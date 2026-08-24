#!/usr/bin/env python3
"""Seed a sandbox so a live tutor session starts AT a chosen checkpoint.

    seed_checkpoint.py <module_dir> <checkpoint_id> [seed_dir]

Prints the seed directory. Hand it to e2e_setup.sh as E2E_SEED_DIR and the
sandbox opens with the module already played up to — but not into — that
checkpoint:

    SEED=$(./seed_checkpoint.py ../m01-euler-tour cp5_csr)
    STATE=$(E2E_SEED_DIR=$SEED ./e2e_setup.sh ../m01-euler-tour)
    ./dialog_choice.sh "$STATE" "Continue where we left off"

Why this exists: a checkpoint in chapter 5 is otherwise reachable only by
playing chapters 1-4 first, which is an hour of live model turns per probe and
serialises work that is independent. Every checkpoint can be probed at once
instead, and a fix can be re-tested in three minutes rather than in an hour.

What it writes into the seed dir:

  notebook.py                          the notebook as it stands when that
                                       checkpoint opens
  session_artifacts/session_log.jsonl  one row per checkpoint already played
  session_artifacts/chapter_state.json the chapter the target sits in

Where the material comes from. The notebook is `notebook.golden.py`, cut after
the note cell of the checkpoint before the target — the golden is a FINISHED
session assembled from this module's own templates and skeletons, so its cells
are the same cells a live session grows, in the same order. The preamble and
the appeal box are taken from `notebook.template.py` instead, so the parts a
session starts with are byte-identical to a student's. The log rows are the
`RECORD` table in `notebook.golden.build.py` — the fictional student's answers,
judgments and hint counts — written in the schema the extension's own
appendLog() uses, because the resume brief reads them back.

Two honest limits, so nobody reads more into a green probe than it holds:

  * The kept cells for chapters 4 and 5 are the GOLDEN's variants of those
    cells. They force the "already finished" branch and read the student's
    exercise code from assets/golden/ instead of assets/exercises/. They are
    scenery for the checkpoint under test, never the thing under test.
  * A seeded session's transcript holds no real conversation — the tutor
    resumes on the log alone, exactly as it does for a student who closed the
    lid yesterday. What a probe cannot see is anything that depends on words
    said earlier in the same session.

The full end-to-end run from cp0 is still the gate. This is what makes the
work before that gate finite.
"""
import argparse
import importlib.util
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

CELL_RE = re.compile(r"(?m)^@app\.cell")
DEF_RE = re.compile(r"\ndef ([A-Za-z_][A-Za-z0-9_]*)\(")


def split_notebook(text):
    """(head, [(name, source)], tail) for a marimo file.

    `source` keeps its own "@app.cell" line, so head + cells + tail is the
    original file back again.
    """
    parts = CELL_RE.split(text)
    head, blocks = parts[0], parts[1:]
    if not blocks:
        return head, [], ""
    cells = []
    for b in blocks:
        m = DEF_RE.search(b)
        cells.append([m.group(1) if m else "_", "@app.cell" + b])
    # The last cell carries the file's tail (`if __name__ == "__main__":`).
    last = cells[-1][1]
    cut = last.find('\nif __name__ == "__main__":')
    tail = ""
    if cut != -1:
        cells[-1][1], tail = last[:cut], last[cut:]
    return head, [(n, s) for n, s in cells], tail


def load_build_module(module_dir):
    """notebook.golden.build.py as a module — for ANSWERS and RECORD.

    Its main() is behind an `if __name__` guard, so importing it builds
    nothing; it only defines the fictional session.
    """
    path = module_dir / "notebook.golden.build.py"
    spec = importlib.util.spec_from_file_location("golden_build", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["golden_build"] = mod
    spec.loader.exec_module(mod)
    return mod


def checkpoint_order(module_dir):
    """([checkpoint ids in order], {checkpoint id: chapter id})."""
    index = json.loads((module_dir / "lesson" / "index.json").read_text())
    order, chapter_of = [], {}
    for ch in index["chapters"]:
        for cp in ch["checkpoints"]:
            order.append(cp)
            chapter_of[cp] = ch["id"]
    return order, chapter_of


def log_rows(record, played, start):
    """Session-log rows for the checkpoints already played.

    The schema is appendLog()'s in notebook-tool.ts. `student_response` is the
    student's typed answers joined, `student_said_verbatim` is those answers
    one per message — which is what the extension captures from a transcript
    and what the resume brief quotes back.
    """
    by_id = {r[0]: r for r in record}
    rows, when = [], start
    for cp in played:
        if cp not in by_id:
            continue
        cid, judgment, hints, question, typed, picked, notes = by_id[cp]
        when += timedelta(minutes=4)
        row = {
            "ts": when.isoformat().replace("+00:00", "Z"),
            "type": "checkpoint",
            "id": cid,
            "question": question,
            "student_response": " ".join(typed) if typed else "(no answer — moved on)",
            "judgment": judgment,
            "hints_used": hints,
            "notes": notes,
            "student_said_verbatim": list(typed),
        }
        if picked:
            row["student_picked"] = [picked]
        rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("module_dir")
    ap.add_argument("checkpoint_id")
    ap.add_argument("seed_dir", nargs="?")
    args = ap.parse_args()

    module_dir = Path(args.module_dir).resolve()
    target = args.checkpoint_id
    order, chapter_of = checkpoint_order(module_dir)
    if target not in order:
        sys.exit(f"error: {target} is not a checkpoint of {module_dir.name} — have {', '.join(order)}")

    played = order[: order.index(target)]
    seed = Path(args.seed_dir).resolve() if args.seed_dir else Path(
        f"/tmp/seed-{module_dir.name}-{target}"
    )
    (seed / "session_artifacts").mkdir(parents=True, exist_ok=True)

    # ── the notebook ──────────────────────────────────────────────────────
    tpl_head, tpl_cells, tpl_tail = split_notebook((module_dir / "notebook.template.py").read_text())
    _, gold_cells, _ = split_notebook((module_dir / "notebook.golden.py").read_text())

    # The template's own cells: the unnamed preamble, then the appeal box the
    # extension keeps pinned at the bottom. Everything between them is lesson.
    preamble = [c for c in tpl_cells if c[0] == "_"]
    # The appeal box is the tail of that run of unnamed cells; the imports and
    # helpers are its head. They are told apart by content, not by position, so
    # a template that grows another helper cell does not silently move the line.
    appeal_from = next(
        (i for i, (_, src) in enumerate(preamble) if "tutor_stuck" in src),
        len(preamble),
    )
    top, appeal = preamble[:appeal_from], preamble[appeal_from:]

    # Cut after the note cell of the last checkpoint played. cp0_welcome has no
    # note cell (its script says `note: none`), and a target with nothing played
    # before it keeps no lesson cells at all — which is a fresh start.
    names = [n for n, _ in gold_cells]
    cut = -1
    for cp in reversed(played):
        if f"{cp}_note" in names:
            cut = names.index(f"{cp}_note")
            break
    lesson = []
    if cut >= 0:
        for name, src in gold_cells[: cut + 1]:
            # The golden's own preamble — imports, theme, the netviz helper.
            # Unnamed, and already taken from the template above; kept here
            # too it would define every one of those names twice and marimo
            # refuses the notebook.
            if name == "_":
                continue
            # The banner announcing a fictional reference notebook belongs to
            # the golden, not to a session.
            if name == "reference_banner":
                continue
            # The header of the target's own chapter is the extension's to
            # insert when the chapter loads; leaving it out keeps that path
            # under test. Headers of chapters already finished stay.
            if name == f"{chapter_of[target]}_header":
                continue
            lesson.append(src)

    parts = [c[1] for c in top] + lesson + [c[1] for c in appeal]
    (seed / "notebook.py").write_text(
        tpl_head.rstrip("\n") + "\n\n\n" + "\n\n".join(p.strip("\n") for p in parts) + "\n\n\n" + tpl_tail.lstrip("\n")
    )

    # ── the log ───────────────────────────────────────────────────────────
    build = load_build_module(module_dir)
    start = datetime(2026, 8, 21, 13, 0, tzinfo=timezone.utc)
    rows = log_rows(build.RECORD, played, start)
    (seed / "session_artifacts" / "session_log.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in rows)
    )
    (seed / "session_artifacts" / "chapter_state.json").write_text(
        json.dumps({"current": chapter_of[target]}) + "\n"
    )

    print(seed)
    print(
        f"seeded {module_dir.name} at {target}: {len(rows)} checkpoint(s) logged, "
        f"{len(lesson)} lesson cell(s) in the notebook, chapter {chapter_of[target]}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
