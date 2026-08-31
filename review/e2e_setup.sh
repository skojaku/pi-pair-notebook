#!/usr/bin/env bash
# Start a live tutor E2E session in an isolated sandbox.
#
# Usage: e2e_setup.sh <module_dir> [agent_name]
# Prints the path of a state file to pass to the other harness scripts.
#
# What it does: copies the module to a sandbox (fresh notebook from the
# template), starts the marimo server headless, opens a browser page on it,
# then starts the tutor agent in a herdr pane with global agent extensions
# disabled for fidelity.
#
# The page is opened because a student has one open — it is what they watch,
# and it is where they press the buttons. It is NOT a precondition for the
# tutor's tool calls: those speak HTTP to the kernel, and a gate run
# confirmed nb_add_template succeeding with no client attached at all (lsof
# checked). This comment used to say the kernel stays asleep until a client
# connects, which is why D7 was so hard to reproduce: the way to test a
# notebook that is down is to stop the server, not to withhold the browser.
set -euo pipefail

MODULE_DIR=$(cd "${1:?usage: e2e_setup.sh <module_dir> [agent_name]}" && pwd)
AGENT="${2:-tutor-e2e-$$}"
# Default to what a student actually gets: the course gateway's aliases. A gate
# run on a stronger model passes a tutor no student will ever meet.
TUTOR_MODEL="${TUTOR_MODEL:-netsci/tutor}"

for cmd in herdr uv rsync python3 pi; do
  command -v "$cmd" >/dev/null || { echo "error: $cmd is required" >&2; exit 1; }
done

SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/tutor-e2e-XXXXXX")
rsync -a --exclude session_artifacts --exclude __marimo__ --exclude .skill-cache \
  --exclude notebook.py --exclude '.pi/git' \
  --exclude '.pi/skills' --exclude '.claude/skills' \
  "$MODULE_DIR/" "$SANDBOX/"
cp "$SANDBOX/notebook.template.py" "$SANDBOX/notebook.py"
mkdir -p "$SANDBOX/session_artifacts"

# The nb_* toolkit is the pi-pair-notebook package, not part of the module.
# Fail loudly: with the wrong toolkit (or none) every nb_* call fails and the
# whole run is a silent write-off. The toolkit speaks HTTP to marimo from Node
# now, so there is no bridge script to stage or check for.
#
# WHICH toolkit is the part that used to go wrong quietly. The search was
# `../toolkit` and then the module's installed copy, so in a layout where
# `../toolkit` does not exist — the ops repo keeps its checkout at
# `pair-notebook/.software` — the run silently fell through to the PINNED tag.
# It then looks perfect and says nothing about the fix you made ten minutes
# ago. Worse, `.software` is itself a fetch of the pin (tools/fetch_software.sh
# puts it there on purpose), so "the checkout this script lives in" is not
# automatically the tree you are working in either.
#
# So this does not guess at a label. It resolves a path and PRINTS IT, with
# the git description of whatever repo it came out of. `v0.10.0` on that line
# means you are testing a tag; a branch name and a sha mean you are testing
# work in progress. Read it before you read anything else.
PAIR_NOTEBOOK_EXTENSION="${PAIR_NOTEBOOK_EXTENSION:-}"
if [ -z "$PAIR_NOTEBOOK_EXTENSION" ]; then
  for cand in "$(cd "$(dirname "$0")/../toolkit" 2>/dev/null && pwd)/extensions/notebook-tool.ts" \
              "$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/extensions/notebook-tool.ts" \
              "$MODULE_DIR/.pi/git/github.com/skojaku/pi-pair-notebook/extensions/notebook-tool.ts"; do
    [ -f "$cand" ] && { PAIR_NOTEBOOK_EXTENSION="$cand"; break; }
  done
fi
[ -f "$PAIR_NOTEBOOK_EXTENSION" ] || {
  echo "error: no pi-pair-notebook toolkit found — set PAIR_NOTEBOOK_EXTENSION=/path/to/extensions/notebook-tool.ts" >&2
  exit 1
}
PAIR_NOTEBOOK_ROOT=$(cd "$(dirname "$PAIR_NOTEBOOK_EXTENSION")/.." && pwd)
PAIR_NOTEBOOK_VERSION=$(
  git -C "$PAIR_NOTEBOOK_ROOT" describe --tags --always --dirty 2>/dev/null || echo "not a git checkout"
)
PAIR_NOTEBOOK_BRANCH=$(git -C "$PAIR_NOTEBOOK_ROOT" branch --show-current 2>/dev/null)
echo "note: TOOLKIT UNDER TEST — $PAIR_NOTEBOOK_EXTENSION" >&2
echo "note:   ${PAIR_NOTEBOOK_BRANCH:-(detached)} @ $PAIR_NOTEBOOK_VERSION" >&2
# A previous session's photos would satisfy the photo guard before the student
# has taken one, and the harness exists to test that guard.
rm -rf "$SANDBOX/assets/uploads" "$SANDBOX/assets/exercises"

# Start partway through the module.
#
# E2E_SEED_DIR is a directory laid out like the sandbox — notebook.py, and a
# session_artifacts/ holding session_log.jsonl and chapter_state.json — copied
# over the fresh copy. `seed_checkpoint.py` builds one from the module's golden
# notebook, so a checkpoint in chapter 5 can be probed without playing the four
# chapters in front of it. The extension resumes from the log: it finds the
# furthest checkpoint in it, works out the next one, and opens with the
# continue-or-fresh dialog. Answer that with dialog_choice.sh and the session
# lands on the checkpoint under test.
#
# Applied AFTER the wipe above, so a seed that carries an upload or a saved
# exercise keeps it.
SEEDED=0
if [ -n "${E2E_SEED_DIR:-}" ]; then
  [ -d "$E2E_SEED_DIR" ] || { echo "error: E2E_SEED_DIR=$E2E_SEED_DIR is not a directory" >&2; exit 1; }
  rsync -a "$E2E_SEED_DIR/" "$SANDBOX/"
  [ -f "$SANDBOX/notebook.py" ] && SEEDED=1
  echo "note: seeded from $E2E_SEED_DIR ($(wc -l <"$SANDBOX/session_artifacts/session_log.jsonl" 2>/dev/null || echo 0) checkpoint rows)" >&2
fi

# Who owns the notebook server.
#
# Pre-starting one and handing the extension MARIMO_URL is fast and pins the
# port, but it also switches OFF the half of the toolkit that students actually
# run: setting MARIMO_URL makes externalMarimo() true, so `bootstrapNotebook`,
# the boot timeout, the restart-after-death path, the browser-opening
# fallbacks and the shutdown handler are all unreachable from the gate. Three
# separate lifecycle faults lived in that blind spot at once, every one of them
# in the student's copy and none of them in any review.
#
# So the default is now the student's arrangement: the extension starts marimo,
# opens the page, and takes it down again. E2E_EXTERNAL_MARIMO=1 restores the
# pre-started server for quick reruns where the lesson, not the plumbing, is
# what is under test.
EXTERNAL="${E2E_EXTERNAL_MARIMO:-0}"
# Declared out here because the state file below reads them in BOTH modes, and
# `set -u` turned an unset one into "line 265: BROWSER_CMD: unbound variable"
# on every default-mode run.
BROWSER_CMD="${E2E_BROWSER_CMD:-}"
BROWSER_PID=""
if [ "$EXTERNAL" = 0 ]; then
  echo "note: the extension owns the notebook server (E2E_EXTERNAL_MARIMO=1 to pre-start one)" >&2
fi

# Start marimo fully detached, with PID 1 as its parent.
#
# `marimo edit` runs a parent poller and kills itself the moment its parent
# process goes away — and this script exits seconds after launching it, so a
# plain background job died about ten minutes into a gate run, mid-checkpoint.
# A keepalive subshell was tried and did not help: the poller watches the
# DIRECT parent, and uv's own process chain sits in between.
#
# marimo skips the poller entirely when its parent is already init
# (start_parent_poller returns early for parent_pid == 1), so double-fork and
# wait for the reparenting to land BEFORE exec — no race, no poller, no
# ten-minute death.
if [ "$EXTERNAL" = 1 ]; then
python3 - "$SANDBOX" <<'DETACH'
import os, sys, time

sandbox = sys.argv[1]
log = os.path.join(sandbox, "session_artifacts", "marimo_server.log")

if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        while os.getppid() != 1:
            time.sleep(0.01)
        # Lead our own process group, so teardown's `kill -- -<pid>` reaches
        # the whole uv chain instead of a group that does not exist.
        os.setpgid(0, 0)
        os.chdir(sandbox)
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        os.dup2(fd, 1)
        os.dup2(fd, 2)
        os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
        with open(os.path.join(sandbox, "session_artifacts", "marimo.pid"), "w") as f:
            f.write(str(os.getpid()))
        os.execvp(
            "uvx",
            ["uvx", "marimo", "edit", "--sandbox", "--no-token", "--headless", "notebook.py"],
        )
    os._exit(0)
os.wait()
DETACH

MARIMO_URL=""
for _ in $(seq 1 60); do
  # -a: uv progress bars put control chars in the log; without it grep says
  # "Binary file matches" instead of printing the URL.
  #
  # The LAST url in the log, and only once it answers. `--sandbox` makes
  # marimo re-exec itself inside an isolated uv environment, and the second
  # process binds again — on a different port when the first one is taken.
  # Taking the first line handed the tutor a port nothing was listening on
  # while a good server ran next door, twice in one gate run.
  CAND=$(grep -aoE 'http://[a-zA-Z0-9.]+:[0-9]+' \
    "$SANDBOX/session_artifacts/marimo_server.log" 2>/dev/null | tail -1 || true)
  if [ -n "$CAND" ] && curl -sf -m 2 "$CAND/api/sessions" >/dev/null 2>&1; then
    MARIMO_URL="$CAND"
    break
  fi
  sleep 1
done
[ -n "$MARIMO_URL" ] || {
  echo "error: marimo did not start — see $SANDBOX/session_artifacts/marimo_server.log" >&2
  exit 1
}

# Wake the kernel before the tutor's first nb_* call.
#
# E2E_BROWSER_CMD replaces `open` with any command that takes the URL as its
# last argument. Its reason is running several probes at once: `open` puts a
# tab in the reviewer's own browser, and a dozen of those is a dozen windows
# over whatever they were doing. A headless Chrome connects the same
# websocket and wakes the same kernel:
#
#   E2E_BROWSER_CMD="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --disable-gpu"
if [ -n "$BROWSER_CMD" ]; then
  # Word-split on purpose: the variable carries flags as well as the binary.
  # shellcheck disable=SC2086
  eval $BROWSER_CMD "\"$MARIMO_URL/?view-as=present\"" >/dev/null 2>&1 &
  BROWSER_PID=$!
  sleep 5
elif command -v open >/dev/null; then
  open "$MARIMO_URL/?view-as=present"
  sleep 5
else
  echo "warning: no 'open' — connect a browser to $MARIMO_URL/?view-as=present yourself" >&2
fi
else
  # The extension's own path. It copies notebook.template.py to notebook.py,
  # starts the server, opens the page and stops it at shutdown — so leave all
  # of that alone here, and above all do NOT export MARIMO_URL.
  #
  # A seeded notebook is the one thing that must survive: bootstrapNotebook
  # copies the template only when notebook.py is absent, so removing it here
  # would throw the seed away and open the run at chapter 1 with a log saying
  # chapter 5.
  [ "$SEEDED" = 1 ] || rm -f "$SANDBOX/notebook.py"
  MARIMO_URL=""
fi

# The reviewer's own machine is not a student's. `--no-skills` and
# `--no-prompt-templates` keep the global ones out for the same reason
# `--no-extensions` does: a gate run once started with two dozen of the
# instructor's skills in the tutor's context, on a tutor whose contract says
# it never uses one.
#
# `--exclude-tools bash` is deliberately NOT here any more. The toolkit strips
# bash itself, from session_start — and it did not, for a long time, because
# the strip ran in the extension factory where pi binds that API to a stub
# that throws, and the surrounding catch swallowed it every time. It read as
# working precisely because this line hid it: D8 says "no bash", and the one
# place D8 was ever checked had bash removed on the command line before the
# tutor started. A student's pi has no such flag. If the strip regresses, the
# gate must be the thing that notices.
#
# AND "no bash" was still the wrong question. The strip is only as strong as
# the tools left standing, and nb_run — "run arbitrary Python" — was standing:
# a live run reasoned "I can't run shell" and then ran
# `subprocess.run(['lsof','-nP','-iTCP','-sTCP:LISTEN'])` through it, reading
# every listening service on the machine back into the tutor's context. The
# code is refused in Node now, before the kernel call, at every tool that runs
# model-authored Python (nb_run, nb_read, nb_add_cell, nb_edit_cell,
# nb_add_exercise) — see lib/pysrc.ts scanKernelCode, and `npm test` for the
# cases. D8 has to be read as "no tool reached the operating system", not "the
# bash tool is absent": the second is what the gate could see, and it is why
# this was invisible.
#
# --no-extensions keeps the MACHINE's global extensions out, but it also
# stops pi discovering the packages the module declares in .pi/settings.json
# — and one of those is ask_user_question, the dialog the scripts require for
# their predictions. A student's own `pi` loads them, so a run without
# them tests the wrong tutor: it falls back to plain text and P8 can never be
# assessed. Explicit -e still works under --no-extensions, so load each
# declared package by path.
EXTS=(-e "$PAIR_NOTEBOOK_EXTENSION")
while IFS= read -r pkg; do
  # git: entries are the toolkit itself, loaded above from the working tree.
  case "$pkg" in ""|git:*|https://*|ssh://*|/*|./*) continue ;; esac
  # npm:@scope/name@1.2.3 -> @scope/name (the directory npm installs it into).
  name="${pkg#npm:}"
  [ "${name#@}" = "$(printf '%s' "${name#@}" | sed 's/@.*//')" ] || name="${name%@*}"
  entry="$SANDBOX/.pi/npm/node_modules/$name/index.ts"
  [ -f "$entry" ] || entry="$SANDBOX/.pi/npm/node_modules/$name/index.js"
  if [ -f "$entry" ]; then
    EXTS+=(-e "$entry")
  else
    echo "warning: declared package '$pkg' is not installed in the sandbox — " \
         "run 'pi install $pkg -l --approve' in the module first, or dialogs will be missing" >&2
  fi
done < <(python3 -c "
import json, sys
try:
    print('\n'.join(json.load(open(sys.argv[1])).get('packages', [])))
except Exception:
    pass
" "$SANDBOX/.pi/settings.json" 2>/dev/null)

KICKOFF="Please start the tutoring session. Your CHAPTER SCRIPT message contains the current curriculum — begin at its first checkpoint, unless a RESUME CONTEXT message is present (then greet the student back and follow it). Keep replies short and conversational (1-3 spoken sentences, one question at a time), and use the nb_* notebook tools for all notebook work — the student is watching this terminal."

# MARIMO_URL is passed ONLY in the pre-started mode. An empty one would still
# count as set for some shells, and the extension keys its whole lifecycle off
# whether that variable holds a URL.
ENVS=(--env "TUTOR_VISION_MODEL=${TUTOR_VISION_MODEL:-netsci/vision}"
      --env "TUTOR_REFEREE_MODEL=${TUTOR_REFEREE_MODEL:-netsci/referee}")
[ -n "$MARIMO_URL" ] && ENVS+=(--env "MARIMO_URL=$MARIMO_URL")

# Where the pane lands. Left to herdr it goes wherever herdr's default is,
# which on a reviewer's machine is whatever workspace they were not looking at
# — a live session running unwatched in another window is the one thing a gate
# run must not be. E2E_HERDR_WORKSPACE puts it beside the work it is testing.
PANE_ARGS=(--cwd "$SANDBOX" --no-focus)
[ -n "${E2E_HERDR_WORKSPACE:-}" ] && PANE_ARGS+=(--workspace "$E2E_HERDR_WORKSPACE")

herdr agent start "$AGENT" "${PANE_ARGS[@]}" \
  "${ENVS[@]}" \
  -- pi --model "$TUTOR_MODEL" --thinking low -a \
     --no-skills --no-prompt-templates \
     --no-extensions "${EXTS[@]}" "$KICKOFF" >/dev/null

if [ -z "$MARIMO_URL" ]; then
  # The extension starts it; wait so the other scripts have a URL to talk to,
  # and so a server that never comes up is an error here rather than a puzzle
  # ten turns later.
  for _ in $(seq 1 120); do
    # Last url, and only once it answers — see the note in the branch above.
    CAND=$(grep -aoE 'http://[a-zA-Z0-9.]+:[0-9]+' \
      "$SANDBOX/session_artifacts/marimo_server.log" 2>/dev/null | tail -1 || true)
    if [ -n "$CAND" ] && curl -sf -m 2 "$CAND/api/sessions" >/dev/null 2>&1; then
      MARIMO_URL="$CAND"
      break
    fi
    sleep 1
  done
  [ -n "$MARIMO_URL" ] ||
    echo "warning: the extension has not reported a notebook URL yet — see $SANDBOX/session_artifacts/marimo_server.log" >&2
fi

STATE="$SANDBOX/review-state.env"
{
  echo "SANDBOX=$SANDBOX"
  echo "AGENT=$AGENT"
  echo "MARIMO_URL=$MARIMO_URL"
  echo "EXTERNAL_MARIMO=$EXTERNAL"
  # Only set when E2E_BROWSER_CMD started one: a headless browser has no window
  # to close, so teardown has to know its pid or it outlives the run.
  echo "BROWSER_PID=${BROWSER_PID:-}"
  # And its pid is not enough. A headless Chrome is a tree — renderer, GPU and
  # network children — and killing the launcher leaves them holding a socket to
  # a server that is already gone. Ten probe runs left thirty of them. The
  # profile directory is unique to this run and appears on every child's
  # command line, so it is the safe thing to sweep by: like the port, it can
  # only ever match this run.
  echo "BROWSER_TAG=$(printf '%s' "$BROWSER_CMD" | sed -n 's/.*--user-data-dir=\([^ ]*\).*/\1/p')"
} >"$STATE"
echo "$STATE"
