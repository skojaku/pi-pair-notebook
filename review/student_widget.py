#!/usr/bin/env python3
"""Act on a notebook widget the way the student's own hands would.

    student_widget.py <state_file> list
    student_widget.py <state_file> set   <element> <value>      # --from-file for long text
    student_widget.py <state_file> press <element>
    student_widget.py <state_file> upload <element> <image path>

Two checkpoints in this course are finished with the mouse, not the keyboard:
the drawing goes into a file-drop box and the exercise code into a code editor
with a ▶ Run and a 📨 Send button. A terminal-driven review cannot reach either,
so those two were the only checkpoints the harness could not exercise — and
they are the two carrying the most machinery.

This reaches them at the same layer marimo's own frontend uses: the kernel's
`set_ui_value`, over the HTTP API the toolkit already speaks (`GET
/api/sessions`, `POST /api/kernel/execute`). Setting the value runs the cells
that depend on it, exactly as a click does, so the send button really does
append to student_signal.txt and the tutor really is woken by it.

What this is NOT: a test of the page itself. A button that renders in the wrong
place, or a drop area that rejects a real .jpg, is invisible from here. That is
what the browser is for, and one human pass over the finished notebook.
"""
import argparse
import base64
import json
import re
import sys
import urllib.request
from pathlib import Path


def read_state(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def session_id(url, notebook_path):
    with urllib.request.urlopen(f"{url}/api/sessions", timeout=15) as r:
        sessions = json.load(r)
    want = str(Path(notebook_path).resolve())
    for sid, meta in sessions.items():
        if str(Path(meta.get("path", "")).resolve()) == want:
            return sid
    # One notebook per sandbox in practice; if the path did not match (macOS
    # /private symlinks have bitten this before) take the only session there is.
    if len(sessions) == 1:
        return next(iter(sessions))
    sys.exit(f"error: no marimo session for {notebook_path} (have {list(sessions)})")


def run_kernel(url, sid, code):
    req = urllib.request.Request(
        f"{url}/api/kernel/execute",
        data=json.dumps({"code": code}).encode(),
        headers={"Content-Type": "application/json", "Marimo-Session-Id": sid},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read().decode()
    out, failed = [], False
    for chunk in body.split("\n\n"):
        m = re.search(r"^data: (.*)$", chunk, re.M)
        if not m:
            continue
        try:
            payload = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        if "data" in payload and isinstance(payload["data"], str):
            out.append(payload["data"])
        if payload.get("success") is False:
            failed = True
        if payload.get("error"):
            failed = True
            out.append(str(payload["error"]))
    return "".join(out), failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("state_file")
    ap.add_argument("action", choices=["list", "set", "press", "upload"])
    ap.add_argument("element", nargs="?")
    ap.add_argument("value", nargs="?")
    ap.add_argument("--from-file", help="read the value from this file instead")
    args = ap.parse_args()

    state = read_state(args.state_file)
    url = state.get("MARIMO_URL", "").rstrip("/")
    if not url:
        sys.exit("error: the state file has no MARIMO_URL")
    nb = Path(state["SANDBOX"]) / "notebook.py"
    sid = session_id(url, nb)

    if args.action == "list":
        # The options come out too: a dropdown takes the option's full LABEL,
        # and guessing "C" for "C — north bank" is one round-trip wasted every
        # time. A slider prints the numbers on its scale for the same reason.
        code = (
            "import marimo._code_mode as cm\n"
            "async with cm.get_context() as ctx:\n"
            "    for _k, _v in sorted(ctx.globals.items()):\n"
            "        if _v.__class__.__module__.startswith('marimo') and hasattr(_v, 'value'):\n"
            "            _opts = getattr(_v, 'options', None)\n"
            "            if _opts is None:\n"
            "                _m = getattr(_v, '_mapping', None)\n"
            "                _opts = list(_m.values()) if isinstance(_m, dict) else None\n"
            "            print(_k, '=', type(_v).__name__, '->', repr(_v.value)[:80],\n"
            "                  ('| accepts: ' + repr(list(_opts))[:160]) if _opts else '')\n"
        )
    elif args.action == "press":
        # A run_button's value is what the click sets; the cells that read it
        # re-run on the change, which is the whole point of pressing it.
        code = (
            "import marimo._code_mode as cm\n"
            "async with cm.get_context() as ctx:\n"
            f"    ctx.set_ui_value(ctx.globals[{args.element!r}], True)\n"
            f"    print('pressed', {args.element!r})\n"
        )
    elif args.action == "set":
        if args.from_file:
            value = Path(args.from_file).read_text()
        else:
            raw = args.value or ""
            # "5" is the number five and "true" is a boolean, because that is
            # what a dropdown and a checkbox hold; anything that is not JSON
            # stays the string it was typed as.
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                value = raw
        # A slider is addressed by STEP INDEX, not by the number on its scale:
        # that is what the frontend posts, and set_ui_value takes the frontend's
        # side. Passing 5 to a 1-6 slider raises KeyError(5) — which reads like
        # a broken widget and is nothing of the kind. Translate through the
        # element's own mapping when it has one, so callers can say what the
        # student would say ("set the slider to 5").
        code = (
            "import marimo._code_mode as cm\n"
            "async with cm.get_context() as ctx:\n"
            f"    _el = ctx.globals[{args.element!r}]\n"
            f"    _val = {value!r}\n"
            "    _map = getattr(_el, '_mapping', None)\n"
            "    if isinstance(_map, dict):\n"
            "        _inv = {v: k for k, v in _map.items()}\n"
            "        if _val in _inv:\n"
            "            _val = _inv[_val]\n"
            # A dropdown posts a LIST of selected labels, even when it takes
            # one — a bare string reaches it as a list of characters and it
            # raises "Dropdowns only support a single value". Wrap it here
            # rather than making every caller know that.
            "    if type(_el).__name__.lower() in ('dropdown', 'multiselect') and not isinstance(_val, list):\n"
            "        _val = [_val]\n"
            "    ctx.set_ui_value(_el, _val)\n"
            f"    print('set', {args.element!r}, '->', repr(_el.value)[:80])\n"
        )
    else:  # upload
        raw = Path(args.value).read_bytes()
        b64 = base64.b64encode(raw).decode()
        name = Path(args.value).name
        # mo.ui.file takes what the browser posts: (filename, base64 contents).
        code = (
            "import marimo._code_mode as cm\n"
            "async with cm.get_context() as ctx:\n"
            f"    ctx.set_ui_value(ctx.globals[{args.element!r}], [({name!r}, {b64!r})])\n"
            f"    print('uploaded', {name!r})\n"
        )

    out, failed = run_kernel(url, sid, code)
    print(out.rstrip())
    if failed:
        sys.exit("error: the kernel refused that — see the output above")


if __name__ == "__main__":
    main()
