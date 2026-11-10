import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { skipsQuestionAfterPass } from "../extensions/lib/pace.ts";

describe("skipsQuestionAfterPass", () => {
  test("a clean pass skips the stop when the module says so", () => {
    assert.equal(skipsQuestionAfterPass("when_hinted", "pass", 0), true);
  });
  test("a pass with a hint, or a guided one, keeps it", () => {
    assert.equal(skipsQuestionAfterPass("when_hinted", "pass_with_hints", 1), false);
    assert.equal(skipsQuestionAfterPass("when_hinted", "pass", 1), false);
    assert.equal(skipsQuestionAfterPass("when_hinted", "guided", 0), false);
  });
  test("no setting, or another value, keeps it for everyone", () => {
    assert.equal(skipsQuestionAfterPass(undefined, "pass", 0), false);
    assert.equal(skipsQuestionAfterPass("always", "pass", 0), false);
  });
});
