/**
 * Does a pass go straight on to the next checkpoint, without the "any
 * questions?" stop?
 *
 * `"ask_after_pass": "when_hinted"` in a module's lesson/index.json says yes
 * for a checkpoint passed with no hint. Anything else, or a missing key, keeps
 * the stop after every pass. A pass that needed help always keeps it.
 */
export function skipsQuestionAfterPass(setting: unknown, judgment: string, hints: number): boolean {
  return setting === "when_hinted" && judgment === "pass" && hints === 0;
}
