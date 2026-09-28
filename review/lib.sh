# Shared helpers for the tutor E2E harness. Source, don't execute.
# Requires: herdr, python3.

pane_id() { # pane_id <agent>
  herdr agent get "$1" | python3 -c \
    'import json,sys; print(json.load(sys.stdin)["result"]["agent"]["pane_id"])'
}

agent_status() { # agent_status <agent>
  herdr agent get "$1" 2>/dev/null | python3 -c \
    'import json,sys; print(json.load(sys.stdin)["result"]["agent"]["agent_status"])' \
    2>/dev/null || echo unknown
}

wait_idle() { # wait_idle <agent> [timeout_seconds]
  local agent="$1" timeout="${2:-240}" waited=0
  # Give the agent a moment to leave idle (it may still be ingesting input).
  sleep 5
  while [ "$waited" -lt "$timeout" ]; do
    [ "$(agent_status "$agent")" = idle ] && return 0
    sleep 3; waited=$((waited + 8))
  done
  echo "warning: agent '$agent' not idle after ${timeout}s — reading anyway" >&2
}

read_screen() { # read_screen <agent> [lines]
  # herdr 0.9 prints the pane text directly; it used to wrap it in a JSON
  # envelope. Accept either, so this harness works against both -- a stale
  # parse here fails as a Python traceback in the middle of a gate run, which
  # reads like the tutor died.
  herdr agent read "$1" --source recent --lines "${2:-50}" | python3 -c \
    'import json, sys
raw = sys.stdin.read()
try:
    print(json.loads(raw)["result"]["read"]["text"])
except Exception:
    print(raw, end="")'
}

split_pane() { # split_pane <base_pane> <cwd> [--env K=V ...]  -> prints the new pane id
  local base="$1" cwd="$2"; shift 2
  herdr pane split --pane "$base" --direction down --ratio 0.5 \
    --cwd "$cwd" "$@" --no-focus |
    python3 -c "import json,sys; print(json.load(sys.stdin)['result']['pane']['pane_id'])"
}

start_tutor() { # start_tutor <agent> <pane> -- <pi args...>
  # A freshly split pane can still be starting its shell when `agent start`
  # looks at it, and herdr 0.9 refuses with agent_pane_busy. Nothing was typed
  # into the pane then, so trying again is safe; any other failure is not
  # retried, because it may have launched pi already.
  local agent="$1" pane="$2" out try
  shift 2; [ "${1:-}" = "--" ] && shift
  for try in 1 2 3 4 5; do
    if out=$(herdr agent start "$agent" --kind pi --pane "$pane" --timeout 120000 -- "$@" 2>&1); then
      return 0
    fi
    case "$out" in
      *agent_pane_busy*) echo "note: pane $pane not at its prompt yet, retrying ($try/5)" >&2; sleep 3 ;;
      *) echo "$out" >&2; return 1 ;;
    esac
  done
  echo "$out" >&2
  return 1
}
