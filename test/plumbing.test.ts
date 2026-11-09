import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { plumbingDrift, plumbingTells, repairScript } from "../extensions/lib/plumbing.ts";

const HAVE_PY = spawnSync("python3", ["--version"]).status === 0;

// The shape of a module template: a bug-report cell, then the plumbing.
const TEMPLATE = [
  "import marimo",
  "app = marimo.App()",
  "",
  "@app.cell(hide_code=True)",
  "def _(mo):",
  "    mo.md(r\"\"\"bug report\"\"\")",
  "    return",
  "",
  "",
  "@app.cell(hide_code=True)",
  "def _():",
  "    # tutor:plumbing — kept below the lesson; see the note above.",
  "    import marimo as mo",
  "    return (mo,)",
  "",
  "",
  "@app.cell(hide_code=True)",
  "def _(mo):",
  "    # tutor:plumbing — the focus-mode switch.",
  "    focus_mode = mo.ui.switch(value=True)",
  "    return (focus_mode,)",
  "",
  "",
  "@app.cell(hide_code=True)",
  "def _(mo):",
  "    # tutor:plumbing — how the exercises work.",
  '    mo.md(r"""',
  "- a line at column zero inside a string",
  '    """)',
  "    return",
  "",
  "",
  "@app.cell(hide_code=True)",
  "def _():",
  "    # tutor:plumbing — kept below the lesson; see the note above.",
  "    import numpy as np",
  "    return (np,)",
  "",
  "",
  'if __name__ == "__main__":',
  "    app.run()",
].join("\n");

// What four m05 students had: the import and the switch replaced by the
// header's own code.
const CORRUPT = TEMPLATE.replace(
  "    # tutor:plumbing — kept below the lesson; see the note above.\n    import marimo as mo\n    return (mo,)",
  '    mo.md(r"""## Finding Groups in Code""")\n    return',
).replace(
  "    # tutor:plumbing — the focus-mode switch.\n    focus_mode = mo.ui.switch(value=True)\n    return (focus_mode,)",
  '    mo.md(r"""## Finding Groups in Code""")\n    return',
);

describe("plumbingDrift", () => {
  test("the template counts its own cells", () => {
    const t = plumbingTells(TEMPLATE);
    assert.equal(t.get("# tutor:plumbing — kept below the lesson; see the note above."), 2);
    assert.equal(t.get("# tutor:plumbing — the focus-mode switch."), 1);
  });

  test("a whole notebook has no drift", () => {
    assert.deepEqual(plumbingDrift(TEMPLATE, TEMPLATE), []);
  });

  test("a notebook that gained cells has no drift", () => {
    const more = TEMPLATE.replace('if __name__', '@app.cell\ndef cp1_work(ig):\n    return\n\n\nif __name__');
    assert.deepEqual(plumbingDrift(more, TEMPLATE), []);
  });

  test("the import and the switch replaced by copies are reported", () => {
    const d = plumbingDrift(CORRUPT, TEMPLATE);
    assert.ok(d.includes("# tutor:plumbing — the focus-mode switch."));
    assert.ok(d.includes("# tutor:plumbing — kept below the lesson; see the note above."));
    assert.ok(d.includes("import marimo as mo"));
  });

  test("a prose line that mentions the tell is not a cell", () => {
    const note = "# Each cell carries `# tutor:plumbing` INSIDE its body\n" + TEMPLATE;
    assert.deepEqual(plumbingDrift(TEMPLATE, note), []);
  });
});

// A stand-in for marimo's code-mode context, enough to run the repair script
// and record what it asks for.
const STUB = `
import json, sys
from contextlib import asynccontextmanager

class Cell:
    def __init__(self, id, code, name="_"):
        self.id, self.code, self.name = id, code, name

STATE = json.load(open(sys.argv[1]))
OPS = []

class Ctx:
    def __init__(self):
        self.cells = [Cell(c["id"], c["code"], c.get("name", "_")) for c in STATE["cells"]]
    def delete_cell(self, i): OPS.append(["delete", i])
    def create_cell(self, code, hide_code=True, **kw):
        OPS.append(["create", code.split("\\n")[0]]); return "new%d" % len(OPS)
    def run_cell(self, i): OPS.append(["run", i])

@asynccontextmanager
async def get_context():
    yield Ctx()
`;

function runRepair(force: boolean, cells: { id: string; code: string; name?: string }[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plumbing-"));
  fs.mkdirSync(path.join(dir, "marimo"));
  fs.writeFileSync(path.join(dir, "marimo", "__init__.py"), "");
  fs.writeFileSync(
    path.join(dir, "marimo", "_code_mode.py"),
    STUB.replace("STATE = json.load(open(sys.argv[1]))", `STATE = json.load(open(${JSON.stringify(path.join(dir, "state.json"))}))`) +
      "\nimport atexit\natexit.register(lambda: print('OPS ' + json.dumps(OPS)))\n",
  );
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ cells }));
  fs.writeFileSync(path.join(dir, "notebook.template.py"), TEMPLATE);
  const runner =
    "import ast, asyncio, sys\n" +
    "src = open(sys.argv[1]).read()\n" +
    "code = compile(src, 'repair', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)\n" +
    "r = eval(code)\n" +
    "asyncio.run(r) if r else None\n";
  fs.writeFileSync(path.join(dir, "repair.py"), repairScript(force));
  fs.writeFileSync(path.join(dir, "run.py"), runner);
  const r = spawnSync("python3", ["run.py", "repair.py"], { cwd: dir, encoding: "utf-8", env: { ...process.env, PYTHONPATH: dir } });
  const lines = r.stdout.trim().split("\n");
  const ops = JSON.parse(lines.find((l) => l.startsWith("OPS "))!.slice(4));
  return { verdict: lines[0], ops, stderr: r.stderr };
}

const LIVE_OK = [
  { id: "a", code: 'mo.md(r"""bug report""")' },
  { id: "b", code: "# tutor:plumbing — kept below the lesson; see the note above.\nimport marimo as mo" },
  { id: "c", code: "# tutor:plumbing — the focus-mode switch.\nfocus_mode = mo.ui.switch(value=True)" },
  { id: "e", code: "# tutor:plumbing — how the exercises work.\nmo.md(r\"\"\"\n- a line at column zero inside a string\n\"\"\")" },
  { id: "d", code: "# tutor:plumbing — kept below the lesson; see the note above.\nimport numpy as np" },
  { id: "h", code: 'mo.md(r"""## Finding Groups in Code""")', name: "ch1_header" },
];

describe("repairScript", { skip: !HAVE_PY }, () => {
  test("a whole live notebook and a whole file: nothing happens", () => {
    const r = runRepair(false, LIVE_OK);
    assert.equal(r.verdict, "ok", r.stderr);
    assert.deepEqual(r.ops, []);
  });

  test("a whole live notebook but a damaged file (force): plumbing is recreated through the document", () => {
    const r = runRepair(true, LIVE_OK);
    assert.equal(r.verdict, "repaired", r.stderr);
    const deleted = r.ops.filter((o: string[]) => o[0] === "delete").map((o: string[]) => o[1]);
    assert.deepEqual(deleted.sort(), ["b", "c", "d", "e"]);
    const created = r.ops.filter((o: string[]) => o[0] === "create").map((o: string[]) => o[1]);
    assert.equal(created.length, 4, "the cell with a column-zero line is recreated too");
    assert.equal(r.ops.filter((o: string[]) => o[0] === "run").length, 4);
  });

  test("live cells that were overwritten by copies: copies go, plumbing returns", () => {
    const live = [
      { id: "a", code: 'mo.md(r"""bug report""")' },
      { id: "b", code: 'mo.md(r"""## Finding Groups in Code""")' }, // was the import
      { id: "c", code: 'mo.md(r"""## Finding Groups in Code""")' }, // was the switch
      { id: "d", code: "# tutor:plumbing — kept below the lesson; see the note above.\nimport numpy as np" },
      { id: "h", code: 'mo.md(r"""## Finding Groups in Code""")', name: "ch1_header" },
    ];
    const r = runRepair(false, live);
    assert.equal(r.verdict, "repaired", r.stderr);
    const deleted = r.ops.filter((o: string[]) => o[0] === "delete").map((o: string[]) => o[1]);
    assert.deepEqual(deleted.sort(), ["b", "c", "d"]);
    assert.ok(!deleted.includes("h"), "the named header stays");
    assert.ok(!deleted.includes("a"), "the bug-report cell stays");
  });
});
