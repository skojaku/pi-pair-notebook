/**
 * The update channel: how a fix reaches a student who has already started.
 *
 * A module pins this toolkit by tag in its .pi/settings.json. Rewriting that
 * pin is NOT enough — measured on pi 0.84.2: the startup path reuses an
 * existing clone as-is (getGitInstallPath keys on host/path with no ref
 * component, and resolve() never reconciles), so a module pinned v0.8.0 whose
 * pin is edited to v0.9.0 starts on v0.8.0 forever, without so much as a
 * FETCH_HEAD. Only the `pi update` / `pi install` CLI path reconciles. So this
 * file moves the checkout ITSELF and writes the pin to match.
 *
 * Which makes it the most dangerous file in the package: it can reach every
 * student at once. Four properties hold it down.
 *
 *   1. THE PIN IS ONLY EVER ADVANCED TO A TAG ALREADY ON THIS DISK. Fetch,
 *      check out and verify first; write the pin last. A pin naming a tag pi
 *      cannot resolve kills pi with a raw Node stack trace before any
 *      extension loads — nothing in this package could repair that, so the
 *      channel must never be able to create it.
 *   2. A TAG THAT DOES NOT COME UP IS ROLLED BACK, LOCALLY, WITHOUT ANYONE
 *      NOTICING IT. See "The two markers" below. One dead launch if the new
 *      code fails to load, two if it loads and then never comes up.
 *   3. NOTHING HERE CAN DELAY A LESSON. No awaited network I/O at load. The
 *      roll-forward runs off the critical path behind a hard deadline, and
 *      every failure — offline, timeout, bad JSON, unwritable file — leaves
 *      the pin exactly where it was. Failures are silent: the student is
 *      here for a lesson, not for our plumbing.
 *   4. IT NEVER SPEAKS TO THE STUDENT AND NEVER TOUCHES THEIR WORK. It writes
 *      two paths and no others: the module's .pi/settings.json, and its own
 *      state under ~/.pi/agent/. notebook.py, session_artifacts/ and assets/
 *      are the submission and are not ours.
 *
 * WHY A SEPARATE FILE, LOADED SECOND. dist/core/extensions/loader.js:439-448
 * loops over every extension path from every package with one try/catch per
 * path, so a sibling still loads — and its factory still runs — when
 * notebook-tool.ts throws at import. That is the only code that executes on a
 * launch pi has already decided to kill (main.js:718-724 exits 1 on any load
 * error), so the rollback lives in the factory here and runs synchronously:
 * async work would be cut off by that exit. Listed SECOND in package.json so
 * notebook-tool.ts is already imported before we check anything out from
 * under it.
 *
 * THE TWO MARKERS. notebook-tool.ts writes `loaded` as the first statement of
 * its factory, and `healthy` at the end of a session_start that actually came
 * up. Both are stamped with the tag captured at ITS import, before this file
 * can move the checkout. Absence of `loaded` on a pending tag means the new
 * code did not import — roll back now. Present-but-never-`healthy` across a
 * whole launch means it imported and then died — roll back on the next one.
 * The marker code is duplicated there on purpose: these two files must share
 * no code, or a syntax error takes both down and nothing is left to repair it.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The package this file was loaded from — the git clone pi checked out. */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The student's module folder. */
const MODULE_DIR = process.cwd();
const SETTINGS = path.join(MODULE_DIR, ".pi", "settings.json");
const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "pair-notebook-channel");
const STATE = path.join(STATE_DIR, "state.json");
const MARKERS = path.join(STATE_DIR, "markers");
/**
 * Backups of settings.json live HERE, not next to the file they back up.
 * `nb_submit` runs `git add -A`, and the module .gitignore covers `.pi/git/`
 * and friends but nothing shaped like `.pi/settings.json.bak-20260826T105048`
 * — so a backup written beside the original is a file the student hands in for
 * a grade. Three of them showed up in one afternoon of testing.
 */
const BACKUPS = path.join(STATE_DIR, "settings-backups");
/** Enough to undo a bad run by hand; not a place old files go to live. */
const KEEP_BACKUPS = 5;

/**
 * Where students read the approved tag. The `release` branch, not `main`:
 * main is where a tag is proposed, release is what CI promotes once it has
 * proved the tag boots. Branch protection is what makes that a gate rather
 * than a habit. raw.githubusercontent, never api.github.com — the API allows
 * 60 unauthenticated calls an hour per IP, and a lecture hall behind one
 * campus NAT is one IP.
 */
// One override, not two, and it moves both URLs together so a test exercises
// the same shape production does. It is for the review harness, which has to
// serve a channel it controls — update machinery nobody can run is update
// machinery nobody has tested. Not a security boundary: anyone who can set it
// can already edit .pi/settings.json by hand.
const RAW_BASE =
  process.env.PAIR_NOTEBOOK_CHANNEL_BASE ||
  "https://raw.githubusercontent.com/skojaku/pi-pair-notebook";
const CHANNEL_URL = `${RAW_BASE}/release/channel.json`;
/** Proves a tag resolves before we ask git for it. Same CDN, no rate limit. */
const TAG_PROBE = (tag: string) => `${RAW_BASE}/${tag}/package.json`;

const HTTP_TIMEOUT_MS = 8_000;
/** Whole roll-forward, network and git together. Abandoned past this. */
const FORWARD_DEADLINE_MS = 45_000;
/** A local checkout on a warm clone is milliseconds; this is a stuck-git guard. */
const GIT_LOCAL_TIMEOUT_MS = 15_000;
const GIT_NET_TIMEOUT_MS = 25_000;

/** Every file this package must have for a launch to be worth attempting. */
const REQUIRED = ["package.json", "extensions/notebook-tool.ts", "extensions/channel-update.ts"];

/**
 * `from` is the tag we left to get here, and it is not a nicety — it is the
 * only thing that makes a student's FIRST update recoverable.
 *
 * `lastKnownGood` is earned: a tag has to be pending and then reach `healthy`
 * before it is written down. On the launch that performs a student's first
 * ever move there is nothing earned yet, so a rollback would have had nowhere
 * to go — it would poison the bad tag and leave the clone and the pin sitting
 * on it, with `pending` cleared and session_start never firing again. That is
 * every student on the evening the channel is first unfrozen, all at once.
 *
 * `from` is written at the moment intent is recorded, from the tag that is
 * running right now: it imported, its factory ran, and session_start is
 * executing this very line — proof it comes up on THIS machine, which is
 * stronger evidence than a lastKnownGood from three weeks ago. And it is
 * certainly on disk, because it is what is checked out.
 */
type Pending = { tag: string; launches: number; from?: string };
type ModuleState = { lastKnownGood?: string; pending?: Pending; poisoned?: string[] };
type State = { schema: 1; modules: Record<string, ModuleState> };

// ── the smallest possible filesystem layer ──────────────────────────────────
// Everything here returns a value or a null; nothing throws upward. A channel
// that can raise inside a factory is a channel that can take the launch down
// on its own, which is the failure it exists to prevent.

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Temp file, fsync, rename — the shape applyCourseModels already uses in
 * notebook-tool.ts, and for the same reason: an interrupted write leaves
 * settings.json truncated, pi then starts with no tutor at all, and
 * SettingsManager refuses every later project write, so no code can repair
 * it. The student cannot be talked through restoring a backup from a shell.
 */
function writeAtomic(p: string, body: string): boolean {
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

/** Module folders are keyed by a hash: paths hold names, and this file is shared. */
const MODULE_KEY = createHash("sha256").update(MODULE_DIR).digest("hex").slice(0, 16);

function readState(): State {
  const s = readJson<State>(STATE);
  if (!s || s.schema !== 1 || typeof s.modules !== "object" || !s.modules) {
    return { schema: 1, modules: {} };
  }
  return s;
}

function mine(s: State): ModuleState {
  return (s.modules[MODULE_KEY] ??= {});
}

function saveState(s: State): void {
  writeAtomic(STATE, JSON.stringify(s, null, 2) + "\n");
}

function markerPath(kind: "loaded" | "healthy", tag: string): string {
  return path.join(MARKERS, `${MODULE_KEY}--${kind}--${tag}`);
}

const sawMarker = (kind: "loaded" | "healthy", tag: string) =>
  fs.existsSync(markerPath(kind, tag));

// ── what is actually checked out ────────────────────────────────────────────

/**
 * The tag the working tree currently holds, read from package.json rather than
 * from git. It is the same answer, it costs no subprocess, and it stays right
 * on a clone whose .git is damaged — which is exactly when we most need to
 * know. Returns null if the package is not intact enough to run.
 */
function checkedOutTag(): string | null {
  for (const f of REQUIRED) if (!fs.existsSync(path.join(PKG_ROOT, f))) return null;
  const pkg = readJson<{ version?: string }>(path.join(PKG_ROOT, "package.json"));
  return pkg?.version ? `v${pkg.version}` : null;
}

/** The tag THIS file was loaded from, captured before any checkout can move it. */
const RUNNING_TAG = checkedOutTag();

/**
 * Whether this copy is pi's own clone, and therefore ours to move.
 *
 * pi installs a git package into `<module>/.pi/git/<host>/<owner>/<repo>`. It
 * also supports a local PATH package, loaded in place and not copied — which is
 * how the review harness and `tools/fetch_software.sh` run the toolkit from a
 * working tree. `git checkout --force` in one of those discards whatever the
 * author had not committed yet. The channel exists to repair student machines,
 * not to reach into a checkout somebody is editing, so anything that is not the
 * managed clone is left strictly alone.
 */
const IS_MANAGED_CLONE = (() => {
  const marker = `${path.sep}.pi${path.sep}git${path.sep}`;
  if (!PKG_ROOT.includes(marker)) return false;
  return fs.existsSync(path.join(PKG_ROOT, ".git"));
})();

// ── git, on a short leash ───────────────────────────────────────────────────

function gitSync(args: string[], timeout: number): boolean {
  try {
    const r = spawnSync("git", ["-C", PKG_ROOT, ...args], {
      timeout,
      stdio: "ignore",
      // A private remote would prompt for a password and hang the terminal
      // with no output at all. There is no interactive git here, ever.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function gitAsync(args: string[], timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    try {
      const p = spawn("git", ["-C", PKG_ROOT, ...args], {
        stdio: "ignore",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
      });
      const timer = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(false);
      }, timeout);
      p.on("error", () => {
        clearTimeout(timer);
        finish(false);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    } catch {
      finish(false);
    }
  });
}

// ── the pin ─────────────────────────────────────────────────────────────────

const PIN_RE = /^git:github\.com\/skojaku\/pi-pair-notebook@/;

/**
 * Rewrites ONLY our own git entry and leaves the rest of the array — and the
 * rest of the file — alone. The npm companion in particular must never be
 * touched: npm pins ARE version-checked on every startup, and a bad one is a
 * hard exit that reaches already-installed students too.
 *
 * Refuses a settings.json that does not already parse. "Repairing" a file we
 * do not understand is how a soft failure becomes an unrecoverable one.
 */
function writePin(tag: string): boolean {
  const data = readJson<{ packages?: unknown[] }>(SETTINGS);
  if (!data || !Array.isArray(data.packages)) return false;

  let touched = false;
  const packages = data.packages.map((entry) => {
    if (typeof entry !== "string" || !PIN_RE.test(entry)) return entry;
    const next = `git:github.com/skojaku/pi-pair-notebook@${tag}`;
    if (next !== entry) touched = true;
    return next;
  });
  if (!touched) return true;

  const body = JSON.stringify({ ...data, packages }, null, 2) + "\n";
  // Parse the bytes we are about to commit to. Cheap, and it is the last
  // place a serialisation fault can be caught before it reaches the disk pi
  // reads at startup.
  try {
    JSON.parse(body);
  } catch {
    return false;
  }
  backup();
  return writeAtomic(SETTINGS, body);
}

/** Keeps the last few copies of settings.json, well outside the submission. */
function backup(): void {
  try {
    fs.mkdirSync(BACKUPS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    fs.copyFileSync(SETTINGS, path.join(BACKUPS, `${MODULE_KEY}--${stamp}.json`));
    const mine = fs
      .readdirSync(BACKUPS)
      .filter((f) => f.startsWith(`${MODULE_KEY}--`))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) {
      fs.rmSync(path.join(BACKUPS, old), { force: true });
    }
  } catch {
    /* a backup we could not take is not a reason to skip an atomic write */
  }
}

function pinnedTag(): string | null {
  const data = readJson<{ packages?: unknown[] }>(SETTINGS);
  if (!data || !Array.isArray(data.packages)) return null;
  for (const entry of data.packages) {
    if (typeof entry === "string" && PIN_RE.test(entry)) return entry.split("@").pop() ?? null;
  }
  return null;
}

// ── reconcile: the life-saving half, synchronous, in the factory ────────────

/**
 * Runs on every launch, local only, before anything can go wrong. Decides
 * what the previous launch proved about the tag we moved to, and undoes the
 * move if it proved the wrong thing.
 *
 * Synchronous on purpose. On a launch where notebook-tool.ts failed to import,
 * pi prints its diagnostics and calls process.exit(1) immediately after the
 * loader returns; a promise scheduled here would never run. Local git on a
 * warm clone is milliseconds, and the tag is already fetched — that is
 * guaranteed by rollForward, which never records a pending tag it has not
 * already materialised.
 */
function reconcile(): void {
  if (!IS_MANAGED_CLONE) return;
  const state = readState();
  const me = mine(state);
  const pending = me.pending;
  if (!pending) return;

  const onDisk = checkedOutTag();

  // The move never actually landed (interrupted between recording intent and
  // checking out). Not the tag's fault — forget it, do not poison a tag that
  // was never given a chance.
  if (onDisk !== pending.tag) {
    delete me.pending;
    saveState(state);
    return;
  }

  if (sawMarker("healthy", pending.tag)) {
    me.lastKnownGood = pending.tag;
    delete me.pending;
    saveState(state);
    return;
  }

  // notebook-tool.ts's factory runs before ours and writes `loaded` first
  // thing. Nothing there means the new code did not import at all, and pi is
  // already going to exit — roll back now so the next launch is the good one.
  const loadedThisLaunch = sawMarker("loaded", pending.tag);
  if (loadedThisLaunch && pending.launches < 1) {
    pending.launches = 1;
    saveState(state);
    return;
  }

  rollback(state, me, pending, loadedThisLaunch ? "never came up" : "did not load");
}

function rollback(state: State, me: ModuleState, pending: Pending, _why: string): void {
  const bad = pending.tag;
  (me.poisoned ??= []).push(bad);
  delete me.pending;

  // `from` first: it is the tag this student was actually running one launch
  // ago, so it is both more recent and better evidenced than lastKnownGood —
  // and on a first-ever update it is the only one of the two that exists.
  const good = pending.from ?? me.lastKnownGood;
  if (!good || good === bad) {
    // Nowhere to go back to. Recording the poison is still worth doing: it
    // stops the channel walking this student into the same tag again.
    saveState(state);
    return;
  }

  gitSync(["checkout", "--force", good], GIT_LOCAL_TIMEOUT_MS);
  // The pin goes back even when the checkout failed. It costs nothing, and it
  // is what makes `pi install git:...@<good> -l -a` — the printed rescue — put
  // a broken working tree right instead of reinstating the bad tag.
  writePin(good);
  saveState(state);
}

// ── roll forward: the useful half, async, off the critical path ─────────────

async function getJson(url: string, signal: AbortSignal): Promise<any | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]),
      headers: { accept: "application/json", "cache-control": "no-cache" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function rollForward(): Promise<void> {
  // Every way a student, an instructor or pi itself can say "not now".
  if (process.env.PAIR_NOTEBOOK_NO_UPDATE || process.env.PI_OFFLINE) return;
  if (!IS_MANAGED_CLONE || !RUNNING_TAG) return;

  const deadline = AbortSignal.timeout(FORWARD_DEADLINE_MS);

  const channel = await getJson(CHANNEL_URL, deadline);
  if (!channel || channel.schema !== 1 || channel.frozen === true) return;

  const moduleId = readJson<{ module?: string }>(
    path.join(MODULE_DIR, "lesson", "index.json"),
  )?.module;
  if (!moduleId) return;

  const target = channel.modules?.[moduleId]?.toolkit;
  if (typeof target !== "string" || !/^v\d+\.\d+\.\d+$/.test(target)) return;

  const state = readState();
  const me = mine(state);
  if (me.pending) return; // a move is already in flight; one at a time
  if (me.poisoned?.includes(target)) return;

  const onDisk = checkedOutTag();
  if (onDisk === target) {
    // Already running it. Make the pin agree — a pin that disagrees with the
    // working tree is how one student gets reinstalled onto a different
    // version than the one that taught their lesson.
    if (pinnedTag() !== target) writePin(target);
    if (me.lastKnownGood !== target && sawMarker("healthy", target)) {
      me.lastKnownGood = target;
      saveState(state);
    }
    return;
  }

  // Property 1: prove the tag resolves BEFORE git is asked for it, and prove
  // it is this package at that version. A pin pi cannot resolve is fatal
  // before any of our code exists, so this check is the whole safety margin.
  const probe = await getJson(TAG_PROBE(target), deadline);
  if (!probe || probe.name !== "@skojaku/pi-pair-notebook" || `v${probe.version}` !== target) {
    return;
  }

  if (!(await gitAsync(["fetch", "--tags", "origin", target], GIT_NET_TIMEOUT_MS))) return;
  if (deadline.aborted) return;

  // Record the intent before moving. If we die between here and a verified
  // checkout, reconcile() sees pending.tag !== what is on disk and drops it
  // without poisoning.
  me.pending = { tag: target, launches: 0, from: RUNNING_TAG };
  // Also earned, right here: whatever is running has reached session_start on
  // this machine, which is exactly the bar `healthy` sets. Unconditional, not
  // ??=, because fresh evidence beats a stale entry.
  me.lastKnownGood = RUNNING_TAG;
  saveState(state);

  await gitAsync(["checkout", "--force", target], GIT_LOCAL_TIMEOUT_MS);
  // Judged on what is on disk, never on git's exit code. A checkout that lost
  // a race for index.lock reports failure over a tree that is already correct,
  // and reverting that would undo a move that had in fact landed.
  if (checkedOutTag() !== target) {
    // Put the tree back where it was and forget the whole thing.
    await gitAsync(["checkout", "--force", RUNNING_TAG], GIT_LOCAL_TIMEOUT_MS);
    const s2 = readState();
    delete mine(s2).pending;
    saveState(s2);
    return;
  }

  // Property 1 again, this time against what actually landed on disk: the tag
  // is here, complete, and says what it should. Only now does the pin move.
  if (!writePin(target)) {
    await gitAsync(["checkout", "--force", RUNNING_TAG], GIT_LOCAL_TIMEOUT_MS);
    const s3 = readState();
    delete mine(s3).pending;
    saveState(s3);
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Synchronous, local, and wrapped: whatever happens in here, the launch
  // proceeds exactly as it would have without this file.
  try {
    reconcile();
  } catch {
    /* never our turn to end a session */
  }

  pi.on("session_start", async () => {
    // Deliberately not awaited into the startup path, and with a terminal
    // catch: an unhandled rejection reaches pi's late uncaughtException
    // handler, which exits 1 — a channel that crashes the lesson it was
    // built to repair.
    void rollForward().catch(() => {});
  });
}
