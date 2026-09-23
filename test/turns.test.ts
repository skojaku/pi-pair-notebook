import { test } from "node:test";
import assert from "node:assert/strict";

import { announcesClose } from "../extensions/lib/turns.ts";

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
