import { expect, test } from "claude-code/testing";

const SUMMARY = "We changed the compaction hook in hooks/register.ts and validated the plugin. ".repeat(4).trim();
const CARD = ("## Next steps\n1. `claude plugin validate .`\n").repeat(6).trim();
const CARD_PATH = "/home/u/.claude/handoffs/2026-10-04-1612-01234567.md";

const MESSAGES = [
  { role: "user", text: "Improve the compaction hook", toolUses: [] },
  { role: "assistant", text: "Reading hooks/register.ts", toolUses: [] },
];

const answered = text => ({ isAnswered: true, text, usage: { input_tokens: 10, output_tokens: 5 } });

// The world beneath the plugin: what the model answers, what the machine says.
// A call on `$` is answered with { value }; an event (session.compact) with its result.
function world(on, reply, { git = true } = {}) {
  const seen = { writes: [], prompts: [], runs: [] };
  const ran = (exitCode, stdout) => ({ value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } });
  on("env.get", async () => ({ value: "/home/u" }));
  on("session.id", async () => ({ value: "0123456789abcdef" }));
  on("session.cwd", async () => ({ value: "/home/u/work" }));
  on("clock.now", async () => ({ value: 0 }));
  on("ui.log", async () => ({ value: undefined }));
  on("process.run", async (_$, e) => {
    seen.runs.push(e.argv.join(" "));
    if (e.argv[0] === "date") return ran(0, "2026-10-04 1612 +0300\n");
    if (e.argv[0] === "sh") return ran(0, "custom census line\n");
    if (!git) return ran(128, "");
    return ran(0, e.argv.includes("status") ? "## main...origin/main [ahead 1]\n M a.ts\n" : "x\n");
  });
  on("fs.write", async (_$, e) => { seen.writes.push(e); return { value: undefined }; });
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
    await $.session.compact({ trigger: "manual", messages: MESSAGES });
    expect(seen.runs).toContain("sh -c make census");
    expect(seen.prompts[0]).toContain("<census>\ncustom census line");
    expect(seen.writes[0].path).toBe("/srv/cards/2026-10-04-1612-01234567.md");
    expect(seen.writes[0].text).toContain("written by sonnet");
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
