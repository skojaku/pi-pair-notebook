/**
 * The notebook name is now a decision, and the cost of getting it wrong is
 * asymmetric: a tutored module that stops finding `notebook.py` loses fifty
 * graded sessions, and a mini-project that finds nothing loses an afternoon.
 * So every rule in lib/notebook-target.ts has a case here, and the first two
 * are the ones that must never change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chooseNotebook,
  DEFAULT_NOTEBOOK,
  findNotebooks,
  isMarimoNotebook,
  isScannableNotebook,
  type NotebookIO,
  safeNotebookPath,
} from "../extensions/lib/notebook-target.ts";

const NB = 'import marimo\n\napp = marimo.App(width="medium")\n';

/** A tree as a flat map of path -> contents; directories are the prefixes. */
function fakeDisk(files: Record<string, string>): NotebookIO {
  return {
    list(dir) {
      const seen = new Map<string, { name: string; file: boolean; dir: boolean }>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(`${dir}/`)) continue;
        const rest = p.slice(dir.length + 1);
        const cut = rest.indexOf("/");
        const name = cut === -1 ? rest : rest.slice(0, cut);
        seen.set(name, { name, file: cut === -1, dir: cut !== -1 });
      }
      return [...seen.values()];
    },
    head: (file) => files[file] ?? "",
  };
}

test("a module folder is notebook.py, whatever else is lying around", () => {
  const c = chooseNotebook({
    hasDefault: true,
    found: ["notebook.py", "notebook.golden.py", "tools/build_golden.py"],
  });
  assert.equal(c.file, DEFAULT_NOTEBOOK);
  assert.equal(c.from, "default");
});

test("nothing found at all still answers notebook.py", () => {
  const c = chooseNotebook({ hasDefault: false });
  assert.equal(c.file, DEFAULT_NOTEBOOK);
  assert.equal(c.from, "fallback");
  assert.equal(c.alternatives, undefined);
});

test("one notebook in the folder needs no configuration", () => {
  const c = chooseNotebook({ hasDefault: false, found: ["mini-project.py"] });
  assert.equal(c.file, "mini-project.py");
  assert.equal(c.from, "found");
});

test("two notebooks decide nothing, and say what they were", () => {
  const c = chooseNotebook({
    hasDefault: false,
    found: ["mini-project.py", "scratch.py"],
  });
  assert.equal(c.file, DEFAULT_NOTEBOOK);
  assert.deepEqual(c.alternatives, ["mini-project.py", "scratch.py"]);
});

test("the env var wins over everything, including a real notebook.py", () => {
  const c = chooseNotebook({
    env: "assignment/mini-project.py",
    config: "other.py",
    hasDefault: true,
    found: ["notebook.py"],
  });
  assert.equal(c.file, "assignment/mini-project.py");
  assert.equal(c.from, "env");
});

test("the repository's own file wins over the default name", () => {
  const c = chooseNotebook({ config: "mini-project.py", hasDefault: true });
  assert.equal(c.file, "mini-project.py");
  assert.equal(c.from, "config");
});

test("a refused configured path falls through rather than stopping the session", () => {
  for (const bad of ["/etc/passwd", "../../secrets.py", "notes.md", "  ", 7, null]) {
    const c = chooseNotebook({ env: bad, hasDefault: true });
    assert.equal(c.file, DEFAULT_NOTEBOOK, `${String(bad)} should not have been taken`);
  }
});

test("safeNotebookPath tidies what it accepts", () => {
  assert.equal(safeNotebookPath("./mini-project.py"), "mini-project.py");
  assert.equal(safeNotebookPath("  assignment/nb.py  "), "assignment/nb.py");
  assert.equal(safeNotebookPath("assignment\\nb.py"), "assignment/nb.py");
  assert.equal(safeNotebookPath("C:\\Users\\nb.py"), undefined);
  assert.equal(safeNotebookPath("a/../../b.py"), undefined);
});

test("a marimo notebook is the generated App line, and a cell body is not", () => {
  assert.equal(
    isMarimoNotebook('import marimo\n\napp = marimo.App(width="medium")\n'),
    true,
  );
  assert.equal(isMarimoNotebook("_app = marimo.App()\n"), true);
  // cells/cp1_map.py — a body the tutor inserts, never a notebook
  assert.equal(isMarimoNotebook('# describe: the map\nmo.md("hello")\n'), false);
  assert.equal(isMarimoNotebook("import marimo as mo\n"), false);
});

test("the walk finds the one notebook in a mini-project clone", () => {
  const io = fakeDisk({
    "/r/mini-project.py": NB,
    "/r/README.md": "# team",
    "/r/pair-notebook.json": "{}",
    "/r/__marimo__/session/mini-project.py.json": "{}",
  });
  assert.deepEqual(findNotebooks("/r", io), ["mini-project.py"]);
});

test("the walk reaches assignment/ and stops there", () => {
  const io = fakeDisk({
    "/r/assignment/assignment.py": NB,
    "/r/assignment/deep/deeper.py": NB,
    "/r/node_modules/pkg/thing.py": NB,
    "/r/.venv/lib/other.py": NB,
  });
  assert.deepEqual(findNotebooks("/r", io), ["assignment/assignment.py"]);
});

test("the walk offers neither the template nor the golden", () => {
  const io = fakeDisk({
    "/r/notebook.template.py": NB,
    "/r/notebook.golden.py": NB,
    "/r/build.py": "print('not a notebook')\n",
  });
  assert.deepEqual(findNotebooks("/r", io), []);
});

test("the scan never offers the template or an answer key", () => {
  assert.equal(isScannableNotebook("mini-project.py"), true);
  assert.equal(isScannableNotebook("notebook.template.py"), false);
  assert.equal(isScannableNotebook("notebook.golden.py"), false);
  assert.equal(isScannableNotebook("notebook.golden.build.py"), false);
  assert.equal(isScannableNotebook(".hidden.py"), false);
  assert.equal(isScannableNotebook("README.md"), false);
});
