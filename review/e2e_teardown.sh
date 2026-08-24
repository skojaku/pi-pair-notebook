#!/usr/bin/env bash
# End a tutor E2E session: close the tutor pane and stop the marimo server.
# The sandbox (notebook, session_artifacts) is kept for Part S/P inspection.
#
# Usage: e2e_teardown.sh <state_file>
set -euo pipefail
. "$(dirname "$0")/lib.sh"
. "${1:?usage: e2e_teardown.sh <state_file>}"

herdr pane close "$(pane_id "$AGENT")" >/dev/null 2>&1 || true
kill "$(cat "$SANDBOX/session_artifacts/marimo.pid" 2>/dev/null)" 2>/dev/null || true
# marimo runs in its own session (setsid), so kill the whole process group —
# uv leaves a 4-deep chain and killing only the recorded pid strands it.
# `|| true` is load-bearing under `set -e`: in extension-owned mode (the
# default) there IS no marimo.pid, cat exits 1, and the assignment took the
# whole script down with it — so the pkill sweep below and the "artifacts
# kept in:" line never ran, and every gate run ended on a teardown error.
_MPID="$(cat "$SANDBOX/session_artifacts/marimo.pid" 2>/dev/null || true)"
[ -n "$_MPID" ] && kill -- "-$_MPID" 2>/dev/null || true
# In extension-owned mode there is no marimo.pid: closing the pane takes pi
# down and pi's shutdown handler stops the server. Sweep anything that
# outlived it — a marimo left holding the port makes the NEXT gate run look
# like a toolkit bug.
#
# By PORT, never by command line. This was `pkill -f "marimo edit --sandbox
# --no-token --headless notebook.py"`, and every tutor session on this machine
# runs a server with exactly that command line: a teardown here killed an
# instructor's own live session in m02-small-world, mid-lesson, and the tutor
# spent the next several turns asking a student to restart a notebook that
# something else had shot. The sandbox's port is in its own server log; only
# one process can hold a port, so this can only ever hit the run being torn
# down.
_PORT="$(sed -n 's|.*http://localhost:\([0-9][0-9]*\).*|\1|p' \
  "$SANDBOX/session_artifacts/marimo_server.log" 2>/dev/null | tail -1 || true)"
if [ -n "$_PORT" ]; then
  for _pid in $(lsof -t -nP -iTCP:"$_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    kill "$_pid" 2>/dev/null || true
  done
fi
# A headless browser (E2E_BROWSER_CMD) has no window and no parent watching it,
# so nothing else ever stops it. Ten probe runs leave ten of them holding a
# websocket to a server that is already gone.
if [ -n "${BROWSER_PID:-}" ]; then
  kill "$BROWSER_PID" 2>/dev/null || true
fi
# The children too — see the note in e2e_setup.sh. Matched on this run's own
# profile directory, so it cannot reach another run's browser or the
# reviewer's own.
if [ -n "${BROWSER_TAG:-}" ]; then
  pkill -f -- "$BROWSER_TAG" 2>/dev/null || true
fi
echo "artifacts kept in: $SANDBOX"
