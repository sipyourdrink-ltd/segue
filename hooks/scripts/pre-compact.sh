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

# Extract cwd without jq (common on CI hosts). Falls back to $PWD.
cwd=$(printf '%s' "$EVENT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
: "${cwd:=$PWD}"

# A short banner so the summarizer knows these lines are not from the model.
printf -- '--- segue pre-compact snapshot (host: %s) ---\n' "${CLAUDE_CODE_ENTRYPOINT:-cli}"

# Git state at cwd, same shape as the function hook's census block.
if command -v git >/dev/null 2>&1 && git -C "$cwd" rev-parse --show-toplevel >/dev/null 2>&1; then
  printf '\n$ git status --porcelain=v1 --branch\n'
  git -C "$cwd" status --porcelain=v1 --branch 2>/dev/null | head -30
  printf '\n$ git log --oneline -5\n'
  git -C "$cwd" log --oneline -5 2>/dev/null
fi

# Current handoff pointer the function hook writes under cwd/.claude/.
if [ -f "$cwd/.claude/handoff-current.md" ]; then
  printf '\n--- last handoff pointer in cwd ---\n'
  sed -n '1,20p' "$cwd/.claude/handoff-current.md"
fi

# On-disk task ledger (most recently modified list dir).
TASKS_DIR="$HOME/.claude/tasks"
if [ -d "$TASKS_DIR" ]; then
  latest=$(ls -1t "$TASKS_DIR" 2>/dev/null | head -1)
  if [ -n "$latest" ] && [ -d "$TASKS_DIR/$latest" ]; then
    printf '\n--- open tasks on disk (%s) ---\n' "$latest"
    for f in "$TASKS_DIR/$latest"/*.json; do
      [ -f "$f" ] || continue
      content=$(sed -n 's/.*"content"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)
      status=$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)
      [ -n "$content" ] || continue
      printf -- '- [%s] %s\n' "${status:-?}" "$content"
    done
  fi
fi

exit 0
