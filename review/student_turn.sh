#!/usr/bin/env bash
# Send one student message to the tutor, wait for its reply, print the screen.
#
# Usage: student_turn.sh <state_file> "<message>" [screen_lines]
set -euo pipefail
. "$(dirname "$0")/lib.sh"
. "${1:?usage: student_turn.sh <state_file> \"<message>\" [screen_lines]}"
MSG="${2:?message required}"

# Refuse to type into an open picker. A picker takes the keyboard: the text
# goes nowhere, the Enter selects whatever row the cursor is on, and the run
# carries on looking normal — a reviewer doing this by accident gets a
# transcript where the student's sentence vanished and a choice they never
# made was recorded, which is indistinguishable from a real tutor fault. Say
# so instead, and name the tool that does work.
if read_screen "$AGENT" 60 | python3 "$(dirname "$0")/dialog_probe.py" |
   python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["focus"] is not None else 1)'; then
  echo "error: an option list is on screen — answer it with dialog_choice.sh, not student_turn.sh." >&2
  echo "       (typing here would be swallowed by the picker and select a row at random)" >&2
  read_screen "$AGENT" "${3:-50}" >&2
  exit 1
fi

herdr agent send "$AGENT" "$MSG" >/dev/null
sleep 1
herdr pane send-keys "$(pane_id "$AGENT")" enter >/dev/null
wait_idle "$AGENT" "${TURN_TIMEOUT:-240}"
read_screen "$AGENT" "${3:-50}"
