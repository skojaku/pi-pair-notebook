#!/usr/bin/env python3
"""Can the tutor actually do what each note «slot» asks of it?

    note_slots_check.py <module_dir>     # lists what to fix, exit 1 if any

A note skeleton's «slots» are the graded artifact's centerpiece, and the
extension fills them two different ways. A slot whose text says "verbatim" is
filled by the machine, copied out of the transcript; every other slot is
written by the model, because its answer — what a drawing shows, which option
they picked, the numbers a widget displayed — never reaches the transcript at
all.

A slot that asks for BOTH is not followable. m02's cp4_shortcut_drawing asked
one slot for "which dots I connected, and why — written as mine … quote my
reasoning word for word", and offered "I ran it from 0 to 4 because…" as the
example. The tutor did the only thing that produces a single fluent sentence:
it rewrote the student's opening clause into the description and kept the
rest. What landed in the notebook, inside a fold labelled as the student's own
words, was:

    I ran it from 0 to 4 because that was the longest trip before …

The student had typed "i put it there because that was the longest trip
before". Half the slot could not be quoted, so the half that could was
rewritten to match it. No guard caught it and none reasonably could: nothing
was added that the transcript did not hold, because the numbers came from the
photo description. The fix is the script, and this is the check that keeps it
fixed.

The shape that works, and that has never failed, is two markers:

    /// details | My work
        type: lh-answer
    > «their answers, verbatim»
    >
    > **On paper:** «what my photo of the derivation shows, written as mine»
    ///
"""
import re
import sys
from pathlib import Path

# The machine fills it from the transcript.
QUOTES = re.compile(r"verbatim|word for word|\bquote\b|\bquoting\b", re.I)
# Only the model can know it: it is a picture, a widget or a picker.
DESCRIBES = re.compile(
    r"\bphoto\b|\bdrawing\b|\bpicture\b|\bshows\b|\bdescribe\b|\bpick\b|\bpicked\b|\bwidget\b",
    re.I,
)


def checkpoints(module: Path):
    for path in sorted((module / "lesson").glob("ch*.yaml")):
        text = path.read_text()
        for m in re.finditer(r"^  - id: (\S+)$(.*?)(?=^  - id: |\Z)", text, re.S | re.M):
            note = re.search(r"^    note: \|\n(.*?)(?=\n    \w+:|\Z)", m.group(2), re.S | re.M)
            yield path.name, m.group(1), note.group(1) if note else ""


def main() -> int:
    module = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    if not (module / "lesson").is_dir():
        sys.exit(f"error: no lesson/ under {module}")

    bad, seen = [], 0
    for fname, cp, note in checkpoints(module):
        for marker in re.findall(r"«[^»]*»", note):
            seen += 1
            flat = re.sub(r"\s+", " ", marker)
            if QUOTES.search(flat) and DESCRIBES.search(flat):
                bad.append((fname, cp, flat))

    for fname, cp, marker in bad:
        print(f"COMPOUND {fname} {cp}")
        print(f"  {marker[:150]}")
        print("  asks the tutor to describe a picture AND quote the student in one")
        print("  slot. Split it: a «… verbatim» marker the extension fills from the")
        print("  transcript, and a described marker that says only what the picture")
        print("  shows.")
    if bad:
        print(f"\n{seen} slots checked; {len(bad)} cannot be followed as written.")
        return 1
    print(f"note slots OK — {seen} checked, none asks for a description and a quote at once.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
