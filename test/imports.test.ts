/**
 * A name imported from lib/ that nothing calls.
 *
 * bf6b255 pulled log_detour's question matcher out into lib/verbatim.ts as
 * `matchDetourQuestion`, with four tests named after the live faults it
 * encodes. The library half landed; the call site was never swapped. For four
 * commits notebook-tool.ts ran a hand-copied duplicate of the same logic, and
 * `npm test` reported those four cases green against code no session ever
 * reached — so a fix to the library would have been green and dead, and an
 * edit to the copy in the tool would have been untested. That is the exact
 * failure mode the extraction was done to end.
 *
 * One reference — the import — is what it looked like:
 *
 *     $ grep -n "matchDetourQuestion" extensions/notebook-tool.ts
 *     50:  matchDetourQuestion,
 *
 * It is a grep, and it would have caught this the day it shipped.
 *
 * WHAT IT DOES NOT COVER, deliberately: channel-update.ts imports nothing from
 * lib/ and must keep it that way. Its copy of the health markers is duplicated
 * on purpose — "the two files must share no code. A shared helper with a
 * syntax error in it takes down the toolkit AND the thing that repairs the
 * toolkit". Do not widen this into "delete duplicated code".
 *
 * THE WAY OUT, if a name ever has to be imported ahead of its call site: use
 * it. `void thing;` is a use, it is one line, and the failure below names the
 * file and the name so the fix is never a guess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Comments and string-literal TEXT removed, so a name that appears only in a
 * doc comment does not read as a use. `${…}` holes are code and are kept; so
 * are regex literals, because a name can be built into one.
 *
 * A hand-written scanner and not a parser. Its failure mode is a loud false
 * positive at commit time, never a silent pass.
 */
function scrub(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  // A `/` starts a regex only where a value cannot already have ended.
  const regexAllowed = () => {
    const t = out.replace(/\s+$/, "");
    if (!t) return true;
    return !/[\w$)\]]$/.test(t);
  };
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
      continue;
    }
    const c = src[i];
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i += 1;
      out += " ";
      continue;
    }
    if (c === "`") {
      i += 1;
      let depth = 0;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (depth === 0 && src.slice(i, i + 2) === "${") {
          depth = 1;
          out += " ";
          i += 2;
          continue;
        }
        if (depth > 0) {
          if (src[i] === "{") depth += 1;
          else if (src[i] === "}") {
            depth -= 1;
            i += 1;
            out += " ";
            continue;
          }
          out += src[i];
          i += 1;
          continue;
        }
        if (src[i] === "`") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    if (c === "/" && regexAllowed()) {
      // A regex literal. Kept whole: a name can be spelled inside one.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        out += src.slice(i, j);
        i = j;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Every name a file imports from a relative ./lib/* specifier. */
function libImports(src: string): { name: string; local: string }[] {
  const found: { name: string; local: string }[] = [];
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']\.\/?lib\/[^"']+["']/g;
  for (const m of src.matchAll(re)) {
    for (const raw of m[2].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const [name, , alias] = part.split(/\s+(as)\s+/);
      found.push({ name: name.trim(), local: (alias ?? name).trim() });
    }
  }
  return found;
}

/**
 * The import declarations themselves, gone.
 *
 * BEFORE the scrub, not after: scrub() blanks the module specifier, so
 * `from "./lib/verbatim.ts"` becomes `from  ` and an import-stripping regex
 * that expects a quoted specifier no longer matches. The import line then
 * survives into the body, every imported name counts as a use of itself, and
 * the lint passes on everything — silently, which is the one failure mode a
 * check like this must not have. The last test in this file is here because
 * that is exactly what happened while it was being written.
 */
function stripImports(src: string): string {
  return src
    .replace(/^\s*import\s[\s\S]*?\sfrom\s*["'][^"']*["']\s*;?/gm, " ")
    .replace(/^\s*import\s*["'][^"']*["']\s*;?/gm, " ");
}

const SOURCES = ["extensions/notebook-tool.ts", "extensions/channel-update.ts"];

test("every name imported from lib/ is used by the file that imports it", () => {
  const dead: string[] = [];
  for (const rel of SOURCES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, "utf-8");
    const body = scrub(stripImports(src));
    for (const { local } of libImports(src)) {
      const uses = body.match(new RegExp(`\\b${local.replace(/\$/g, "\\$")}\\b`, "g")) ?? [];
      if (uses.length === 0) dead.push(`${rel}: ${local}`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    `imported from lib/ and never called — either wire it up or delete the import:\n  ${dead.join("\n  ")}`,
  );
});

test("the scrubber does not count a name that appears only in a comment", () => {
  const src = `// isFillerMessage is described here\nconst x = 1;\n`;
  assert.ok(!/isFillerMessage/.test(scrub(src)));
});

test("the scrubber does not count a name that appears only in a string", () => {
  assert.ok(!/matchDetourQuestion/.test(scrub(`const s = "call matchDetourQuestion";`)));
  assert.ok(!/matchDetourQuestion/.test(scrub(`const s = 'matchDetourQuestion';`)));
});

test("a template hole is code and survives the scrub", () => {
  assert.match(scrub("const s = `x ${bigramDice(a, b)} y`;"), /bigramDice/);
});

test("a regex literal survives, including one holding a quote", () => {
  assert.match(scrub(`const re = /^['"]none$/i;`), /none/);
  assert.match(scrub(`const u = /^https?:\\/\\/\\S+$/.test(x);`), /https/);
});

test("a division is not mistaken for a regex", () => {
  // `(a + b) / 2` must not swallow the rest of the file as a regex literal.
  assert.match(scrub("const avg = (a + b) / 2;\nconst keep = bigramDice(x);"), /bigramDice/);
});

test("this file's own lint would have failed on the tree that shipped #7", () => {
  // The disguise: the name WAS imported. Only the call was missing.
  const pretend = [
    `import { matchDetourQuestion, normMsg } from "./lib/verbatim.ts";`,
    `// matchDetourQuestion is what this should call`,
    `const x = normMsg("hi");`,
  ].join("\n");
  const body = scrub(stripImports(pretend));
  const names = libImports(pretend).map((i) => i.local);
  assert.deepEqual(names, ["matchDetourQuestion", "normMsg"]);
  assert.equal((body.match(/\bmatchDetourQuestion\b/g) ?? []).length, 0);
  assert.ok((body.match(/\bnormMsg\b/g) ?? []).length > 0);
});
