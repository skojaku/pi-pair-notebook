#!/usr/bin/env bash
# Open a live tutor session standing AT one checkpoint, ready for its first
# question.
#
# Usage: checkpoint_probe.sh <module_dir> <checkpoint_id> [agent_name]
# Prints the state file the other harness scripts take.
#
#   STATE=$(./checkpoint_probe.sh ../m01-euler-tour cp5_csr)
#   ./screen.sh "$STATE"                       # the tutor is asking cp5_csr
#   ./student_turn.sh "$STATE" "a few petabytes"
#   ./checkpoint_verify.py "$STATE" cp5_csr    # what landed in the notebook
#   ./e2e_teardown.sh "$STATE"
#
# It seeds the sandbox from the module's golden notebook (seed_checkpoint.py),
# starts the session, and answers the continue-or-fresh dialog the extension
# opens whenever a log already exists. What comes back is a tutor that has
# just recapped where you two left off and is asking the checkpoint you named.
#
# Two deliberate differences from the full gate, both in the direction of
# running a dozen of these at once:
#
#   * the marimo server is pre-started (E2E_EXTERNAL_MARIMO=1), so the
#     server-lifecycle paths are NOT under test here — the full run from cp0
#     is where those live;
#   * the page is woken by a headless browser instead of the reviewer's own,
#     so ten parallel probes do not open ten windows.
#
# Both can be overridden from the environment.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"

MODULE_DIR=$(cd "${1:?usage: checkpoint_probe.sh <module_dir> <checkpoint_id> [agent_name]}" && pwd)
CP="${2:?checkpoint id required}"
AGENT="${3:-probe-${CP}-$$}"

SEED_DIR="${E2E_SEED_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/seed-${CP}-XXXXXX")}"
"$HERE/seed_checkpoint.py" "$MODULE_DIR" "$CP" "$SEED_DIR" >/dev/null

export E2E_SEED_DIR="$SEED_DIR"
export E2E_EXTERNAL_MARIMO="${E2E_EXTERNAL_MARIMO:-1}"
if [ -z "${E2E_BROWSER_CMD:-}" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  # Its own profile directory per probe: two headless Chromes sharing one
  # profile fight over the lock and the second exits without connecting, which
  # looks from the tutor's side like a notebook that never woke up.
  export E2E_BROWSER_CMD="'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new --disable-gpu --no-first-run --user-data-dir=$(mktemp -d "${TMPDIR:-/tmp}/chrome-probe-XXXXXX")"
fi

STATE=$("$HERE/e2e_setup.sh" "$MODULE_DIR" "$AGENT")
# shellcheck source=/dev/null
. "$STATE"

# Its own tab. Ten probes at once split one tab ten ways, and a pane four
# columns wide wraps the picker's labels one character to a line — so
# dialog_probe.py reads "C\no\nn\nt..." and every option match fails. That
# looks exactly like a broken dialog and is a window-manager artifact.
herdr pane move "$(pane_id "$AGENT")" --new-tab --no-focus >/dev/null 2>&1 || true

# The first model turn is a greeting plus the continue-or-fresh dialog. Wait
# for the picker rather than for a fixed number of seconds — a cold gateway
# takes a minute, a warm one takes ten seconds.
FOUND=0
for _ in $(seq 1 "${PROBE_DIALOG_TIMEOUT:-40}"); do
  if read_screen "$AGENT" 60 | python3 "$HERE/dialog_probe.py" |
     python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["focus"] is not None else 1)'; then
    FOUND=1
    break
  fi
  sleep 5
done

if [ "$FOUND" = 1 ]; then
  # "Continue", not the whole label. A picker wraps its rows to the pane
  # width, and dialog_probe.py reads what is on the screen — so the option
  # the resume brief specifies word for word comes back as "Continue" with
  # the rest on the next line, and a full-string match finds nothing. Two
  # probes lost their first attempt to that.
  "$HERE/dialog_choice.sh" "$STATE" "Continue" >/dev/null
  wait_idle "$AGENT" "${TURN_TIMEOUT:-240}"
else
  # Not an error worth stopping for: the reviewer can read the screen and see
  # what the tutor did instead — and "it never asked" is itself a finding
  # (the resume brief tells it to ask, in those exact words).
  echo "warning: no continue-or-fresh dialog appeared — read the screen and judge it" >&2
fi

echo "$STATE"
