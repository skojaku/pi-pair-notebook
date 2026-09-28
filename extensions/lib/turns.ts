/**
 * Reading a finished tutor turn, as pure functions.
 *
 * Same rule as lib/verbatim.ts: arguments in, answer out, nothing else.
 * Tests: `npm test`.
 */

/**
 * Did this turn TELL the student the checkpoint is closed?
 *
 * A live m03 run ended cp1 on "You had it. The checkpoint closes now." — and
 * no checkpoint_done. The tutor had said the close instead of doing it, so
 * nothing moved: no note, no next exercise, and the student sat there until
 * they typed "next". The words are the toolkit's own vocabulary (AGENTS.md
 * and the scripts say "close"/"closes" throughout), which is why the tutor
 * reaches for them, and why a match on them is a match on the tutor saying
 * it rather than on a student-facing phrase that happens to look similar.
 *
 * Narrow on purpose: "checkpoint" (or "this one") within a few words of
 * close/closed/closes/done/complete, in a turn that asks nothing. A sentence
 * that merely contains "close" — "close, but not quite" — never matches, and
 * neither does a promise ("…and the checkpoint closes").
 */
export function announcesClose(text: string): boolean {
  // A turn that still asks something is waiting on the student, whatever
  // else it says.
  if (text.includes("?")) return false;
  const re =
    /(\b(and|then|once|when|before|until)\s+)?\b(the\s+)?(checkpoint|this one)\b[^.!?\n]{0,24}\b(closes|closed|is done|is complete|complete[ds]?)\b/gi;
  for (const m of text.matchAll(re)) {
    // "Say it back, and the checkpoint closes" is a promise about the NEXT
    // turn, not a close.
    if (!m[1]) return true;
  }
  return false;
}

/**
 * Is the student asking for the referee? The word is "judge" — the one the
 * course tells them — or "referee", or the /judge command. Whole words only:
 * "judgement" in a sentence about their code is not a request.
 */
export function callsReferee(text: string): boolean {
  return /(^|\s)\/judge\b|\bjudge\b|\breferee\b|ジャッジ/i.test(text);
}

/**
 * Was a checkpoint's scripted reveal SAID, in any of these tutor texts?
 *
 * `closed_without_speaking` asked only "has the tutor said anything since the
 * student last typed?". That is the right question for m02's shape, where
 * the reveal is owed after the student's answer. m03's is different: the
 * reveal comes with the pass, then "Do you have any questions about this
 * exercise before we move on?", and a "no" is followed by a silent close — as
 * the script asks. A fully correct m03 run was stamped
 * `closed_without_speaking` on every one of its six rows.
 *
 * So the flag also looks for the reveal itself, anywhere in the checkpoint.
 * The reveal's ➤ lines are its words (the rest is for the note cell); a
 * reveal with no ➤ is taken whole. Each counts as said when its first six
 * words appear in order in what the tutor said, compared on letters and
 * digits only — the scripts ask for the lines as written, and a marker, a
 * backtick or a line break the tutor dropped is not a different sentence.
 */
export function revealSaid(reveal: string, spoken: string[]): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const heard = ` ${norm(spoken.join("\n"))} `;
  const lines = reveal.includes("➤")
    ? reveal.split("➤").slice(1)
    : [reveal];
  for (const line of lines) {
    const words = norm(line).split(" ").filter(Boolean).slice(0, 6);
    if (words.length < 3) continue;
    if (heard.includes(` ${words.join(" ")} `)) return true;
  }
  return false;
}
