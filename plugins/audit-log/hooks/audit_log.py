#!/usr/bin/env python3
"""PostToolUse hook for Claude Code: append one JSON line per finished tool call.

The line says when, in which session and directory, which tool, and with what
input. Tool output is never written. File bodies and edit text are replaced by
their length, and strings that look like credentials are masked.
"""
import datetime
import json
import os
import re
import sys

MAX_COMMAND = 2000  # characters kept of a Bash command
MAX_STRING = 300    # characters kept of any other string
MAX_ITEMS = 40      # entries kept of a list or an object
MAX_DEPTH = 6
MASK = "[masked]"
# Input fields that hold file bodies or edit text: only their size is recorded.
BULK = {"content", "new_string", "old_string", "new_source", "edits"}

SECRET_NAME = r"[A-Za-z0-9_.-]*(?:passw(?:or)?d|secret|token|api[_-]?key|access[_-]?key|credential|auth(?![A-Za-z]))[A-Za-z0-9_.-]*"
SECRETS = [
    # private key blocks
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)", re.S), MASK),
    # user:password@ in a URL
    (re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s/:@]+:)[^\s/@]+(@)", re.I), r"\1" + MASK + r"\2"),
    # Authorization header values
    (re.compile(r"(\b(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1" + MASK),
    # name=value and name: value where the name says it is a secret
    (re.compile(r"(?<![A-Za-z0-9])(" + SECRET_NAME + r"\s*[=:]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s\"'&|;]+)", re.I),
     r"\1" + MASK),
    # --name value, for an option whose name says it is a secret
    (re.compile(r"(?<![A-Za-z0-9-])(--?" + SECRET_NAME + r"\s+)(?:\"[^\"]*\"|'[^']*'|[^\s\"'&|;-][^\s\"'&|;]*)", re.I),
     r"\1" + MASK),
    # tokens with a well-known shape
    (re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"), MASK),
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"), MASK),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), MASK),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), MASK),
    (re.compile(r"\bAIza[A-Za-z0-9_-]{30,}"), MASK),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), MASK),
]
SECRET_KEY = re.compile(r"\A" + SECRET_NAME + r"\Z", re.I)


def mask(text):
    for pattern, replacement in SECRETS:
        text = pattern.sub(replacement, text)
    return text


def clip(text, limit):
    text = mask(text)
    if len(text) <= limit:
        return text
    return text[:limit] + "...(+%d chars)" % (len(text) - limit)


def size_of(value):
    if isinstance(value, str):
        return {"chars": len(value)}
    if isinstance(value, (list, dict)):
        return {"items": len(value)}
    return {"type": type(value).__name__}


def reduce(value, limit=MAX_STRING, depth=0):
    """A copy of a tool input that is safe and small enough to keep."""
    if isinstance(value, str):
        return clip(value, limit)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if depth >= MAX_DEPTH:
        return size_of(value)
    if isinstance(value, list):
        kept = [reduce(item, limit, depth + 1) for item in value[:MAX_ITEMS]]
        if len(value) > MAX_ITEMS:
            kept.append("...(+%d items)" % (len(value) - MAX_ITEMS))
        return kept
    if isinstance(value, dict):
        kept = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= MAX_ITEMS:
                kept["..."] = "+%d keys" % (len(value) - MAX_ITEMS)
                break
            key = str(key)
            if key in BULK:
                kept[key] = size_of(item)
            elif SECRET_KEY.match(key) and isinstance(item, str):
                kept[key] = MASK
            else:
                kept[key] = reduce(item, limit, depth + 1)
        return kept
    return str(type(value).__name__)


def record(payload, now):
    tool = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if tool == "Bash" and isinstance(tool_input, dict):
        kept = reduce({key: item for key, item in tool_input.items() if key != "command"})
        kept["command"] = reduce(tool_input.get("command"), MAX_COMMAND)
    else:
        kept = reduce(tool_input)
    entry = {
        "ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session": payload.get("session_id"),
        "cwd": payload.get("cwd"),
        "tool": tool,
        "id": payload.get("tool_use_id"),
        "input": kept,
    }
    for name, field in (("agent", "agent_id"), ("ms", "duration_ms")):
        if payload.get(field) is not None:
            entry[name] = payload[field]
    return entry


def log_dir():
    return os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(os.path.expanduser("~"), ".claude", "audit-log")


def append(directory, now, entry):
    os.makedirs(directory, mode=0o700, exist_ok=True)
    path = os.path.join(directory, now.strftime("audit-%Y-%m-%d.jsonl"))
    line = (json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8", "replace")
    # One write on a descriptor opened for appending: lines of parallel sessions do not mix.
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, line)
    finally:
        os.close(descriptor)
    return path


def main():
    try:
        payload = json.loads(sys.stdin.buffer.read())
        if not isinstance(payload, dict) or not isinstance(payload.get("tool_name"), str):
            raise ValueError("no tool_name in the hook input")
        now = datetime.datetime.now(datetime.timezone.utc)
        append(log_dir(), now, record(payload, now))
    except Exception as error:  # the tool call has already run; say so and do not block
        print("audit-log: entry not written: %s" % error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
