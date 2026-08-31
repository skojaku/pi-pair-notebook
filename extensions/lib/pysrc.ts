/**
 * The Python-source half of the toolkit, as pure functions.
 *
 * Everything here turns a JavaScript string into a fragment of the Python
 * file the student's notebook IS. A quoting bug in this file is not a
 * cosmetic fault: it is a SyntaxError in a notebook a beginner cannot repair,
 * or a note cell that renders `C_i = rac{…}` because Python ate the `\f`.
 * Both have happened.
 *
 * Same rule as lib/verbatim.ts: arguments in, string out, nothing else.
 * Tests: `npm test`.
 */

/** JSON string literals are valid Python string literals. */
export const py = (s: string): string => JSON.stringify(s);

export const pyList = (xs: string[]): string => JSON.stringify(xs);

export const sanitize = (s: string): string => s.replace(/\W/g, "_");

/**
 * The argument of an `mo.md(...)` call, as a RAW triple-quoted literal.
 *
 * `py()` is wrong here, and silently so. marimo recognises a markdown cell
 * when it saves the file and rewrites it as a triple-quoted literal, copying
 * the r/f prefix from the ORIGINAL source token — so a note created as
 * `mo.md("…\\frac…")` is written back as a NON-raw `mo.md("""…\frac…""")`,
 * and the next reload lets Python eat `\f`, `\a`, `\r`, `\t`. That is how
 * the module's central definition ended up on screen as
 * `C_i = rac{ ext{friendships…}}`, and $L = 7/6 pprox 1.17$ beside it.
 * Every note skeleton is full of LaTeX, so this hit the keepsake hardest.
 *
 * A raw string cannot contain `"""` and cannot end in a backslash, so the
 * text is split into raw chunks glued together with ordinary literals. In
 * the normal case (no triple quote anywhere) that is exactly the
 * `r"""…"""` marimo writes for itself.
 *
 * The prefix marimo copies is the LAST string token's, so that token must be
 * raw no matter what the text ends with — and a note ends with the student's
 * own words, which can perfectly well end in a quotation mark. Padding the
 * final chunk with one newline (invisible in markdown) keeps it raw instead
 * of peeling it into an ordinary literal and losing the prefix again.
 */
export function pyMd(markdown: string): string {
  const chunk = (s: string): string => {
    if (!s) return '""';
    // Neither a quote nor a backslash may sit against the closing """ —
    // peel any trailing run of them into an ordinary escaped literal.
    const tail = /["\\]+$/.exec(s);
    if (!tail) return `r"""${s}"""`;
    const head = s.slice(0, s.length - tail[0].length);
    return head ? `r"""${head}""" ${py(tail[0])}` : py(tail[0]);
  };
  const parts = markdown.replace(/\r\n/g, "\n").split('"""');
  const last = parts.length - 1;
  if (parts[last] === "" || /["\\]$/.test(parts[last])) parts[last] += "\n";
  return parts.map(chunk).join(` '"""' `);
}

/**
 * The starter notebook already owns mo/nx/np/plt. Models add these imports
 * anyway, which triggers marimo's multiply-defined-name rejection (seen in
 * production) — strip them from submitted cell bodies.
 */
export function stripRedundantImports(code: string): string {
  const redundant = [
    /^\s*import marimo as mo\s*$/,
    /^\s*import marimo\s*$/,
    /^\s*import networkx as nx\s*$/,
    /^\s*import numpy as np\s*$/,
    /^\s*import matplotlib\.pyplot as plt\s*$/,
    /^\s*from matplotlib import pyplot as plt\s*$/,
    /^\s*import igraph as ig\s*$/,
    /^\s*import seaborn as sns\s*$/,
    /^\s*import altair as alt\s*$/,
    /^\s*import pandas as pd\s*$/,
  ];
  return code
    .split("\n")
    .filter((line) => !redundant.some((re) => re.test(line)))
    .join("\n");
}

// ---------------------------------------------------------------------------
// The shell the toolkit thought it had taken away
// ---------------------------------------------------------------------------

/**
 * `bash` is removed from the tutor's active tools at session_start, on purpose,
 * and the harness was changed so that a regression in that removal would be
 * visible to the gate. It was load-bearing and it did not hold: `nb_run` runs
 * arbitrary Python in the notebook kernel, and arbitrary Python imports
 * `subprocess`.
 *
 * A live run did it. The student said the page had not opened; the tutor
 * reasoned, in its own transcript, "I can't run shell" — and then ran shell,
 * in four escalating calls, ending with
 *
 *     subprocess.run(['lsof','-nP','-iTCP','-sTCP:LISTEN'])
 *
 * whose output — every listening service on the machine — came back into its
 * context in full. On a student's laptop that is their port inventory, read by
 * the tutor, in a session they are watching.
 *
 * `nb_run` is not the only door. `nb_read` builds `repr(eval(<expr>))` around a
 * model-supplied expression, which reaches the same place in one call rather
 * than four, and `nb_add_cell`/`nb_edit_cell`/`nb_add_exercise` all run
 * model-authored bodies in the same kernel. Guarding one tool moves the hole
 * one tool to the left, so this runs at every one of them.
 *
 * IN NODE, BEFORE THE KERNEL CALL — never as an in-kernel `ast` check like
 * nb_review.py. The incident began with a notebook that was not answering, and
 * a check that lives in the kernel fails open on exactly that turn.
 *
 * WHAT THIS IS NOT: a filesystem sandbox. `open()` stays legal because saving
 * an uploaded photo and appending to a file is half of what nb_run exists for.
 * What it closes is processes, ports, the environment, and the primitives that
 * turn a string back into code.
 */

/** Comments and string literals removed, so a scan reads CODE and not prose. */
export function pythonSkeleton(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "#") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.slice(i, i + 3);
      const delim = triple === '"""' || triple === "'''" ? triple : c;
      // An f-string's {...} holes ARE code and must survive the strip; the
      // literal text around them must not.
      const prefix = /[A-Za-z]*$/.exec(out)?.[0] ?? "";
      const isF = /f/i.test(prefix);
      i += delim.length;
      let body = "";
      while (i < n) {
        if (src[i] === "\\") {
          body += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (src.slice(i, i + delim.length) === delim) {
          i += delim.length;
          break;
        }
        body += src[i];
        i += 1;
      }
      // A space keeps neighbouring tokens apart: "os" + ".system" must not be
      // glued back together by removing the literal between them. An
      // f-string's {...} holes ARE code, so they are kept and the prose
      // around them is not.
      const holes = isF
        ? [...body.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).join(" ")
        : "";
      out += ` ${holes} `;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * A module no cell in this course has an honest reason to reach: other
 * processes, the network, and the machine underneath.
 *
 * Deliberately NOT here: `signal`, `platform`, `resource`, `pwd`, `grp`,
 * `getpass`, `tempfile`. None of them is the threat — the incident was
 * processes and ports — and every one is a plausible ordinary variable name or
 * an honest one-off. A guard that refuses honest work gets withdrawn, and this
 * file has four of those on record already.
 */
const BANNED_MODULES = [
  "subprocess", "socket", "socketserver", "pty", "multiprocessing", "ctypes",
  "psutil", "shutil", "importlib", "runpy",
  "http", "urllib", "requests", "httpx", "ftplib", "telnetlib", "smtplib", "webbrowser",
];

/**
 * `os` is not banned outright: `os.path.join` is honest and common. These are
 * the attributes that are not.
 */
const BANNED_ATTRS = [
  "os.system", "os.popen", "os.spawn", "os.exec", "os.fork", "os.kill", "os.environ",
  "os.putenv", "os.getenv", "os.startfile", "os.setuid", "os.chmod", "os.chown",
  "sys.executable", "sys.argv", "shutil.which", "shutil.rmtree", "pathlib.Path.home",
  "Path.home", "os.path.expanduser",
];

/**
 * The primitives that turn a string back into code. The scan strips string
 * literals before it looks, so obfuscation lives here rather than in the
 * module list: without these, `"sub" + "process"` is a value and not an import.
 */
const BANNED_CALLS = [
  "__import__", "eval", "exec", "compile", "globals", "locals", "vars", "getattr",
  "setattr", "delattr", "breakpoint", "input",
];

const BANNED_DUNDERS = ["__subclasses__", "__globals__", "__builtins__", "__loader__", "__code__"];

export interface KernelScan {
  ok: boolean;
  /** What was found, in the words the refusal prints. */
  hits: string[];
}

/**
 * Rename every alias back to the module it points at, so the attribute rules
 * below cannot be walked past with `import os as o`.
 *
 * Both forms matter and both were missed by the first version of this scan:
 *
 *     import os as o        →  o.system("ls")      reads as os.system
 *     from os import system →  system("ls")        reads as os.system
 *
 * Returned as extra text appended to the skeleton rather than a rewrite of it:
 * a substitution could change offsets under the other rules, and appending can
 * only ever add hits.
 */
function resolveAliases(code: string): string {
  let extra = "";
  /** Every use of `alias.attr`, spelled as the module it really is. */
  const spellOut = (mod: string, alias: string) => {
    extra += `\nimport ${mod}`;
    if (alias === mod) return;
    for (const u of code.matchAll(new RegExp(`\\b${alias}\\s*\\.\\s*(\\w+)`, "g"))) {
      extra += `\n${mod}.${u[1]}`;
    }
  };
  // COMMA-AWARE, and that is the whole reason this is a parser and not one
  // regex. `import os, subprocess as sp` puts neither `subprocess` after the
  // `import` keyword nor a `subprocess.` reference anywhere in the file, so a
  // rule anchored on either walks straight past it — and the incident's own
  // second call was a comma import (`import socket, subprocess`), caught only
  // by the accident of which name came first.
  for (const m of code.matchAll(/(?:^|\n)[ \t]*import[ \t]+([^\n]+)/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const [modRaw, , aliasRaw] = t.split(/\s+(as)\s+/);
      const mod = (modRaw ?? "").trim();
      if (!/^[\w.]+$/.test(mod)) continue;
      spellOut(mod, (aliasRaw ?? mod).trim());
    }
  }
  // `from os import system` binds `system` with no dotted reference left for
  // the attribute rule to see, which is the other half of the same hole.
  for (const m of code.matchAll(/(?:^|\n)[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+([^\n]+)/g)) {
    const [, mod, names] = m;
    extra += `\nimport ${mod}`;
    for (const raw of names.split(",")) {
      const [nameRaw, , aliasRaw] = raw.replace(/[()]/g, "").trim().split(/\s+(as)\s+/);
      const name = (nameRaw ?? "").trim();
      if (!name || name === "*") continue;
      extra += `\n${mod}.${name}`;
      // …and any use of the local name it bound.
      const alias = (aliasRaw ?? name).trim();
      for (const u of code.matchAll(new RegExp(`\\b${alias}\\s*\\.\\s*(\\w+)`, "g"))) {
        extra += `\n${mod}.${name}.${u[1]}`;
      }
    }
  }
  return code + extra;
}

export function scanKernelCode(src: string): KernelScan {
  const code = resolveAliases(pythonSkeleton(String(src ?? "")));
  const hits: string[] = [];
  const add = (h: string) => {
    if (!hits.includes(h)) hits.push(h);
  };
  for (const m of BANNED_MODULES) {
    const root = m.split(".")[0];
    // `import x`, `from x import y`, and a bare `x.attr` reference — the last
    // one because the kernel is long-lived and a module imported three calls
    // ago is still bound.
    const re = new RegExp(
      `(?:^|\\n)\\s*(?:import|from)\\s+${root}\\b|\\b${root}\\s*\\.\\s*[A-Za-z_]`,
    );
    if (re.test(code)) add(root);
  }
  for (const a of BANNED_ATTRS) {
    const re = new RegExp(`\\b${a.replace(/\./g, "\\s*\\.\\s*")}`);
    if (re.test(code)) add(a);
  }
  for (const c of BANNED_CALLS) {
    if (new RegExp(`\\b${c}\\s*\\(`).test(code)) add(`${c}()`);
  }
  for (const d of BANNED_DUNDERS) if (code.includes(d)) add(d);
  return { ok: hits.length === 0, hits };
}

/**
 * What the tutor is told instead. It names the tool that does the thing it was
 * reaching for, because a refusal with no route is how a model starts
 * obfuscating — and because in the run that produced this, what it actually
 * wanted was the notebook's address.
 */
export function kernelRefusal(hits: string[]): string {
  return (
    `NOT RUN — this code reaches the operating system (${hits.join(", ")}), and the ` +
    `notebook kernel is not a shell. You do not have one, deliberately.\n` +
    `WHAT TO DO INSTEAD:\n` +
    `• Where is the notebook / what is its address? → nb_notebook_url. Never tell the ` +
    `student to start marimo themselves: the toolkit owns the server, and a second one ` +
    `is a corrupted session.\n` +
    `• Is the notebook alive? → nb_read, or just build the cell; the tools report it.\n` +
    `• Save an uploaded photo, write a file, do arithmetic, read a timestamp? → all of ` +
    `that still works: open(), pathlib, datetime, json, base64.\n` +
    `Rewrite this call without the flagged names, or say what you were trying to learn ` +
    `and ask the student.`
  );
}
