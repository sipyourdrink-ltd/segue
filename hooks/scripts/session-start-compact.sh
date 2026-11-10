#!/bin/sh
# segue: SessionStart handler that re-injects the handoff pointer after a
# compaction, resume or clear event, and the state of this session's Workflow
# runs resolved from disk at this moment.
#
# This classic hook complements the function hook: the function hook writes
# the card and bolts a trailing user message onto the compacted summary;
# this hook reads the card pointer the function hook left under cwd/.claude/
# and prints it, which the engine adds to the context right after the summary.
# If the function hook never ran (CLI without function-hook runtime), this is
# the only path the next session has to the card.
#
# The card is written once, before the compaction; a Workflow run started in
# the background usually ends after it. So the runs are not read from the card
# but resolved here, every time: a run directory
# ~/.claude/projects/<project>/<session>/subagents/workflows/wf_*/journal.jsonl
# without its terminal record ~/.claude/projects/<project>/<session>/workflows/wf_*.json
# is still running; with the record, the record's status is the outcome.
#
# Output is plain text: for SessionStart the engine adds stdout to the context.
# Fail-open: no pointer file and no runs → nothing printed. A field that cannot
# be read is printed as "id unknown"; the hook never fails session start.

set -eu

# A journal untouched this long is no evidence of a live run any more.
STALE_MINUTES=30
MAX_RUNS=10

EVENT=$(cat 2>/dev/null || true)
field() {
  printf '%s' "$EVENT" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}
cwd=$(field cwd)
: "${cwd:=$PWD}"
source=$(field source)
sid=$(field session_id)
transcript=$(field transcript_path)

# Modification time in epoch seconds; GNU stat first, then BSD stat.
mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

# Top-level status and taskId of a terminal record, tab-separated; empty when unreadable.
record_fields() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 -c 'import json, sys
try:
    r = json.load(open(sys.argv[1]))
    print("%s\t%s" % (r.get("status") or "", r.get("taskId") or ""))
except Exception:
    pass' "$1" 2>/dev/null || true
}

# The task id the launch result gave for a run, from the session transcript.
task_from_transcript() {
  [ -n "$transcript" ] && [ -f "$transcript" ] || return 0
  # The run id and its task id sit in the same JSON string of the launch result.
  grep -F "$1" "$transcript" 2>/dev/null \
    | LC_ALL=C sed -n "s/.*Task ID: \([A-Za-z0-9]*\)[^\"]*$1.*/\1/p" 2>/dev/null | head -1 || true
}

workflow_runs() {
  [ -n "$sid" ] || return 0
  now=$(date +%s)
  ls -t "$HOME"/.claude/projects/*/"$sid"/subagents/workflows/wf_*/journal.jsonl 2>/dev/null | head -"$MAX_RUNS" |
  while IFS= read -r journal; do
    rundir=${journal%/journal.jsonl}
    run=${rundir##*/}
    sessdir=${rundir%/subagents/workflows/*}
    terminal="$sessdir/workflows/$run.json"
    script=$(ls "$HOME"/.claude/projects/*/"$sid"/workflows/scripts/*-"$run".js 2>/dev/null | head -1 || true)
    if [ -f "$terminal" ]; then
      fields=$(record_fields "$terminal")
      status=$(printf '%s' "$fields" | cut -f1)
      task=$(printf '%s' "$fields" | cut -f2)
      [ -n "$task" ] || task=$(task_from_transcript "$run")
      out=""
      [ -n "$task" ] && out=$(ls /tmp/claude-*/*/"$sid"/tasks/"$task".output 2>/dev/null | head -1 || true)
      printf -- '- %s · ended: %s · task %s · result %s\n' "$run" "${status:-status unknown}" \
        "${task:-id unknown}" "${out:-in $terminal (field result)}"
      continue
    fi
    age=$(( (now - $(mtime "$journal")) / 60 ))
    started=$(grep '"type"[[:space:]]*:[[:space:]]*"started"' "$journal" 2>/dev/null || true)
    starts=$(printf '%s' "$started" | grep -c . || true)
    keys=$(printf '%s' "$started" | sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u | grep -c . || true)
    phase=$(printf '%s' "$started" | sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | tail -1)
    progress="phase id unknown"
    if [ -n "$script" ]; then
      titles=$(head -60 "$script" | sed -n '/phases[[:space:]]*:/,/^[[:space:]]*\]/p' \
        | grep -o "title:[[:space:]]*['\"][^'\"]*" | sed "s/^title:[[:space:]]*['\"]//" || true)
      n=$(printf '%s' "$titles" | grep -c . || true)
      k=""
      [ -n "$phase" ] && k=$(printf '%s\n' "$titles" | grep -n -x -F "$phase" | head -1 | cut -d: -f1 || true)
      [ "$n" -gt 0 ] && progress="phase ${k:-?}/$n${phase:+ ($phase)}"
    fi
    task=$(task_from_transcript "$run")
    if [ "$age" -gt "$STALE_MINUTES" ]; then
      state="stale, check: no terminal record and the journal idle ${age}m"
    else
      state="running: journal ${age}m ago"
    fi
    printf -- '- %s · %s · %s · retries %s · task %s · script %s\n' "$run" "$state" "$progress" \
      "$((starts - keys))" "${task:-id unknown}" "${script:-id unknown}"
  done
}

runs=$(workflow_runs 2>/dev/null || true)

ptr="$cwd/.claude/handoff-current.md"
if [ -f "$ptr" ]; then
  # A cross-reference, not a replay: the engine already has the summary.
  printf 'segue [%s]: continuing from a prior handoff.\n\n' "${source:-unknown}"
  sed -n '1,40p' "$ptr"
fi

if [ -n "$runs" ]; then
  printf '\nsegue: Workflow runs of this session, resolved from disk now (newer than anything in the card). '
  printf 'A running one keeps running and reports back with a task notification: do not relaunch it. '
  printf 'Resume a stale one only after reading its journal: Workflow {scriptPath, resumeFromRunId: <wf id>}.\n'
  printf '%s\n' "$runs"
fi
exit 0
