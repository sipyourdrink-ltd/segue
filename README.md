<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sipyourdrink-ltd/segue/main/assets/segue-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/sipyourdrink-ltd/segue/main/assets/segue-light.svg">
  <img alt="segue: a long conversation runs into a compaction; a handoff card is written before it and read after it, and the conversation continues from the card" src="https://raw.githubusercontent.com/sipyourdrink-ltd/segue/main/assets/segue-light.svg" width="820">
</picture>

### Claude Code compaction that continues without a break

[![tests](https://github.com/sipyourdrink-ltd/segue/actions/workflows/test.yml/badge.svg)](https://github.com/sipyourdrink-ltd/segue/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/sipyourdrink-ltd/segue)](LICENSE)

[install](#install-in-a-minute) &middot; [what it costs](#what-it-costs) &middot; [what the agent reads](#what-the-agent-reads-afterwards) &middot; [options](#options) &middot; [limits](#limits)

</div>

---

> **Status: experimental.** segue uses Claude Code's function hooks, an interface that is switched on by an environment variable and may change between releases. When the hook is not loaded, compaction is the built-in one: nothing breaks, you only lose what segue adds.

After a compaction the agent keeps a summary and loses the thread: which step it was on, what it had already tried, what you told it not to do. segue is a Claude Code plugin that hooks `/compact` and auto-compact and does three things in one pass:

1. **Before** the conversation is replaced, it writes a **handoff card** to disk: what is done (with the commit or path that proves it), what is in flight, the next three steps, the traps.
2. It writes the **summary on Haiku** instead of the session's model. The session's model is never switched.
3. **After** the compaction, the conversation ends with the card's path and one instruction: read it, check it against the repository, carry on from "Next steps".

### at a glance

- **A card on disk, not only a summary in context.** It survives the next compaction, a crash, and a move to another session.
- **About a cent per compaction.** One call to a small model over a transcript with tool output clipped. Numbers below.
- **Fails open.** A refused call, an API error, a short reply, a thrown error: the built-in summary runs as if segue were not there.
- **Small enough to read.** One file, about 200 lines, no network calls, no dependencies. [`hooks/register.ts`](hooks/register.ts).

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

The compacted conversation is the summary, followed by this:

```text
Before this compaction a handoff card was written to
~/.claude/handoffs/2026-10-04-1612-3f9c2a1b.md. Continue the work from it:
read that file first, check it against the actual state (git status, running
processes), then carry on from its "Next steps". The card is a hypothesis;
the machine is the truth.
```

And the card it points to looks like this (an illustrative example, not a recording):

```markdown
# Handoff before compaction — 2026-10-04 1612 +0300 (session 3f9c2a1b)
- trigger: auto · session: 3f9c2a1b-… · cwd: ~/work/billing
- written by haiku from the transcript and a census of the machine: a hypothesis, not the truth

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

### install in a minute

```bash
git clone https://github.com/sipyourdrink-ltd/segue ~/.claude/segue
```

Try it for one session:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ~/.claude/segue
```

Keep it for every new session, CLI and desktop: add two keys to `env` in `~/.claude/settings.json` (use the absolute path).

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/.claude/segue"
  }
}
```

Check that it works: run `/compact` in a conversation with some history, then look in `~/.claude/handoffs/`. With `claude --debug` the log has a line like `segue: manual by haiku, in 7512 out 1480, handoff /Users/you/.claude/handoffs/…md`.

Remove it: delete the two keys. Sessions already running keep the compaction they started with.

### options

Set them in `/config`, or under `pluginConfigs.segue.options` in `settings.json`.

| option | default | what it does |
|---|---|---|
| `model` | `haiku` | the model that writes the summary and the card |
| `handoffDir` | `~/.claude/handoffs` | where the cards go; one file per compaction, `<date>-<time>-<session>.md` |
| `censusCommand` | empty | a shell command whose output is given to the model as the machine's state; empty means the built-in git census |

The built-in census is `git status --branch`, `git worktree list`, the last five commits and the stash list, read at the moment of compaction. It is what lets the card say "3 uncommitted files on `fix/rounding`" from the machine instead of from memory. Outside a git repository there is no census and the card rests on the transcript alone.

Text you pass to `/compact <instructions>` reaches the summary model as it does today.

### how it works

```text
/compact or auto-compact
   │
   ├─ census            git state, or your censusCommand
   ├─ one model call    transcript (tool I/O clipped) + census  →  <summary> + <handoff>
   ├─ write the card    <handoffDir>/<date>-<time>-<session>.md
   └─ replace history   summary + "continue from <card>"  (+ your last message, verbatim)
```

| if | then |
|---|---|
| the model call fails or the summary is too short | the built-in summary runs; a card that was written is still named after it |
| the card is cut off by the output limit | it is written as far as it got |
| the card cannot be written | the summary stands without the pointer |
| a subagent compacts its own transcript | segue stays out of it |

Each row is a test in [`hooks/register.test.ts`](hooks/register.test.ts), run against the engine itself:

```bash
claude plugin validate . && claude plugin test .
```

`validate` also lists every engine call the module makes: one environment read (`HOME`), file writes, the model call, a clock read, and child processes (in the source these are `git`, `date` and your census command). There is no network call among them.

### limits

- **The interface is experimental.** A Claude Code update can change it. The failure mode is the built-in compaction, and the debug log says so.
- **The card is written by a small model.** It is told to cite an artefact for every "done" and to mark the rest unconfirmed, and the agent is told to check the card against the repository. It is still a hypothesis.
- **The summary is short on purpose** (up to 15 sentences). Detail belongs in the card and in the files it points to.
- **The transcript goes to the summary model** through Claude Code's own model access, the same account as the session. Nothing is sent anywhere else.
- **Tested on macOS with Claude Code 2.1.286.** Linux should behave the same. Without `date` and `sh` on the path, file names fall back to UTC and a custom census command does not run.

### why the name?

*Segue* is a direction in a score: go on to the next section without a pause. It comes from the same house as [Bernstein](https://github.com/sipyourdrink-ltd/bernstein).

### license

[Apache-2.0](LICENSE).
