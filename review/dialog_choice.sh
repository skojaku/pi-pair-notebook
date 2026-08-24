#!/usr/bin/env bash
# Answer an on-screen select dialog (e.g. "Where to next?").
#
# Usage: dialog_choice.sh <state_file> <option_index|label_substring> [screen_lines]
#   0-based index, or a substring of the option's label (safer to read back).
#
# This does NOT blind-fire N arrow keys. A run that did exactly that pressed
# "I don't code" and logged "comfortable with Python": the widget was still
# drawing, the keys landed somewhere else, and the graded record ended up
# holding an answer the student never gave — indistinguishable, afterwards,
# from a tutor fabricating one. So instead it reads the screen, moves ONE row,
# reads again, and only presses Enter once the cursor is provably on the row it
# was asked for. A dropped keystroke costs another loop instead of a wrong
# answer, and a picker that is not there at all is an error rather than an
# Enter into the chat box.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
. "${1:?usage: dialog_choice.sh <state_file> <option_index|label_substring> [screen_lines]}"
WANT="${2:?0-based option index or a label substring required}"
PROBE="$(dirname "$0")/dialog_probe.py"

PANE=$(pane_id "$AGENT")

probe() { read_screen "$AGENT" 60 | python3 "$PROBE"; }

# Wait for a picker to actually be on screen before touching the keyboard.
STATE_JSON=""
for _ in $(seq 1 20); do
  STATE_JSON=$(probe)
  [ "$(printf '%s' "$STATE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["focus"] is not None)')" = True ] && break
  sleep 1
done

read -r KIND FOCUS COUNT <<<"$(printf '%s' "$STATE_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["kind"], d["focus"], len(d["options"]))
')"
if [ "$FOCUS" = None ]; then
  echo "error: no option list on screen — is this a typed-answer turn? use student_turn.sh" >&2
  read_screen "$AGENT" "${3:-50}" >&2
  exit 1
fi

# Resolve a label substring to an index; an index is used as-is.
TARGET=$(printf '%s' "$STATE_JSON" | WANT="$WANT" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
want = os.environ["WANT"]
opts = d["options"]
if want.isdigit():
    i = int(want)
    if not (0 <= i < len(opts)):
        print(f"error: index {i} out of range for {len(opts)} options: {opts}", file=sys.stderr)
        sys.exit(1)
    print(i)
else:
    hits = [i for i, o in enumerate(opts) if want.lower() in (o or "").lower()]
    if len(hits) != 1:
        print(f"error: {len(hits)} options match {want!r}: {opts}", file=sys.stderr)
        sys.exit(1)
    print(hits[0])
')

# One row at a time, toward the target, re-reading after each. Direction
# matters: the two pickers disagree about the ends. The ask_user_question
# widget wraps (so `up` from the top walks onto "Type something." and submits
# an empty answer), while the toolkit's own picker clamps — a loop that only
# ever pressed `down` sat on the last row pressing down forever.
STEPS=0
MAX=$((COUNT * 2 + 4))
while [ "$FOCUS" != "$TARGET" ]; do
  if [ "$STEPS" -ge "$MAX" ]; then
    echo "error: cursor stuck at row $FOCUS after $STEPS moves, wanted $TARGET" >&2
    read_screen "$AGENT" "${3:-50}" >&2
    exit 1
  fi
  if [ "$FOCUS" -lt "$TARGET" ]; then KEY=down; else KEY=up; fi
  herdr pane send-keys "$PANE" "$KEY" >/dev/null
  STEPS=$((STEPS + 1))
  sleep 0.6
  FOCUS=$(probe | python3 -c 'import json,sys; print(json.load(sys.stdin)["focus"])')
  [ "$FOCUS" = None ] && { echo "error: the picker vanished mid-navigation" >&2; exit 1; }
done

CHOSE=$(probe | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["options"][d["focus"]])')
echo "# selecting: $CHOSE" >&2
herdr pane send-keys "$PANE" enter >/dev/null

# The graded log records what the dialog actually returned (student_picked).
# After answering, check it against the option you meant to choose — that is
# the only way to tell a tutor error from a harness misfire.
wait_idle "$AGENT" "${TURN_TIMEOUT:-240}"
read_screen "$AGENT" "${3:-50}"
