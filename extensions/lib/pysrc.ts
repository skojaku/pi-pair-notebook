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
