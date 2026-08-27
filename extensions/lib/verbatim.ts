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

// ---------------------------------------------------------------------------
// Choosing what the note cell quotes
// ---------------------------------------------------------------------------

export interface QuoteWindow {
  /** Every message the student typed since the last checkpoint closed. */
  said: string[];
  /** The answer the model logged, used only to RESCUE a message. */
  response: string;
  /** How many of `said` were typed before the tutor first spoke here. */
  cut: number;
  /** [first,last] index spans of `said` that belong to a detour. */
  detourSpans: [number, number][];
  /** Normalised text of questions already recorded as detours. */
  detourAsked: Set<string>;
  dropDetours: boolean;
}

/**
 * Which of the student's messages the note cell quotes, and their 1-based
 * positions in `said`.
 *
 * The BOUNDARY decides what to drop; content may only ever RESCUE. That
 * asymmetry is the whole difference between this and growing ACK_WORDS,
 * which has twice deleted real answers from a graded artifact: a word list
 * decides on its own and gets "yes" wrong, while nothing is dropped here
 * that the timeline had not already placed before the tutor spoke — and a
 * figure, or the very message the tutor logged as the answer, pulls it
 * straight back in. A student who volunteers the answer before being asked
 * keeps it.
 */
export function chooseQuoted(w: QuoteWindow): { keep: string[]; from: number[] } {
  const from: number[] = [];
  const keep = w.said.filter((m, i) => {
    const isResponse = normMsg(m) === normMsg(w.response) || bigramDice(m, w.response) >= 0.6;
    // Inside a detour the student was answering the tutor's aside, not this
    // checkpoint. detourAsked already drops their question; this drops the
    // rest of the exchange around it.
    const inDetour = w.dropDetours && w.detourSpans.some(([a, b]) => i >= a && i <= b);
    const elsewhere = (i < w.cut || inDetour) && !isResponse && !slotTokens(m).some(isFigure);
    const k =
      isResponse || (!elsewhere && !w.detourAsked.has(normMsg(m)) && !isFillerMessage(m));
    if (k) from.push(i + 1);
    return k;
  });
  return { keep, from };
}

/**
 * The same three-step fail-open cascade the note cell has always used, in
 * one place so it can be run.
 *
 * If a narrowing leaves the note with nothing of theirs to quote, the caller
 * falls back to the MODEL's wording — which is what every check in this file
 * exists to prevent. So both narrowings give way, the newest one first,
 * before that can happen. Quote too much instead.
 */
export function chooseQuotedWithFallback(
  w: QuoteWindow,
): { keep: string[]; from: number[]; cutUsed: number; detoursDropped: boolean } {
  let chosen = chooseQuoted({ ...w, dropDetours: true });
  if (chosen.keep.length) return { ...chosen, cutUsed: w.cut, detoursDropped: true };
  if (w.cut > 0) {
    chosen = chooseQuoted({ ...w, cut: 0, dropDetours: true });
    if (chosen.keep.length) return { ...chosen, cutUsed: 0, detoursDropped: true };
  }
  if (w.detourSpans.length) {
    chosen = chooseQuoted({ ...w, dropDetours: false });
    if (chosen.keep.length) return { ...chosen, cutUsed: w.cut, detoursDropped: false };
  }
  return { ...chosen, cutUsed: w.cut, detoursDropped: false };
}

/**
 * A model-filled slot describes a picture, so its prose is the tutor's.
 * Anything it puts in QUOTATION MARKS is still the student's, and a live run
 * put three different spellings of one sentence into the record —
 * student_response, the transcript capture, and a note cell reading
 * "becuase tirangles are im[portat]", brackets and all. A quote that is a
 * near-copy of something they typed is replaced with what they actually
 * typed; a quote of three words or more that matches nothing they said is
 * reported.
 */
export function repairQuotes(
  fill: string,
  pool: string[],
): { text: string; snapped: string[]; invented: string[] } {
  const snapped: string[] = [];
  const invented: string[] = [];
  const text = fill.replace(/[“"]([^”"]{4,})[”"]/g, (whole, inner: string) => {
    const t = inner.trim();
    let best = "";
    let score = 0;
    for (const msg of pool) {
      const d = bigramDice(t, msg);
      if (d > score) {
        score = d;
        best = msg;
      }
    }
    if (score >= 0.8 && best && normMsg(best) !== normMsg(t)) {
      snapped.push(t);
      return `“${best}”`;
    }
    // Short quotes are labels and readings ("2.07", "long"), not speech.
    if (score < 0.5 && t.split(/\s+/).filter(Boolean).length >= 3) invented.push(t);
    return whole;
  });
  return { text, snapped, invented };
}

/**
 * A quote that stops partway through what the student typed.
 *
 * slotDrift only asks what a quote ADDS. It cannot see what the quote LEAVES
 * OFF, and a practice round lost a student's reasoning that way: they typed
 * "6 choose 2 is 15, and the outer friends each only have 1 friend so they
 * cant center any" and the note quoted "6 choose 2 is 15" — the arithmetic
 * kept, the thinking dropped, on a checkpoint whose whole point was the
 * thinking. Nothing was added, so nothing fired.
 *
 * Returns the offending segment and what was dropped, or null.
 */
export function truncatedQuote(
  quoted: string,
  said: string[],
  minDropped = 4,
): { segment: string; rest: string } | null {
  for (const seg of quoted.split("·").map((s) => s.trim().replace(/^"|"$/g, ""))) {
    const segN = normMsg(seg);
    if (segN.split(" ").filter(Boolean).length < 2) continue;
    // A quote that IS one of their messages is right by definition, even when
    // a later one opens with the same words. Students elaborate: "i think its
    // 2", then "i think its 2 because they are neighbours on the ring".
    // Without this, quoting the first one exactly and correctly is reported
    // as a truncation of the second.
    if (said.some((m) => normMsg(m) === segN)) continue;
    const whole = said.find((m) => {
      const mN = normMsg(m);
      return mN.startsWith(segN) && mN.length > segN.length;
    });
    if (!whole) continue;
    const dropped = normMsg(whole).split(" ").length - segN.split(" ").length;
    if (dropped >= minDropped) {
      return { segment: seg, rest: normMsg(whole).slice(segN.length).trim() };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function fillSlots(skeleton: string, slots: string[], fallback: string): string {
  let i = 0;
  let usedFallback = false;
  return skeleton.replace(/«[^»]*»/g, () => {
    const supplied = slots[i];
    i += 1;
    // `.trim()`, matching the slot-count guard: a whitespace pad satisfied
    // neither, and rendered as a heading with nothing under it.
    if (supplied !== undefined && supplied.trim() !== "") return supplied;
    // The fallback is for a ONE-slot skeleton. On a skeleton whose other slot
    // already quotes the student, using it again printed their sentence twice
    // in one line: "**My guess:** way off, i said 20 — "way off, i said 20"".
    if (!fallback.trim() || usedFallback) return "*(not answered)*";
    usedFallback = true;
    return fallback;
  });
}

/** The «slot» markers in a note skeleton, in order. */
export const slotMarkers = (skeleton: string): string[] => skeleton.match(/«[^»]*»/g) ?? [];

/**
 * A souvenir cell opens with the student's own question, quoted. Every live
 * session so far produced detour cells that answered a question the notebook
 * never states — unreadable months later, and the personalization is the
 * whole point of a souvenir.
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

/**
 * What a «verbatim» slot renders when the student typed nothing at all.
 *
 * Normally that cannot happen: a skeleton only asks for their words where a
 * question was put to them, and `checkpoint_done` refuses a close that quotes
 * words nobody typed. The exception is a paper checkpoint whose PHOTO
 * arrived — the page was the answer, and refusing there would be refusing an
 * honest record.
 *
 * The fallback used to be `student_response` in every case, and on that one
 * path it put the model's own stage direction inside a fold labelled as the
 * student's words. From a gate run on 2026-08-27, in cp2_paperwork's "My
 * work":
 *
 *     > (photo of hand-worked table: 5-ring, all 10 pairs, sum 15, average 1.5)
 *
 * Nobody said that. It is a sentence the model wrote for the log's headline
 * field, and the row still carries it there, where it belongs. What the fold
 * says now is what actually happened.
 */
export function verbatimFill(
  answerish: string[],
  response: string,
  opts: { photoAnswered?: boolean } = {},
): string {
  if (answerish.length) {
    return answerish.map((m) => `"${m.replace(/\n+/g, " ").trim()}"`).join(" · ");
  }
  return opts.photoAnswered ? "*(answered on paper — the photo is above)*" : response;
}
