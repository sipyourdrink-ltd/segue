// segue: compaction that continues without a break.
//
// One completion on a small model over the rendered transcript writes two
// things: the summary that replaces the conversation, and a handoff card saved
// to disk before the compaction lands. The compacted conversation names that
// file and tells the agent to continue from it. The session's own model is
// never switched.
//
// Fail-open: a refused call, an API error, an empty or short reply, a thrown
// error — each hands the compaction to the built-in summarizer via next(e).
// A card that was already written is still named after the built-in summary.

// The summary model's window is 200k tokens; ~2.5 chars per token for mixed text.
const MAX_CHARS = 420_000;
const HEAD_CHARS = 40_000;
const TOOL_INPUT_CHARS = 500;
const TOOL_TEXT_CHARS = 1500;
const CENSUS_CHARS = 8000;
const PROJECT_STATE_CHARS = 6000;
const TODOS_CHARS = 4000;
const AGENT_PROMPT_CHARS = 6000;
// Past this fill an automatic compaction is no longer held for running subagents.
const HOLD_CEILING_PERCENT = 96;
const MIN_SUMMARY_CHARS = 200;
const MIN_HANDOFF_CHARS = 200;
// How many parent directories to walk when looking for a project-root marker.
const ANCESTOR_LIMIT = 10;
// The verbatim tail of the conversation in the card: the last messages of each side, the language, the background tasks.
const LAST_MESSAGES = 3;
const LAST_MESSAGE_CHARS = 3000;
// The user's standing request: the last message of theirs with this many words of prose, kept verbatim
// in the card and re-issued after the summary.
const REQUEST_MIN_WORDS = 6;
const REQUEST_CHARS = 6000;
const LANGUAGE_MESSAGES = 5;
const BACKGROUND_TASKS = 10;
const BACKGROUND_TASK_CHARS = 160;
// A background output file untouched this long with no completion notice has most likely finished.
const BACKGROUND_IDLE_MS = 60_000;

const SYSTEM =
  "You prepare the hand-over for a long coding-agent conversation that is about to be compacted. " +
  "The agent continues the work from what you write alone, so keep exact file paths, " +
  "commands, ids, numbers, decisions, constraints the user stated, and the next step. " +
  "Reply in the language the user wrote in, with exactly two blocks and nothing else: " +
  "<summary>…</summary> first, then <handoff>…</handoff>.";

const SUMMARY_INSTRUCTION =
  "Up to 15 sentences of plain prose, no headings and no lists: what was being done, as detailed " +
  "and as compressed as possible — the goal, the decisions, files and paths, the current state, the next step. " +
  "Then, past the sentence budget, every part of the user's standing request as one line each, in order, " +
  "marked done, in progress or not started; a part that is far ahead is still listed.";

const HANDOFF_INSTRUCTION =
  "A handoff card in markdown, one fact per line, with exactly these sections in this order " +
  "(keep the headings in English):\n" +
  "## Goal and repo — the session's goal in one line, repositories and paths, branch\n" +
  "## Done — `- ✅ <what> — <sha | PR | path>`; with no artefact in the transcript the line is `- ⚠️ unconfirmed: <what>`\n" +
  "## In flight — `- ⏳ <what> — <pid n | task <id> | run <wf_id>> · done when <condition> · resume: <command>`; " +
  "the id slot is the process id, background task id or workflow run id the transcript gives; when it gives none, " +
  "omit the slot rather than write that it is missing; or `none`\n" +
  "## Open work in project trees — if the project state block names peel/breaker/improve open items, quote their ids and one-line what each one is, verbatim from that block; or `none`\n" +
  "## Plan — every part of the user's standing request, in order, one line each: `- ✅|⏳|⬜ <part> — <evidence, command or path>`; " +
  "a part is listed even when it is far ahead or was only implied by the request; never fewer lines than the request has parts\n" +
  "## Next steps — the first open lines of the plan, up to 3, each with a command or a path\n" +
  "## Only the user — what only the person can do or decide; or `none`\n" +
  "## Read first — up to 5 paths\n" +
  "## Traps — what was tried and failed, and why; constraints the user stated\n" +
  "Take facts only from the transcript, the census, the project state and the todos. What is in none of them, leave out.";

function clip(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function render(messages) {
  const out = [];
  for (const m of messages) {
    const parts = [];
    if (m.text) parts.push(m.text);
    for (const u of m.toolUses || []) {
      let input = "";
      try { input = JSON.stringify(u.input); } catch (_) { input = ""; }
      parts.push(`[tool ${u.tool} ${clip(input, TOOL_INPUT_CHARS)}]` +
        (u.text ? ` → ${clip(u.text, TOOL_TEXT_CHARS)}` : ""));
    }
    for (const r of m.toolResults || []) {
      parts.push(`[result${r.isError ? " error" : ""}] ${clip(r.text, TOOL_TEXT_CHARS)}`);
    }
    if (parts.length) out.push(`${m.role.toUpperCase()}: ${parts.join("\n")}`);
  }
  let text = out.join("\n\n");
  if (text.length > MAX_CHARS) {
    text = text.slice(0, HEAD_CHARS) + "\n\n[… middle of the conversation omitted …]\n\n" +
      text.slice(text.length - (MAX_CHARS - HEAD_CHARS));
  }
  return text;
}

function block(text, tag) {
  // The closing tag may be lost to the output limit; the opening one may not.
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`));
  return m ? m[1].trim() : "";
}

// The two blocks of the reply. The handoff is looked for after the summary's close: a summary that
// mentions the tags, as one about this hook does, must not open the card early.
function blocks(text) {
  const s = text.match(/<summary>([\s\S]*?)(?:<\/summary>|$)/);
  const from = s ? s.index + s[0].length : 0;
  return { summary: s ? s[1].trim() : "", handoff: block(text.slice(from), "handoff") };
}

// The latest TodoWrite tool call in the transcript carries the task tracker's
// full state as of the last write. The small model is not asked to reconstruct
// it from fragments; the hook extracts the todos list verbatim and writes it
// into the card unchanged, so the next session resumes against a reliable list.
function latestTodos(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const uses = m.toolUses || [];
    for (let j = uses.length - 1; j >= 0; j--) {
      const u = uses[j];
      if (u.tool === "TodoWrite" && u.input && Array.isArray(u.input.todos)) {
        return u.input.todos;
      }
    }
  }
  return [];
}

// Some hosts keep the task ledger on disk under $HOME/.claude/tasks/, grouped
// by list id. When present, that record outlives transcript truncation and is
// the more durable source for the todos list. The in-process scan above runs
// first (fast, same session); this probe fills in only when the transcript scan
// found nothing and the disk ledger is readable.
async function diskTasks($, home) {
  if (!home) return [];
  try {
    const base = `${home}/.claude/tasks`;
    if (!(await fsExists($, base))) return [];
    const lists = await $.fs.list(base);
    if (!Array.isArray(lists) || !lists.length) return [];
    // Pick the most recently modified list dir.
    const stamped = await Promise.all(lists.map(async (name) => {
      try {
        const st = await $.fs.stat(`${base}/${name}`);
        return { name, mtime: st && typeof st.mtimeMs === "number" ? st.mtimeMs : 0 };
      } catch (_) { return { name, mtime: 0 }; }
    }));
    stamped.sort((a, b) => b.mtime - a.mtime);
    const listDir = `${base}/${stamped[0].name}`;
    const files = await $.fs.list(listDir);
    const tasks = [];
    for (const f of (Array.isArray(files) ? files : [])) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await $.fs.read(`${listDir}/${f}`);
        const t = JSON.parse(raw);
        if (t && typeof t.content === "string") tasks.push(t);
      } catch (_) { /* skip malformed entries */ }
    }
    return tasks;
  } catch (_) {
    return [];
  }
}

function todosSection(todos) {
  if (!todos.length) return "";
  const marker = { pending: " ", in_progress: "⏳", completed: "x" };
  const openCount = todos.filter(t => t.status !== "completed").length;
  const doneCount = todos.length - openCount;
  const lines = todos.map(t => {
    const m = marker[t.status] !== undefined ? marker[t.status] : " ";
    const text = t.activeForm && t.status === "in_progress" ? t.activeForm : (t.content || "");
    return `- [${m}] ${text}`;
  });
  return clip(
    `## Task tracker at compaction\n` +
    `Open ${openCount} · done ${doneCount}. Treat this list as the authoritative state at compaction; ` +
    `re-check each item's actual progress before marking it in a new TodoWrite.\n\n` +
    lines.join("\n"),
    TODOS_CHARS,
  );
}

// Non-throwing shell runner for optional probes: a probe that cannot run on
// this host (missing python3, missing skill script, no fs access) is dropped,
// not propagated as an error.
async function probe($, argv) {
  try {
    const r = await $.process.run(argv, { timeoutMs: 10_000 });
    return r.exitCode === 0 ? r.stdout.trim() : "";
  } catch (_) {
    return "";
  }
}

async function fsExists($, path) {
  try {
    const v = await $.fs.exists(path);
    return !!v;
  } catch (_) {
    return false;
  }
}

// Walk cwd upwards for ANCESTOR_LIMIT levels looking for the first ancestor
// that contains every marker file. Returns null when none match or when
// $.fs.exists is unavailable in the host.
async function findProjectRoot($, cwd, markers) {
  if (!cwd) return null;
  let dir = cwd;
  for (let i = 0; i < ANCESTOR_LIMIT; i++) {
    let allPresent = true;
    for (const marker of markers) {
      if (!(await fsExists($, `${dir}/${marker}`))) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) return dir;
    const slash = dir.lastIndexOf("/");
    if (slash <= 0) break;
    const parent = dir.slice(0, slash) || "/";
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// The on-disk state of the three skill-project harnesses (peel, blackbox-breaker,
// improve) at compaction. Every probe is gated on an fs.exists check: on a host
// where $.fs.exists is unavailable or the marker files are absent, the probe
// never shells out at all, so the card simply omits that section. The improve
// journal is global ($HOME/.local/share/improve/journal.jsonl); the other two
// are rooted in an ancestor of cwd.
async function projectState($, cwd) {
  const blocks = [];
  const home = await (async () => { try { return await $.env.get("HOME"); } catch (_) { return ""; } })();

  // peel: ACCESS.md with a tier: line is scaffold's unique marker.
  const peelRoot = await findProjectRoot($, cwd, ["ACCESS.md"]);
  if (peelRoot && home) {
    const out = await probe($, ["sh", "-c",
      `grep -q '^tier: ' "${peelRoot}/ACCESS.md" 2>/dev/null && ` +
      `python3 "${home}/.claude/skills/peel/scripts/peel.py" status --root "${peelRoot}"`]);
    if (out) blocks.push(`=== PEEL project: ${peelRoot} ===\n${out}`);
  }

  // blackbox-breaker: AUTHORIZATION.md + vectors.csv at the same ancestor.
  const breakerRoot = await findProjectRoot($, cwd, ["AUTHORIZATION.md", "vectors.csv"]);
  if (breakerRoot && home) {
    const out = await probe($, ["sh", "-c",
      `python3 "${home}/.claude/skills/blackbox-breaker/scripts/breaker.py" status --root "${breakerRoot}" && ` +
      `echo '--- top 3 open vectors ---' && ` +
      `tail -n +2 "${breakerRoot}/vectors.csv" | awk -F, '$6=="open"' | head -3`]);
    if (out) blocks.push(`=== BREAKER project: ${breakerRoot} ===\n${out}`);
  }

  // improve: global journal, independent of cwd. Gated on fs.exists so an
  // unavailable fs.* namespace (as in the default test world) prevents the
  // shell call entirely, and the probe never fires on hosts without the skill.
  if (home) {
    const journal = `${home}/.local/share/improve/journal.jsonl`;
    if (await fsExists($, journal)) {
      const out = await probe($, ["sh", "-c",
        `python3 "${home}/.claude/skills/improve/scripts/improve.py" log due --days 7 2>/dev/null | head -40`]);
      if (out) blocks.push(`=== IMPROVE journal: due or overdue (next 7d) ===\n${out}`);
    }
  }

  return clip(blocks.join("\n\n"), PROJECT_STATE_CHARS);
}

function projectStateSection(block) {
  if (!block) return "";
  return `## Open work in project trees\n` +
    `Captured verbatim at compaction from the project harnesses. The next session ` +
    `should re-run each named status subcommand before touching open items.\n\n` +
    "```\n" + block + "\n```";
}

// The task notification that closes a background task, in a message after the one that started it.
function notice(messages, i, id) {
  if (!id) return undefined;
  return messages.slice(i + 1).map(x => x.text || "").find(t => t.includes(`<task-id>${id}</task-id>`));
}

// A Workflow started in the background answers with its names: "Task ID: …", "Transcript dir:
// …/<session>/subagents/workflows/wf_…" and "Script file: …-wf_….js". The run writes its terminal record to
// <session>/workflows/wf_….json only when it ends. A field the launch result does not carry stays empty.
function workflowRun(u) {
  const text = String(u.text || "");
  const field = name => ((text.match(new RegExp(`${name}: (\\S+)`)) || [])[1] || "");
  const dir = field("Transcript dir").replace(/\/$/, "");
  const script = field("Script file");
  const runId = (dir.match(/\/(wf_[\w-]+)$/) || script.match(/-(wf_[\w-]+)\.js$/) || [])[1] || "";
  const terminal = /\/subagents\/workflows\/wf_[\w-]+$/.test(dir)
    ? dir.replace(/\/subagents\/workflows\/(wf_[\w-]+)$/, "/workflows/$1.json") : "";
  const summary = oneLine(((text.match(/Summary: ([^\n]+)/) || [])[1] || "").split(" · ")[0]);
  return { taskId: field("Task ID"), runId, dir, script, terminal, summary };
}

// Subagents the main loop started that were still running at compaction. The
// calls that would carry their results are summarised away, so the next turn
// gets their prompts verbatim, from the transcript, not from the small model.
// Workflow runs started in the background count as running until a task notification names their task id
// or their terminal record exists; they carry `workflow` with the run's ids.
async function inFlight($, messages) {
  const calls = [];
  const runs = [];
  messages.forEach((m, i) => {
    for (const u of m.toolUses || []) {
      if ((u.tool === "Agent" || u.tool === "Task") && u.input) calls.push(u);
      else if (u.tool === "Workflow" && /Task ID:|Transcript dir:|launched in background/.test(String(u.text || ""))) runs.push({ u, i });
    }
  });
  const workflows = [];
  for (const { u, i } of runs) {
    const wf = workflowRun(u);
    if (notice(messages, i, wf.taskId)) continue;
    if (wf.terminal && await fsExists($, wf.terminal)) continue;
    workflows.push({ ...u, workflow: wf });
  }
  if (!calls.length) return workflows;
  let running = null;
  try {
    running = new Set((await $.agent.list()).filter(a => a.status === "running").map(a => a.id));
  } catch (_) {
    // No listing: a call still waiting for its answer is the best evidence left.
  }
  return [...calls.filter(u => running ? Boolean(u.agentId && running.has(u.agentId)) : !u.result && !u.text), ...workflows];
}

function agentEntry(u) {
  const x = u.input;
  const meta = [x.subagent_type, x.model, u.agentId && `id ${u.agentId}`].filter(Boolean).join(" · ");
  return `${x.description || "agent"}${meta ? " · " + meta : ""}\n` + fence(clip(String(x.prompt || ""), AGENT_PROMPT_CHARS));
}

function workflowEntry(u) {
  const w = u.workflow;
  const what = w.summary || (u.input && u.input.description) || "run";
  const resume = w.script && w.runId
    ? "`Workflow {scriptPath: \"" + w.script + "\", resumeFromRunId: \"" + w.runId + "\"}`" : "id unknown";
  return `Workflow ${clip(what, BACKGROUND_TASK_CHARS)} · task ${w.taskId || "id unknown"} · run ${w.runId || "id unknown"}\n` +
    `- journal: ${w.dir ? w.dir + "/journal.jsonl" : "id unknown"}; ended when ${w.terminal || "its terminal record"} exists or its task notification arrives\n` +
    `- resume only if it stopped: ${resume}`;
}

function agentsSection(calls) {
  if (!calls.length) return "";
  const agents = calls.filter(u => !u.workflow);
  const runs = calls.filter(u => u.workflow);
  return "## Subagents running at compaction\n" +
    (agents.length ? "Their results may never reach this conversation. Check what they already wrote to disk, " +
      "then relaunch the unfinished ones with these prompts; do not wait for them.\n" : "") +
    (runs.length ? "Workflow runs keep running in the background and report back with a task notification: do not relaunch them. " +
      "A journal untouched for a long time means the run may have stopped; resume only then.\n" : "") +
    "\n" + [...agents.map(agentEntry), ...runs.map(workflowEntry)].map((s, i) => `### ${i + 1}. ${s}`).join("\n\n");
}

// Long texts keep their beginning and their end: the question at the end of a message is what a resume needs.
function clipMiddle(s, n) {
  if (s.length <= n) return s;
  const head = Math.ceil(n / 2);
  return `${s.slice(0, head)}\n… [${s.length - n} chars cut] …\n${s.slice(s.length - (n - head))}`;
}

// A fence longer than any backtick run in the text, so the text cannot close it early.
function fence(text) {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}text\n${text}\n${f}`;
}

// Secrets the person may have typed in the conversation. The card outlives the session, so verbatim text is
// masked before it is written.
const SECRET_TOKENS = [
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
];
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi;

function redact(text) {
  let out = text;
  for (const re of SECRET_TOKENS) out = out.replace(re, "[redacted]");
  return out.replace(SECRET_ASSIGNMENT, "$1$2[redacted]");
}

// What the person wrote, with the host's own wrappers removed: task notifications, system reminders and
// command echoes arrive as user messages but are not the user's words.
const HOST_WRAPPERS = /<(task-notification|system-reminder|local-command-stdout|local-command-caveat|command-name|command-message|command-args|ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/g;
const HOST_PREAMBLE = /\[SYSTEM NOTIFICATION[^\]]*\][^\n]*(?:\n(?!\n)[^\n]*)*/g;
function prose(m) {
  if (!m || m.role !== "user" || typeof m.text !== "string") return "";
  return m.text.replace(HOST_WRAPPERS, " ").replace(HOST_PREAMBLE, " ").trim();
}

// The user's standing request: their last message with at least REQUEST_MIN_WORDS words of prose, so that
// a bare "yes" or "go on" points back at the request it answered. Null when nothing qualifies.
function standingRequest(messages) {
  let fallback = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = prose(messages[i]);
    if (!text) continue;
    if (text.split(/\s+/).length >= REQUEST_MIN_WORDS) return { message: messages[i], text };
    if (!fallback) fallback = { message: messages[i], text };
  }
  return fallback;
}

// Written only when the request is older than the tail; in the tail it is marked instead.
function requestSection(request, messages) {
  if (!request || tailMessages(messages, LAST_MESSAGES, request).some(m => m.request)) return "";
  return "## Standing request\n" +
    "The user's last substantive message, verbatim. Every part of it is the task; the summary and the plan say how far it got.\n\n" +
    fence(clipMiddle(redact(request.text), REQUEST_CHARS));
}

// The last few user or agent texts, oldest first; tool results, host wrappers and empty turns are skipped.
function tailMessages(messages, perRole, request) {
  const counts = { user: 0, assistant: 0 };
  const picked = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!(m.role === "user" || m.role === "assistant") || counts[m.role] >= perRole) continue;
    const text = m.role === "user" ? prose(m) : (m.text || "").trim();
    if (!text) continue;
    counts[m.role] += 1;
    picked.unshift({ role: m.role, text, request: Boolean(request && request.message === m) });
  }
  return picked;
}

// The person's language from the words of their last few messages, code and URLs left out. Cyrillic words
// count as ru; below one word in five Cyrillic the text is reported as en.
const PROSE_SKIP = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+/g;
function userLanguage(messages) {
  const recent = messages.map(prose).filter(Boolean).slice(-LANGUAGE_MESSAGES);
  const words = recent.map(t => t.replace(PROSE_SKIP, " ")).join(" ").split(/[^\p{L}]+/u).filter(Boolean);
  if (!words.length) return "unknown";
  const cyrillic = words.filter(w => /\p{Script=Cyrillic}/u.test(w)).length;
  const share = Math.round((100 * cyrillic) / words.length);
  return `${share >= 20 ? "ru" : "en"} (Cyrillic words ${share}% of the last user messages)`;
}

// The conversation's tail as it was written: the resume point that the summary can blur.
function conversationSection(messages, request) {
  const tail = tailMessages(messages, LAST_MESSAGES, request);
  if (!tail.length) return "";
  return "## Last messages at compaction\n" +
    `- user language: ${userLanguage(messages)} — reply in the same language\n` +
    "Verbatim from the transcript, oldest first; the middle is cut when a message is long.\n\n" +
    tail.map(m => `### ${m.role === "user" ? (m.request ? "User (standing request)" : "User") : "Agent"}\n` +
      fence(clipMiddle(redact(m.text), LAST_MESSAGE_CHARS))).join("\n\n");
}

// One line, for list items that must not break across lines.
function oneLine(s) {
  return s.replace(/\s+/g, " ").trim();
}

function tagText(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : "";
}

// Bash calls started with run_in_background: the task id and output file the tool returned. A task
// notification later in the conversation closes a task; without one it may still run, or be lost. The notice
// can arrive after the messages the hook sees, so an output file that is non-empty and untouched for
// BACKGROUND_IDLE_MS is reported as idle: the task most likely finished and its output is the result.
async function backgroundTasks($, messages) {
  const tasks = [];
  messages.forEach((m, i) => {
    for (const u of m.toolUses || []) {
      if (u.tool !== "Bash" || !u.input || u.input.run_in_background !== true) continue;
      const text = String(u.text || "");
      const id = (text.match(/background with ID: (\S+?)\./) || [])[1];
      if (!id) continue;
      const output = ((text.match(/written to: (\S+)/) || [])[1] || "").replace(/\.$/, "");
      const what = clip(oneLine(redact(String(u.input.description || u.input.command || ""))), BACKGROUND_TASK_CHARS);
      const note = notice(messages, i, id);
      const state = note ? oneLine(redact(tagText(note, "summary") || tagText(note, "status") || "finished")) : "";
      tasks.push({ id, output, what, state, idle: 0 });
    }
  });
  const recent = tasks.slice(-BACKGROUND_TASKS);
  if (!recent.some(t => !t.state && t.output)) return recent;
  let now = 0;
  try { now = Number(await $.clock.now()) || 0; } catch (_) { now = 0; }
  for (const t of recent) {
    if (t.state || !t.output) continue;
    try {
      const st = await $.fs.stat(t.output);
      const idle = now - Number(st && st.mtimeMs);
      if (st && st.size > 0 && idle > BACKGROUND_IDLE_MS) t.idle = Math.floor(idle / 60_000);
    } catch (_) { /* no stat: reported without the idle hint */ }
  }
  return recent;
}

async function backgroundSection($, messages) {
  const tasks = await backgroundTasks($, messages);
  if (!tasks.length) return "";
  return "## Background tasks at compaction\n" +
    "Bash calls started with run_in_background. ✅ = a completion notice came back; " +
    "⏳ = none did: an idle output most likely holds the finished result, read it; " +
    "otherwise it may still run or be lost: read its output file before relaunching it.\n" +
    tasks.map(t => t.state
      ? `- ✅ ${t.id} · ${t.what} · ${t.state} · output ${t.output}`
      : `- ⏳ ${t.id} · ${t.what} · ${t.idle ? `output idle ${t.idle}m, read it` : "no completion notice"} · output ${t.output}`).join("\n");
}

async function run($, argv) {
  try {
    const r = await $.process.run(argv, { timeoutMs: 20_000 });
    return r.exitCode === 0 ? r.stdout.trim() : "";
  } catch (_) {
    return "";
  }
}

// The machine's state at the moment of compaction, so the card rests on more
// than the transcript. Best effort: the card is written without it.
async function census($, command) {
  if (command) return clip(await run($, ["sh", "-c", command]), CENSUS_CHARS);
  if (!(await run($, ["git", "rev-parse", "--show-toplevel"]))) return "";
  const [status, worktrees, log, stashes] = await Promise.all([
    run($, ["git", "status", "--porcelain=v1", "--branch"]),
    run($, ["git", "worktree", "list"]),
    run($, ["git", "log", "--oneline", "-5"]),
    run($, ["git", "stash", "list"]),
  ]);
  return clip([
    "$ git status --porcelain=v1 --branch\n" + status,
    "$ git worktree list\n" + worktrees,
    "$ git log --oneline -5\n" + log,
    stashes ? "$ git stash list\n" + stashes : "",
  ].filter(Boolean).join("\n\n"), CENSUS_CHARS);
}

// Local day and time for the file name; UTC when the host has no `date`.
async function stamp($) {
  const local = (await run($, ["date", "+%Y-%m-%d %H%M%S %z"])).split(" ");
  if (local.length === 3) return { day: local[0], time: local[1], zone: local[2] };
  const iso = new Date(await $.clock.now()).toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 19).replace(/:/g, ""), zone: "UTC" };
}

async function saveHandoff($, dir, source, e, card) {
  const { day, time, zone } = await stamp($);
  const id = await $.session.id();
  const path = `${dir}/${day}-${time}-${id.slice(0, 8)}.md`;
  const head =
    `# Handoff before compaction — ${day} ${time} ${zone} (session ${id.slice(0, 8)})\n` +
    `- trigger: ${e.trigger} · session: ${id} · cwd: ${await $.session.cwd()}\n` +
    `- written by ${source}: a hypothesis, not the truth\n` +
    `- transcript: ~/.claude/projects/*/${id}.jsonl — the card is a digest; the last user turns there are the resume point\n` +
    `- resume: read this card → read the last user turns in the transcript → check both against the repository's actual state → carry on from "Next steps"\n\n`;
  await $.fs.write(path, head + card + "\n");
  return path;
}

// The compacted summary itself is a durable artifact: readers of the card
// benefit from the original prose, and a search over past summaries recovers
// context the card compresses out. Written as a sibling of the card, named
// after it so the pair stays discoverable. Gated on the plugin data dir
// existing: the extra write only happens on hosts where the CLI has set up
// the data directory, which keeps the test matrix stable.
async function saveSummary($, cardPath, summary, dataDir) {
  if (!cardPath || !summary || !dataDir) return "";
  if (!(await fsExists($, dataDir))) return "";
  try {
    const sumPath = cardPath.replace(/\.md$/, ".summary.md");
    await $.fs.write(sumPath, summary + "\n");
    return sumPath;
  } catch (_) {
    return "";
  }
}

// A per-plugin KV directory ($CLAUDE_PLUGIN_DATA) is the right place for an
// index that outlives any single project tree. The index is append-only so
// readers can tail it without locking. Gated on the data directory actually
// existing so hosts that do not provide one are untouched.
async function appendCardIndex($, cardPath, e, dataDir) {
  if (!cardPath || !dataDir) return;
  if (!(await fsExists($, dataDir))) return;
  try {
    const line = JSON.stringify({
      ts: new Date(await $.clock.now()).toISOString(),
      trigger: e.trigger,
      session: await $.session.id(),
      cwd: await $.session.cwd(),
      card: cardPath,
    });
    const idxPath = `${dataDir}/cards.jsonl`;
    let prev = "";
    try { prev = await $.fs.read(idxPath); } catch (_) { prev = ""; }
    await $.fs.write(idxPath, prev + line + "\n");
  } catch (_) { /* index is best-effort */ }
}

// A pointer file in the project tree outlives the compacted summary. When the
// cwd is a repo and writable, writing a short pointer under .claude/ lets a
// later session discover the last handoff without reading plugin data.
async function writeProjectPointer($, cwd, cardPath) {
  if (!cwd || !cardPath) return "";
  try {
    const dir = `${cwd}/.claude`;
    if (!(await fsExists($, dir))) return "";
    const path = `${dir}/handoff-current.md`;
    const body = `# Current handoff\n\nLast compaction wrote a card to:\n\n    ${cardPath}\n\n` +
      `Read that file first. The card is a hypothesis; the machine is the truth.\n`;
    await $.fs.write(path, body);
    return path;
  } catch (_) {
    return "";
  }
}

// Which host the plugin is running under; used in logs and toasts so a reader
// can tell CLI from desktop apart at a glance.
async function hostLabel($) {
  try {
    const ep = await $.env.get("CLAUDE_CODE_ENTRYPOINT");
    if (!ep) return "";
    return ep === "claude-desktop" ? "desktop" : (ep === "cli" ? "cli" : ep);
  } catch (_) {
    return "";
  }
}

function pointer(path, censusCommand, agents, runs, hasProjectState, hasTodos) {
  const stateHint = hasProjectState
    ? " The card's \"Open work in project trees\" names peel/breaker/improve open items — " +
      "re-run each harness's `status` subcommand before touching those items."
    : "";
  const todosHint = hasTodos
    ? " The card's \"Task tracker at compaction\" is the authoritative todo list; " +
      "re-check each item's actual progress before marking it in a new TodoWrite."
    : "";
  return "Before this compaction a handoff card was written to " + path + ". " +
    "Continue the work from it: read that file first, check it against the actual state " +
    (censusCommand ? "(run `" + censusCommand + "`)" : "(git status, running processes)") +
    ", then carry on from its \"Next steps\". " +
    "The card is a hypothesis; the machine is the truth. " +
    "Its \"Plan\" lists every part of the user's standing request with its state: finish all open parts, not only the next one." +
    todosHint +
    stateHint +
    (agents ? ` ${agents} subagent(s) were running at compaction and may not report back: ` +
      "the card's \"Subagents running at compaction\" has their exact prompts; " +
      "check their output on disk and relaunch what is unfinished instead of waiting." : "") +
    (runs ? ` ${runs} workflow run(s) were running at compaction: they keep running and report back with a task notification; ` +
      "do not relaunch them. The card's \"Subagents running at compaction\" has their task and run ids and how to resume one that stopped." : "");
}

// The standing request re-issued after the summary, verbatim: the summary says how far it got, this says
// what all of it was. The trailing message is kept by identity elsewhere, so it is not repeated here.
function reissue(request, messages) {
  if (!request || request.message === messages[messages.length - 1]) return [];
  return [{
    role: "user",
    text: "The user's standing request, verbatim as sent before the compaction. The summary above says how far it got; " +
      "every part of it is still the task:\n\n" + clipMiddle(request.text, REQUEST_CHARS),
    toolUses: [],
  }];
}

// The context's fill as the status line has it; unknown when the engine does not say.
async function contextPercent($) {
  try {
    const u = await $.session.usage();
    return u && u.context && typeof u.context.percent === "number" ? u.context.percent : undefined;
  } catch (_) {
    return undefined;
  }
}

function number(v, fallback) {
  const n = Number(v);
  return v === undefined || v === null || v === "" || Number.isNaN(n) ? fallback : Math.max(0, n);
}

export function register(on, options) {
  const model = String((options && options.model) || "haiku");
  const censusCommand = String((options && options.censusCommand) || "");
  const handoffDir = String((options && options.handoffDir) || "~/.claude/handoffs");
  const holdMs = number(options && options.holdForAgentsMinutes, 10) * 60_000;
  const guardPercent = number(options && options.agentGuardPercent, 90);
  // An automatic compaction being held back for running subagents: when the hold began.
  let hold = null;

  // A subagent started this close to the limit would be stopped by the next
  // compaction before it answers. Refused with the way out, so the model
  // compacts or hands off first and starts it after.
  on("tool.call", async ($, e, next) => {
    if (e.tool !== "Agent" || e.agentId || !guardPercent) return await next(e);
    const percent = await contextPercent($);
    if (percent === undefined || percent < guardPercent) return await next(e);
    return {
      deny: `segue: the context is at ${percent}% (guard at ${guardPercent}%); a subagent started now would be lost at the next compaction. ` +
        "Compact or hand off first, then start it.",
    };
  });

  on("session.compact", async ($, e, next) => {
    try {
      // A subagent's own compaction stays with the engine.
      if (e.agentId) return await next(e);
      const transcript = render(e.messages);
      if (!transcript) return await next(e);
      const running = await inFlight($, e.messages);
      // Workflow runs go on in the background past a compaction and report back; they are listed, not held for.
      const agents = running.filter(u => !u.workflow);
      const runs = running.length - agents.length;
      // Subagents still running are stopped by a compaction. An automatic one
      // is held back until they answer: the engine asks again before each
      // request. Bounded by the context's fill and by time, so a hold cannot
      // run the conversation into the limit itself.
      if (e.trigger === "auto" && agents.length && holdMs) {
        const now = await $.clock.now();
        if (!hold) hold = { since: now, toasted: false };
        const percent = await contextPercent($);
        if (percent !== undefined && percent < HOLD_CEILING_PERCENT && now - hold.since < holdMs) {
          const why = `${agents.length} subagent(s) still running, context ${percent}%`;
          $.ui.log(`segue: compaction held (${why})`);
          if (!hold.toasted) {
            hold.toasted = true;
            $.ui.toast(`compaction held: ${why}`);
          }
          return { skip: `segue: ${why}; compaction resumes when they answer` };
        }
      }
      hold = null;
      // Custom instructions steer what both blocks keep; the card's sections are not theirs to change.
      const extra = e.instructions
        ? `\n\nThe user also asked: ${e.instructions}\nFollow it in the summary. In the card follow it for what to keep; the card's sections and line format stay as specified.`
        : "";
      // Parallel probes: git census, three skill-project harnesses, the
      // in-process TodoWrite scan, and the disk task ledger. The disk ledger
      // is read only when the transcript scan found nothing, so a transcript
      // that still holds the latest TodoWrite is trusted first.
      const cwd = await (async () => { try { return await $.session.cwd(); } catch (_) { return ""; } })();
      const home = await (async () => { try { return await $.env.get("HOME"); } catch (_) { return ""; } })();
      const [state, projectBlock] = await Promise.all([
        census($, censusCommand),
        projectState($, cwd),
      ]);
      let todos = latestTodos(e.messages);
      if (!todos.length) todos = await diskTasks($, home);
      const todosBlock = todosSection(todos);
      const projectBlockSection = projectStateSection(projectBlock);
      const runningBlock = agentsSection(running);
      const r = await $.model.complete({
        model,
        system: SYSTEM,
        prompt: `<transcript>\n${transcript}\n</transcript>\n\n` +
          (state ? `<census>\n${state}\n</census>\n\n` : "") +
          (projectBlock ? `<project-state>\n${projectBlock}\n</project-state>\n\n` : "") +
          (todos.length ? `<todos>\n${JSON.stringify(todos, null, 2)}\n</todos>\n\n` : "") +
          `In the <summary> block: ${SUMMARY_INSTRUCTION}\n\n` +
          `In the <handoff> block: ${HANDOFF_INSTRUCTION}${extra}`,
        maxTokens: 8000,
        timeoutMs: 180_000,
      });
      const text = r.isAnswered ? r.text : "";
      let handoffPath = "";
      const parsed = blocks(text);
      // A reply without either tag is read as the summary alone.
      const body = parsed.summary || (text.includes("<handoff>") ? "" : text.trim());
      const written = parsed.handoff;
      const request = standingRequest(e.messages);
      // The running subagents, the todo tracker, the project-state block, the verbatim tail and the background
      // tasks are saved even when the small model wrote no card: they carry the in-flight work and the resume point
      // that the Haiku summary would have had to reconstruct.
      const modelWrote = written.length >= MIN_HANDOFF_CHARS;
      const card = [
        modelWrote ? written : "",
        requestSection(request, e.messages),
        todosBlock,
        projectBlockSection,
        runningBlock,
        conversationSection(e.messages, request),
        await backgroundSection($, e.messages),
      ].filter(Boolean).join("\n\n");
      if (card) {
        try {
          const dir = handoffDir.startsWith("~/") && home ? home + handoffDir.slice(1) : handoffDir;
          const source = modelWrote ? `${model} from the transcript and a census of the machine`
            : "segue (the model wrote no card) from the transcript";
          handoffPath = await saveHandoff($, dir, source, e, card);
        } catch (err) {
          $.ui.log(`segue: handoff not written: ${err}`);
        }
      }
      // Persist the summary prose alongside the card and keep an index of all
      // handoffs under the plugin's data dir. A pointer under cwd's `.claude/`
      // lets a later session discover the last handoff without reading plugin
      // data. All three are best-effort and each is gated on the relevant
      // directory existing; a failure never fails the compaction.
      const dataDir = await (async () => { try { return await $.env.get("CLAUDE_PLUGIN_DATA"); } catch (_) { return ""; } })();
      await saveSummary($, handoffPath, body, dataDir);
      await appendCardIndex($, handoffPath, e, dataDir);
      await writeProjectPointer($, cwd, handoffPath);
      const host = await hostLabel($);
      if (body.length < MIN_SUMMARY_CHARS) {
        const why = r.isAnswered ? "short reply" : r.reason;
        $.ui.log(`segue: fallback to built-in (${why})`);
        if (e.trigger !== "precompute") {
          $.ui.toast(`built-in summary used (${why})` + (handoffPath ? `; handoff card: ${handoffPath}` : ""));
        }
        const res = await next(e);
        if (!handoffPath || !res.messages) return res;
        return { ...res, messages: [...res.messages, ...reissue(request, e.messages), { role: "user", text: pointer(handoffPath, censusCommand, agents.length, runs, Boolean(projectBlock), todos.length > 0), toolUses: [] }] };
      }
      const u = r.usage;
      const hostTag = host ? ` [${host}]` : "";
      $.ui.log(`segue${hostTag}: ${e.trigger} by ${model}, in ${u.input_tokens} out ${u.output_tokens}` +
        (handoffPath ? `, handoff ${handoffPath}` : ", no handoff"));
      if (e.trigger !== "precompute") {
        $.ui.toast((handoffPath ? `handoff card: ${handoffPath}` : "summary written, no handoff card") +
          (agents.length ? ` · ${agents.length} subagent(s) were running: prompts in the card` : ""));
      }
      const summary = {
        role: "user",
        text: "This session is being continued from a previous conversation that ran out of context. " +
          "The summary below covers the earlier portion of the conversation.\n\nSummary:\n" + body +
          (handoffPath ? "\n\n" + pointer(handoffPath, censusCommand, agents.length, runs, Boolean(projectBlock), todos.length > 0) : ""),
        toolUses: [],
      };
      const kept = [summary, ...reissue(request, e.messages)];
      // A trailing plain prompt from the person stays verbatim, by identity.
      const last = e.messages[e.messages.length - 1];
      if (last && last.role === "user" && last.text && !(last.toolResults && last.toolResults.length) && !(last.toolUses && last.toolUses.length)) {
        kept.push(last);
      }
      return { messages: kept };
    } catch (err) {
      $.ui.log(`segue: error, fallback to built-in: ${err}`);
      return await next(e);
    }
  });
}
