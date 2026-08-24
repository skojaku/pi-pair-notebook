#!/usr/bin/env python3
"""Read a tutor pane's on-screen option list and say where the cursor is.

Two different pickers appear in a session and they do not look alike:

  the toolkit's own picker              the ask_user_question widget
  ─────────────────────────             ────────────────────────────
   Where to next?                        How do you feel about Python?

     Ready for the next question        ❯ 1. I don't code
   → I have a question first                 I don't code — I'll keep …
     Give me another one like that        2. tried a little
                                              tried a little — I'll offer …
   ↑↓ navigate  enter select              3. comfortable with Python
                                          4. Type something.

The numbered one interleaves a description under every row, so "the lines
around the cursor" is not a list of options there. Hence two parsers, chosen
by whether numbered rows exist.

Usage:  dialog_probe.py < screen.txt
Prints one JSON object: {"kind", "focus", "options": [...]} — focus is the
0-based index of the row the cursor is on, or null if no picker is on screen.
"""

import json
import re
import sys

# The cursor, in every renderer either of them uses.
MARKERS = "❯→›»▶"
NUMBERED = re.compile(r"^(?P<mark>[" + MARKERS + r" ]*)\s*(?P<n>\d+)\.\s+(?P<label>\S.*?)\s*$")
# Hint/footer lines are not options, however much they look like one.
FOOTER = re.compile(r"(↑↓|↑/↓|enter select|Enter to select|navigate|escape/ctrl\+c|Esc to)")


def parse(screen: str) -> dict:
    lines = screen.split("\n")

    # --- the numbered widget -------------------------------------------------
    rows = []
    for i, line in enumerate(lines):
        if FOOTER.search(line):
            continue
        m = NUMBERED.match(line)
        if m:
            rows.append((i, int(m.group("n")), m.group("label"), any(c in m.group("mark") for c in MARKERS)))
    # Only trust it when the numbers actually run 1..N — a description line that
    # happens to start "2. " would otherwise invent a row.
    if rows and [r[1] for r in rows] == list(range(1, len(rows) + 1)):
        focus = next((k for k, r in enumerate(rows) if r[3]), None)
        return {"kind": "numbered", "focus": focus, "options": [r[2] for r in rows]}

    # --- the plain picker ----------------------------------------------------
    # Anchor on the cursor line, then walk out in both directions over lines
    # that carry text at the same indentation.
    focus_line = None
    for i, line in enumerate(lines):
        if FOOTER.search(line):
            continue
        stripped = line.lstrip()
        if stripped and stripped[0] in MARKERS:
            focus_line = i
            break
    if focus_line is None:
        return {"kind": "none", "focus": None, "options": []}

    def text_of(line: str) -> str | None:
        stripped = line.lstrip()
        if not stripped or FOOTER.search(line):
            return None
        if stripped[0] in MARKERS:
            stripped = stripped[1:].lstrip()
        return stripped or None

    indent_of = len(lines[focus_line]) - len(lines[focus_line].lstrip())
    block = [focus_line]
    for step in (-1, 1):
        i = focus_line + step
        while 0 <= i < len(lines):
            t = text_of(lines[i])
            if t is None:
                break
            # Siblings sit at the cursor's indent or one marker-width right of it.
            ind = len(lines[i]) - len(lines[i].lstrip())
            if abs(ind - indent_of) > 2:
                break
            block.append(i)
            i += step
    block.sort()
    return {
        "kind": "plain",
        "focus": block.index(focus_line),
        "options": [text_of(lines[i]) for i in block],
    }


if __name__ == "__main__":
    print(json.dumps(parse(sys.stdin.read()), ensure_ascii=False))
