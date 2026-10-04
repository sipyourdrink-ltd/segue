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
const AGENT_PROMPT_CHARS = 6000;
// Past this fill an automatic compaction is no longer held for running subagents.
const HOLD_CEILING_PERCENT = 96;
const MIN_SUMMARY_CHARS = 200;
const MIN_HANDOFF_CHARS = 200;

const SYSTEM =
  "You prepare the hand-over for a long coding-agent conversation that is about to be compacted. " +
  "The agent continues the work from what you write alone, so keep exact file paths, " +
  "commands, ids, numbers, decisions, constraints the user stated, and the next step. " +
  "Reply in the language the user wrote in, with exactly two blocks and nothing else: " +
  "<summary>…</summary> first, then <handoff>…</handoff>.";

const SUMMARY_INSTRUCTION =
  "Up to 15 sentences of plain prose, no headings and no lists: what was being done, as detailed " +
  "and as compressed as possible — the goal, the decisions, files and paths, the current state, the next step.";

const HANDOFF_INSTRUCTION =
  "A handoff card in markdown, one fact per line, with exactly these sections in this order " +
  "(keep the headings in English):\n" +
  "## Goal and repo — the session's goal in one line, repositories and paths, branch\n" +
  "## Done — `- ✅ <what> — <sha | PR | path>`; with no artefact in the transcript the line is `- ⚠️ unconfirmed: <what>`\n" +
  "## In flight — `- ⏳ <what> — pid <n> · done when <condition> · resume: <command>`; or `none`\n" +
  "## Next steps — up to 3, in order, each with a command or a path\n" +
  "## Only the user — what only the person can do or decide; or `none`\n" +
  "## Read first — up to 5 paths\n" +
  "## Traps — what was tried and failed, and why; constraints the user stated\n" +
  "Take facts only from the transcript and the census. What is in neither, leave out.";

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

// Subagents the main loop started that were still running at compaction. The
// calls that would carry their results are summarised away, so the next turn
// gets their prompts verbatim, from the transcript, not from the small model.
async function inFlight($, messages) {
  const calls = [];
  for (const m of messages) {
    for (const u of m.toolUses || []) {
      if ((u.tool === "Agent" || u.tool === "Task") && u.input) calls.push(u);
    }
  }
  if (!calls.length) return [];
  let running = null;
  try {
    running = new Set((await $.agent.list()).filter(a => a.status === "running").map(a => a.id));
  } catch (_) {
    // No listing: a call still waiting for its answer is the best evidence left.
  }
  return calls.filter(u => running ? Boolean(u.agentId && running.has(u.agentId)) : !u.result && !u.text);
}

function agentsSection(calls) {
  if (!calls.length) return "";
  return "## Subagents running at compaction\n" +
    "Their results may never reach this conversation. Check what they already wrote to disk, " +
    "then relaunch the unfinished ones with these prompts; do not wait for them.\n\n" +
    calls.map((u, i) => {
      const x = u.input;
      const meta = [x.subagent_type, x.model, u.agentId && `id ${u.agentId}`].filter(Boolean).join(" · ");
      return `### ${i + 1}. ${x.description || "agent"}${meta ? " · " + meta : ""}\n` +
        "```text\n" + clip(String(x.prompt || ""), AGENT_PROMPT_CHARS) + "\n```";
    }).join("\n\n");
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

async function saveHandoff($, dir, model, e, card) {
  const { day, time, zone } = await stamp($);
  const id = await $.session.id();
  const path = `${dir}/${day}-${time}-${id.slice(0, 8)}.md`;
  const head =
    `# Handoff before compaction — ${day} ${time} ${zone} (session ${id.slice(0, 8)})\n` +
    `- trigger: ${e.trigger} · session: ${id} · cwd: ${await $.session.cwd()}\n` +
    `- written by ${model} from the transcript and a census of the machine: a hypothesis, not the truth\n` +
    `- resume: read this card → check it against the repository's actual state → carry on from "Next steps"\n\n`;
  await $.fs.write(path, head + card + "\n");
  return path;
}

function pointer(path, censusCommand, agents) {
  return "Before this compaction a handoff card was written to " + path + ". " +
    "Continue the work from it: read that file first, check it against the actual state " +
    (censusCommand ? "(run `" + censusCommand + "`)" : "(git status, running processes)") +
    ", then carry on from its \"Next steps\". " +
    "The card is a hypothesis; the machine is the truth." +
    (agents ? ` ${agents} subagent(s) were running at compaction and may not report back: ` +
      "the card's \"Subagents running at compaction\" has their exact prompts; " +
      "check their output on disk and relaunch what is unfinished instead of waiting." : "");
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
      const agents = await inFlight($, e.messages);
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
      const state = await census($, censusCommand);
      const running = agentsSection(agents);
      const r = await $.model.complete({
        model,
        system: SYSTEM,
        prompt: `<transcript>\n${transcript}\n</transcript>\n\n` +
          (state ? `<census>\n${state}\n</census>\n\n` : "") +
          `In the <summary> block: ${SUMMARY_INSTRUCTION}\n\n` +
          `In the <handoff> block: ${HANDOFF_INSTRUCTION}${extra}`,
        maxTokens: 8000,
        timeoutMs: 180_000,
      });
      const text = r.isAnswered ? r.text : "";
      let handoffPath = "";
      const written = block(text, "handoff");
      // The running subagents are saved even when the small model wrote no card.
      const card = [written.length >= MIN_HANDOFF_CHARS ? written : "", running].filter(Boolean).join("\n\n");
      if (card) {
        try {
          const home = await $.env.get("HOME");
          const dir = handoffDir.startsWith("~/") && home ? home + handoffDir.slice(1) : handoffDir;
          handoffPath = await saveHandoff($, dir, model, e, card);
        } catch (err) {
          $.ui.log(`segue: handoff not written: ${err}`);
        }
      }
      // A reply without either tag is read as the summary alone.
      const body = block(text, "summary") || (text.includes("<handoff>") ? "" : text.trim());
      if (body.length < MIN_SUMMARY_CHARS) {
        const why = r.isAnswered ? "short reply" : r.reason;
        $.ui.log(`segue: fallback to built-in (${why})`);
        if (e.trigger !== "precompute") {
          $.ui.toast(`built-in summary used (${why})` + (handoffPath ? `; handoff card: ${handoffPath}` : ""));
        }
        const res = await next(e);
        if (!handoffPath || !res.messages) return res;
        return { ...res, messages: [...res.messages, { role: "user", text: pointer(handoffPath, censusCommand, agents.length), toolUses: [] }] };
      }
      const u = r.usage;
      $.ui.log(`segue: ${e.trigger} by ${model}, in ${u.input_tokens} out ${u.output_tokens}` +
        (handoffPath ? `, handoff ${handoffPath}` : ", no handoff"));
      if (e.trigger !== "precompute") {
        $.ui.toast((handoffPath ? `handoff card: ${handoffPath}` : "summary written, no handoff card") +
          (agents.length ? ` · ${agents.length} subagent(s) were running: prompts in the card` : ""));
      }
      const summary = {
        role: "user",
        text: "This session is being continued from a previous conversation that ran out of context. " +
          "The summary below covers the earlier portion of the conversation.\n\nSummary:\n" + body +
          (handoffPath ? "\n\n" + pointer(handoffPath, censusCommand, agents.length) : ""),
        toolUses: [],
      };
      const kept = [summary];
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
