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
