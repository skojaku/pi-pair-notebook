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
  capturePick,
  driftIsReportable,
  handoffCutPoint,
  editDistanceAtMost,
  isDialogSentinel,
  isFigure,
  isFillerMessage,
  matchDetourQuestion,
  normMsg,
  renderNoteSkeleton,
  notebookBanner,
  answerCountForGate,
  pickIsMechanics,
  quoteIsBacked,
  rewriteRivalServer,
  souvenirVerdict,
  withQuotedQuestion,
  STUCK_ANSWERS,
  stripModelQuoteLines,
  scriptedQuestionCount,
  slotDrift,
  slotTokens,
  snapCheckpointId,
  snapToTranscript,
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

/**
 * The real shape, copied from a live session file:
 *   details.answers[] = {questionIndex, question, kind, answer}
 * The `question` is what tells a prediction about seven bridges from "did the
 * page open?", and capturePick used to throw it away.
 */
const dialog = (answer: string, question = "") => ({
  toolName: "ask_user_question",
  details: { answers: [{ questionIndex: 0, question, kind: "option", answer }] },
});

/** What the dialog package hands back when nothing structured is attached. */
const envelope = (question: string, answer: string) => ({
  toolName: "ask_user_question",
  content: [
    {
      type: "text",
      text: `User has answered your questions: "${question}"="${answer}". You can now continue with the user's answers in mind.`,
    },
  ],
});

test("a lesson pick is stored", () => {
  const r = capturePick(dialog("no, it's impossible"), false);
  assert.equal(r.picked, "no, it's impossible");
  assert.equal(r.resumeAnswered, false);
  assert.deepEqual(r.picks, [
    { question: "", answer: "no, it's impossible", mechanics: false },
  ]);
});

test("a tool that is not the dialog contributes nothing", () => {
  assert.equal(capturePick({ toolName: "nb_add_cell" }, false).picked, null);
});

test("the resume choice is kept out of the record, and disarms the flag", () => {
  // Both labels the resume brief tells the model to use, word for word.
  for (const label of ["Continue where we left off", "Start fresh"]) {
    assert.deepEqual(capturePick(dialog(label), true), {
      picks: [],
      picked: null,
      resumeAnswered: true,
    });
  }
});

test("the same words are a real answer once the resume is behind us", () => {
  // The flag is what makes them mechanics; the words alone must not be.
  assert.equal(capturePick(dialog("Start fresh"), false).picked, "Start fresh");
});

test("a dismissed dialog is not an answer", () => {
  assert.equal(capturePick(dialog("User declined to answer questions"), false).picked, null);
  // And it does not answer the resume question either, so the flag stays armed
  // — clearing it here stored the RE-ASKED continue-or-fresh answer instead.
  assert.equal(capturePick(dialog("User declined to answer questions"), true).resumeAnswered, false);
});

test("the envelope sentence is stripped down to the answer", () => {
  assert.equal(
    capturePick(envelope("How do you feel about Python?", "tried a little"), false).picked,
    "tried a little",
  );
});

test("an answer containing its own quotation marks survives the envelope", () => {
  assert.equal(
    capturePick(envelope("What did they call it?", 'the "geometry of position"'), false).picked,
    'the "geometry of position"',
  );
});

test("a mechanics dialog the tutor improvised does not become the student's prediction", () => {
  // maleynet, m01, 2026-08-25. The notebook had not opened; they typed "can
  // we restart? i did not see the browser open", the tutor improvised a
  // picker, and its answer was filed in cp1_bridges' student_picked beside
  // their actual guess:
  //
  //   "student_picked": ["Yes, but only from the right starting point",
  //                      "Found it — I can see the city now"]
  //
  // Nothing about this dialog is a lesson answer, and no blacklist of ANSWERS
  // could ever have known: the tutor improvised the words. The question is
  // what gives it away.
  const r = capturePick(
    dialog("Found it — I can see the city now", "Did the notebook page open in your browser?"),
    false,
  );
  assert.equal(r.picked, null, "it must not be filed as a lesson answer");
  assert.deepEqual(
    r.picks.map((p) => p.mechanics),
    [true],
  );
});

test("a mechanics pick is kept, not dropped", () => {
  // "Found it — I can see the city now" is the best evidence in that whole
  // submission that the notebook never opened by itself. It belongs in the
  // record — just not as an answer to the bridge puzzle.
  const r = capturePick(
    dialog("Found it — I can see the city now", "Can you see the page now, or is it blank?"),
    false,
  );
  assert.equal(r.picks.length, 1);
  assert.equal(r.picks[0].answer, "Found it — I can see the city now");
});

test("a lesson question that mentions the apparatus is still a lesson question", () => {
  // Every one of these is a shape this course really asks. Filing one as
  // machinery would take the student's own answer out of student_picked and
  // out of the *You chose:* line in the notebook they submit — the expensive
  // direction, and the reason the classifier fails open.
  for (const q of [
    "Look at your notebook — does the walk work?",
    "Does the graph on your screen show a triangle?",
    "Can you find a route on the page that crosses every bridge once?",
    "Königsberg has seven bridges. Do you think a walk exists that crosses each one exactly once?",
    "How many lines do you have to walk along to get from A to B?",
    "Open the picture in your notebook — which dot has the most lines?",
    "In the notebook, is the new drawing the same shape as the old one?",
    "Look at the whiteboard — did the pattern change?",
    "Should we restart the counting from a different dot?",
    "Now that the picture has appeared, what do you notice about the dots?",
  ]) {
    assert.equal(pickIsMechanics(q, "yes"), false, q);
  }
});

test("the apparatus questions are machinery", () => {
  for (const q of [
    "Did the notebook page open in your browser?",
    "Is the page blank, or can you see the city?",
    "Did the browser tab load?",
    "Shall we restart the terminal?",
    "Can you see the notebook now, or is it still blank?",
    "Is the notebook open in your browser?",
  ]) {
    assert.equal(pickIsMechanics(q, "yes"), true, q);
  }
});

test("a figure in the exchange keeps it a lesson answer", () => {
  // Whatever the wording, an exchange carrying a number carried graded
  // content: "about 20" is the answer that refused cp1's honest record twice
  // when picks were left out of the pool.
  assert.equal(pickIsMechanics("Did the page open with all 7 bridges?", "yes"), false);
  assert.equal(pickIsMechanics("Did the page open?", "yes, all 7 are there"), false);
});

test("with no question there is nothing to judge, so it stays a lesson answer", () => {
  assert.equal(capturePick(dialog("Found it — I can see the city now"), false).picked, "Found it — I can see the city now");
});

test("the envelope's question is used too, not just thrown away", () => {
  const r = capturePick(
    envelope("Did the notebook page open in your browser?", "yes, I see it now"),
    false,
  );
  assert.equal(r.picked, null);
  assert.equal(r.picks[0].question, "Did the notebook page open in your browser?");
});

test("a two-question dialog splits into two records", () => {
  const r = capturePick(
    {
      toolName: "ask_user_question",
      details: {
        answers: [
          { questionIndex: 0, question: "Did the page open?", kind: "option", answer: "yes" },
          {
            questionIndex: 1,
            question: "Do you think such a walk exists?",
            kind: "option",
            answer: "no, it's impossible",
          },
        ],
        cancelled: false,
      },
    },
    false,
  );
  assert.equal(r.picked, "no, it's impossible");
  assert.deepEqual(
    r.picks.map((p) => p.mechanics),
    [true, false],
  );
});

// ---------------------------------------------------------------------------
// quoteIsBacked — a "You asked" line the student never said
// ---------------------------------------------------------------------------

test("a question composed by the model is not backed", () => {
  // maleynet, m01, notebook.py:1405. The souvenir reads
  //   > 🧭 **You asked:** "Wait no we would visit twice more because 4 is
  //     even... Odd numbers pair off to one extra, that means one extra visit,
  //     so three visits total?"
  // and the whole capture window for that detour is these five messages. Not
  // one of them is that sentence.
  const said = [
    "A repeats a street\nB repeats a stop\nC repeats nada",
    "need all to have even degree",
    "C repeats nothing, but it misses 2 streets.",
    "B, however it also misses a street.",
    "None of them cross every bridge once. Not A,B, or C. Are you asking about the eulerian definitions? Do you mean an Euler trail?",
  ];
  assert.equal(
    quoteIsBacked(
      "Wait no we would visit twice more because 4 is even... Odd numbers pair off to one extra, that means one extra visit, so three visits total?",
      said,
    ),
    false,
  );
});

test("their own words are backed, punctuation and all", () => {
  const said = ["whats this called again", "ok so, is a trail the same as a circuit?"];
  assert.equal(quoteIsBacked("is a trail the same as a circuit?", said), true);
  assert.equal(quoteIsBacked("whats this called again", said), true);
});

test("a dialog answer backs a quote as much as a typed message does", () => {
  // A dialog takes over the keyboard, so a question typed into one never
  // reaches the transcript. Leaving picks out of a pool has refused honest
  // records here twice.
  assert.equal(quoteIsBacked("is it about 20", ["hmm", "is it about 20"]), true);
});

test("with nothing to check against, the check stands down", () => {
  // A transcript we cannot read must never accuse.
  assert.equal(quoteIsBacked("anything at all", []), true);
  assert.equal(quoteIsBacked("anything at all", ["", "  "]), true);
});

test("a script normMsg cannot see is not called a fabrication", () => {
  // normMsg strips every non-ASCII character, so this would normalise to ""
  // on both sides. It must stand down rather than suppress every quote in a
  // session typed in Japanese.
  assert.equal(quoteIsBacked("オイラー路ってなに？", ["こんにちは", "オイラー路ってなに？"]), true);
  assert.equal(quoteIsBacked("これはなんですか", ["こんにちは"]), true);
});

// ---------------------------------------------------------------------------
// stripModelQuoteLines — the quote line is not the model's to write
// ---------------------------------------------------------------------------

test("an unbacked You asked line is taken out of a cell body", () => {
  const code = [
    'mo.md(r"""',
    "> 🧭 **You asked:** “so three visits total?”",
    "",
    "Here is the idea.",
    '""")',
  ].join("\n");
  const r = stripModelQuoteLines(code);
  assert.deepEqual(r.removed, ["so three visits total?"]);
  assert.ok(!r.code.includes("You asked"));
  assert.ok(r.code.includes("Here is the idea."));
  assert.equal((r.code.match(/"""/g) ?? []).length, 2);
});

test("a BACKED but shortened quote is taken out too", () => {
  // m02, live. The student typed the whole sentence; the model quoted two
  // thirds of it. Containment says "backed", so an unbacked-only rule leaves
  // it — and then the extension finds no match for the full message, prepends
  // the correct quote, and the souvenir carries the question twice: once
  // whole, once with "i keep mixing them up" missing.
  const code =
    'mo.md(r"""🧭 **Detour**\n\nYou asked: *"whats the difference between an average and a median hop count?"*\n\nFive letters took 2, 3, 4, 4 and 12 hops.""")';
  const r = stripModelQuoteLines(code);
  assert.deepEqual(r.removed, ["whats the difference between an average and a median hop count?"]);
  assert.ok(!r.code.includes("You asked"));
  assert.ok(r.code.includes("Five letters"));
});

test("the quote is removed as a SEGMENT, so the delimiters survive", () => {
  // THE shape that matters, and the one a line-based strip cannot touch: the
  // marker and the closing `"""` share a line.
  for (const code of [
    'mo.md(r"""> 🧭 **You asked:** “never said this”""")',
    'mo.vstack([mo.md(r"""> 🧭 **You asked:** “never said this”\n\nthe idea"""), netviz(e)])',
  ]) {
    const r = stripModelQuoteLines(code);
    assert.deepEqual(r.removed, ["never said this"]);
    assert.ok(!r.code.includes("You asked"), r.code);
    assert.equal((r.code.match(/"""/g) ?? []).length, (code.match(/"""/g) ?? []).length);
    assert.ok(r.code.startsWith("mo."), r.code);
  }
});

test("a cell with no quote line is returned untouched", () => {
  const code = 'mo.vstack([mo.md(r"""### Detour\n\nThe idea."""), netviz(e)])';
  assert.deepEqual(stripModelQuoteLines(code), { code, removed: [] });
});

test("the model's own wording of the quote line is caught too", () => {
  // From a live m01 run: `You asked: *"…"*` — no 🧭, emphasis instead of bold.
  const code = 'mo.md(r"""### Detour\n\nYou asked: *"so three visits total?"*\n\nHere is why.""")';
  const r = stripModelQuoteLines(code);
  assert.deepEqual(r.removed, ["so three visits total?"]);
  assert.ok(r.code.includes("Here is why."));
});

// ---------------------------------------------------------------------------
// souvenirVerdict — both faults, not the first one
// ---------------------------------------------------------------------------

test("a prose-only souvenir no longer hides an unquoted one", () => {
  // xi-io's detour_terminology and detour_trail_circuit: markdown tables, so
  // `shows` is false, so `gap` said "is prose only" and the missing quote was
  // never mentioned anywhere — not in the bounce, not on the row.
  const v = souvenirVerdict({ missing: false, proseOnly: true, unquoted: true });
  assert.match(v.gap, /never quotes the question/);
  assert.match(v.gap, /prose only/);
  // The quote clause comes first: being second is how it got swallowed.
  assert.ok(v.gap.indexOf("never quotes") < v.gap.indexOf("prose only"));
});

test("a missing cell says only that", () => {
  const v = souvenirVerdict({ missing: true, proseOnly: true, unquoted: true });
  assert.equal(v.gap, "does not exist in the notebook");
});

test("a souvenir with a picture and a quote has no gap", () => {
  assert.equal(souvenirVerdict({ missing: false, proseOnly: false, unquoted: false }).gap, "");
});

// ---------------------------------------------------------------------------
// answerCountForGate — a detour's turns are not answers to the checkpoint
// ---------------------------------------------------------------------------

const gateWindow = (said: string[], spans: [number, number][]) => ({
  said,
  detourSpans: spans,
  detourAsked: new Set<string>(),
});

test("a detour taken mid-checkpoint is not counted as answers", () => {
  // The live run: four messages during cp2_abstraction, two of them a logged
  // detour. The script asks 2 questions, so the raw count of 4 tripped a
  // refusal that asked the tutor to write down hints that never happened.
  const said = [
    "the distances dont matter",
    "wait what is a multigraph?",
    "can you write that down for me",
    "just the connections then",
  ];
  assert.equal(answerCountForGate(gateWindow(said, [[1, 2]])), 2);
  // Without the span it is the old number, which is the bug.
  assert.equal(answerCountForGate(gateWindow(said, [])), 4);
});

test("the gate still fires on the close that came too late", () => {
  // The founding case: cp2_distance walked pair by pair, then the student
  // answered the NEXT checkpoint's question too, and all nine lines landed in
  // one row logged `pass` with zero hints. No detour, so nothing is subtracted.
  const said = [
    "A to B is 1", "A to C is 2", "A to D is 2", "B to C is 1", "B to D is 1",
    "C to D is 1", "so 7/6", "can you just tell me the answer?",
    "the A-D one is the tallest bar",
  ];
  assert.ok(answerCountForGate(gateWindow(said, [])) > 2);
});

test("acknowledgements are not answers the tutor asked for", () => {
  assert.equal(answerCountForGate(gateWindow(["2", "ok", "7/6"], [])), 2);
});

// ---------------------------------------------------------------------------
// The notebook's address
// ---------------------------------------------------------------------------

test("the banner carries the address and no command", () => {
  const b = notebookBanner("http://localhost:2718/?view-as=present", true);
  assert.match(b, /http:\/\/localhost:2718\/\?view-as=present/);
  // The one thing it must never do is tell a student to start the notebook.
  assert.ok(!/marimo\s+(edit|run)|pip install|uvx/.test(b));
});

test("a guessed address is not printed at all", () => {
  // marimoBase() falls back to 127.0.0.1:2718, and the port often is not that.
  assert.equal(notebookBanner("", true), "");
  assert.equal(notebookBanner("Binary file matches", true), "");
});

test("the rival-server instruction is rewritten before the student reads it", () => {
  // Measured, live: this exact advice starts a second server on :2719 while
  // the toolkit's own holds :2718.
  const said = "Open a new terminal window (not this one), and in it type:\n```\nmarimo edit notebook.py\n```\nThat will open the page.";
  const r = rewriteRivalServer(said, "http://localhost:2718/?view-as=present");
  assert.ok(!/marimo edit/.test(r.text));
  assert.match(r.text, /localhost:2718/);
  assert.deepEqual(r.hits, ["marimo edit notebook.py"]);
});

test("a rival PORT is corrected, and our own is left alone", () => {
  const r = rewriteRivalServer(
    "It printed http://localhost:2719 — open that.",
    "http://localhost:2718/?view-as=present",
  );
  assert.match(r.text, /localhost:2718/);
  assert.ok(!/2719/.test(r.text));
  const ours = rewriteRivalServer(
    "Your notebook is at http://localhost:2718/?view-as=present",
    "http://localhost:2718/?view-as=present",
  );
  assert.deepEqual(ours.hits, []);
});

test("honest prose is not touched", () => {
  // setup/setup-pi.mjs really does tell a student to open a new terminal, for
  // a good reason. Matching phrasing rather than a command is the shape of fix
  // this repo has already deleted once (NARRATES_A_BUILD, f8fe8f2).
  const ok = "Open a new terminal and re-run me.";
  assert.deepEqual(rewriteRivalServer(ok, "http://localhost:2718/?view-as=present"), {
    text: ok,
    hits: [],
  });
});

test("with no address of our own, nothing is rewritten", () => {
  const t = "run marimo edit notebook.py";
  assert.deepEqual(rewriteRivalServer(t, ""), { text: t, hits: [] });
});

test("even a word-perfect quote is the extension's to write, not the model's", () => {
  // The m01 souvenir, where the model's line WAS verbatim. It still goes: the
  // extension puts the same words back through prependQuestionToCell, and a
  // rule of "remove only the wrong ones" is what let the m02 truncation
  // through. One rule, no judgement about which copy is better.
  const code =
    'mo.md(r"""### Detour: trail vs circuit\n\nYou asked: *"whats the difference between a trail and a circuit? i keep mixing them up"*\n\n- A **trail** is a walk…""")';
  const r = stripModelQuoteLines(code);
  assert.deepEqual(r.removed, [
    "whats the difference between a trail and a circuit? i keep mixing them up",
  ]);
  assert.ok(r.code.includes("A **trail** is a walk"));
});

// ---------------------------------------------------------------------------
// mechanicsAsked — "where is my notebook" is not an answer (#12)
// ---------------------------------------------------------------------------

test("a checkpoint answered in a couple of tries is not stuck", () => {
  // The measured ratio is 2.6 assistant turns per student message, so twelve
  // turns was four or five exchanges — and an m02 review saw the ⚖️ nudge land
  // "right after the very first wrong turn".
  const said = ["is it 3?", "oh wait, 5"];
  assert.ok(
    answerCountForGate({ said, ...NO_DETOURS }) < STUCK_ANSWERS,
    "two answers must not read as stuck",
  );
});

test("six answers at one checkpoint is stuck", () => {
  const said = ["3", "4", "maybe 5", "im not sure", "6?", "7"];
  assert.ok(answerCountForGate({ said, ...NO_DETOURS }) >= STUCK_ANSWERS);
});

test("a curious student is not a stuck one", () => {
  // Two asides mid-checkpoint used to push the count toward the threshold in
  // both currencies. The detour's turns are out of it now.
  const said = ["is it 3?", "whats a multigraph?", "ah ok", "and a trail?", "got it", "its 5"];
  const detourSpans: [number, number][] = [[1, 2], [3, 4]];
  assert.ok(
    answerCountForGate({ said, detourSpans, detourAsked: new Set() }) <
      STUCK_ANSWERS,
  );
});

// ---------------------------------------------------------------------------
// renderNoteSkeleton — the note cell stopped quoting the student
// ---------------------------------------------------------------------------

test("the fold that held the student's answer is removed whole", () => {
  // m01 ch1-hook.yaml, verbatim. The toolkit ships before the lesson YAML is
  // edited, so a student on the new toolkit and an old module is the normal
  // state for a while — and «their own report of the attempt, verbatim» must
  // never render into their notebook.
  const skeleton = [
    "### The seven bridges of Königsberg",
    "Every Sunday the citizens of Königsberg set each other the same",
    "challenge. Cross all **seven bridges exactly once**, and come back to",
    "where you started.",
    "",
    "Nobody managed it, and nobody could show it was impossible.",
    "",
    "/// details | My guess, and how far I got",
    "    type: lh-answer",
    "> «their pick» — «their own report of the attempt, verbatim»",
    "///",
  ].join("\n");
  const out = renderNoteSkeleton(skeleton);
  assert.ok(!out.includes("«"), out);
  assert.ok(!out.includes("»"), out);
  // The whole fold goes: an empty collapsible titled "My guess, and how far I
  // got" is worse than no fold.
  assert.ok(!out.includes("My guess"), out);
  assert.ok(!out.includes("details"), out);
  // The instructor's prose is untouched.
  assert.ok(out.startsWith("### The seven bridges of Königsberg"));
  assert.ok(out.includes("nobody could show it was impossible"));
});

test("a fold that holds real prose keeps it", () => {
  // Only a fold whose whole body is slots is dropped. One the instructor wrote
  // content into is theirs.
  const skeleton = [
    "### Degrees",
    "",
    "/// details | Why two ends per edge",
    "    type: lh-note",
    "Every bridge has two ends, so the degrees add to twice the bridges.",
    "///",
  ].join("\n");
  assert.equal(renderNoteSkeleton(skeleton), skeleton.trim());
});

test("a fold mixing prose and a slot keeps the prose", () => {
  const skeleton = [
    "/// details | My work",
    "    type: lh-answer",
    "The rule is that every dot needs an even number of lines.",
    "> «their answer, verbatim»",
    "///",
  ].join("\n");
  const out = renderNoteSkeleton(skeleton);
  assert.ok(out.includes("every dot needs an even number of lines"));
  assert.ok(!out.includes("«"));
});

test("a stray slot outside a fold is removed without taking the line's prose", () => {
  const out = renderNoteSkeleton("You said: «their answer, verbatim» — and that is the rule.");
  assert.equal(out, "You said:  — and that is the rule.");
});

test("a skeleton with no slots is returned as it stands", () => {
  const skeleton = "### Title\n\nSome prose.\n\nMore prose.";
  assert.equal(renderNoteSkeleton(skeleton), skeleton);
});

test("removing a slot does not open a hole in the prose", () => {
  // A slot on its own line leaves a blank; two blanks read as a paragraph
  // break the instructor did not write.
  const out = renderNoteSkeleton("### T\n\nprose\n\n«their answer, verbatim»\n\nmore prose");
  assert.ok(!/\n\n\n/.test(out), JSON.stringify(out));
});

test("a slot whose instruction runs to several lines still takes its fold with it", () => {
  // cp2_paperwork, verbatim. Tested per line, `«[^»]*»` matches nothing here —
  // and three of this course's skeletons kept an empty "My work" fold in the
  // student's notebook because of it.
  const skeleton = [
    "### The paperwork",
    "",
    "/// details | My work",
    "    type: lh-answer",
    "> ",
    ">",
    '> **On paper:** «what my photo of the table shows, written as mine —',
    '  "I listed all ten pairs and got…". A photographed answer never',
    "  reaches the transcript, so this slot is yours to describe»",
    "///",
  ].join("\n");
  const out = renderNoteSkeleton(skeleton);
  assert.ok(!out.includes("«") && !out.includes("»"), out);
  assert.ok(!out.includes("My work"), out);
  assert.ok(!out.includes("On paper"), out);
  assert.equal(out, "### The paperwork");
});

// ---------------------------------------------------------------------------
// handoffCutPoint — where a chapter-boundary compaction cuts
// ---------------------------------------------------------------------------

test("the cut lands on the chapter boundary, not on pi's token budget", () => {
  // Replayed across all 92 real handoffs on one machine, pi's own cut point
  // kept the finished chapter's script alive at 40 of them; this keeps it at 0.
  const branch = [{ id: "a" }, { id: "b" }, { id: "chapter_done_turn" }];
  assert.equal(handoffCutPoint(branch, "pi-would-say-this"), "chapter_done_turn");
});

test("an empty or unreadable branch falls back to pi's cut point", () => {
  // Never worse than what pi would have done on its own.
  assert.equal(handoffCutPoint([], "pi-cut"), "pi-cut");
  assert.equal(handoffCutPoint(undefined, "pi-cut"), "pi-cut");
  assert.equal(handoffCutPoint("not a list", "pi-cut"), "pi-cut");
  assert.equal(handoffCutPoint([{ noId: true }], "pi-cut"), "pi-cut");
});
