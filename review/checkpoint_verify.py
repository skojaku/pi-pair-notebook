#!/usr/bin/env python3
"""Report what a checkpoint actually left behind in a sandbox.

    checkpoint_verify.py <state_file> <checkpoint_id>

Reads the sandbox named in the state file and prints, in one screen:

  BUILD    the cells the checkpoint's `build:` line names, and whether each
           one is in the notebook
  NOTE     whether <checkpoint>_note landed, and whether any «slot» in it was
           left unfilled
  LOG      the checkpoint's row, with the flags the extension stamps on a row
           it had to repair or give up on (build_missing, photo_missing,
           verbatim_drift, id_snapped_from, note_skipped_msgs, …)
  EXTRA    named cells the tutor added that the script never asked for — a
           souvenir cell for a detour is the good case, a stray heading is not

It judges nothing. What it removes is the part of a probe where a reviewer
greps a 40-cell notebook by hand and, tired, calls a checkpoint clean because
its note cell is there and its figure is not.
"""
import argparse
import json
import re
import sys
from pathlib import Path

DEF_RE = re.compile(r"\ndef ([A-Za-z_][A-Za-z0-9_]*)\(")
TEMPLATE_RE = re.compile(r"nb_add_(?:template|exercise)\(\s*[\"']([A-Za-z0-9_]+)[\"']")
CELL_MARKER_RE = re.compile(r"(?m)^# --- cell: (\w+) ---$")


def read_state(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def notebook_cells(nb_path):
    text = nb_path.read_text()
    names = []
    for b in re.split(r"(?m)^@app\.cell", text)[1:]:
        m = DEF_RE.search(b)
        names.append(m.group(1) if m else "_")
    return names, text


def checkpoint_block(module_dir, cp):
    """The chunk of chapter YAML belonging to one checkpoint."""
    for f in sorted((module_dir / "lesson").glob("ch*.yaml")):
        text = f.read_text()
        for chunk in re.split(r"(?m)^  - id: ", text)[1:]:
            if chunk.split("\n", 1)[0].strip() == cp:
                return f.name, chunk
    return None, ""


def expected_cells(module_dir, cp):
    """Cell names the checkpoint's build line should put in the notebook."""
    _, chunk = checkpoint_block(module_dir, cp)
    build = re.search(r"(?ms)^    build: \|\n(.*?)(?=\n    [a-z_]+:|\Z)", chunk)
    names = []
    for tpl in TEMPLATE_RE.findall(build.group(1) if build else ""):
        src = module_dir / "cells" / f"{tpl}.py"
        if src.exists():
            names.extend(CELL_MARKER_RE.findall(src.read_text()))
        else:
            # An exercise box is named by the tool call, not by a cells/ file:
            # it becomes <name>_ed / _out / _sent in the notebook.
            names.extend([f"{tpl}_ed", f"{tpl}_out"])
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("state_file")
    ap.add_argument("checkpoint_id")
    ap.add_argument("--module-dir", help="defaults to the sandbox itself")
    args = ap.parse_args()

    state = read_state(args.state_file)
    sandbox = Path(state["SANDBOX"])
    module_dir = Path(args.module_dir) if args.module_dir else sandbox
    cp = args.checkpoint_id

    nb = sandbox / "notebook.py"
    if not nb.exists():
        sys.exit(f"error: no notebook.py in {sandbox}")
    names, text = notebook_cells(nb)

    print(f"SANDBOX  {sandbox}")
    print(f"CHECKPOINT {cp}")

    want = expected_cells(module_dir, cp)
    if want:
        print("\nBUILD")
        for w in want:
            print(f"  {'OK  ' if w in names else 'MISSING'}  {w}")
    else:
        print("\nBUILD  (this checkpoint's script names no template)")

    print("\nNOTE")
    note_name = f"{cp}_note"
    if note_name in names:
        body = re.split(r"(?m)^@app\.cell", text)[names.index(note_name) + 1]
        slots = re.findall(r"«[^»]*»", body)
        print(f"  OK    {note_name} ({len(body)} chars)")
        if slots:
            print(f"  UNFILLED SLOTS: {slots}")
        quoted = re.findall(r"^\s*> .*$", body, re.M)
        print(f"  quoted lines in the fold: {len(quoted)}")
        for q in quoted[:6]:
            print(f"    {q.strip()[:120]}")
    else:
        print(f"  MISSING  {note_name}")

    print("\nLOG")
    log = sandbox / "session_artifacts" / "session_log.jsonl"
    rows = []
    if log.exists():
        for line in log.read_text().splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    print(f"  UNPARSEABLE ROW: {line[:120]}")
    mine = [r for r in rows if str(r.get("id", "")).startswith(cp)]
    if not mine:
        print(f"  no row for {cp} (the checkpoint was never closed)")
    for r in mine:
        print(f"  id={r.get('id')} judgment={r.get('judgment')} hints_used={r.get('hints_used')}")
        print(f"    question: {str(r.get('question',''))[:150]}")
        print(f"    student_response: {str(r.get('student_response',''))[:200]}")
        print(f"    student_said_verbatim: {r.get('student_said_verbatim')}")
        if "student_picked" in r:
            print(f"    student_picked: {r['student_picked']}")
        print(f"    notes: {str(r.get('notes',''))[:200]}")
        flags = {
            k: v
            for k, v in r.items()
            if k
            in (
                "build_missing",
                "photo_missing",
                "verbatim_drift",
                "id_snapped_from",
                "response_retyped_as",
                "slot_quotes_repaired",
                "note_skipped_msgs",
                "note_window_from_msg",
                "turns_in_checkpoint",
                "closed_without_speaking",
                "figures_not_quoted",
                "closed_by_referee",
            )
        }
        if flags:
            print(f"    FLAGS: {json.dumps(flags)}")

    print("\nDETOURS")
    detours = [r for r in rows if r.get("type") == "detour"]
    for d in detours:
        print(f"  {json.dumps(d)[:300]}")
    if not detours:
        print("  (none logged)")

    print("\nEXTRA CELLS (named, added beyond this checkpoint's build and note)")
    known = set(want) | {note_name}
    extra = [
        n
        for n in names
        if n != "_"
        and n not in known
        and (n.startswith(cp) or n.startswith("detour_") or n.endswith("_header"))
    ]
    print("  " + (", ".join(extra) if extra else "(none)"))


if __name__ == "__main__":
    main()
