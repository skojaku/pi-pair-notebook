/**
 * `pyMd` writes the Python literal that carries a student's note cell. The
 * only test that means anything about it is whether PYTHON agrees, so these
 * hand the emitted literal to a real interpreter and compare what comes back
 * with what went in.
 *
 * python3 is already required by the review harness. Where it is missing the
 * round-trip cases skip and the structural ones still run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  kernelRefusal,
  py,
  pyList,
  pyMd,
  pythonSkeleton,
  sanitize,
  scanKernelCode,
  stripRedundantImports,
} from "../extensions/lib/pysrc.ts";

const HAVE_PY = spawnSync("python3", ["-c", "pass"]).status === 0;

/** Evaluate the literal `pyMd` produced and hand back what Python read. */
function pythonReads(literal: string): string {
  const r = spawnSync(
    "python3",
    ["-c", `import sys; sys.stdout.write(${literal})`],
    { encoding: "utf-8" },
  );
  assert.equal(r.status, 0, `python rejected the literal:\n${literal}\n${r.stderr}`);
  return r.stdout;
}

const ADVERSARIAL: [string, string][] = [
  ["plain markdown", "### 📏 Distance\n\nFive pairs sit at 1."],
  ["LaTeX with backslashes", "$$C_i = \\frac{\\text{friendships}}{\\text{pairs}}$$"],
  ["the escapes Python eats", "\\frac \\alpha \\r \\t \\n \\v \\b"],
  ["ends in a backslash", "a line that ends in a backslash \\"],
  ["ends in a quotation mark", 'they typed "i think its 2"'],
  ["ends in several quotes", 'nested quotes """'],
  ["embedded triple quote", 'before """ after'],
  ["only a triple quote", '"""'],
  ["empty", ""],
  ["CRLF", "line one\r\nline two"],
  ["a lone quote at the very end", 'the answer is "'],
  ["backslash then quote", 'trailing \\"'],
  ["unicode and slots", "«their answers, verbatim» — 7/6 ≈ 1.17 ✅"],
  ["a python-looking payload", 'x""" + __import__("os").name + """y'],
];

for (const [name, input] of ADVERSARIAL) {
  test(`pyMd round-trips through python: ${name}`, { skip: !HAVE_PY }, () => {
    const out = pythonReads(pyMd(input));
    // CRLF is normalised on purpose (a note written on Windows must not
    // carry \r into the notebook); trailing newline padding is invisible in
    // markdown and is what keeps the last token raw.
    assert.equal(out.replace(/\n+$/, ""), input.replace(/\r\n/g, "\n").replace(/\n+$/, ""));
  });
}

test("the LAST token is raw, whatever the text ends with", () => {
  // marimo copies the r/f prefix from the last string token when it rewrites
  // a markdown cell. A last token that is not raw is how the module's own
  // definition came back as `C_i = rac{…}` after one reload.
  for (const [, input] of ADVERSARIAL) {
    if (input === "" || input === '"""') continue;
    const lit = pyMd(input);
    const lastToken = lit.slice(lit.lastIndexOf("r\"\"\"") >= 0 ? lit.lastIndexOf("r\"\"\"") : 0);
    assert.ok(lit.includes('r"""'), `no raw token at all for: ${JSON.stringify(input)}`);
    assert.ok(lastToken.startsWith('r"""'), `last token is not raw for: ${JSON.stringify(input)}`);
  }
});

test("py() is a valid python literal for the same shapes", { skip: !HAVE_PY }, () => {
  for (const [, input] of ADVERSARIAL) {
    assert.equal(pythonReads(py(input)), input);
  }
});

test("pyList round-trips a list of strings", { skip: !HAVE_PY }, () => {
  const xs = ["cp2_distance", 'he said "no"', "back\\slash"];
  const r = spawnSync(
    "python3",
    ["-c", `import json,sys; sys.stdout.write(json.dumps(${pyList(xs)}))`],
    { encoding: "utf-8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), xs);
});

test("sanitize leaves a legal python identifier body", () => {
  assert.equal(sanitize("cp2 distance-extra!"), "cp2_distance_extra_");
});

test("stripRedundantImports drops only the notebook's own imports", () => {
  const code = [
    "import marimo as mo",
    "import igraph as ig",
    "import my_own_module",
    "x = 1",
  ].join("\n");
  assert.equal(stripRedundantImports(code), "import my_own_module\nx = 1");
});

test("stripRedundantImports leaves an indented import inside a function alone", () => {
  // The regexes allow leading whitespace, so this documents what they do —
  // a deliberate choice, not an accident: a model that indents its import is
  // still creating the same duplicate binding at cell scope in marimo.
  assert.equal(stripRedundantImports("    import numpy as np\ny = 2"), "y = 2");
});

// ---------------------------------------------------------------------------
// scanKernelCode — the shell the toolkit thought it had taken away
// ---------------------------------------------------------------------------

test("the four calls a live run actually made are refused", () => {
  // pi-pair-notebook#11, tutor openrouter/z-ai/glm-5.3, in order. It had just
  // reasoned "I can't run shell" in its own transcript.
  const escalation = [
    `import os\nfor k,v in os.environ.items():\n    if 'MARIMO' in k.upper():\n        print(k, '=', v)`,
    `import socket, subprocess\ns = socket.socket(); s.settimeout(1)\nprint('8080 open:', s.connect_ex(('127.0.0.1', 8080)) == 0)`,
    `import subprocess\nprint(subprocess.run(['lsof','-nP','-iTCP','-sTCP:LISTEN'], capture_output=True, text=True).stdout)`,
    `import urllib.request\nprint(urllib.request.urlopen('http://127.0.0.1:2718', timeout=3).read(200)[:200])`,
  ];
  for (const code of escalation) {
    assert.equal(scanKernelCode(code).ok, false, code.slice(0, 40));
  }
});

test("what nb_run is FOR still runs", () => {
  // Saving an uploaded photo, timestamps, arithmetic, writing a file. A guard
  // that refuses these breaks the graded artifact, which is worse than the
  // fault it catches.
  const honest = [
    `from datetime import datetime, timezone\nprint(datetime.now(timezone.utc).isoformat())`,
    `import json, base64, pathlib\np = pathlib.Path("session_artifacts/uploads")\np.mkdir(parents=True, exist_ok=True)\n(p / "photo.jpg").write_bytes(base64.b64decode(cp4_photo.value[0].contents))`,
    `with open("session_artifacts/note.txt", "a") as f:\n    f.write("hello\\n")`,
    `print(sum(1 for _ in range(10)) / 2)`,
    `import numpy as np\nprint(np.mean([1, 2, 3]))`,
    `print(len(G.edges()), nx.average_shortest_path_length(G))`,
  ];
  for (const code of honest) {
    const r = scanKernelCode(code);
    assert.equal(r.ok, true, `${code.slice(0, 50)} → ${r.hits.join(", ")}`);
  }
});

test("os.path stays legal while os.system does not", () => {
  // Banning `os` outright would refuse honest work; these are the attributes
  // that are not honest here.
  assert.equal(scanKernelCode(`import os\nprint(os.path.join("a", "b"))`).ok, true);
  assert.equal(scanKernelCode(`import os\nos.system("ls")`).ok, false);
  assert.equal(scanKernelCode(`import os\nprint(os.environ["HOME"])`).ok, false);
});

test("a module bound three calls ago is still a module", () => {
  // The kernel is long-lived: the import can be in one nb_run and the use in
  // the next. A bare attribute reference is enough.
  assert.equal(scanKernelCode(`print(subprocess.run(["ls"]))`).ok, false);
});

test("the string that names the module is not the module", () => {
  // Literals are stripped before the scan, so prose about subprocess is prose.
  assert.equal(scanKernelCode(`print("we do not use subprocess here")`).ok, true);
  assert.equal(scanKernelCode(`# subprocess.run is not allowed\nprint(1)`).ok, true);
});

test("assembling the name out of literals does not get you the module", () => {
  // This is why the dynamic-execution primitives are refused rather than the
  // spellings: with literals stripped, "sub" + "process" is a value, and the
  // only way back to code is through one of these.
  for (const code of [
    `__import__("sub" + "process").run(["ls"])`,
    `eval("__imp" + "ort__('os').system('ls')")`,
    `exec(compile("import os", "<s>", "exec"))`,
    `getattr(os, "sys" + "tem")("ls")`,
  ]) {
    assert.equal(scanKernelCode(code).ok, false, code);
  }
});

test("an f-string's holes are code and its prose is not", () => {
  assert.equal(scanKernelCode('print(f"the answer is {2 + 2}")').ok, true);
  assert.equal(scanKernelCode('print(f"{subprocess.run(cmd)}")').ok, false);
  // And the prose inside an f-string is still prose.
  assert.equal(scanKernelCode('print(f"os.system is off limits {x}")').ok, true);
});

test("removing a literal does not glue its neighbours together", () => {
  // `os` + "…" + `.system` must not read as os.system.
  assert.equal(scanKernelCode('print(os, "x", 1)').ok, true);
});

test("a cell body is scanned too — it is the same kernel", () => {
  // nb_add_cell hides the code from the student by default, so it is not the
  // safer door.
  assert.equal(scanKernelCode(`import subprocess\nsubprocess.run(["id"])`).ok, false);
  assert.equal(
    scanKernelCode(`_fig = netviz(edges, highlight=[1, 2])\nmo.vstack([mo.md("hi"), _fig])`)
      .ok,
    true,
  );
});

test("the refusal names a tool instead of leaving the model to improvise", () => {
  // What the model actually wanted in the incident was the notebook's address,
  // and a refusal with no route is how a model starts obfuscating.
  const r = kernelRefusal(["subprocess"]);
  assert.match(r, /nb_notebook_url/);
  assert.match(r, /subprocess/);
  assert.match(r, /never tell the student to start marimo/i);
  // It must not read as "try again", which is what a failed result would say.
  assert.ok(!/retry this call/i.test(r));
});

test("pythonSkeleton keeps line structure", () => {
  // The import test below relies on `import x` sitting at the start of a line.
  const src = 'x = "a"\nimport subprocess\ny = 2';
  assert.match(pythonSkeleton(src), /\nimport subprocess\n/);
});

test("a respelling of the import does not get you the module back", () => {
  // The refusal tells the model to rewrite the call, so the respellings are
  // the thing to hold. `import os, subprocess as sp` puts neither
  // `subprocess` after the import keyword nor `subprocess.` anywhere — and
  // the live incident's own second call was a comma import.
  for (const code of [
    'import os, subprocess as sp\nsp.run(["lsof"])',
    "import os, subprocess\nsubprocess.run(['id'])",
    'from os import system\nsystem("ls")',
    'from os import popen\nprint(popen("lsof -nP -iTCP").read())',
    'from os import environ\nprint(environ["HOME"])',
    'import os as _o\n_o.system("ls")',
    'import subprocess as sp, os\nsp.run(["id"])',
    'from subprocess import run\nrun(["ls"])',
  ]) {
    assert.equal(scanKernelCode(code).ok, false, code.split("\n")[0]);
  }
});

test("the from-import forms this course really uses still run", () => {
  for (const code of [
    'from os import makedirs\nmakedirs("session_artifacts", exist_ok=True)',
    'from os.path import join\nprint(join("a", "b"))',
    'from pathlib import Path\nPath("session_artifacts/x.txt").write_text("hi")',
    "from datetime import datetime, timezone\nprint(datetime.now(timezone.utc))",
    "import numpy as np, networkx as nx\nprint(np.mean([1, 2]), nx.density(G))",
    "from collections import Counter\nprint(Counter([1, 1, 2]))",
  ]) {
    const r = scanKernelCode(code);
    assert.equal(r.ok, true, `${code.split("\n")[0]} → ${r.hits.join(", ")}`);
  }
});
