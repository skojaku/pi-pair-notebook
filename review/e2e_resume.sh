#!/usr/bin/env bash
# D6: kill the tutor mid-session and start it again on the same sandbox.
#
# Usage: e2e_resume.sh <state_file>
# Prints the state file again (updated in place: new AGENT and PANE).
#
# The relaunch is the one e2e_setup.sh made, read back from the sandbox's
# e2e-launch.env — same model, same --no-extensions, same -e list. It used to
# be "re-run the herdr agent start line by hand", and a hand relaunch that
# drops the module's declared packages starts a tutor without
# ask_user_question: continue-or-fresh then comes out as plain text, which
# looks exactly like the tutor breaking P8.
#
# The marimo server is left alone. Closing the pane stops pi, and pi's
# shutdown stops a server it started; the new pi starts its own on the same
# notebook.py, as a student relaunching `pi` would.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
STATE="${1:?usage: e2e_resume.sh <state_file>}"
. "$STATE"
LAUNCH="$SANDBOX/e2e-launch.env"
[ -f "$LAUNCH" ] || { echo "error: $LAUNCH missing — this sandbox predates e2e_resume.sh; run e2e_setup.sh again" >&2; exit 1; }
. "$LAUNCH"

herdr pane close "$(pane_id "$AGENT")" >/dev/null 2>&1 || true
# Let pi's shutdown handler finish stopping the server before a new one wants
# the notebook.
sleep 3

NEW_AGENT="${AGENT%-r*}-r$$"
PANE=$(split_pane "$BASE_PANE" "$SANDBOX" "${PANE_ENVS[@]}")
[ -n "$PANE" ] || { echo "error: herdr pane split gave no pane id" >&2; exit 1; }
echo "note: resumed tutor pane $PANE (split off $BASE_PANE)" >&2
start_tutor "$NEW_AGENT" "$PANE" -- "${TUTOR_ARGS[@]}" || exit 1

# The new server may be on a new port.
MARIMO_URL_NEW=""
for _ in $(seq 1 120); do
  CAND=$(grep -aoE 'http://[a-zA-Z0-9.]+:[0-9]+' \
    "$SANDBOX/session_artifacts/marimo_server.log" 2>/dev/null | tail -1 || true)
  if [ -n "$CAND" ] && curl -sf -m 2 "$CAND/api/sessions" >/dev/null 2>&1; then
    MARIMO_URL_NEW="$CAND"; break
  fi
  sleep 1
done

python3 - "$STATE" "$NEW_AGENT" "$PANE" "${MARIMO_URL_NEW:-$MARIMO_URL}" <<'PY'
import sys
path, agent, pane, url = sys.argv[1:]
out = []
for line in open(path):
    k = line.split("=", 1)[0]
    if k == "AGENT": line = f"AGENT={agent}\n"
    elif k == "PANE": line = f"PANE={pane}\n"
    elif k == "MARIMO_URL": line = f"MARIMO_URL={url}\n"
    out.append(line)
open(path, "w").writelines(out)
PY
echo "$STATE"
