import { test } from "node:test";
import assert from "node:assert/strict";

import { announcesClose, callsReferee, revealSaid } from "../extensions/lib/turns.ts";

test("the live case: the close said, not done", () => {
  assert.ok(announcesClose("You had it. The checkpoint closes now."));
  assert.ok(announcesClose("That's it — this one is done."));
  assert.ok(announcesClose("Checkpoint complete."));
});

test("ordinary tutoring never matches", () => {
  assert.equal(announcesClose("Close — but not quite."), false);
  assert.equal(announcesClose("Which of those two told igraph there are seven?"), false);
  assert.equal(announcesClose("Run the cell whenever you are ready."), false);
  assert.equal(announcesClose("You closed the paren on line 3."), false);
  // A promise about the next turn, and a turn still asking: both wait.
  assert.equal(announcesClose("Say that back to me in your own words, and the checkpoint closes."), false);
  assert.equal(announcesClose("Once the checkpoint is done we move on. What is n?"), false);
});

test("the student's word for the referee", () => {
  assert.ok(callsReferee("call a judge"));
  assert.ok(callsReferee("/judge"));
  assert.ok(callsReferee("Judge please"));
  assert.ok(callsReferee("can the referee look at this"));
  assert.ok(callsReferee("ジャッジを呼んで"));
  assert.equal(callsReferee("my judgement was that n is 7"), false);
  assert.equal(callsReferee("I think the answer is 0.5"), false);
});

test("m03's reveal, said the turn before the questions check", () => {
  const reveal =
    "Say ONLY the ➤ lines. The rest is the note cell's.\n" +
    "➤ A network is two lists: its nodes and its edges. `n` sets the\n" +
    "nodes, so a node with no edges still exists.\n";
  const said = [
    "Your code asks g for its size instead of typing 7.",
    "A network is two lists: its nodes and its edges. n sets the nodes, so a node with no edges still exists.\n\nDo you have any questions about this exercise before we move on?",
  ];
  assert.ok(revealSaid(reveal, said));
  assert.ok(revealSaid(reveal, ["➤ A network is two lists — its nodes and its edges."]));
  assert.equal(revealSaid(reveal, ["Do you have any questions about this exercise before we move on?"]), false);
  assert.equal(revealSaid(reveal, []), false);
});
