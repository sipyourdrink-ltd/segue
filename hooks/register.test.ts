import { expect, test } from "claude-code/testing";

const SUMMARY = "We changed the compaction hook in hooks/register.ts and validated the plugin. ".repeat(4).trim();
const CARD = ("## Next steps\n1. `claude plugin validate .`\n").repeat(6).trim();
const CARD_PATH = "/home/u/.claude/handoffs/2026-10-04-161207-01234567.md";

const MESSAGES = [
  { role: "user", text: "Improve the compaction hook", toolUses: [] },
  { role: "assistant", text: "Reading hooks/register.ts", toolUses: [] },
];

const answered = text => ({ isAnswered: true, text, usage: { input_tokens: 10, output_tokens: 5 } });

// The world beneath the plugin: what the model answers, what the machine says.
// A call on `$` is answered with { value }; an event (session.compact) with its result.
function world(on, reply, { git = true, disk = true, now = () => 0 } = {}) {
  const seen = { writes: [], prompts: [], runs: [], toasts: [] };
  const ran = (exitCode, stdout) => ({ value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } });
  on("env.get", async () => ({ value: "/home/u" }));
  on("session.id", async () => ({ value: "0123456789abcdef" }));
  on("session.cwd", async () => ({ value: "/home/u/work" }));
  on("clock.now", async () => ({ value: now() }));
  on("ui.log", async () => ({ value: undefined }));
  on("ui.toast", async (_$, e) => { seen.toasts.push(e.text); return { value: undefined }; });
  on("process.run", async (_$, e) => {
    seen.runs.push(e.argv.join(" "));
    if (e.argv[0] === "date") return ran(0, "2026-10-04 161207 +0300\n");
    if (e.argv[0] === "sh") return ran(0, "custom census line\n");
    if (!git) return ran(128, "");
    return ran(0, e.argv.includes("status") ? "## main...origin/main [ahead 1]\n M a.ts\n" : "x\n");
  });
  on("fs.write", async (_$, e) => {
    if (!disk) return { deny: "read-only file system" };
    seen.writes.push(e);
    return { value: undefined };
  });
  on("model.complete", async (_$, e) => { seen.prompts.push(e.prompt); return { value: reply }; });
  on("session.compact", async () => ({ messages: [{ role: "user", text: "built-in summary", toolUses: [] }] }));
  return seen;
}

test("writes the handoff card before compacting and names it in the summary", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  const r = await $.session.compact({ trigger: "auto", messages: MESSAGES });

  expect(seen.writes.length).toBe(1);
  expect(seen.writes[0].path).toBe(CARD_PATH);
  expect(seen.writes[0].text).toContain("## Next steps");
  expect(seen.writes[0].text).toContain("trigger: auto");
  expect(seen.prompts[0]).toContain("<census>\n$ git status --porcelain=v1 --branch\n## main...origin/main [ahead 1]");
  expect(r.messages.length).toBe(1);
  expect(r.messages[0].text).toContain(SUMMARY);
  expect(r.messages[0].text).toContain(CARD_PATH);
  expect(r.messages[0].text).toContain("Continue the work from it");
  expect(r.messages[0].text).not.toContain("<handoff>");
  expect(seen.toasts).toEqual([`handoff card: ${CARD_PATH}`]);
});

test("a card cut off by the output limit is still written", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}`));
  const r = await $.session.compact({ trigger: "manual", messages: MESSAGES });
  expect(seen.writes.length).toBe(1);
  expect(r.messages[0].text).toContain(CARD_PATH);
});

test("outside a git repository there is no census and the summary still stands", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>`), { git: false });
  const r = await $.session.compact({ trigger: "manual", messages: MESSAGES });
  expect(seen.writes.length).toBe(0);
  expect(seen.prompts[0]).not.toContain("<census>");
  expect(r.messages[0].text).toContain(SUMMARY);
  expect(r.messages[0].text).not.toContain("handoff card");
});

test("options: model, folder and census command are taken from userConfig",
  { options: { model: "sonnet", handoffDir: "/srv/cards", censusCommand: "make census" } }, async ($, on) => {
    const seen = world(on, answered(`<summary>${SUMMARY}</summary><handoff>${CARD}</handoff>`));
    const r = await $.session.compact({ trigger: "manual", messages: MESSAGES });
    expect(seen.runs).toContain("sh -c make census");
    expect(seen.prompts[0]).toContain("<census>\ncustom census line");
    expect(seen.writes[0].path).toBe("/srv/cards/2026-10-04-161207-01234567.md");
    expect(seen.writes[0].text).toContain("written by sonnet");
    expect(r.messages[0].text).toContain("(run `make census`)");
  });

test("a card that cannot be written leaves the summary without the pointer", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary><handoff>${CARD}</handoff>`), { disk: false });
  const r = await $.session.compact({ trigger: "auto", messages: MESSAGES });
  expect(seen.writes.length).toBe(0);
  expect(r.messages[0].text).toContain(SUMMARY);
  expect(r.messages[0].text).not.toContain("handoff card");
  expect(seen.toasts).toEqual(["summary written, no handoff card"]);
});

test("text after /compact reaches the summary and the card", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary><handoff>${CARD}</handoff>`));
  await $.session.compact({ trigger: "manual", instructions: "keep the SQL migrations", messages: MESSAGES });
  expect(seen.prompts[0]).toContain("The user also asked: keep the SQL migrations");
  expect(seen.prompts[0]).toContain("the card's sections and line format stay as specified");
});

test("a reply without tags is read as the summary alone", async ($, on) => {
  const seen = world(on, answered(SUMMARY));
  const r = await $.session.compact({ trigger: "manual", messages: MESSAGES });
  expect(seen.writes.length).toBe(0);
  expect(r.messages[0].text).toContain(SUMMARY);
});

test("a short summary falls back to the built-in one, which still names the card", async ($, on) => {
  const seen = world(on, answered(`<summary>too short</summary><handoff>${CARD}</handoff>`));
  const r = await $.session.compact({ trigger: "auto", messages: MESSAGES });
  expect(seen.writes.length).toBe(1);
  expect(r.messages[0].text).toBe("built-in summary");
  expect(r.messages[1].text).toContain(CARD_PATH);
  expect(seen.toasts).toEqual([`built-in summary used (short reply); handoff card: ${CARD_PATH}`]);
});

test("a failed model call leaves the compaction to the built-in summary", async ($, on) => {
  const seen = world(on, { isAnswered: false, reason: "api-error", status: null, kind: "authentication_failed" });
  const r = await $.session.compact({ trigger: "auto", messages: MESSAGES });
  expect(seen.writes.length).toBe(0);
  expect(r.messages.length).toBe(1);
  expect(r.messages[0].text).toBe("built-in summary");
});

test("a subagent's compaction is not touched", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary><handoff>${CARD}</handoff>`));
  const r = await $.session.compact({ trigger: "auto", agentId: "a1", messages: MESSAGES });
  expect(seen.prompts.length).toBe(0);
  expect(seen.writes.length).toBe(0);
  expect(r.messages[0].text).toBe("built-in summary");
});

const AGENT_MESSAGES = [
  ...MESSAGES,
  { role: "assistant", text: "Two agents in the background", toolUses: [
    { tool_use_id: "toolu_1", tool: "Agent", agentId: "a1", input: { description: "Audit the parser", subagent_type: "Explore", prompt: "List every caller of parse() in src/." }, text: "launched" },
    { tool_use_id: "toolu_2", tool: "Agent", agentId: "a2", input: { description: "Fix the lint", prompt: "Run the linter and fix src/a.ts." }, text: "launched" },
  ] },
];

test("subagents still running at compaction land in the card with their exact prompts", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  on("agent.list", async () => ({ value: [
    { id: "a1", description: "Audit the parser", type: "Explore", status: "running" },
    { id: "a2", description: "Fix the lint", type: "general-purpose", status: "completed" },
  ] }));
  const r = await $.session.compact({ trigger: "auto", messages: AGENT_MESSAGES });

  expect(seen.writes[0].text).toContain("## Next steps");
  expect(seen.writes[0].text).toContain("## Subagents running at compaction");
  expect(seen.writes[0].text).toContain("### 1. Audit the parser · Explore · id a1");
  expect(seen.writes[0].text).toContain("List every caller of parse() in src/.");
  expect(seen.writes[0].text).not.toContain("Run the linter");
  expect(r.messages[0].text).toContain("1 subagent(s) were running at compaction");
});

test("the running subagents are saved even when the model writes no card", async ($, on) => {
  const seen = world(on, { isAnswered: false, reason: "timeout" });
  on("agent.list", async () => ({ value: [{ id: "a1", description: "Audit the parser", type: "Explore", status: "running" }] }));
  const r = await $.session.compact({ trigger: "manual", messages: AGENT_MESSAGES });

  expect(seen.writes.length).toBe(1);
  expect(seen.writes[0].text).toContain("List every caller of parse() in src/.");
  expect(r.messages[r.messages.length - 1].text).toContain("1 subagent(s) were running at compaction");
});

test("without an agent listing, only calls still waiting for an answer count as running", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  on("agent.list", async () => ({ deny: "not available" }));
  const waiting = [...MESSAGES, { role: "assistant", text: "", toolUses: [
    { tool_use_id: "toolu_3", tool: "Agent", input: { description: "Audit the parser", prompt: "List every caller of parse() in src/." } },
    { tool_use_id: "toolu_4", tool: "Agent", input: { description: "Fix the lint", prompt: "Run the linter and fix src/a.ts." }, text: "done", result: {} },
  ] }];
  const r = await $.session.compact({ trigger: "auto", messages: waiting });

  expect(seen.writes[0].text).toContain("List every caller of parse() in src/.");
  expect(seen.writes[0].text).not.toContain("Run the linter");
  expect(r.messages[0].text).toContain("1 subagent(s)");
});

// A conversation at a given fill, with one subagent of the main loop still running.
function nearLimit(on, percent, { running = true } = {}) {
  const state = { percent, running };
  on("session.usage", async () => ({ value: { startedAt: 0, context: { window: 200_000, percent: state.percent } } }));
  on("agent.list", async () => ({ value: [{ id: "a1", description: "Audit the parser", type: "Explore", status: state.running ? "running" : "completed" }] }));
  return state;
}

test("an automatic compaction is held while a subagent runs and the context has room", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  nearLimit(on, 91);
  const r = await $.session.compact({ trigger: "auto", messages: AGENT_MESSAGES });

  expect(r.skip).toContain("1 subagent(s) still running");
  expect(seen.prompts.length).toBe(0);
  expect(seen.writes.length).toBe(0);
  expect(seen.toasts).toEqual(["compaction held: 1 subagent(s) still running, context 91%"]);

  // Asked again while it still runs: held again, no second toast.
  const again = await $.session.compact({ trigger: "auto", messages: AGENT_MESSAGES });
  expect(again.skip).toContain("still running");
  expect(seen.toasts.length).toBe(1);
});

test("the hold ends when the context nears the limit: the compaction runs with the prompts in the card", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  nearLimit(on, 97);
  const r = await $.session.compact({ trigger: "auto", messages: AGENT_MESSAGES });

  expect(r.skip).toBeUndefined();
  expect(seen.writes[0].text).toContain("## Subagents running at compaction");
  expect(r.messages[0].text).toContain("1 subagent(s) were running at compaction");
});

test("the hold ends when the subagents have answered", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  nearLimit(on, 91, { running: false });
  const r = await $.session.compact({ trigger: "auto", messages: AGENT_MESSAGES });

  expect(r.skip).toBeUndefined();
  expect(seen.writes[0].text).not.toContain("## Subagents running at compaction");
  expect(r.messages[0].text).toContain(SUMMARY);
});

test("the hold is bounded in time", { options: { holdForAgentsMinutes: 0.001 } }, async ($, on) => {
  let t = 0;
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`), { now: () => (t += 1000) });
  nearLimit(on, 91);
  const first = await $.session.compact({ trigger: "auto", messages: AGENT_MESSAGES });
  expect(first.skip).toContain("still running");
  // A second later the hold has run out: the compaction goes ahead, prompts in the card.
  const r = await $.session.compact({ trigger: "auto", messages: AGENT_MESSAGES });

  expect(r.skip).toBeUndefined();
  expect(seen.writes[0].text).toContain("List every caller of parse() in src/.");
});

test("a hold of zero minutes never holds; an unknown fill is not held either", { options: { holdForAgentsMinutes: 0 } }, async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  nearLimit(on, 91);
  const r = await $.session.compact({ trigger: "auto", messages: AGENT_MESSAGES });
  expect(r.skip).toBeUndefined();
  expect(seen.writes.length).toBe(1);
});

test("/compact typed by the person is not held; the toast says what was running", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  nearLimit(on, 91);
  const r = await $.session.compact({ trigger: "manual", messages: AGENT_MESSAGES });

  expect(r.skip).toBeUndefined();
  expect(seen.toasts[0]).toContain("1 subagent(s) were running: prompts in the card");
});

test("a subagent is refused near the limit, with the way out; allowed with room, in a subagent's loop, or with the guard off", async ($, on) => {
  on("tool.call", async () => ({ result: { agentId: "a9" }, text: "launched" }));
  const fill = nearLimit(on, 92);
  const input = { description: "Audit the parser", prompt: "List every caller of parse() in src/." };

  const refused = await $.tool.call({ tool: "Agent", input });
  expect(refused.deny).toContain("context is at 92% (guard at 90%)");
  expect(refused.deny).toContain("Compact or hand off first");

  const inner = await $.tool.call({ tool: "Agent", input, agentId: "a1" });
  expect(inner.deny).toBeUndefined();

  const other = await $.tool.call({ tool: "Read", input: { file_path: "/x" } });
  expect(other.deny).toBeUndefined();

  fill.percent = 40;
  const allowed = await $.tool.call({ tool: "Agent", input });
  expect(allowed.deny).toBeUndefined();
  expect(allowed.text).toBe("launched");
});

test("the guard can be turned off", { options: { agentGuardPercent: 0 } }, async ($, on) => {
  on("tool.call", async () => ({ result: { agentId: "a9" }, text: "launched" }));
  nearLimit(on, 99);
  const r = await $.tool.call({ tool: "Agent", input: { description: "x", prompt: "y" } });
  expect(r.deny).toBeUndefined();
});

const TODO_MESSAGES = [
  ...MESSAGES,
  { role: "assistant", text: "", toolUses: [
    { tool_use_id: "toolu_t1", tool: "TodoWrite", input: { todos: [
      { content: "Audit the parser", activeForm: "Auditing the parser", status: "completed" },
      { content: "Fix the lint rule", activeForm: "Fixing the lint rule", status: "in_progress" },
      { content: "Ship the release", activeForm: "Shipping the release", status: "pending" },
    ] } },
  ] },
];

test("the latest TodoWrite is captured verbatim in the card, with counts and markers", async ($, on) => {
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  const r = await $.session.compact({ trigger: "auto", messages: TODO_MESSAGES });
  expect(seen.writes[0].text).toContain("## Task tracker at compaction");
  expect(seen.writes[0].text).toContain("Open 2 · done 1");
  expect(seen.writes[0].text).toContain("- [x] Audit the parser");
  expect(seen.writes[0].text).toContain("- [⏳] Fixing the lint rule");
  expect(seen.writes[0].text).toContain("- [ ] Ship the release");
  // The todos reach the summarizer too, as a block it must preserve.
  expect(seen.prompts[0]).toContain("<todos>");
  expect(seen.prompts[0]).toContain("Audit the parser");
  // And the pointer tells the next session the tracker is authoritative.
  expect(r.messages[0].text).toContain("Task tracker at compaction");
});

test("todos are still saved when the model's reply is unusable", async ($, on) => {
  const seen = world(on, { isAnswered: false, reason: "timeout" });
  const r = await $.session.compact({ trigger: "manual", messages: TODO_MESSAGES });
  expect(seen.writes.length).toBe(1);
  expect(seen.writes[0].text).toContain("## Task tracker at compaction");
  expect(seen.writes[0].text).toContain("Ship the release");
  // The pointer attached after the built-in summary still names the tracker.
  expect(r.messages[r.messages.length - 1].text).toContain("Task tracker at compaction");
});

test("when $.fs.exists is unavailable, the project-state block is omitted and the prompt stays clean", async ($, on) => {
  // The default world function registers no fs.exists handler, so every
  // ancestor lookup returns false — projectState() must degrade to "".
  const seen = world(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`));
  const r = await $.session.compact({ trigger: "auto", messages: MESSAGES });
  expect(seen.prompts[0]).not.toContain("<project-state>");
  expect(seen.writes[0].text).not.toContain("## Open work in project trees");
  expect(r.messages[0].text).not.toContain("Open work in project trees");
  // The existing path keeps working: census + summary unchanged.
  expect(seen.writes[0].text).toContain("## Next steps");
});

// A world where $.env.get returns distinct values per name and $.fs.exists is
// stubbed by directory. Used to exercise the data-dir-gated writes.
function worldWithEnv(on, reply, envMap, existsMap, extra = {}) {
  const seen = { writes: [], reads: {}, toasts: [], logs: [] };
  const ran = (exitCode, stdout) => ({ value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } });
  on("env.get", async (_$, e) => ({ value: envMap[e.name] !== undefined ? envMap[e.name] : "" }));
  on("session.id", async () => ({ value: "0123456789abcdef" }));
  on("session.cwd", async () => ({ value: "/home/u/work" }));
  on("clock.now", async () => ({ value: 0 }));
  on("ui.log", async (_$, e) => { seen.logs.push(e.text); return { value: undefined }; });
  on("ui.toast", async (_$, e) => { seen.toasts.push(e.text); return { value: undefined }; });
  on("process.run", async (_$, e) => {
    if (e.argv[0] === "date") return ran(0, "2026-10-04 161207 +0300\n");
    return ran(0, "## main\n");
  });
  on("fs.exists", async (_$, e) => ({ value: Boolean(existsMap[e.path]) }));
  if (extra.fsRead) on("fs.read", extra.fsRead);
  else on("fs.read", async (_$, e) => {
    if (seen.reads[e.path] === undefined) return { deny: "not found" };
    return { value: seen.reads[e.path] };
  });
  if (extra.fsList) on("fs.list", extra.fsList);
  if (extra.fsStat) on("fs.stat", extra.fsStat);
  on("fs.write", async (_$, e) => {
    seen.writes.push(e);
    seen.reads[e.path] = e.text;
    return { value: undefined };
  });
  on("model.complete", async () => ({ value: reply }));
  on("session.compact", async () => ({ messages: [{ role: "user", text: "built-in summary", toolUses: [] }] }));
  return seen;
}

test("the summary is persisted alongside the card and the card is indexed, when the plugin data dir exists", async ($, on) => {
  const seen = worldWithEnv(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`),
    { HOME: "/home/u", CLAUDE_PLUGIN_DATA: "/home/u/.local/share/segue", CLAUDE_CODE_ENTRYPOINT: "cli" },
    { "/home/u/.local/share/segue": true });
  await $.session.compact({ trigger: "auto", messages: MESSAGES });
  const paths = seen.writes.map(w => w.path);
  expect(paths).toContain("/home/u/.claude/handoffs/2026-10-04-161207-01234567.md");
  expect(paths).toContain("/home/u/.claude/handoffs/2026-10-04-161207-01234567.summary.md");
  expect(paths).toContain("/home/u/.local/share/segue/cards.jsonl");
  const idx = seen.writes.find(w => w.path.endsWith("cards.jsonl"));
  expect(idx.text).toContain("\"card\":\"/home/u/.claude/handoffs/2026-10-04-161207-01234567.md\"");
  expect(idx.text).toContain("\"trigger\":\"auto\"");
  // The log carries the host label when CLAUDE_CODE_ENTRYPOINT is set.
  expect(seen.logs.some(l => l.includes("[cli]"))).toBe(true);
});

test("when the data dir does not exist, neither the summary file nor the index is written", async ($, on) => {
  const seen = worldWithEnv(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`),
    { HOME: "/home/u" }, {});
  await $.session.compact({ trigger: "manual", messages: MESSAGES });
  const paths = seen.writes.map(w => w.path);
  // The card itself is still written to the default handoff dir.
  expect(paths).toContain("/home/u/.claude/handoffs/2026-10-04-161207-01234567.md");
  // But the summary sibling and the index are skipped.
  expect(paths.some(p => p.endsWith(".summary.md"))).toBe(false);
  expect(paths.some(p => p.endsWith("cards.jsonl"))).toBe(false);
});

test("a .claude/ pointer file is written when the cwd has one", async ($, on) => {
  const seen = worldWithEnv(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`),
    { HOME: "/home/u" }, { "/home/u/work/.claude": true });
  await $.session.compact({ trigger: "auto", messages: MESSAGES });
  const pointer = seen.writes.find(w => w.path === "/home/u/work/.claude/handoff-current.md");
  expect(pointer).toBeDefined();
  expect(pointer.text).toContain("2026-10-04-161207-01234567.md");
  expect(pointer.text).toContain("Read that file first");
});

test("disk task ledger is read when the transcript carries no TodoWrite", async ($, on) => {
  const seen = worldWithEnv(on, answered(`<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>`),
    { HOME: "/home/u" }, { "/home/u/.claude/tasks": true },
    {
      fsList: async (_$, e) => {
        if (e.path === "/home/u/.claude/tasks") return { value: ["list-1"] };
        if (e.path === "/home/u/.claude/tasks/list-1") return { value: ["t1.json", "t2.json", "readme.txt"] };
        return { value: [] };
      },
      fsStat: async (_$, e) => ({ value: { mtimeMs: e.path.endsWith("list-1") ? 1000 : 0 } }),
      fsRead: async (_$, e) => {
        if (e.path.endsWith("t1.json")) return { value: JSON.stringify({ content: "Ship v0.7.0", status: "in_progress", activeForm: "Shipping v0.7.0" }) };
        if (e.path.endsWith("t2.json")) return { value: JSON.stringify({ content: "Write docs", status: "pending" }) };
        return { deny: "not found" };
      },
    });
  await $.session.compact({ trigger: "auto", messages: MESSAGES });
  const card = seen.writes.find(w => w.path.endsWith("01234567.md"));
  expect(card.text).toContain("## Task tracker at compaction");
  expect(card.text).toContain("Shipping v0.7.0");
  expect(card.text).toContain("Write docs");
});
