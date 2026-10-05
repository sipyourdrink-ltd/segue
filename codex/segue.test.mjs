import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "segue.mjs");
const SUMMARY = "The hook under test was rewritten and its tests were run against a synthetic rollout. ".repeat(4).trim();
const CARD = "## Goal and repo\nsegue codex adapter\n## Next steps\n1. `node --test codex/`\n".repeat(4).trim();
const REPLY = `<summary>${SUMMARY}</summary>\n<handoff>${CARD}</handoff>\n`;
const SPAWN_PROMPT = "Explore the repository and list every hook event the adapter handles.";

// A synthetic Codex rollout: a few messages, one tool call, one spawn_agent whose
// answer names agent-7, and a trailing token count that sets the context's fill.
function fixture(dir, percent) {
  const line = (type, payload) => JSON.stringify({ timestamp: "2026-10-05T07:00:00.000Z", type, payload });
  const lines = [
    line("session_meta", { id: "sess-1", cwd: dir }),
    line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "# AGENTS.md\n" + "rule ".repeat(400) }] }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Port segue to Codex" }] }),
    line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading the hook docs" }] }),
    line("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls codex" }), call_id: "c1" }),
    line("response_item", { type: "function_call_output", call_id: "c1", output: "hooks.json\nsegue.mjs" }),
    line("response_item", { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ agent_type: "explorer", prompt: SPAWN_PROMPT }), call_id: "c2" }),
    line("response_item", { type: "function_call_output", call_id: "c2", output: JSON.stringify({ agent_id: "agent-7", status: "running" }) }),
  ];
  if (percent !== undefined) {
    lines.push(line("event_msg", { type: "token_count", info: { last_token_usage: { total_tokens: percent * 1000 }, model_context_window: 100_000 } }));
  }
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// A `codex` that records its arguments and stdin and writes the canned reply after -o.
function shim(dir, reply = REPLY) {
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/argv.txt"
cat > "${dir}/prompt.txt"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
[ -n "$out" ] && printf '%s' '${reply.replace(/'/g, "'\\''")}' > "$out"
exit 0
`);
  chmodSync(bin, 0o755);
  return bin;
}

function world({ percent = 50, codexBin } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "segue-test-"));
  const transcript = fixture(dir, percent);
  const bin = codexBin === undefined ? shim(dir) : codexBin;
  const env = {
    ...process.env,
    HOME: dir,
    PLUGIN_DATA: join(dir, "data"),
    SEGUE_HANDOFF_DIR: join(dir, "handoffs"),
    SEGUE_CODEX_BIN: bin,
    SEGUE_CENSUS_COMMAND: "",
  };
  delete env.SEGUE_MODEL;
  const call = (event, input, extraEnv = {}) => {
    const body = typeof input === "string" ? input : JSON.stringify({ session_id: "sess-1", transcript_path: transcript, cwd: dir, hook_event_name: event, ...input });
    const r = spawnSync(process.execPath, [SCRIPT, event], { input: body, env: { ...env, ...extraEnv }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { out: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const cards = () => existsSync(env.SEGUE_HANDOFF_DIR) ? readdirSync(env.SEGUE_HANDOFF_DIR).map(f => readFileSync(join(env.SEGUE_HANDOFF_DIR, f), "utf8")) : [];
  const holdFile = join(env.PLUGIN_DATA, "sess-1", "hold.json");
  return { dir, env, call, cards, holdFile, argv: () => readFileSync(join(dir, "argv.txt"), "utf8").trim().split("\n"), prompt: () => readFileSync(join(dir, "prompt.txt"), "utf8") };
}

test("pre-compact writes the card and names it", () => {
  const w = world();
  const { out } = w.call("pre-compact", { trigger: "manual" });
  const [card] = w.cards();
  assert.ok(card, "a card was written");
  assert.match(card, /^# Handoff before compaction — \d{4}-\d{2}-\d{2} \d{6} [+-]\d{4} \(session sess-1\)/);
  assert.match(card, /written by codex exec \(default model\)/);
  assert.match(card, /## Next steps/);
  assert.match(out.systemMessage, /^segue: handoff card .*sess-1\.md$/);
  const prompt = w.prompt();
  assert.match(prompt, /USER: Port segue to Codex/);
  assert.match(prompt, /\[tool exec_command /);
  assert.ok(!prompt.includes("<census>"), "no census outside a git repository");
  assert.ok(prompt.indexOf("rule rule") < prompt.indexOf("USER:") && !prompt.includes("rule ".repeat(150)), "developer message is clipped");
});

test("pre-compact includes a git census inside a repository", () => {
  const w = world();
  const git = (...a) => spawnSync("git", a, { cwd: w.dir, encoding: "utf8" });
  if (git("--version").status !== 0) return;
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first");
  w.call("pre-compact", { trigger: "manual" });
  assert.match(w.prompt(), /<census>\n\$ git status --porcelain=v1 --branch/);
});

test("post-compact points at the card", () => {
  const w = world();
  const { out: pre } = w.call("pre-compact", { trigger: "manual" });
  const path = pre.systemMessage.replace("segue: handoff card ", "");
  const { out } = w.call("post-compact", { trigger: "manual" });
  assert.equal(out.hookSpecificOutput.hookEventName, "PostCompact");
  assert.ok(out.hookSpecificOutput.additionalContext.includes(path));
  assert.match(out.hookSpecificOutput.additionalContext, /"Next steps"/);
  assert.ok(!out.hookSpecificOutput.additionalContext.includes("subagent(s) were running"));
});

test("post-compact without a card is silent", () => {
  const w = world();
  assert.deepEqual(w.call("post-compact", { trigger: "auto" }).out, {});
});

test("auto compaction is held while a subagent runs", () => {
  const w = world({ percent: 70 });
  w.call("subagent-start", { agent_id: "agent-7", agent_type: "explorer" });
  const { out } = w.call("pre-compact", { trigger: "auto" });
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /1 subagent\(s\) still running, context 70%/);
  assert.match(out.systemMessage, /^compaction held: /);
  assert.ok(existsSync(w.holdFile));
  assert.equal(w.cards().length, 0);
});

test("manual compaction is not held and saves the subagent's prompt", () => {
  const w = world({ percent: 70 });
  w.call("subagent-start", { agent_id: "agent-7", agent_type: "explorer" });
  const { out } = w.call("pre-compact", { trigger: "manual" });
  assert.ok(!("continue" in out));
  assert.ok(!existsSync(w.holdFile));
  const [card] = w.cards();
  assert.match(card, /## Subagents running at compaction/);
  assert.match(card, /### 1\. explorer · id agent-7 · since 20/);
  assert.ok(card.includes(SPAWN_PROMPT));
  const { out: post } = w.call("post-compact", { trigger: "manual" });
  assert.match(post.hookSpecificOutput.additionalContext, /1 subagent\(s\) were running at compaction/);
});

test("hold expires after the configured minutes", () => {
  const w = world({ percent: 70 });
  w.call("subagent-start", { agent_id: "agent-7", agent_type: "explorer" });
  mkdirSync(dirname(w.holdFile), { recursive: true });
  writeFileSync(w.holdFile, JSON.stringify({ since: Date.now() - 11 * 60_000 }));
  const { out } = w.call("pre-compact", { trigger: "auto" });
  assert.ok(!("continue" in out));
  assert.equal(w.cards().length, 1);
  assert.ok(!existsSync(w.holdFile));
});

test("no hold past 96% of the context", () => {
  const w = world({ percent: 97 });
  w.call("subagent-start", { agent_id: "agent-7", agent_type: "explorer" });
  const { out } = w.call("pre-compact", { trigger: "auto" });
  assert.ok(!("continue" in out));
  assert.equal(w.cards().length, 1);
});

test("hold is off with SEGUE_HOLD_MINUTES=0", () => {
  const w = world({ percent: 70 });
  w.call("subagent-start", { agent_id: "agent-7", agent_type: "explorer" });
  const { out } = w.call("pre-compact", { trigger: "auto" }, { SEGUE_HOLD_MINUTES: "0" });
  assert.ok(!("continue" in out));
});

test("subagent-stop releases the hold", () => {
  const w = world({ percent: 70 });
  w.call("subagent-start", { agent_id: "agent-7", agent_type: "explorer" });
  w.call("subagent-stop", { agent_id: "agent-7", agent_type: "explorer" });
  const { out } = w.call("pre-compact", { trigger: "auto" });
  assert.ok(!("continue" in out));
  assert.equal(w.cards().length, 1);
  assert.ok(!w.cards()[0].includes("## Subagents running"));
});

test("spawn_agent is refused at 93%", () => {
  const w = world({ percent: 93 });
  const { out } = w.call("pre-tool-use", { tool_name: "spawn_agent", tool_input: { prompt: "x" }, tool_use_id: "t1" });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /context is at 93% \(guard at 90%\)/);
  assert.deepEqual(w.call("pre-tool-use", { tool_name: "exec_command", tool_input: {}, tool_use_id: "t2" }).out, {});
  assert.deepEqual(w.call("pre-tool-use", { tool_name: "spawn_agent", tool_input: {}, tool_use_id: "t3" }, { SEGUE_GUARD_PERCENT: "0" }).out, {});
});

test("spawn_agent passes at 50% and when the fill is unknown", () => {
  assert.deepEqual(world({ percent: 50 }).call("pre-tool-use", { tool_name: "spawn_agent", tool_input: {}, tool_use_id: "t1" }).out, {});
  assert.deepEqual(world({ percent: undefined }).call("pre-tool-use", { tool_name: "spawn_agent", tool_input: {}, tool_use_id: "t1" }).out, {});
});

test("codex missing still saves the running subagents", () => {
  const w = world({ codexBin: join(tmpdir(), "segue-no-such-codex") });
  w.call("subagent-start", { agent_id: "agent-7", agent_type: "explorer" });
  const { out } = w.call("pre-compact", { trigger: "manual" });
  assert.match(out.systemMessage, /^segue: handoff card /);
  const [card] = w.cards();
  assert.match(card, /## Subagents running at compaction/);
  assert.ok(!card.includes("## Next steps"));
});

test("codex missing and nothing running: no card, a reason", () => {
  const w = world({ codexBin: join(tmpdir(), "segue-no-such-codex") });
  const { out } = w.call("pre-compact", { trigger: "manual" });
  assert.equal(out.systemMessage, "segue: no handoff card (codex exec failed)");
  assert.equal(w.cards().length, 0);
});

test("a short reply writes no card", () => {
  const w = world();
  shim(w.dir, "<summary>too short</summary><handoff>too short</handoff>");
  const { out } = w.call("pre-compact", { trigger: "manual" });
  assert.equal(out.systemMessage, "segue: no handoff card (short reply)");
});

test("garbage stdin is harmless", () => {
  const w = world();
  const { out, stderr } = w.call("pre-compact", "not json");
  assert.deepEqual(out, {});
  assert.match(stderr, /^segue: /);
  assert.deepEqual(w.call("no-such-event", { trigger: "manual" }).out, {});
});

test("codex exec is called the documented way", () => {
  const w = world();
  w.call("pre-compact", { trigger: "manual" });
  let argv = w.argv();
  assert.equal(argv[0], "exec");
  for (const flag of ["--ephemeral", "--skip-git-repo-check", "--ignore-rules", "-o"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
  assert.equal(argv[argv.indexOf("-c") + 1], 'model_reasoning_effort="low"');
  assert.ok(argv[argv.indexOf("-C") + 1].startsWith(tmpdir()), "runs from a scratch directory, not the repository");
  assert.equal(argv[argv.length - 1], "-");
  assert.ok(!argv.includes("-m"), "no model flag by default");
  assert.ok(w.prompt().startsWith("You prepare the hand-over"), "system text leads the prompt");
  assert.match(w.prompt(), /do not run commands or use tools/);
  w.call("pre-compact", { trigger: "manual" }, { SEGUE_MODEL: "cheap" });
  argv = w.argv();
  assert.equal(argv[argv.indexOf("-m") + 1], "cheap");
  assert.match(w.cards().at(-1), /written by codex exec \(cheap\)/);
});
