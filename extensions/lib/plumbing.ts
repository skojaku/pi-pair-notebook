/**
 * The notebook's plumbing cells, and the check that they are all still there.
 *
 * Every module's `notebook.template.py` carries a handful of anonymous cells
 * that every other cell leans on: `import marimo as mo`, the progress bar, the
 * focus switch, the figure helpers. Each opens with `# tutor:plumbing`.
 *
 * In four of sixteen m05 student notebooks some of them were gone: the code of
 * `ch1_header` or of a brief sat where an import and the focus switch should
 * be. The page looked fine while the kernel was alive and every cell that
 * renders anything failed with "name 'mo' is not defined" on the first reload
 * from the file. The students wrote "nothing is showing up besides the header"
 * and "please restart, something has gone wrong. Lots is missing". How the
 * cells went is not known; that they can go is.
 *
 * This is the pure half: count the cells by the comment they open with, in
 * the file and in the template, and say which ones are short. The repair that
 * recreates them runs in the kernel (`repairScript`).
 */

/** The `# tutor:plumbing ...` first line of every cell that has one, counted. */
export function plumbingTells(src: string): Map<string, number> {
  const tells = new Map<string, number>();
  const lines = src.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (!/^    # tutor:plumbing/.test(lines[i])) continue;
    // A cell: the line above is its `def`, possibly wrapped over several lines
    // ending in a colon.
    if (!/^(def |@app\.cell)|:\s*$/.test(lines[i - 1])) continue;
    const tell = lines[i].trim();
    tells.set(tell, (tells.get(tell) ?? 0) + 1);
  }
  return tells;
}

/**
 * What the notebook file lacks that the template has: each plumbing tell with
 * fewer cells in the file than in the template, and `import marimo as mo` when
 * no cell of the file holds it. Empty when the file is whole.
 */
export function plumbingDrift(fileSrc: string, templateSrc: string): string[] {
  const want = plumbingTells(templateSrc);
  const have = plumbingTells(fileSrc);
  const short: string[] = [];
  for (const [tell, n] of want) {
    if ((have.get(tell) ?? 0) < n) short.push(tell);
  }
  if (want.size > 0 && !/^\s+import marimo as mo\s*$/m.test(fileSrc)) {
    short.push("import marimo as mo");
  }
  return short;
}

/**
 * The kernel script that puts the plumbing back.
 *
 * Runs in marimo's code-mode context. It reads `notebook.template.py`, takes
 * every cell that opens with `# tutor:plumbing`, and compares what the LIVE
 * notebook holds. When `force` is set (the file was short) or the live cells
 * are short, it deletes every plumbing cell and every anonymous cell that is a
 * copy of a named one (the stray `ch1_header` and brief copies), and creates
 * the template's plumbing cells again, last. Going through the document
 * means the page and the file both follow; editing a live cell to the code it
 * already has would write nothing.
 *
 * Prints `ok`, `repaired`, or `no template`.
 */
export function repairScript(force: boolean): string {
  return [
    "import ast, textwrap",
    "from collections import Counter",
    "from pathlib import Path",
    "import marimo._code_mode as cm",
    `_force = ${force ? "True" : "False"}`,
    "_tpl = Path('notebook.template.py')",
    "if not _tpl.exists():",
    "    print('no template')",
    "else:",
    "    _tsrc = _tpl.read_text()",
    "    _lines = _tsrc.splitlines()",
    "    _want = []",
    "    for _n in ast.parse(_tsrc).body:",
    "        if not isinstance(_n, ast.FunctionDef) or not _n.decorator_list:",
    "            continue",
    "        _start = _n.lineno",
    "        while _start <= len(_lines) and not _lines[_start - 1].rstrip().endswith(':'):",
    "            _start += 1",
    "        _end = _n.body[-1]",
    "        if isinstance(_end, ast.Return) and len(_n.body) > 1:",
    "            _end = _n.body[-2]",
    "        _code = textwrap.dedent('\\n'.join(_lines[_start:_end.end_lineno]))",
    "        if _code.split('\\n')[0].startswith('# tutor:plumbing'):",
    "            _want.append(_code)",
    "    _need = Counter(c.split('\\n')[0] for c in _want)",
    "    async with cm.get_context() as ctx:",
    "        _have = Counter((c.code or '').split('\\n')[0] for c in ctx.cells)",
    "        _short = any(_have[t] < n for t, n in _need.items())",
    "        _nomo = bool(_want) and not any('import marimo as mo' in (c.code or '') for c in ctx.cells)",
    "        if _want and (_force or _short or _nomo):",
    "            _named = {(c.code or '').strip() for c in ctx.cells if c.name and c.name != '_'}",
    "            for _c in list(ctx.cells):",
    "                _first = (_c.code or '').split('\\n')[0]",
    "                _anon = not _c.name or _c.name == '_'",
    "                if _first.startswith('# tutor:plumbing') or (_anon and (_c.code or '').strip() in _named):",
    "                    ctx.delete_cell(_c.id)",
    "            _ids = [ctx.create_cell(_code, hide_code=True) for _code in _want]",
    "            for _i in _ids:",
    "                ctx.run_cell(_i)",
    "            print('repaired')",
    "        else:",
    "            print('ok')",
    "",
  ].join("\n");
}
