/**
 * WHICH notebook a session works in.
 *
 * For two years there was only one answer: `notebook.py`, in the folder pi
 * was started in, created from `notebook.template.py` on the first run. That
 * is a tutored module, and nothing about it changes here.
 *
 * The second shape is a **mini-project**: a team repository whose notebook is
 * the assignment itself (`mini-project.py`), with no `lesson/` beside it and
 * no tutor contract over it. The same `nb_*` toolkit is exactly what that
 * team wants — an agent that edits the live notebook instead of a file on
 * disk the browser has not read — and the only thing standing in the way was
 * the filename, written down in four places.
 *
 * So the name becomes a decision, and this is where it is made. The rules, in
 * order, and the reason each one exists:
 *
 *   1. `PAIR_NOTEBOOK_FILE` — the review harness pins one, and it is the
 *      one-line answer for a repository whose layout nothing here predicts.
 *   2. `pair-notebook.json` → `{"notebook": "..."}` — the repository says it
 *      once, in its own file, and every student who clones it agrees. NOT
 *      `.pi/settings.json`: that file is what makes pi start at all, and an
 *      unknown key in it is a gamble taken on fifty machines at once.
 *   3. `notebook.py`, when it is there — every module folder, unchanged.
 *   4. the one marimo notebook in the folder, when there is exactly one.
 *      Zero configuration for the common mini-project, and it cannot fire in
 *      a module folder because rule 3 already answered.
 *   5. `notebook.py` anyway. Nothing was found, so the caller fails with the
 *      message it has always had rather than a new one about configuration.
 *
 * Same rule as the other libs: arguments in, value out, no disk. The reading
 * and the scanning live in notebook-tool.ts; the deciding lives here, where
 * `npm test` can reach it.
 */

/** The name a module folder has always used, and the fallback for everything. */
export const DEFAULT_NOTEBOOK = "notebook.py";

export type NotebookChoice = {
  /** Path as marimo is handed it: relative to the folder pi was started in. */
  file: string;
  /** Which rule above decided. Only for the log line and the tests. */
  from: "env" | "config" | "default" | "found" | "fallback";
  /** What else was in the folder when nothing decided. The caller says these
   *  out loud: "three notebooks here, name one" is a fixable message, and
   *  "the notebook is not reachable" — which is what the student would
   *  otherwise be told — is not. */
  alternatives?: string[];
};

/**
 * A configured path, or nothing.
 *
 * Relative and inside the folder, or it is refused. An absolute path would
 * start marimo somewhere the repository does not control and write a graded
 * artifact outside the clone; `..` is the same fault spelled differently.
 * Refusing falls through to the next rule, which is always answerable — a bad
 * value must not be able to stop a session starting.
 */
export function safeNotebookPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const p = raw.trim().replace(/^\.\//, "");
  if (!p || !p.endsWith(".py")) return undefined;
  if (/^([A-Za-z]:)?[/\\]/.test(p)) return undefined; // absolute, both platforms
  if (p.split(/[/\\]/).includes("..")) return undefined;
  return p.replace(/\\/g, "/");
}

/**
 * Is this Python file a marimo notebook?
 *
 * The generated header is `app = marimo.App(...)`, and it is on line 10 of
 * every notebook marimo has ever written. A module's `cells/*.py` are cell
 * BODIES and carry no such line, which is why the scan can afford to be this
 * literal: the false positive it could produce (a script that mentions
 * `marimo.App` in a comment) is a file someone deliberately put in the
 * folder, and rule 2 is how they say which one they meant.
 */
export function isMarimoNotebook(src: string): boolean {
  return /^\s*\w+\s*=\s*marimo\.App\s*\(/m.test(src);
}

/**
 * Files the scan must never offer, whatever is in them.
 *
 * `notebook.template.py` is the pristine copy rule 3 makes `notebook.py`
 * from — offering it would have the toolkit editing the template and the
 * student's own work staying empty. The goldens are answer keys.
 */
export function isScannableNotebook(name: string): boolean {
  if (!name.endsWith(".py")) return false;
  if (name.startsWith(".")) return false;
  if (name === "notebook.template.py") return false;
  if (/\.golden(\.build)?\.py$/.test(name)) return false;
  return true;
}

/**
 * Directories a scan must not walk into.
 *
 * `cells/` and `lesson/` are a module's own, and a module never scans — rule
 * 3 answered before this ran. The rest are the folders a repository grows:
 * one of them can hold thousands of files, and this runs before the agent has
 * said hello.
 */
const SKIP_DIRS = new Set([
  "node_modules", "__pycache__", "__marimo__", ".git", "session_artifacts",
  "assets", "cells", "lesson", "tools", ".venv", "venv", "site-packages",
]);

/** What the walk needs from a filesystem, so a test can hand it a tree. */
export type NotebookIO = {
  /** Entries of one directory. Anything unreadable is an empty list. */
  list(dir: string): { name: string; file: boolean; dir: boolean }[];
  /** The first few KB of a file — the generated App line is near the top. */
  head(file: string): string;
};

/**
 * Marimo notebooks in `root`, and one level under it.
 *
 * One level, and named directories only. A mini-project keeps its notebook at
 * the top or in `assignment/`; a recursive walk buys the third case and pays
 * for it with a startup that stats a whole clone.
 */
export function findNotebooks(root: string, io: NotebookIO): string[] {
  const out: string[] = [];
  const scan = (dir: string, prefix: string) => {
    const entries = io.list(dir);
    for (const e of entries) {
      if (!e.file || !isScannableNotebook(e.name)) continue;
      if (isMarimoNotebook(io.head(`${dir}/${e.name}`))) out.push(prefix + e.name);
    }
    return entries;
  };
  for (const e of scan(root, "")) {
    if (!e.dir || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    scan(`${root}/${e.name}`, `${e.name}/`);
  }
  return out;
}

export function chooseNotebook(input: {
  /** PAIR_NOTEBOOK_FILE. */
  env?: unknown;
  /** `notebook` from pair-notebook.json. */
  config?: unknown;
  /** Does notebook.py exist in the folder? */
  hasDefault: boolean;
  /** Marimo notebooks the caller found, as relative paths. */
  found?: string[];
}): NotebookChoice {
  const env = safeNotebookPath(input.env);
  if (env) return { file: env, from: "env" };
  const config = safeNotebookPath(input.config);
  if (config) return { file: config, from: "config" };
  if (input.hasDefault) return { file: DEFAULT_NOTEBOOK, from: "default" };
  const found = (input.found ?? []).filter((f) => safeNotebookPath(f));
  if (found.length === 1) return { file: found[0], from: "found" };
  return {
    file: DEFAULT_NOTEBOOK,
    from: "fallback",
    ...(found.length > 1 ? { alternatives: found } : {}),
  };
}
