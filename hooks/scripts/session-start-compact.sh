#!/bin/sh
# segue: SessionStart handler that re-injects the handoff pointer after a
# compaction, resume or clear event.
#
# This classic hook complements the function hook: the function hook writes
# the card and bolts a trailing user message onto the compacted summary;
# this hook reads the card pointer the function hook left under cwd/.claude/
# and returns it as `additionalContext`, which the engine inserts right after
# the summary. If the function hook never ran (CLI without function-hook
# runtime), this is the only path the next session has to the card.
#
# Fail-open: no pointer file → no context injected. The hook never fails
# session start; worst case the context block is empty.

set -eu

EVENT=$(cat 2>/dev/null || true)
cwd=$(printf '%s' "$EVENT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
: "${cwd:=$PWD}"
source=$(printf '%s' "$EVENT" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

ptr="$cwd/.claude/handoff-current.md"
if [ ! -f "$ptr" ]; then
  # Nothing to inject; return the empty-but-valid shape.
  printf '{}\n'
  exit 0
fi

# Build the additional-context block. Keep it short: the engine already has
# the summary; this is a cross-reference, not a replay.
body=$(sed -n '1,40p' "$ptr" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'BEGIN{p=""} {p=p $0 "\\n"} END{sub(/\\n$/,"",p); print p}')

printf '{"hookSpecificOutput":{"additionalContext":"segue [%s]: continuing from a prior handoff.\\n\\n%s"}}\n' \
  "${source:-unknown}" "$body"
exit 0
