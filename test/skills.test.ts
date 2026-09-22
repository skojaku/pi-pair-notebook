/**
 * The last twenty centimetres.
 *
 * Skills were written once, by an installer that runs before pi exists, so a
 * skill added afterwards sat on the student's disk (the update channel put it
 * there) and never reached ~/.pi/agent/skills. These tests are about the two
 * halves of closing that: everything ours moves, and nothing that is not ours
 * is touched — the second half runs inside a student's home directory, where
 * a wrong delete is not recoverable from a terminal they can use.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

import { OWNED_MARKER, syncSkills } from "../extensions/lib/skills.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let src: string;
let dst: string;
let n = 0;

beforeEach(() => {
  src = path.join(ROOT, `src-${++n}`);
  dst = path.join(ROOT, `dst-${n}`);
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dst, { recursive: true });
});

function skill(name: string, body = "Do the thing.") {
  return `---\nname: ${name}\ndescription: what ${name} is for.\n---\n\n${body}\n`;
}

function ship(name: string, body?: string) {
  fs.mkdirSync(path.join(src, name), { recursive: true });
  fs.writeFileSync(path.join(src, name, "SKILL.md"), skill(name, body));
}

function installed(name: string) {
  return fs.readFileSync(path.join(dst, name, "SKILL.md"), "utf8");
}

describe("syncSkills", () => {
  test("a skill added to the package reaches a student who set up months ago", () => {
    ship("closing-a-checkpoint");
    const report = syncSkills(src, dst);
    assert.deepEqual(report.added, ["closing-a-checkpoint"]);
    assert.match(installed("closing-a-checkpoint"), /name: closing-a-checkpoint/);
  });

  test("a reworded skill is rewritten, and an unchanged one is left alone", () => {
    ship("notebook-figures", "Nodes are #3959A6.");
    syncSkills(src, dst);
    assert.deepEqual(syncSkills(src, dst).unchanged, ["notebook-figures"]);

    ship("notebook-figures", "Nodes are #3959A6. Highlights are rust.");
    const second = syncSkills(src, dst);
    assert.deepEqual(second.updated, ["notebook-figures"]);
    assert.match(installed("notebook-figures"), /rust/);
  });

  test("a rule withdrawn from the package leaves the student's machine", () => {
    ship("retracted");
    syncSkills(src, dst);
    fs.rmSync(path.join(src, "retracted"), { recursive: true });

    const report = syncSkills(src, dst);
    assert.deepEqual(report.removed, ["retracted"]);
    assert.equal(fs.existsSync(path.join(dst, "retracted")), false);
  });

  test("lecture-quiz, written unmarked by an old installer, is adopted", () => {
    // The whole fleet set up before the marker existed. Without this, the
    // sync meets its own skill, reads it as a stranger's, and never updates
    // it again — which is the exact fault the sync was written to end.
    fs.mkdirSync(path.join(dst, "lecture-quiz"), { recursive: true });
    fs.writeFileSync(path.join(dst, "lecture-quiz", "SKILL.md"), skill("lecture-quiz", "old"));
    ship("lecture-quiz", "fetch the page first");

    const report = syncSkills(src, dst);
    assert.deepEqual(report.updated, ["lecture-quiz"]);
    assert.match(installed("lecture-quiz"), /fetch the page first/);
    assert.equal(fs.existsSync(path.join(dst, "lecture-quiz", OWNED_MARKER)), true);
  });

  test("adoption is a named list, not a rule about unmarked skills", () => {
    fs.mkdirSync(path.join(dst, "closing-a-checkpoint"), { recursive: true });
    fs.writeFileSync(path.join(dst, "closing-a-checkpoint", "SKILL.md"), "theirs\n");
    ship("closing-a-checkpoint", "ours");

    const report = syncSkills(src, dst);
    assert.equal(installed("closing-a-checkpoint"), "theirs\n");
    assert.match(report.failed["closing-a-checkpoint"], /not ours/);
  });

  test("a skill we did not write is never rewritten", () => {
    // classroom-teammates is written by setup-pi.mjs and is not in this
    // package. A student may have written skills of their own.
    fs.mkdirSync(path.join(dst, "classroom-teammates"), { recursive: true });
    fs.writeFileSync(path.join(dst, "classroom-teammates", "SKILL.md"), "theirs\n");
    ship("classroom-teammates", "ours");

    const report = syncSkills(src, dst);
    assert.equal(installed("classroom-teammates"), "theirs\n");
    assert.match(report.failed["classroom-teammates"], /not ours/);
  });

  test("a skill we did not write is never deleted", () => {
    fs.mkdirSync(path.join(dst, "someones-own"), { recursive: true });
    fs.writeFileSync(path.join(dst, "someones-own", "SKILL.md"), "mine\n");

    const report = syncSkills(src, dst);
    assert.deepEqual(report.removed, []);
    assert.equal(fs.existsSync(path.join(dst, "someones-own", "SKILL.md")), true);
  });

  test("a missing skills/ withdraws nothing", () => {
    // A packaging slip and a deliberate withdrawal of everything look
    // identical from here. Only one of the two readings is recoverable from a
    // student's terminal, so the source directory going missing must be inert.
    ship("keep-me");
    syncSkills(src, dst);
    fs.rmSync(src, { recursive: true });

    const report = syncSkills(src, dst);
    assert.deepEqual(report.removed, []);
    assert.equal(fs.existsSync(path.join(dst, "keep-me", "SKILL.md")), true);
  });

  test("a file with no frontmatter name is not a skill", () => {
    fs.mkdirSync(path.join(src, "broken"), { recursive: true });
    fs.writeFileSync(path.join(src, "broken", "SKILL.md"), "# just a heading\n");

    const report = syncSkills(src, dst);
    assert.deepEqual(report.added, []);
    assert.match(report.failed["broken"], /frontmatter/);
    assert.equal(fs.existsSync(path.join(dst, "broken")), false);
  });

  test("only plain lowercase names are ever turned into a path", () => {
    // Each of these becomes a directory under the student's HOME. readdir
    // cannot hand back a name containing a separator, so the guard is not
    // about "../" — it is about refusing to build a home-directory path out
    // of whatever a malformed or hostile package happens to contain.
    for (const odd of ["..evil", "Uppercase", "has space", ".hidden", "-leading"]) {
      fs.mkdirSync(path.join(src, odd), { recursive: true });
      fs.writeFileSync(path.join(src, odd, "SKILL.md"), skill("odd"));
    }
    ship("normal");

    const report = syncSkills(src, dst);
    assert.deepEqual(report.added, ["normal"]);
    assert.deepEqual(fs.readdirSync(dst), ["normal"]);
  });

  test("the marker is what licenses a rewrite, and it survives one", () => {
    ship("owned");
    syncSkills(src, dst);
    assert.equal(fs.existsSync(path.join(dst, "owned", OWNED_MARKER)), true);
    ship("owned", "reworded");
    syncSkills(src, dst);
    assert.equal(fs.existsSync(path.join(dst, "owned", OWNED_MARKER)), true);
    assert.match(installed("owned"), /reworded/);
  });

  test("an interrupted write leaves no temp file behind", () => {
    ship("tidy");
    syncSkills(src, dst);
    ship("tidy", "again");
    syncSkills(src, dst);
    const left = fs.readdirSync(path.join(dst, "tidy")).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(left, []);
  });

  test("one bad skill does not stop the good ones", () => {
    ship("good-one");
    fs.mkdirSync(path.join(src, "bad-one"), { recursive: true });
    fs.writeFileSync(path.join(src, "bad-one", "SKILL.md"), "no frontmatter\n");
    ship("good-two");

    const report = syncSkills(src, dst);
    assert.deepEqual(report.added.sort(), ["good-one", "good-two"]);
    assert.ok(report.failed["bad-one"]);
  });
});
