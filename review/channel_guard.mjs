#!/usr/bin/env node
/**
 * The static half of the channel gate. Run it on every change to channel.json,
 * and again on a schedule against the live `release` file — a tag can be
 * deleted long after it was promoted.
 *
 *   node review/channel_guard.mjs                     # ./channel.json
 *   node review/channel_guard.mjs --channel release   # the live one students read
 *   node review/channel_guard.mjs --channel <path|url>
 *   node review/channel_guard.mjs --against release   # also refuse to walk backwards
 *
 * Exits non-zero, loudly, on anything that could reach a student. Prints
 * `tags=v0.9.0,v0.9.1` on stdout for the boot job to matrix over.
 *
 * The checks exist because of what each failure does on a student's machine:
 * an unresolvable pin kills pi with a raw Node stack trace before any
 * extension loads, and a manifest entry pointing at a missing file is dropped
 * in silence — the extension simply ceases to exist and pi still exits 0. Both
 * are invisible to "did it exit cleanly".
 */
import { readFileSync } from "node:fs";

const REPO = "skojaku/pi-pair-notebook";
const RAW = (ref, file) => `https://raw.githubusercontent.com/${REPO}/${ref}/${file}`;
const PKG_NAME = "@skojaku/pi-pair-notebook";

/** Every file that must exist at a tag for a launch to be worth attempting. */
const REQUIRED = [
  "package.json",
  "extensions/notebook-tool.ts",
  "extensions/channel-update.ts",
];
/** Both must be in pi.extensions, and the updater must not be first. */
const MANIFEST_ORDER = ["extensions/notebook-tool.ts", "extensions/channel-update.ts"];

const TIMEOUT_MS = 20_000;
const TAG_RE = /^v\d+\.\d+\.\d+$/;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const problems = [];
const fail = (msg) => problems.push(msg);

async function getText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.text() };
}

async function loadChannel(where) {
  if (!where) return { label: "./channel.json", raw: readFileSync("channel.json", "utf-8") };
  if (/^https?:/.test(where)) {
    const r = await getText(where);
    if (!r.ok) throw new Error(`${where} -> HTTP ${r.status}`);
    return { label: where, raw: r.body };
  }
  if (/^[\w.\-/]+$/.test(where) && !where.includes(".json")) {
    const url = RAW(where, "channel.json");
    const r = await getText(url);
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return { label: url, raw: r.body };
  }
  return { label: where, raw: readFileSync(where, "utf-8") };
}

/**
 * Everything a single tag has to prove before students can be pointed at it.
 * All of it over raw.githubusercontent: api.github.com allows 60
 * unauthenticated calls an hour per IP, and CI shares its IP with the world.
 */
async function checkTag(tag, usedBy) {
  const at = (f) => `${tag} (${usedBy.join(", ")}): ${f}`;

  if (!TAG_RE.test(tag)) {
    fail(at(`not a vX.Y.Z tag`));
    return;
  }

  const pkgRes = await getText(RAW(tag, "package.json"));
  if (!pkgRes.ok) {
    // The one that ends the class. A pin naming a tag pi cannot resolve is
    // fatal before any extension loads, so nothing shipped in the package can
    // repair it.
    fail(at(`tag does not resolve on the remote (package.json -> HTTP ${pkgRes.status})`));
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(pkgRes.body);
  } catch (e) {
    fail(at(`package.json does not parse: ${e.message}`));
    return;
  }

  if (pkg.name !== PKG_NAME) fail(at(`package name is "${pkg.name}", expected "${PKG_NAME}"`));
  if (`v${pkg.version}` !== tag) {
    fail(at(`package.json says v${pkg.version} — tag and manifest must agree`));
  }

  const listed = pkg?.pi?.extensions;
  if (!Array.isArray(listed)) {
    fail(at(`pi.extensions is missing — the toolkit would silently not exist`));
  } else {
    for (const want of MANIFEST_ORDER) {
      if (!listed.includes(want)) fail(at(`pi.extensions does not list ${want}`));
    }
    if (
      listed.indexOf(MANIFEST_ORDER[1]) !== -1 &&
      listed.indexOf(MANIFEST_ORDER[1]) < listed.indexOf(MANIFEST_ORDER[0])
    ) {
      // Second, so notebook-tool.ts is already imported before the updater can
      // check a different tag out from under the loader.
      fail(at(`channel-update.ts is listed before notebook-tool.ts`));
    }
  }

  // A manifest entry whose file is missing is dropped without a word
  // (collectFilesFromPaths: `if (!existsSync(p)) continue`), so presence has to
  // be asserted rather than inferred from a clean exit.
  for (const f of REQUIRED) {
    if (f === "package.json") continue;
    const r = await getText(RAW(tag, f));
    if (!r.ok) fail(at(`${f} is missing at this tag (HTTP ${r.status})`));
  }
}

function cmpTag(a, b) {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const main = async () => {
  const { label, raw } = await loadChannel(opt("channel"));
  console.log(`channel: ${label}`);

  let ch;
  try {
    ch = JSON.parse(raw);
  } catch (e) {
    fail(`channel.json does not parse: ${e.message}`);
    throw new Error("unparseable");
  }

  if (ch.schema !== 1) fail(`schema is ${JSON.stringify(ch.schema)}, expected 1`);
  if (typeof ch.frozen !== "boolean") fail(`"frozen" must be present and boolean`);
  if (!ch.modules || typeof ch.modules !== "object" || Array.isArray(ch.modules)) {
    fail(`"modules" must be an object`);
    throw new Error("unusable");
  }

  const tags = new Map();
  for (const [id, entry] of Object.entries(ch.modules)) {
    const tag = entry?.toolkit;
    if (typeof tag !== "string") {
      fail(`${id}: "toolkit" must be a tag string`);
      continue;
    }
    if (!tags.has(tag)) tags.set(tag, []);
    tags.get(tag).push(id);
  }
  // Empty is a real state, not a mistake — but only the frozen one. A live
  // channel with no modules in it is a channel someone emptied by accident.
  if (tags.size === 0 && ch.frozen !== true) {
    fail(`no modules listed on a live channel — set "frozen": true if that is deliberate`);
  }

  // Printed because a mistyped module id is otherwise perfectly silent: it
  // matches no lesson/index.json, so those students simply never update and
  // nothing anywhere says so.
  for (const [tag, usedBy] of tags) console.log(`  ${tag}  <-  ${usedBy.join(", ")}`);

  for (const [tag, usedBy] of tags) await checkTag(tag, usedBy);

  // Refuse to walk students backwards by accident. An intentional rollback is
  // the whole point of the channel, so this is opt-out, not a wall.
  const against = opt("against");
  if (against && !args.includes("--allow-rollback")) {
    try {
      const live = JSON.parse((await loadChannel(against)).raw);
      for (const [id, entry] of Object.entries(ch.modules)) {
        const now = live?.modules?.[id]?.toolkit;
        const next = entry?.toolkit;
        if (typeof now === "string" && typeof next === "string" && TAG_RE.test(now)) {
          if (cmpTag(next, now) < 0) {
            fail(
              `${id}: ${next} is behind the live ${now} — pass --allow-rollback if that is deliberate`,
            );
          }
        }
      }
    } catch (e) {
      console.log(`note: could not read the live channel to compare (${e.message})`);
    }
  }

  if (ch.frozen === true) {
    console.log("NOTE: frozen=true — students will hold where they are.");
  }

  console.log(`tags=${[...tags.keys()].join(",")}`);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tags=${JSON.stringify([...tags.keys()])}\nfrozen=${ch.frozen === true}\n`,
    );
  }
};

try {
  await main();
} catch (e) {
  if (!problems.length) fail(String(e?.message ?? e));
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s) — NOT SAFE TO PROMOTE:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("\n✓ channel is safe to promote");
