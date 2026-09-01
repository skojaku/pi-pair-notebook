/**
 * The quoting half of the toolkit, as pure functions.
 *
 * Everything exported here is a function of its arguments alone: no pi API,
 * no kernel, no filesystem, no clock, no closure it mutates. That is the
 * whole point of the file existing.
 *
 * `checkpoint_done` and `log_detour` are on no boot path — `pi -p "hi"`
 * enters the factory and `session_start` and stops — so for a long time
 * nothing below could be run at all without playing a whole lesson at a real
 * model. Three bugs shipped through that gap in one afternoon: a span index
 * taken against the wrong array, a counter read one line after its reset, and
 * a truncation check with no exact-match guard. Every one was a slip that
 * fits in a test, and every one loaded cleanly and wrote both health markers.
 *
 * The rule for this file: if a function needs `pi`, the kernel, the disk or
 * the transcript, it does not belong here — hand it what it needs instead.
 *
 * Tests: `npm test` (node --test, no dependencies to install).
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The note cell's «slots» are the graded artifact's centerpiece: they must be
 * the STUDENT's words, not the tutor's prose. A live session produced
 * "A–D = 2, and the average over all 6 pairs = 7/6 ≈ 1.17" from a student who
 * had typed only "yes", "2", "7/6" — a fabricated number presented as their
 * work. So the extension checks the fills against what the student actually
 * said (transcript capture + the tutor's own verbatim field).
 *
 * Tolerant by design: word order, joining and connective words are free; what
 * it catches is invented content — any number they never gave, or several
 * added content words.
 */
export const SLOT_GLUE = new Set([
  "a", "an", "and", "the", "of", "to", "in", "on", "at", "is", "are", "was", "were",
  "it", "its", "i", "my", "me", "we", "our", "you", "your", "that", "this", "these",
  "those", "so", "then", "for", "with", "as", "but", "or", "if", "not", "be", "been",
  "there", "here", "each", "every", "both", "than", "when", "because", "about",
  // Structural labels a tutor puts around a multi-part answer — the note
  // skeletons say «their answers, verbatim» (plural) for the 3-6 part
  // checkpoints, so "Idea: … Count: … Fraction: …" is the natural shape and
  // must not read as invented content.
  "idea", "answer", "answers", "count", "counts", "fraction", "result", "work",
  "note", "first", "second", "third", "final", "total", "corrected", "then",
]);

export function slotTokens(s: string): string[] {
  const norm = s
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[*_`>#]/g, " ");
  return norm.match(/[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?/g) ?? [];
}

/**
 * A "figure": 7/6, 1.17, 4.74, 0.61 — a compound or multi-digit
 * number. Bare single digits are NOT figures: they are how a subscript
 * ($L_0$ → "l", "0") and an ordinary label ("dot 1 to dot 5") tokenize, and
 * flagging those refused faithful records.
 */
export function isFigure(token: string): boolean {
  return /^\d+([./:,-]\d+)+$|^\d{2,}$/.test(token);
}

export const normMsg = (m: string): string =>
  m
    .toLowerCase()
    .replace(/['‘’ʼ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const ACK_WORDS = new Set(
  ("ok okay k kk yep yup yeah ya sure right true ready im i m ive got it gotcha see ah oh ohh " +
    "hm hmm mm uh huh thanks thanku thank you cool nice great awesome perfect makes sense " +
    "understood understand lets go going next continue done finished fine alright allright " +
    "sounds good please well so and then ill let s " +
    // normMsg strips the apostrophe, so "let's" arrives as "lets" and never
    // matched the "let" + "s" pair above. With the words that travel with it:
    // "yeah lets keep going" answered the tutor's "ready to move on?" after a
    // detour and was filed in the next checkpoint's note as the student's
    // worked answer, between two real ones. Every word must be an ack word
    // for a message to be dropped, so these cannot swallow an answer alone.
    "lets keep carry on move moving ahead forward " +
    // A whole turn answering the tutor's own offer — "yeah, a quick note would
    // be nice" — is not the student's work, and a live run left it sitting in
    // the note between two real answers. `yes` and `no` stay OUT: they can be
    // the answer to a lesson question.
    // `this` and `one` are NOT here: "this one", answering "which of the two
    // worlds do you live in?", is half an answer, and adding them deleted it
    // from the keepsake while the student's reason survived.
    //
    // `that` IS here, and the pair above is why it is safe. Every word must be
    // an acknowledgement for a message to be dropped, so "this one", "that
    // one" and "thats the one" all survive on the strength of the word beside
    // it. What "that" buys is the shape a gate run produced on 2026-08-27:
    // "yep that makes sense, lets keep going", the student closing a detour,
    // quoted in the NEXT checkpoint's note under "I worked out". detourSpans
    // cannot reach that one — the span is closed when log_detour runs and this
    // came after it — and every other word in it was already an ack.
    "would could should will do does did a an the be is are quick note maybe bit little that")
    .split(" "),
);

/** True for a message that is acknowledgement and nothing else. */
export function isFillerMessage(m: string): boolean {
  const t = normMsg(m);
  if (!t || /\d/.test(t)) return false;
  const words = t.split(" ");
  // Eight, not five: the live example ran seven. Still short enough that a
  // real answer is safe — and one that is not is rescued by matching
  // student_response.
  if (words.length > 8) return false;
  return words.every((w) => ACK_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Similarity and repair
// ---------------------------------------------------------------------------

/**
 * Character-bigram overlap (Dice), 0–1. Used to spot a RETYPED answer: a
 * live session logged "becuase tirangles are ipormtat" for a student who
 * typed "becuase tirangles are ipmortat" — the model copied their sentence
 * out by hand and re-scrambled their own typo along the way. Word-level
 * drift cannot see that (one odd token), and it is exactly the kind of
 * silent edit the graded record must not carry.
 */
export function bigramDice(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g, " ").trim();
    const out = new Set<string>();
    for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const g of A) if (B.has(g)) hits += 1;
  return (2 * hits) / (A.size + B.size);
}

/**
 * If `response` is a near-copy of one of the student's own messages, return
 * that message instead — their words, character for character.
 *
 * Similarity alone is not enough to act on. Joining several short answers
 * into one ("A–D is 2, and the average is 7/6 over all six pairs") is the
 * sanctioned shape — the skeletons say «their answers, verbatim», plural —
 * and it scores nearly as high against its longest fragment as a retype
 * does against the whole message. Snapping there would delete half the
 * student's answer from the graded record, so a candidate must also be
 * about the same LENGTH: a retype is, a swallowed fragment is not.
 */
export function snapToTranscript(response: string, said: string[]): string | null {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (said.some((s) => flat(s) === flat(response) || flat(s).includes(flat(response)))) return null;
  let best: { score: number; text: string } | null = null;
  for (const s of said) {
    const score = bigramDice(s, response);
    if (!best || score > best.score) best = { score, text: s };
  }
  if (!best || best.score < 0.8) return null;
  const longest = Math.max(best.text.length, response.length);
  return Math.abs(best.text.length - response.length) <= 0.15 * longest ? best.text : null;
}

/** Content tokens in `fill` that the student never produced. */
export function slotDrift(
  fill: string,
  studentPool: string[],
): { numbers: string[]; words: string[] } {
  const pool = new Set(studentPool.flatMap(slotTokens));
  const numbers: string[] = [];
  const words: string[] = [];
  for (const t of new Set(slotTokens(fill))) {
    if (pool.has(t) || SLOT_GLUE.has(t)) continue;
    if (isFigure(t)) numbers.push(t);
    else words.push(t);
  }
  return { numbers, words };
}

/** Drift worth reporting: any invented figure, or three added content words. */
export const driftIsReportable = (d: { numbers: string[]; words: string[] }): boolean =>
  d.numbers.length > 0 || d.words.length >= 3;




/**
 * How many of this checkpoint's messages are ANSWERS to it — the number the
 * late-close gate and the ⚖️ nudge compare against.
 *
 * It used to be `said.length`, the raw window, and a student who asked one
 * question mid-checkpoint tripped a refusal whose prescribed remedy was to
 * write down hints that never happened: measured in a live run, on a
 * checkpoint answered correctly first try on turns 1 and 3 with a logged
 * detour in between. A curious student is the one this module wants, and the
 * gate degraded their record for it.
 *
 * Three things are not answers, and all three are marked from FACTS rather
 * than from any reading of the student's words:
 *   · a detour's turns — the span runs from their question to log_detour;
 *   · a message already recorded as a detour question;
 *   · the "where is my notebook?" exchange (see mechanicsAsked);
 * plus pure acknowledgement, which is the one word-list left and the one with
 * a scar record — see ACK_WORDS.
 *
 * This used to run through `chooseQuoted`, because the note cell needed the
 * same narrowing and the two must not disagree. The note cell no longer quotes
 * the student at all, so this is the only caller left and it says what it does
 * directly. `isResponse` is gone with it: the rescue existed so a curated quote
 * could not lose a real answer, and there is no curated quote any more.
 *
 * Subtracting can only ever turn a refusal OFF, never on, which is the one
 * direction this file's history of withdrawn guards allows a count to move.
 */
export function answerCountForGate(w: {
  said: string[];
  detourSpans: [number, number][];
  detourAsked: Set<string>;
  mechanicsAsked?: Set<string>;
}): number {
  return w.said.filter((m, i) => {
    if (w.detourSpans.some(([a, b]) => i >= a && i <= b)) return false;
    const n = normMsg(m);
    if (w.detourAsked.has(n) || w.mechanicsAsked?.has(n)) return false;
    return !isFillerMessage(m);
  }).length;
}

/**
 * A note skeleton with its «slots» taken out, ready to render as it stands.
 *
 * The note cell used to quote the student: the instructor's skeleton carried
 * «their answers, verbatim» and the extension filled it from the transcript.
 * That one feature is where nearly every fault in this file's history lived —
 * four withdrawn guards, two occasions on which a word list deleted a real
 * answer from a graded artifact, and the whole apparatus of window edges,
 * detour spans, filler words and rescue clauses that existed to decide WHICH
 * of the student's messages to copy.
 *
 * It was also the fourth copy. A finished notebook already carries their words
 * uncurated in the `session_record` cell, `session_summary.md` carries them
 * again, and `session_log.jsonl` holds the raw window in
 * `student_said_verbatim` — which is trustworthy precisely because nothing
 * chooses. The note cell was the only copy that had to choose, and choosing
 * was the bug.
 *
 * So the note cell is the instructor's prose now, and nothing else.
 *
 * THIS FUNCTION IS THE COMPATIBILITY LAYER, and it is why it is not simply
 * `skeleton`. A module whose lesson YAML still carries the slots must not
 * render `«their answers, verbatim»` into a student's notebook — the toolkit
 * ships before the modules are edited, and a student on the new toolkit and an
 * old module is the normal state for a while. A `details` block that holds
 * nothing but slots goes with them: an empty fold titled "My guess, and how
 * far I got" is worse than no fold.
 */
const SLOT_MARKER = /«[^»]*»/g;

export function renderNoteSkeleton(skeleton: string): string {
  const lines = skeleton.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\/\/\/\s*details\b/.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // Collect the block: `/// details | title` … `///`
    let end = i + 1;
    while (end < lines.length && !/^\s*\/\/\/\s*$/.test(lines[end])) end += 1;
    const body = lines.slice(i + 1, end);
    // JOINED before the slots are stripped, never line by line. A slot's
    // instruction to the model runs to several lines —
    //     > «what my photo of the table shows, written as mine —
    //       "I listed all ten pairs and got…". A photographed answer never
    //       reaches the transcript, so this slot is yours to describe»
    // — and `«[^»]*»` matches that only across the whole block. Tested per
    // line it matches nothing, the fold reads as prose, and three of this
    // course's own skeletons kept an empty "My work" fold in the student's
    // notebook.
    const joined = body.join("\n");
    const stripped = joined.replace(SLOT_MARKER, "");
    // `type: lh-answer` and friends are the fold's own attributes, not content.
    const content = stripped.split("\n").filter((l) => l.trim() && !/^\s*\w[\w-]*:\s/.test(l));
    // What is left once the slots go has to be WORDS to count as content, and
    // three things do not count:
    //   · punctuation the instructor put BETWEEN two slots — the real skeleton
    //     is `> «their pick» — «their report, verbatim»`, whose residue is a
    //     blockquote arrow and a dash;
    //   · a bare label like `**On paper:**`, which titles an answer that is no
    //     longer there (cp2_paperwork and cp4_shortcut_drawing both do this);
    //   · nothing at all — cp4_disconnected's fold is one slot and no prose.
    // All three leave a fold with a heading and an empty inside, which is
    // worse for the student than no fold.
    const hadSlot = stripped !== joined;
    const survives = content.filter((l) =>
      /[\p{L}\p{N}]/u.test(l.replace(/\*\*[^*]*:\*\*/g, "")),
    );
    const onlySlots = hadSlot && survives.length === 0;
    if (!onlySlots) out.push(...lines.slice(i, Math.min(end + 1, lines.length)));
    i = end;
  }
  return out
    .join("\n")
    .replace(SLOT_MARKER, "")
    // A slot on its own line leaves a blank; two blanks in a row read as a
    // paragraph break the instructor did not write.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * How many answers make "these two are going round".
 *
 * It used to be twelve TURNS, and a turn is not an exchange. Measured on a live
 * m01 session: 13 assistant turns to 5 student messages, four of those turns
 * with no words in them at all — a tool call is a turn, a refused
 * `checkpoint_done` and its retry are two more, and every guard that fires adds
 * one. So `STUCK_TURNS = 12` was reached after four or five real exchanges, and
 * an m02 review reported the ⚖️ nudge landing "right after the very first wrong
 * turn". That is pi-pair-notebook#3, and the count was the story.
 *
 * Six ANSWERS. A checkpoint normally takes one to three; six means the student
 * has said six things here and is still on it, whatever the model believes.
 * Filler and a detour's turns are already out — the same narrowing the note
 * cell and the late-close gate use, so all three agree on what an answer is.
 */
export const STUCK_ANSWERS = 6;



// ---------------------------------------------------------------------------
// The souvenir's quote — the one place the student's own words are still
// written INTO the notebook by this file. Their answers are not: those live in
// session_log.jsonl, in session_summary.md and in the session_record cell,
// none of which has to choose which message to copy. Their QUESTION is
// different — a souvenir is built because they asked something, so the
// question is the cell's subject rather than a record of their work.
// ---------------------------------------------------------------------------

/**
 * A souvenir cell opens with the student's own question, quoted. Every live
 * session so far produced detour cells that answered a question the notebook
 * never states, so a reader — the student, next month — cannot tell what the
 * cell is for.
 */
export function withQuotedQuestion(
  markdown: string,
  question: string,
  alsoQuoted = "",
): string {
  if (!question) return markdown;
  // Words, not bytes — and the log_detour gap check normalises the same way,
  // or the two halves of the contract disagree: a cell that quotes "can't"
  // against a question typed "cant" satisfies that check and then gets a
  // SECOND copy of the question prepended by this one.
  const flat = (s: string) =>
    s
      .toLowerCase()
      .replace(/['‘’ʼ"“”]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  if (flat(markdown).includes(flat(question))) return markdown;
  if (alsoQuoted && flat(markdown).includes(flat(alsoQuoted))) return markdown;
  const quote = `> 🧭 **You asked:** “${question}”`;
  const lines = markdown.split("\n");
  if (/^\s*#{1,6}\s/.test(lines[0] ?? "")) {
    return [lines[0], "", quote, ...lines.slice(1)].join("\n");
  }
  return `${quote}\n\n${markdown}`;
}

/**
 * Is this quote something the student actually typed?
 *
 * `snapToTranscript` is a REPAIR, and it returns null for two situations that
 * are indistinguishable at its call site: the text is already verbatim in the
 * transcript (nothing to repair), and nothing in the transcript resembles it
 * at all (nothing to repair WITH). The second falls through to the model's own
 * string, which then goes into the student's notebook under **You asked**. A
 * submitted m01 notebook carries a whole sentence of reasoning that way —
 * "Odd numbers pair off to one extra, that means one extra visit, so three
 * visits total?" — that its student never typed. Per REVIEWING.md, corrupting
 * the graded record is a Blocker.
 *
 * Plain containment, and no threshold. Every repair in this file already ends
 * in a REAL message (snapToTranscript returns one; matchDetourQuestion's
 * upgrade returns `said[index]`), so on every honest path this is a no-op —
 * which is exactly why it can be acted on where the four meaning-judging
 * guards this file records had to be withdrawn. "Does any message contain this
 * string" is decidable; "is this a fair paraphrase" is not.
 *
 * It STANDS DOWN on an empty pool, like every other check here: with nothing to
 * check against there is nothing to conclude, and a transcript we cannot read
 * must never accuse. normMsg erases every non-ASCII script, so a student
 * typing Japanese or Cyrillic normalises to "" and stands down too — with a
 * looser fallback below it so their quotes can still be BACKED rather than
 * merely unjudged.
 */
export function quoteIsBacked(quote: string, pool: string[]): boolean {
  const q = normMsg(quote);
  const pooled = pool.map((m) => normMsg(m)).filter(Boolean);
  if (!q || !pooled.length) return true;
  if (pooled.some((m) => m.includes(q))) return true;
  // Punctuation-only normalisation, which keeps scripts normMsg drops.
  const loose = (s: string) =>
    s.toLowerCase().replace(/['‘’ʼ"“”]/g, "").replace(/\s+/g, " ").trim();
  const lq = loose(quote);
  return !!lq && pool.some((m) => loose(m).includes(lq));
}

/**
 * The marker this toolkit owns. A student never types it; the extension writes
 * it, and `withQuotedQuestion` is the only thing that should.
 */
export const ASKED_LINE = /^[ \t]*>?[ \t]*🧭[ \t]*\*\*You asked:?\*\*/;

/**
 * The quote AS A SEGMENT, not as a line.
 *
 * A line test is the obvious way to write this and it does not work: the shape
 * the model actually produces is
 *
 *     mo.md(r\"\"\"> 🧭 **You asked:** “…”\n\n…\"\"\")
 *
 * where the marker and the closing `\"\"\"` share a line — so a strip that
 * refuses any line holding a string delimiter (as it must, or it can unbalance
 * the source) never fires on the one shape it was written for. Matching the
 * marker plus its quoted span removes only text that provably contains no
 * delimiter, wherever on the line it sits.
 */
// The compass and the bold are OPTIONAL, because the model does not use them.
// A live run wrote its souvenir quote as `You asked: *"…"*` — no 🧭, emphasis
// instead of bold — and a pattern anchored on the toolkit's own marker walks
// straight past it. That one was verbatim and harmless; the same shape with a
// composed question is the Blocker this exists to stop.
//
// Widening is safe in the one direction that matters: nothing is removed
// unless the quoted text is absent from everything the student typed or
// picked, so an ordinary sentence quoting them back keeps its quote.
const ASKED_SEGMENT =
  />?[ \t]*(?:🧭[ \t]*)?(?:\*\*|__)?You asked:?(?:\*\*|__)?[ \t]*[*_]*[“"]([^”"]*)[”"][*_]*[ \t]*/gi;

/**
 * Take the MODEL's **You asked** line out of a cell body before that cell
 * exists. Every one of them, backed or not.
 *
 * "The quote line is the extension's job, not the model's" is the rule this
 * file already states at log_detour's gap check, and it is stated because the
 * model cannot be trusted with it. Two live faults, one each way:
 *
 *   UNBACKED. log_detour's bounce text used to hand over the literal template,
 *   and a cell built from it satisfied the "is the question quoted?" test with
 *   the MODEL's wording — so the extension's quoting path never ran and a
 *   sentence the student never typed shipped in their keepsake. That is the
 *   Blocker in pi-pair-notebook#5.
 *
 *   BACKED BUT SHORT. An m02 run wrote
 *       You asked: *"whats the difference between an average and a median hop count?"*
 *   for a student who typed that PLUS "i keep mixing them up". Containment says
 *   backed, so an unbacked-only rule leaves it — and then the extension's own
 *   check finds no match for the full message, prepends the correct quote, and
 *   the souvenir carries the question twice: once whole, once with half the
 *   student's sentence missing.
 *
 * So the rule is not "remove the false ones", it is "the model does not write
 * this line". The extension adds the right one straight after — through
 * withQuotedQuestion on the markdown path, prependQuestionToCell on the cell
 * path, and quoteCellBeside when that will not go in.
 *
 * WHOLE SEGMENTS, never a line holding a string delimiter. The quote sits
 * inside a triple-quoted markdown literal, and the shape the model actually
 * writes puts the marker and the closing `"""` on the same line — so a
 * LINE-based strip has to refuse exactly the case it exists for. Matching the
 * marker plus its quoted span removes only text that provably contains no
 * delimiter, wherever on the line it sits.
 */
export function stripModelQuoteLines(
  code: string,
): { code: string; removed: string[] } {
  const removed: string[] = [];
  const out = code.replace(ASKED_SEGMENT, (whole, quoted: string) => {
    // Belt and braces. The capture group cannot contain a `"` at all, so this
    // can only fire on a pathological `\'\'\'`; keeping the segment is always the
    // safe answer, because unparseable Python in a student's notebook is worse
    // than a quote line that has to be reported instead of removed.
    if (/"""|\'\'\'/.test(whole)) return whole;
    if (!quoted.trim()) return whole;
    removed.push(quoted.trim());
    return "";
  });
  // What is left where the quote was is a blank line inside a markdown
  // literal, which renders as nothing. The cell is not otherwise touched: a
  // strip that also tidied would be editing the tutor's prose, and this is
  // allowed to remove exactly one thing.
  return { code: removed.length ? out : code, removed };
}

// ---------------------------------------------------------------------------
// What a souvenir cell is missing
// ---------------------------------------------------------------------------

/**
 * Everything wrong with a detour souvenir, rather than the first thing.
 *
 * `gap` was one string and `!shows` won the ternary, so a markdown-table
 * souvenir always reported "is prose only" and a MISSING QUOTE was never
 * mentioned — not in the bounce, not on the row. Two of one student's three
 * souvenirs shipped with the tutor's paraphrase of their question instead of
 * their words, and nothing anywhere said so. The student had asked for tables
 * and no figures, which is a reasonable thing to want; it should not also cost
 * them the record of their own question.
 *
 * The QUOTE clause comes first because it is the graded-record fault of the
 * two, and because being second is how it got swallowed.
 */
export interface SouvenirVerdict {
  /** No such cell in the notebook — nb_edit_cell cannot make one. */
  missing: boolean;
  /** Nothing to look at or play with. */
  proseOnly: boolean;
  /** The question it answers is not in it. */
  unquoted: boolean;
  /** The one line for the bounce and for `souvenir_gap` on the row. */
  gap: string;
}

export function souvenirVerdict(v: {
  missing: boolean;
  proseOnly: boolean;
  unquoted: boolean;
}): SouvenirVerdict {
  const parts: string[] = [];
  if (v.missing) return { ...v, gap: "does not exist in the notebook" };
  if (v.unquoted) parts.push("never quotes the question it answers");
  if (v.proseOnly) parts.push("is prose only — nothing to look at or play with");
  return { ...v, gap: parts.join(", and ") };
}

// ---------------------------------------------------------------------------
// Checkpoint ids
// ---------------------------------------------------------------------------

/** "cp2_distance_extra" (an improvised practice round) → "cp2_distance". */
export function baseCheckpointId(id: string): string {
  // Repeated, because a looping tutor produced "cp0_welcome_extra_extra" —
  // one strip left an id no lookup could match, which silently disabled the
  // ordering guard and the note skeleton for every later round.
  let out = id;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/_extra(_?\d+)?$/, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** True when `a` and `b` differ by at most `max` edits. */
export function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false; // no cell in this row can still win
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * Pull a checkpoint id back onto the script when the model has drifted near
 * it. `order` is the script's flat checkpoint order — passed in, so this can
 * be run without a lesson/ directory.
 */
export function snapCheckpointId(
  id: string,
  order: string[],
): { id: string; snappedFrom?: string } {
  const base = baseCheckpointId(id);
  if (order.includes(base)) return { id };
  const suffix = id.slice(base.length); // "_extra", "_extra2", ""
  const norm = (s: string) => s.toLowerCase().replace(/[-\s.]/g, "_");
  const target = norm(base);
  let hit = order.find((c) => norm(c) === target);
  if (!hit) {
    // One edit away, and only when exactly one candidate is that close — an
    // ambiguous near miss is not a near miss.
    const within1 = order.filter((c) => editDistanceAtMost(norm(c), target, 1));
    if (within1.length === 1) hit = within1[0];
  }
  return hit ? { id: hit + suffix, snappedFrom: id } : { id };
}

/** A sentence the DIALOG produced, not the student. */
export const isDialogSentinel = (s: string): boolean =>
  /^user (declined to answer|wants to chat)/i.test(s.trim()) ||
  /^\(no input\)$/i.test(s.trim());

// ---------------------------------------------------------------------------
// Picker answers
// ---------------------------------------------------------------------------

/**
 * The resume dialog, recognised by the words the resume brief tells the model
 * to use. Matching by CONTENT and not by "whatever dialog comes first after a
 * resume" is deliberate: if the tutor asks continue-or-fresh in plain text,
 * a positional flag would swallow the next real prediction instead.
 *
 * It is also the ONLY dialog anything filters, which is the hole — a dialog
 * the tutor improvises for its own purposes ("did the page open?") matches
 * none of these words and rides into the next checkpoint's `student_picked`.
 * See pi-pair-notebook#6.
 */
const RESUME_ANSWER = /continue|fresh|left off|pick (things )?up/i;

/**
 * The machinery half of a dialog, decided on the QUESTION the tutor asked.
 *
 * The answer cannot decide this. "Found it — I can see the city now" is the
 * answer to "did the page open?" and it is also a perfectly good answer to a
 * question about Königsberg; RESUME_ANSWER only works at all because the resume
 * brief dictates the words. Everything else the tutor raises it improvises, so
 * a blacklist of answers can never extend to it. The question is in the tool
 * result — `details.answers[].question`, confirmed against live session files
 * — and it is the tutor's own sentence, not the student's, so a word list here
 * cannot delete a student's words the way one over their answers could.
 *
 * TIGHT ON PURPOSE, and it fails open. A machinery NOUN and a machinery STATE
 * word must BOTH be present, and both lists are deliberately small: the
 * expensive direction is filing a lesson answer as machinery, because that
 * takes the student's own answer out of `student_picked` and out of the
 * *You chose:* line in their notebook. Anything this cannot place stays a
 * lesson answer, which is what every dialog was before this existed.
 *
 * The shapes that must NOT match, all of them things this course really asks:
 *   "Look at your notebook — does the walk work?"        (no machinery noun)
 *   "Does the graph on your screen show a triangle?"     (no machinery noun)
 *   "Can you find a route on the page that crosses …?"   (no machinery state)
 */
const MACHINERY_THING =
  /\b(?:notebook|whiteboard|browser|the page|that page|the tab|the link|that link|terminal|marimo)\b/i;
const MACHINERY_STATE =
  /\b(?:open|opened|opens|opening|load|loads|loaded|loading|reload|refresh|restart|restarted|blank|appear|appeared|appears|pop(?:ped)? up|came up|come up|visible)\b/i;
/**
 * A lesson question that happens to mention the apparatus is still a lesson
 * question. Paper checkpoints talk about photographs and drawings; a figure
 * anywhere means the exchange carried graded content.
 */
const LESSON_ASK =
  /\bhow many\b|\bhow much\b|\bwhy\b|\bdo you think\b|\bwhat do you\b|\bpredict\b|\bwhich of\b|\bpaper\b|\bphoto|\bpicture\b|\bdraw/i;
/**
 * The continue-or-fresh dialog, seen from the question side — by the exact
 * words the resume brief dictates, and nothing looser.
 *
 * "start fresh" alone is NOT enough: a tutor offering a practice round on new
 * data says "shall we start fresh with a different city?", and that is a
 * lesson question whose answer belongs in the record.
 */
const RESUME_QUESTION = /where we left off/i;

export function pickIsMechanics(question: string, answer: string): boolean {
  const q = String(question ?? "");
  if (!q.trim()) return false; // no question to judge — it stays a lesson answer
  if (RESUME_QUESTION.test(q)) return true;
  if (LESSON_ASK.test(q)) return false;
  // Any digit at all, not isFigure: a bare "7" is deliberately not a figure
  // elsewhere in this file (a subscript and a dot label tokenize that way),
  // but "did the page open with all 7 bridges?" is an exchange about the
  // seven bridges. Erring toward lesson costs nothing; erring the other way
  // takes a student's answer out of their notebook.
  if (/\d/.test(`${q} ${answer ?? ""}`)) return false;
  return MACHINERY_THING.test(q) && MACHINERY_STATE.test(q);
}

/** One answer to one question of one dialog. */
export interface PickRecord {
  /** The tutor's question, when the dialog reported it. */
  question: string;
  /** What the student chose or typed. */
  answer: string;
  /** Session machinery rather than an answer to the lesson. */
  mechanics: boolean;
}

export interface PickCapture {
  /** Every answer this dialog produced, question attached, classified. */
  picks: PickRecord[];
  /**
   * The LESSON answers, joined — the value `student_picked` has always held.
   * Kept as its own field so nothing downstream has to know about the split.
   */
  picked: string | null;
  /** True when this was the resume choice, so the caller clears its flag. */
  resumeAnswered: boolean;
}

const NOTHING: PickCapture = { picks: [], picked: null, resumeAnswered: false };

/**
 * What a finished `ask_user_question` contributes to the graded record.
 *
 * Pure so a test can reach it: every branch below is a shape a live session
 * produced, and none of them is on a boot path.
 */
export function capturePick(event: any, awaitingResumeChoice: boolean): PickCapture {
  if (!/ask.?user.?question/i.test(String(event?.toolName ?? ""))) return NOTHING;

  // The package supplies the answers structured on the tool result; the
  // envelope sentence is only a fallback. Parsing prose truncated an answer
  // that contained its own quotation marks.
  //
  // Both shapes carry the QUESTION as well, and both used to throw it away:
  // details.answers[] is {questionIndex, question, kind, answer} (confirmed
  // against live session files), and the envelope's own regex already captured
  // it as group 1. Keeping it is the whole of pi-pair-notebook#6 — it is the
  // only thing that can tell a prediction about seven bridges from "did the
  // page open?".
  const structured: PickRecord[] = (event?.details?.answers ?? [])
    .map((a: any) => ({
      question: String(a?.question ?? "").trim(),
      answer: String(a?.answer ?? a?.value ?? "").trim(),
    }))
    .filter((p: PickRecord) => p.answer && !isDialogSentinel(p.answer))
    .map((p: PickRecord) => ({ ...p, mechanics: pickIsMechanics(p.question, p.answer) }));
  const text = (event?.content ?? [])
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n")
    .trim();

  if (structured.length) return settlePicks(structured, awaitingResumeChoice);
  if (!text) return NOTHING;

  let picks: PickRecord[] = [];
  try {
    const parsed = JSON.parse(text);
    if (parsed?.cancelled) return NOTHING;
    const answers = parsed?.answers ?? parsed;
    const flat = Array.isArray(answers)
      ? answers
      : answers && typeof answers === "object"
        ? Object.values(answers)
        : [];
    picks = flat
      .map((a: any) =>
        typeof a === "string"
          ? { question: "", answer: a }
          : { question: String(a?.question ?? ""), answer: String(a?.answer ?? a?.value ?? "") },
      )
      .filter((p: PickRecord) => p.answer && !isDialogSentinel(p.answer))
      .map((p: PickRecord) => ({ ...p, mechanics: pickIsMechanics(p.question, p.answer) }));
  } catch {
    // Not JSON. The dialog package hands back a sentence of plumbing —
    //   User has answered your questions: "How do you feel about
    //   Python?"="tried a little". You can now continue …
    // — and storing that whole sentence put a machine's voice inside the
    // student's own `*You chose:*` line in the submitted notebook. Keep only
    // the answers: every "question"="answer" pair's right-hand side. Per
    // ANSWER, not per sentence: a dialog with two questions where one was
    // left blank must still record the one that was answered. The value is
    // matched lazily up to the quote that ends the pair, so an answer
    // containing its own quotation marks survives instead of being stored
    // truncated to its first word.
    picks = [...text.matchAll(/"([^"]*)"\s*=\s*"([\s\S]*?)"(?=\s*[.,]|\s*$)/g)]
      .map((m) => ({ question: m[1].trim(), answer: m[2].trim() }))
      .filter((p) => p.answer && !isDialogSentinel(p.answer))
      .map((p) => ({ ...p, mechanics: pickIsMechanics(p.question, p.answer) }));
  }

  return settlePicks(picks, awaitingResumeChoice);
}

/**
 * The last three decisions, in one place because they have to happen in this
 * order and each of them has a live failure behind it.
 *
 * A dismissed dialog is not an answer. The package returns a fixed "User
 * declined to answer questions", which is a machine's sentence — stored, it
 * printed in the submitted record as *You chose: "User declined to answer
 * questions"*, attributed to the student.
 *
 * And it does NOT answer the resume question, so the flag stays armed:
 * clearing it there meant the RE-ASKED continue-or-fresh answer was stored
 * instead, which is the same leak one dialog later. The resume test stays on
 * the ANSWER and stays behind the arming flag, deliberately: the flag is what
 * makes "Start fresh" safe as a lesson answer once the first checkpoint has
 * closed, and matching the question instead would swallow a real prediction
 * from a tutor that offers a practice round "from scratch".
 */
function settlePicks(picks: PickRecord[], awaitingResumeChoice: boolean): PickCapture {
  if (!picks.length) return NOTHING;
  if (awaitingResumeChoice && picks.some((p) => RESUME_ANSWER.test(p.answer))) {
    return { picks: [], picked: null, resumeAnswered: true };
  }
  const capped = picks.map((p) => ({ ...p, answer: p.answer.slice(0, 300) }));
  const lesson = capped.filter((p) => !p.mechanics).map((p) => p.answer);
  return {
    picks: capped,
    picked: lesson.length ? lesson.join(" · ") : null,
    resumeAnswered: false,
  };
}

// ---------------------------------------------------------------------------
// Detours
// ---------------------------------------------------------------------------

/**
 * Question shape is decided at the START of an utterance, not by a wh-word
 * anywhere in it. A wh-word ANYWHERE deleted a student's real answer from
 * their own note: "clustering is how often my friends know each other"
 * scores 0.78 against the question "how often do friends know each other",
 * and contains "how". Dropping their work from the graded artifact is far
 * worse than leaving a question in it, so this errs toward keeping.
 *
 * `which`, `whether` and `if` are deliberately NOT openers: they lead
 * declaratives at least as often ("which means C stays the same").
 */
const QUESTION_OPENER =
  /^(?:(?:wait|hang on|hold on|sorry|ok|okay|hmm+|umm+|oh|but|and|also|quick|one more|side note|random|off topic)[ ]+)*(?:what|whats|why|how|hows|when|where|who|whos|is|are|isnt|arent|do|does|did|dont|doesnt|can|could|should|would|will)\b|^(?:i (?:dont|do not|didnt|cant) (?:get|understand|see|follow)|im (?:confused|lost)|i(?:m| am) not sure (?:what|why|how))\b/;

const HEDGE_WORDS = new Set([
  "wait", "hang", "hold", "sorry", "ok", "okay", "hmm", "hmmm", "umm", "um",
  "oh", "ohh", "quick", "random", "side", "topic", "off", "exactly", "just",
  "really", "actually", "again", "please", "btw", "like", "though", "tho",
  "whats", "hows", "whos", "one", "more", "note", "er",
]);

export interface DetourMatch {
  /** Where in `said` the question was asked, or -1 when nothing matched. */
  index: number;
  /**
   * The question to quote in the souvenir. Upgraded to the student's whole
   * message when this IS that message — a live run logged the question with
   * the student's lead-in trimmed off ("Wait, quick question first —") and
   * the souvenir quoted the trim.
   */
  question: string;
  /**
   * True when the message may be marked as a detour: dropped from the next
   * checkpoint's note, and its span skipped. False means the message carries
   * more than the question and stays whole.
   */
  isDetour: boolean;
}

/**
 * Which of the student's messages holds the question `log_detour` was called
 * with — and whether that message is ONLY the question.
 *
 * A message that is their question AND something else keeps its something
 * else. Dropping whole messages cost a student the "i count 2" out of "how
 * many could there be? i count 2" — half an answer, gone from the note, on
 * the checkpoint that was about counting.
 */
export function matchDetourQuestion(question: string, said: string[]): DetourMatch {
  const qNorm = normMsg(question);
  // A message containing the question is a match; a message CONTAINED IN it
  // is not — "triangles" sits inside "why do triangles matter?" and is a
  // perfectly good answer.
  let bestIdx = -1;
  let bestScore = 0;
  said.forEach((m, i) => {
    const n = normMsg(m);
    const d =
      n === qNorm || (qNorm.length > 0 && n.includes(qNorm)) ? 1 : bigramDice(m, question);
    // `>` and not `>=`: on a tie the EARLIER message wins nothing, and a
    // student who typed the same words twice must not stretch the span back
    // over answers they had already given.
    if (d > bestScore) {
      bestScore = d;
      bestIdx = i;
    }
  });
  if (bestIdx < 0) return { index: -1, question, isDetour: false };
  const asked = said[bestIdx];
  const looksAsked = /\?/.test(asked) || QUESTION_OPENER.test(normMsg(asked));

  // WHERE the leftovers sit decides what they are. A lead-in runs BEFORE the
  // question ("wait, quick question before I do the average — does it matter
  // which direction…"), and a live run lost that whole checkpoint's note to
  // it: four content words in the run-up read as an answer. What comes AFTER
  // is the half that is usually an answer. Either way a figure anywhere in
  // the leftovers means graded content, and the message stays whole.
  const aNorm = normMsg(asked);
  const at = qNorm ? aNorm.indexOf(qNorm) : -1;
  const tokensOf = (t: string) => t.split(" ").filter(Boolean);
  const before = at >= 0 ? tokensOf(aNorm.slice(0, at)) : [];
  const after = at >= 0 ? tokensOf(aNorm.slice(at + qNorm.length)) : [];
  const qTok = new Set(tokensOf(qNorm));
  const residue = at >= 0 ? [...before, ...after] : tokensOf(aNorm).filter((t) => !qTok.has(t));
  // Only the trailing half is weighed by length; a lead-in is judged on
  // figures alone.
  const weighed = at >= 0 ? after : residue;
  const carriesMore =
    residue.some((t) => /\d/.test(t)) ||
    weighed.filter((t) => !HEDGE_WORDS.has(t) && !SLOT_GLUE.has(t)).length >= 3;

  const isDetour = !carriesMore && (bestScore >= 0.9 || (bestScore >= 0.6 && looksAsked));
  return {
    index: bestIdx,
    question: isDetour && normMsg(asked) !== qNorm ? asked : question,
    isDetour,
  };
}

/**
 * How many questions a checkpoint's `ask:` block asks, counted from its own
 * numbered list. Zero when the block does not number them, which switches the
 * check that uses this OFF rather than guessing.
 *
 * "2b." counts as its own question. A script that splits a step in two — ask,
 * then invite the self-check box in the student's own beat — asks one more
 * thing than its top-level numbering says, and the late-close gate compares
 * this number against how many messages the student sent.
 */
export function scriptedQuestionCount(askBlock: string): number {
  return (askBlock.match(/^\s*\d+[a-z]?\.\s/gm) ?? []).length;
}


// ---------------------------------------------------------------------------
// Where the notebook is
// ---------------------------------------------------------------------------

/**
 * The address of the student's page was spoken ONLY from openInBrowser's
 * failure branch. On macOS `open <url>` exits 0 the instant it has handed the
 * URL to a browser, and `cmd /c start` on Windows likewise — so a page that
 * opened behind the terminal, on another Space, or in a browser nobody was
 * watching counted as SUCCESS, the failure branch never ran, and nothing ever
 * said the address out loud.
 *
 * All three submitted m01 sessions opened with the student unable to find the
 * notebook: 21 minutes of one graded session and 22 hours of another spent
 * hunting for a page that was already running, and a third student typing
 * "can we restart? i did not see the browser open". The dialog the tutor
 * improvised in reply is still in that session's graded record.
 *
 * The words are here so `npm test` can hold them to the two things that matter:
 * the line carries the URL, and it never carries a command for the student to
 * run. An empty url returns an empty banner — a printed guess at the address
 * is worse than silence, and startMarimo's own comment says the port is often
 * not the one we would guess.
 */
export const NOTEBOOK_BANNER_PREFIX = "📓 Your notebook";

export function notebookBanner(url: string, opened: boolean): string {
  if (!/^https?:\/\/\S+$/.test(url ?? "")) return "";
  const tail = "Your tutor runs it for you — there is nothing to install and nothing to start.";
  return opened
    ? `${NOTEBOOK_BANNER_PREFIX} is at ${url}\n` +
        `It should already be open in your browser. If you cannot see it — another window, ` +
        `another desktop — open that link. ${tail}`
    : `${NOTEBOOK_BANNER_PREFIX} is at ${url}\n` +
        `It did not open by itself, so please open that link in your browser now. ${tail}`;
}

/** The port a URL names, or "" when it names none. */
export function urlPort(url: string): string {
  return /^https?:\/\/[^/?#]*?:(\d+)/.exec(url ?? "")?.[1] ?? "";
}

/**
 * Take a second marimo server out of the tutor's mouth before the student
 * reads it.
 *
 * Asked where the notebook was, a live tutor told the student to run
 * `marimo edit notebook.py` in a new terminal, and doubled down when pressed.
 * Measured in the same sandbox: that starts a SECOND server on :2719 while the
 * toolkit's own holds :2718. The student then watches a page no nb_* call ever
 * writes to, with two kernels open on one file, and every cell the tutor
 * builds lands somewhere they cannot see. They are further from the notebook
 * than before they asked.
 *
 * READ THE HISTORY BEFORE TOUCHING THIS. `NARRATES_A_BUILD` — a regex over the
 * tutor's phrasing, fired as an invisible note — was deleted in f8fe8f2, and
 * its epitaph in notebook-tool.ts says that shape "has failed here every
 * single time" and "could not unsay the sentence". Two things make this
 * different, and if either stops being true this should go the same way:
 *
 *  1. It matches a COMMAND and a PORT NUMBER, not a mood. There is one way to
 *     write `marimo edit`; there are a thousand ways to say "let me draw".
 *     `bash` is taken off the tutor at session_start, so a shell command in
 *     front of a student has no honest use here at all. "new terminal" is
 *     deliberately NOT matched — setup/setup-pi.mjs tells a student to open
 *     one, for a good reason, in those words.
 *  2. It is applied at RENDER time, so it does unsay it: the wrong line never
 *     reaches the screen. Nothing is refused and no turn is aborted.
 *
 * The port half is skipped unless we know our own port. startMarimo's comment
 * records why: `--sandbox` re-execs and the second process binds again, often
 * somewhere else, and a rewrite that cannot tell our server from theirs would
 * replace correct addresses with a guess.
 */
// The command and its own arguments — NOT the rest of the line. `[^\n`]*` ate
// the prose after it ("…and tell me what you see"), so a sentence that gave
// wrong advice and then said something perfectly good lost both halves.
const RIVAL_COMMAND =
  /\b(?:uvx\s+|uv\s+run\s+|python3?\s+-m\s+)?marimo\s+(?:edit|run)(?:\s+(?:--?[\w-]+|[\w./~-]+\.py|[\w./~-]*notebook[\w./~-]*))*/gi;
const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?(?:\/[^\s`)\]]*)?/gi;

export function rewriteRivalServer(
  text: string,
  present: string,
): { text: string; hits: string[] } {
  if (!/^https?:\/\/\S+$/.test(present ?? "")) return { text, hits: [] };
  const live = urlPort(present);
  const hits: string[] = [];
  let out = text.replace(RIVAL_COMMAND, (m) => {
    hits.push(m.trim());
    return `open ${present} — it is already running, there is nothing to start`;
  });
  if (live) {
    out = out.replace(LOCAL_URL, (m, port) => {
      if (port === live) return m;
      hits.push(m);
      return present;
    });
  }
  return { text: out, hits };
}
