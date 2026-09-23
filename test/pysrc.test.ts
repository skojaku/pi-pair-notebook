/**
 * `pyMd` writes the Python literal that carries a student's note cell. The
 * only test that means anything about it is whether PYTHON agrees, so these
 * hand the emitted literal to a real interpreter and compare what comes back
 * with what went in.
 *
 * python3 is already required by the review harness. Where it is missing the
 * round-trip cases skip and the structural ones still run.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  handedInCode,
  kernelRefusal,
  pickNotebookSession,
  py,
  pyList,
  pyMd,
  pythonSkeleton,
  sanitize,
  scanKernelCode,
  stripRedundantImports,
  workCellFor,
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

test("the graded record is refused, not written and then complained about", () => {
  // 66 of the 87 nb_run calls in this machine's history were hand-written log
  // JSON. The old check ran the code first and appended a note afterwards, so
  // the row was already on disk by the time the tutor was told not to.
  for (const code of [
    `import json\nwith open("session_artifacts/session_log.jsonl","a") as f:\n    f.write(json.dumps(row))`,
    `open("session_artifacts/session_summary.md","w").write(summary)`,
    `import json; json.dump(state, open("session_artifacts/chapter_state.json","w"))`,
  ]) {
    const r = scanKernelCode(code);
    assert.equal(r.ok, false, code.split("\n")[0]);
    assert.ok(r.hits.includes("the graded record"));
  }
});

test("the graded-record refusal names the tools that own those files", () => {
  const r = kernelRefusal(["the graded record"]);
  assert.match(r, /checkpoint_done/);
  assert.match(r, /log_detour/);
  assert.match(r, /chapter_done/);
  // It is a different fault from reaching the operating system, and must not
  // read as one.
  assert.ok(!/operating system/.test(r));
});

test("saving a photo beside the log is still fine", () => {
  // The check is on the graded files by name, not on session_artifacts/.
  const r = scanKernelCode(
    'import base64, pathlib\npathlib.Path("session_artifacts/uploads/p.jpg").write_bytes(base64.b64decode(b))',
  );
  assert.equal(r.ok, true, r.hits.join(", "));
});

/**
 * Putting the pass watcher back after a break.
 *
 * `liveWorkCell` is memory, and nb_add_exercise was the only thing that ever
 * set it — so "the run is the hand-in" worked on the day the exercise was
 * built and was silently dead in every session after, because the resume
 * brief tells the tutor (correctly) not to rebuild cells that are already
 * there. A lesson of this length is lived across sittings.
 */
describe("workCellFor", () => {
  const NB = [
    "import marimo",
    "app = marimo.App()",
    "",
    "@app.cell",
    "def cp1_build_work(check_build, ig):",
    "    g = ig.Graph()",
    "    check_build(g, 7, 9)",
    "    return",
    "",
    "@app.cell(hide_code=True)",
    "def cp1_build_brief(mo):",
    "    return",
  ].join("\n");

  test("the open checkpoint's cell is found", () => {
    assert.equal(workCellFor(NB, "cp1_build"), "cp1_build_work");
  });

  test("a checkpoint whose exercise was never built watches nothing", () => {
    // Otherwise the watcher polls the kernel every three seconds, all session,
    // for a cell that does not exist.
    assert.equal(workCellFor(NB, "cp2_edit"), null);
  });

  test("no open checkpoint, nothing to watch", () => {
    assert.equal(workCellFor(NB, null), null);
  });

  test("a helper the student defined inside a cell is not the cell", () => {
    // marimo writes its own `def` at column zero. An indented one is theirs.
    const nb = "@app.cell\ndef other(mo):\n    def cp9_x_work(a):\n        return a\n";
    assert.equal(workCellFor(nb, "cp9_x"), null);
  });

  test("an id that is not an identifier never reaches the regex", () => {
    for (const bad of ["cp1-build", "cp1 build", "cp.*", "", "1cp"]) {
      assert.equal(workCellFor(NB, bad), null, bad);
    }
  });

  test("a practice round's own cell is found under its own id", () => {
    const nb = "@app.cell\ndef cp1_build_extra_work(check_build):\n    return\n";
    assert.equal(workCellFor(nb, "cp1_build_extra"), "cp1_build_extra_work");
    assert.equal(workCellFor(nb, "cp1_build"), null);
  });
});

/**
 * What the page says the moment the bench passes.
 *
 * Two faults met here. The 🆘 button is the way out of a cell that will not
 * go, and it was still sitting under cells that had gone — offering help with
 * a solved problem, and leaving one control on the page that writes to the
 * tutor, so a stray press read as a second hand-in. And taking it away alone
 * left the page silent exactly when the student needed telling where to look:
 * their eyes are on the notebook, the tutor talks in the terminal, and a green
 * cell with nothing under it gives them no reason to turn their head.
 */
describe("handedInCode", () => {
  const code = handedInCode("cp1_build_work");

  test("both help cells go, the reader before the button it reads", () => {
    // `_helped` references the button `_help` defines. Deleting the definition
    // first leaves a NameError where the student's work used to be.
    assert.ok(code.includes('["cp1_build_helped","cp1_build_help"]'));
    assert.ok(code.includes("ctx.delete_cell(_n)"));
  });

  test("a line takes their place, under the student's own cell", () => {
    assert.match(code, /name="cp1_build_handed"/);
    assert.match(code, /after=_w\[0\]\.id/);
    assert.match(code, /Your tutor answers in the terminal/);
  });

  test("the line says where the answer comes back", () => {
    // The whole point: the student is looking at the notebook and the tutor
    // is about to speak somewhere else.
    assert.match(code, /terminal/);
  });

  test("it is true on a cold read", () => {
    // This cell is in the keepsake a grader opens in March. Nothing in it may
    // claim something is happening right now.
    for (const nope of ["right now", "is reading", "is looking", "just now"]) {
      assert.ok(!code.includes(nope), nope);
    }
  });

  test("the anchor is read before the deletes, not after", () => {
    assert.ok(code.indexOf("_w = [c for c in ctx.cells") < code.indexOf("ctx.delete_cell"));
  });

  test("running twice does not write the line twice", () => {
    // Every pass runs this, including one restored from an earlier sitting
    // where the box has long gone.
    assert.match(code, /if "cp1_build_handed" not in _names and _w:/);
  });

  test("a practice round cleans up its own box", () => {
    const extra = handedInCode("cp1_build_extra_work");
    assert.ok(extra.includes('["cp1_build_extra_helped","cp1_build_extra_help"]'));
    assert.match(extra, /name="cp1_build_extra_handed"/);
  });
});

/**
 * Which marimo session is ours.
 *
 * The toolkit talks to a fixed port, so a server from some other run that is
 * still holding it answers like a healthy one. Three orphans from a harness
 * that died without its teardown sat on 2718–2720 for six days. A lone
 * session used to be adopted without a glance at what it was serving, and the
 * fallback for several of them matched the BASENAME — and every pair notebook
 * in this course is called notebook.py.
 */
describe("pickNotebookSession", () => {
  const CWD = "/Users/s/teaching/ops/pair-notebook/m03-robustness";
  const WANT = `${CWD}/notebook.py`;

  test("our own session is found", () => {
    const sessions = { s_a: { path: WANT, filename: WANT } };
    assert.equal(pickNotebookSession(sessions, ["s_a"], WANT, CWD), "s_a");
  });

  test("a lone session that is NOT ours is refused", () => {
    // The six-day-old orphan, exactly: one session, another notebook.py.
    const other = "/private/var/folders/p1/T/tutor-e2e-boy3my/notebook.py";
    const sessions = { s_q90q0t: { path: other, filename: other } };
    assert.equal(pickNotebookSession(sessions, ["s_q90q0t"], WANT, CWD), null);
  });

  test("the right one is picked out of a crowd", () => {
    const other = "/private/var/folders/p1/T/tutor-e2e-x/notebook.py";
    const sessions = {
      s_a: { path: other, filename: other },
      s_b: { path: WANT, filename: WANT },
    };
    assert.equal(pickNotebookSession(sessions, ["s_a", "s_b"], WANT, CWD), "s_b");
  });

  test("macOS reports /private; the short path still matches", () => {
    // /tmp and /var are symlinks into /private. marimo reports the resolved
    // path, process.cwd() gives the short one — this mismatch is why the
    // basename fallback was reached in ordinary use, so dropping the fallback
    // without this would break the normal case to fix the rare one.
    const cwd = "/var/folders/p1/T/lesson";
    const want = `${cwd}/notebook.py`;
    const reported = "/private/var/folders/p1/T/lesson/notebook.py";
    assert.equal(pickNotebookSession({ s: { path: reported } }, ["s"], want, cwd), "s");
  });

  test("a relative path is resolved against the module folder", () => {
    assert.equal(pickNotebookSession({ s: { path: "notebook.py" } }, ["s"], WANT, CWD), "s");
  });

  test("filename is consulted when path is absent", () => {
    assert.equal(pickNotebookSession({ s: { filename: WANT } }, ["s"], WANT, CWD), "s");
  });

  test("no sessions at all is not a match", () => {
    assert.equal(pickNotebookSession({}, [], WANT, CWD), null);
  });

  test("a neighbouring module's notebook is not ours", () => {
    // The fault the basename rule could never see.
    const sibling = "/Users/s/teaching/ops/pair-notebook/m02-small-world/notebook.py";
    assert.equal(pickNotebookSession({ s: { path: sibling } }, ["s"], WANT, CWD), null);
  });

  test("doubled slashes do not decide identity", () => {
    assert.equal(
      pickNotebookSession({ s: { path: WANT.replace("/pair-notebook/", "//pair-notebook//") } }, ["s"], WANT, CWD),
      "s",
    );
  });
});
