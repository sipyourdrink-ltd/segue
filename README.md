<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sipyourdrink-ltd/segue/main/assets/segue-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/sipyourdrink-ltd/segue/main/assets/segue-light.svg">
  <img alt="segue: a long conversation runs into a compaction; a handoff card is written before it and read after it, and the conversation continues from the card" src="https://raw.githubusercontent.com/sipyourdrink-ltd/segue/main/assets/segue-light.svg" width="820">
</picture>

### Compaction that leaves a handoff card and continues from it — for Claude Code and Codex

[![tests](https://github.com/sipyourdrink-ltd/segue/actions/workflows/test.yml/badge.svg)](https://github.com/sipyourdrink-ltd/segue/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/sipyourdrink-ltd/segue)](https://github.com/sipyourdrink-ltd/segue/releases)
[![License](https://img.shields.io/github/license/sipyourdrink-ltd/segue)](LICENSE)

[install](#install) &middot; [Codex](#codex-cli-and-the-chatgpt-desktop-app) &middot; [what it costs](#what-it-costs) &middot; [what the agent reads](#what-the-agent-reads-afterwards) &middot; [options](#options) &middot; [limits](#limits)

</div>

---

> **Status: experimental.** segue uses Claude Code's function hooks, an interface that is switched on by an environment variable and may change between releases. When the hook is not loaded, compaction is the built-in one: nothing breaks, you only lose what segue adds. Needs Claude Code 2.1.278 or later; tested on 2.1.285 and 2.1.286.

After a compaction the agent keeps a summary and loses the thread: which step it was on, what it had already tried, what you told it not to do. segue is a Claude Code plugin that hooks `/compact` and auto-compact and does three things in one pass:

1. **Before** the conversation is replaced, it writes a **handoff card** to disk: what is done (with the commit or path that proves it), what is in flight, the next three steps, the traps.
2. It writes the **summary on Haiku** instead of the session's model. The session's model is never switched.
3. **After** the compaction, the conversation carries the card's path and one instruction: read it, check it against the repository, carry on from "Next steps".

### at a glance

- **A card on disk, not only a summary in context.** It survives the next compaction, a crash, and a move to another session.
- **About a cent per compaction.** One call to a small model over a transcript with tool output clipped. Numbers below.
- **Fails open.** A refused call, an API error, a short reply, a thrown error: the built-in summary runs as if segue were not there.
- **Subagents are not lost to a compaction.** An automatic compaction waits for the ones still running, a new one is refused when the context is nearly full, and the prompts of any still running when the summary is written go into the card.
- **Small enough to read.** One file per host, about 300 lines each, no dependencies. [`hooks/register.ts`](hooks/register.ts) for Claude Code, [`codex/segue.mjs`](codex/segue.mjs) for Codex.

### install

Two commands and one setting.

```bash
claude plugin marketplace add sipyourdrink-ltd/segue
```

```bash
claude plugin install segue@sipyourdrink
```

Then switch function hooks on: add one key to `env` in `~/.claude/settings.json`. It applies to the CLI and the desktop app alike.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

Start a new session. After the next `/compact` or auto-compact a toast says `handoff card: <path>`, and the card is in `~/.claude/handoffs/`. If the model call failed, the toast says `built-in summary used` and why.

<details>
<summary>Try it without installing, or run it from a clone</summary>

```bash
git clone https://github.com/sipyourdrink-ltd/segue
```

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ./segue
```

To keep a clone loaded in every session, set `CLAUDE_CODE_PLUGIN_DIRS` in the same `env` block to the clone's absolute path. The variable is a colon-separated list: if it already has a value, append to it instead of replacing it.

The first load writes type files into the clone (`.claude-plugin/types/`, `tsconfig.json`). They are ignored by git.

</details>

Update: `claude plugin marketplace update sipyourdrink`, then `claude plugin update segue@sipyourdrink`; or `git pull` in a clone. Remove: `claude plugin uninstall segue@sipyourdrink`. Sessions already running keep the compaction they started with.

### Codex CLI and the ChatGPT desktop app

The same card, pointer, hold and guard run under Codex through its command hooks: [`codex/segue.mjs`](codex/segue.mjs), one Node script with no dependencies, wired by [`codex/hooks.json`](codex/hooks.json). What differs from Claude Code:

| | Claude Code | Codex |
|---|---|---|
| handoff card before compaction | yes | yes, to `~/.codex/handoffs/` |
| pointer to the card afterwards | in the summary | as developer context (`PostCompact`) |
| hold an auto-compaction while subagents run | yes | yes (`continue: false`) |
| refuse a new subagent near the limit | yes | yes (`PreToolUse` on `spawn_agent`) |
| the summary itself | written on Haiku | Codex's own; a hook cannot replace it |
| who writes the card | `$.model.complete` on Haiku | `codex exec --ephemeral` on the model you pick (`SEGUE_MODEL`, default: your Codex default) |
| the context's fill | from the engine | estimated from the transcript's last `token_count` |

Install from a clone (hooks from plugins run only after you trust them in `/hooks`):

```bash
git clone https://github.com/sipyourdrink-ltd/segue ~/.codex/segue-plugin
```

Then register the marketplace at `~/.agents/plugins/marketplace.json` (the repository's own [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) is a template: point `source.path` at the clone), run `/plugins` in Codex, enable `segue`, and trust its hooks in `/hooks`. Without plugins, paste the five entries of `codex/hooks.json` into `~/.codex/hooks.json` with `$PLUGIN_ROOT` replaced by the clone's path.

Options are environment variables, read by the hook process: `SEGUE_MODEL`, `SEGUE_HANDOFF_DIR`, `SEGUE_CENSUS_COMMAND`, `SEGUE_HOLD_MINUTES`, `SEGUE_GUARD_PERCENT` — the same meaning as the Claude Code options below — and `SEGUE_TIMEOUT_SECONDS` (default 180) for the model call. Pick a fast model for `SEGUE_MODEL`: the call runs with low reasoning effort from an empty directory in a read-only sandbox, and the card is only as good as the model that writes it. When the call fails or times out, the compaction proceeds and a card with the running subagents is still written. State (running subagents, the last card's path) lives in the plugin's data directory, or `~/.codex/segue/` when the hooks are wired by hand.

### what it costs

One real conversation of 105k tokens, compacted three ways:

| | built-in, on the session's model (Opus) | built-in, session switched to Haiku | segue |
|---|---:|---:|---:|
| cost of the compaction | $0.31 warm cache · $1.12 cold | $0.10 | **≈ $0.011** |
| context left afterwards | ~5.9k tokens | | **816 tokens** |
| time | ~20 s | | **6.5 s** |

How this was measured: 2026-10-02, Claude Code 2.1.285, two runs per column, cost read from `modelUsage.costUSD` of a forked session; segue's call was 7.5k tokens in and 0.6k out. These figures are for the summary alone. The handoff card was added afterwards and adds its own output (roughly one to two thousand tokens) to the same call; that version has not been re-measured yet.

The smaller context afterwards matters more than the call itself: every later turn re-reads what the compaction left behind.

### what the agent reads afterwards

The compacted conversation is the summary, followed by this (and then your last message, if you had just sent one):

```text
Before this compaction a handoff card was written to
/Users/you/.claude/handoffs/2026-10-04-161207-3f9c2a1b.md. Continue the work
from it: read that file first, check it against the actual state (git status,
running processes), then carry on from its "Next steps". The card is a
hypothesis; the machine is the truth.
```

And the card it points to looks like this (an illustrative example, not a recording):

```markdown
# Handoff before compaction — 2026-10-04 161207 +0300 (session 3f9c2a1b)
- trigger: auto · session: 3f9c2a1b-… · cwd: /Users/you/work/billing
- written by haiku from the transcript and a census of the machine: a hypothesis, not the truth
- resume: read this card → check it against the repository's actual state → carry on from "Next steps"

## Goal and repo
- move invoice rounding from floats to integer cents · ~/work/billing · branch fix/rounding

## Done
- ✅ Money type with integer cents — src/money.ts (a41c9e2)
- ⚠️ unconfirmed: migration script ran on staging

## In flight
- ⏳ test suite — 3 failing in tests/invoice.test.ts · resume: `npm test -- invoice`

## Next steps
1. fix the half-cent case in `roundLine()` — src/invoice.ts:88
2. `npm test -- invoice`
3. push fix/rounding and open the PR

## Only the user
- decide whether historical invoices are re-rounded

## Read first
- src/money.ts
- tests/invoice.test.ts

## Traps
- do not touch the legacy exporter: the user said it is frozen until Q1
- banker's rounding was tried and rejected: totals must match the printed invoices
```

A line under **Done** carries a ✅ only when the transcript holds the artefact for it. Everything else is marked unconfirmed, so the agent re-checks instead of trusting.

### options

Three, all optional. Set them with `/plugin configure segue@sipyourdrink`, or in your user `settings.json` (project settings are not read for plugin options):

```json
{
  "pluginConfigs": {
    "segue@sipyourdrink": {
      "options": { "handoffDir": "~/notes/handoffs" }
    }
  }
}
```

For a clone loaded with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` the key is `segue`.

| option | default | what it does |
|---|---|---|
| `model` | `haiku` | the model that writes the summary and the card |
| `handoffDir` | `~/.claude/handoffs` | where the cards go; one file per compaction, `<date>-<time>-<session>.md` |
| `censusCommand` | empty | a shell command whose output is given to the model as the machine's state; empty means the built-in git census |
| `holdForAgentsMinutes` | `10` | how long an automatic compaction is held back while subagents of the conversation are still running; `0` never holds |
| `agentGuardPercent` | `90` | from this fill of the context a new subagent is refused until the conversation compacts or hands off; `0` turns the guard off |

The built-in census is `git status --branch`, `git worktree list`, the last five commits and the stash list, read at the moment of compaction. It is what lets the card say "3 uncommitted files on `fix/rounding`" from the machine instead of from memory. Outside a git repository there is no census and the card rests on the transcript alone. With a `censusCommand`, the instruction after compaction tells the agent to run that same command when it checks the card.

Text you pass to `/compact <instructions>` reaches the model for both the summary and the card. It decides what they keep; the card's sections stay as they are.

### how it works

```text
/compact or auto-compact
   │
   ├─ running subagents auto-compact with some still running → held, asked again later
   ├─ census            git state, or your censusCommand
   ├─ one model call    transcript (tool I/O clipped) + census  →  <summary> + <handoff>
   ├─ write the card    <handoffDir>/<date>-<time>-<session>.md
   ├─ replace history   summary + "continue from <card>"  (+ your last message, verbatim)
   └─ toast             handoff card: <path>
```

| if | then |
|---|---|
| the model call fails or the summary is too short | the built-in summary runs; a card that was written is still named after it |
| the card is cut off by the output limit | it is written as far as it got |
| the card cannot be written | the summary stands without the pointer |
| a subagent compacts its own transcript | segue stays out of it |
| auto-compaction comes while subagents of the conversation are still running | it is held back (`{ skip }`): the engine asks again before each request, and the compaction runs once they have answered, with their answers in the transcript. The hold ends at 96% of the context or after `holdForAgentsMinutes`, whichever first |
| subagents are still running when the compaction does run (`/compact`, the hold ran out) | their exact prompts go into the card, from the transcript, and the continued conversation is told to check their output on disk and relaunch the unfinished ones rather than wait |
| the conversation starts a subagent at `agentGuardPercent` of the context or above | the call is refused with the reason: a subagent started now would be stopped by the next compaction; compact or hand off first |

Each row is a test in [`hooks/register.test.ts`](hooks/register.test.ts), run against the engine itself. From a clone:

```bash
cd segue && claude plugin validate .claude-plugin/plugin.json && claude plugin test .
```

Neither command needs a login. `validate` also lists every engine call the module makes: one environment read (`HOME`), the session's id, working directory and context fill, the list of its agents, a clock read, file writes, the model call, child processes (in the source: `git`, `date`, and `sh` for your census command), a log line and a toast. There is no network call among them.

CI installs the latest Claude Code on every run, so a red badge means the interface moved, not that your install broke: yours falls back to the built-in compaction.

### limits

- **The interface is experimental.** A Claude Code update can change it. The failure mode is the built-in compaction, and the toast or the debug log says so.
- **The card is written by a small model.** It is told to cite an artefact for every "done" and to mark the rest unconfirmed, and the agent is told to check the card against the repository. It is still a hypothesis.
- **The summary is short on purpose** (up to 15 sentences). Detail belongs in the card and in the files it points to.
- **Very long transcripts are trimmed.** Tool output is clipped, and above about 420k characters the middle of the conversation is left out of the model call; the beginning and the recent part stay.
- **Cards are plain files and are never deleted.** A card can contain whatever the conversation contained. Keep `handoffDir` out of anything you share, and clear it when you like.
- **One compaction plugin at a time.** If another plugin also answers `session.compact`, only one of them writes the summary.
- **The transcript goes to the summary model** through Claude Code's own model access. segue makes no network call of its own.
- **Tested on macOS; CI runs the tests on Linux.** Without `date` and `sh` on the path, file names fall back to UTC and a custom census command does not run.

Something off? [Open an issue](https://github.com/sipyourdrink-ltd/segue/issues) with the toast text or the `segue:` line from `claude --debug`.

### why the name?

*Segue* is a direction in a score: go on to the next section without a pause. It comes from the same house as [Bernstein](https://github.com/sipyourdrink-ltd/bernstein).

### license

[Apache-2.0](LICENSE).
