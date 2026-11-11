# audit-log

A Claude Code plugin with one hook. After each tool call finishes, the hook appends one JSON line to a daily file: when, in which session and directory, which tool, with what input.

```bash
claude plugin marketplace add sipyourdrink-ltd/segue
```

```bash
claude plugin install audit-log@sipyourdrink
```

Needs `python3` on the path. No dependencies, no options, no network call.

## Where the log is

`audit-YYYY-MM-DD.jsonl` (UTC date) in the plugin's data folder, which Claude Code passes as `CLAUDE_PLUGIN_DATA`; without it, `~/.claude/audit-log/`. The folder is created with mode 700 and each file with mode 600. Sessions that run at the same time write to the same file, one line per call.

## One line

```json
{"ts":"2026-11-11T13:13:26Z","session":"3f9c2a1b","cwd":"/work/project","tool":"Bash","id":"toolu_01","input":{"description":"Show status","command":"git status"},"ms":42}
```

| Field | Meaning |
|---|---|
| `ts` | time the line was written, UTC |
| `session` | session id |
| `cwd` | working directory of the session |
| `tool` | tool name, including MCP tools |
| `id` | tool call id |
| `input` | the tool's input, reduced as described below |
| `ms` | run time in milliseconds, when Claude Code reports it |
| `agent` | subagent id, when the call came from one |

Read it with any JSON-lines tool:

```bash
jq -r 'select(.tool == "Bash") | [.ts, .input.command] | @tsv' ~/.claude/audit-log/audit-*.jsonl
```

## What is left out

- **Tool output.** Never written.
- **File bodies and edit text.** `content`, `old_string`, `new_string`, `new_source` and `edits` are replaced by their size, for example `{"chars": 5000}`. The file path stays.
- **Long values.** A Bash command is cut at 2,000 characters, any other string at 300, a list or an object at 40 entries. The cut is marked with the number left out.
- **Strings that look like credentials.** Values after a name that contains `password`, `secret`, `token`, `api_key`, `access_key`, `credential` or `auth` (`NAME=value`, `name: value`, `--name value`), `Bearer` and `Basic` header values, a password inside a URL, private key blocks, and tokens with a well-known prefix are replaced by `[masked]`.

Masking works on patterns and will miss a secret that has no telling name or shape, for example a bare value passed as a positional argument. Treat the log as private.

## Limits

- Calls that were refused or failed before finishing are not logged: the hook runs on `PostToolUse` only.
- Files are never rotated or deleted. Remove old ones yourself.
- If a line cannot be written, the hook prints `audit-log: entry not written: …` and exits with status 1. Claude Code shows that to you and the session goes on.

## Tests

```bash
python3 plugins/audit-log/tests/test_audit_log.py
```

## License

[Apache-2.0](../../LICENSE).
