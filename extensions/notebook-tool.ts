/**
 * Notebook toolkit for the tutoring session.
 *
 * Gives the tutor agent small, high-level tools (nb_add_cell, nb_edit_cell,
 * nb_delete_cell, nb_read, nb_run) instead of raw bash + marimo code-mode
 * boilerplate. The extension generates the `cm` ceremony itself, which:
 *   - cuts token usage (the model sends only the cell body),
 *   - removes a whole class of errors observed in real sessions:
 *       cold kernel (cells never run)      -> warm-up call before every op
 *       redundant mo/nx/np/plt imports     -> stripped automatically
 *       editing a nonexistent cell         -> pre-check, returns cell list
 *   - keeps the student's terminal quiet: each call renders as one friendly
 *     status line ("📝 Setting up your first question…") with output hidden
 *     behind the expand keybinding. The LLM still receives full output.
 *
 * Upload boxes carry a 📨 Send to my tutor button: pressing it appends to
 * session_artifacts/student_signal.txt, which the watcher below turns into a
 * turn, so the tutor never has to ask whether the photo is up. Everything
 * else the student explores (sliders, widgets) has no button — they say so
 * in the terminal and the tutor reads the values with nb_read.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
// The pure half of this toolkit, in files a test runner can reach. Nothing
// under a tool is on any boot path — `pi -p "hi"` enters the factory and
// session_start and stops — so anything that can be a function of its
// arguments belongs there, where `npm test` runs it. See lib/verbatim.ts.
// The `.ts` in the specifier is deliberate: it is the one form both node's
// type-stripping and pi's jiti loader accept, so one source file serves both
// with no build step.
import {
  answerCountForGate,
  baseCheckpointId,
  capturePick,
  driftIsReportable,
  handoffCutPoint,
  renderNoteSkeleton,
  matchDetourQuestion,
  normMsg,
  notebookBanner,
  NOTEBOOK_BANNER_PREFIX,
  type PickRecord,
  quoteIsBacked,
  rewriteRivalServer,
  slotDrift,
  SLOT_GLUE,
  slotTokens,
  snapToTranscript,
  scriptedQuestionCount,
  snapCheckpointId as snapIdAgainst,
  souvenirVerdict,
  STUCK_ANSWERS,
  stripModelQuoteLines,
  withQuotedQuestion,
} from "./lib/verbatim.ts";
import {
  kernelRefusal,
  py,
  pyList,
  pyMd,
  sanitize,
  scanKernelCode,
  stripRedundantImports,
} from "./lib/pysrc.ts";

/** This file's directory. */
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── Health markers for the update channel ───────────────────────────────────
// channel-update.ts moves this package's checkout to a newer tag and rolls it
// back when the new one does not come up. These two markers are how it knows
// which happened: `loaded` is written the moment this file's factory runs,
// `healthy` only after a session_start that actually got a chapter on screen.
//
// Duplicated there rather than imported from there, deliberately: the two
// files must share no code. A shared helper with a syntax error in it takes
// down the toolkit AND the thing that repairs the toolkit, and nothing is
// left on the student's machine that can undo the release.
//
// RUNNING_TAG is read at import, before any checkout can move it — so a
// marker always names the code that actually ran, never the pin.
const CHANNEL_MARKERS = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pair-notebook-channel",
  "markers",
);
const CHANNEL_MODULE_KEY = createHash("sha256")
  .update(process.cwd())
  .digest("hex")
  .slice(0, 16);
const RUNNING_TAG: string | null = (() => {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(EXT_DIR, "..", "package.json"), "utf-8"),
    )?.version;
    return v ? `v${v}` : null;
  } catch {
    return null;
  }
})();

function markChannel(kind: "loaded" | "healthy"): void {
  if (!RUNNING_TAG) return;
  try {
    fs.mkdirSync(CHANNEL_MARKERS, { recursive: true });
    fs.writeFileSync(
      path.join(CHANNEL_MARKERS, `${CHANNEL_MODULE_KEY}--${kind}--${RUNNING_TAG}`),
      "",
    );
  } catch {
    /* a marker we cannot write costs a rollback we did not need, never a lesson */
  }
}


/**
 * Ask the browser to bring a cell into view (marimo's focus-cell op) — new
 * content should greet the student, not hide below the fold. Wrapped in
 * try/except so a marimo-internals change can never fail the operation.
 */
const focusCellCode = (cellIdExpr: string, indent: string) =>
  `${indent}try:\n` +
  `${indent}    from marimo._messaging.notification import FocusCellNotification as _FCN\n` +
  `${indent}    ctx.broadcast_raw_notification(_FCN(cell_id=${cellIdExpr}))\n` +
  `${indent}except Exception:\n` +
  `${indent}    pass\n`;

/**
 * Python source of the improvised-cell review (nb_review.py), prepended to
 * the kernel call that creates the cell. Missing file = review skipped.
 */
let reviewSrcCache: string | null = null;
function reviewSource(): string {
  if (reviewSrcCache === null) {
    // Beside this file inside the package; the cwd path is the pre-package
    // layout, kept so an older module folder still reviews its cells.
    const candidates = [
      path.join(EXT_DIR, "nb_review.py"),
      path.join(process.cwd(), ".pi", "extensions", "nb_review.py"),
    ];
    reviewSrcCache = "";
    for (const c of candidates) {
      try {
        reviewSrcCache = fs.readFileSync(c, "utf-8");
        break;
      } catch {
        /* try the next one */
      }
    }
  }
  return reviewSrcCache ?? "";
}

const indentBlock = (s: string, n: number) =>
  s
    .split("\n")
    .map((l) => (l.trim() ? " ".repeat(n) + l : l))
    .join("\n");

const BOOTSTRAP =
  `import marimo._code_mode as cm\n` +
  `async with cm.get_context() as ctx:\n` +
  `    for _c in list(ctx.cells):\n` +
  `        ctx.run_cell(_c.id)\n`;

// ---------------------------------------------------------------------------
// Talking to the marimo kernel.
//
// Two HTTP calls, and that is the whole protocol:
//   GET  /api/sessions          -> { "<session id>": { path, filename }, ... }
//   POST /api/kernel/execute    -> an SSE stream of stdout / stderr / done
//
// This used to be marimo-pair's execute-code.sh, spawned through bash for every
// nb_* call. That cost a bash + curl process per call and, worse, put `jq` and
// `curl` on the list of things a student has to install — on Windows, where
// Git Bash ships curl but not jq, that was the single most likely thing to
// stop a first evening dead. Node speaks HTTP; nothing here needs a shell.
// ---------------------------------------------------------------------------

const KERNEL_TIMEOUT_MS = 180_000;
/** How long a nb_* call waits for the student's notebook page to attach. */
const SESSION_WAIT_MS = 90_000;

// ---------------------------------------------------------------------------
// The notebook server.
//
// This used to be a launcher script: start marimo, poll its log for a URL,
// export MARIMO_URL, open a browser, start pi, kill marimo on exit. That script
// was bash — which made Windows a support problem — and it lived in every
// module folder, so fixing it meant editing every copy. It belongs here: the
// package is versioned, pinned by tag, and Node already knows how to spawn a
// process on three platforms.
//
// Nothing is awaited at startup. The student's first turn is a greeting, and
// uv's first sandbox build can take a minute; the first nb_* call is where
// waiting actually costs something, so that is where the wait happens.
// ---------------------------------------------------------------------------

const MARIMO_BOOT_MS = 180_000;

/** Set when the extension loads; the server lifecycle lives at module level
 *  because process signals do, and it occasionally needs to speak to the
 *  tutor (a page that would not open by itself). */
let piRef: any = null;

let marimoProc: ReturnType<typeof spawn> | null = null;
let marimoStart: Promise<{ url?: string; error?: string }> | null = null;

/** An externally supplied server (the review harness, or an instructor running
 *  marimo by hand) wins: never start a second one.
 *
 *  Read ONCE, at load. marimoUrl() writes our own URL into the same variable
 *  so that nb_run's student code can find it, so anything asking later cannot
 *  tell "the harness gave us a server" from "we started one" — and the restart
 *  path below has to know the difference. */
const EXTERNAL_MARIMO = /^https?:\/\/\S+$/.test(process.env.MARIMO_URL ?? "");
const externalMarimo = () => EXTERNAL_MARIMO;

/** The student's own copy, made on first run so the template stays pristine. */
function bootstrapNotebook(): void {
  try {
    const nb = path.join(process.cwd(), "notebook.py");
    const tpl = path.join(process.cwd(), "notebook.template.py");
    if (!fs.existsSync(nb) && fs.existsSync(tpl)) fs.copyFileSync(tpl, nb);
    // marimo's session snapshot RESTORES pressed buttons, and the cells behind
    // ours have side effects: every send button appends a line to
    // student_signal.txt, which the watcher below reads as the student acting
    // right now. So a session that reopens one of those snapshots replays the
    // last press. A gate run caught the worst version — the ⚖️ appeal replayed
    // one second after boot, and a nervous novice's first turn carried a
    // referee verdict about a case they never filed, on a session where
    // nothing had happened yet. The photo and code send buttons replay the
    // same way: the tutor is told a photo just arrived, and goes looking at
    // the last session's picture. Drop the snapshot before the server starts;
    // a live session re-runs every cell anyway and writes a fresh one.
    const snap = path.join(process.cwd(), "__marimo__", "session", "notebook.py.json");
    if (fs.existsSync(snap)) fs.rmSync(snap, { force: true });
  } catch {
    // startMarimo will fail loudly enough if this mattered
  }
}

function openInBrowser(url: string, onFailure: () => void): void {
  // WSL first on Linux: xdg-open exists there but opens nothing a student sees.
  const attempts: [string, string[]][] =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : [
            ["wslview", [url]],
            ["xdg-open", [url]],
            ["explorer.exe", [url]],
          ];
  const tryNext = (i: number) => {
    if (i >= attempts.length) return onFailure();
    const [cmd, args] = attempts[i];
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      let settled = false;
      const next = () => {
        if (settled) return;
        settled = true;
        tryNext(i + 1);
      };
      child.on("error", next);
      // "The command exists" is not "the page opened". On WSL and on a
      // locked-down desktop, xdg-open is present and exits non-zero — and
      // because only the ENOENT path was watched, neither the next opener nor
      // onFailure ever ran. The student was left with a notebook nobody had
      // opened, no kernel, and a tutor that had not been told to say the URL
      // out loud. Give it a moment to fail before believing it.
      child.on("exit", (code) => {
        if (code) next();
        else settled = true;
      });
      const grace = setTimeout(() => (settled = true), 4000);
      (grace as any).unref?.();
      child.unref();
    } catch {
      tryNext(i + 1);
    }
  };
  tryNext(0);
}

function startMarimo(): Promise<{ url?: string; error?: string }> {
  const cwd = process.cwd();
  bootstrapNotebook();
  let log: fs.WriteStream | null = null;
  try {
    fs.mkdirSync(path.join(cwd, "session_artifacts"), { recursive: true });
    // Append, not truncate: a restart that erased the previous server's last
    // words would delete the only record of why it died.
    log = fs.createWriteStream(path.join(cwd, "session_artifacts", "marimo_server.log"), {
      flags: "a",
    });
  } catch {
    // a missing log is survivable; a missing server is not
  }
  return new Promise((resolve) => {
    let settled = false;
    let seen = "";
    let bootTimer: any = null;
    const done = (r: { url?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      // Or the timer holds the event loop open for three minutes after the
      // server is already up, and pi cannot exit when the student says bye.
      if (bootTimer) clearTimeout(bootTimer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "uvx",
        ["marimo", "edit", "--sandbox", "--no-token", "--headless", "notebook.py"],
        // Its own process group, so stopMarimo can take down the whole
        // uv -> python -> marimo chain rather than just the wrapper.
        { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e: any) {
      return done({ error: `could not start the notebook server: ${e?.message ?? e}` });
    }
    marimoProc = child;
    // The FIRST url marimo prints is not always the one it ends up serving.
    // `--sandbox` makes it re-exec itself inside an isolated uv environment,
    // and the second process binds again — on a different port when the first
    // one is taken, which on a machine running more than one session it often
    // is. Settling on the first match left the tutor talking to a port nothing
    // was listening on, while a perfectly good server ran next door: every
    // nb_* call failed, the student saw "something hiccuped", and the log
    // recorded a URL that answered a curl by hand. Seen twice in one gate run.
    //
    // So a candidate is not a server until it answers. Take the newest URL
    // printed, poll it, and abandon that poll the moment a newer one appears.
    let candidate = "";
    const verify = async (url: string) => {
      for (let i = 0; i < 60 && !settled && candidate === url; i++) {
        try {
          const res = await fetch(`${url}/api/sessions`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (res.ok) return done({ url });
        } catch {
          // not up yet, or not this port at all
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    const scan = (chunk: Buffer) => {
      log?.write(chunk);
      seen += chunk.toString();
      const all = seen.match(/http:\/\/[A-Za-z0-9.\-]+:\d+/g) ?? [];
      const latest = all[all.length - 1];
      if (latest && latest !== candidate) {
        candidate = latest;
        void verify(latest);
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (e: any) =>
      done({
        error:
          e?.code === "ENOENT"
            ? "uv is not installed, so the notebook cannot start (install it: https://docs.astral.sh/uv/)"
            : `could not start the notebook server: ${e?.message ?? e}`,
      }),
    );
    child.on("exit", (code) =>
      done({
        error: `the notebook server stopped (exit ${code}) — session_artifacts/marimo_server.log has why`,
      }),
    );
    bootTimer = setTimeout(
      () => done({ error: "the notebook server did not come up in time" }),
      MARIMO_BOOT_MS,
    );
  });
}

/**
 * Say where the notebook is, to the STUDENT, in this toolkit's own words.
 *
 * The address used to be spoken only from openInBrowser's failure branch, and
 * on macOS `open <url>` exits 0 the moment it has handed the URL to a browser
 * — so a page that opened behind the terminal, on another Space, or in a
 * browser nobody was watching was a SUCCESS, and the URL was never said. All
 * three submitted m01 sessions began with a student who could not find their
 * notebook; two of them lost 21 minutes and 22 hours of a graded session to
 * it. The tutor cannot say an address nobody has told it, and what it does
 * with the gap is invent one (see nb_notebook_url).
 *
 * Printed, not asked for. A note to the tutor would only move the improvising
 * one step earlier. This is the one other message in the toolkit written for
 * the student to act on rather than read, and it renders like the other one.
 *
 * Never a guessed address: marimoBase() falls back to 127.0.0.1:2718, and
 * startMarimo's own comment records that the port often is not that — a
 * printed guess is worse than silence.
 */
let announcedNotebook = false;
function announceNotebook(url: string, opened: boolean): void {
  const body = notebookBanner(`${url.replace(/\/+$/, "")}/?view-as=present`, opened);
  if (!body) return;
  if (opened && announcedNotebook) return;
  announcedNotebook = true;
  try {
    piRef?.sendMessage(
      { customType: "notebook-url", content: body, display: true },
      // NOT "nextTurn": that parks the message until some later turn runs, and
      // the whole point is that the student sees it before they need it.
      { triggerTurn: false },
    );
  } catch {
    /* best effort — nb_notebook_url is still there */
  }
}

/** Start the server once, remember the result, open the student's page. */
function marimoUrl(): Promise<{ url?: string; error?: string }> {
  if (externalMarimo()) return Promise.resolve({ url: marimoBase() });
  if (!marimoStart) {
    marimoStart = startMarimo().then((r) => {
      if (!r.url) return r;
      // Everything downstream reads the env var, including a nb_run the
      // student's own code might make.
      process.env.MARIMO_URL = r.url;
      openInBrowser(`${r.url}/?view-as=present`, () => {
        // No browser opener on this machine at all — say it again, harder,
        // because a notebook nobody has open is a kernel that never wakes.
        announcedNotebook = false;
        announceNotebook(r.url!, false);
        try {
          piRef?.sendMessage(
            {
              customType: "notebook-note",
              content:
                `NOTE (invisible to the student): their notebook page did not open by itself, ` +
                `and they have been shown its address. If they say they cannot see it, call ` +
                `nb_notebook_url and read them what it returns — never ask them to start the ` +
                `notebook themselves.`,
              display: false,
            },
            { deliverAs: "nextTurn" },
          );
        } catch {
          /* best effort */
        }
      });
      return r;
    });
  }
  return marimoStart;
}

/**
 * Bring a server we started back after it died, and reopen the student's page.
 *
 * A lesson runs 60-90 minutes and outlives a lot: the laptop sleeps, the tab
 * gets closed, marimo is OOM-killed. Before this existed any one of those
 * ended the notebook for the rest of the session — the tutor said "the
 * whiteboard needs a restart" (it is told to), the student had no way to
 * restart it, and every remaining checkpoint went unbuilt while the graded
 * artifact stopped growing. Killing marimo mid-checkpoint in a live run left
 * exactly that: a session that talked its way to the end with nothing on the
 * page.
 *
 * Never touches a server someone else started — the review harness pins one
 * on purpose, and an instructor running marimo by hand would not thank us.
 * Rate-limited, so a genuinely unstartable server (no uv, a busy port) costs
 * one boot attempt per minute rather than one per tool call.
 */
const RELAUNCH_COOLDOWN_MS = 60_000;
let lastRelaunch = 0;
let lastReopen = 0;

/**
 * Put the student's notebook tab back. A marimo kernel exists only while a
 * browser client is attached, so a closed tab is indistinguishable, from
 * here, from a dead server — except that it is far commoner and far cheaper
 * to fix. Works for a harness-supplied server too: reopening someone else's
 * page costs them nothing.
 */
function reopenPage(): boolean {
  if (Date.now() - lastReopen < RELAUNCH_COOLDOWN_MS) return false;
  lastReopen = Date.now();
  try {
    openInBrowser(`${marimoBase()}/?view-as=present`, () => {});
    return true;
  } catch {
    return false;
  }
}

async function relaunchMarimo(): Promise<boolean> {
  if (externalMarimo()) return false;
  if (Date.now() - lastRelaunch < RELAUNCH_COOLDOWN_MS) return false;
  lastRelaunch = Date.now();
  stopMarimo(); // clears the cached start promise, and reaps a half-dead chain
  try {
    const r = await marimoUrl();
    return !!r.url;
  } catch {
    return false;
  }
}

function stopMarimo(): void {
  const child = marimoProc;
  marimoProc = null;
  marimoStart = null;
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM"); // the group, not just uvx
    }
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* it is already gone */
    }
  }
}

// session_shutdown is the normal path; these catch the rest (Ctrl-C, a crash),
// because a marimo left running holds port 2718 against the next session.
for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => stopMarimo());
}

/** Guard against a garbage env value (a broken grep once exported
 *  "Binary file ... matches" as the URL and every call failed). */
function marimoBase(): string {
  const envUrl = process.env.MARIMO_URL ?? "";
  const url = /^https?:\/\/\S+$/.test(envUrl) ? envUrl : "http://127.0.0.1:2718";
  return url.replace(/\/+$/, "");
}

function marimoHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = process.env.MARIMO_TOKEN;
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

/**
 * The shell the toolkit thought it had taken away. The scan itself is in
 * lib/pysrc.ts, where `npm test` runs it; this is the door.
 *
 * NOT strike-capped, and that is a deliberate departure from every other
 * refusal in this file. The capped ones — slot drift, the cell review, the
 * build order, the late close — stand between the student and their RECORD,
 * so a guard that will not let go can strand them at a checkpoint they have
 * already finished. This one stands between the model and a CAPABILITY, and
 * nothing on the graded path goes through a refused name: the toolkit writes
 * the log, the notes, the summary and the photo saves itself. Three strikes
 * and then the port scan runs is not a backstop, it is a delay.
 *
 * The way out is an environment variable an instructor can set and the model
 * cannot reach.
 */
function kernelGuard(code: string): string | null {
  if (process.env.PAIR_NOTEBOOK_KERNEL_UNSAFE === "1") return null;
  const scan = scanKernelCode(code);
  return scan.ok ? null : kernelRefusal(scan.hits);
}

/** What the tutor is told when the notebook cannot be reached at all. */
const NO_NOTEBOOK =
  "The notebook is not reachable, so nothing can be built or read there right now. " +
  "Tell the student, in one warm sentence, that the notebook needs restarting — then " +
  "keep teaching in the terminal.";

/**
 * Which kernel session to run in. Resolved per call, never cached: marimo
 * renames a session when the browser reconnects, and a stale id fails in a way
 * that looks like broken code rather than a broken connection.
 */
type SessionLookup = {
  id?: string;
  error?: string;
  /** Why it failed, so the caller can pick the right repair: a server that is
   *  gone needs restarting, a page the student closed only needs reopening —
   *  and restarting a healthy server to fix a closed tab costs the student a
   *  minute and a half of silence for nothing. */
  reason?: "unreachable" | "no-page" | "ambiguous";
};

async function resolveSession(signal: AbortSignal): Promise<SessionLookup> {
  let sessions: Record<string, { path?: string; filename?: string }> = {};
  let ids: string[] = [];
  // A marimo kernel exists only while a browser client is attached. The page is
  // opened for the student the moment the server reports its URL, but a cold
  // laptop can take a while to render it — and the first nb_* call can easily
  // arrive first. Waiting here is invisible; failing here costs the tutor a
  // checkpoint and the student an apology for something that was about to work.
  const deadline = Date.now() + SESSION_WAIT_MS;
  // If nothing has attached after a few seconds, the likeliest reason is not
  // a slow laptop but a tab that was closed — students close tabs. Put it
  // back while we are still waiting, rather than spending the full ninety
  // seconds first and only then noticing. Rate-limited inside reopenPage, so
  // a machine with no browser opener at all does not get spammed.
  const nudgeAt = Date.now() + 8_000;
  let nudged = false;
  for (;;) {
    try {
      const res = await fetch(`${marimoBase()}/api/sessions`, {
        headers: marimoHeaders(),
        signal,
      });
      if (!res.ok)
        return { error: `${NO_NOTEBOOK} (server said ${res.status})`, reason: "unreachable" };
      sessions = (await res.json()) as typeof sessions;
    } catch {
      return { error: NO_NOTEBOOK, reason: "unreachable" };
    }
    ids = Object.keys(sessions ?? {});
    if (ids.length > 0) break;
    if (Date.now() >= deadline || signal.aborted) {
      // WITH the address. "Ask the student to open the notebook tab" was an
      // instruction the tutor could not carry out: it had never been told
      // where the tab is, and what it did with that gap was tell a student to
      // start a second server.
      return {
        reason: "no-page",
        error:
          "The notebook page is not open, so its kernel is asleep and nothing can be built " +
          "there. Ask the student to open " +
          (/^https?:\/\/\S+$/.test(process.env.MARIMO_URL ?? "")
            ? `${marimoBase()}/?view-as=present — that exact address, in one sentence`
            : "the notebook tab (it may have been closed)") +
          " — and keep teaching in the terminal meanwhile. Never ask them to start the " +
          "notebook themselves.",
      };
    }
    if (!nudged && Date.now() >= nudgeAt) {
      nudged = true;
      reopenPage();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (ids.length === 1) return { id: ids[0] };
  // More than one notebook on this server: pick ours by path. Exact first —
  // the basename rule matches any notebook.py anywhere, which is a fallback
  // for a marimo that reports paths differently, not a way to choose.
  const want = path.join(process.cwd(), "notebook.py");
  const exact = ids.filter((id) => {
    const s = sessions[id] ?? {};
    return s.path === want || s.filename === want;
  });
  const mine = exact.length
    ? exact
    : ids.filter((id) => {
        const s = sessions[id] ?? {};
        return path.basename(s.path ?? s.filename ?? "") === "notebook.py";
      });
  // Ambiguity used to be fatal, and fatal here means fatal for the session:
  // the error carried NO_NOTEBOOK, which tells the tutor to announce that the
  // whiteboard needs restarting and finish in the terminal — over a server
  // that is running, healthy, and holding the student's own notebook. Guessing
  // wrong costs one cell in the wrong page; refusing costs the artifact. So
  // take the first match and keep going.
  if (mine.length >= 1) return { id: mine[0] };
  return {
    reason: "ambiguous",
    error: `No open notebook matches this folder (${ids.length} on the server). ${NO_NOTEBOOK}`,
  };
}

/**
 * Run Python in the notebook's scratchpad and return everything it printed.
 *
 * `failed` is true when the kernel reported an error, when the stream ended
 * without a `done` event (the code never ran), or when the server could not be
 * reached — every caller treats those the same way: surface the RECOVERY line
 * to the tutor, never to the student.
 */
async function runKernel(
  code: string,
  signal?: AbortSignal,
): Promise<{ out: string; failed: boolean; reason?: string }> {
  const timeout = AbortSignal.timeout(KERNEL_TIMEOUT_MS);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  // The server was started at load; this is where the first call waits for it.
  const server = await marimoUrl();
  if (!server.url) return { out: `${NO_NOTEBOOK} (${server.error})`, failed: true };

  let session = await resolveSession(abort);
  // A closed tab is already handled inside resolveSession, which puts the page
  // back mid-wait. What is left here is the server itself being gone: start it
  // again, once, and look for the kernel a second time.
  if (!session.id && !abort.aborted && session.reason === "unreachable") {
    if (await relaunchMarimo()) session = await resolveSession(abort);
  }
  if (!session.id)
    return { out: session.error ?? NO_NOTEBOOK, failed: true, reason: session.reason };

  let res: Response;
  try {
    res = await fetch(`${marimoBase()}/api/kernel/execute`, {
      method: "POST",
      headers: marimoHeaders({
        "Content-Type": "application/json",
        "Marimo-Session-Id": session.id,
      }),
      body: JSON.stringify({ code }),
      signal: abort,
    });
  } catch {
    return { out: NO_NOTEBOOK, failed: true };
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    return { out: `${NO_NOTEBOOK} (server said ${res.status}) ${detail}`.trim(), failed: true };
  }

  // SSE: "event: <name>" then "data: <json>", records separated by a blank
  // line. stdout/stderr arrive as {"data": "..."} and concatenate without
  // separators — they are a byte stream, not lines.
  let stdout = "";
  let stderr = "";
  let failed = false;
  let done = false;
  let unparsed = "";
  let event = "";
  let buffer = "";

  const handle = (line: string) => {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      return;
    }
    if (line === "") return;
    if (!line.startsWith("data:")) {
      // Not SSE at all — an error body rather than a stream.
      unparsed += line + "\n";
      return;
    }
    const raw = line.slice(5).trim();
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      unparsed += raw + "\n";
      return;
    }
    switch (event) {
      case "stdout":
        stdout += payload?.data ?? "";
        break;
      case "stderr":
        stderr += payload?.data ?? "";
        break;
      case "done":
        // Carries the success bit and the last expression's output; errors
        // already arrived as stderr.
        if (payload?.success === false) failed = true;
        else if (payload?.output?.data) stdout += payload.output.data + "\n";
        done = true;
        break;
    }
  };

  try {
    const decoder = new TextDecoder();
    for await (const chunk of res.body as any) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        handle(buffer.slice(0, nl).replace(/\r$/, "")); // SSE permits CRLF
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer) handle(buffer.replace(/\r$/, ""));
  } catch {
    return {
      out: [stdout, stderr, "The notebook connection dropped mid-run."].filter(Boolean).join("\n"),
      failed: true,
    };
  }

  if (!done) {
    failed = true;
    stderr +=
      "\nExecution did not complete: the server ended the stream without a result." +
      (unparsed ? `\n${unparsed.trim()}` : "");
  }
  return { out: [stdout, stderr].filter(Boolean).join("\n").trim(), failed };
}

/**
 * Run all notebook cells if the kernel hasn't executed them yet. Must be a
 * SEPARATE kernel call from any cell create/edit: queued runs inside one
 * code-mode context do not reliably execute before a newly created cell
 * (observed in production: new cell ran first and hit NameError on `mo`).
 */
async function ensureWarm(signal?: AbortSignal): Promise<{ out: string; failed: boolean } | null> {
  const probe = await runKernel(`print("OK" if "mo" in globals() else "COLD")`, signal);
  if (probe.failed) return probe;
  if (probe.out.includes("COLD")) {
    const boot = await runKernel(BOOTSTRAP, signal);
    if (boot.failed) return boot;
  }
  return null;
}

/**
 * The tutor model (glm-5.2 cloud) is text-only — nb_view_image delegates
 * "seeing" to a separate vision-capable model. Resolution order:
 *   1. TUTOR_VISION_MODEL env ("provider/model-id", as pi knows it)
 *   2. an image-capable model on the tutor's own provider (same billing)
 *   3. any zero-cost image-capable model (local servers are safe to auto-pick)
 * None found -> the tool tells the tutor to ask for a verbal description.
 */
function resolveVisionModel(ctx: any): any | null {
  const reg = ctx?.modelRegistry;
  if (!reg) return null;
  const all: any[] = reg.getAvailable?.() ?? [];
  const pinned = (process.env.TUTOR_VISION_MODEL ?? "").trim();
  if (pinned.includes("/")) {
    const i = pinned.indexOf("/");
    const m = reg.find?.(pinned.slice(0, i), pinned.slice(i + 1));
    if (m) return m;
    // Router model ids contain slashes themselves ("openrouter/minimax/minimax-m3");
    // accept the full provider/id form or the bare router slug, case-insensitively.
    const want = pinned.toLowerCase();
    const byId = all.find(
      (c) =>
        `${c.provider}/${c.id}`.toLowerCase() === want || String(c.id).toLowerCase() === want,
    );
    if (byId) return byId;
  }
  const canSee = (m: any) => Array.isArray(m?.input) && m.input.includes("image");
  const sameProvider = all.find((m) => canSee(m) && m.provider === ctx?.model?.provider);
  if (sameProvider) return sameProvider;
  return (
    all.find((m) => canSee(m) && m?.cost && m.cost.input === 0 && m.cost.output === 0) ?? null
  );
}

async function describeImage(
  ctx: any,
  b64jpeg: string,
  task: string,
  question: string,
): Promise<{ text: string; model?: string; failed: boolean }> {
  const noVisionAdvice =
    "Ask the student to describe their drawing in words instead (e.g. which dots " +
    "they connected and why), then judge their words — that is a perfectly valid pass. " +
    "Say NOTHING to them about the picture not being readable: a live run announced " +
    "\"the page viewer's being stubborn today\", which is your plumbing and not their " +
    "problem. Just ask them to talk you through the page.";
  const model = resolveVisionModel(ctx);
  if (!model) {
    return {
      failed: true,
      text:
        `NO VISION MODEL: you are text-only and no vision-capable model is configured ` +
        `(instructor: set TUTOR_VISION_MODEL=provider/model-id). ${noVisionAdvice}`,
    };
  }
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok) throw new Error(auth?.error ?? "no credentials for vision model");
    // A bare "describe the image" fails on messy hand drawings (a chord two
    // steps apart was reported as "already neighbors" in production). The
    // model needs the TASK to know what to look for, and a forced
    // shape-by-shape / line-by-line trace before answering.
    const prompt =
      "You are the eyes of a text-only tutor looking at a student's photo.\n" +
      `What the student was asked to do: ${task}\n` +
      "Work carefully:\n" +
      "1. Count the main shapes (dots, boxes...) and name each by its position — " +
      "clock positions work well for anything arranged in a circle.\n" +
      "2. Trace EVERY line one at a time; for each, name the two things it connects.\n" +
      "3. Then answer the tutor's question using those position names.\n" +
      "If you are unsure about anything, say so explicitly instead of guessing.\n" +
      "Describe only — never grade or judge. Under 150 words.\n" +
      `Tutor's question: ${question}`;
    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: prompt },
              { type: "image" as const, data: b64jpeg, mimeType: "image/jpeg" },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        // Vision models that can think should: tracing lines in a wobbly
        // hand drawing is exactly what fails without it.
        ...(model.reasoning ? { reasoningEffort: "medium" as const } : {}),
        cacheRetention: "none",
        sessionId: uuidv7(),
      },
    );
    const text = (response?.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("vision model returned no text");
    return { failed: false, model: `${model.provider}/${model.id}`, text };
  } catch (e: any) {
    return {
      failed: true,
      text:
        `VISION FAILED (${e?.message ?? e}): you cannot see the image this time. ` +
        `Do not retry more than once and do not debug. ${noVisionAdvice}`,
    };
  }
}

// ── The referee (the student's ⚖️ "Tutor gets stuck" appeal) ────────────────
// The notebook carries a persistent "Tutor gets stuck — call the referee"
// box. Pressing it appends "tutor_stuck" to student_signal.txt (their case
// text goes to session_artifacts/appeal.txt); the watcher hands the whole
// situation to a STRONGER model, whose ruling is delivered to the tutor as a
// binding "REFEREE VERDICT" message. The verdict can order what the tutor
// cannot grant alone — count the work already shown, redo on fresh data,
// skip ahead, end the chapter — so rulings that close things also arm a
// short-lived waiver that the photo/build/chapter gates honor.

/** ctx from the most recent hook/tool call — the referee runs outside any
 * tool, but needs ctx.modelRegistry for model lookup and credentials. */
let lastCtx: any = null;

let refereeWaiver: { ruling: string; expires: number } | null = null;
const refereeWaiverActive = (): boolean =>
  !!refereeWaiver && refereeWaiver.expires > Date.now();

let appealInFlight = false;

const REFEREE_RULINGS = [
  "keep_going",
  "hear_them_out",
  "redo_fresh",
  "accept_and_close",
  "skip_ahead",
  "next_chapter",
];

/** Rulings that close or skip things need the gates to stand aside. */
const WAIVER_RULINGS = ["accept_and_close", "skip_ahead", "next_chapter"];

function resolveRefereeModel(ctx: any): any | null {
  const reg = ctx?.modelRegistry;
  if (!reg) return null;
  // Default to a "referee" model on the tutor's OWN provider — a course
  // gateway publishes tutor / vision / referee among its aliases, and the
  // student has credentials for exactly that provider and no other. Looked up
  // by exact id, so a gateway that grows aliases (an `assistant` for the rest
  // of the course) does not change what the appeal reaches. The launcher used
  // to export this; nothing exports anything now.
  const sameProvider = ctx?.model?.provider
    ? (reg.find?.(ctx.model.provider, "referee") ?? null)
    : null;
  const pinned = (
    process.env.TUTOR_REFEREE_MODEL ??
    (sameProvider ? `${sameProvider.provider}/${sameProvider.id}` : "openrouter/z-ai/glm-5.2")
  ).trim();
  if (!pinned.includes("/")) return null;
  const i = pinned.indexOf("/");
  const m = reg.find?.(pinned.slice(0, i), pinned.slice(i + 1));
  if (m) return m;
  // Router model ids contain slashes themselves ("openrouter/z-ai/glm-5.2");
  // accept the full provider/id form or the bare router slug.
  const want = pinned.toLowerCase();
  const all: any[] = reg.getAvailable?.() ?? [];
  return (
    all.find(
      (c) =>
        `${c.provider}/${c.id}`.toLowerCase() === want || String(c.id).toLowerCase() === want,
    ) ?? null
  );
}

/** The recent conversation, labeled and clipped, for the referee's eyes. */
function transcriptTail(ctx: any, maxMsgs = 40, maxChars = 7000): string {
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
  const rows: string[] = [];
  for (const e of entries) {
    if (e?.type !== "message") continue;
    const role = e?.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const c = e.message.content;
    const text = (
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c
              .filter((p: any) => p?.type === "text" && typeof p.text === "string")
              .map((p: any) => p.text)
              .join("\n")
          : ""
    ).trim();
    if (!text) continue;
    if (role === "user" && INJECTED_PREFIX.test(text)) continue;
    rows.push(
      `${role === "user" ? "STUDENT" : "TUTOR"}: ${text.length > 500 ? text.slice(0, 500) + "…" : text}`,
    );
  }
  let tail = rows.slice(-maxMsgs);
  while (tail.join("\n").length > maxChars && tail.length > 4) tail = tail.slice(2);
  return tail.join("\n") || "(no conversation captured)";
}

function currentChapterScriptRaw(): string {
  try {
    const dir = path.join(process.cwd(), "lesson");
    const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf-8"));
    const cur = currentChapterId() ?? idx.chapters?.[0]?.id;
    const ch = (idx.chapters ?? []).find((c: any) => c.id === cur) ?? idx.chapters?.[0];
    if (!ch?.file) return "(no chapter script found)";
    return fs.readFileSync(path.join(dir, ch.file), "utf-8").slice(0, 16000);
  } catch {
    return "(no chapter script found)";
  }
}

async function handleAppeal(pi: any): Promise<void> {
  if (appealInFlight) return;
  appealInFlight = true;
  try {
    let caseText = "(no details given)";
    try {
      caseText =
        fs
          .readFileSync(path.join(process.cwd(), "session_artifacts", "appeal.txt"), "utf-8")
          .trim() || caseText;
    } catch {
      /* the button works even if the case file does not */
    }
    const ctx = lastCtx;
    const model = ctx ? resolveRefereeModel(ctx) : null;
    let verdict: {
      ruling: string;
      reason: string;
      directive: string;
      to_student: string;
    } | null = null;
    let modelName = "";
    if (model) {
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth?.ok) throw new Error(auth?.error ?? "no credentials for referee model");
        const prompt =
          `You are the REFEREE for a live one-on-one tutoring session (a Socratic AI ` +
          `tutor teaching a university network-science module to a possibly ` +
          `non-programming student). The student just pressed a "Tutor gets stuck" ` +
          `button: they are appealing over the tutor's head, and your ruling is ` +
          `binding on the tutor.\n\n` +
          `The tutor's standing rules, for context: it never states the answer to an ` +
          `open checkpoint; hints are unlimited and never penalized; predictions are ` +
          `never wrong; typed work substitutes for photographed pen-and-paper work ` +
          `when photographing is a hardship; honest reasoning deserves credit; extra ` +
          `practice is never failure. Rules serve the student — where a rule's letter ` +
          `and the student's legitimate progress conflict, side with the student.\n\n` +
          // The six rulings below all decide a CHECKPOINT, and an appeal is not
          // always about one. A student appealed because the tutor would not
          // hand their work in to GitHub; the referee had no ruling for that,
          // ruled on the nearest checkpoint instead, and the tutor accepted the
          // ruling and moved on — the request itself was never granted. The
          // directive is the channel for anything the rulings do not name.
          `WHAT THE TUTOR CAN ACTUALLY DO, so you do not rule around it: it builds and ` +
          `edits notebook cells, reads what the student typed into a widget, looks at an ` +
          `uploaded photo, logs checkpoints and detours, and HANDS THE WORK IN — it has ` +
          `an nb_submit tool that commits and pushes their notebook and session log to ` +
          `their GitHub repository, and it may use it at any point, not only at the end. ` +
          `If the appeal is a REQUEST the tutor refused or dropped rather than a dispute ` +
          `about a checkpoint, rule "keep_going" and make the directive the action: name ` +
          `the tool and say to do it now, before anything else.\n\n` +
          `THE STUDENT'S CASE (verbatim):\n${caseText}\n\n` +
          `PROGRESS SO FAR (graded log):\n${progressBrief(readSessionLog())}\n\n` +
          `CURRENT CHAPTER SCRIPT (the tutor's curriculum for right now):\n` +
          `${currentChapterScriptRaw()}\n\n` +
          `RECENT CONVERSATION (oldest first; STUDENT lines are the student's own ` +
          `words):\n${transcriptTail(ctx)}\n\n` +
          `Decide the fairest way forward. Choose EXACTLY ONE ruling:\n` +
          `- "keep_going": the tutor is handling it right; name ONE concrete ` +
          `adjustment it should make.\n` +
          `- "hear_them_out": the student deserves a proper hearing on this ` +
          `checkpoint; tell the tutor what to ask and what standard to accept.\n` +
          `- "redo_fresh": scrap the current attempt; restart the SAME kind of ` +
          `problem on fresh data.\n` +
          `- "accept_and_close": the work already shown meets the bar; the current ` +
          `checkpoint closes now, judged on what actually happened.\n` +
          `- "skip_ahead": close the current checkpoint as unresolved and move to ` +
          `the next one; no grade penalty.\n` +
          `- "next_chapter": end this chapter now and move on to the next.\n\n` +
          `Answer with ONLY a JSON object, no prose around it:\n` +
          `{"ruling": "<one of the six>", "reason": "1-2 plain sentences", ` +
          `"directive": "2-4 concrete sentences the tutor must now follow, naming ` +
          `the checkpoint(s) to act on", "to_student": "1-2 warm sentences addressed ` +
          `directly to the student"}`;
        const response = await complete(
          model,
          {
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: prompt }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            ...(model.reasoning ? { reasoningEffort: "medium" as const } : {}),
            cacheRetention: "none",
            sessionId: uuidv7(),
          },
        );
        const text = (response?.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        const m = text.match(/\{[\s\S]*\}/);
        let parsed: any = null;
        try {
          parsed = m ? JSON.parse(m[0]) : null;
        } catch {
          parsed = null;
        }
        if (parsed && REFEREE_RULINGS.includes(parsed.ruling)) {
          verdict = {
            ruling: String(parsed.ruling),
            reason: String(parsed.reason ?? ""),
            directive: String(parsed.directive ?? ""),
            to_student: String(parsed.to_student ?? ""),
          };
          modelName = `${model.provider}/${model.id}`;
        } else if (text) {
          // A referee that replied in prose still ruled — treat the whole
          // reply as the directive rather than dropping the appeal.
          verdict = {
            ruling: "hear_them_out",
            reason: "(referee replied in prose)",
            directive: text.slice(0, 1200),
            to_student: "",
          };
          modelName = `${model.provider}/${model.id}`;
        }
      } catch {
        /* fall through to the unreachable-referee path */
      }
    }
    // The artifact records every appeal, ruled or not, before the tutor
    // hears about it — misbehavior after the verdict cannot erase it.
    appendLog({
      type: "appeal",
      student_case: caseText,
      ruling: verdict?.ruling ?? "unresolved_no_referee",
      reason: verdict?.reason ?? "",
      referee: modelName || "(unreachable)",
    });
    if (!verdict || WAIVER_RULINGS.includes(verdict.ruling)) {
      refereeWaiver = {
        ruling: verdict?.ruling ?? "unresolved_no_referee",
        expires: Date.now() + 20 * 60_000,
      };
    }
    const content = verdict
      ? `REFEREE VERDICT (binding). The student pressed the ⚖️ "Tutor gets stuck" ` +
        `button, and a stronger referee model reviewed the whole situation. Its ` +
        `ruling overrides your script and your own judgment wherever they ` +
        `conflict.\n` +
        `Their case, in their words: "${caseText}"\n` +
        `Ruling: ${verdict.ruling} — ${verdict.reason}\n` +
        (verdict.to_student
          ? `For the student (deliver this warmly, in your own words, as the ` +
            `referee's decision): ${verdict.to_student}\n`
          : "") +
        `What you do now, exactly: ${verdict.directive}\n` +
        // Accepting a ruling is not carrying it out. A student appealed
        // because the tutor would not hand their work in; the tutor accepted
        // the verdict warmly, said nothing more about it, and moved on to the
        // next chapter with the request never granted. Whatever the ruling
        // names, the thing the student ASKED for is still owed.
        `And whatever the ruling says, THEIR ORIGINAL REQUEST IS STILL OWED. Agreeing ` +
        `with the referee is not doing the thing: if they asked for their work to be ` +
        `handed in, call nb_submit; if they asked for another problem, set one. Do it in ` +
        `this turn, before you move on, and never advance a chapter with their request ` +
        `still unanswered.\n` +
        `Do not argue with or re-litigate the ruling, and never hold the appeal ` +
        `against the student — appealing is participation. The appeal itself is ` +
        `already in the log; close any affected checkpoint honestly (its row is ` +
        `stamped for the graders). If a gate refused you before, it will let this ` +
        `ruling through now.`
      : `REFEREE VERDICT (the referee could not be reached — you resolve this ` +
        `appeal yourself). The student pressed the ⚖️ "Tutor gets stuck" button ` +
        `with this case, in their words: "${caseText}"\n` +
        `Resolve it generously, in their favor where reasonable: react to their ` +
        `case, then offer plainly the three ways forward — count the honest work ` +
        `they have already shown, redo the problem on fresh data, or simply move ` +
        `on — and do what they choose. The appeal is already in the log; log ` +
        `whatever closes as it actually happened (notes may say "resolved without ` +
        `referee").`;
    pi.sendMessage(
      { customType: "referee-verdict", content, display: false },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch {
    /* an appeal must never break the session */
  } finally {
    appealInFlight = false;
  }
}

function toResult({ out, failed, reason }: { out: string; failed: boolean; reason?: string }) {
  let text = failed ? `NOTEBOOK ERROR:\n${out || "(no output)"}` : out || "(ok)";
  if (failed) {
    // Tell the model exactly what to do — otherwise it starts "debugging"
    // with skills, shell, and log files in front of the student.
    //
    // This used to branch on out.includes("No active sessions") — a string
    // that appears nowhere else in this repo and that marimo never returns.
    // So the one case with a real, cheap fix (their tab is closed; ask them to
    // open it) always fell through to "tell them the whiteboard is
    // unavailable and continue in terminal-only mode", which ends the notebook
    // for the rest of the session over a browser tab. The reason now travels
    // as a field instead of being guessed from prose.
    text +=
      reason === "no-page"
        ? `\nRECOVERY: the notebook server is fine — the student's notebook TAB is closed, ` +
          `so the page has no kernel. Ask them, in one warm sentence, to open ` +
          `${marimoBase()}/?view-as=present (it may already be reopening by itself), wait ` +
          `for their reply, then retry this call. Do NOT switch to terminal-only mode for ` +
          `this and do NOT tell them the whiteboard is broken.`
        : `\nRECOVERY: retry this call ONCE. If it fails again, tell the student the ` +
          `whiteboard is unavailable and continue in terminal-only mode (AGENTS.md) — ` +
          `do NOT investigate with skills, shell, or log files.`;
  }
  return {
    content: [{ type: "text" as const, text }],
    details: { failed },
  };
}

// ── Is the tutor's own model actually reachable? ────────────────────────────
// The course endpoint moved once, and every machine still pointing at the old
// host got, in full, this: "Error: Connection error." — four times, then
// "Retry failed after 3 attempts". No URL, no status, no mention of a key, no
// suggestion. On a student who has never used a terminal that is the end of
// the assignment, and the instructor hears "it doesn't work".
//
// So the session opens by asking the provider whether it is there. It costs
// one HTTP call against an endpoint that must work anyway, it happens before
// the student has typed anything, and it names the three things that are ever
// wrong: the address, the key, or the network. Silent when all is well.
async function preflightProvider(ctx: any): Promise<string | null> {
  const model = ctx?.model;
  const provider = model?.provider;
  if (!provider) return null;
  let auth: any;
  try {
    // Same call the vision path uses: {ok, apiKey, headers, baseUrl}.
    auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
  } catch {
    return null;
  }
  if (!auth?.ok) return null;
  const baseUrl = String(
    auth.baseUrl ?? ctx.modelRegistry?.getProvider?.(provider)?.baseUrl ?? "",
  ).replace(/\/+$/, "");
  // A built-in provider with no configured baseUrl of its own is not what this
  // is for — those speak their vendor's endpoint and diagnose themselves.
  if (!/^https?:\/\//.test(baseUrl)) return null;

  const fix =
    `What to do: run  node setup-pi.mjs  in this folder — it rewrites the course ` +
    `settings and tells you which part is wrong. If it still fails, send your ` +
    `instructor the line above.`;
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        ...(auth.headers ?? {}),
        ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return null;
    if (res.status === 401 || res.status === 403) {
      return (
        `Your course key was refused by ${baseUrl} (HTTP ${res.status}).\n` +
        `Check NETSCI_API_KEY in this terminal — a missing character or a stray ` +
        `space is the usual cause, and a key set in another window does not ` +
        `count.\n${fix}`
      );
    }
    if (res.status === 429) {
      return (
        `The course server says you are over your allowance for now (HTTP 429).\n` +
        `See what is left at ${baseUrl}/usage, and tell your instructor if that ` +
        `looks wrong.`
      );
    }
    return `The course server answered ${baseUrl} with HTTP ${res.status}.\n${fix}`;
  } catch (e: any) {
    const why =
      e?.name === "TimeoutError" ? "it did not answer in 15 seconds" : (e?.message ?? String(e));
    return (
      `Could not reach the course server at ${baseUrl} — ${why}.\n` +
      `If you are online, the address in your settings may be out of date.\n${fix}`
    );
  }
}

// ── Keeping the student's course models current ─────────────────────────────
// models.json is written once, by the installer, before pi exists. After that
// a student's clone pins a toolkit tag and pi skips pinned packages on update
// (`pi update --extensions` leaves a pinned ref alone, by design), so a course
// gateway that grows an alias reaches nobody: the server serves it and every
// client refuses to offer a model it holds no local declaration for. The
// repair is two lines in a terminal — which is exactly what to avoid asking of
// the students this is trying not to lose.
//
// Hence a tool. Not a system prompt telling the model to edit the file
// itself: this file is what makes pi run at all, and a mangled write takes the
// tutor down with it, mid-lesson, on the machine of someone who cannot get it
// back from a shell. Everything here is about never being the cause of that.
// An unreadable file is left alone rather than "fixed". Other providers are
// never touched. Entries that already exist are never rewritten — only
// missing ones are appended, so a student who has tuned a setting keeps it.
// The write is a temp file and a rename, because a half-written models.json
// is the failure this whole design is trying not to cause.
const PI_MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");

/** One `/v1/models` row as a pi catalogue entry. */
function catalogueEntry(row: any) {
  const input =
    Array.isArray(row?.input) && row.input.length ? row.input.map(String) : ["text"];
  return {
    id: String(row.id),
    name: String(row.name ?? row.id),
    ...(row.reasoning ? { reasoning: true } : {}),
    input,
    // The course gateway is free to the student and meters requests and
    // tokens, not dollars. A price here would put a running bill on screen
    // for an allowance that is not money.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(row.context_window ?? 131072),
    maxTokens: Number(row.max_tokens ?? 8192),
  };
}

type SetupPlan =
  | { kind: "current" }
  | { kind: "add"; provider: string; missing: any[]; data: any }
  | { kind: "skip"; why: string };

/** What would change, without changing anything. */
async function planCourseModels(ctx: any): Promise<SetupPlan> {
  const model = ctx?.model;
  const provider = model?.provider;
  if (!provider) return { kind: "skip", why: "this session has no provider to check" };

  let auth: any;
  try {
    auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
  } catch {
    auth = null;
  }
  if (!auth?.ok) return { kind: "skip", why: "their course key cannot be read from here" };

  const baseUrl = String(
    auth.baseUrl ?? ctx.modelRegistry?.getProvider?.(provider)?.baseUrl ?? "",
  ).replace(/\/+$/, "");
  // The same guard preflightProvider uses: a built-in provider speaking its
  // own vendor's endpoint is not a course gateway and has no catalogue of ours.
  if (!/^https?:\/\//.test(baseUrl)) {
    return { kind: "skip", why: "this session is not running on a course gateway" };
  }

  let rows: any;
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        ...(auth.headers ?? {}),
        ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { kind: "skip", why: `the course server answered HTTP ${res.status}` };
    }
    rows = (await res.json())?.data;
  } catch (e: any) {
    const why =
      e?.name === "TimeoutError" ? "it did not answer in 15 seconds" : (e?.message ?? String(e));
    return { kind: "skip", why: `the course server could not be reached — ${why}` };
  }
  if (!Array.isArray(rows) || !rows.length) {
    return { kind: "skip", why: "the course server listed no models" };
  }
  // Decline rather than default the modalities. A gateway too old to report
  // `input` would have every alias written down as text-only, and the one
  // that matters is the vision alias: nb_view_image picks the image-capable
  // model on this provider, finds none, and the tutor starts telling students
  // to describe their drawing in words. That is a silent, plausible-looking
  // failure introduced by the tool meant to repair their setup. `name` and
  // `reasoning` are cosmetic by comparison and are allowed to default.
  if (!rows.every((r: any) => Array.isArray(r?.input) && r.input.length)) {
    return {
      kind: "skip",
      why:
        `the course server's model list does not say what each model can read, so ` +
        `writing it down would guess — their instructor needs to update the server`,
    };
  }

  // No config at all means nothing was ever installed here. Writing a provider
  // block from scratch means inventing a baseUrl and a key reference, which is
  // the installer's job and not a guess to make in the middle of a lesson.
  if (!fs.existsSync(PI_MODELS_JSON)) {
    return { kind: "skip", why: "there is no pi settings file on this machine to update" };
  }
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(PI_MODELS_JSON, "utf8"));
  } catch (e: any) {
    return {
      kind: "skip",
      why:
        `their pi settings file is not valid JSON (${e?.message ?? e}). It was NOT ` +
        `touched and must not be — say their instructor needs to look at it`,
    };
  }
  const block = data?.providers?.[provider];
  if (!block || !Array.isArray(block.models)) {
    return { kind: "skip", why: "their pi settings hold no course provider to add to" };
  }

  const have = new Set(block.models.map((m: any) => String(m?.id)));
  const missing = rows
    .filter((r: any) => r?.id && !have.has(String(r.id)))
    .map(catalogueEntry);
  return missing.length ? { kind: "add", provider, missing, data } : { kind: "current" };
}

/** Writes the plan. Returns null on success, or why it failed. */
function applyCourseModels(plan: Extract<SetupPlan, { kind: "add" }>): string | null {
  const tmp = `${PI_MODELS_JSON}.tmp-${process.pid}`;
  try {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..*/, "")
      .replace("T", "-");
    fs.copyFileSync(PI_MODELS_JSON, `${PI_MODELS_JSON}.bak-${stamp}`);
    plan.data.providers[plan.provider].models.push(...plan.missing);
    // Rename, not a second write over the real file: an interrupted write
    // leaves models.json truncated, and a student whose pi no longer starts
    // cannot be talked through restoring the backup.
    fs.writeFileSync(tmp, JSON.stringify(plan.data, null, 2) + "\n");
    fs.renameSync(tmp, PI_MODELS_JSON);
    return null;
  } catch (e: any) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return String(e?.message ?? e);
  }
}

// ── Pickers the student can type into ──────────────────────────────────────
// pi's ctx.ui.select swallows every printable key. A student who answers by
// typing while a picker is open sees NOTHING appear on screen — no echo, no
// warning — and their Enter then selects whatever row the cursor happens to
// be on. Both halves of that were reproduced in one live run: the sentence
// was gone and the choice was not theirs. The tutor's own contract warns the
// TUTOR about this ("a picker takes the keyboard"), but the student, who is
// the one holding the keyboard, was never protected at all.
//
// So every picker this toolkit opens carries a typed-answer row, and its
// title says how to drive it. The row cannot rescue keys pressed before the
// student notices — nothing can, from outside pi — but it does mean there is
// always somewhere for their words to go, and that a beginner who types out
// of habit finds the way through in the list they are already looking at.
const TYPE_IT = "✎ Let me type something instead";

/**
 * True while a picker is on screen, read by the trivia timer.
 *
 * A tip is for dead air — the long wait on a model call or a vision read —
 * and the seconds around a picker are the opposite of dead air. The tutor has
 * just delivered the reveal, and every line printed under it pushes it further
 * up a terminal the student may not think to scroll. Live, in order: the
 * reveal, a tool status line, a tip, a separator, the picker. On a short
 * window the payoff is off the top and the student answers "Where to next?"
 * having never read what their answer bought them.
 */
let quietForPicker = false;

/**
 * The last thing the tutor SAID, short enough to sit on top of a picker.
 *
 * The reveal is the payoff for the answer the student just gave, and the
 * picker that follows it is titled "Where to next?" and nothing else — so
 * when the reveal has scrolled off the top, the student is choosing with no
 * idea what they were shown. Carrying the last line into the dialog costs a
 * line of repetition when it is still visible, and saves the whole beat when
 * it is not.
 */
function lastTutorLine(ctx: any, maxChars = 150): string {
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "message" || e?.message?.role !== "assistant") continue;
    const c = e.message.content;
    const text = (
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c
              .filter((p: any) => p?.type === "text" && typeof p.text === "string")
              .map((p: any) => p.text)
              .join("\n")
          : ""
    ).trim();
    if (!text) continue;
    // The last SENTENCE, not the last line. A reveal is two sentences on one
    // line as often as not, and cutting that at a character count ends the
    // dialog mid-clause — "…at most two odd nodes for a trail, and none at…",
    // which is worse than showing nothing. The final sentence is also the one
    // the beat lands on: "Königsberg has four odd nodes, so it has neither."
    const flat = text.replace(/\s+/g, " ").trim();
    const parts = flat.split(/(?<=[.!?])\s+/).filter(Boolean);
    // The last two sentences when they fit, not just the last one. A reveal
    // is two sentences by contract, and the last of them is often the optional
    // extra beat — "And the citizens had asked for the circuit" — while the
    // punchline is the one before it. Taking both, when both fit, is the whole
    // beat rather than its tail.
    let line = parts[parts.length - 1] ?? flat;
    if (parts.length > 1) {
      const pair = `${parts[parts.length - 2]} ${line}`;
      if (pair.length <= maxChars) line = pair;
    }
    // The transcript renders markdown; a select() title does not. Straight out
    // of the tutor's mouth the line reads "an **Eulerian trail**, and coming
    // home makes it an **Eulerian circuit**" — asterisks and all, printed at a
    // student, which is the same fault as saying "$G = (V,E)" out loud.
    line = line
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|\s)\*([^*]+)\*(?=\s|[.,!?;:]|$)/g, "$1$2")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/(^|\s)_([^_]+)_(?=\s|[.,!?;:]|$)/g, "$1$2")
      .trim();
    return line.length > maxChars ? line.slice(0, maxChars - 1).trimEnd() + "…" : line;
  }
  return "";
}

async function askStudent(
  ctx: any,
  title: string,
  options: string[],
): Promise<{ choice: string | null; typed: string; asked: boolean }> {
  if (!ctx?.ui?.select) return { choice: null, typed: "", asked: false };
  quietForPicker = true;
  // Two things share the space between the reveal and the dialog, and both
  // used to say the machine was busy while in fact it was the student's turn.
  //
  // The tip is one: silencing the timer is not enough, because a tip set
  // moments earlier stays on screen for as long as the student takes to
  // choose. The spinner is the other, and it cannot be taken down — a tool
  // that opens a picker has not returned, so pi is legitimately mid-turn, and
  // its "📝 …" call line keeps its place too (rendered once, at call time,
  // and not re-rendered while the dialog is up — tried).
  //
  // What CAN be fixed is what they say. A spinner beside "waiting for your
  // answer" reads as what it is; beside a stale tip, or nothing at all, it
  // reads as "still loading, please wait" next to a question waiting on them.
  try {
    ctx?.ui?.setWorkingMessage?.("waiting for your answer");
  } catch {
    /* cosmetic */
  }
  try {
    return await askStudentInner(ctx, title, options);
  } finally {
    quietForPicker = false;
  }
}

async function askStudentInner(
  ctx: any,
  title: string,
  options: string[],
): Promise<{ choice: string | null; typed: string; asked: boolean }> {
  const choice = await ctx.ui.select(`${title}   ↑↓ then Enter`, [...options, TYPE_IT]);
  if (choice !== TYPE_IT) return { choice: choice ?? null, typed: "", asked: true };
  let typed = "";
  try {
    typed = String((await ctx.ui.input?.("Type it here, then Enter:", "")) ?? "").trim();
  } catch {
    /* an older pi without ui.input: falls through as an empty typed answer */
  }
  return { choice: TYPE_IT, typed, asked: true };
}

/**
 * Shared quiet renderers: student sees a status line and a checkmark.
 *
 * `fallback` is what the line says when the model sends no `status`. It used
 * to be one generic sentence for every tool, which was fine while `status` was
 * required — but required meant a model that forgot it lost the whole call, so
 * it is optional now, and a small model promptly stopped sending it at all: a
 * live run showed "Working in the notebook…" four times in a row where the
 * student had been getting "Noting your experience level…". Optional keeps the
 * checkpoint; a per-tool fallback keeps the warmth.
 */
const quiet = (fallback: string) => ({
  renderCall(args: { status?: string }, theme: any) {
    const status =
      // .trim(): a status of a single space passed the length test and
      // printed a bare "📝  ✓" at the student.
      typeof args?.status === "string" && args.status.trim().length > 0
        ? args.status.trim()
        : fallback;
    return new Text(theme.fg("accent", `📝 ${status}`), 0, 0);
  },
  renderResult(result: any, { expanded, isPartial }: any, theme: any) {
    if (isPartial) return new Text(theme.fg("muted", "…"), 0, 0);
    // `details` is set by every path through execute(). Its ABSENCE means
    // execute never ran — pi rejected the arguments against the schema first —
    // and that used to render as a green ✓ while nothing had happened, with
    // the model's whole rejected payload (question, verbatim answer, note
    // markdown) printed into the student's terminal beside it.
    if (result?.details?.failed === true || result?.isError === true || !result?.details) {
      return new Text(theme.fg("error", "⚠ something hiccuped — your tutor is on it"), 0, 0);
    }
    const raw =
      result?.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
        .join("\n")
        .trim() ?? "";
    if (expanded && raw) {
      return new Text(theme.fg("success", "✓") + "\n" + theme.fg("dim", raw), 0, 0);
    }
    let line = theme.fg("success", "✓");
    if (raw && raw !== "(ok)") line += " " + theme.fg("dim", `(${keyHint("app.tools.expand", "for details")})`);
    return new Text(line, 0, 0);
  },
});

/** The generic pair, for tools with nothing more specific to say. */
const quietRender = quiet("Working in the notebook…");

// Optional on purpose. It is a nicety — one friendly line above a spinner —
// and renderCall already has a default for it, but as a required field a model
// that forgot it lost the whole call: pi rejects the arguments before execute
// runs, so the build never happens, the student watches the rejected payload
// scroll past, and the tutor apologises for a field it cannot name. Nothing
// that only decorates the screen should be able to fail a checkpoint.
const STATUS_PARAM = Type.Optional(
  Type.String({
    description:
      "ALWAYS send this. Short student-facing status in plain, friendly words, e.g. " +
      "'Preparing our next step…'. It is the only thing on their screen while the call " +
      "runs, so a specific one ('Noting how you like to learn…') is worth far more than " +
      "the generic line they get without it. No technical terms, no cell/code/error " +
      "talk — and NEVER a fact the checkpoint you are on is asking them to find (it is " +
      "shown at the moment you build that checkpoint).",
  }),
);

// ── Chapter orchestration (the deterministic "lead agent") ──────────────────
// The lesson is split into chapters (lesson/index.json). The tutor holds only
// the CURRENT chapter's script in context; chapter_done builds a handoff
// brief, injects the next script, and trims the old conversation via
// compaction — same session, same visible transcript, fresh LLM context.
type Chapter = {
  id: string;
  file: string;
  title: string;
  /** Lecture-note prose rendered under the chapter heading (see chapterOpening). */
  opening?: string;
  checkpoints: string[];
};

function loadChapters(): Chapter[] {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "lesson", "index.json"), "utf-8");
    return (JSON.parse(raw).chapters ?? []) as Chapter[];
  } catch {
    return [];
  }
}

/** The module's own id, from lesson/index.json ("m01-euler-tour"). */
function moduleId(): string {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "lesson", "index.json"), "utf-8");
    return String(JSON.parse(raw).module ?? "");
  } catch {
    return "";
  }
}

/** Flat checkpoint order across all chapters — the script is the authority. */
function checkpointOrder(): string[] {
  return loadChapters().flatMap((c) => c.checkpoints);
}

function isScriptedCheckpoint(id: string): boolean {
  return checkpointOrder().includes(baseCheckpointId(id));
}

/**
 * Pull a checkpoint id back onto the script when the model has drifted near
 * it. The comparison lives in lib/verbatim.ts, where it can be run; the disk
 * read is the only thing that has to stay here.
 *
 * `judgment` is validated against a list and `student_response` against empty,
 * but `id` — the key everything else is looked up by — was taken as given. One
 * character out (`cp3-clustering` for `cp3_clustering`) and four things fail at
 * once, none of them visibly: the note skeleton is not found, so the
 * instructor's note cell never reaches the keepsake; the build guard and the
 * ordering guard stop recognising the checkpoint; and the closing summary
 * reports "14 of 15" while the notebook shows an answer under a misspelled
 * heading.
 */
const snapCheckpointId = (id: string): { id: string; snappedFrom?: string } =>
  snapIdAgainst(id, checkpointOrder());

/** The checkpoint the tutor is expected to work next, or null if unknown. */
/**
 * Where to go after closing `id`: the next checkpoint in the script, full
 * stop.
 *
 * This was briefly made gap-aware — "the first checkpoint with no log row" —
 * so that a session killed mid-module could resume into the hole it left.
 * Three rounds of review found three different Blockers in that, all the
 * same shape: the ordering guard, `chapter_done`'s re-arm, the per-chapter
 * scripts and this function each have their own idea of "next", and making
 * one of them gap-aware puts it at odds with the other three — a build the
 * guard refuses, a chapter that can never be re-loaded, a walk back through
 * checkpoints that already have rows and notes, duplicate rows in the graded
 * record. Positional is the only rule all four share.
 *
 * A gap is also close to unreachable now: the build guard refuses a
 * checkpoint ahead of the open one, and this advances one at a time. The
 * gapped logs in session_artifacts/ predate both. When one does appear, the
 * honest outcome is a record that says so — the closing summary already
 * prints "Checkpoints completed: 11 of 12" and names where to pick up —
 * not a record that quietly re-runs half the module to paper over it.
 */
function nextCheckpointId(id: string): string | null {
  const order = checkpointOrder();
  const i = order.indexOf(baseCheckpointId(id));
  return i >= 0 ? (order[i + 1] ?? null) : null;
}

/**
 * Is `cpId` a checkpoint the tutor has not reached yet? This — not mere
 * inequality — is what the build-ordering guard must refuse: inserting a
 * LATER checkpoint's build while the current one is open strands its note
 * cell after that build. Re-inserting an EARLIER one (a reveal figure added
 * after the checkpoint was closed) is harmless and must stay allowed.
 */
function isAheadOf(cpId: string, openId: string): boolean {
  const order = checkpointOrder();
  const a = order.indexOf(cpId);
  const b = order.indexOf(openId);
  return a >= 0 && b >= 0 && a > b;
}

function chapterScriptMessage(ch: Chapter, num: number, total: number): string {
  const src = fs.readFileSync(path.join(process.cwd(), "lesson", ch.file), "utf-8");
  const last = ch.checkpoints[ch.checkpoints.length - 1];
  return (
    `CHAPTER SCRIPT ${num}/${total} — "${ch.title}" (invisible to the student). ` +
    `This is your curriculum right now:\n\n${src}\n\n` +
    (chapterOpening(ch)
      ? `The chapter's opening paragraph is ALREADY in their notebook, above ` +
        `your first build — do not read it out or paraphrase it. It says:\n` +
        `"${chapterOpening(ch)}"\n\n`
      : "") +
    `Work its checkpoints in order, ending each one with checkpoint_done. ` +
    `After checkpoint_done for the final checkpoint (${last}), call chapter_done ` +
    `with short handoff notes.`
  );
}

/**
 * The chapter's instructor-authored `opening:` prose, from the `chapter:`
 * block at the top of its script. This is what turns the notebook from a
 * pile of experiments into a lecture note: a heading alone tells a cold
 * reader nothing about why the next four cells exist.
 *
 * It renders BEFORE the chapter's first question, so an opening that
 * answers one is an answer leak — the scripts carry a comment saying so.
 */
function chapterOpening(ch: Chapter): string {
  return String(ch.opening ?? "").trim();
}

/**
 * Deterministic notebook structure: a "## Chapter N — Title" markdown cell
 * plus the chapter's opening prose, at every chapter start, so the finished
 * notebook reads as a document the student can re-learn from.
 * Skip-if-exists; cosmetic — never blocks.
 */
async function insertChapterHeader(
  ch: Chapter,
  num: number,
  total: number,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const warm = await ensureWarm(signal);
    if (warm) return false;
    const name = `${ch.id}_header`;
    const opening = chapterOpening(ch);
    const heading = `## Chapter ${num} of ${total} — ${ch.title}`;
    const body = `mo.md(${pyMd(opening ? `${heading}\n\n${opening}` : heading)})`;
    await runKernel(
      `import marimo._code_mode as cm\n` +
        `async with cm.get_context() as ctx:\n` +
        `    _names = [c.name for c in ctx.cells]\n` +
        `    if ${py(name)} not in _names:\n` +
        `        _cid = ctx.create_cell(${py(body)}, name=${py(name)}, hide_code=True)\n` +
        `        ctx.run_cell(_cid)\n` +
        focusCellCode("_cid", "        "),
      signal,
    );
    await pinAppealToBottom(signal);
    return true;
  } catch {
    // headers are cosmetic — never block the lesson
    return false;
  }
}

/**
 * Chapter 1's header is the one nobody else retries: chapters 2-5 get theirs
 * from chapter_done, long after the kernel is warm, but chapter 1's fires
 * once at session start — and the kernel stays cold until a browser client
 * connects. A student who opens the page late (the D7 notebook-down path)
 * used to lose that header for good, leaving a notebook whose first heading
 * says "Chapter 2 of 5". Keep trying until it lands, the chapter moves on,
 * or we give up after ~5 minutes. create_cell is skip-if-exists, so a late
 * success can never duplicate it.
 */
/**
 * No named cell may land before its chapter header. The scheduled attempt is
 * on a timer, and cp0_welcome builds nothing — so its note cell (a greeting
 * and one dialog later) could be created first and push "Chapter 1 of 5"
 * below it. Called before every insert that creates a named cell; skip-if-
 * exists makes it a no-op after the first success.
 */
async function ensureChapterHeader(signal?: AbortSignal): Promise<void> {
  const chapters = loadChapters();
  if (chapters.length === 0) return;
  const id = currentChapterId() ?? chapters[0].id;
  const idx = chapters.findIndex((c) => c.id === id);
  if (idx < 0) return;
  await insertChapterHeader(chapters[idx], idx + 1, chapters.length, signal);
}

function scheduleChapterHeader(ch: Chapter, num: number, total: number): void {
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    if (currentChapterId() !== ch.id) return;
    const ok = await insertChapterHeader(ch, num, total);
    if (ok || attempts >= 20) return;
    const t = setTimeout(() => void tick(), 15_000);
    (t as any).unref?.();
  };
  const first = setTimeout(() => void tick(), 15_000);
  (first as any).unref?.();
}

function chapterStatePath(): string {
  return path.join(process.cwd(), "session_artifacts", "chapter_state.json");
}

function currentChapterId(): string | null {
  try {
    return JSON.parse(fs.readFileSync(chapterStatePath(), "utf-8")).current ?? null;
  } catch {
    return null;
  }
}

function writeChapterState(id: string) {
  try {
    fs.mkdirSync(path.dirname(chapterStatePath()), { recursive: true });
    fs.writeFileSync(chapterStatePath(), JSON.stringify({ current: id }));
  } catch {
    // best-effort
  }
}

function readSessionLog(): any[] {
  try {
    return fs
      .readFileSync(path.join(process.cwd(), "session_artifacts", "session_log.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function progressBrief(entries: any[]): string {
  const cps = entries.filter((e) => e?.type === "checkpoint" && e.id);
  if (cps.length === 0) return "(no checkpoints logged yet)";
  return cps
    .map(
      (e) =>
        `${e.id}: ${e.judgment ?? "?"}` +
        (e.student_response ? ` — "${String(e.student_response).slice(0, 120)}"` : ""),
    )
    .join("\n");
}

function sessionLogPath(): string {
  return path.join(process.cwd(), "session_artifacts", "session_log.jsonl");
}

/** The tutor no longer hand-writes JSON: the extension owns the graded log. */
function appendLog(entry: Record<string, unknown>): boolean {
  try {
    fs.mkdirSync(path.dirname(sessionLogPath()), { recursive: true });
    fs.appendFileSync(
      sessionLogPath(),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Ground truth for the graded artifact: the student's own messages, read
 * straight from the transcript, so a logged answer can never drift into
 * paraphrase. Returns what they typed since the previous checkpoint.
 *
 * AN INDEX INTO A LIST THAT CAN GET SHORTER, and that is why session_start
 * resets it. pi's `/new` and `/resume` are in-process: they tear the runtime
 * down and build a fresh one, but the extension MODULE is not re-evaluated —
 * pi's loader returns the cached factory — so everything at this scope keeps
 * the value it had in the session that just ended. The new session's branch
 * starts empty, `allStudentMessages(ctx).slice(30)` on a two-message branch is
 * `[]`, and the first checkpoint of the new session logs
 * `student_said_verbatim: []` with nothing to say why.
 *
 * Compaction does NOT do this — it only appends, and getBranch() walks
 * parentId, so it never shortens. A session switch does.
 */
let studentSaidMark = 0;
/**
 * WHERE the previous checkpoint closed, as a branch ENTRY ID.
 *
 * The mark above counts filtered student messages. That is enough to say
 * "since the last close" and nothing at all about the TUTOR's turns in
 * between — so a checkpoint's note quoted everything typed since the PREVIOUS
 * one closed, including turns spoken before its own first question existed. A
 * live m02-small-world session put "yeah a little demo would be cool!" and
 * "yes ready!" — chapter 1's detour reply and its closing pace answer — into
 * cp2_distance's note, and "hello? are you still there?", a nudge typed into
 * a stalled terminal, into cp3_average's. cp3_global_clustering's note was
 * clean in the same session because nothing intervened there, which is what
 * proves this is the window boundary and not a filtering gap. See
 * the note cell's own window, back when the note quoted them.
 *
 * An id and not an index. getBranch() walks the parent chain from the current
 * leaf, so a rewind or a re-branch hands back a different path, and a number
 * we stored would point at a different turn — in the worst case one LATER
 * than the real boundary, which is the one direction this file cannot afford:
 * it would drop the student's own answer out of their own note. An id that is
 * no longer on the branch is simply not found, and the window stands as it is
 * today.
 */
let closedAtEntryId: string | null = null;
// Every pi.sendMessage injection lands in the transcript with role "user".
// Anything added here MUST start with one of these prefixes, or it is filed
// as the student's own words and quoted back at them in the graded record.
/**
 * The messages this toolkit prints for the STUDENT rather than for the tutor.
 * There are two, and both are things to act on: where the notebook is, and
 * "your tutor cannot reach the course server". Everything else the extension
 * injects is a brief the tutor reads and the student never sees.
 */
const STUDENT_FACING_MESSAGES = new Set(["setup-help", "notebook-url"]);

// Built rather than written out, so the banner's own opener cannot drift from
// the test that filters it. A message this toolkit printed must never be filed
// as something the student typed: a graded row in this repo already carries 44
// words of chapter prose as a student's first verbatim utterance.
const INJECTED_PREFIX = new RegExp(
  `^(CHAPTER SCRIPT|RESUME CONTEXT|=== TUTORING HANDOFF|The student clicked|` +
    `Please start the tutoring session|── Chapter |NOTE \\(invisible to the student\\)|` +
    `REFEREE VERDICT|⚠ {2}Your tutor cannot reach|${NOTEBOOK_BANNER_PREFIX})`,
);

/**
 * Curriculum prose that must never be filed as something the student said.
 *
 * The prefix test above catches an injected message by how it STARTS, which
 * is enough while the message arrives whole. It did not hold: a graded row
 * in this repo carries 44 words of chapter-opening prose as the student's
 * first verbatim utterance, quoted back at them inside their own note cell
 * under "What I said we could throw away". The opening reaches the model
 * nested inside the CHAPTER SCRIPT message (chapterScriptMessage quotes it,
 * so the tutor does not read it aloud), and something between there and
 * getBranch() — compaction is the suspect — hands it back as a bare user
 * turn with the prefix gone.
 *
 * Rather than guess at the path, refuse the CONTENT. A student does not type
 * their own chapter opening word for word, so an exact match is safe, and it
 * closes the hole whatever re-wraps the message. Memoised per chapter file:
 * this runs once per captured message.
 */
let scriptProseCache: { key: string; set: Set<string> } | null = null;
function scriptProse(): Set<string> {
  const key = currentChapterId() ?? "";
  if (scriptProseCache?.key === key) return scriptProseCache.set;
  const set = new Set<string>();
  try {
    for (const ch of loadChapters()) {
      const op = chapterOpening(ch);
      // Openings only. Chapter TITLES were in here for one draft, and one of
      // them is the single word "Abstraction" — which is exactly what a
      // student may type as their answer at cp2_abstraction. A guard against
      // losing the student's words must not be the thing that loses them.
      if (op && op.length > 80) set.add(op);
    }
  } catch {
    // no chapters is not a reason to lose the student's words
  }
  scriptProseCache = { key, set };
  return set;
}

/**
 * The spoken text of a message's content. TEXT parts only: a reasoning trace
 * says "the user wants…" as a matter of course and is not anybody speaking to
 * anybody, and a tool_use block is not speech — the same rule message_update
 * and tutorAwaitingAnswer already apply, each in its own copy of this.
 */
function partsText(c: any): string {
  return (
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c
            .filter((p: any) => p?.type === "text" && typeof p.text === "string")
            .map((p: any) => p.text)
            .join("\n")
        : ""
  ).trim();
}

/**
 * The student's own turns, each with WHERE in the branch it sits.
 *
 * The position is what gives the capture window a second edge instead of
 * being a tail. Carried here rather than recomputed by
 * a second walk with a second copy of the INJECTED_PREFIX / scriptProse
 * rules: two guards reading the same transcript and disagreeing about what
 * counts is how a `_photo` cell holding no upload came to be refused for
 * having no photo in it.
 */
function allStudentTurns(ctx: any): { text: string; at: number }[] {
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
  const out: { text: string; at: number }[] = [];
  const prose = scriptProse();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e?.type !== "message" || e?.message?.role !== "user") continue;
    const s = partsText(e.message.content);
    if (!s || INJECTED_PREFIX.test(s) || prose.has(s)) continue;
    out.push({ text: s, at: i });
  }
  return out;
}

function allStudentMessages(ctx: any): string[] {
  return allStudentTurns(ctx).map((t) => t.text);
}

/**
 * Mark every message the tutor answered by giving out the notebook's address.
 *
 * The second of `mechanicsAsked`'s two facts. "Where is my notebook?" does not
 * announce itself in the student's wording — xi-io wrote four sentences about
 * `.py` files — but the tutor's ANSWER does, because the address is a string
 * this process owns. If the reply to a message carried it, that exchange was
 * about finding the notebook, whatever either of them typed.
 *
 * Only the first thing said back, and never past their next message: a URL
 * mentioned three turns later is a different exchange.
 */
function markUrlAnsweredTurns(ctx: any): void {
  try {
    if (!/^https?:\/\/\S+$/.test(process.env.MARIMO_URL ?? "")) return;
    const host = marimoBase();
    const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const t of allStudentTurns(ctx)) {
      for (let i = t.at + 1; i < entries.length; i++) {
        const e = entries[i];
        if (e?.type !== "message") continue;
        const role = e?.message?.role;
        if (role === "user") break; // their next message: this reply is over
        if (role !== "assistant") continue;
        const text = partsText(e.message.content);
        if (!text) continue; // a tool-only turn is not the answer yet
        if (text.includes(host)) mechanicsAsked.add(normMsg(t.text));
        break;
      }
    }
  } catch {
    // A transcript we cannot read narrows nothing, like every other reader here.
  }
}

/**
 * The question the tutor asked and never got an answer to, or "".
 *
 * `checkpoint_done` opens a dialog, and a dialog takes over the keyboard: a
 * live run ended its reveal with "what would you expect on a ring of 800
 * dots?" and closed the checkpoint in the same breath. The student's typed
 * answer went into the dialog instead of the conversation, vanished from the
 * transcript entirely, and the picker resolved itself to READY — so the
 * pacing gate the student was supposed to hold passed without them.
 */
function tutorAwaitingAnswer(ctx: any): string {
  try {
    const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type !== "message") continue;
      const role = e?.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const c = e.message.content;
      const text = (
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .filter((p: any) => p?.type === "text" && typeof p.text === "string")
                .map((p: any) => p.text)
                .join("\n")
            : ""
      ).trim();
      // A tool-only assistant turn is not the tutor speaking.
      if (!text) continue;
      if (role === "user") return "";
      // The LAST FEW lines, not only the last one. A question followed by a
      // closing remark is the commonest shape the tutor produces — ch1's
      // reveal_after scripts it that way in so many words ("THEN one typed
      // follow-up … Bridge: …") — and looking only at the final line meant the
      // guard went quiet on exactly the turn it exists for: the picker opened
      // over an unanswered question, the student's typed reply went into it,
      // and the checkpoint was logged with nothing of theirs to quote.
      for (const last of text
        .split(/\n+/)
        .filter(Boolean)
        .map((l: string) => l.trim())
        .slice(-3)
        .reverse()) {
        // Not only a trailing "?": a live run asked "does that mean your camera's
        // working now?" and then added "Just so I know for the next paper page."
        // — so the line ended in a full stop, the guard stayed quiet, and the
        // picker ate the answer exactly as before. Take the last sentence that
        // IS a question.
        // A question the tutor QUOTES is not a question it is waiting on:
        // `You wrote "is it 6?" earlier.` fired the guard and reported the
        // fragment `you just asked "You wrote "`. Mask quoted spans (same
        // length, so offsets still line up) before looking for the "?".
        const masked = last.replace(/[\u201C"][^\u201D"]*[\u201D"]/g, (m) => " ".repeat(m.length));
        if (!masked.includes("?")) continue;
        const end = masked.lastIndexOf("?") + 1;
        const upTo = last.slice(0, end);
        const parts = masked.slice(0, end - 1).split(/(?<=[.!?])\s+/);
        const startAt = parts.length > 1 ? upTo.length - parts[parts.length - 1].length - 1 : 0;
        return upTo.slice(Math.max(0, startAt)).trim();
      }
      return "";
    }
  } catch {
    /* a transcript we cannot read never blocks a close */
  }
  return "";
}

/**
 * A picker answer never becomes a transcript message, so until now the graded
 * record had NO independent evidence of it — and a live run logged
 * "Comfortable with Python" for a student who had picked "I don't code",
 * miscalibrating the whole session and putting the opposite of their answer
 * in the artifact they submit. These are captured straight off the
 * ask_user_question tool result instead.
 */
const pickedAnswers: PickRecord[] = [];
let pickedMark = 0;
/**
 * Set while the resume brief is in flight. The continue-or-fresh dialog is
 * session mechanics, not an answer to a lesson question, so its result is
 * dropped instead of riding into the next checkpoint's `student_picked`.
 */
let awaitingResumeChoice = false;

function recordPickedAnswer(event: any): void {
  try {
    // The decision lives in lib/verbatim.ts, where `npm test` can reach it.
    // Only the two mutable globals stay here.
    const r = capturePick(event, awaitingResumeChoice);
    if (r.resumeAnswered) awaitingResumeChoice = false;
    for (const p of r.picks) pickedAnswers.push(p);
  } catch {
    // capture is best-effort; never break a turn
  }
}

function pickedSince(commit = true): PickRecord[] {
  const fresh = pickedAnswers.slice(pickedMark);
  if (commit) pickedMark = pickedAnswers.length;
  return fresh;
}

/**
 * Every pick as plain text, machinery included.
 *
 * Whatever the split does to the ROW, both halves stay in every pool that
 * checks the student's words against what they said. Leaving picks out of that
 * pool refused cp1's honest record twice — "about 20", a figure that appears
 * in neither the typed follow-up nor the question — and then stamped a false
 * quoting warning on the notebook they submitted. Splitting them into two
 * fields is a second way to leave them out, and it must not become one.
 */
function pickedTexts(fresh: PickRecord[] = pickedAnswers.slice(pickedMark)): string[] {
  return fresh.map((p) => p.answer).filter(Boolean);
}

function studentSaidSince(ctx: any, commit = true): string[] {
  try {
    const all = allStudentMessages(ctx);
    const fresh = all.slice(studentSaidMark);
    if (commit) {
      studentSaidMark = all.length;
      // The two marks advance in the SAME statement, deliberately. A second
      // mark that moves somewhere else is how every capture fault in this
      // file begins: one of the two is always the one that got missed.
      const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
      closedAtEntryId = entries.length ? (entries[entries.length - 1]?.id ?? null) : null;
    }
    return fresh;
  } catch {
    return [];
  }
}

/**
 * Pull a checkpoint's instructor-authored `note:` block out of its chapter
 * YAML (block scalar, dedented). The tutor fills «slots», not prose.
 */
// Exact id only. A practice round (`cp2_distance_extra`) is the same QUESTION
// on new DATA, so its base checkpoint's skeleton is wrong for it: cp2's says
// "$L = 7/6$", while the practice variant is a star ($L = 9/6$). The tutor
// writes note_markdown for those, per AGENTS.md.
function checkpointBlock(cpId: string, key: string): string {
  try {
    const chapter = loadChapters().find((c) => c.checkpoints.includes(cpId));
    if (!chapter) return "";
    const lines = fs
      .readFileSync(path.join(process.cwd(), "lesson", chapter.file), "utf-8")
      .split("\n");
    const idRe = new RegExp(`^\\s*-\\s+id:\\s*${cpId}\\s*$`);
    const start = lines.findIndex((l) => idRe.test(l));
    if (start < 0) return "";
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*-\s+id:\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    for (let i = start; i < end; i++) {
      const m = new RegExp(`^(\\s*)${key}:\\s*\\|`).exec(lines[i]);
      if (!m) continue;
      const keyIndent = m[1].length;
      const block: string[] = [];
      for (let j = i + 1; j < end; j++) {
        const l = lines[j];
        if (!l.trim()) {
          block.push("");
          continue;
        }
        if (l.length - l.trimStart().length <= keyIndent) break;
        block.push(l);
      }
      const indents = block.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
      const base = indents.length ? Math.min(...indents) : 0;
      return block.map((l) => l.slice(base)).join("\n").trim();
    }
    return "";
  } catch {
    return "";
  }
}

/** A checkpoint's instructor-authored `note:` skeleton. */
function noteSkeleton(cpId: string): string {
  return checkpointBlock(cpId, "note");
}

/**
 * `note: none` in the script — this checkpoint gets NO note cell. Some
 * checkpoints are session mechanics, not lecture: cp0 calibrates how much
 * code the student wants to see, and a cell about that is the first thing a
 * cold reader meets in a document that has not begun. The answer still gets
 * logged and still lands in the closing session_record.
 *
 * It suppresses the "where to next?" picker as well, for the same reason:
 * mechanics ask the student nothing, so there is no answer to pace against.
 * See the picker in checkpoint_done.
 */
function noteSuppressed(cpId: string): boolean {
  try {
    const chapter = loadChapters().find((c) => c.checkpoints.includes(baseCheckpointId(cpId)));
    if (!chapter) return false;
    const lines = fs
      .readFileSync(path.join(process.cwd(), "lesson", chapter.file), "utf-8")
      .split("\n");
    const start = lines.findIndex((l) =>
      new RegExp(`^\\s*-\\s+id:\\s*${baseCheckpointId(cpId)}\\s*$`).test(l),
    );
    if (start < 0) return false;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*-\s+id:\s/.test(lines[i])) break;
      if (/^\s*note:\s*none\s*$/.test(lines[i])) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Does the script offer a practice variant for this checkpoint? */
function hasFreshVariants(cpId: string): boolean {
  return checkpointBlock(cpId, "fresh_variants").trim().length > 0;
}

/**
 * The cell names a checkpoint's `build:` promises — every
 * `nb_add_template("X")` in it, resolved through `cells/X.py`'s
 * `# --- cell: NAME ---` markers.
 *
 * Used to catch a build the tutor simply never did. cp5_ring_formula asks
 * seven things in sequence and the seventh is "photograph that page"; in a
 * live run the model reached the end of the reasoning, decided the answer
 * was complete, and closed the checkpoint — the upload area was never
 * inserted and the student was never asked for the photo at all. The
 * hand-worked page is the point of those checkpoints, so a promise in the
 * script is checked rather than trusted.
 */
function scriptedBuildCells(cpId: string): string[] {
  const build = checkpointBlock(cpId, "build");
  if (!build.trim() || /^\s*none\s*$/i.test(build)) return [];
  const out: string[] = [];
  // Tolerate the argument form the tool itself asks for —
  // nb_add_template("x", checkpoint="cp4") — and a named first argument.
  // Requiring the bare one-arg call meant an instructor aligning a build:
  // line with the tool contract silently switched this guard off.
  for (const m of build.matchAll(/nb_add_template\(\s*(?:template\s*=\s*)?["']([\w-]+)["']/g)) {
    try {
      const src = fs.readFileSync(path.join(process.cwd(), "cells", `${m[1]}.py`), "utf-8");
      for (const c of src.matchAll(/^#\s*---\s*cell:\s*(\w+)\s*---/gm)) out.push(c[1]);
    } catch {
      // an unknown template name is nb_add_template's problem, not ours
    }
  }
  return out;
}

/**
 * Of a checkpoint's build cells, the ones that actually ask for a photograph.
 *
 * A cell holds a drop area when it CREATES one — `mo.ui.file(...)` — which is
 * the same test nb_add_template uses to decide whether to tell the tutor to
 * ask for the page. The photo gate below used to look at the cell's NAME
 * instead, and any name ending in `_photo` armed it. m01's chapter 3 reveals
 * the 1944 bombing with a historical plate in a cell called
 * `cp3_bombed_photo`: display-only, nothing to upload, and no ask anywhere in
 * the script. Closing that checkpoint was refused with "no photo has reached
 * me", and the second attempt logged it stamped `photo_missing`, which the
 * closing summary prints as a page the student never took. Two guards reading
 * the same build disagreed about what a photo cell is; now they run the same
 * test.
 */
function scriptedPhotoCells(cpId: string): string[] {
  const build = checkpointBlock(cpId, "build");
  if (!build.trim() || /^\s*none\s*$/i.test(build)) return [];
  const out: string[] = [];
  for (const m of build.matchAll(/nb_add_template\(\s*(?:template\s*=\s*)?["']([\w-]+)["']/g)) {
    try {
      const src = fs.readFileSync(path.join(process.cwd(), "cells", `${m[1]}.py`), "utf-8");
      // Split on the cell markers, keeping each name with the body under it.
      const parts = src.split(/^#\s*---\s*cell:\s*(\w+)\s*---$/m);
      for (let i = 1; i < parts.length; i += 2) {
        if (/\bmo\.ui\.file\s*\(/.test(parts[i + 1] ?? "")) out.push(parts[i]);
      }
    } catch {
      // an unknown template name is nb_add_template's problem, not ours
    }
  }
  return out;
}

/**
 * How many questions the checkpoint's own script asks, counted from the
 * numbered list in its `ask` block ("1." … "2." …). Zero when the block does
 * not number them, which switches the check that uses this off rather than
 * guessing.
 */
function scriptedQuestionCountFor(cpId: string): number {
  return scriptedQuestionCount(checkpointBlock(cpId, "ask"));
}

/**
 * The checkpoint's `reveal_after` block, or "" when its script has none.
 *
 * cp0_welcome carries none on purpose — ch1's own comment says "No hints and
 * no reveal_after, deliberately: there is no question here to hint toward" —
 * and its `ask` orders the tutor to greet and close in one breath. A silence
 * guard firing there would be refusing the script. Read from the script and
 * not from a list of ids, because cp1 DOES have one in both modules
 * (cp1_milgram, cp1_routing, cp1_bridges), and a hardcoded cp0/cp1 exemption
 * would have switched the guard off on two checkpoints that need it. An id
 * the script does not know returns "" as well, which switches the guard off
 * rather than guessing — the direction every gate in this file fails.
 */
function scriptedReveal(cpId: string): string {
  const r = checkpointBlock(cpId, "reveal_after").trim();
  return /^none$/i.test(r) ? "" : r;
}

/**
 * Has the tutor SAID anything since the student last typed?
 *
 * checkpoint_done opens the "Where to next?" picker, and a picker under a
 * silent close is everything the student gets for a right answer. In one live
 * m02 session it happened three times: at cp2_diameter the pane went from
 * their correct answer straight to "Writing that into your notebook…" and the
 * dialog — the tool call sat in an assistant message with no text block in it
 * at all, so the reveal that was the payoff for that answer was never spoken.
 * cp3_clustering went the same way, and the turn after it came back
 * completely empty, so the terminal sat dead until the student typed "hello?
 * are you still there?" — which then landed in the next checkpoint's note as
 * their own worked answer. AGENTS.md has forbidden this in prose for as long
 * as there has been a reveal; a prohibition in prose is the weaker fix.
 *
 * The window is "since they last typed", not "in this message". A tutor that
 * gives the reveal and then runs one more cell before closing has still given
 * it, and refusing that shape would be refusing honest work. What must never
 * happen is a beat with the student's words at one end and a dialog at the
 * other and nothing in between.
 *
 * The tutor's own message is already in the branch when one of its tools runs
 * — message_end persists it before the tool batch executes — which is the
 * same fact tutorAwaitingAnswer above depends on to catch a question asked in
 * this very breath.
 *
 * Boundaries are the student's typed turns and this extension's own injected
 * briefs. An injection persists as `type: "custom_message"` with its content
 * at entry level, so the readers above never see one; here it counts, because
 * speech owed after a fresh brief is speech owed now. A tool result is not a
 * boundary — role "toolResult" is the notebook answering, not anybody
 * speaking. A tool-only assistant message is not the tutor speaking either;
 * it is exactly what the three silent closes looked like.
 *
 * A walk that reaches the top without finding either end, or a transcript we
 * cannot read: true. Nothing here blocks a close on a guess.
 */
function tutorSpokeSinceStudent(ctx: any): boolean {
  try {
    const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "custom_message") {
        // Two of these are not briefs to the tutor at all — they are lines
        // this toolkit prints for the STUDENT to act on (where the notebook
        // is; the model is unreachable). Speech owed after a fresh brief is
        // speech owed now, but nothing is owed because the extension put a
        // sentence on the screen: counting them stamped a false
        // `closed_without_speaking` on the graded row of any checkpoint the
        // notebook happened to finish booting inside.
        if (STUDENT_FACING_MESSAGES.has(String(e.customType ?? ""))) continue;
        if (partsText(e.content)) return false;
        continue;
      }
      if (e?.type !== "message") continue;
      const role = e?.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = partsText(e.message.content);
      if (!text) continue;
      return role === "assistant";
    }
  } catch {
    /* a transcript we cannot read never blocks a close */
  }
  return true;
}

/** Names of every cell currently in the notebook, or null if unreadable. */
/**
 * Questions the student asked that are already recorded as detours. Their own
 * question is not their answer, and log_detour deliberately peeks at the
 * transcript without consuming it, so without this the question is quoted
 * twice: once in the souvenir, once in the next checkpoint's note as work.
 * Cleared when the checkpoint that follows them closes.
 */
const detourAsked = new Set<string>();

/**
 * The stretches of this checkpoint's window that belong to a DETOUR, as
 * [first, last] indices into what studentSaidSince last handed back.
 *
 * `detourAsked` drops the question and nothing else, so the rest of the
 * exchange stayed in the checkpoint's note. A live run put "yes please, that
 * would help" — the student accepting an offered souvenir cell — into
 * cp1_routing's note as their worked answer on the routing question, and it
 * was the only note in that session with anything wrong in it, because it was
 * the only checkpoint a detour sat in front of.
 *
 * A SPAN and not a new window start, which is the whole difference between
 * this and the two shapes that had to be rejected. Detours happen INSIDE
 * checkpoints — AGENTS.md builds the lesson around that — so anything that
 * moved the window forward to the detour would take with it every answer the
 * student had already given before asking their question. A span reaches from
 * their question to the moment log_detour recorded it, and touches nothing on
 * either side of that.
 *
 * Cleared with detourAsked, when the checkpoint closes.
 */
const detourSpans: [number, number][] = [];

/**
 * Messages that were about the SESSION and not about the lesson.
 *
 * `detourAsked` in the other currency: normalised text, dropped from the note
 * cell wherever it sits in the window, and cleared when the checkpoint closes.
 *
 * A live run left two of these in cp1_bridges' note under "My guess, and how
 * far I got" — the student asking which file the notebook was and saying the
 * browser had not opened, printed as their work on the seven bridges. Every
 * existing narrowing kept them: they are sentences, so not filler; nothing
 * called log_detour, so no span; they came after the tutor spoke, so the
 * pre-question cut does not reach them.
 *
 * FILLED FROM FACTS ONLY. Two of them, and both are things this process did
 * rather than things it thinks the student meant:
 *
 *   1. the message that made the toolkit run `nb_notebook_url`;
 *   2. a message whose reply carried the notebook's own address — the tutor
 *      answering "where is it?" with the URL, which is a string this process
 *      owns and can test for exactly.
 *
 * A word list over the student's own words is what this must never become:
 * ACK_WORDS has twice deleted real answers from a graded artifact, and the
 * rule there — the boundary decides what to drop, content may only rescue —
 * holds here too. `student_said_verbatim` is untouched either way; every word
 * they typed stays on the row, which is where #4 was found.
 */
const mechanicsAsked = new Set<string>();

/**
 * Injections that end one chapter's conversation and begin the next. Both are
 * written by this file (chapterScriptMessage, and the divider beside it), so
 * this holds for m01, m02 and anything authored later. customType FIRST and
 * the text prefix second: the prefix test in INJECTED_PREFIX is the one that
 * has already failed once, when something between sendMessage and getBranch
 * re-wrapped a message and lost it.
 */
const CHAPTER_BOUNDARY_TYPES = new Set(["chapter-script", "chapter-divider"]);


async function notebookCellNames(signal?: AbortSignal): Promise<string[] | null> {
  const r = await runKernel(
    `import marimo._code_mode as cm\n` +
      `async with cm.get_context() as ctx:\n` +
      `    print("CELLS<<" + ",".join(str(getattr(c, "name", "")) for c in ctx.cells) + ">>")\n`,
    signal,
  );
  if (r.failed) return null;
  const m = /CELLS<<(.*)>>/.exec(r.out);
  return m ? m[1].split(",").filter(Boolean) : null;
}

/**
 * The source of a named cell, or null when it cannot be read (kernel cold,
 * marimo API shifted). Used to CHECK a souvenir the tutor built itself —
 * the `cell_name` path was the unchecked half of the contract, and it is
 * the path the model actually takes.
 */
async function readCellSource(name: string, signal?: AbortSignal): Promise<string | null> {
  const r = await runKernel(
    `import marimo._code_mode as cm\n` +
      `async with cm.get_context() as ctx:\n` +
      `    _c = None\n` +
      `    for _x in ctx.cells:\n` +
      `        if getattr(_x, "name", None) == ${py(name)}:\n` +
      `            _c = _x\n` +
      `    if _c is None:\n` +
      `        print("SOUVENIR_MISSING")\n` +
      `    else:\n` +
      `        _src = ""\n` +
      `        for _a in ("code", "source", "text"):\n` +
      `            _v = getattr(_c, _a, None)\n` +
      `            if isinstance(_v, str) and _v.strip():\n` +
      `                _src = _v\n` +
      `                break\n` +
      `        print("SOUVENIR_SRC<<")\n` +
      `        print(_src)\n` +
      `        print(">>SOUVENIR_SRC")\n`,
    signal,
  );
  if (r.failed) return null;
  if (r.out.includes("SOUVENIR_MISSING")) return "";
  const m = /SOUVENIR_SRC<<\n([\s\S]*?)\n>>SOUVENIR_SRC/.exec(r.out);
  const src = m?.[1] ?? "";
  // Empty means the attribute walk found nothing — unknown, not empty. A
  // check that cannot see the cell must stand down, never accuse.
  return src.trim() ? src : null;
}

/**
 * Put the student's own question at the top of a souvenir cell the tutor
 * built. The bounce asks for it once; if the retry still paraphrases, the
 * quote is one line and we have it — better in the keepsake by machine than
 * absent forever, which is what "bounce once, then accept" left behind.
 */
async function prependQuestionToCell(
  name: string,
  question: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const src = await readCellSource(name, signal);
  if (!src) return false;
  // The rewrite is done by Python, in the kernel, with `ast` — the cell's
  // last top-level statement is a thing only a parser can find. String
  // surgery on "the last unindented line" put the quote UNDER the picture
  // for a souvenir whose vstack closes on its own line, and produced
  // unparseable source for a multi-line netviz(...) call. Both are shapes
  // nb_review.py itself emits.
  const quote = `mo.md(r"""> 🧭 **You asked:** “${question.replace(/"""/g, '"')}”""")`;
  const r = await runKernel(
    `import ast\n` +
      `import marimo._code_mode as cm\n` +
      `_src = ${py(src)}\n` +
      `_quote = ${py(quote)}\n` +
      `_tree = ast.parse(_src)\n` +
      `_lines = _src.split("\\n")\n` +
      `if not _tree.body or not isinstance(_tree.body[-1], ast.Expr):\n` +
      `    print("NOT_A_DISPLAY")\n` +
      `else:\n` +
      `    _last = _tree.body[-1]\n` +
      `    _head = "\\n".join(_lines[: _last.lineno - 1])\n` +
      `    _tail = "\\n".join(_lines[_last.lineno - 1 : _last.end_lineno])\n` +
      // Everything AFTER the last top-level expression — a trailing comment,
      // a blank line. It was dropped on every successful prepend, silently.
      `    _foot = "\\n".join(_lines[_last.end_lineno :])\n` +
      `    _v = _last.value\n` +
      `    _is_vstack = (\n` +
      `        isinstance(_v, ast.Call)\n` +
      `        and isinstance(_v.func, ast.Attribute)\n` +
      `        and _v.func.attr == "vstack"\n` +
      `        and _v.args\n` +
      `        and isinstance(_v.args[0], ast.List)\n` +
      `    )\n` +
      `    if _is_vstack:\n` +
      `        _open = _tail.index("[") + 1\n` +
      `        _body = _tail[:_open] + "\\n    " + _quote + "," + _tail[_open:]\n` +
      `    else:\n` +
      `        _indented = "\\n".join("    " + _l for _l in _tail.split("\\n"))\n` +
      `        _body = "mo.vstack([\\n    " + _quote + ",\\n" + _indented + ",\\n])"\n` +
      `    _new = (_head + "\\n" + _body) if _head else _body\n` +
      `    if _foot.strip():\n` +
      `        _new = _new + "\\n" + _foot\n` +
      `    ast.parse(_new)\n` +
      `    async with cm.get_context() as ctx:\n` +
      `        ctx.edit_cell(${py(name)}, _new)\n` +
      `        ctx.run_cell(${py(name)})\n` +
      `    print("QUOTED")\n`,
    signal,
  );
  return !r.failed && r.out.includes("QUOTED");
}

/**
 * Put the student's question in a cell of its OWN, directly above the
 * souvenir.
 *
 * The second route to the same one line, for when the first will not go. The
 * quote is the extension's job — "The quote line is the extension's job, not
 * the model's" is written at log_detour's own gap check — and until now a
 * `false` from prependQuestionToCell simply lost it, silently, with the
 * prose-only warning printing over the top. Two of one student's three
 * souvenirs shipped with the tutor's paraphrase of their question instead of
 * their words, and the row said nothing.
 *
 * ADDITIVE, and that is the point: it opens no cell it has to reparse, so the
 * shape that defeated the prepend cannot defeat it as well. String surgery on
 * a live souvenir is what the ast rewrite above exists to avoid, and this
 * writes nothing into the tutor's cell at all.
 */
async function quoteCellBeside(
  souvenir: string,
  question: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!question.trim()) return false;
  const name = `${sanitize(souvenir)}_asked`;
  const body = `mo.md(${pyMd(`> 🧭 **You asked:** “${question}”`)})`;
  const r = await runKernel(
    `import marimo._code_mode as cm\n` +
      `async with cm.get_context() as ctx:\n` +
      `    _names = [c.name for c in ctx.cells]\n` +
      `    if ${py(name)} in _names:\n` +
      `        print("QUOTED")\n` +
      `    else:\n` +
      `        _t = [c for c in ctx.cells if c.name == ${py(souvenir)}]\n` +
      `        _qid = None\n` +
      // `before=` is the tidy way and may not exist on every marimo we run
      // against; the fallback needs only create_cell and move_cell, both of
      // which this file already depends on elsewhere.
      `        try:\n` +
      `            _qid = ctx.create_cell(${py(body)}, name=${py(name)}, hide_code=True, before=_t[0].id) if _t else None\n` +
      `        except TypeError:\n` +
      `            _qid = None\n` +
      `        if _qid is None:\n` +
      `            _qid = ctx.create_cell(${py(body)}, name=${py(name)}, hide_code=True)\n` +
      `            if _t:\n` +
      `                ctx.move_cell(_t[0].id, after=_qid)\n` +
      `        ctx.run_cell(_qid)\n` +
      `        print("QUOTED")\n`,
    signal,
  );
  return !r.failed && r.out.includes("QUOTED");
}

/**
 * Notes whose cell could not be written, kept on disk exactly as rendered.
 *
 * The tutor must never re-author one: a live outage put a chapter boundary
 * (and a context compaction) between the answer and the retry, and the
 * rebuilt note paraphrased the student in the artifact their work is graded
 * from. Parked here, the text is the same bytes whenever it lands.
 */
const parkedDir = () => path.join(process.cwd(), "session_artifacts", "parked_notes");

function parkNote(id: string, markdown: string): void {
  try {
    fs.mkdirSync(parkedDir(), { recursive: true });
    // The chapter rides in the filename: at flush, a note belonging to the
    // CURRENT chapter may create that chapter's heading, while one recovered
    // into a later chapter must not — otherwise it is filed under a chapter
    // it has nothing to do with, or lands above its own heading.
    const chapter = sanitize(currentChapterId() || "ch");
    fs.writeFileSync(path.join(parkedDir(), `${chapter}--${sanitize(id)}.md`), markdown);
  } catch {
    // best effort — the log still holds the student's words
  }
}

/** Drop a parked note once its cell is safely in the notebook. */
function unparkNote(id: string): void {
  try {
    const chapter = sanitize(currentChapterId() || "ch");
    fs.rmSync(path.join(parkedDir(), `${chapter}--${sanitize(id)}.md`), { force: true });
  } catch {
    // A leftover park file is harmless: flushParkedNotes skips a cell that is
    // already on the page, and the closing summary only lists what is left.
  }
}

/**
 * Insert every parked note, oldest first, before anything else goes in.
 * Called at the top of each build so a recovered note lands in its own
 * place rather than after the cells added while the notebook was down.
 */
async function flushParkedNotes(signal?: AbortSignal): Promise<void> {
  let files: string[];
  try {
    files = fs
      .readdirSync(parkedDir())
      .filter((f) => f.endsWith(".md"))
      // By WHEN they were parked. Sorting names put cp6_large_n_experiment
      // before cp6_watts_strogatz, which is back to front.
      .map((f) => ({ f, t: fs.statSync(path.join(parkedDir(), f)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .map(({ f }) => f);
  } catch {
    return;
  }
  for (const f of files) {
    const full = path.join(parkedDir(), f);
    try {
      const md = fs.readFileSync(full, "utf-8");
      const [chapter, cell] = f.replace(/\.md$/, "").split("--");
      const ownChapter = !!cell && chapter === (currentChapterId() || "");
      const r = await insertMarkdownCell(cell ?? chapter, md, signal, !ownChapter);
      if (!r.failed) fs.rmSync(full, { force: true });
    } catch {
      return;
    }
  }
}

/** Insert (or skip, if present) a markdown cell and scroll the page to it. */
async function insertMarkdownCell(
  name: string,
  markdown: string,
  signal?: AbortSignal,
  skipHeader = false,
): Promise<{ out: string; failed: boolean; reason?: string }> {
  const warm = await ensureWarm(signal);
  if (warm) return warm;
  // A note recovered from an outage belongs to the chapter it was written
  // in, so it must not be the thing that creates the CURRENT chapter's
  // heading — that would file it under a chapter it has nothing to do with.
  if (name !== "session_record" && !skipHeader) await ensureChapterHeader(signal);
  // Parked notes go in before anything else, so a note recovered after an
  // outage lands in its own place rather than after the cells written while
  // the notebook was down.
  const body = `mo.md(${pyMd(markdown)})`;
  const r = await runKernel(
    `import marimo._code_mode as cm\n` +
      `async with cm.get_context() as ctx:\n` +
      `    _names = [c.name for c in ctx.cells]\n` +
      `    if ${py(name)} in _names:\n` +
      `        print("note cell already there — skipped")\n` +
      `    else:\n` +
      `        _cid = ctx.create_cell(${py(body)}, name=${py(name)}, hide_code=True)\n` +
      `        ctx.run_cell(_cid)\n` +
      focusCellCode("_cid", "        "),
    signal,
  );
  if (!r.failed) await pinAppealToBottom(signal);
  return r;
}

/**
 * Keep the ⚖️ "Tutor gets stuck" box the LAST thing on the page: every
 * insert lands above it, so the student always finds the appeal box at the
 * bottom, right under the newest material. The box's two cells are
 * anonymous on purpose (nb_fresh_start's wipe deletes every NAMED cell),
 * so they are found by their code instead of a name. Moves are visual only
 * — no cell re-executes. Purely cosmetic: a failure never blocks an insert.
 */
async function pinAppealToBottom(signal?: AbortSignal): Promise<void> {
  try {
    await runKernel(
      `import marimo._code_mode as cm\n` +
        `async with cm.get_context() as ctx:\n` +
        `    _app = [c.id for c in ctx.cells if "tutor_stuck_send" in c.code]\n` +
        `    _ids = [c.id for c in ctx.cells]\n` +
        `    if len(_app) == 2 and _ids[-2:] != _app:\n` +
        `        ctx.move_cell(_app[0], after=_ids[-1])\n` +
        `        ctx.move_cell(_app[1], after=_app[0])\n` +
        `    print("ok")\n`,
      signal,
    );
  } catch {
    /* cosmetic — never let pinning break an insert */
  }
}

/** The closing record + summary are DERIVED from the log, never retyped. */
function buildSessionRecord(entries: any[]): string {
  const cps = entries.filter((e) => e?.type === "checkpoint" && e.id);
  const detours = entries.filter((e) => e?.type === "detour");
  const lines = [
    "## 📋 Session record",
    "",
    "*Your answer to each question, and every word you typed while working on*",
    "*it — this is what gets reviewed, not the code. Hints are never held*",
    "*against you.*",
    "",
  ];
  for (const e of cps) {
    const hints = Number(e.hints_used ?? 0);
    // Two separate things, never conflated. The quote is the tutor's record
    // of the ANSWER — which for a picker choice or a drawing is the only
    // record there is. Beneath it, verbatim, goes everything the student
    // actually typed while working on this checkpoint, straight from the
    // transcript. Printing the capture AS the answer was wrong: a stray
    // "ok" typed while a dialog was open would have become their answer.
    const saidRaw: string[] = Array.isArray(e.student_said_verbatim)
      ? e.student_said_verbatim.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
      : [];
    const quote = String(e.student_response ?? "").trim();
    lines.push(
      `**${e.id}** · ${e.judgment ?? "?"}${hints ? ` · ${hints} hint${hints > 1 ? "s" : ""}` : ""}`,
      "",
      `*${String(e.question ?? "").trim()}*`,
      "",
      `> ${quote.replace(/\n+/g, " ")}`,
      "",
    );
    const pickedRaw: string[] = Array.isArray(e.student_picked)
      ? e.student_picked.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
      : [];
    if (pickedRaw.length) {
      lines.push(`*You chose:* ${pickedRaw.map((s) => `"${s}"`).join(" · ")}`, "");
    }
    // The housekeeping dialogs, on their own line and named as such. They used
    // to ride into *You chose:* — a submitted notebook has "Found it — I can
    // see the city now", the answer to an improvised "did the page open?",
    // printed as part of a graded prediction about the seven bridges.
    //
    // Shown rather than hidden, deliberately. The split is decided by a word
    // list over the TUTOR's question, and a word list can be wrong; if it ever
    // files a real answer here, the student can still see what they said. A
    // misroute must cost a label, never a line of the record.
    const mechRaw: string[] = Array.isArray(e.student_picked_mechanics)
      ? e.student_picked_mechanics.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
      : [];
    if (mechRaw.length) {
      lines.push(`*Getting set up:* ${mechRaw.map((s) => `"${s}"`).join(" · ")}`, "");
    }
    if (saidRaw.length) {
      lines.push(
        `*You typed:* ${saidRaw.map((s) => `"${s.replace(/\n+/g, " ")}"`).join(" · ")}`,
        "",
      );
    }
    if (e.notes) lines.push(`*Tutor's note:* ${String(e.notes).trim()}`, "");
    // A drift the tutor was warned about twice and logged anyway belongs in
    // the submitted artifact, not only in the log the student never opens.
    if (Array.isArray(e.verbatim_drift) && e.verbatim_drift.length) {
      lines.push(
        `*⚠ Quoting check: the wording above was flagged as not matching what you typed — ` +
          `your own words are the line above it.*`,
        "",
      );
    }
  }
  const scripted = checkpointOrder();
  const haveIds = new Set(cps.map((e) => baseCheckpointId(String(e.id))));
  const furthest = scripted.reduce((acc, id, i) => (haveIds.has(id) ? i : acc), -1);
  const holes = scripted.filter((c) => !haveIds.has(c) && scripted.indexOf(c) < furthest);
  const notReached = scripted.filter((c) => !haveIds.has(c) && scripted.indexOf(c) > furthest);
  let stillParked: string[] = [];
  try {
    stillParked = fs
      .readdirSync(parkedDir())
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, "").replace(/^[^-]*--/, ""));
  } catch {
    stillParked = [];
  }
  if (holes.length || notReached.length || stillParked.length) {
    lines.push(`### ⚠ Not everything is here`, "");
    if (stillParked.length) {
      lines.push(
        `*The notebook was unreachable when these notes were written, and it never came ` +
          `back, so they are saved beside this notebook rather than in it ` +
          `(session_artifacts/parked_notes/): ${stillParked.join(", ")}. Your answers ` +
          `themselves are in the record below.*`,
        "",
      );
    }
    if (holes.length) {
      lines.push(
        `*A session ended part-way and the next one carried on, so these have no answer ` +
          `of yours: ${holes.join(", ")}.*`,
        "",
      );
    }
    if (notReached.length) {
      lines.push(`*The module stops here — still to come: ${notReached.join(", ")}.*`, "");
    }
  }
  // "Your own questions" has to be their own. A detour whose question the
  // transcript could not back is one the tutor composed — log_detour keeps the
  // wording on the row and refuses to quote it in the souvenir, and the
  // closing record is the same keepsake by another route, so it is held to the
  // same rule. Printed either way: an aside the tutor took is worth having in
  // the record, just not under a heading that puts words in their mouth.
  const asked = detours.filter((d) => !d?.question_unsupported);
  const aside = detours.filter((d) => d?.question_unsupported);
  if (asked.length) {
    lines.push(`### 🧭 Your own questions (${asked.length})`, "");
    for (const d of asked) lines.push(`- *${String(d.question ?? "").trim()}*`);
    lines.push("");
  }
  if (aside.length) {
    lines.push(`### 🧭 Side trips we took (${aside.length})`, "");
    for (const d of aside) lines.push(`- *${String(d.question ?? "").trim()}*`);
    lines.push("");
  }
  return lines.join("\n");
}

function buildSessionSummary(entries: any[], allCheckpoints: string[]): string {
  const cps = entries.filter((e) => e?.type === "checkpoint" && e.id);
  // Count the SCRIPT's checkpoints, not the log rows: a practice round is
  // logged under its own `_extra` id, and counting those produced
  // "Checkpoints completed: 13 of 12" on the first full run — a summary the
  // grader cannot read as anything but a bug. Extra rounds are worth
  // reporting, just not as progress through the module.
  const done = new Set(cps.map((e) => baseCheckpointId(String(e.id))));
  const extras = cps.filter((e) => /_extra/.test(String(e.id))).length;
  const missing = allCheckpoints.filter((id) => !done.has(id));
  // Which curriculum produced this. A module gets edited between terms, and a
  // grader reading a submission six weeks later has no other way to tell which
  // version of a checkpoint the student actually met.
  const modId = moduleId();
  const modVer = (() => {
    try {
      const raw = fs.readFileSync(path.join(process.cwd(), "lesson", "index.json"), "utf-8");
      return String(JSON.parse(raw).version ?? "");
    } catch {
      return "";
    }
  })();
  const out = [
    "# Session summary",
    "",
    ...(modId ? [`Module: ${modId}${modVer ? ` v${modVer}` : ""}`] : []),
    `Checkpoints completed: ${allCheckpoints.filter((id) => done.has(id)).length} of ${allCheckpoints.length}`,
    ...(extras ? [`Extra practice rounds asked for: ${extras}`] : []),
    // Their own, and the tutor's own asides counted separately — the label
    // says "student's own questions", so a question the transcript cannot back
    // must not be counted under it.
    `Detours (student's own questions): ${
      entries.filter((e) => e?.type === "detour" && !e?.question_unsupported).length
    }`,
    ...(entries.some((e) => e?.type === "detour" && e?.question_unsupported)
      ? [
          `Side trips the tutor took: ${
            entries.filter((e) => e?.type === "detour" && e?.question_unsupported).length
          }`,
        ]
      : []),
    "",
  ];
  for (const e of cps) {
    out.push(
      `## ${e.id} — ${e.judgment ?? "?"} (${Number(e.hints_used ?? 0)} hint${Number(e.hints_used ?? 0) === 1 ? "" : "s"})`,
      `Question: ${String(e.question ?? "").trim()}`,
      `Answer (verbatim): ${String(e.student_response ?? "").trim()}`,
    );
    if (Array.isArray(e.student_said_verbatim) && e.student_said_verbatim.length) {
      out.push(`Typed by the student: ${JSON.stringify(e.student_said_verbatim)}`);
    }
    if (e.notes) out.push(`Tutor's note: ${String(e.notes).trim()}`);
    // Gaps the guards gave up on. Each of these is written on the row and, up
    // to now, read by nothing: a checkpoint closed without its figure, without
    // the page it was about, or by the referee looked exactly like one that
    // went to plan. The log was honest; every view derived from it was not.
    if (Array.isArray(e.build_missing) && e.build_missing.length) {
      out.push(
        `NOT BUILT: ${e.build_missing.join(", ")} — this checkpoint's figure is ` +
          `not in the notebook (the notebook was unreachable, or the tutor never ` +
          `ran the build). The answer below was given without it.`,
      );
    }
    if (e.photo_missing) {
      out.push(`NO PHOTO: closed without the pen-and-paper page this checkpoint asks for.`);
    }
    if (e.closed_by_referee) {
      out.push(`Closed by referee ruling: ${String(e.closed_by_referee)} (the student appealed).`);
    }
    if (e.id_snapped_from) {
      out.push(
        `(the tutor sent the id as "${String(e.id_snapped_from)}"; corrected to the script's)`,
      );
    }
    // The note quotes the transcript, so a grader never has to trust the
    // tutor's memory. What is worth a human eye is what the note left out.
    if (Array.isArray(e.figures_not_quoted) && e.figures_not_quoted.length) {
      out.push(
        `Numbers they typed that no slot quotes: ${e.figures_not_quoted.join(", ")} ` +
          `(may be a self-correction or an aside — worth a glance)`,
      );
    }
    out.push("");
  }
  // Appeals are logged (type "appeal") and were read by neither closing
  // artifact, so a session where the student had to go over the tutor's head
  // — the one signal that says the tutor was failing them — reached the
  // grader only if they opened the raw JSONL. Using the button is
  // participation, and the record should show it as such.
  const appeals = entries.filter((e: any) => e.type === "appeal");
  if (appeals.length) {
    out.push(`## Appeals to the referee (${appeals.length})`);
    out.push(
      `The student pressed the ⚖️ box. This counts as participation, never against ` +
        `them — but it is worth reading, because it is where they felt stuck.`,
    );
    for (const a of appeals) {
      out.push(
        `- Their case: ${String(a.student_case ?? "").trim()}`,
        `  Ruling: ${String(a.ruling ?? "?")} — ${String(a.reason ?? "").trim()}` +
          (a.referee
            ? ` [${String(a.referee)}]`
            : " [referee unreachable — the tutor resolved it]"),
      );
    }
    out.push("");
  }
  try {
    const stranded = fs
      .readdirSync(parkedDir())
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, "").replace(/^[^-]*--/, ""));
    if (stranded.length) {
      out.push(
        `## Notes that never reached the notebook`,
        `The notebook was unreachable when these were written and did not come back, so ` +
          `they are saved as markdown beside it in session_artifacts/parked_notes/: ` +
          `${stranded.join(", ")}. The answers themselves are below.`,
        "",
      );
    }
  } catch {
    // no parked notes is the normal case
  }
  if (missing.length) {
    // Name them ALL. Reporting only the first said "9 of 12" and then
    // pointed at one id, so two missing checkpoints appeared nowhere in the
    // artifact the grader reads. And a module whose last checkpoint IS
    // logged is not "where to pick up" — it is a record with holes, which
    // is what it should say.
    // Two different things, and they were being conflated: checkpoints
    // BEHIND the furthest one reached are holes an earlier session left —
    // the resume brief says never to go back for them — while the ones
    // AHEAD are simply where the module stopped. Naming the first hole as
    // "where to pick up" sent the next session back into it, and listing
    // the untaught remainder as holes described the whole rest of the
    // lesson as missing.
    const furthest = allCheckpoints.reduce(
      (acc: number, id: string, i: number) => (done.has(id) ? i : acc),
      -1,
    );
    const holes = missing.filter((id) => allCheckpoints.indexOf(id) < furthest);
    const ahead = missing.filter((id) => allCheckpoints.indexOf(id) > furthest);
    if (holes.length) {
      out.push(
        `## Not recorded`,
        `These checkpoints have no record — an earlier session ended before they were ` +
          `reached, and later ones carried on without them: ${holes.join(", ")}`,
        "",
      );
    }
    if (ahead.length) {
      out.push(`## Where to pick up`, `Next checkpoint: ${ahead[0]}`, "");
    }
  }
  return out.join("\n");
}

const JUDGMENTS = ["pass", "pass_with_hints", "guided", "prediction"];

const MARIMO_CELL_RULES =
  "Cell code rules (marimo is reactive): " +
  "(1) NEVER read a widget's .value in the cell that creates it — marimo forbids it. " +
  "Pattern: one cell makes and displays the widget (w = mo.ui.slider(…) then w as last line), " +
  "a SECOND cell uses w.value. " +
  "(2) Do NOT import mo/nx/np/plt/ig/sns/alt/pd — they already exist (redundant imports are " +
  "stripped); netviz(edges, highlight=[...]) is also predefined for themed D3 network drawings. " +
  "(3) Each public variable is owned by exactly ONE cell; prefix throwaway names with _ . " +
  "(4) The cell's LAST expression is what gets displayed; markdown via mo.md(r'''…'''). " +
  "(5) A matplotlib figure renders ONLY as the cell's last expression — NEVER interpolate a " +
  "figure into an mo.md f-string (it prints object gibberish, not an image). UI widgets may " +
  "be embedded in mo.md f-strings; figures may not. " +
  "(6) Text AND a figure in ONE cell: end with mo.vstack([mo.md(r'''…'''), <figure or " +
  "netviz(...)>]). NEVER draw a diagram as ASCII art inside markdown — a tiny netviz " +
  "(it even draws self-loops) or matplotlib figure always looks better.";

export default function (pi: ExtensionAPI) {
  // First statement in the factory, before anything that could throw: this is
  // what tells channel-update.ts that a newly checked-out tag imported at all.
  markChannel("loaded");
  piRef = pi;
  // The notebook server, the student's copy of the notebook, and the browser
  // page all come up here — nothing outside this package launches anything.
  // Not awaited: uv's first sandbox build can take a minute, and the student's
  // first turn is a hello. runKernel waits when waiting actually matters.
  //
  // The .catch is not decoration. There is no unhandledRejection handler in
  // pi, and its uncaughtException handler exits 1 — so a rejected promise
  // nobody is holding ends the student's session with a stack trace.
  void marimoUrl().catch(() => {});
  // Guards against a checkpoint's build landing in the wrong place: if the
  // tutor starts building checkpoint B before closing checkpoint A with
  // checkpoint_done, A's note cell gets created LATE and lands after B's
  // build cells instead of before them (seen in production — a "welcome"
  // note appeared after the next checkpoint's image). nb_add_template (and
  // nb_add_exercise, when tagged) check this before inserting.
  //
  // The open checkpoint is armed from the SCRIPT, not from the build: a
  // checkpoint with `build: none` (cp0_welcome, cp5_tension) never inserts a
  // cell, so arming on insert left exactly those unguarded — which is how
  // cp0's welcome note landed after cp1's image. Armed at session start and
  // advanced to the next scripted id by checkpoint_done.
  let pendingCheckpoint: string | null = null;
  // A slot-drift refusal fires at most once per checkpoint, so a model that
  // cannot satisfy it can never trap the student in a retry loop.
  const slotDriftWarned = new Map<string, number>();
  // Same idea for the souvenir contract: a text-only detour cell is bounced
  // once, then accepted, so a detour that genuinely has no picture in it can
  // still be recorded.
  // Keyed by the CELL, and counted. It was keyed by the question STRING, so
  // a retry that reworded the question was a fresh key: four bounces, four
  // rewordings, and the detour never reached the record at all.
  const detourTextOnlyWarned = new Map<string, number>();
  // Souvenirs whose question went into a cell of its OWN because the prepend
  // would not go in. Remembered, or the next call re-reads the souvenir, still
  // finds no quote in it, and puts a second copy in.
  const souvenirQuotedBeside = new Set<string>();
  // Improvised-cell review refusals, per cell name — capped like the rest.
  const cellReviewWarned = new Map<string, number>();
  // chapter_done's "was this chapter actually taught?" refusals, per chapter.
  const chapterGateWarned = new Map<string, number>();
  // Checkpoints whose pace question was never actually put to the student
  // (the picker could not run). The next build for them is bounced once.
  const paceUnasked = new Set<string>();
  // The build-ordering refusal, per checkpoint. It was the last uncapped
  // guard in the file: whenever the open checkpoint ended up wrong, every
  // build refused forever and the only escape it named wrote a duplicate row.
  const buildOrderWarned = new Map<string, number>();
  // The late-close refusal, per checkpoint. A close that arrives long after
  // the answer did takes the NEXT checkpoint's turns with it — the capture
  // only resets here — and the model's own hint count has stopped matching
  // what happened. See the guard in checkpoint_done.
  const lateCloseWarned = new Map<string, number>();
  // Checkpoints an EARLIER session left unlogged. Reported to the tutor at
  // resume and then treated as settled: the brief says not to go back for
  // them, so nothing downstream may order it to.
  const resumeGaps = new Set<string>();
  // How many turns the tutor has spent on the checkpoint it is working now.
  // Reset by checkpoint_done and chapter_done — see the ⚖️ nudge at turn_end.
  // A FACT for the row, and nothing else. It gates nothing — see the ⚖️ nudge
  // in turn_end for why counting turns was the wrong measure for "stuck".
  let turnsInCheckpoint = 0;
  // The ⚖️ nudge fires once per checkpoint. It used to be an `=== 12` on a
  // monotonically rising turn count, which is self-limiting; an answer count
  // can sit on the same number for several turns, so the once-ness has to be
  // stated rather than implied.
  let stuckNudged = false;
  // Upload widgets nb_view_image has actually looked at. Cell presence is
  // not evidence that the photo was ASKED for: cp5's script builds the drop
  // area up front, so the area exists from question 1 and a tutor that then
  // skips the "photograph that page" step closes a paper checkpoint with no
  // paper in it — which is exactly what a live run did.
  const viewedPhotos = new Set<string>();

  pi.on("tool_result", async (event: any) => {
    recordPickedAnswer(event);
  });

  // ── The student's "Send to my tutor" button ───────────────────────────
  // marimo runs in its own process, so a button in the page cannot call a
  // tool. The upload templates append the widget's name to
  // session_artifacts/student_signal.txt instead, and this watcher turns
  // each new line into a turn. Without it the student has to type "it's up"
  // in the terminal — one more thing to explain, and one more place for a
  // nervous beginner to sit waiting for permission.
  //
  // The message starts with "The student clicked", which INJECTED_PREFIX
  // filters: a button press is the student acting, but it is not their
  // words, and it must never be logged as something they said.
  const signalPath = () =>
    path.join(process.cwd(), "session_artifacts", "student_signal.txt");
  const readSignalLines = (): string[] => {
    try {
      return fs
        .readFileSync(signalPath(), "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  // Whatever is already in the file belongs to an earlier session.
  let signalMark = readSignalLines().length;
  const signalTimer = setInterval(() => {
    try {
      const lines = readSignalLines();
      if (lines.length < signalMark) signalMark = lines.length; // reset/archived
      if (lines.length <= signalMark) return;
      const widget = lines[lines.length - 1];
      signalMark = lines.length;
      if (!/^[A-Za-z_]\w*$/.test(widget)) return;
      // The ⚖️ "Tutor gets stuck" button appeals over the tutor's head:
      // the referee model rules, then the verdict message starts the turn.
      if (widget === "tutor_stuck") {
        void handleAppeal(pi);
        return;
      }
      // Two kinds of box send: a photo drop area, and an exercise code box
      // (whose widget name ends in _ed). They need opposite instructions —
      // one is read with the vision model, the other with nb_read — and a
      // tutor told to call nb_view_image on a code box burns a turn on an
      // error the student then watches it recover from.
      const isCode = /_ed$/.test(widget);
      pi.sendMessage(
        {
          customType: "student-signal",
          content: isCode
            ? `The student clicked "Send my code to my tutor" in the notebook: they have ` +
              `run their code and are handing it in. Read it with ` +
              `nb_read(["${widget}.value"]) now — do not ask them to paste it. Their ` +
              `output is already on screen under the box; react to what THEIR code and ` +
              `chart actually show, and ask the checkpoint's question about it. If the ` +
              `code does not run or does not do the task, say so warmly and point at the ` +
              `one line to change — they can edit and press ▶ Run again as often as they ` +
              `like, then send again.`
            : `The student clicked "Send to my tutor" in the notebook: their photo is ` +
              `uploaded and showing in the "${widget}" box. Call ` +
              `nb_view_image(widget="${widget}", …) now — do not ask them whether it is ` +
              `up. Judge what you see against the task, and say something specific about ` +
              `THEIR picture. If it does not show what the checkpoint asked for, say so ` +
              `warmly and ask them to redo it and drop the new photo into the same box; ` +
              `they can replace it as many times as they need.`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      // the button is a convenience — never let it break a turn
    }
  }, 2000);
  (signalTimer as any).unref?.();

  // Normal exit, /resume, /new: take the notebook server with us. A marimo
  // left behind holds port 2718 against the next session, and its kernel still
  // has the previous student's variables in it.
  pi.on("session_shutdown", async () => {
    stopMarimo();
  });

  // Rendered plainly, in the warning colour, because these are the two
  // messages in this whole toolkit written for the student to act on rather
  // than read: a tutor that cannot reach its model, and a notebook page they
  // have not found.
  for (const kind of STUDENT_FACING_MESSAGES) {
    pi.registerMessageRenderer(kind, (message: any, _opts: any, theme: any) => {
      const body = String(message.content ?? "")
        .split("\n")
        .map((l: string) => theme.fg("warning", l))
        .join("\n");
      return new Text(body, 0, 0);
    });
  }

  // ── Take a second marimo server out of the tutor's mouth ──────────────────
  // Asked where the notebook was, a live tutor told the student to run
  // `marimo edit notebook.py` in a new terminal — which starts a rival server
  // on another port, so the page they then watch is not the one being built
  // in. The rewrite happens at RENDER time, which is the whole difference
  // between this and NARRATES_A_BUILD (deleted in f8fe8f2): that one fired an
  // invisible note after the sentence was already on screen and "could not
  // unsay" it. This one unsays it. See rewriteRivalServer for why a command
  // and a port number are a fair thing to match when a mood is not.
  //
  // Belt and braces, and the braces are the belt: even if this transformer is
  // missing from an older pi, the address is printed at session start and
  // nb_notebook_url answers the question directly.
  let rivalNotes = 0;
  try {
    pi.registerMarkdownTransformer?.((markdown: string, mctx: any) => {
      if (mctx?.messageType !== "assistant") return markdown;
      const env = process.env.MARIMO_URL ?? "";
      if (!/^https?:\/\/\S+$/.test(env)) return markdown;
      const r = rewriteRivalServer(markdown, `${marimoBase()}/?view-as=present`);
      if (!r.hits.length) return markdown;
      // Once the message has stopped moving, and twice per session at most.
      if (!mctx?.isStreaming && rivalNotes < 2) {
        rivalNotes += 1;
        try {
          pi.sendMessage(
            {
              customType: "rival-server",
              content:
                `NOTE (invisible to the student): you just pointed them at ${r.hits[0]}. ` +
                `The notebook server is already running and this toolkit owns it — a second ` +
                `one is a second kernel on the same file, and the page they would be watching ` +
                `is not the one you build in. What they read was corrected on screen. Use ` +
                `nb_notebook_url for the address, and never ask them to start the notebook.`,
              display: false,
            },
            { deliverAs: "nextTurn" },
          );
        } catch {
          /* the rewrite already did the work */
        }
      }
      return r.text;
    });
  } catch {
    /* an older pi without markdown transformers: the banner still prints */
  }

  pi.on("session_start", async (_event, _ctx) => {
    lastCtx = _ctx ?? lastCtx;
    // ── Where the notebook is ────────────────────────────────────────────
    // HERE, and not inside marimoUrl's own then-block, on purpose: an
    // externally supplied server (the review harness pins one, and an
    // instructor may run marimo by hand) returns from marimoUrl before that
    // block is ever reached. Announcing there would have left the Part D gate
    // unable to see this at all — which is how a fault of exactly this shape
    // survives a green gate.
    //
    // ── Everything at module scope outlives the session ──────────────────
    // pi's `/new` and `/resume` are in-process: the runtime is rebuilt, but
    // the extension module is not re-evaluated (the loader returns the cached
    // factory), so every `let` up there still holds the last session's value
    // while the new session's branch starts empty.
    //
    // `studentSaidMark` is the one that damages a record: it is an INDEX, the
    // new branch is shorter than the old mark, and `all.slice(mark)` is then
    // `[]` — so the first checkpoint of the second session logs
    // `student_said_verbatim: []` and the note has nothing of theirs in it.
    // The others are cheaper but wrong in the same way: a stale pick riding
    // into the new session's first row, a detour span pointing at a window
    // that no longer exists, a banner that never prints again.
    //
    // Compaction is NOT this. It only ever appends, and getBranch() walks
    // parentId, so the branch never gets shorter under it.
    studentSaidMark = 0;
    closedAtEntryId = null;
    pickedAnswers.length = 0;
    pickedMark = 0;
    detourSpans.length = 0;
    detourAsked.clear();
    mechanicsAsked.clear();
    announcedNotebook = false;
    void marimoUrl()
      .then((r) => {
        if (r.url) announceNotebook(r.url, true);
      })
      .catch(() => {});
    // The tutor talks; it does not run commands. Every notebook and log
    // operation goes through the quiet nb_* tools, so a raw shell would only
    // ever scroll past the student mid-lesson.
    //
    // Here and not in the factory. pi binds the tool-management methods to
    // stubs that THROW for the whole of extension loading
    // (dist/core/extensions/loader.js:133-152, "Action methods cannot be
    // called during extension loading"), so the same block in the factory
    // threw into its own catch every single time and the tutor kept bash on
    // every student's machine. It read as working because the E2E harness
    // passes --exclude-tools bash on the command line, which hid it under
    // test — the one place it was never actually exercised.
    try {
      const active: string[] = pi.getActiveTools?.() ?? [];
      if (active.includes("bash")) pi.setActiveTools?.(active.filter((n) => n !== "bash"));
    } catch {
      /* an older pi without tool management: AGENTS.md still forbids it */
    }
    // Before anything else: is the tutor's own model reachable? A broken key
    // or a stale endpoint is otherwise discovered as an unexplained
    // "Connection error." on the student's first hello.
    void preflightProvider(_ctx)
      .then((problem) => {
        if (!problem) return;
        try {
          // No ui.notify beside this: pi renders a notification as another
          // "Error:" row, and the student is already looking at one they cannot
          // read. One block, in plain words, last on the screen.
          piRef?.sendMessage(
            {
              customType: "setup-help",
              content: `⚠  Your tutor cannot reach the course server.\n\n${problem}`,
              display: true,
            },
            { deliverAs: "followUp" },
          );
        } catch {
          /* best effort — the student still gets pi's own error */
        }
      })
      .catch(() => {});
    // ── Chapter start + resume brief ──────────────────────────────────────
    // Determine the current chapter (from progress or saved state), inject
    // its script, and — when previous progress exists — a resume brief that
    // asks the student continue-or-fresh.
    try {
      const chapters = loadChapters();
      if (chapters.length > 0) {
        const entries = readSessionLog();
        const cps = entries.filter((e: any) => e.type === "checkpoint" && e.id);
        // An empty log means the module has NOT started, whatever
        // chapter_state.json says — that file outlives the log it belongs
        // to. A fresh start archives the log; if the saved chapter were
        // still trusted after that, the "clean slate" session would open in
        // the middle of the module, on top of whatever cells the wipe left
        // behind. Seen exactly that way: no log, chapter_state "ch3", and a
        // notebook whose first cell was chapter 3's heading.
        let chapter =
          cps.length > 0
            ? (chapters.find((c) => c.id === currentChapterId()) ?? chapters[0])
            : chapters[0];
        pendingCheckpoint = chapter.checkpoints[0] ?? null;
        let moduleFinished = false;
        if (cps.length > 0) {
          const order = chapters.flatMap((c) => c.checkpoints);
          // Scan BACKWARDS for the last id the script actually knows. The
          // newest entry can be off-script — a stretch (cs1_code), a typo —
          // and indexOf(-1)+1 would silently resolve to cp0_welcome, walking
          // a student who finished four chapters back to the welcome.
          // The FURTHEST scripted checkpoint reached, not the newest row.
          // A practice round logged out of order (a `cp2_distance_extra`
          // after chapter 3) rewound the whole session and armed the build
          // guard back at chapter 2, while the closing summary still read
          // the position correctly — the two disagreed on the same log.
          const lastScripted = cps
            .map((e: any) => baseCheckpointId(String(e.id ?? "")))
            .filter((id: string) => order.includes(id))
            .reduce(
              (acc: string | undefined, id: string) =>
                acc === undefined || order.indexOf(id) > order.indexOf(acc) ? id : acc,
              undefined as string | undefined,
            );
          // Positional, matching nextCheckpointId — see the note there for
          // why resuming INTO a gap is not supported. No next id means the
          // module is done; do NOT fall back to the last checkpoint, which
          // tells the tutor to re-run cp8, whose re-close skips the existing
          // session_record while overwriting session_summary.md.
          const nextId = lastScripted ? order[order.indexOf(lastScripted) + 1] : order[0];
          const finished = !nextId;
          // A gap is reported, not repaired: the brief says so in one line so
          // the tutor does not silently carry on as if the module were whole,
          // and the closing summary lists the missing ids either way.
          const doneIds = new Set(cps.map((e: any) => baseCheckpointId(String(e.id))));
          const gaps = order.filter(
            (o: string) => !doneIds.has(o) && (!nextId || order.indexOf(o) < order.indexOf(nextId)),
          );
          resumeGaps.clear();
          for (const g of gaps) resumeGaps.add(g);
          moduleFinished = finished;
          chapter = (nextId && chapters.find((c) => c.checkpoints.includes(nextId))) || chapter;
          pendingCheckpoint = nextId ?? null;
          // The continue-or-fresh answer below is session mechanics, not a
          // lesson answer, and nothing drains the pick buffer until the next
          // checkpoint_done — so without this it rode into that checkpoint's
          // record and printed as *You chose: "Continue where we left off"*
          // under a lecture question in the submitted notebook.
          awaitingResumeChoice = true;
          pi.sendMessage(
            {
              customType: "resume-brief",
              content:
                `RESUME CONTEXT (invisible to the student — never mention this message): ` +
                `a previous session exists. Progress so far:\n${progressBrief(entries)}\n` +
                (gaps.length
                  ? `Note for you, not for them: ${gaps.join(", ")} ${gaps.length > 1 ? "have" : "has"} ` +
                    `no record — an earlier session ended between them. Do NOT go back for ` +
                    `${gaps.length > 1 ? "them" : "it"}; carry on from where the module is now, and the ` +
                    `closing summary will show ${gaps.length > 1 ? "them" : "it"} as missing.\n`
                  : "") +
                `FIRST, greet the student and ask with ask_user_question, using EXACTLY these ` +
                `two option labels: "Continue where we left off" and "Start fresh" — the ` +
                `extension recognises those words and keeps this housekeeping answer out of ` +
                `the graded record, so do not reword them. If they choose fresh: call ` +
                `nb_fresh_start and follow its instructions (chapter 1 reloads ` +
                `automatically — do not improvise). ` +
                (finished
                  ? (fs.existsSync(path.join(process.cwd(), "session_artifacts", "session_summary.md"))
                      ? `If they continue: they already FINISHED this module — do not re-run any ` +
                        `checkpoint and do not call chapter_done. Say so warmly, offer to answer ` +
                        `questions or replay any experiment in the notebook, and log anything you ` +
                        `answer with log_detour.`
                      // Every checkpoint is logged but the closing record was never
                      // written — the last session ended between the final answer and
                      // chapter_done. Seen live: the tutor said a warm goodbye and the
                      // student's notebook shipped with no session_record and no
                      // summary, the two things the grader opens first.
                      : `If they continue: every checkpoint is logged but this module was ` +
                        `never CLOSED — there is no session_record cell and no summary. Do ` +
                        `not re-run any checkpoint. Say one warm line that you are just ` +
                        `filing their work, call chapter_done to write the closing record, ` +
                        `and then say goodbye.`)
                  : `If they continue: do NOT rebuild existing notebook cells ` +
                    `(nb_add_template skips duplicates automatically), remind them in one ` +
                    `sentence where you two left off, and continue at checkpoint ${nextId} ` +
                    `(chapter "${chapter.title}").`),
              display: false,
            },
            { deliverAs: "nextTurn" },
          );
        }
        writeChapterState(chapter.id);
        const num = chapters.findIndex((c) => c.id === chapter.id) + 1;
        // A finished module gets NO chapter script: it ends "work its
        // checkpoints in order... then call chapter_done", which is the exact
        // opposite of the resume brief above, and re-running cp8 appends a
        // duplicate log row against a note cell that skips as already there.
        if (!moduleFinished) {
          pi.sendMessage(
            {
              customType: "chapter-script",
              content: chapterScriptMessage(chapter, num, chapters.length),
              display: false,
            },
            { deliverAs: "nextTurn" },
          );
        }
        // Delayed and retried: the kernel is still booting at session start,
        // and stays cold until a browser client connects. Each attempt
        // re-checks that this chapter is still current — if the student
        // chose "start fresh" (or a chapter transition otherwise happened),
        // inserting its header would land a stray "Chapter N" heading in
        // the middle of a different chapter's cells (seen in production).
        scheduleChapterHeader(chapter, num, chapters.length);
      }
      // Last statement inside the try: session_start got all the way through
      // — the log was read, the chapter resolved, the script handed over —
      // without throwing. That is the definition of "this tag came up" the
      // channel rolls back on, so it must not move above the work. A marker
      // written before the lesson exists would certify a broken release fifty
      // times over.
      markChannel("healthy");
    } catch {
      // chapter injection is best-effort; AGENTS.md tells the tutor how to cope
    }
  });

  // Chapter dividers render as a single accent line in the transcript.
  pi.registerMessageRenderer("chapter-divider", (message: any, _opts: any, theme: any) => {
    return new Text(theme.fg("accent", String(message.content ?? "")), 0, 0);
  });

  // Custom compaction at chapter boundaries: the handoff brief IS the summary
  // (deterministic, no extra LLM call).
  let pendingHandoffBrief: string | null = null;
  // When it was armed. The brief belongs to ONE compaction — the one
  // chapter_done starts — and every other path that arms it also clears it on
  // failure, except the 20-second fallback timer, which did not. A brief left
  // behind there is consumed by the next compaction instead, which may be the
  // automatic one forty minutes later: the tutor is then handed a summary
  // saying it has just started chapter 2, in the middle of chapter 3, and the
  // real conversation is gone. Stale after two minutes, which is far longer
  // than the handoff takes and far shorter than the session.
  let handoffArmedAt = 0;
  const HANDOFF_TTL_MS = 120_000;
  // Armed by chapter_done, fired at message_end — see the comment there.
  let pendingCompaction: (() => void | Promise<void>) | null = null;
  const runPendingCompaction = () => {
    const go = pendingCompaction;
    pendingCompaction = null;
    if (go) void Promise.resolve(go()).catch(() => {});
  };
  pi.on("session_before_compact", async (event: any) => {
    if (!pendingHandoffBrief) return;
    if (Date.now() - handoffArmedAt > HANDOFF_TTL_MS) {
      pendingHandoffBrief = null;
      return; // let pi summarise this one itself
    }
    const summary = pendingHandoffBrief;
    pendingHandoffBrief = null;
    // ── Where the cut lands, and why it is not pi's ──────────────────────
    // This used to hand `event.preparation.firstKeptEntryId` straight back —
    // pi's own cut point, which findCutPoint walks backwards to keep the most
    // recent `keepRecentTokens` of conversation. That is the right rule for a
    // compaction that happens because the context got big. It is the wrong
    // rule for this one, which happens because a CHAPTER ENDED, and whose
    // summary is a complete handoff brief for everything before it.
    //
    // A chapter's conversation is nowhere near the budget — measured at 5,571
    // tokens against a keepRecentTokens of 3,000-20,000 — so pi's cut point
    // lands at or before the OUTGOING chapter's own script, and the compaction
    // removes essentially nothing. Measured across 92 real handoffs on one
    // machine: 40 kept the finished chapter's script alive, 39 then held TWO
    // chapter scripts in context at once, and 23 of them came out of the
    // "compaction" BIGGER than they went in. The design note above this
    // handler — "same session, same visible transcript, fresh LLM context" —
    // was false at every one of them, and the tutor began chapter 2 still
    // reading chapter 1's script, whose closing line tells it to call
    // chapter_done. chapter_done's own guard records what that produced: two
    // transitions back to back, and a student who went from chapter 1 straight
    // into chapter 3's pen-and-paper task.
    //
    // pi stores whatever id the hook returns, unvalidated (session-manager
    // appendCompaction), and buildContextEntries keeps from it — so the hook
    // is allowed to name its own boundary, and this one should: the last entry
    // on the branch, which is the chapter_done turn. Everything before it is
    // what the brief already says. An id pi cannot find degrades to "keep only
    // what came after the compaction", which is the same intent.
    return {
      compaction: {
        summary,
        firstKeptEntryId: handoffCutPoint(event?.branchEntries, event.preparation.firstKeptEntryId),
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  // ── chapter_done ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "chapter_done",
    label: "Chapter done",
    description:
      "Call when the current chapter's FINAL checkpoint has been logged. Pass short handoff " +
      "notes for the next part of the lesson (student's style, anchors worth reusing like " +
      "'their cable was the long one', anything to watch). The next chapter script loads " +
      "automatically — after calling, say ONE short bridge sentence and wait.",
    promptSnippet: "Finish the current chapter and load the next (with handoff notes)",
    parameters: Type.Object({
      status: STATUS_PARAM,
      handoff: Type.String({
        description: "2-4 sentences: student profile updates, anchors, watch-outs.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: any) {
      lastCtx = ctx ?? lastCtx;
      const chapters = loadChapters();
      const curId = currentChapterId() ?? chapters[0]?.id;
      const idx = chapters.findIndex((c) => c.id === curId);
      const next = chapters[idx + 1];

      // ── The chapter must actually have been taught ──────────────────────
      // A chapter transition compacts the conversation, and a model that
      // comes out of compaction disoriented can call chapter_done a second
      // time. That happened in a live session: two transitions fired back to
      // back and the student went from chapter 1 straight into chapter 3's
      // pen-and-paper task, having never met distance or clustering. The
      // student picker below cannot catch it — they were asked "anything
      // first?" about a chapter that had not happened.
      const cur = chapters[idx];
      if (cur) {
        const loggedIds = new Set(
          readSessionLog()
            .filter((e: any) => e?.type === "checkpoint" && e.id)
            .map((e: any) => baseCheckpointId(String(e.id))),
        );
        // Checkpoints an earlier session already skipped are NOT this
        // chapter's unfinished business: the resume brief told the tutor not
        // to go back for them, and this gate was then ordering it straight
        // back. Same rule both places — a gap is reported, not repaired.
        const missing = cur.checkpoints.filter(
          (c) => !loggedIds.has(c) && !resumeGaps.has(c),
        );
        // Capped like every other guard. Without a cap, a log that cannot be
        // written makes this fire forever — readSessionLog() returns [], so
        // every checkpoint reads as missing — while checkpoint_done is
        // telling the tutor "LOG WRITE FAILED — keep teaching". The student
        // could never leave chapter 1.
        const gateStrikes = chapterGateWarned.get(cur.id) ?? 0;
        // A referee ruling that ends the chapter walks through this gate;
        // the summary still reports the unlogged checkpoints as gaps.
        const chapterWaived = refereeWaiverActive();
        if (missing.length > 0 && chapterWaived) refereeWaiver = null;
        if (missing.length > 0 && gateStrikes < 2 && !chapterWaived) {
          chapterGateWarned.set(cur.id, gateStrikes + 1);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `NOT ADVANCED — "${cur.title}" is not finished. These checkpoints have ` +
                  `never been logged: ${missing.join(", ")}. Say nothing about this to the ` +
                  `student; just carry on with "${missing[0]}" from your CHAPTER SCRIPT, ` +
                  `ending it with checkpoint_done, and call chapter_done again once the ` +
                  `chapter's last checkpoint is logged.`,
              },
            ],
            details: { gated: true },
          };
        }
      }

      // ── Forced chapter-end follow-up ────────────────────────────────────
      // Enforced here, not by prompt: a chapter boundary is the one moment
      // the student must get an unhurried "anything first?" — the tutor was
      // racing past questions and requests for extra practice.
      const READY = next ? "I'm ready for the next chapter" : "I'm ready to wrap up";
      const ASK_Q = "I have a question first";
      const MORE = "Give me one more practice problem";
      if (ctx?.ui?.select) {
        const title = chapters[idx]?.title ?? "this part";
        const { choice, typed } = await askStudent(
          ctx,
          `Before we leave "${title}" — anything first?`,
          [READY, ASK_Q, MORE],
        );
        if (choice !== READY) {
          const text =
            choice === ASK_Q
              ? `The student has a QUESTION. Do NOT advance. Ask them in plain text what it ` +
                `is, answer it properly, leave a souvenir cell (mo.vstack: note + netviz/figure ` +
                `— never ASCII art), log the detour, then call chapter_done again.`
              : choice === MORE
                ? // Named objects belong to whichever module wrote them, and this
                  // string is read by every module that installs the toolkit: it
                  // used to send the Königsberg tutor off to improvise on "the
                  // 4-person network, the 8-dot ring", which are the small-world
                  // module's and exist nowhere in this one. The scripts already
                  // carry the right data for exactly this, per checkpoint.
                  `The student wants MORE PRACTICE. Do NOT advance. Improvise ONE problem of ` +
                  `the same kind on NEW data — the fresh_variants of the checkpoint you just ` +
                  `finished, or the same recipe on this module's own objects. Guide, judge, log ` +
                  `it as extra practice (never a fail), then call chapter_done again.`
                : choice === TYPE_IT && typed
                  ? `Do NOT advance. The student typed this instead of picking a row — these ` +
                    `are THEIR words, react to them: "${typed}". Answer whatever it asks (a ` +
                    `question gets a proper answer, a souvenir cell and log_detour), then ask ` +
                    `in plain text whether they are ready, and call chapter_done again once ` +
                    `they say so.`
                  : `The student closed the picker without choosing — they may want to say ` +
                    `something in their own words. Ask them in plain text what they'd like to do, ` +
                    `handle it, then call chapter_done again.`;
          return { content: [{ type: "text" as const, text }], details: { gated: true } };
        }
      } else if ((chapterGateWarned.get(`${chapters[idx]?.id}:pace`) ?? 0) < 1) {
        // No picker — a dead notebook, a headless restart. DESIGN.md says
        // chapter_done "refuses to transition" without the student's word,
        // and with no else branch it simply transitioned. checkpoint_done's
        // gate was fixed the same way; this is its twin.
        //
        // ONE refusal, because the picker will still be missing on the
        // retry: the point is to make the tutor ask, not to trap it in a
        // loop it can never satisfy.
        chapterGateWarned.set(`${chapters[idx]?.id}:pace`, 1);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `NOT ADVANCED — the picker could not run, so the student has not been asked ` +
                `whether they want anything before leaving "${chapters[idx]?.title ?? "this part"}". ` +
                `Ask them in plain text — ready to move on, a question first, or one more ` +
                `practice problem — END YOUR TURN, and wait. Call chapter_done again once ` +
                `they answer; handle a question or a practice round first if that is what ` +
                `they choose.`,
            },
          ],
          details: { gated: true },
        };
      }

      if (!next) {
        // The closing artifacts are DERIVED from the log — never retyped from
        // the model's memory of the session (that is the graded record).
        const entries = readSessionLog();
        const allCps = chapters.flatMap((c) => c.checkpoints);
        let done = "";
        // Last chance for any note the notebook was down for — chapter 5 has
        // no builds at all, so without this a note parked at cp7 or cp8 would
        // never reach the page it belongs on.
        await flushParkedNotes(_signal);
        const rec = await insertMarkdownCell("session_record", buildSessionRecord(entries), _signal);
        done += rec.failed ? "session_record cell FAILED. " : "Closing record added to their notebook. ";
        try {
          fs.writeFileSync(
            path.join(process.cwd(), "session_artifacts", "session_summary.md"),
            buildSessionSummary(entries, allCps),
          );
          done += "Summary written. ";
        } catch {
          done += "Summary write failed. ";
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                `That was the FINAL chapter. ${done}\n` +
                // The last thing a finished session must do is hand itself in.
                // This used to end at "say goodbye" and nothing anywhere told
                // the student to submit — a whole module could be finished,
                // closed and left sitting in a folder, ungraded.
                `NOW CALL nb_submit — that hands their work in, and it is the last thing ` +
                `this session owes them. Then say goodbye: tell them plainly what they ` +
                `can now do, that their answers (not code) are what gets reviewed, that ` +
                `their work is handed in, and that the notebook is theirs to keep and ` +
                `keep playing with.`,
            },
          ],
          details: {},
        };
      }
      // -1, not 0, for the reason spelled out at checkpoint_done's own reset:
      // turn_end has not run for this turn yet, and it belongs to the chapter
      // that just ended.
      turnsInCheckpoint = -1;
      writeChapterState(next.id);
      // Re-arm the build-ordering guard on the new chapter's first
      // checkpoint, so it keeps working across the transition instead of
      // still pointing at the chapter that just ended.
      pendingCheckpoint = next.checkpoints[0] ?? pendingCheckpoint;
      const brief =
        `=== TUTORING HANDOFF (chapter transition, invisible to the student) ===\n` +
        `You are the SAME tutor, mid-session. Conversation so far, summarized:\n` +
        `Progress:\n${progressBrief(readSessionLog())}\n` +
        `Tutor's notes: ${params.handoff}\n` +
        `Anything above about a camera, a phone or a photo belongs to the checkpoint it ` +
        `happened at — it is NOT a standing fact about this student. Every paper ` +
        `checkpoint in this chapter asks for the photo, in one line, and waits.\n` +
        `The notebook already contains every cell built so far — never rebuild them. ` +
        `Continue warmly with the same voice; your new CHAPTER SCRIPT message has the curriculum.`;
      pendingHandoffBrief = brief;
      handoffArmedAt = Date.now();
      // The next chapter must load AFTER compaction: injecting before it
      // races the session reload (the fresh turn gets aborted and nothing
      // restarts — seen in production) and the script could be summarized
      // away. loadOnce also serves as the fallback when compaction errors
      // (e.g. nothing to compact) or never calls back.
      const num = idx + 2;
      let loaded = false;
      const loadOnce = () => {
        if (loaded) return;
        loaded = true;
        // Any note the notebook was down for goes in BEFORE the next
        // chapter's heading. A live run killed marimo during cp1_routing;
        // its note was parked, the chapter turned over, and the recovered
        // note landed under "── Chapter 2 ──" — a chapter-1 answer filed
        // inside chapter 2, in the keepsake the student submits. Every
        // other insertion point already flushes first; this was the one
        // that did not.
        void flushParkedNotes().then(() => insertChapterHeader(next, num, chapters.length));
        pi.sendMessage(
          {
            customType: "chapter-divider",
            content: `── Chapter ${num} · ${next.title} ──`,
            display: true,
          },
          { deliverAs: "followUp" },
        );
        pi.sendMessage(
          {
            customType: "chapter-script",
            content: chapterScriptMessage(next, num, chapters.length),
            display: false,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      };
      // Compaction aborts whatever model request is in flight — and the one
      // in flight right now is the tutor saying the bridge sentence this very
      // tool result asks for. Started here, it printed a red
      // "Error: This operation was aborted" into the student's terminal at
      // every chapter turn, four times a session, with nothing actually
      // wrong. So it is armed here and fired at message_end, once the tutor
      // has finished speaking.
      const armCompaction = async () => {
        // Wait for pi to actually settle. turn_end fires while the run is
        // still winding down, and compacting then aborts it — which the
        // student reads as "Error: This operation was aborted", in red, at
        // every chapter boundary. isIdle() is the difference between "the
        // tutor has stopped talking" and "there is nothing left to abort".
        //
        // Ten seconds is a bound, not a decision. When it runs out the old
        // code compacted ANYWAY — into a run that was, by its own test, still
        // going — which is the abort this poll exists to avoid, just later and
        // rarer. `turn_end` fires per assistant message, so the first one to
        // arrive is the chapter_done tool turn itself, before the bridge
        // sentence the tool result asks for; the poll is what usually covers
        // that gap. Re-arm instead: the next turn_end tries again, and the 30s
        // floor below is the backstop for a tutor that never speaks again.
        for (let i = 0; i < 40 && ctx?.isIdle && !ctx.isIdle(); i++) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (ctx?.isIdle && !ctx.isIdle()) {
          pendingCompaction = armCompaction;
          return;
        }
        try {
          ctx?.compact?.({
            customInstructions: "chapter handoff",
            onComplete: loadOnce,
            onError: () => {
              pendingHandoffBrief = null;
              loadOnce();
            },
          });
          const timer = setTimeout(loadOnce, 20_000);
          (timer as any).unref?.();
        } catch {
          pendingHandoffBrief = null;
          loadOnce();
        }
      };
      pendingCompaction = armCompaction;
      // A floor under it: a tutor that says nothing at all may never produce
      // a message_end, and a chapter that never loads strands the student.
      const armed = setTimeout(runPendingCompaction, 30_000);
      (armed as any).unref?.();
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Handoff recorded. Say ONE short, warm bridge sentence to the student ` +
              `(no new questions) and END YOUR TURN — chapter "${next.title}" loads automatically.`,
          },
        ],
        details: {},
      };
    },
    ...quiet("Getting our next chapter ready…"),
  });

  // ── Runaway guard ─────────────────────────────────────────────────────────
  // Silent safety net only (style is steered by AGENTS.md, not enforced):
  // flash-class models can fall into degenerate repetition loops. Abort the
  // generation if a single message runs absurdly long, and nudge a restart.
  const RUNAWAY_CHARS = 1600;

  // The ceiling alone does not catch the shape this actually takes. A student
  // sent in a screenshot of the tutor asking "how many bridges land on it?" and
  // then answering itself: "user5, so it must revisit at least once." followed
  // by the same sentence three times over, then a tool call — around 900
  // characters, well under the ceiling, with the student never getting the
  // keyboard back. Two cheaper tells fire first now, and both fire within a
  // sentence or two rather than after a page.

  // A leaked turn header. Chat templates write the next speaker as a bare
  // lowercase "user"/"assistant"/"system", and a model that runs past its own
  // end-of-turn emits it verbatim, glued to the reply it then writes for the
  // student — which is where the "user5" above comes from.
  //
  // \b would not catch "user5": both sides are word characters, so there is no
  // boundary between them. Hence the negative lookahead — which also keeps
  // "users" out. The second lookahead requires a character to FOLLOW the match:
  // mid-stream the buffer ends wherever the chunk ended, and "…\nuser" with
  // nothing after it is as likely to become "users of the bridge" as a header.
  // Lowercase only, deliberately: a sentence opening with "User" is prose, and
  // capitalisation is the one thing the template form never has.
  const TURN_HEADER = /(?:^|\n)(?:user|assistant|system)(?![a-z])(?=[\s\S])/;
  const SPECIAL_TOKEN = /<\|(?:im_start|im_end|start_header_id|end_header_id|eot_id)\|>/;

  /** The same sentence three times over is a loop, not an explanation. */
  const repeatedLine = (t: string): boolean => {
    const seen = new Map<string, number>();
    for (const raw of t.split("\n")) {
      const l = raw.trim();
      // Short lines repeat honestly — "Right." and "Yes, exactly." are how the
      // tutor is supposed to sound — and a table row or a quoted line repeats
      // by construction. Neither is a loop.
      if (l.length < 15 || !/[A-Za-z]/.test(l) || /^[|>]/.test(l)) continue;
      const n = (seen.get(l) ?? 0) + 1;
      if (n >= 3) return true;
      seen.set(l, n);
    }
    return false;
  };

  // Every one of these must start with a phrase INJECTED_PREFIX knows, or the
  // note is filed as the student's own words and quoted back at them.
  const RUNAWAY_NOTE: Record<string, string> = {
    length:
      "NOTE (invisible to the student): your message ran away and was cut off. " +
      "Continue with one short message.",
    loop:
      "NOTE (invisible to the student): you began repeating the same sentence and " +
      "were cut off. Say ONE short line and end your turn.",
    header:
      "NOTE (invisible to the student): you started writing the student's reply for " +
      "them and were cut off. Stop at your own question — say ONE short line, end " +
      "your turn, and wait for what they actually type.",
  };

  let runawayFired = false;
  pi.on("message_update", async (event: any, ctx: any) => {
    const msg = event?.message;
    if (msg?.role !== "assistant" || runawayFired) return;
    const raw = msg.content;
    // Text parts only. A reasoning trace says "user wants…" as a matter of
    // course, and it is not the tutor speaking to anyone.
    const t =
      typeof raw === "string"
        ? raw
        : (Array.isArray(raw) ? raw : [])
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text ?? "")
            .join("\n");
    const reason =
      TURN_HEADER.test(t) || SPECIAL_TOKEN.test(t)
        ? "header"
        : repeatedLine(t)
          ? "loop"
          : t.length > RUNAWAY_CHARS
            ? "length"
            : null;
    if (!reason) return;
    runawayFired = true;
    try {
      ctx.abort();
    } catch {
      // best-effort
    }
    pi.sendMessage(
      {
        customType: "runaway-guard",
        content: RUNAWAY_NOTE[reason],
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
  // The runaway guard's only re-arm. It used to sit at the top of the
  // narration nudge's own message_end handler, so deleting that block would
  // have taken this line with it and left the guard dead for the rest of the
  // session after its first fire. It gets its own handler now.
  pi.on("message_end", async () => {
    runawayFired = false;
  });

  // ── The breath before a drawing, and why it is not here any more ─────────
  // "Let me put both shapes up so we can see them side by side." "I'll draw a
  // new one." Every one of those went out immediately before a cell landed,
  // in sessions run under an AGENTS.md whose longest passage is the ban on
  // exactly this.
  //
  // This file answered that with a regex over "let me|I'll" + "put|draw|add
  // |show", fired once per session as an invisible note. It was never a
  // refusal and it could not unsay the sentence — by the time a message ends
  // it is on their screen — so at best it stopped the second one. What it
  // actually was is a bet on one model's phrasing, which is the shape of fix
  // that has failed here every single time: five review rounds, and every
  // fault answered with a prohibition came back somewhere new, while every
  // fault answered with literal words in the chapter script stayed fixed.
  //
  // So the words are in the scripts now, at every site that inserts a cell in
  // both modules: the step names the insert, quotes what to say next, and
  // says in as many words that nothing goes in front of it. m01 had none of
  // those sentences and now has twelve; m02 has six. That is where this lives.
  //
  // `empty-turn` in turn_end stays, and the contrast is the point: it tests
  // `stopReason` and an empty content array. It infers nothing about what the
  // tutor meant to say.
  // Fixed-choice questions go through the ask_user_question tool
  // (@juicesharp/rpiv-ask-user-question package, declared in .pi/settings.json).

  // ── checkpoint_done ───────────────────────────────────────────────────────
  // One call replaces the whole per-checkpoint ceremony: the extension writes
  // the graded log (with the student's own messages captured from the
  // transcript), renders the note cell from the chapter script's `note:`
  // skeleton, and runs the transition ask itself. The tutor supplies only
  // what a model can: the verbatim answer and the judgment.
  pi.registerTool({
    name: "checkpoint_done",
    label: "Checkpoint done",
    description:
      "Finish a checkpoint: this ONE call logs it (graded artifact), adds the notebook note " +
      "cell from the chapter script's note: skeleton, and asks the student whether to move " +
      "on. Call it right after you judge their answer — never hand-write log JSON, never " +
      "hand-write the note cell. The result tells you what the student chose: only 'ready' " +
      "means you may start the next checkpoint.",
    promptSnippet: "Log a checkpoint, add its note cell, and ask the student what's next",
    promptGuidelines: [
      "End EVERY checkpoint with checkpoint_done — it replaces hand-written log JSON, the note cell, and the transition question.",
    ],
    parameters: Type.Object({
      status: STATUS_PARAM,
      id: Type.String({ description: "Checkpoint id from the script, e.g. 'cp2_distance'." }),
      // "As you asked it", not "as the script wrote it". A student who
      // answers a later question early is answering one you never put, and a
      // row that lists both reads back as a tutor firing two questions in one
      // breath — which is what a reviewer concluded from exactly this row,
      // from the log alone, with the transcript already gone.
      question: Type.String({
        description:
          "The question as you actually asked it — not the script's wording, and " +
          "not a question you skipped because they answered it early. Say in notes " +
          "when they volunteered the rest.",
      }),
      student_response: Type.String({
        description: "Their answer VERBATIM — their words, not your summary.",
      }),
      judgment: Type.String({
        description: "One of: pass | pass_with_hints | guided | prediction.",
      }),
      // Optional, and accepted as a string too: execute already does
      // `Number(params.hints_used ?? 0) || 0`, so a missing or "2"-shaped
      // value costs nothing — while requiring a number meant a model that
      // sent "2" lost the entire close, including the student's verbatim
      // answer, to a schema rejection it never sees the text of.
      hints_used: Type.Optional(
        Type.Union([Type.Number(), Type.String()], {
          description:
            "How many hints you gave. A hint is any question you asked BECAUSE " +
            "their answer was not there yet — one counts, even if they got it on " +
            "the next turn. 0 only if they answered every part first time.",
        }),
      ),
      notes: Type.String({ description: "One line: what their answer showed." }),
      note_markdown: Type.Optional(
        Type.String({
          description:
            "Only when the script has no note: skeleton — the full note cell markdown " +
            "(plain-words title, 2-4 sentences with $math$, then their quoted answer).",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx: any) {
      lastCtx = ctx ?? lastCtx;
      // Everything below looks the checkpoint up by this id — the note
      // skeleton, the build guard, the ordering guard, both closing artifacts.
      // A near miss is pulled back onto the script rather than quietly
      // disabling all four (see snapCheckpointId).
      const snapped = snapCheckpointId(String(params.id ?? "").trim());
      const id = snapped.id;
      const judgment = String(params.judgment ?? "").trim();
      if (!JUDGMENTS.includes(judgment)) {
        return toResult({
          out: `NOT LOGGED — judgment must be one of ${JUDGMENTS.join(" | ")}, got "${judgment}". Call again.`,
          failed: false,
        });
      }
      let response = String(params.student_response ?? "").trim();
      if (!response) {
        return toResult({
          out: `NOT LOGGED — student_response is empty. Log their actual words (or "(no answer — moved on)") and call again.`,
          failed: false,
        });
      }
      // Their answer to a question that is still hanging would be eaten by
      // this tool's own dialog. Once — a rhetorical closer is one retry away,
      // and the retry needs no speech.
      //
      // Every gate below stands aside for a live referee ruling, and this one
      // is where that rule is written down. The verdict the student's ⚖️
      // appeal produces says, in the message the model reads: "If a gate
      // refused you before, it will let this ruling through now." That was
      // true of the build and photo gates only; the hanging, slot-count,
      // drift and late-close gates never consulted the waiver, so an appeal
      // that ruled accept_and_close could still be refused by four of the six
      // — the tutor promising the student their answer counts and then not
      // being able to log it.
      const hanging = tutorAwaitingAnswer(ctx);
      if (hanging && (slotDriftWarned.get(`${id}:hanging`) ?? 0) < 1 && !refereeWaiverActive()) {
        slotDriftWarned.set(`${id}:hanging`, 1);
        return toResult({
          out:
            `NOT LOGGED — you just asked "${hanging.slice(0, 90)}" and they have not ` +
            `answered. Closing here opens the "where to next?" dialog, which takes over ` +
            `the keyboard: their answer would go into the picker and never reach you, ` +
            `and the checkpoint would close itself. Say nothing more, WAIT for their ` +
            `reply, react to it, and then call checkpoint_done.\n` +
            `If that question was rhetorical (a cliffhanger into the next chapter) or ` +
            `they have already answered it, call checkpoint_done again right now — no ` +
            `need to say anything first.`,
          failed: false,
        });
      }
      // A checkpoint whose script promises a build cannot be closed while
      // that build is missing. cp5_ring_formula asks seven things and the
      // seventh is "photograph that page"; a live run answered the first
      // six, decided the reasoning was complete, and closed — the upload
      // area was never inserted and the photo never asked for, on a
      // checkpoint whose whole point is the page in the student's own hand.
      // Capped like the rest, so a dead notebook cannot strand anyone.
      const wantCells = scriptedBuildCells(baseCheckpointId(id));
      let missingBuild: string[] = [];
      if (wantCells.length > 0) {
        const have = await notebookCellNames(signal);
        if (have) missingBuild = wantCells.filter((c) => !have.includes(c));
      }
      const buildStrikes = slotDriftWarned.get(`${id}:build`) ?? 0;
      if (missingBuild.length > 0 && buildStrikes < 2 && !refereeWaiverActive()) {
        slotDriftWarned.set(`${id}:build`, buildStrikes + 1);
        return toResult({
          out:
            `NOT LOGGED — this checkpoint's build never happened: ${missingBuild
              .map((c) => `"${c}"`)
              .join(", ")} ${missingBuild.length > 1 ? "are" : "is"} missing from the ` +
            `notebook. Read your script's build: line for "${baseCheckpointId(id)}", run ` +
            `the nb_add_template it names, and work the part of the ask that goes with it ` +
            `— on a paper checkpoint that means asking for the photo and WAITING for the ` +
            `📨 Send press. Then call checkpoint_done again.`,
          failed: false,
        });
      }
      // The build existing is not the same as the page being asked for. On a
      // checkpoint whose build inserts a drop area, either a photo came
      // through (nb_view_image saw it) or the student said they cannot take
      // one — and in that case the record should say so. One nudge, then it
      // logs either way with the gap on the row.
      const wantPhotos = scriptedPhotoCells(baseCheckpointId(id));
      // The in-memory set dies with the process, but the photo itself does
      // not: nb_view_image saves the original under assets/uploads/. Consult
      // both, or a resume after a photo was already read re-fires the
      // refusal and stamps a false `photo_missing` on the graded row.
      const uploadedOnDisk = (w: string): boolean => {
        try {
          return fs
            .readdirSync(path.join(process.cwd(), "assets", "uploads"))
            .some((f) => f.startsWith(`${w}_upload`) || f.startsWith(`${w}_view`));
        } catch {
          return false;
        }
      };
      const photoMissing =
        wantPhotos.length > 0 &&
        !wantPhotos.some((w) => viewedPhotos.has(w) || uploadedOnDisk(w));
      // The page WAS the answer, and it arrived. Declared here beside what it
      // is derived from rather than beside its first use: read from the note
      // rendering ~170 lines below, and a const read above its own
      // declaration is the temporal-dead-zone shape that made every
      // checkpoint unclosable once already.
      const photoAnswered = wantPhotos.length > 0 && !photoMissing;
      // Did they say ANYTHING about a camera at THIS checkpoint? A live run
      // carried "camera's broken" forward from cp2_paperwork and opened cp4
      // with "well, thinking time, since your camera's still out" — the page
      // never asked for at all, on a checkpoint whose script says "THE PAGE
      // IS THE POINT". So the exemption is scoped to where it was said: they
      // may repeat it in one word, but the ask has to happen.
      // Has the ask been put to them here? Either they mentioned a camera in
      // their own words, or — after the first refusal told the tutor to ask —
      // they have typed something since. A live run refused three times
      // because the student answered "still broken sorry, ill go with the
      // typed version", which says nothing about a camera; they had answered
      // the question, and the guard did not notice.
      const photoStrikes = slotDriftWarned.get(`${id}:photo`) ?? 0;
      const saidSoFar = studentSaidSince(ctx, false);
      // "Typed something SINCE the refusal", measured against where the
      // transcript stood WHEN the refusal went out — not against the whole
      // checkpoint. saidSoFar counts from the last checkpoint close, so on a
      // checkpoint where the student had already answered anything at all
      // this read true on the very first retry and quietly collapsed the two
      // nudges into one. The page is the point on these checkpoints; the
      // second ask is the one that usually gets it.
      const saidWhenAsked = slotDriftWarned.get(`${id}:photoSaid`);
      const typedSinceAsk =
        photoStrikes > 0 && saidWhenAsked !== undefined && saidSoFar.length > saidWhenAsked;
      const cameraSaidHere =
        saidSoFar.some((m) => /camera|photo|picture|scan|phone/i.test(m)) || typedSinceAsk;
      if (photoMissing && photoStrikes < (cameraSaidHere ? 1 : 2) && !refereeWaiverActive()) {
        slotDriftWarned.set(`${id}:photo`, photoStrikes + 1);
        slotDriftWarned.set(`${id}:photoSaid`, saidSoFar.length);
        return toResult({
          out:
            `NOT LOGGED — this is a pen-and-paper checkpoint and no photo has reached ` +
            `me for "${wantPhotos[0]}". If you have not asked yet: SAY THE ASK OUT LOUD ` +
            `to the student now — the page and nothing else — and only then end your ` +
            `turn. Never end a turn on this without speaking: a silent turn is a frozen ` +
            `screen, and in a live run it left a student waiting ten minutes. Their 📨 ` +
            `Send press starts the next turn, and you read it with nb_view_image.\n` +
            (cameraSaidHere
              ? `They have said something about a camera here, so if that was "I can't", ` +
                `their typed work counts — say so in notes ("camera broken, typed ` +
                `instead") and call checkpoint_done again; it will log.`
              : `They have said NOTHING about a camera at this checkpoint. An answer they ` +
                `gave two checkpoints ago is not an answer here: ask for the page, and if ` +
                `they tell you again that they cannot, that is fine and their typed work ` +
                `counts.`),
          failed: false,
        });
      }
      // ── The close with nothing said in front of it ──────────────────────
      // AGENTS.md says "The reveal comes BEFORE checkpoint_done, always", with
      // the live failure that motivated it written out underneath — and in one
      // m02 session it was broken three times anyway.
      //
      // The tell needs no reading of meaning: has the tutor said ANYTHING
      // since the student last typed? At cp2_diameter and cp3_clustering the
      // answer was no — the checkpoint_done call sat in an assistant message
      // carrying no text block, so the student went from their own answer to
      // "Where to next?" with not one word in between.
      //
      // RECORDED, not refused. Every field on the row is true either way:
      // what the student lost is the payoff beat, not the record of their
      // work. `closed_without_speaking` has been on the row since the guard
      // gave up after one strike anyway, and a grader reading it can see
      // exactly what happened. Refusing bought one retry and cost a false
      // positive nobody could see: the guard cannot tell "said nothing" from
      // "gave the reveal before their last message", which is why it already
      // carried an escape hatch telling the model to call again immediately.
      // The rule itself lives where it holds — the chapter script, which now
      // spells out the reveal's words at the sites this fired on.
      const revealDue = !!scriptedReveal(baseCheckpointId(id));
      const spokeSince = revealDue ? tutorSpokeSinceStudent(ctx) : true;
      // Peek, don't consume: a refusal below must leave the transcript mark
      // where it was, or the retry would log an empty student_said_verbatim.
      const said = studentSaidSince(ctx, false);
      const pickRecords = pickedSince(false);
      // Both halves, everywhere a check compares the record against what the
      // student actually said. The split below decides which FIELD a pick is
      // written to; it must never decide whether a pick counts as their words.
      const picked = pickedTexts(pickRecords);
      const pickedLesson = pickRecords.filter((p) => !p.mechanics).map((p) => p.answer);
      const pickedMechanics = pickRecords
        .filter((p) => p.mechanics)
        .map((p) => (p.question ? `${p.question} → ${p.answer}` : p.answer));
      // Note «slots» the instructor marked «… verbatim» are held to the
      // student's own words. «their pick» (a picker choice, which never
      // reaches the transcript) and free commentary slots are the tutor's to
      // phrase, and are not checked. The bar is deliberately low — reordering
      // and joining and labelling are all fine — so that only invention
      // trips it: a figure they never gave, or three added content words.
      //
      // The pool is the transcript plus the QUESTION's own vocabulary —
      // echoing the words of the question ("distance", "average") is
      // labelling, not fabrication. student_response is deliberately NOT in
      // it: it is model-authored, so including it let the model whitelist
      // its own paraphrase by writing the same text into both fields, which
      // is exactly the failure the check exists to catch.
      //
      // With nothing typed there is nothing to check against, so the check
      // stands down rather than guessing. Checkpoints answered by drawing or
      // photograph are marked in the script instead: their slots do not say
      // «verbatim», because the tutor legitimately writes what the picture
      // shows there, and holding that to the transcript refused honest
      // records (it did, for every photo checkpoint).
      // `picked` belongs in the pool as much as `said` does: a dialog choice
      // IS the student's own answer. Leaving it out refused cp1's honest
      // record twice ("about 20" — the figure 20 appears in neither the
      // typed follow-up nor the question) and then stamped a false quoting
      // warning on it in the submitted notebook.
      // ── The student's answer is not written into the notebook ───────────
      // It used to be. The instructor's skeleton carried «their answers,
      // verbatim» and the extension filled it from the transcript — and that
      // one feature is where nearly every fault in this file's history lived.
      // Four withdrawn guards. A word list that deleted a real answer from a
      // graded artifact, twice. Window edges, detour spans, filler words,
      // rescue clauses, a fail-open cascade: all of it machinery for deciding
      // WHICH of the student's messages to copy.
      //
      // It was also the fourth copy of the same words. A finished notebook
      // already carries them uncurated in `session_record`, session_summary.md
      // carries them again, and `student_said_verbatim` on the row below is
      // the raw window — trustworthy precisely because nothing chooses. The
      // note cell was the only copy that had to choose, and choosing was the
      // bug.
      //
      // What survives here is about the LOG ROW, not the note: student_response
      // is the model's headline for the record and is still held to the
      // student's words.
      const pool = [...said, ...picked, String(params.question ?? "")];
      const problems: string[] = [];
      // The mechanics marking still runs — the late-close gate and the ⚖️ nudge
      // both ask how many times the student ANSWERED here, and "where is my
      // notebook?" is not an answer.
      markUrlAnsweredTurns(ctx);
      // student_response is the headline quote of the graded record, so it is
      // held to the transcript — plus a repair. A near-copy is snapped back
      // silently (the correction is recorded in the log, not paraded at the
      // student), and only real invention — a figure or three content words
      // they never produced — is bounced back to the model.
      let responseSnappedFrom: string | null = null;
      // A bracketed stage direction is not a quote and must survive the snap.
      // Two checkpoints in this course pin one: `(no answer — moved on)`, and
      // cp0_welcome's `(nothing was asked — the session opened straight into
      // the story)`, which its script pins BECAUSE the record's headline is
      // the first thing a cold reader meets. The student still types something
      // at cp0 — "hi", "start" — so the snap replaced the pinned literal with
      // that word, and the graded record opened with "start" as the answer to
      // "(nothing asked — the session just opened)".
      const stageDirection = /^\((?:nothing|no answer)\b/i.test(response.trim());
      if (said.length > 0 && !stageDirection) {
        const snapped = snapToTranscript(response, said);
        if (snapped) {
          responseSnappedFrom = response;
          response = snapped;
        }
        const d = slotDrift(response, pool);
        if (driftIsReportable(d)) {
          problems.push(
            `student_response ("${response.slice(0, 80)}") adds ` +
              [...d.numbers, ...d.words].map((t) => `"${t}"`).join(", "),
          );
        }
      }
      // When the answer came ONLY from a picker, student_response must be the
      // option they actually chose. This is the one case the transcript cannot
      // police and the one a live run got backwards.
      if (said.length === 0 && picked.length > 0) {
        const pickPool = new Set(picked.flatMap(slotTokens));
        const shared = slotTokens(response).some((t) => pickPool.has(t) && !SLOT_GLUE.has(t));
        if (!shared) {
          problems.push(
            `student_response ("${response.slice(0, 80)}") does not match what they picked: ` +
              picked.map((p) => `"${p}"`).join(", "),
          );
        }
      }
      // Two refusals per checkpoint, then it logs anyway with the drift
      // flagged for the grader: a model that cannot satisfy the check must
      // never be able to strand the student mid-lesson.
      const strikes = slotDriftWarned.get(id) ?? 0;
      if (problems.length > 0 && strikes < 2 && !refereeWaiverActive()) {
        slotDriftWarned.set(id, strikes + 1);
        return toResult({
          out:
            `NOT LOGGED — student_response is the student's own words, and this is not in ` +
            `anything they said: ${problems.join("; ")}.\n` +
            `What they actually typed: ${said.map((s) => `"${s}"`).join(", ")}.\n` +
            `Quote them, don't polish — no figure they didn't give, no sentence built out ` +
            `of your own summary. Your reading of a drawing, or a number a widget showed, ` +
            `belongs in notes.` +
            (picked.length
              ? ` They picked: ${picked.map((p) => `"${p}"`).join(", ")} — record THAT.`
              : "") +
            ` Then call checkpoint_done again.`,
          failed: false,
        });
      }
      // ── The close that came too late ────────────────────────────────────
      // The verbatim capture resets HERE and nowhere else, so a close that
      // waits until the next question is already being answered files two
      // checkpoints' words under one id. A gate run did exactly that: the
      // student was walked pair-by-pair through cp2_distance, then answered
      // "can you just tell me the answer?" and cp2_diameter's "the A-D one is
      // the tallest bar" — and all nine lines, both checkpoints', landed in
      // cp2_distance's row, logged `pass` with zero hints. cp2_diameter's own
      // row kept a single line and lost the hint it was given. Nothing in the
      // record said any of this happened.
      //
      // How many times they ANSWERED is the tell. A checkpoint answered when
      // it is asked takes one or two; six is the same "these two are going
      // round" the ⚖️ nudge fires on, and zero hints after six answers is not
      // a clean pass whatever the model believes it remembers. Refuse once —
      // the model gets to recount, and to close the next one on time — then
      // log whatever comes back, because a guard that will not let go is a
      // student stuck at a checkpoint they have already finished.
      //
      // This arm was `turnsInCheckpoint >= 12` and it was measuring the wrong
      // thing: a live session ran 13 assistant turns to 5 student messages, so
      // twelve turns is four or five exchanges, and this could refuse a close
      // on a checkpoint the student had answered twice. See #3.
      // The same zero, caught earlier. The count above only fires at six
      // answers, and a checkpoint can be guided through in three: two live
      // runs logged `pass` with no hints on rows whose own verbatim array
      // holds the wrong first answer that a hint corrected, and one of them
      // wrote "invented it unprompted" in the notes beside it.
      //
      // The tell that IS in reach: a scripted checkpoint asks a known number
      // of questions, and every extra message the student sent is one the
      // tutor asked for. More answers than questions, with no hints, is worth
      // one look. Conservative on purpose — the count is taken only from an
      // `ask` block that numbers its questions, a multi-part answer typed as
      // two messages costs one extra tool call and nothing else, and the
      // nudge says so.
      const qCount = scriptedQuestionCountFor(baseCheckpointId(id));
      // Not said.length. The raw window holds a detour's turns too, and a
      // student who asked ONE question mid-checkpoint tripped this refusal —
      // measured in a live run on a checkpoint they answered correctly first
      // try, on turns 1 and 3, with a logged detour in between. The refusal's
      // prescribed remedy is to raise hints_used, so the fix it argues for is
      // a lie in the graded record; and it fires more often the more a student
      // asks, which degrades the record of exactly the curious student this
      // module wants.
      //
      // The count comes from the SAME narrowing the note cell uses, so the two
      // can never disagree again about what an answer is here. Subtracting can
      // only turn the gate off, never on.
      const answerCount = answerCountForGate({
        said,
        response,
        detourSpans,
        detourAsked,
        mechanicsAsked,
      });
      const moreAnswersThanQuestions = qCount > 0 && answerCount > qCount;
      const lateStrikes = lateCloseWarned.get(id) ?? 0;
      if (
        (answerCount >= STUCK_ANSWERS || moreAnswersThanQuestions) &&
        Math.round(Number(params.hints_used ?? 0) || 0) === 0 &&
        judgment !== "prediction" &&
        lateStrikes < 1 &&
        !refereeWaiverActive()
      ) {
        lateCloseWarned.set(id, lateStrikes + 1);
        return toResult({
          out:
            `NOT LOGGED — ` +
            (moreAnswersThanQuestions
              ? `this checkpoint's script asks ${qCount} question${qCount === 1 ? "" : "s"} ` +
                `and the student sent ${answerCount} answers, `
              : `the student has answered ${answerCount} times at this checkpoint `) +
            `and you are logging it with no hints. Two things to fix, in this order.\n` +
            `1. hints_used: count the smaller questions you asked to get them there. ` +
            `A question you asked because an answer was not there yet is a hint, even ` +
            `if they got it on the very next turn — and "unprompted" does not belong ` +
            `in the notes of a row like that. Hints are never held against the ` +
            `student; a wrong count is what damages the record. If they really did ` +
            `answer everything first time (two messages for one two-part answer, say), ` +
            `send it again unchanged and it will log.\n` +
            `2. If you have already moved on to the next question, this close is late, ` +
            `and everything they typed since — including their answer to the NEXT ` +
            `checkpoint — is about to be filed under this one. Close a checkpoint the ` +
            `moment its answer lands, before you ask the next thing.\n` +
            `Then call checkpoint_done again. It will log whatever you send this time.`,
          failed: false,
        });
      }
      // The next scripted checkpoint is now the open one, even if it builds
      // nothing — that is what keeps its note cell ahead of the next build.
      // Off-script ids (a stretch, a typo) must NOT null it out: that would
      // switch the ordering guard off for the rest of the session.
      // Monotonic. Closing an out-of-order practice round — a
      // `cp2_distance_extra` logged from chapter 3 — used to move the open
      // checkpoint BACKWARDS, and the build guard it arms then refused every
      // remaining build with "close cp2_paperwork first": a checkpoint that
      // already has a row and a note, so obeying wrote a duplicate into the
      // graded record. The session's position only ever goes forward.
      if (isScriptedCheckpoint(id)) {
        const ord = checkpointOrder();
        const advanced = nextCheckpointId(id);
        // null means "module finished" — the END of the order, not before
        // its start, or closing a stray practice round could pull the
        // session back out of the terminal state.
        const here = pendingCheckpoint ? ord.indexOf(pendingCheckpoint) : ord.length;
        const there = advanced ? ord.indexOf(advanced) : ord.length;
        if (there >= here) pendingCheckpoint = advanced;
      }
      // The resume window closes with the first checkpoint: past this point
      // every dialog answer is a lesson answer.
      awaitingResumeChoice = false;
      studentSaidSince(ctx, true);
      pickedSince(true);
      // The detour marks belong to the checkpoint just closed — the same
      // words typed again later are a fresh answer.
      detourAsked.clear();
      // Same lifetime, same reason: the same words typed again at the NEXT
      // checkpoint are a fresh answer, not a fresh piece of housekeeping.
      mechanicsAsked.clear();
      stuckNudged = false;
      // The spans are indices into the window that just closed. Left behind,
      // they would point at whatever the NEXT checkpoint's window puts in
      // those slots — the student's own answers.
      //
      // BELOW the late-close gate, and it has to stay below: the gate reads
      // these two to work out how many of `said` were answers to THIS
      // checkpoint rather than to an aside. Moving this block above it would
      // revert that fix with no test failing except the ones written for it.
      detourSpans.length = 0;

      // A checkpoint that needed hints is `pass_with_hints`, whatever the
      // model typed. It logged plain `pass` with hints_used 2 in a live run —
      // not dishonesty, just two fields the model has to keep agreeing, so
      // the extension makes them agree. Hints are never penalised; the point
      // is that the record says what happened.
      let hintsOut = Math.max(0, Math.round(Number(params.hints_used ?? 0) || 0));
      // The two fields must agree, whichever way round they were typed. A
      // `guided` checkpoint is by definition one the tutor walked them
      // through, so zero hints there is a miscount, not a cleaner record.
      const judgmentOut =
        judgment === "pass" && hintsOut > 0
          ? "pass_with_hints"
          : judgment === "pass_with_hints" && hintsOut === 0
            ? "pass"
            : judgment;
      if (judgmentOut === "guided" && hintsOut === 0) hintsOut = 1;
      // A row logged under a referee ruling says so, for the graders. The
      // waiver is spent here — except next_chapter, which chapter_done's own
      // gate must still see and consume.
      let appealRuling: string | null = null;
      if (refereeWaiverActive()) {
        appealRuling = refereeWaiver!.ruling;
        if (appealRuling !== "next_chapter") refereeWaiver = null;
      }
      // Read BEFORE the reset on the next line, which is four lines above the
      // row that logs it. Taken after, the field is 0 on every checkpoint ever
      // closed — which is worse than not having it: a grader reads "0 turns"
      // beside "0 hints" and concludes the student needed neither.
      //
      // +1, and -1 rather than 0, because turn_end has not run yet. The
      // counter holds turns COMPLETED since this checkpoint opened; the turn
      // this close is happening in is one more, and it belongs to THIS
      // checkpoint. Resetting to 0 handed that same turn to the NEXT one:
      // every checkpoint started at 1, so the ⚖️ stuck nudge fired at eleven
      // turns rather than twelve and the late-close gate counted a turn the
      // student had not taken yet. -1 lets turn_end's increment land on 0
      // where the next checkpoint actually begins.
      const turnsTaken = turnsInCheckpoint + 1;
      turnsInCheckpoint = -1; // turn_end brings it to 0; a closed checkpoint is not a stuck one
      const logged = appendLog({
        type: "checkpoint",
        id,
        question: String(params.question ?? ""),
        student_response: response,
        judgment: judgmentOut,
        hints_used: hintsOut,
        // How long the two of them were actually on this checkpoint. Not a
        // check and not a correction — a FACT, next to a number the model
        // supplies from memory and has been seen to get wrong: a live run
        // gave three separate guiding turns on one sub-question ("A to B —
        // how many lines?", then "is there a line directly from A to B…",
        // then "look at the rust dot in the middle…") and logged
        // hints_used: 2. Nothing here overrides the model's count, because
        // "was that turn a hint or a reaction?" is a judgement no counter can
        // make. But a grader reading `hints_used: 0` beside eleven turns can
        // see what happened, and today the row gives them nothing to see it
        // with. Hints are never held against the student; a record that
        // undercounts them is what damages this.
        turns_in_checkpoint: turnsTaken,
        // How many of those messages the gate counted as answers to THIS
        // checkpoint, when that is not all of them. Recorded rather than
        // silent: without it a grader reading nine student turns beside a
        // quiet gate cannot see that an aside is why.
        ...(answerCount !== said.length ? { answers_counted: answerCount } : {}),
        notes: String(params.notes ?? ""),
        student_said_verbatim: said,
        // The lesson half. Every dialog answer used to land here, including
        // the ones the tutor raised for its own housekeeping: a submitted log
        // has "Found it — I can see the city now" — the answer to an
        // improvised "did the page open?" — filed beside a student's real
        // prediction about the seven bridges, and rendered into their notebook
        // as part of it. The machinery half is KEPT, in its own field with the
        // question attached: that answer is the best evidence in the whole
        // submission that the page never opened by itself. It is just not an
        // answer to the bridge puzzle.
        ...(pickedLesson.length > 0 ? { student_picked: pickedLesson } : {}),
        ...(pickedMechanics.length > 0 ? { student_picked_mechanics: pickedMechanics } : {}),
        ...(responseSnappedFrom ? { response_retyped_as: responseSnappedFrom } : {}),
        ...(photoMissing ? { photo_missing: true } : {}),
        // This is the whole of the reveal check now — there is no refusal
        // above it any more. Says only what is checkable: nothing was spoken
        // between their last words and this close. A reveal given before
        // their last message is not visible from here, and this does not
        // claim otherwise, which is exactly why refusing on it was the wrong
        // shape.
        ...(revealDue && !spokeSince ? { closed_without_speaking: true } : {}),
        // The build guard gives up after two refusals and logs anyway — the
        // right call, since a guard that can strand a student is worse than
        // the fault it catches. But it left no mark, so a row for a checkpoint
        // whose figure is not in the notebook was byte-identical to an honest
        // one, while the photo gate beside it has always stamped its own gap.
        ...(missingBuild.length ? { build_missing: missingBuild } : {}),
        // Which id the model actually sent, when it was not the script's.
        ...(snapped.snappedFrom ? { id_snapped_from: snapped.snappedFrom } : {}),
        ...(appealRuling ? { closed_by_referee: appealRuling } : {}),
        // Invention in student_response — a figure or three content words the
        // student never produced — after two refusals. The other fields that
        // used to sit here (note_quotes_msgs, note_skipped_msgs,
        // note_window_from_msg, slot_quotes_repaired, note_quotes_short,
        // figures_not_quoted) all described which of their messages the NOTE
        // CELL had copied, and there is no such copy any more.
        ...(problems.length > 0 ? { verbatim_drift: problems } : {}),
      });

      const suppressed = noteSuppressed(id);
      const skeleton = suppressed ? "" : noteSkeleton(id);
      const md = suppressed
        ? ""
        : skeleton
          ? renderNoteSkeleton(skeleton)
          : String(params.note_markdown ?? "").trim();
      let noteLine: string;
      if (suppressed) {
        noteLine =
          `No note cell for this one, by design (the script says note: none) — it is ` +
          `logged and appears in the closing record. Do NOT add one yourself.`;
      } else if (!md) {
        noteLine =
          `NO NOTE CELL: this checkpoint has no note: skeleton and you passed no ` +
          `note_markdown — add one now with nb_add_cell (name "${id}_note").`;
      } else {
        // Park FIRST, unpark on success. The row is already on disk by this
        // point, and inserting a cell takes a round trip to the kernel — so a
        // session that ends inside that round trip (Ctrl-C, a closed terminal,
        // a shut laptop, all of them ordinary ways for a beginner to stop)
        // left a logged checkpoint whose note existed nowhere: not in the
        // notebook, not parked, and not in the model's context after the next
        // compaction. Written down before the risky part, it survives.
        await flushParkedNotes(signal);
        parkNote(`${id}_note`, md);
        const r = await insertMarkdownCell(`${id}_note`, md, signal);
        // A note that could not be written stays PARKED, exactly as rendered.
        // In a live run the notebook died mid-checkpoint, and by the time the
        // tutor came back to write the note the student's wording had been
        // compacted out of its context — so it reconstructed the quotes from
        // memory and paraphrased three of them into the graded artifact. The
        // text is already correct here; nothing needs to remember it.
        if (!r.failed) unparkNote(`${id}_note`);
        noteLine = r.failed
          ? `Note cell PARKED — the notebook is unreachable, so the note is saved ` +
            `exactly as written and goes in by itself the moment the notebook is back. ` +
            `Do NOT rewrite it later from memory; keep teaching.`
          : `Note cell added.`;
      }

      // Every branch NAMES the checkpoint to go to. Without that, a small
      // model three practice rounds deep loses the thread: in a live run it
      // answered READY by inventing yet another warm-up and logging
      // cp0_welcome_extra, then _extra_extra — the student could not leave
      // cp0 at all. "Start the next checkpoint from your script" is not an
      // instruction a flash model can act on; "start cp1_milgram" is.
      const nextId = nextCheckpointId(id);
      // "Find it in your CHAPTER SCRIPT" is only true while the next id is in
      // THIS chapter. At every chapter boundary it named a checkpoint the
      // script in context does not contain, contradicting the script's own
      // closing line ("call chapter_done") in the same turn — and the tool
      // result is the instruction a flash model actually follows.
      const thisChapter = loadChapters().find((c) => c.checkpoints.includes(baseCheckpointId(id)));
      const nextIsHere = !!nextId && !!thisChapter && thisChapter.checkpoints.includes(nextId);
      const goNext = !nextId
        ? `That was the last checkpoint of the module — call chapter_done next.`
        : nextIsHere
          ? `Start checkpoint "${nextId}" NOW: find it in your CHAPTER SCRIPT and ask its ` +
            `first question. Do not revisit "${baseCheckpointId(id)}".`
          : `That was the last checkpoint of this chapter — call chapter_done next. It ` +
            `loads the chapter that holds "${nextId}"; do not start that checkpoint from ` +
            `memory.`;
      const READY = "Ready for the next question";
      const ASK_Q = "I have a question first";
      const MORE = "Give me another one like that";
      // When the picker cannot run — a dead notebook, a headless restart —
      // the pace gate becomes a sentence, and a live run simply carried on
      // into the next checkpoint without ever asking. So the sentence leads
      // with the prohibition, and the next build is bounced once to make it
      // stick.
      let nextLine =
        `No picker available. Do NOT start the next checkpoint yet: ask the student in ` +
        `plain text whether they are ready, END YOUR TURN, and wait for their answer. ` +
        `Only when they say yes: ${goNext}`;
      let paceAsked = false;
      // A `note: none` checkpoint asked the student NOTHING. cp0 is the
      // greeting, and its script says in as many words to say hello, close,
      // and go straight into the first real checkpoint. Stopping there for
      // "where to next?" offers three rows that are all false: there is no
      // next question yet, no answer of theirs to have a question about, and
      // "give me another one like that" points at a "one" that does not
      // exist. A live run put that menu on screen ten seconds into the
      // session, after the student had typed nothing but "hello", and made
      // them press Enter on it before the lesson had begun. Nothing was
      // asked, so there is nothing to pace.
      if (suppressed) {
        paceAsked = true;
        nextLine =
          `Nothing was asked here, so the student was NOT stopped to choose where to go ` +
          `next — treat them as READY. ${goNext}`;
      } else if (ctx?.ui?.select) {
        paceAsked = true;
        // The reveal, above the question, so the beat survives a short window.
        const said = lastTutorLine(ctx);
        const { choice, typed } = await askStudent(
          ctx,
          said ? `${said}\n\nWhere to next?` : "Where to next?",
          [READY, ASK_Q, MORE],
        );
        const practiceRound = /_extra/.test(id);
        nextLine =
          choice === READY
            ? `The student is READY. ${goNext}`
            : choice === ASK_Q
              ? `The student has a QUESTION. Do NOT advance: ask what it is, answer it ` +
                `properly, leave a souvenir cell, call log_detour, then ask them again ` +
                `in plain text whether to move on. When they are ready: ${goNext}`
              : choice === MORE
                ? // A checkpoint with no fresh_variants has nothing to practise
                  // (cp0 is a calibration question), and a second helping of an
                  // already-repeated one is where the loop started.
                  !hasFreshVariants(baseCheckpointId(id))
                  ? `The student asked for MORE PRACTICE, but this checkpoint has no ` +
                    `practice variant — it is not that kind of question. Say so warmly in ` +
                    `ONE sentence, then: ${goNext}`
                  : practiceRound
                    ? `They have already had a practice round here. Give at most one more, ` +
                      `then move on regardless: ${goNext}`
                    : `The student wants MORE PRACTICE. Do NOT advance yet: improvise ONE ` +
                      `problem of the same kind on NEW data, from this checkpoint's ` +
                      `fresh_variants. Guide, then checkpoint_done again with id ` +
                      `"${baseCheckpointId(id)}_extra" (never a fail). After that: ${goNext}`
                : choice === TYPE_IT && typed
                  ? `Do NOT start the next checkpoint. The student typed this instead of ` +
                    `picking a row — these are THEIR words, react to them: "${typed}". ` +
                    `Answer whatever it asks (a question gets a proper answer, a souvenir ` +
                    `cell and log_detour), then ask in plain text whether they are ready. ` +
                    `Only when they say yes: ${goNext}`
                  : `The student closed the picker — ask in plain text what they'd like to do. ` +
                    `If they want to move on: ${goNext}`;
      }

      if (!paceAsked && nextId) paceUnasked.add(nextId);
      return toResult({
        out:
          `Logged${logged ? "" : " (LOG WRITE FAILED — tell no one, keep teaching)"}. ` +
          `${noteLine}\n${nextLine}`,
        failed: false,
      });
    },
    ...quiet("Writing that into your notebook…"),
  });

  // ── nb_submit ─────────────────────────────────────────────────────────────
  //
  // Handing the work in, from inside the session.
  //
  // This did not exist, and its absence cost a student their submission. They
  // asked the tutor mid-session to put their work on GitHub; the tutor has no
  // shell and no instruction covering it, so it refused. They appealed to the
  // referee, which has six rulings and none of them is "submit" — so it ruled
  // on the nearest thing, the tutor accepted the ruling warmly, and the
  // session moved on to the next chapter with the request simply gone. The
  // work sat unsubmitted in a folder.
  //
  // There is a second half nobody would have found by reading the module:
  // these assignments are `submission_mode: "tag"`, where a plain `git push`
  // is DELIBERATELY not a submission — classroom50 suppresses branch-triggered
  // runs and grades only a pushed `submit/*` tag. The README told students to
  // push the branch. So even a student who did it by hand, exactly as
  // documented, was not handing anything in. Both halves are why this tool
  // tags as well as pushes.
  //
  // git is run directly, never through a shell: the tutor's bash tool is
  // excluded on purpose, and on Windows the student has Git Bash but the
  // agent does not.
  const gitRun = (
    args: string[],
    opts: { input?: string } = {},
  ): { ok: boolean; out: string } => {
    try {
      const r = spawnSync("git", args, {
        cwd: process.cwd(),
        encoding: "utf-8",
        input: opts.input,
        timeout: 120_000,
        // No credential prompt may ever block the session waiting on a
        // terminal the student is not looking at.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
      return { ok: r.status === 0, out };
    } catch (e: any) {
      return { ok: false, out: String(e?.message ?? e) };
    }
  };

  /** `submit/<UTC>-<short sha>` — classroom50's canonical namespace, minted
   *  the same way its own workflow mints it, so a pushed tag IS the record. */
  const submissionTag = (sha: string): string => {
    const t = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
    return `submit/${t}-${sha.slice(0, 7)}`;
  };

  pi.registerTool({
    name: "nb_submit",
    label: "Hand in",
    description:
      "Commit the student's work and hand it in. Call this WHENEVER they ask to submit, " +
      "hand in, save to GitHub, or push — at any point in the session, not only at the " +
      "end — and once more when the module finishes. Never refuse the request and never " +
      "tell them to type git commands: this is the tool for it. It commits everything " +
      "(the notebook, the session log, their photos and code), pushes, and then pushes a " +
      "submission tag, which is what actually starts the grading. Safe to call twice; " +
      "with nothing new to commit it just says so.",
    promptSnippet: "Commit and hand in the student's work",
    parameters: Type.Object({
      status: STATUS_PARAM,
      message: Type.Optional(
        Type.String({
          description:
            "Commit message. Something plain about where they are — " +
            "\"Pair Notebook 01 — through chapter 3\". Defaults to the module and the date.",
        }),
      ),
    }),
    execute: async (_id: any, params: any, _signal: any, _onUpdate: any) => {
      const inside = gitRun(["rev-parse", "--is-inside-work-tree"]);
      if (!inside.ok) {
        return toResult({
          out:
            `NOT HANDED IN — this folder is not a git repository, so there is nothing to ` +
            `push to. Their work is still safe on disk (the notebook and ` +
            `session_artifacts/ are written as you go). Tell them plainly that the ` +
            `folder they are working in is not the one the assignment link created, and ` +
            `that their instructor can sort it out — then carry on teaching.`,
          failed: false,
        });
      }

      const msg =
        String(params?.message ?? "").trim() ||
        `Pair Notebook — ${new Date().toISOString().slice(0, 10)}`;

      gitRun(["add", "-A"]);
      const staged = gitRun(["diff", "--cached", "--quiet"]);
      let committed = false;
      if (!staged.ok) {
        let c = gitRun(["commit", "-m", msg]);
        if (!c.ok && /please tell me who you are|user\.email|user\.name/i.test(c.out)) {
          // A fresh machine has no git identity, and "Please tell me who you
          // are" is not something to hand a student mid-lesson. Commit as the
          // repo's own owner, the way GitHub's web editor does.
          const url = gitRun(["remote", "get-url", "origin"]).out;
          const owner = /[/:]([^/]+)\/[^/]+?(?:\.git)?$/.exec(url)?.[1] ?? "student";
          c = gitRun([
            "-c", `user.name=${owner}`,
            "-c", `user.email=${owner}@users.noreply.github.com`,
            "commit", "-m", msg,
          ]);
        }
        if (!c.ok) {
          return toResult({
            out:
              `NOT HANDED IN — the commit failed: ${c.out.slice(0, 300)}\n` +
              `Say in one warm line that you could not hand it in and their instructor ` +
              `will sort it out. Their work is still on disk. Then carry on teaching.`,
            failed: false,
          });
        }
        committed = true;
      }

      const sha = gitRun(["rev-parse", "HEAD"]).out.trim();
      const branch = gitRun(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim() || "HEAD";
      const hasRemote = gitRun(["remote", "get-url", "origin"]).ok;
      if (!hasRemote) {
        return toResult({
          out:
            `Committed${committed ? "" : " (nothing new to commit)"}, but NOT handed in: ` +
            `this folder has no GitHub remote, so there is nowhere to push. Tell them ` +
            `their work is saved here and their instructor can sort the hand-in out.`,
          failed: false,
        });
      }

      const push = gitRun(["push", "origin", `HEAD:${branch}`]);
      if (!push.ok) {
        return toResult({
          out:
            `Committed, but the push failed: ${push.out.slice(0, 300)}\n` +
            `Their work IS saved and committed — nothing is lost. Say in one line that ` +
            `you could not reach GitHub and they should tell their instructor, then carry ` +
            `on teaching. Do not debug it with them and do not ask them to type anything.`,
          failed: false,
        });
      }

      // The tag is the submission. Without it a push in tag mode is filed and
      // never graded, which is the failure this whole tool exists for.
      //
      // But only one tag per commit. A student who asks twice with nothing
      // changed in between would otherwise get a second tag on the same sha,
      // and each one starts its own grading run over identical work —
      // classroom50 dedupes by sha on its side, so it is not wrong, just
      // noise nobody asked for. Already tagged means already handed in, and
      // saying so is a better answer than doing it again.
      const existing = gitRun(["tag", "--points-at", "HEAD", "--list", "submit/*"])
        .out.split("\n").map((s) => s.trim()).filter(Boolean);
      let tag = existing[existing.length - 1] ?? "";
      let madeTag = !!tag;
      if (!tag) {
        tag = submissionTag(sha);
        madeTag = gitRun(["tag", tag]).ok && gitRun(["push", "origin", tag]).ok;
      }

      return toResult({
        out:
          (committed
            ? `Handed in. `
            : existing.length
              ? `Already handed in — nothing has changed since last time. `
              : `Handed in (nothing new to commit — pushed what was there). `) +
          (madeTag
            ? `Submission tag ${tag} is what starts the grading.`
            : `WARNING: the push worked but the submission tag did not, so this may not ` +
              `be graded — tell them to mention it to their instructor.`) +
          `\nSay it in ONE short line — "that's handed in" — and go straight back to the ` +
          `lesson. They can carry on and hand in again as often as they like.`,
        failed: false,
      });
    },
    ...quiet("Handing your work in…"),
  });

  // ── nb_update_setup ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "nb_update_setup",
    label: "Update course setup",
    description:
      "Add course models the student's pi does not know about yet. Call this ONLY when " +
      "they say pi cannot find a course model, or ask to update their setup. NEVER offer " +
      "it unprompted, never mid-checkpoint, and never as a fix for anything going wrong " +
      "in the notebook — it has nothing to do with the lesson. It asks the student's " +
      "permission itself, adds only what is missing, and backs their settings up first. " +
      "Their notebook, their log and their work are not touched.",
    promptSnippet: "Add missing course models to the student's pi settings",
    parameters: Type.Object({ status: STATUS_PARAM }),
    execute: async () => {
      const ctx = lastCtx;
      const plan = await planCourseModels(ctx);

      if (plan.kind === "skip") {
        return toResult({
          out:
            `NOT UPDATED — ${plan.why}. Nothing was changed. Say in ONE warm line that ` +
            `you could not update it from here and their instructor will sort it out, ` +
            `then go straight back to the lesson. Do NOT ask them to type anything, do ` +
            `NOT try another way, and do NOT call this again this session.`,
          failed: false,
        });
      }

      if (plan.kind === "current") {
        return toResult({
          out:
            `Nothing to do — their settings already list every course model. If they ` +
            `told you pi could not find one, the likely answer is that pi has not been ` +
            `restarted since it was added: say so in ONE line ("it'll be there next time ` +
            `you start it"), then back to the lesson.`,
          failed: false,
        });
      }

      const names = plan.missing.map((m: any) => m.id);
      const YES = "Yes, update my settings";
      const NO = "No, leave it alone";
      const { choice, typed, asked } = await askStudent(
        ctx,
        `Add ${names.length > 1 ? "these course models" : "the course model"} ` +
          `${names.map((n: string) => `"${n}"`).join(", ")} to your pi settings? ` +
          `Your lesson is not affected either way.`,
        [YES, NO],
      );

      // No picker, no consent. Writing to their settings on the strength of
      // something the model believes it heard is exactly the shortcut this
      // tool exists to avoid.
      if (!asked) {
        return toResult({
          out:
            `NOT UPDATED — this session cannot show them the yes/no box, so there is no ` +
            `way to ask permission, and their settings were not touched. Tell them in ` +
            `one line that their instructor will sort it out, then back to the lesson.`,
          failed: false,
        });
      }
      if (choice !== YES) {
        return toResult({
          out:
            (choice === NO
              ? `They said no. Nothing was changed. `
              : typed
                ? `They did not pick yes — they typed this instead: "${typed}". Nothing was ` +
                  `changed. React to what they said, `
                : `They closed the box without answering. Nothing was changed. `) +
            `Do not ask again and do not bring it up later. Back to the lesson.`,
          failed: false,
        });
      }

      const failure = applyCourseModels(plan);
      if (failure) {
        return toResult({
          out:
            `NOT UPDATED — writing their settings failed: ${failure}\n` +
            `Their old settings are intact and their lesson is unaffected. One warm line ` +
            `that their instructor will sort it out, then back to the lesson.`,
          failed: false,
        });
      }
      return toResult({
        out:
          `Added ${names.join(", ")} to their pi settings (the old file is backed up ` +
          `beside it). It does NOT appear in this session — pi reads that file when it ` +
          `starts. Tell them in ONE line that it is set up and will be there the next ` +
          `time they start pi, and that nothing about this lesson has changed. Then go ` +
          `straight back to the lesson — do not explain the file, the folder, or what ` +
          `you just did.`,
        failed: false,
      });
    },
    ...quiet("Checking your course settings…"),
  });

  // ── log_detour ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "log_detour",
    label: "Log detour",
    description:
      "Record a student question you answered off-script (their curiosity is graded as " +
      "engagement) and leave the souvenir in their notebook. Build the souvenir with " +
      "nb_add_cell first — text AND a picture in one mo.vstack, or a playable demo — and " +
      "pass its cell_name. souvenir_markdown is the fallback for an idea no picture helps.",
    promptSnippet: "Log a student's off-script question and leave a souvenir cell",
    parameters: Type.Object({
      status: STATUS_PARAM,
      question: Type.String({
        description:
          "Their question VERBATIM — but the QUESTION only. If they answered and " +
          "asked in one breath (\"2 out of 10 - but why does that matter?\"), send " +
          "just the question part; the rest is their answer and belongs in the note.",
      }),
      what_you_did: Type.String({ description: "One line: how you answered it." }),
      souvenir_markdown: Type.Optional(
        Type.String({
          description:
            "Fallback only: markdown for a text-only 🧭 Detour cell. Prefer nb_add_cell " +
            "+ cell_name, so the souvenir has something to look at or play with.",
        }),
      ),
      cell_name: Type.Optional(
        Type.String({ description: "Name of the souvenir cell you already added." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx: any) {
      const question = String(params.question ?? "").trim();
      const md0 = String(params.souvenir_markdown ?? "").trim();
      const cellName = String(params.cell_name ?? "").trim();
      // A souvenir is a keepsake, not a log line: the notebook's whole promise
      // is that a curious student's copy looks different from everyone else's,
      // and four text-only blobs in one live session is what that failure
      // looks like. Bounced ONCE, with both ways out spelled out, then
      // accepted — some ideas really are just words.
      //
      // The cell the tutor built ITSELF is checked the same way. Trusting
      // that path was the hole: every detour in the failing session arrived
      // as a cell_name, and every one of them was prose that never quoted
      // the question it answered.
      // The question as the STUDENT typed it, not as the tutor remembers it.
      // A live run logged a tidied paraphrase — "wait whats this called," gone,
      // "it" reworded — and the souvenir quoted that.
      const saidNow = studentSaidSince(ctx, false);
      const snapped = snapToTranscript(question, saidNow);
      let snappedQ = snapped ?? question;
      // Mark the message they asked it in, so the next checkpoint's note
      // quotes their answer and not their question — the souvenir already
      // holds the question, word for word.
      //
      // NOT gated on `snapped`: snapToTranscript is a REPAIR, and its first
      // act is to return null when the text is already in the transcript
      // because there is nothing to repair. Gating on it meant the dedup
      // fired only when the model DISOBEYED "their question VERBATIM" and
      // never when it obeyed — measured: verbatim and true paraphrase both
      // leaked, a tidied quote was the only shape that worked.
      {
        // The matcher itself lives in lib/verbatim.ts, where `npm test` runs
        // it. It was extracted there — with tests named after the live faults
        // it encodes — and the call site was never swapped, so for four
        // commits this file ran a hand-copied duplicate and those tests were
        // green against code no session ever reached. test/imports.test.ts
        // now fails on a name imported from lib/ that nothing calls, which is
        // the check that would have caught it the day it shipped.
        const m = matchDetourQuestion(question, saidNow);
        const bestIdx = m.index;
        const asked = bestIdx >= 0 ? saidNow[bestIdx] : "";
        if (m.isDetour) {
          detourAsked.add(normMsg(asked));
          // The question is not the whole detour. Everything from it to here
          // is the aside — the tutor's answer, the offer of a souvenir, their
          // "yes please, that would help" — and none of it answers the
          // checkpoint. Recorded from THEIR question, not from the close, so
          // a detour taken in the middle of a checkpoint leaves the answers
          // they gave before it exactly where they are.
          // bestIdx, not a fresh findIndex over the same text: a student who
          // types the same words twice would match the FIRST of them, and the
          // span would reach back over answers they had already given. It is
          // already the position `asked` was taken from, and it is > -1 here.
          detourSpans.push([bestIdx, saidNow.length - 1]);
          // Whatever the note leaves out, the souvenir says in full — and in
          // THEIR words. A live run logged the question with the student's
          // lead-in trimmed off ("Wait, quick question first —"), and the
          // souvenir quoted the trim. snapToTranscript cannot repair that: a
          // question the message CONTAINS is, to a repair function, already
          // fine. We have just decided this message is the question, so use
          // it.
          if (normMsg(asked) !== normMsg(snappedQ)) snappedQ = asked;
        }
        if (snapped) detourAsked.add(normMsg(snapped));
      }
      // ── Is this quote theirs at all? ──────────────────────────────────────
      // snapToTranscript returns null both when the text is already verbatim
      // in the transcript and when NOTHING in the transcript resembles it, and
      // the second falls through to the model's own string — which is then
      // written into the student's notebook under **You asked**. A submitted
      // m01 notebook carries a whole sentence of reasoning that way, one its
      // student never typed. Per REVIEWING.md that is a Blocker, and it is the
      // one fault here no retry can undo: the keepsake is theirs to keep.
      //
      // Plain containment against everything they typed or picked. On every
      // honest path it is a no-op, because every repair above ends in a REAL
      // message (saidNow[m.index], or snapToTranscript's own return). It
      // stands down when there is nothing to check against.
      //
      // The WHOLE session, not `saidNow`. The window opens where the last
      // checkpoint closed, and AGENTS.md lets a detour be logged after that
      // close — so a question asked before it is honest and simply not in the
      // window. Judging against the window would refuse those, which is the
      // shape of guard this file has had to withdraw four times. A union can
      // only ever say "backed" more often.
      const backingPool = [...allStudentMessages(ctx), ...saidNow, ...pickedTexts(pickedAnswers)];
      const questionBacked = quoteIsBacked(snappedQ, backingPool);
      let quoteRouted: "prepended" | "beside" | "" = "";
      let verdict = souvenirVerdict({ missing: false, proseOnly: false, unquoted: false });
      if (cellName) {
        const src = await readCellSource(cellName, signal);
        // The quote line is the extension's job, not the model's. Left to the
        // model it tidied the student's punctuation ("whats" → "what's", a
        // "?" appended) — a small edit to the one thing in the cell that is
        // supposed to be theirs, word for word. It goes in unless their exact
        // words are already there, and the gap check no longer asks the model
        // for it at all.
        if (src !== null && src.trim() === "") {
          // No such cell. Saying "is prose only" about a cell that does not
          // exist sent the model editing thin air; the honest gap is the one
          // withQuotedQuestion's sibling check has always used.
          verdict = souvenirVerdict({ missing: true, proseOnly: false, unquoted: false });
        } else if (src !== null) {
          // Words, not bytes — the SAME normalisation withQuotedQuestion uses.
          // A byte-exact test called a cell unquoted because the quote had
          // typographic apostrophes, and the cell then carried "You asked"
          // twice: once raw, once tidied.
          const flat = (x: string) =>
            x
              .toLowerCase()
              .replace(/['\u2018\u2019\u02BC"\u201C\u201D]/g, "")
              .replace(/[^a-z0-9]+/g, " ")
              .trim();
          // Either wording: the model wrote this cell against its own
          // `question`, and snappedQ may since have grown into the student's
          // full message.
          let quoted = flat(src).includes(flat(snappedQ)) || flat(src).includes(flat(question));
          // An unbacked quote is not "already quoted", whoever wrote it — and
          // it must not be written by us either. The souvenir keeps its prose
          // and its picture; what it loses is the false attribution.
          if (!questionBacked) quoted = true;
          // Already put in beside this cell on an earlier call. Without this
          // memo the retry after a prose-only bounce re-reads the SOUVENIR,
          // still finds no quote there (it lives in the neighbouring cell),
          // and prepends a second copy — the student's question, twice, in
          // their keepsake. withQuotedQuestion's whole normalise-both-sides
          // comparison exists because that happened once already.
          else if (souvenirQuotedBeside.has(cellName)) quoted = true;
          else if (!quoted) {
            quoted = await prependQuestionToCell(cellName, snappedQ, signal);
            if (quoted) quoteRouted = "prepended";
            else {
              // The prepend failed — a cell marimo will not rewrite, or an ast
              // it will not reparse. The quote is ONE LINE and it is this
              // extension's own job, so it must not depend on the model or on
              // rewriting a cell that has already refused once: put it in a
              // cell of its own, immediately above the souvenir. Two of three
              // souvenirs in a submitted session shipped with no record of the
              // question they answered, and a silent `false` here is why
              // nobody noticed for three sessions.
              quoted = await quoteCellBeside(cellName, snappedQ, signal);
              if (quoted) {
                quoteRouted = "beside";
                souvenirQuotedBeside.add(cellName);
              }
            }
          }
          const shows =
            /netviz\s*\(|mo\.ui\.|mo\.image\s*\(|alt\.Chart|sns\.\w+\s*\(|plt\.\w+\s*\(/.test(src);
          // BOTH faults, and the QUOTE first. `gap` carried one message and
          // `!shows` won the ternary, so a markdown-table souvenir always
          // reported "is prose only" and a missing quote was never mentioned —
          // not in the bounce, not on the row. The prose-only warning then
          // gives up after two tries by design, and took the quote with it.
          // The student had asked for tables and no figures, which is a
          // reasonable thing to want; it should not also cost them the record
          // of their own question.
          verdict = souvenirVerdict({ missing: false, proseOnly: !shows, unquoted: !quoted });
        }
      }
      const gap = verdict.gap;
      const gapKey = cellName || question;
      if (gap && (detourTextOnlyWarned.get(gapKey) ?? 0) < 2) {
        detourTextOnlyWarned.set(gapKey, (detourTextOnlyWarned.get(gapKey) ?? 0) + 1);
        // "Fix it with nb_edit_cell" is the right advice for a cell that is
        // there and thin. For a cell that does not exist it is impossible
        // advice: nb_edit_cell cannot create one, so it prints "no cell named
        // X", which renders as a ✓, and the model tries again against the
        // same nothing until the strikes run out.
        // These two templates used to show the **You asked:** line, and that
        // was the leak: a model that copied the template wrote its OWN wording
        // of the question into the cell, the "is it quoted?" test above then
        // found it and stood down, and the fabricated quote shipped. The quote
        // is not the model's line to write — the extension puts it in, in the
        // student's bytes — so the template no longer contains it.
        return toResult({
          out: verdict.missing
            ? `NOT LOGGED YET — there is no cell named "${cellName}" in the notebook. ` +
              `nb_edit_cell cannot make one; build it first with nb_add_cell (name ` +
              `"${cellName}"), text and picture in ONE cell —\n` +
              `  mo.vstack([mo.md(r"""…the idea, in your words…"""), netviz(edges, highlight=[…])])\n` +
              `— or an nb_add_exercise box if the idea is playable. Then call log_detour ` +
              `again with the same cell_name. Do NOT write a "You asked" line yourself: ` +
              `the extension quotes their question for you, word for word.`
            : `NOT LOGGED YET — the souvenir cell "${cellName}" ${gap}. Fix it with ` +
              `nb_edit_cell so it holds something to see or try (their question is ` +
              `quoted for you — do not add it, and do not reword it) —\n` +
              `  mo.vstack([mo.md(r"""…the idea, in your words…"""), netviz(edges, highlight=[…])])\n` +
              `— or an nb_add_exercise box if the idea is playable. Then call log_detour ` +
              `again with the same cell_name.\n` +
              `If words genuinely are the whole answer here, call log_detour again as it ` +
              `is and it will be accepted.`,
          failed: false,
        });
      }
      if (!cellName && md0 && (detourTextOnlyWarned.get(question) ?? 0) < 2) {
        detourTextOnlyWarned.set(question, (detourTextOnlyWarned.get(question) ?? 0) + 1);
        return toResult({
          out:
            `NOT LOGGED YET — a text-only souvenir is the weakest kind of keepsake. Build ` +
            `the cell first with nb_add_cell (name "detour_<topic>"), text and picture in ` +
            `ONE cell: mo.vstack([mo.md(r"""…"""), netviz(edges, highlight=[…])]) — or an ` +
            `nb_add_exercise box if the idea is something they can try. Then call ` +
            `log_detour again with cell_name. Their question is quoted for you; do not ` +
            `write a "You asked" line yourself.\n` +
            `If a picture genuinely adds nothing to this one, call log_detour again with ` +
            `the same souvenir_markdown and it will be accepted as it is.`,
          failed: false,
        });
      }
      // Insert BEFORE logging, so the row names the cell it actually made. It
      // logged cell:"" on this path, and a grader auditing souvenirs from the
      // log found none for a question that has one.
      let madeCell = "";
      let madeFailed = false;
      if (!cellName && md0) {
        // No quote line when the transcript cannot back one. A tutor-initiated
        // aside is a fine thing to build — the ch5 stretch is exactly that —
        // it just must not be labelled with words the student never said.
        //
        // The strip runs on this path too. withQuotedQuestion stands down when
        // the markdown already "quotes the question", so a souvenir_markdown
        // that arrives with the model's own **You asked** line in it would sail
        // straight through the check above and into the notebook.
        const clean = stripModelQuoteLines(md0).code;
        const md = questionBacked ? withQuotedQuestion(clean, snappedQ, question) : clean;
        const slug = sanitize(question.toLowerCase().split(/\s+/).slice(0, 4).join("_")).slice(
          0,
          40,
        );
        const name = `detour_${slug || "note"}`;
        const r = await insertMarkdownCell(name, md, signal);
        madeFailed = r.failed;
        if (!r.failed) madeCell = name;
      }
      appendLog({
        type: "detour",
        question,
        what_you_did: String(params.what_you_did ?? ""),
        cell: String(params.cell_name ?? "") || madeCell,
        // Peek, never consume: a detour normally happens mid-checkpoint, and
        // consuming the mark here would move the student's checkpoint answer
        // into the detour record — leaving checkpoint_done with an empty
        // student_said_verbatim and a drift check with nothing to match.
        student_said_verbatim: studentSaidSince(ctx, false),
        // Accepted on the retry despite the gap — the grader sees what the
        // souvenir was missing rather than the tool pretending it was fine.
        ...(gap ? { souvenir_gap: gap } : {}),
        // Named on its own, because it is the graded-record fault of the two
        // and it spent three sessions hidden behind "is prose only".
        ...(verdict.unquoted ? { souvenir_unquoted: true } : {}),
        // The prepend failed and the quote went in beside the cell instead.
        // Stamped so that a `false` from prependQuestionToCell is never silent
        // again — that silence is why nobody looked for three sessions.
        ...(quoteRouted === "beside" ? { souvenir_quote_cell: `${cellName}_asked` } : {}),
        // Nothing they typed or picked contains this question, so no quote was
        // written anywhere. The row keeps the model's wording in `question`,
        // where it belongs; the student's notebook does not get it in theirs.
        ...(questionBacked ? {} : { question_unsupported: true }),
      });
      if (!md0) {
        return toResult({
          out: cellName
            ? // Do not call a cell that is not there "noted": the give-up path
              // reported success for a souvenir the student's notebook does
              // not contain, and the model moved on satisfied.
              verdict.missing
              ? `Logged — but there is still NO cell named "${cellName}" in the notebook, ` +
                `so this detour has no souvenir. Build it with nb_add_cell (not ` +
                `nb_edit_cell, which cannot create a cell) when you get a moment.`
              : `Logged. Souvenir cell "${cellName}" noted.`
            : `Logged — but NO souvenir cell yet. Add one now (nb_add_cell, name ` +
              `"detour_<topic>"): their question quoted plus the idea, text and picture ` +
              `together in ONE cell (mo.vstack + netviz).`,
          failed: false,
        });
      }
      return toResult({
        out: madeFailed
          ? `Logged. Souvenir cell FAILED — add it with nb_add_cell.`
          : `Logged and the souvenir is in their notebook.`,
        failed: false,
      });
    },
    ...quiet("Keeping a note of your question…"),
  });

  // ── nb_add_cell ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "nb_add_cell",
    label: "Add notebook cell",
    description:
      "Create and run a new cell in the live marimo notebook. " +
      MARIMO_CELL_RULES,
    promptSnippet: "Add and run a cell in the live marimo notebook",
    promptGuidelines: [
      "Use nb_add_cell / nb_edit_cell / nb_delete_cell / nb_read / nb_run for ALL notebook work — never bash, never raw marimo._code_mode boilerplate.",
      "Every nb_* status is shown to the student: short, warm, plain words only.",
      // Written as a rule as well as enforced as a mechanism, because a rule
      // the model can read is cheaper than a correction it has to be given.
      "NEVER tell the student to start the notebook themselves — no `marimo edit`, no second terminal, no install. This toolkit runs the server; a second one is a second kernel on the same file and the page they would watch is not the one you build in. If they cannot find the notebook, call nb_notebook_url and read them the address.",
    ],
    parameters: Type.Object({
      status: STATUS_PARAM,
      name: Type.String({
        description: "Unique snake_case cell name, e.g. 'cp2_ripple'. Use it later with nb_edit_cell/nb_delete_cell.",
      }),
      code: Type.String({ description: "The cell body (Python)." }),
      show_code: Type.Optional(
        Type.Boolean({
          description: "Show the code editor to the student (default false). Use true for cells whose code the student should read.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      // A cell body runs in the same kernel nb_run does, and it is hidden from
      // the student by default (hide_code), so it is not the safer door.
      const refusedCode = kernelGuard(params.code);
      if (refusedCode) return toResult({ out: refusedCode, failed: false });
      const warm = await ensureWarm(signal);
      if (warm) return toResult(warm);
      await flushParkedNotes(signal);
      await ensureChapterHeader(signal);
      const hide = params.show_code === true ? "False" : "True";
      // nb_add_exercise and nb_view_image both validate the name; this one did
      // not, and it is the tool that gets hand-written names — detours,
      // souvenirs, the personalised half of the notebook. marimo stores a cell
      // whose name is not an identifier as an unparsable block, so "detour:
      // clustering" becomes a dead region in the keepsake and neither
      // nb_edit_cell nor nb_delete_cell can address it afterwards. Correct it
      // rather than refuse, and say what it became.
      const wanted = String(params.name ?? "").trim();
      const name = /^[A-Za-z_]\w*$/.test(wanted)
        ? wanted
        : sanitize(wanted)
            .replace(/^(?=\d)/, "c_")
            .replace(/^_+$/, "cell") || "cell";
      let inner =
        `async with cm.get_context() as ctx:\n` +
        `    _cid = ctx.create_cell(_code, name=${py(name)}, hide_code=${hide})\n` +
        `    ctx.run_cell(_cid)\n`;
      inner += focusCellCode("_cid", "    ");
      // ── The quote line is not the model's to write ───────────────────────
      // Stripped whether or not the transcript backs it. An unbacked one is
      // the Blocker in #5; a BACKED one is the fault an m02 run produced, where
      // the model quoted two thirds of the student's sentence, the extension's
      // own check found no match for the whole of it, prepended the correct
      // quote — and the souvenir ended up carrying the question twice, once
      // whole and once with half of it missing. log_detour adds the right one.
      const cellQuotes = stripModelQuoteLines(params.code);
      // Improvised cells go through the review (nb_review.py) — it catches the
      // displays marimo would silently drop before the student sees a cell
      // with a missing figure.
      const review = reviewSource();
      // Two refusals per cell name, then it goes in with the complaint
      // attached — the same backstop every other guard here has. A review
      // the model cannot satisfy must never be able to strand the student
      // in a retry loop; a cell with one bad formula is the smaller harm,
      // and nb_edit_cell can still fix it.
      const strikes = cellReviewWarned.get(name) ?? 0;
      const enforce = review && strikes < 2;
      if (review && !enforce) cellReviewWarned.delete(name);
      else if (review) cellReviewWarned.set(name, strikes + 1);
      const code =
        `import marimo._code_mode as cm\n` +
        (review ? review + "\n" : "") +
        `_code = ${py(stripRedundantImports(cellQuotes.code))}\n` +
        (review
          ? `_code, _note, _fatal = _nb_review(_code)\n` +
            (enforce
              ? `if _fatal:\n` +
                `    print(_fatal)\n` +
                `else:\n` +
                indentBlock(inner, 4) +
                `    if _note:\n` +
                `        print(_note)\n`
              : indentBlock(inner, 0) +
                `if _fatal or _note:\n` +
                `    print("INSERTED ANYWAY (third attempt) —", _fatal or _note, ` +
                `"Fix it with nb_edit_cell rather than retrying.")\n`)
          : inner);
      const addCellResult = await runKernel(code, signal);
      if (!addCellResult.failed) {
        if (cellQuotes.removed.length) {
          addCellResult.out +=
            `\nNOTE — a "You asked" line was left out of this cell. That line is not ` +
            `yours to write: log_detour adds it, from the student's own message, whole. ` +
            `Yours was ${cellQuotes.removed.map((q) => `“${q}”`).join(", ")} — a re-typed ` +
            `quote loses a clause or tidies their punctuation, and both have happened. ` +
            `Build the aside itself.`;
        }
        await pinAppealToBottom(signal);
        if (name !== wanted) {
          addCellResult.out +=
            `\nNAMED "${name}" — "${wanted}" is not a usable cell name (marimo needs a ` +
            `Python identifier). Use "${name}" if you refer to this cell later.`;
        }
      }
      return toResult(addCellResult);
    },
    ...quiet("Adding something to your whiteboard…"),
  });

  // ── nb_add_exercise ───────────────────────────────────────────────────────
  // Fill-in coding, app-view friendly: instructions + a pre-filled code box
  // (mo.ui.code_editor) + a ▶ Run button that executes via the notebook's
  // run_student_code helper (stdout + last expression, friendly errors).
  // The student never needs the cell editor.
  pi.registerTool({
    name: "nb_add_exercise",
    label: "Add coding exercise",
    description:
      "Give the student a fill-in coding exercise INSIDE the notebook page: instructions, " +
      "a code box pre-filled with your scaffold (numbered # steps with ... blanks), and a " +
      "▶ Run button that executes it and shows output or a friendly error. They can run as " +
      "often as they like. Read their attempt with nb_read('<name>_ed.value'). env_vars " +
      "is ONLY for variables another notebook cell already defines (a graph G you built " +
      "earlier) — never the scaffold's own variables, which live inside the code box. " +
      "lists notebook variables their code may use (e.g. a graph G you set up earlier). " +
      "ALWAYS use this instead of asking the student to edit cells. Pass checkpoint when this " +
      "exercise IS a checkpoint's build (not a detour) — lets the tool catch a checkpoint you " +
      "started but never closed with checkpoint_done.",
    promptSnippet: "Insert a fill-in coding exercise (code box + Run button) into the notebook",
    parameters: Type.Object({
      status: STATUS_PARAM,
      name: Type.String({ description: "Base name, e.g. 'cs1_code'." }),
      instructions: Type.String({
        description: "1-3 sentences shown above the code box (markdown, $math$ ok).",
      }),
      scaffold: Type.String({
        description: "Pre-filled Python: numbered # instructions + ... blanks to fill.",
      }),
      env_vars: Type.Optional(
        Type.Array(Type.String(), {
          description: "Notebook variable names the student's code may use.",
        }),
      ),
      checkpoint: Type.Optional(
        Type.String({
          description: "Checkpoint id this build is for, e.g. 'cp6_large_n_experiment'. Omit for detours.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const name = String(params.name ?? "").trim();
      if (!/^[A-Za-z_]\w*$/.test(name)) {
        return toResult({ out: `'${name}' is not a valid cell name.`, failed: true });
      }
      // The scaffold is model-authored Python the student is invited to run.
      const refusedScaffold = kernelGuard(String(params.scaffold ?? ""));
      if (refusedScaffold) return toResult({ out: refusedScaffold, failed: false });
      const exCpId = String(params.checkpoint ?? "").trim();
      if (exCpId && paceUnasked.has(exCpId)) {
        paceUnasked.delete(exCpId);
        return toResult({
          out:
            `NOT INSERTED — the "where to next?" picker could not run when you closed the ` +
            `last checkpoint, so the student has not said they are ready. Ask them in ` +
            `plain text, END YOUR TURN, and wait. When they say yes, call this again.`,
          failed: false,
        });
      }
      const exKey = `exercise:${exCpId}`;
      if (
        exCpId &&
        pendingCheckpoint &&
        isAheadOf(exCpId, pendingCheckpoint) &&
        (buildOrderWarned.get(exKey) ?? 0) < 2
      ) {
        buildOrderWarned.set(exKey, (buildOrderWarned.get(exKey) ?? 0) + 1);
        return toResult({
          out:
            `NOT INSERTED — '${exCpId}' comes after '${pendingCheckpoint}', which is still ` +
            `open. Call checkpoint_done for '${pendingCheckpoint}' first (its note cell ` +
            `must land before this build), then retry this insert.`,
          failed: false,
        });
      }
      // env_vars becomes a REAL reference in the generated cell, which is
      // how marimo passes a notebook variable into the exercise — and how a
      // name that does not exist takes the whole notebook down. A live run
      // listed the scaffold's OWN variables (N, k, p_values, L0, C0, rows,
      // df), which live only inside the editor's text, and the export died
      // with "name 'p_values' is not defined" on a cell the student cannot
      // even see. So only names the kernel actually defines get through.
      const asked = (params.env_vars ?? []).filter((v: string) => /^[A-Za-z_]\w*$/.test(v));
      const warm = await ensureWarm(signal);
      if (warm) return toResult(warm);
      let envVars: string[] = [];
      let droppedEnv = asked;
      if (asked.length) {
        // AFTER ensureWarm: on a cold kernel every name reads as undefined,
        // and a resume that lands straight on the coding checkpoint makes
        // this the session's first nb_* call. And it fails CLOSED — letting
        // an unchecked name through is what broke `marimo export` on a cell
        // the student cannot see, while dropping one costs nothing here
        // (run_student_code already injects mo/ig/nx/np/plt/alt/pd/netviz).
        const probe = await runKernel(
          `print("DEFINED<<" + ",".join(_n for _n in ${pyList(asked)} if _n in globals()) + ">>")\n`,
          signal,
        );
        const m = /DEFINED<<(.*)>>/.exec(probe.out ?? "");
        if (!probe.failed && m) {
          const defined = new Set(m[1].split(",").filter(Boolean));
          envVars = asked.filter((v) => defined.has(v));
          droppedEnv = asked.filter((v) => !defined.has(v));
        }
      }
      const envDict = `{${envVars.map((v: string) => `${py(v)}: ${v}`).join(", ")}}`;
      await flushParkedNotes(signal);
      await ensureChapterHeader(signal);
      const edBody =
        `${name}_ed = mo.ui.code_editor(value=${py(params.scaffold)}, language="python", min_height=140)\n` +
        `${name}_run = mo.ui.run_button(label="▶ Run my code")\n` +
        `mo.vstack([mo.md(${pyMd(params.instructions)}), ${name}_ed, ${name}_run])`;
      // Every ▶ Run writes the code to assets/exercises/<name>.py. marimo
      // does NOT serialise a code_editor's value, so without this the one
      // coding checkpoint left nothing in the submitted notebook: reopen it
      // and the box is back to the scaffold, the chart is gone, and the
      // grader sees `...` blanks where the student's work was. Same cure as
      // the photo view cell — save the artifact, render it from disk.
      const savedPath = `assets/exercises/${name}.py`;
      const outBody =
        `from pathlib import Path as _P\n` +
        `_saved = _P(${py(savedPath)})\n` +
        `${name}_send = mo.ui.run_button(\n` +
        `    label="📨 Send my code to my tutor",\n` +
        `    disabled=not (${name}_run.value or _saved.exists()),\n` +
        `)\n` +
        `if ${name}_run.value:\n` +
        `    _saved.parent.mkdir(parents=True, exist_ok=True)\n` +
        `    _saved.write_text(${name}_ed.value)\n` +
        `    _res = mo.vstack([\n` +
        `        run_student_code(${name}_ed.value, ${envDict}),\n` +
        `        mo.md(\n` +
        `            "<span style='color:#6A6D75;font-size:13px'>Run it as many times "\n` +
        `            "as you like. When it does what you want, press 📨 — that is what "\n` +
        `            "hands it in and tells your tutor to look.</span>"\n` +
        `        ),\n` +
        `        ${name}_send,\n` +
        `    ])\n` +
        `elif _saved.exists():\n` +
        `    _res = mo.vstack([\n` +
        `        mo.md(\n` +
        `            "<span style='color:#6A6D75;font-size:13px'>The code I wrote and "\n` +
        `            "ran — press ▶ Run again after an edit to refresh this:</span>"\n` +
        `            "\\n\\n\`\`\`python\\n"\n` +
        `            + _saved.read_text()\n` +
        `            + "\\n\`\`\`"\n` +
        `        ),\n` +
        `        run_student_code(_saved.read_text(), ${envDict}),\n` +
        `        ${name}_send,\n` +
        `    ])\n` +
        `else:\n` +
        `    _res = mo.md("*Press ▶ Run when you're ready.*")\n` +
        `_res`;
      const sentBody =
        `from pathlib import Path as _P\n` +
        `if ${name}_send.value:\n` +
        `\n` +
        `    _P("session_artifacts").mkdir(exist_ok=True)\n` +
        `    with open("session_artifacts/student_signal.txt", "a") as _f:\n` +
        `        _f.write(${py(name + "_ed")} + "\\n")\n` +
        `    _sent = mo.md("✅ **Handed in.** Your tutor is reading your code now.")\n` +
        `else:\n` +
        // Not mo.md(""): an empty markdown node is a blank cell in the
        // keepsake, and reopening it always lands on this branch.
        // Only once the button is actually on screen — before the first
        // ▶ Run the out cell renders "Press ▶ Run when you're ready" and no
        // 📨 button at all, and pointing at it then is one more thing for a
        // nervous beginner to hunt for.
        // Phrased so it is still true months later: "press 📨 once the chart
        // looks right" is an instruction to a session that ended, in a
        // notebook whose code was handed in long ago. Naming what the button
        // does works live AND on a cold read.
        `    _sent = mo.md(\n` +
        `        "<span style='color:#6A6D75;font-size:13px'>*The 📨 button above is "\n` +
        `        "what hands this code to your tutor.*</span>"\n` +
        `        if _P(${py(savedPath)}).exists()\n` +
        `        else "<span style='color:#6A6D75;font-size:13px'>*A 📨 hand-in button "\n` +
        `        "appears here once you have pressed ▶ Run.*</span>"\n` +
        `    )\n` +
        `_sent`;
      let code =
        `import marimo._code_mode as cm\n` +
        `from pathlib import Path as _P\n` +
        `async with cm.get_context() as ctx:\n` +
        `    _names = [c.name for c in ctx.cells]\n` +
        `    if ${py(name + "_ed")} in _names:\n` +
        `        print("exercise already in the notebook — skipped duplicate insert")\n` +
        `    else:\n` +
        // Handing out the box means starting it. Any saved file here belongs
        // to someone else's session (or, once, to a solved copy committed by
        // mistake), and the out cell renders whatever it finds under "The
        // code I wrote and ran" — which would show this student the answer
        // before they typed a character, in their own voice.
        `        _P(${py(savedPath)}).unlink(missing_ok=True)\n` +
        `        _cid = ctx.create_cell(${py(edBody)}, name=${py(name + "_ed")}, hide_code=True)\n` +
        `        ctx.run_cell(_cid)\n` +
        `        _first = _cid\n` +
        `        _cid = ctx.create_cell(${py(outBody)}, name=${py(name + "_out")}, hide_code=True, after=_cid)\n` +
        `        ctx.run_cell(_cid)\n` +
        `        _cid = ctx.create_cell(${py(sentBody)}, name=${py(name + "_sent")}, hide_code=True, after=_cid)\n` +
        `        ctx.run_cell(_cid)\n`;
      code += focusCellCode("_first", "        ");
      const result = await runKernel(code, signal);
      if (!result.failed) await pinAppealToBottom(signal);
      if (!result.failed) {
        result.out =
          `Exercise inserted. The student sees your instructions, a runnable code box, a ` +
          `▶ Run button, and — once they have run it — a 📨 Send button that hands the ` +
          `code in. Ask for the code, then WAIT: their press starts your turn. Every run ` +
          `saves the code to ${savedPath}, so it is still in the notebook months later.\n` +
          (droppedEnv.length
            ? `(Ignored env_vars this notebook does not define: ${droppedEnv.join(", ")} — ` +
              `those look like your scaffold's own variables, which live inside the code ` +
              `box. Nothing to fix unless you meant a variable an earlier cell made.)\n`
            : "") +
          result.out;
      }
      return toResult(result);
    },
    ...quiet("Setting up a box for you to try…"),
  });

  // ── nb_add_template ───────────────────────────────────────────────────────
  // Premade, tested cell groups shipped in cells/*.py — the model sends only
  // a template name, so scripted checkpoint builds are instant and bug-free.
  pi.registerTool({
    name: "nb_add_template",
    label: "Insert premade cells",
    description: (() => {
      const dir = path.join(process.cwd(), "cells");
      const names = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".py"))
            .map((f) => f.slice(0, -3))
        : [];
      return (
        "Insert a PREMADE, tested group of cells into the notebook instantly — no code to " +
        "write. ALWAYS prefer this over nb_add_cell when a template exists for the " +
        "checkpoint. Available templates: " +
        (names.join(", ") || "(none found)") +
        ". REFUSES to insert if an earlier checkpoint was started but never closed with " +
        "checkpoint_done — close it first, its note cell must land before this build."
      );
    })(),
    promptSnippet: "Insert premade, tested notebook cells by template name (instant)",
    promptGuidelines: [
      "For checkpoint builds use nb_add_template with the template named in lesson.yaml; nb_add_cell is only for detours and improvised cells.",
      "Always pass checkpoint — the id of the checkpoint this build is for, from the script.",
    ],
    parameters: Type.Object({
      status: STATUS_PARAM,
      template: Type.String({ description: "Template name, e.g. 'cp2_ripple'." }),
      checkpoint: Type.String({
        description:
          "Checkpoint id from the script this build is for, e.g. 'cp2_distance'. Required — " +
          "lets the tool catch a checkpoint you started but never closed with checkpoint_done.",
      }),
    }),
    async execute(_id, params, signal) {
      const cpId = String(params.checkpoint ?? "").trim();
      if (!cpId) {
        return toResult({
          out: `NOT INSERTED — pass checkpoint: the id of the checkpoint this build is for.`,
          failed: false,
        });
      }
      // Keyed by TOOL as well as checkpoint: a shared budget meant the
      // exercise tool's refusals spent the template tool's, and a genuine
      // first-try violation was then waved through.
      if (paceUnasked.has(cpId)) {
        paceUnasked.delete(cpId);
        return toResult({
          out:
            `NOT INSERTED — the "where to next?" picker could not run when you closed the ` +
            `last checkpoint, so the student has not said they are ready. Ask them in ` +
            `plain text, END YOUR TURN, and wait. When they say yes, call this again — it ` +
            `will go in.`,
          failed: false,
        });
      }
      const tplKey = `template:${cpId}`;
      if (
        pendingCheckpoint &&
        isAheadOf(cpId, pendingCheckpoint) &&
        (buildOrderWarned.get(tplKey) ?? 0) < 2
      ) {
        buildOrderWarned.set(tplKey, (buildOrderWarned.get(tplKey) ?? 0) + 1);
        return toResult({
          out:
            `NOT INSERTED — '${cpId}' comes after '${pendingCheckpoint}', which is still ` +
            `open. Call checkpoint_done for '${pendingCheckpoint}' first (its note cell ` +
            `must land before this build), then retry this insert.`,
          failed: false,
        });
      }
      const file = path.join(process.cwd(), "cells", `${params.template}.py`);
      if (!fs.existsSync(file)) {
        return toResult({ out: `No template named '${params.template}'.`, failed: true });
      }
      const src = fs.readFileSync(file, "utf-8");
      // Factual description the tutor can safely echo — prevents the model
      // from misdescribing the artifact (e.g. calling a 4-person network
      // "5-person", seen in production).
      const describe = /^# describe: (.+)$/m.exec(src)?.[1] ?? "";
      const parts = src.split(/^# --- cell: (\w+) ---[ \t]*$/m);
      const cells: Array<{ name: string; code: string }> = [];
      for (let i = 1; i < parts.length; i += 2) {
        cells.push({ name: parts[i], code: parts[i + 1].trim() });
      }
      if (cells.length === 0) {
        return toResult({ out: `Template '${params.template}' has no cells.`, failed: true });
      }
      const warm = await ensureWarm(signal);
      if (warm) return toResult(warm);
      await flushParkedNotes(signal);
      await ensureChapterHeader(signal);
      let code =
        `import marimo._code_mode as cm\n` +
        `async with cm.get_context() as ctx:\n` +
        `    _names = [c.name for c in ctx.cells]\n` +
        `    if ${py(cells[0].name)} in _names:\n` +
        `        print("template already in the notebook — skipped duplicate insert")\n` +
        `    else:\n` +
        `        _cid = ctx.create_cell(${py(cells[0].code)}, name=${py(cells[0].name)}, hide_code=True)\n` +
        `        ctx.run_cell(_cid)\n` +
        `        _first = _cid\n`;
      for (const c of cells.slice(1)) {
        code +=
          `        _cid = ctx.create_cell(${py(c.code)}, name=${py(c.name)}, hide_code=True, after=_cid)\n` +
          `        ctx.run_cell(_cid)\n`;
      }
      code += focusCellCode("_first", "        ");
      const result = await runKernel(code, signal);
      if (!result.failed) await pinAppealToBottom(signal);
      if (!result.failed && describe) {
        // Upload widgets are named per template (cp4_photo, cp2_paperwork_photo,
        // cp5_ring_paperwork_photo…). The tutor cannot know which one it just
        // inserted, and nb_view_image with the wrong name blows up in the
        // kernel — so the insert result names it.
        const uploads = cells
          .filter((c) => /\bmo\.ui\.file\s*\(/.test(c.code))
          .map((c) => c.name);
        const uploadLine = uploads.length
          ? `ASK FOR THE PHOTO with the question it belongs to, in one line, and then ` +
            `WAIT — never ask whether it is up. Their 📨 Send to my tutor press starts ` +
            `your turn; then call nb_view_image(widget="${uploads[0]}", …).\n` +
            // "ASK FOR THE PHOTO NOW" is what this said, and a script that puts the
            // drop area up a turn BEFORE the question could not win against it: the
            // tutor announced the pen-and-paper step, built the cell and asked the
            // question in one breath, spending the one deliberate pause the
            // checkpoint has — the beat where "this one is a drawing" is allowed to
            // land before the hard part arrives. If your script gives this build its
            // own turn, keep that turn.
            `If your CHAPTER SCRIPT gives this build a turn of its own before the ` +
            `question, KEEP IT: say that beat, build this, and stop. The photo ask ` +
            `goes with the question, on the next turn.\n` +
            `Say NOTHING about typing instead, and nothing about a camera, unless they ` +
            `have mentioned one at THIS checkpoint. A camera that was out an hour ago ` +
            `is not a fact about now: a live run opened here with "your camera was out ` +
            `before — so just tell me which two dots", to a student who had a working ` +
            `camera and had said nothing. The drawing is the point of this checkpoint.\n`
          : "";
        result.out =
          `Inserted. The student now sees: ${describe}\n` +
          `(Describe it to the student ONLY from this line — never guess counts or details.)\n` +
          uploadLine +
          result.out;
      }
      return toResult(result);
    },
    ...quiet("Putting something on your whiteboard…"),
  });

  // ── nb_fresh_start ────────────────────────────────────────────────────────
  // Conversational reset: archives the previous notebook + session log, then
  // deletes every tutor-made cell from the LIVE notebook (template cells are
  // unnamed and survive). Called when the student chooses "start fresh".
  pi.registerTool({
    name: "nb_fresh_start",
    label: "Fresh start",
    description:
      "Reset the session at the student's request: archives the previous notebook and " +
      "session log to session_artifacts/, then clears all tutor-made cells from the live " +
      "notebook. Call ONLY after the student chose to start fresh (ask_user_question).",
    promptSnippet: "Archive the previous session and clear the notebook (student chose fresh start)",
    parameters: Type.Object({
      status: STATUS_PARAM,
    }),
    async execute(_id, params, signal, _onUpdate, ctx: any) {
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..*/, "")
        .replace("T", "-");
      const dir = path.join(process.cwd(), "session_artifacts");
      try {
        fs.mkdirSync(dir, { recursive: true });
        const nb = path.join(process.cwd(), "notebook.py");
        if (fs.existsSync(nb)) fs.copyFileSync(nb, path.join(dir, `notebook-${stamp}.py`));
        const log = path.join(dir, "session_log.jsonl");
        if (fs.existsSync(log)) fs.renameSync(log, path.join(dir, `session_log-${stamp}.jsonl`));
        // The summary belongs to the run that produced it. Left in place it
        // outlives its log and describes checkpoints the new session never did.
        const sum = path.join(dir, "session_summary.md");
        if (fs.existsSync(sum)) fs.renameSync(sum, path.join(dir, `session_summary-${stamp}.md`));
        // Delete, don't rewrite: the saved chapter belongs to the log that
        // was just archived, and anything left in that file would be read
        // back as progress this session never made.
        fs.rmSync(chapterStatePath(), { force: true });
        // The student's saved exercise code goes with it. Left behind, the
        // next run of the coding checkpoint opens showing the PREVIOUS
        // student's code under "The code I wrote and ran" — someone else's
        // work, in this student's voice.
        // Both directories, for the same reason: they are the previous
        // student's work, and the photo guard reads assets/uploads as
        // evidence that a page arrived — stale files there disarm it before
        // the new student has taken a photo.
        for (const [rel, label] of [
          ["exercises", `exercises-${stamp}`],
          ["uploads", `uploads-${stamp}`],
        ] as const) {
          const src = path.join(process.cwd(), "assets", rel);
          if (!fs.existsSync(src)) continue;
          fs.renameSync(src, path.join(dir, label));
          // The archived notebook still points at assets/uploads/<w>_view.jpg,
          // which no longer exists — so repoint the archived COPY at its own
          // stamped directory. A shared session_artifacts/assets/uploads/ was
          // tried first and was worse: the next reset overwrote it, and
          // session 1's keepsake then rendered session 2's photograph as that
          // student's own hand-worked page.
          try {
            const archived = path.join(dir, `notebook-${stamp}.py`);
            if (fs.existsSync(archived)) {
              fs.writeFileSync(
                archived,
                fs.readFileSync(archived, "utf-8").split(`assets/${rel}/`).join(`${label}/`),
              );
            }
          } catch {
            // the archive is best-effort; the live notebook is what matters
          }
        }
      } catch {
        // archiving is best-effort; clearing the notebook is what matters
      }
      // Back to chapter 1 with a fresh script in context. triggerTurn so the
      // tutor starts cp0 from the script once it arrives — without this, the
      // model improvises checkpoints from memory (seen in production).
      try {
        const chapters = loadChapters();
        if (chapters.length > 0) {
          writeChapterState(chapters[0].id);
          // Re-arm the open-checkpoint guard on cp0 — a fresh start rewinds
          // the script, so a stale pending id would refuse cp1's build.
          pendingCheckpoint = chapters[0].checkpoints[0] ?? null;
          slotDriftWarned.clear();
          detourTextOnlyWarned.clear();
          // A fresh start rewinds the record too: anything picked before it
          // (the resume dialog, a previous run's answers) must not surface
          // in the new session's first checkpoint.
          pickedAnswers.length = 0;
          pickedMark = 0;
          awaitingResumeChoice = false;
          cellReviewWarned.clear();
          chapterGateWarned.clear();
          try {
            // Archived, not deleted — its file-level twin promises "nothing is
            // ever deleted", and the rendered note text is nowhere else.
            if (fs.existsSync(parkedDir())) {
              fs.renameSync(parkedDir(), path.join(dir, `parked_notes-${stamp}`));
            }
          } catch {
            // a parked note belongs to the session just archived
          }
          buildOrderWarned.clear();
          lateCloseWarned.clear();
          paceUnasked.clear();
          resumeGaps.clear();
          viewedPhotos.clear();
          // Same rewind for the transcript mark: without it, whatever the
          // student typed before choosing "start fresh" is filed as the new
          // cp0's own words.
          //
          // The detour marks go with it, in this order and for the same
          // reason checkpoint_done clears them in the same block that moves
          // the mark: detourSpans holds INDICES into the window studentSaidSince
          // is about to discard. Left behind, they point at whatever the new
          // session's first checkpoint puts in those slots — the student's own
          // answers, dropped out of their first note cell. checkpoint_done has
          // cleared these since the spans were introduced; this path never did,
          // and it is the same bug shape as the three that shipped: a read of
          // mutable state across a boundary, on a path no boot test reaches.
          detourAsked.clear();
          mechanicsAsked.clear();
          stuckNudged = false;
          detourSpans.length = 0;
          // A fresh start is turn one of a new session. Carrying the abandoned
          // run's count forward can trip the no-hints late-close gate on the
          // very first checkpoint, and puts a number on its row that belongs
          // to a lesson the student chose to throw away. -1 for the same
          // reason as the other two resets: turn_end has not run yet.
          turnsInCheckpoint = -1;
          studentSaidSince(ctx, true);
          pi.sendMessage(
            {
              customType: "chapter-script",
              content: chapterScriptMessage(chapters[0], 1, chapters.length),
              display: false,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        }
      } catch {
        // best-effort
      }
      let code =
        `import marimo._code_mode as cm\n` +
        `async with cm.get_context() as ctx:\n` +
        `    for _c in list(ctx.cells):\n` +
        `        if _c.name and _c.name != "_":\n` +
        `            ctx.delete_cell(_c.id)\n` +
        // Say out loud what survived. A wipe that silently leaves a cell
        // behind is how a "clean slate" notebook opens on the middle of the
        // module — the tutor must know before it starts building.
        `    _left = [c.name for c in ctx.cells if c.name and c.name != "_"]\n` +
        `    if _left:\n` +
        `        print("STILL THERE (delete failed):", ", ".join(_left))\n`;
      // Same kernel call as the wipe so the chapter header lands first,
      // before any cp0/cp1 build cells.
      try {
        const chapters = loadChapters();
        if (chapters.length > 0) {
          const h = `${chapters[0].id}_header`;
          const heading = `## Chapter 1 of ${chapters.length} — ${chapters[0].title}`;
          const op = chapterOpening(chapters[0]);
          const body = `mo.md(${pyMd(op ? `${heading}\n\n${op}` : heading)})`;
          code +=
            `    _cid = ctx.create_cell(${py(body)}, name=${py(h)}, hide_code=True)\n` +
            `    ctx.run_cell(_cid)\n`;
        }
      } catch {
        // header is cosmetic
      }
      const result = await runKernel(code, signal);
      if (!result.failed) await pinAppealToBottom(signal);
      if (!result.failed) {
        result.out =
          `Fresh start complete. The Chapter 1 script arrives next — END YOUR TURN NOW ` +
          `(at most one short welcome line first). Treat this as a brand-new session: ` +
          `begin at cp0_welcome FROM THE INCOMING SCRIPT; do not improvise checkpoints ` +
          `from memory.\n` + result.out;
      }
      return toResult(result);
    },
    ...quiet("Clearing the whiteboard for a fresh start…"),
  });

  // ── nb_edit_cell ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "nb_edit_cell",
    label: "Edit notebook cell",
    description:
      "Replace the body of an existing notebook cell (by the name you gave it in nb_add_cell) and re-run it. " +
      "Submit the FULL new body. " + MARIMO_CELL_RULES,
    promptSnippet: "Edit and re-run a cell in the live marimo notebook",
    parameters: Type.Object({
      status: STATUS_PARAM,
      name: Type.String({ description: "The cell's name." }),
      code: Type.String({ description: "The full replacement cell body (Python)." }),
    }),
    async execute(_id, params, signal) {
      // A cell body runs in the same kernel nb_run does, and it is hidden from
      // the student by default (hide_code), so it is not the safer door.
      const refusedCode = kernelGuard(params.code);
      if (refusedCode) return toResult({ out: refusedCode, failed: false });
      const warm = await ensureWarm(signal);
      if (warm) return toResult(warm);
      // The same door as nb_add_cell, and the likelier one for this: the
      // souvenir bounce asks the tutor to rewrite a cell the extension has
      // already quoted, and a rewrite that re-types the quote from memory is
      // how the student's punctuation got tidied in the first place — and how
      // two thirds of their sentence went missing in an m02 run.
      const edited = stripModelQuoteLines(params.code);
      const code =
        `import marimo._code_mode as cm\n` +
        `async with cm.get_context() as ctx:\n` +
        `    _names = [c.name for c in ctx.cells]\n` +
        `    if ${py(params.name)} not in _names:\n` +
        `        print("EDIT FAILED: no cell named", ${py(params.name)})\n` +
        `        print("Existing cells:", [n for n in _names if n and n != "_"])\n` +
        `    else:\n` +
        `        ctx.edit_cell(${py(params.name)}, ${py(stripRedundantImports(edited.code))})\n` +
        `        ctx.run_cell(${py(params.name)})\n`;
      const editResult = await runKernel(code, signal);
      if (!editResult.failed && edited.removed.length) {
        editResult.out +=
          `\nNOTE — a "You asked" line was left out: that line is not yours to write, ` +
          `log_detour adds it from the student's own message. Yours was ` +
          `${edited.removed.map((q) => `“${q}”`).join(", ")}.`;
      }
      return toResult(editResult);
    },
    ...quiet("Tidying something on your whiteboard…"),
  });

  // ── nb_delete_cell ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "nb_delete_cell",
    label: "Delete notebook cells",
    description:
      "Delete notebook cells by name. Deleting removes the variables those cells define. " +
      "Never delete a cell holding a student's answer.",
    promptSnippet: "Delete cells from the live marimo notebook",
    parameters: Type.Object({
      status: STATUS_PARAM,
      names: Type.Array(Type.String(), { description: "Cell names to delete." }),
    }),
    async execute(_id, params, signal) {
      // "Never delete a cell holding a student's answer" lived only in the
      // description above, and a model whose cell came out wrong reaches for
      // delete-and-rebuild by reflex. The cells that reflex reaches for are
      // the ones that cannot be rebuilt: a note cell quotes words that, after
      // compaction, are no longer anywhere in the model's context; a _view
      // cell is the only copy of the photograph inside the notebook; an _ed
      // cell is the code the student wrote. All three are the graded artifact.
      // _preview holds no student work, which is how it got left off the list
      // — but it is where the 📨 button is DEFINED, and _sent reads it, so
      // deleting it leaves a protected cell referencing an unbound name and
      // the student with no way to hand the photo in. Protect it too: the
      // partial path below deletes what it is allowed to and reports success,
      // so "only the unprotected one went" is not a safe failure.
      const names: string[] = Array.isArray(params.names) ? params.names.map(String) : [];
      const PROTECTED = /(_note|_view|_photo|_preview|_ed|_out|_sent|_header)$|^session_record$/;
      const refused = names.filter((n) => PROTECTED.test(n));
      const allowed = names.filter((n) => !PROTECTED.test(n));
      if (refused.length && !allowed.length) {
        return toResult({
          failed: false,
          out:
            `NOT DELETED — ${refused.map((n) => `"${n}"`).join(", ")} ${refused.length > 1 ? "hold" : "holds"} ` +
            `the student's own work (their answer, their photo, or their code) and ` +
            `${refused.length > 1 ? "are" : "is"} part of what gets graded. Nothing was ` +
            `deleted. If the content is wrong, fix it with nb_edit_cell — and if it is a ` +
            `note cell, leave it alone: checkpoint_done wrote it from the transcript.`,
        });
      }
      const code =
        `import marimo._code_mode as cm\n` +
        `async with cm.get_context() as ctx:\n` +
        `    _names = [c.name for c in ctx.cells]\n` +
        `    for _n in ${pyList(allowed)}:\n` +
        `        if _n in _names:\n` +
        `            ctx.delete_cell(_n)\n` +
        `        else:\n` +
        `            print("skip: no cell named", _n)\n`;
      const r = await runKernel(code, signal);
      if (refused.length && !r.failed) {
        r.out +=
          `\nKEPT: ${refused.map((n) => `"${n}"`).join(", ")} — the student's own work is ` +
          `never deleted. Use nb_edit_cell if one of them needs a correction.`;
      }
      return toResult(r);
    },
    ...quiet("Clearing something off the whiteboard…"),
  });

  // ── nb_read ───────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "nb_read",
    label: "Read notebook values",
    description:
      "Evaluate expressions against the live notebook and return their values — the way to read " +
      "student widget answers, e.g. ['cp6_p.value', 'cp4_photo.value[0].name']. Returns one line per expression.",
    promptSnippet: "Read values/widget answers from the live marimo notebook",
    parameters: Type.Object({
      status: STATUS_PARAM,
      expressions: Type.Array(Type.String(), { description: "Python expressions to evaluate." }),
    }),
    async execute(_id, params, signal) {
      // This tool wraps every expression in `eval`, so it reaches the same
      // place nb_run does — in one call rather than four. Guarding nb_run
      // alone would have moved the hole one tool to the left.
      const refused = kernelGuard((params.expressions ?? []).join("\n"));
      if (refused) return toResult({ out: refused, failed: false });
      const warm = await ensureWarm(signal);
      if (warm) return toResult(warm);
      const code =
        `for _e in ${pyList(params.expressions)}:\n` +
        `    try:\n` +
        `        print(_e, "=", repr(eval(_e)))\n` +
        `    except Exception as _ex:\n` +
        `        print(_e, "!", type(_ex).__name__, str(_ex))\n`;
      return toResult(await runKernel(code, signal));
    },
    ...quiet("Having a look at your notebook…"),
  });

  // ── nb_view_image ─────────────────────────────────────────────────────────
  // The tutor model is text-only; this tool is its eyes. Kernel side: pull the
  // upload bytes, save the original (graded artifact), EXIF-rotate + downscale
  // (phone photos are huge and often sideways), show the photo back in the
  // notebook. Extension side: send the small JPEG to a vision model and hand
  // the tutor a factual description to judge.
  pi.registerTool({
    name: "nb_view_image",
    label: "View student image",
    description:
      "Look at a student-uploaded image — you are text-only, so this is your ONLY way to " +
      "see one (never nb_read image bytes). Give the upload widget name (e.g. 'cp4_photo') " +
      "or a file path, what the task was, and the question you need answered. It saves the " +
      "original to assets/uploads/ so it travels with the notebook, shows the photo in the " +
      "notebook for the student, and " +
      "returns a factual description from a vision model. The description is a machine's " +
      "reading, not ground truth — confirm the key detail with the student before building " +
      "on it. If it reports no vision is available, follow its advice instead.",
    promptSnippet: "See a student-uploaded image through a vision model (the tutor is text-only)",
    parameters: Type.Object({
      status: STATUS_PARAM,
      widget: Type.Optional(
        Type.String({ description: "Upload widget name, e.g. 'cp4_photo'." }),
      ),
      file: Type.Optional(Type.String({ description: "Or: path to an image file." })),
      task: Type.String({
        description:
          "What the student was asked to draw/do, in 1-2 sentences copied from the " +
          "checkpoint — the vision model needs this to know what to look for.",
      }),
      question: Type.String({
        description: "What you need to know, e.g. 'Which two dots does the extra line connect?'",
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx: any) {
      const widget = String(params.widget ?? "").trim();
      const file = String(params.file ?? "").trim();
      if (!widget && !file) {
        return toResult({ out: "Pass widget (e.g. 'cp4_photo') or file.", failed: true });
      }
      if (widget && !/^[A-Za-z_]\w*$/.test(widget)) {
        return toResult({ out: `'${widget}' is not a widget name.`, failed: true });
      }
      const warm = await ensureWarm(signal);
      if (warm) return toResult(warm);

      const base = sanitize(widget || path.basename(file).replace(/\.[^.]*$/, ""));
      // assets/, not session_artifacts/: the photo is the student's own figure
      // in the keepsake notebook, so it has to travel WITH the module. The
      // archive folder is gitignored evidence and may not be carried along —
      // a notebook pointing there throws FileNotFoundError on reopen.
      const viewRel = `assets/uploads/${base}_view.jpg`;
      const viewCell = `${base}_view`;
      // Self-contained display cell: the student sees exactly what the vision
      // model was sent (survives notebook reloads; deleted by fresh_start).
      // The caption is not decoration — an uncaptioned phone photo in the
      // middle of a lecture note is a mystery to anyone reading it cold,
      // including the student in three months. `task` already holds the ask
      // in the tutor's own words, so the cell states what the page shows.
      const taskLine = String(params.task ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/["']/g, "");
      const caption =
        `<span style='color:#6A6D75;font-size:13px'>📷 My own work on paper` +
        (taskLine ? ` — the task: ${taskLine}` : "") +
        `</span>`;
      const cellBody =
        `from pathlib import Path as _P\n` +
        `mo.vstack([\n` +
        `    mo.image(_P(${py(viewRel)}).read_bytes(), width=420),\n` +
        `    mo.md(${pyMd(caption)}),\n` +
        `])`;
      const source = widget
        ? `_files = list(${widget}.value or [])\n` +
          `if not _files:\n` +
          `    print("NO_IMAGE: nothing uploaded yet")\n` +
          `else:\n` +
          `    _name, _raw = _files[0].name, _files[0].contents\n`
        : `_p = _P(${py(file)})\n` +
          `if not _p.exists():\n` +
          `    print("NO_IMAGE: no such file:", ${py(file)})\n` +
          `else:\n` +
          `    _name, _raw = _p.name, _p.read_bytes()\n`;
      const code =
        `import base64 as _b64, io as _io\n` +
        `from pathlib import Path as _P\n` +
        `_P("assets/uploads").mkdir(parents=True, exist_ok=True)\n` +
        `_raw = None\n` +
        source +
        `if _raw is not None:\n` +
        `    from PIL import Image as _Image, ImageOps as _ImageOps\n` +
        `    _ext = _P(_name).suffix.lower() or ".png"\n` +
        `    (_P("assets/uploads") / (${py(base + "_upload")} + _ext)).write_bytes(_raw)\n` +
        `    _img = _Image.open(_io.BytesIO(_raw))\n` +
        `    _img = (_ImageOps.exif_transpose(_img) or _img).convert("RGB")\n` +
        `    _img.thumbnail((1280, 1280))\n` +
        `    _out = _io.BytesIO()\n` +
        `    _img.save(_out, "JPEG", quality=80)\n` +
        `    _P(${py(viewRel)}).write_bytes(_out.getvalue())\n` +
        `    print("FILE:", _name, "->", str(_img.size[0]) + "x" + str(_img.size[1]))\n` +
        `    import marimo._code_mode as cm\n` +
        `    async with cm.get_context() as ctx:\n` +
        `        _names = [c.name for c in ctx.cells]\n` +
        // The upload box's live preview reads mo.ui.file.value, which marimo
        // does NOT serialise — reopen the keepsake and the student's own
        // hand-worked page is gone, replaced by "your photo appears here".
        // So the saved file gets its own cell after all. The two do not
        // disagree after a redo: this cell is EDITED on every nb_view_image
        // call, so the preview shows what is in the box and this shows the
        // page the tutor actually read and graded.
        `        if ${py(viewCell)} in _names:\n` +
        `            ctx.edit_cell(${py(viewCell)}, ${py(cellBody)})\n` +
        `            ctx.run_cell(${py(viewCell)})\n` +
        focusCellCode(`ctx.cells[${py(viewCell)}].id`, "            ") +
        `        else:\n` +
        `            ctx.create_cell(${py(cellBody)}, name=${py(viewCell)}, hide_code=True)\n` +
        `            ctx.run_cell(${py(viewCell)})\n` +
        focusCellCode(`ctx.cells[${py(viewCell)}].id`, "            ") +
        `    print("B64:" + _b64.b64encode(_out.getvalue()).decode())\n`;
      const result = await runKernel(code, signal);
      if (result.failed) return toResult(result);
      await pinAppealToBottom(signal);
      if (result.out.includes("NO_IMAGE")) {
        return toResult({
          out:
            result.out +
            `\nThe drop box is EMPTY — they pressed Send before the photo attached, so ` +
            `they are waiting on you and do not know why. Say so warmly in one line ` +
            `("the box came through empty — drop the photo in and press send again"), ` +
            `then end your turn. Never answer this one with silence: they just pressed ` +
            `a button and a quiet screen reads as broken.`,
          failed: false,
        });
      }
      const b64 = /^B64:([A-Za-z0-9+/=]+)\s*$/m.exec(result.out)?.[1];
      const fileLine = /^FILE:.*$/m.exec(result.out)?.[0] ?? "";
      // A photo actually reached the tutor for this widget — the one piece
      // of evidence checkpoint_done can use to tell "asked for the page" from
      // "never mentioned it".
      if (widget) viewedPhotos.add(widget);
      if (!b64) {
        return toResult({
          out:
            `Could not extract the image. Ask the student to describe their drawing ` +
            `in words instead and judge that.\n${result.out.slice(0, 500)}`,
          failed: true,
        });
      }
      const vision = await describeImage(
        ctx,
        b64,
        String(params.task ?? "").trim(),
        String(params.question ?? "").trim(),
      );
      if (vision.failed) return toResult({ out: `${fileLine}\n${vision.text}`, failed: false });
      return toResult({
        out:
          `${fileLine} — saved, and the student now sees their photo in the notebook.\n` +
          `VISION REPORT from ${vision.model} (a machine description — judge it against ` +
          `the checkpoint yourself; respond to a concrete detail from it, don't echo it ` +
          `wholesale):\n${vision.text}`,
        failed: false,
      });
    },
    ...quiet("Looking at your photo…"),
  });

  // ── nb_notebook_url ───────────────────────────────────────────────────────
  // "Where is the notebook?" had no answer, and what the tutor did with the
  // gap was invent one: a live run told the student to run `marimo edit
  // notebook.py` in a new terminal, and doubled down when pressed. That starts
  // a SECOND server — measured, on :2719, while the toolkit's own held :2718 —
  // so the student ends up watching a page no nb_* call ever writes to, with
  // two kernels open on one file. Three of three submitted sessions opened
  // with a student who could not find their notebook.
  //
  // The address is a fact this process has had all along. A tool is the shape
  // that makes it reachable at the moment the question is asked.
  pi.registerTool({
    name: "nb_notebook_url",
    label: "Where the notebook is",
    description:
      "The address of the student's notebook page, and a reopen. Use it the moment they say " +
      "they cannot see the notebook, or ask where it is, or what to open. " +
      "NEVER tell a student to start the notebook themselves — no `marimo edit`, no second " +
      "terminal: this toolkit runs the server, and a second one is a corrupted session whose " +
      "page nothing you build ever reaches.",
    promptSnippet: "Give the student the notebook's address (and reopen the page)",
    parameters: Type.Object({ status: STATUS_PARAM }),
    async execute() {
      const r = await marimoUrl();
      if (!r.url) {
        return toResult({
          out:
            `The notebook server is not up (${r.error ?? "no address yet"}). Tell them in one ` +
            `warm sentence that the whiteboard needs a moment, and keep teaching here. Do NOT ` +
            `ask them to start it themselves.`,
          failed: false,
        });
      }
      const url = `${r.url}/?view-as=present`;
      // Whatever they typed to get here was about finding the notebook, not
      // about the lesson — so it must not end up quoted in the next
      // checkpoint's note as their worked answer. The FIRST of mechanicsAsked's
      // two facts: this tool ran, and this is the message that made it run.
      try {
        const said = studentSaidSince(lastCtx, false);
        if (said.length) mechanicsAsked.add(normMsg(said[said.length - 1]));
      } catch {
        /* narrowing the note is never worth a failed tool call */
      }
      // Puts the page back if the tab was closed — rate-limited inside.
      reopenPage();
      return toResult({
        out:
          `The notebook is at ${url} — say that address to them, in one sentence, exactly as ` +
          `it is written. It is already running; there is nothing for them to start or install.`,
        failed: false,
      });
    },
    ...quiet("Finding your notebook…"),
  });

  // ── nb_run ────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "nb_run",
    label: "Run Python in notebook kernel",
    description:
      "Escape hatch: run Python in the notebook's scratchpad (variables visible, new " +
      "top-level bindings discarded). Use for: appending to the session log, saving uploaded " +
      "photo bytes to session_artifacts/, timestamps (datetime), quick computations. " +
      "NOT a shell: code that reaches the operating system (subprocess, socket, os.environ, " +
      "eval/exec of assembled strings) is refused before it runs — you have no shell here, " +
      "deliberately. For the notebook's address use nb_notebook_url. " +
      "NOT for creating/editing cells — use nb_add_cell/nb_edit_cell for that. " +
      "AND NEVER TO PRE-SOLVE THE OPEN CHECKPOINT: a live run worked out a checkpoint's " +
      "own arithmetic here and said the answer in the next breath, so the student never " +
      "answered the question they were asked. If a number is what the checkpoint is " +
      "asking for, you may not be the one who says it — ask, end your turn, wait.",
    promptSnippet: "Run scratchpad Python in the notebook kernel (logging, file saves, checks)",
    parameters: Type.Object({
      status: STATUS_PARAM,
      code: Type.String({ description: "Python code to run in the scratchpad." }),
    }),
    async execute(_id, params, signal) {
      // The bash strip is only as strong as the tools left standing, and this
      // is the one that was standing. See kernelGuard.
      const refused = kernelGuard(params.code);
      if (refused) return toResult({ out: refused, failed: false });
      // The graded-record check used to live BELOW this line: the code ran,
      // the row was written, and the tutor was then told not to write rows by
      // hand. 66 of the 87 nb_run calls in this machine's history were exactly
      // that. It is part of kernelGuard now, so it refuses instead of
      // complaining afterwards.
      return toResult(await runKernel(params.code, signal));
    },
    ...quiet("One moment…"),
  });

  // ── waiting-time trivia ───────────────────────────────────────────────────
  // The student stares at "Working…" during model calls, notebook round-trips
  // and chapter handoffs. Replace it with a rotating network-science tidbit —
  // dead air becomes a tiny extra lesson.
  //
  // HARD RULE — these lines are shown at random, so any one of them can land
  // while any checkpoint is open, in ANY module that installs this toolkit.
  // One list serves them all, so it must be clear of every module's answers.
  //
  // Small-world (m02): no hop count for Milgram or Facebook (cp1), no "put
  // the cable across the ring" (cp4), no friendship/triangle counts (cp3,
  // cp5), no "clustering stays while distance collapses" mechanism (cp6), and
  // no "high clustering AND short paths" definition (cp5_tension, cp7).
  //
  // Königsberg (m01): no degree counts and no "two ends per edge, so the
  // total is even" (cp2_degree), nothing about distances or sizes being
  // irrelevant (cp2_abstraction), no odd-node rule and no 0-or-2 condition
  // (cp3_parity, cp3_verdict), nothing about what the 1944 raid did to the
  // answer (cp3_bombing), no connectivity clause (cp4_disconnected,
  // cp6_redteam), and no indptr rule (cp5_csr). This module is the reason
  // three of the lines below were rewritten: "geometry with the distances
  // thrown away" is cp2_abstraction's gold answer in six words, "the puzzle's
  // answer changed with them" is cp3_bombing's, and the handshake fact is the
  // hint cp2_degree's teaching moment turns on. Context and history are fine;
  // answers are not.
  //
  // And a line that says "this module" must be true in every module it can
  // appear in. One claimed Karinthy asked the question behind "this whole
  // module" — true next door, and simply false to a student reading about
  // Euler.
  //
  // A NAME is an answer too. cp3_global_clustering asks the student what to
  // call a trio with all three friendships present, and a tip reading "that's
  // where triangles come from" handed the word over while the question was
  // open — it cleared the count rule above and still lost the checkpoint. If
  // a checkpoint asks "what would you call…", the word it wants is banned
  // here as firmly as any number.
  // Scoped by module. One flat list served every module, and an m01 student
  // counting bridges was told "that 1998 Nature paper is three pages long" —
  // about a paper nothing in their session had mentioned — along with karate
  // clubs, Milgram's letters and C. elegans. None of it leaked an answer; all
  // of it was orphaned, and half of it primes the NEXT module's subject in a
  // course whose own rule is to point backward and never forward. Two live
  // probes filed it independently.
  //
  // GENERAL is what survives anywhere: it may not depend on anything a
  // particular module introduced, and it may not use "that"/"his"/"the famous
  // result" to point at something the student has not met.
  const TRIVIA_GENERAL = [
    "Leonhard Euler wrote roughly 850 papers — and kept publishing after going blind.",
    "Cayley counted trees in 1889 for the chemists, who wanted to know how many molecules were possible.",
    "The word 'graph' for a network comes from Sylvester, 1878 — borrowed from chemistry diagrams.",
    "The four-colour theorem, 1976, was the first famous proof a computer helped finish. It's about a graph.",
    "Graph theory waited two centuries for its first textbook: Dénes König's, in 1936.",
    "Graph isomorphism — are these two drawings the same network? — still has no known fast algorithm.",
    "Thirty people allow more possible friendship patterns than the universe has atoms.",
    "A fruit fly's whole brain was mapped in 2024: about 140,000 neurons, 50 million connections.",
    "Complete wiring maps exist for a worm, a fly, and one cubic millimetre of mouse cortex. That's the list.",
    "Neuroscience calls the brain's wiring diagram a connectome — network science, with wetware.",
    // — the karate club —
    "Zachary's karate club split in two in 1977 — and became network science's favorite dataset.",
    "Zachary sat and watched that club argue for two years. The dataset is field notes.",
    "Zachary's own method called the split almost perfectly: one member ended up on the wrong side.",
    "Find the karate-club split at a network conference and you can win an actual trophy.",
    // — Erdős, Bacon, and counting your distance to people —
    "Erdős number: your coauthor distance to Paul Erdős, who has number 0 and 500-odd coauthors.",
    "About 11,000 people have Erdős number 2, and most of them never met him.",
    "Paul Erdős owned almost nothing and lived out of a suitcase, in other mathematicians' spare rooms.",
    "In Erdős's private vocabulary, a mathematician who stopped working had 'died'; one who died had 'left'.",
    "Erdős and Rényi's 1959 random graph — throw every link in at random — is still the field's null model.",
    "Erdős number + Bacon number = the Erdős–Bacon number. Natalie Portman has one.",
    "Kevin Bacon isn't Hollywood's center — hundreds of actors are better connected.",
    "Three college students invented the Kevin Bacon game in 1994, after watching Footloose.",
    "The Oracle of Bacon has been computing actor distances on the web since 1996.",
    // — how sociologists got here —
    "Granovetter, 1973: people find jobs through acquaintances, not close friends. Weak ties win.",
    "Granovetter's weak-ties paper was rejected in 1969. It is now one of the most cited in all of sociology.",
    "Simmel, 1908: add one person to a pair and you get politics — alliances, mediators, majorities.",
    "Moreno drew the first social network by hand in 1933; the New York Times covered it.",
    "Moreno's first sociograms were drawn to explain a wave of runaways at a girls' reform school.",
    "Network scientists call a network's own map of itself a 'sociogram' — Moreno's word, still in use.",
    "Bavelas wired lab groups as a circle, a chain or a star in the 1940s, then timed them solving puzzles.",
    "Freeman formalised betweenness in 1977: how often you sit on other people's routes.",
    "Anatol Rapoport was modelling how rumours travel along acquaintance chains in the 1950s.",
    "Your friends have more friends than you do, on average — the friendship paradox.",
    "Dunbar's number: human brains manage roughly 150 stable relationships.",
    "You personally know about 0.000002% of the people alive today.",
    // — networks that run the modern world —
    "The web, citation networks, and Hollywood all share one shape: a few superstar hubs.",
    "Hub networks shrug off random failures — but fall fast to targeted attacks on hubs.",
    "Barabási and Albert, 1999: hubs come from growth plus the rich getting richer.",
    "The rich-get-richer idea is older than the web: Yule in 1925, Simon in 1955, Price in 1965.",
    "Merton named it the Matthew effect in 1968 — credit flows to whoever already has some.",
    "PageRank is network centrality: where an endlessly clicking web surfer ends up.",
    "PageRank's imaginary surfer gets bored about 15% of the time and jumps to a page at random.",
    "Stanford owned the PageRank patent, not Google. Google licensed it and paid in shares.",
    "The ARPANET opened in 1969 with four nodes: UCLA, SRI, UC Santa Barbara and Utah.",
    "A follow graph is directed: on Twitter, most friendships only point one way.",
    "Epidemiologists model outbreaks on contact networks, not on crowds of interchangeable people.",
    "Dot and line, vertex and edge, actor and tie, site and bond — four fields, one picture.",
    "This notebook is a network too: change one thing and everything downstream of it redraws itself.",
  ];

  // Lines that belong to ONE module's story — shown only inside it, where the
  // student has met the thing they refer to. The same rule about answers
  // applies here twice over: these land in the module whose checkpoints are
  // about exactly this material.
  const TRIVIA_BY_MODULE: Record<string, string[]> = {
    "m01-euler-tour": [
      "Euler invented network theory in 1736 to settle a stroll — the 7 bridges of Königsberg.",
      "Königsberg's seven bridges went up between 1286 and 1542 — Euler wrote about the set his own century inherited.",
      "Euler filed his bridge paper under a heading of his own invention: 'the geometry of position'.",
      "Königsberg is Kaliningrad now; the city changed its name, and the puzzle kept his.",
      "Euler read his bridge paper to the St Petersburg Academy in 1735; it was printed in 1741.",
    ],
    "m02-small-world": [
      "Frigyes Karinthy dreamed up the six-degrees question in a 1929 short story, 'Chains'.",
      "J. A. Barnes coined 'social network' in 1954, studying a fishing parish in Norway.",
      "Pool and Kochen wrote the small-world problem down around 1958; it sat unpublished for twenty years.",
      "Stanley Milgram ran his letter experiment out of Harvard in the 1960s, with paper and stamps.",
      "Milgram's first packets went out from Wichita, Kansas, before he moved the experiment to Omaha.",
      "Milgram's small-world paper ran in the very first issue of Psychology Today, in 1967.",
      "Most of Milgram's packets never arrived at all — the famous result rests on the ones that did.",
      "In Milgram's Boston study, one clothing merchant handed over a quarter of the letters that arrived.",
      "Milgram's other field experiment: drop stamped letters in the street and see which strangers post them.",
      "In 2003 a team reran Milgram's experiment by email: 24,163 chains, senders in 166 countries.",
      "Watts & Strogatz published their network model in Nature in 1998; it has been cited over 50,000 times.",
      "The Watts-Strogatz paper is three pages long, figures included.",
      "Duncan Watts came to networks from crickets — he was studying how they chirp in sync.",
      "The original three networks studied in 1998: film actors, the US power grid, and a worm's brain.",
      "The C. elegans worm's entire nervous system is mapped — all 302 neurons of it.",
    ],
  };

  const TRIVIA = [...TRIVIA_GENERAL, ...(TRIVIA_BY_MODULE[moduleId()] ?? [])];
  let triviaIdx = Math.floor(Math.random() * TRIVIA.length);
  let triviaTimer: ReturnType<typeof setInterval> | null = null;
  const showTrivia = (ctx: any) => {
    if (quietForPicker) return;
    try {
      const line = `Tip: ${TRIVIA[triviaIdx++ % TRIVIA.length]}`;
      ctx.ui.setWorkingMessage(ctx.ui.theme.fg("dim", line));
    } catch {
      // cosmetic only — never let trivia break a turn
    }
  };
  pi.on("turn_start", async (_event, ctx: any) => {
    if (!ctx.hasUI) return;
    showTrivia(ctx);
    if (triviaTimer) clearInterval(triviaTimer);
    // Long waits (vision calls, compaction) get a new tidbit mid-spin.
    triviaTimer = setInterval(() => showTrivia(ctx), 12_000);
    (triviaTimer as any).unref?.(); // never keep the process alive (print mode)
  });
  // Consecutive turns that came back with nothing in them at all. Reset by
  // any turn that produced words or a tool call — see the bottom of turn_end.
  let emptyTurns = 0;
  pi.on("turn_end", async (event: any) => {
    // Read before runPendingCompaction() nulls it: the stall nudge at the
    // bottom must not fire into a chapter handoff.
    // `pendingHandoffBrief`, not `pendingCompaction`. The latter is nulled by
    // runPendingCompaction() three lines below and therefore ALWAYS false
    // where this is read — so the empty-turn nudge was never actually held
    // back during a handoff, which is the one window it must not fire in
    // (chapter_done ends its turn on a bridge sentence, compaction fires right
    // here, and a message injected into that window is the "Error: This
    // operation was aborted" the comment below exists to prevent). The brief
    // is non-null from chapter_done until session_before_compact consumes it,
    // which is exactly the window.
    const wasHandingOff = !!pendingHandoffBrief || !!pendingCompaction;
    if (triviaTimer) {
      clearInterval(triviaTimer);
      triviaTimer = null;
    }
    // chapter_done arms compaction and leaves the firing to us. It has to be
    // turn_end, not message_end: message_end lands as soon as the tool-calling
    // message is complete, which is BEFORE the tutor says the bridge sentence
    // that same tool result asks for — so compaction aborted it and the
    // student read "Error: This operation was aborted" instead. A turn ends
    // once the tutor has actually stopped talking.
    runPendingCompaction();
    // ── Telling the student the ⚖️ box exists ────────────────────────────
    // The appeal box is the student's only way out from under a tutor that
    // has stopped helping, and nothing ever mentions it to them: AGENTS.md
    // tells the tutor how to OBEY a verdict and never to offer one, the
    // lesson scripts do not name it, and in the notebook it is a collapsed
    // accordion at the bottom of a long page. A beginner going round the
    // same question for the fifth time does not know it is there.
    //
    // "Going round" is countable without asking the model to notice — but NOT
    // as turns, which is what this counted for as long as it existed.
    //
    // A turn is not an exchange. Measured on a live m01 session: 13 assistant
    // turns to 5 student messages, four of those turns with no words in them
    // at all. A tool call is a turn; a refused checkpoint_done and its retry
    // are two more; every guard that fires adds one, and guards have been
    // added since twelve was chosen. So `STUCK_TURNS = 12` was reached after
    // four or five real exchanges, and an m02 review reported this nudge
    // landing "right after the very first wrong turn on cp2_distance". That
    // is pi-pair-notebook#3: the counter resets correctly (cp0 logged 1 and
    // cp1 logged 8 in the same run) — it was counting the wrong thing.
    //
    // Six ANSWERS now, through the same narrowing the note cell and the
    // late-close gate use, so all three agree on what an answer is. Filler and
    // a detour's turns are already out of it: a student who asks two questions
    // mid-checkpoint is curious, not stuck.
    //
    // `turnsInCheckpoint` stays, and gates nothing. It is the FACT on the row
    // — "how long the two of them were actually on this checkpoint" — beside a
    // hint count the model supplies from memory. Keeping the record and the
    // trigger as separate numbers is the point: each now measures the thing it
    // is named after.
    turnsInCheckpoint += 1;
    const stuckAnswers = (() => {
      try {
        return answerCountForGate({
          said: studentSaidSince(lastCtx, false),
          response: "",
          detourSpans,
          detourAsked,
          mechanicsAsked,
        });
      } catch {
        return 0;
      }
    })();
    // `>=`, not `===`. The old equality was safe only because a turn counter
    // rises by exactly one; an answer count can jump two in a turn (a student
    // who types twice while the tutor is working) and an equality would then
    // skip the nudge for the whole checkpoint. `stuckNudged` carries the
    // once-ness now, so the comparison does not have to.
    if (stuckAnswers >= STUCK_ANSWERS && !stuckNudged) {
      stuckNudged = true;
      try {
        pi.sendMessage(
          {
            customType: "stuck-nudge",
            content:
              `NOTE (invisible to the student): you have been on this checkpoint for a ` +
              `while. Keep going exactly as you are — but in your NEXT message, add one ` +
              `plain sentence telling them the ⚖️ box at the bottom of the notebook page ` +
              `is there if they think their answer should count, want a fresh try, or ` +
              `would rather move on, and that using it is never held against them. One ` +
              `sentence, said once, then carry on with the question you are on. Do not ` +
              `apologise and do not suggest they are failing.`,
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      } catch {
        /* a nudge that cannot be sent is not worth a broken turn */
      }
    }

    // ── The turn that came back empty ─────────────────────────────────────
    // Not every silence is a choice the model made. In the same session that
    // lost three reveals, the turn after cp3_clustering's close came back with
    // `content: []` and stopReason "stop": no words, no tool call, nothing to
    // render. The terminal stopped, and stayed stopped, until the student
    // typed "hello? are you still there?" into it — and that nudge then landed
    // in cp3_average's note as their own worked answer.
    //
    // A completion with nothing in it is not a judgement call, so unlike
    // everything else in this file it can be caught from outside the model:
    // turn_end hands us the message. Poke it once and let it speak. A
    // tool-calling turn ends "toolUse", and an aborted or errored one ends
    // "aborted"/"error", so this can never double-fire with the runaway
    // guard's own abort-and-resend.
    //
    // Consecutive stalls are counted so this can never be the thing that spins
    // it: two nudges, then stop. After that the student's own keystroke
    // restarts the session — which is exactly what happens today with no nudge
    // at all, so the cap costs them nothing they were not already going to get.
    //
    // Not while a chapter handoff is armed. chapter_done ends its turn on a
    // bridge sentence and compaction fires right here; a message injected into
    // that window is the "Error: This operation was aborted" the comment above
    // exists to prevent, and that path already has its own 30s floor.
    //
    // Nothing is said to the STUDENT. A stall is toolkit machinery, and a
    // beginner reading "your tutor returned an empty response" learns only
    // that the thing they are graded in is broken.
    const parts = Array.isArray(event?.message?.content) ? event.message.content : [];
    const stalled =
      event?.message?.role === "assistant" &&
      event.message.stopReason === "stop" &&
      !parts.some(
        (p: any) =>
          p?.type === "toolCall" || (p?.type === "text" && String(p.text ?? "").trim()),
      );
    if (!stalled) {
      emptyTurns = 0;
      return;
    }
    emptyTurns += 1;
    if (wasHandingOff || emptyTurns > 2) return;
    try {
      pi.sendMessage(
        {
          customType: "empty-turn",
          content:
            `NOTE (invisible to the student): your last turn came back completely ` +
            `empty — no words and no tool call — so their screen has been sitting ` +
            `silent with nothing on it for them to answer. They cannot tell that apart ` +
            `from you thinking, and in a live run a student waited on exactly this ` +
            `until they typed "hello? are you still there?".\n` +
            `Say the next thing you owe them NOW, in plain text. If a checkpoint's ` +
            `reveal is still unspoken, give it in short beats; otherwise ask the ` +
            `question you were on, in one short line. Do not apologise, do not mention ` +
            `this note, and do not start the chapter over.`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      /* a nudge that cannot be sent is not worth a broken turn */
    }
  });
}
