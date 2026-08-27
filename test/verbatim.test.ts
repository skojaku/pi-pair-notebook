/**
 * Every case below is a fault a live session actually produced, or a fix that
 * a later fix broke. The file is written as a regression log: if a name reads
 * like a story, that is because it is one.
 *
 * `npm test` — node --test, no dependencies to install.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  baseCheckpointId,
  bigramDice,
  chooseQuoted,
  chooseQuotedWithFallback,
  driftIsReportable,
  editDistanceAtMost,
  fillSlots,
  isDialogSentinel,
  isFigure,
  isFillerMessage,
  matchDetourQuestion,
  normMsg,
  repairQuotes,
  scriptedQuestionCount,
  slotDrift,
  slotMarkers,
  slotTokens,
  snapCheckpointId,
  snapToTranscript,
  truncatedQuote,
  verbatimFill,
  withQuotedQuestion,
} from "../extensions/lib/verbatim.ts";

const NO_DETOURS = { detourSpans: [] as [number, number][], detourAsked: new Set<string>() };

// ---------------------------------------------------------------------------
// normMsg / isFillerMessage
// ---------------------------------------------------------------------------

test("normMsg strips the apostrophe, so its and it's are one word", () => {
  assert.equal(normMsg("it's 2"), normMsg("its 2"));
});

test("an acknowledgement carrying a number is never filler", () => {
  // "ok 2" is an answer with a politeness in front of it.
  assert.equal(isFillerMessage("ok 2"), false);
});

test("'yeah lets keep going' is filler — the whole reason lets/keep are listed", () => {
  assert.equal(isFillerMessage("yeah lets keep going"), true);
});

test("'this one' is NOT filler — it is half an answer", () => {
  // Adding this/that/one to ACK_WORDS once deleted a real answer from a
  // keepsake while the student's reason survived beside it.
  assert.equal(isFillerMessage("this one"), false);
});

test("a nine-word acknowledgement is left alone", () => {
  assert.equal(isFillerMessage("ok okay sure right yeah yep fine cool nice great"), false);
});

// ---------------------------------------------------------------------------
// isFigure / slotTokens / slotDrift
// ---------------------------------------------------------------------------

test("a bare single digit is not a figure", () => {
  // "dot 1 to dot 5" and the subscript in $L_0$ both tokenize to single
  // digits. Flagging those refused faithful records.
  assert.equal(isFigure("1"), false);
  assert.equal(isFigure("0"), false);
});

test("compound and multi-digit numbers are figures", () => {
  for (const t of ["7/6", "1.17", "4.74", "12", "2.29"]) {
    assert.equal(isFigure(t), true, t);
  }
});

test("slotDrift reports a number the student never gave", () => {
  const d = slotDrift("the average over all 6 pairs = 7/6 ≈ 1.17", ["yes", "2"]);
  assert.equal(driftIsReportable(d), true);
  assert.ok(d.numbers.includes("7/6"));
});

test("slotDrift lets structural labels through", () => {
  // "Idea: … Count: … Fraction: …" is the sanctioned shape for a multi-part
  // «their answers, verbatim» slot.
  const d = slotDrift("Idea: lines between them. Count: 2. Fraction: 2 out of 10", [
    "lines between them",
    "2",
    "2 out of 10",
  ]);
  assert.equal(driftIsReportable(d), false);
});

test("KNOWN GAP: slotDrift cannot see a substitution (pi-pair-notebook#2)", () => {
  // The student typed "i put it there because…"; the note said "I ran it from
  // 0 to 4 because…". Nothing was ADDED that the pool did not hold, so the
  // check is silent. This is a documented blind spot, not a bug to fix here —
  // the fix is the script, which must not ask one slot to describe AND quote.
  const said = ["i put it there because that was the longest trip before, 4 steps"];
  const pool = [...said, "your cable runs from 0 to 4"]; // the photo description
  const d = slotDrift(
    "I ran it from 0 to 4 because that was the longest trip before, 4 steps",
    pool,
  );
  assert.equal(driftIsReportable(d), false);
});

// ---------------------------------------------------------------------------
// snapToTranscript
// ---------------------------------------------------------------------------

test("a re-scrambled typo snaps back to what they typed", () => {
  const said = ["becuase tirangles are ipmortat"];
  assert.equal(snapToTranscript("becuase tirangles are ipormtat", said), said[0]);
});

test("a joined multi-part answer is NOT swallowed by its longest fragment", () => {
  // Snapping here would delete half the student's answer from the record.
  const said = ["A–D is 2", "the average is 7/6 over all six pairs"];
  assert.equal(snapToTranscript("A–D is 2, and the average is 7/6 over all six pairs", said), null);
});

test("nothing to repair when the text is already in the transcript", () => {
  assert.equal(snapToTranscript("i think its 2", ["i think its 2"]), null);
});

// ---------------------------------------------------------------------------
// truncatedQuote  (fd45061 and its correction 08a6620)
// ---------------------------------------------------------------------------

test("a quote that stops partway through their sentence is caught", () => {
  const said = [
    "6 choose 2 is 15, and the outer friends each only have 1 friend so they cant center any",
  ];
  const hit = truncatedQuote('"6 choose 2 is 15"', said);
  assert.ok(hit, "expected the dropped reasoning to be reported");
  assert.match(hit.rest, /outer friends/);
});

test("a correct quote is not called a truncation of a later elaboration", () => {
  // Students elaborate. Quoting the first message exactly is right by
  // definition, even when a later one opens with the same words.
  const said = ["i think its 2", "i think its 2 because they are neighbours on the ring"];
  assert.equal(truncatedQuote('"i think its 2"', said), null);
});

test("quoting some turns and not others is not a truncation", () => {
  const said = ["2", "and the average is 7/6", "that felt slow"];
  assert.equal(truncatedQuote('"2" · "and the average is 7/6"', said), null);
});

// ---------------------------------------------------------------------------
// repairQuotes
// ---------------------------------------------------------------------------

test("a near-copy quote inside a model slot is replaced with their words", () => {
  const r = repairQuotes(
    'their reason: “becuase tirangles are ipormtat”',
    ["becuase tirangles are ipmortat"],
  );
  assert.deepEqual(r.snapped, ["becuase tirangles are ipormtat"]);
  assert.match(r.text, /ipmortat/);
});

test("a short quote is a label, not speech", () => {
  const r = repairQuotes('the widget read “2.07”', ["i moved the slider"]);
  assert.deepEqual(r.invented, []);
});

test("a three-word quote matching nothing they said is reported", () => {
  const r = repairQuotes('“P is 3, Q is 3, R is 2”', ["i counted them one at a time"]);
  assert.equal(r.invented.length, 1);
});

test("a picker answer is not treated as invented when the pool carries it", () => {
  // Comparing against the typed transcript alone once accused a student of
  // inventing their own picker choice.
  const r = repairQuotes('“about 20 hands”', ["about 20 hands"]);
  assert.deepEqual(r.invented, []);
});

// ---------------------------------------------------------------------------
// chooseQuoted — the capture window
// ---------------------------------------------------------------------------

test("a message typed before the tutor spoke here is skipped", () => {
  const said = ["yes ready!", "the distance is 2"];
  const { keep } = chooseQuoted({
    said,
    response: "the distance is 2",
    cut: 1,
    dropDetours: true,
    ...NO_DETOURS,
  });
  assert.deepEqual(keep, ["the distance is 2"]);
});

test("a figure rescues a message the boundary would have dropped", () => {
  // A student who volunteers the answer before being asked keeps it.
  const said = ["i think its 7/6 already", "yeah"];
  const { keep } = chooseQuoted({
    said,
    response: "7/6",
    cut: 2,
    dropDetours: true,
    ...NO_DETOURS,
  });
  assert.ok(keep.includes("i think its 7/6 already"));
});

test("the logged answer is always kept, whatever the boundary says", () => {
  const said = ["the answer is two"];
  const { keep } = chooseQuoted({
    said,
    response: "the answer is two",
    cut: 1,
    dropDetours: true,
    ...NO_DETOURS,
  });
  assert.deepEqual(keep, said);
});

test("a detour's whole exchange is skipped, not just the question", () => {
  // "yes please, that would help" — the student accepting an offered
  // souvenir — was filed as their worked answer on the routing question.
  const said = ["2 out of 10", "wait what is that called?", "yes please, that would help", "0.2"];
  const { keep } = chooseQuoted({
    said,
    response: "0.2",
    cut: 0,
    dropDetours: true,
    detourSpans: [[1, 2]],
    detourAsked: new Set([normMsg("wait what is that called?")]),
  });
  assert.deepEqual(keep, ["2 out of 10", "0.2"]);
});

test("an answer given BEFORE the detour survives it", () => {
  // A span, not a new window start: anything that moved the window forward to
  // the detour would take every earlier answer with it.
  const said = ["2 out of 10", "wait what is that called?", "ok thanks"];
  const { keep } = chooseQuoted({
    said,
    response: "2 out of 10",
    cut: 0,
    dropDetours: true,
    detourSpans: [[1, 2]],
    detourAsked: new Set([normMsg("wait what is that called?")]),
  });
  assert.ok(keep.includes("2 out of 10"));
});

test("the note never falls through to the model's own wording", () => {
  // If every narrowing empties the window, they give way — newest first.
  const said = ["hello? are you still there?"];
  const r = chooseQuotedWithFallback({
    said,
    response: "the model's paraphrase",
    cut: 1,
    dropDetours: true,
    ...NO_DETOURS,
  });
  assert.deepEqual(r.keep, said);
  assert.equal(r.cutUsed, 0);
});

// ---------------------------------------------------------------------------
// fillSlots
// ---------------------------------------------------------------------------

test("an unfilled slot renders the placeholder, not the previous fill", () => {
  const out = fillSlots("A: «one» B: «two»", ["x"], "");
  assert.equal(out, "A: x B: *(not answered)*");
});

test("the fallback is spent once, never printed twice in one line", () => {
  // "**My guess:** way off, i said 20 — "way off, i said 20"" is what the
  // second use looked like.
  const out = fillSlots("«a» — «b»", [], "way off, i said 20");
  assert.equal(out, "way off, i said 20 — *(not answered)*");
});

test("a whitespace pad does not count as a fill", () => {
  assert.equal(fillSlots("«a»", ["   "], ""), "*(not answered)*");
});

test("slotMarkers finds the markers in order", () => {
  assert.deepEqual(slotMarkers("> «their pick» — «their line, verbatim»"), [
    "«their pick»",
    "«their line, verbatim»",
  ]);
});

// ---------------------------------------------------------------------------
// withQuotedQuestion
// ---------------------------------------------------------------------------

test("the question is not quoted twice when the cell already has it", () => {
  // A byte-exact test once called a cell unquoted because the quote had
  // typographic apostrophes, and the cell then carried "You asked" twice.
  const md = "### 🧭 Detour\n\n> 🧭 **You asked:** “whats a triangle?”\n\nAnswer.";
  assert.equal(withQuotedQuestion(md, "what's a triangle?"), md);
});

test("the quote goes under a leading heading, not above it", () => {
  const out = withQuotedQuestion("### 🧭 Detour\n\nAnswer.", "why?");
  assert.match(out.split("\n")[0], /^### /);
  assert.match(out.split("\n")[2], /You asked/);
});

// ---------------------------------------------------------------------------
// checkpoint ids
// ---------------------------------------------------------------------------

test("a doubled _extra suffix still resolves to its base", () => {
  assert.equal(baseCheckpointId("cp0_welcome_extra_extra"), "cp0_welcome");
});

test("a hyphen for an underscore snaps back onto the script", () => {
  const order = ["cp2_distance", "cp3_clustering"];
  assert.deepEqual(snapCheckpointId("cp3-clustering", order), {
    id: "cp3_clustering",
    snappedFrom: "cp3-clustering",
  });
});

test("a practice round keeps its suffix through the snap", () => {
  const order = ["cp2_distance"];
  assert.equal(snapCheckpointId("cp2-distance_extra", order).id, "cp2_distance_extra");
});

test("an ambiguous near miss is not a near miss", () => {
  // Two candidates one edit away: refuse rather than pick.
  const order = ["cp4_a", "cp4_b"];
  assert.deepEqual(snapCheckpointId("cp4_c", order), { id: "cp4_c" });
});

test("an id for a genuinely different checkpoint is left alone", () => {
  const order = ["cp2_distance", "cp3_clustering"];
  assert.deepEqual(snapCheckpointId("cp9_nonsense", order), { id: "cp9_nonsense" });
});

test("editDistanceAtMost", () => {
  assert.equal(editDistanceAtMost("abc", "abd", 1), true);
  assert.equal(editDistanceAtMost("abc", "aXY", 1), false);
  assert.equal(editDistanceAtMost("abc", "abcd", 1), true);
});

// ---------------------------------------------------------------------------
// dialog sentinels
// ---------------------------------------------------------------------------

test("the package's own sentences are never stored as the student's", () => {
  // Stored, they printed in the submitted record as the student's own
  // *You chose:* line.
  assert.equal(isDialogSentinel("User declined to answer questions"), true);
  assert.equal(isDialogSentinel("User wants to chat about this. Continue…"), true);
  assert.equal(isDialogSentinel("(no input)"), true);
  assert.equal(isDialogSentinel("about 20"), false);
});

test("bigramDice is bounded and symmetric", () => {
  assert.equal(bigramDice("hello", "hello"), 1);
  assert.equal(bigramDice("", "hello"), 0);
  assert.equal(bigramDice("abc", "cba"), bigramDice("cba", "abc"));
});

test("slotTokens folds every dash the same way", () => {
  assert.deepEqual(slotTokens("A–D"), slotTokens("A-D"));
});

// ---------------------------------------------------------------------------
// matchDetourQuestion  (the 6fecbce bug, and the two it must not re-open)
// ---------------------------------------------------------------------------

test("the index and the quoted message always come from the same place", () => {
  // The span used to be located with a fresh findIndex over the same text
  // (6fecbce), which can land on an earlier copy and stretch the span back
  // over answers the student had already given. One lookup, one index.
  const said = ["why does that matter?", "2 out of 10", "why does that matter?"];
  const m = matchDetourQuestion("why does that matter?", said);
  assert.equal(normMsg(said[m.index]), normMsg(m.question));
  assert.equal(m.isDetour, true);
});

test("an answer that merely contains a wh-word is not a detour question", () => {
  // "clustering is how often my friends know each other" scores 0.78 against
  // "how often do friends know each other" and contains "how".
  const said = ["clustering is how often my friends know each other"];
  const m = matchDetourQuestion("how often do friends know each other", said);
  assert.equal(m.isDetour, false);
});

test("a message that answers AND asks keeps its answer", () => {
  // "i count 2" is half an answer on the checkpoint that was about counting.
  const said = ["how many could there be? i count 2"];
  const m = matchDetourQuestion("how many could there be?", said);
  assert.equal(m.isDetour, false);
});

test("a hedging lead-in does not make the message an answer", () => {
  const said = ["wait, quick question before I do the average — does it matter which direction?"];
  const m = matchDetourQuestion("does it matter which direction?", said);
  assert.equal(m.isDetour, true);
  // The souvenir quotes their whole message, lead-in and all.
  assert.equal(m.question, said[0]);
});

test("nothing matches an empty transcript", () => {
  assert.deepEqual(matchDetourQuestion("why?", []), {
    index: -1,
    question: "why?",
    isDetour: false,
  });
});

// ---------------------------------------------------------------------------
// scriptedQuestionCount
// ---------------------------------------------------------------------------

test("a lettered sub-step is its own question", () => {
  // A script that splits a step in two — ask, then invite the self-check box
  // in the student's own beat — asks one more thing than its top-level
  // numbering says. The late-close gate compares this against how many
  // messages the student sent, so a miscount nudges a tutor that did exactly
  // what the script asked.
  const ask = [
    '      1. "Set k to 2. Can two of node 0\'s friends ever know each other?"',
    '      2. "Now set k to 4. Which friendships ALREADY exist?"',
    "      2b. Only once they have committed to a number: \"Now tick 'check my",
    '         count\'. Does it agree with you?"',
    '      3. "So node 0\'s clustering at k=4 is...?"',
  ].join("\n");
  assert.equal(scriptedQuestionCount(ask), 4);
});

test("an ask block that numbers nothing switches the check off", () => {
  assert.equal(scriptedQuestionCount("Ask them where the cable goes, and why."), 0);
});

test("a decimal in the prose is not a question number", () => {
  assert.equal(scriptedQuestionCount("The average was 1.17 over all six pairs."), 0);
});

// ---------------------------------------------------------------------------
// Found by the Part D gate run of 2026-08-27
// ---------------------------------------------------------------------------

test("closing a detour is not the next checkpoint's worked answer", () => {
  // From the run: the student asked a question mid-lesson, the tutor answered
  // it and called log_detour, then asked "Ready to keep going?" — and the
  // student's "yep that makes sense, lets keep going" was quoted in
  // cp2_diameter's note under "I worked out", beside their real answer.
  //
  // detourSpans cannot reach it: the span is closed at log_detour time, and
  // this message came after. It is the same shape as the cp1_routing failure
  // ACK_WORDS was grown for — a whole turn answering the tutor's own offer —
  // and the only word in it that was not already an acknowledgement is "that".
  assert.equal(isFillerMessage("yep that makes sense, lets keep going"), true);
});

test("adding 'that' does not swallow the answers ACK_WORDS was burned on", () => {
  // The comment on ACK_WORDS records `this`/`that`/`one` being added once and
  // deleting half a real answer: "this one", answering "which of the two
  // worlds do you live in?". Every word must be an acknowledgement for a
  // message to be dropped, and `one` and `this` stay out, so these survive.
  assert.equal(isFillerMessage("this one"), false);
  assert.equal(isFillerMessage("that one"), false);
  assert.equal(isFillerMessage("thats the one"), false);
  assert.equal(isFillerMessage("that world"), false);
});

test("a photo-only checkpoint does not put the model's words in their fold", () => {
  // cp2_paperwork, from the same run: the student uploaded a page and typed
  // nothing, so the «verbatim» slot fell through to student_response — a
  // parenthetical the MODEL wrote — inside a fold headed "My work".
  const response = "(photo of hand-worked table: 5-ring, all 10 pairs, sum 15, average 1.5)";
  assert.equal(verbatimFill([], response, { photoAnswered: true }), "*(answered on paper — the photo is above)*");
});

test("with nothing typed and no photo, the fallback is unchanged", () => {
  assert.equal(verbatimFill([], "their answer", {}), "their answer");
});

test("anything they typed still wins", () => {
  assert.equal(
    verbatimFill(["i put it there because"], "x", { photoAnswered: true }),
    '"i put it there because"',
  );
});
