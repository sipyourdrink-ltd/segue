#!/bin/sh
# segue: PreCompact fallback for hosts without the function-hook runtime.
#
# Classic command hooks receive the base event JSON on stdin
# ({session_id, transcript_path, cwd, trigger, custom_instructions, ...})
# and have their stdout appended to the compaction summarizer's prompt.
# This script carries forward the same signal the function hook would:
# a short block naming the branch, open todos (on disk) and the last
# handoff pointer (also on disk) so the summarizer keeps them in sight.
#
# Fail-open: any missing tool or empty section is skipped silently. The
# script never fails the compaction; worst case it prints nothing.

set -eu

# Read the event JSON (ignored on hosts without a working stdin — hooks
# run with a short timeout and no interactive input).
EVENT=$(cat 2>/dev/null || true)

# Extract cwd and session_id without jq (common on CI hosts). Falls back to $PWD.
cwd=$(printf '%s' "$EVENT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
: "${cwd:=$PWD}"
sid=$(printf '%s' "$EVENT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
sid8=$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9_-' | cut -c1-8)

# A short banner so the summarizer knows these lines are not from the model.
printf -- '--- segue pre-compact snapshot (host: %s) ---\n' "${CLAUDE_CODE_ENTRYPOINT:-cli}"

# Git state at cwd, same shape as the function hook's census block.
if command -v git >/dev/null 2>&1 && git -C "$cwd" rev-parse --show-toplevel >/dev/null 2>&1; then
  printf '\n$ git status --porcelain=v1 --branch\n'
  git -C "$cwd" status --porcelain=v1 --branch 2>/dev/null | head -30
  printf '\n$ git log --oneline -5\n'
  git -C "$cwd" log --oneline -5 2>/dev/null
fi

# Session-scoped handoff pointer first; only fall back to handoff-current.md
# when it belongs to this session or carries no session line.
ptr=""
if [ -n "$sid8" ] && [ -f "$cwd/.claude/handoff-${sid8}.md" ]; then
  ptr="$cwd/.claude/handoff-${sid8}.md"
elif [ -f "$cwd/.claude/handoff-current.md" ]; then
  ptr_sid=$(sed -n 's/^- session:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$cwd/.claude/handoff-current.md" | head -1)
  if [ -z "$ptr_sid" ] || [ -z "$sid" ] || [ "$ptr_sid" = "$sid" ]; then
    ptr="$cwd/.claude/handoff-current.md"
  fi
fi
if [ -n "$ptr" ]; then
  printf '\n--- last handoff pointer in cwd ---\n'
  sed -n '1,20p' "$ptr"
fi

# On-disk task ledger: prefer this session's own directory when present, and
# never pick another session's UUID-named task directory.
TASKS_DIR="$HOME/.claude/tasks"
if [ -d "$TASKS_DIR" ]; then
  target=""
  if [ -n "$sid" ] && [ -d "$TASKS_DIR/$sid" ]; then
    target="$sid"
  else
    for cand in $(ls -1t "$TASKS_DIR" 2>/dev/null); do
      [ -d "$TASKS_DIR/$cand" ] || continue
      if [ -n "$sid" ] && printf '%s' "$cand" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
        continue
      fi
      target="$cand"
      break
    done
  fi
  if [ -n "$target" ] && [ -d "$TASKS_DIR/$target" ]; then
    printf '\n--- open tasks on disk (%s) ---\n' "$target"
    for f in "$TASKS_DIR/$target"/*.json; do
      [ -f "$f" ] || continue
      content=$(sed -n 's/.*"content"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)
      status=$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)
      [ -n "$content" ] || continue
      printf -- '- [%s] %s\n' "${status:-?}" "$content"
    done
  fi
fi

exit 0
