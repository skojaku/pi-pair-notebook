// One-time setup for your tutor. Run it once, then use `pi`.
//
//   node setup-pi.mjs
//
// Node, not a shell script, so it is the same command on Windows, macOS and
// Linux — and Node is already required, because that is what pi runs on.
//
// It checks that uv and pi are installed, adds the course model to
// ~/.pi/agent/models.json, and makes one real request so you find out here —
// not mid-lesson — whether your key works.
//
// Safe to re-run. It rewrites only the "netsci" provider and keeps a backup of
// whatever was there before.
//
// YOUR KEY IS NEVER WRITTEN TO A FILE. The provider block reads it from
// NETSCI_API_KEY at request time, because you submit this folder by pushing it
// to GitHub and a key in a tracked file becomes a key in a public history.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_URL = process.env.NETSCI_BASE_URL ?? "https://llm.skojaku.com/v1";
const MODELS = path.join(os.homedir(), ".pi", "agent", "models.json");
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const WIN = process.platform === "win32";

const c = process.stdout.isTTY
  ? { b: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[1;31m", green: "\x1b[1;32m", cyan: "\x1b[1;36m", off: "\x1b[0m" }
  : { b: "", dim: "", red: "", green: "", cyan: "", off: "" };
const say = (m) => console.log(`\n${c.cyan}[setup]${c.off} ${m}`);
const ok = (m) => console.log(`   ${c.green}✓${c.off} ${m}`);
const warn = (m) => console.log(`   ${c.red}!${c.off} ${m}`);
const line = (m = "") => console.log(m);

let todo = 0;

/** Windows needs the shell to resolve npm.cmd / uv.cmd. */
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", shell: WIN, ...opts });
const have = (cmd) => {
  const r = run(cmd, ["--version"]);
  return r.status === 0 ? (r.stdout || "").trim().split("\n")[0] : null;
};

say("Checking what you have");

// --- node: everything here runs on it ---------------------------------------
// You are reading this from inside Node, so it exists — but pi needs 24+, and
// on an older one npm prints an EBADENGINE warning, installs anyway, and pi
// fails later in a way that has nothing to do with Node in its message.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 24) {
  ok(`Node ${process.versions.node}`);
} else {
  warn(`Node ${process.versions.node} is too old — your tutor needs 24 or newer.`);
  line("     Install the current version from https://nodejs.org, then re-run me.");
  todo++;
}

// --- git: pi fetches your tutor's toolkit with it ----------------------------
// .pi/settings.json lists the toolkit as a `git:` package, so pi shells out to
// `git clone` on first start. Without git that clone fails and pi stops before
// the tutor exists — an error about a package, on a machine whose real problem
// is a missing program nobody mentioned.
if (have("git")) {
  ok("git");
} else {
  warn("git is missing — pi downloads your tutor's toolkit with it (and you hand your work in with it).");
  if (WIN) line(`     ${c.b}winget install --id=Git.Git${c.off}   (or https://git-scm.com/download/win)`);
  else line(`     macOS: ${c.b}xcode-select --install${c.off}`);
  todo++;
}

// --- uv: runs the notebook ---------------------------------------------------
const uv = have("uv");
if (uv) {
  ok(`uv ${uv.replace(/^uv /, "")}`);
} else {
  warn("uv is missing — it is what runs the notebook.");
  if (WIN) line(`     ${c.b}winget install --id=astral-sh.uv${c.off}`);
  else line(`     macOS: ${c.b}brew install uv${c.off}`);
  line("     other:  https://docs.astral.sh/uv/getting-started/installation/");
  todo++;
}

// --- pi: the agent your tutor runs on ---------------------------------------
let pi = have("pi");
if (pi) {
  ok(`pi ${pi}`);
} else {
  warn("pi is missing — it is the agent your tutor runs on.");
  if (!have("npm")) {
    warn("npm is missing too — install Node.js 24 or newer first: https://nodejs.org");
    line(`     Then: ${c.b}npm install -g ${PI_PACKAGE}${c.off}`);
    todo++;
  } else if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("     Install it now with npm? [y/N] ")).trim();
    rl.close();
    if (/^y/i.test(answer)) {
      say(`Installing ${PI_PACKAGE} (this takes a minute)`);
      run("npm", ["install", "-g", PI_PACKAGE], { stdio: "inherit" });
      pi = have("pi");
      if (pi) ok(`pi ${pi} installed`);
      else {
        warn("the install finished but 'pi' is still not on PATH — open a new terminal and re-run me");
        todo++;
      }
    } else {
      line(`     Later: ${c.b}npm install -g ${PI_PACKAGE}${c.off}`);
      todo++;
    }
  } else {
    line(`     Run: ${c.b}npm install -g ${PI_PACKAGE}${c.off}`);
    todo++;
  }
}

// --- the course model --------------------------------------------------------
say("Adding the course model to ~/.pi/agent/models.json");

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const netsci = {
  baseUrl: BASE_URL,
  api: "openai-completions",
  // Read from the environment at request time, never stored here.
  apiKey: "$NETSCI_API_KEY",
  compat: { supportsDeveloperRole: false },
  models: [
    { id: "tutor", name: "Course Tutor", reasoning: true, input: ["text"],
      contextWindow: 131072, maxTokens: 32768, cost: zero },
    // The same key outside the notebook: lecture questions, the mini-project,
    // other assignments. A separate alias rather than a looser tutor, because
    // the tutor's Socratic contract is what makes the graded notebook worth
    // grading. Written here so it lands in the student's models.json with
    // everything else; the module itself never names it.
    { id: "assistant", name: "Course Assistant", reasoning: true, input: ["text"],
      contextWindow: 131072, maxTokens: 32768, cost: zero },
    { id: "vision", name: "Course Vision", input: ["text", "image"],
      contextWindow: 1048576, maxTokens: 8192, cost: zero },
    { id: "referee", name: "Course Referee", reasoning: true, input: ["text"],
      contextWindow: 131072, maxTokens: 8192, cost: zero },
  ],
};

fs.mkdirSync(path.dirname(MODELS), { recursive: true });
let data = {};
if (fs.existsSync(MODELS) && fs.statSync(MODELS).size > 0) {
  const raw = fs.readFileSync(MODELS, "utf8");
  try {
    data = JSON.parse(raw);
  } catch (e) {
    // Never overwrite a file we could not read: it may hold provider blocks
    // that took someone an afternoon to get right.
    warn(`${MODELS} is not valid JSON (${e.message}).`);
    line("     Fix or move that file, then run me again — I will not overwrite it.");
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const backup = `${MODELS}.bak-${stamp}`;
  fs.copyFileSync(MODELS, backup);
  line(`   backed up your old file to ${path.basename(backup)}`);
}
if (typeof data !== "object" || data === null || Array.isArray(data)) {
  warn(`${MODELS} does not contain a JSON object. Move it aside and run me again.`);
  process.exit(1);
}
data.providers ??= {};
const kept = Object.keys(data.providers).filter((k) => k !== "netsci");
data.providers.netsci = netsci;
fs.writeFileSync(MODELS, JSON.stringify(data, null, 2) + "\n");
line(`   wrote the netsci provider (tutor, assistant, vision, referee) to ${MODELS}`);
if (kept.length) line(`   kept your other providers: ${kept.sort().join(", ")}`);
ok("course model configured");

// --- trusting this folder ----------------------------------------------------
// The first `pi` in a folder with a .pi/ directory opens a five-option security
// dialog: "Trust project folder? … This allows pi to load .pi settings and
// resources, install missing project packages, and execute project extensions."
// Picking "Do not trust" is remembered, and it turns the assignment off
// completely — no course model, no toolkit, no nb_* tools — while leaving a
// tutor that still talks, now improvising a lesson it cannot build. That is a
// security question about a folder the student just chose to run a setup
// script in, asked of someone who has never opened a terminal, with the
// destructive answer indistinguishable from the safe one.
//
// So answer it here, where the folder is unambiguously theirs and the
// consequence can be stated in a sentence, and let them start with `pi`.
say("Trusting this folder, so pi does not have to ask");
const TRUST = path.join(os.homedir(), ".pi", "agent", "trust.json");
const here = process.cwd();
try {
  let trust = {};
  if (fs.existsSync(TRUST) && fs.statSync(TRUST).size > 0) {
    trust = JSON.parse(fs.readFileSync(TRUST, "utf8"));
    if (typeof trust !== "object" || trust === null || Array.isArray(trust)) trust = {};
  }
  if (trust[here] === true) {
    ok("already trusted");
  } else {
    trust[here] = true;
    fs.writeFileSync(TRUST, JSON.stringify(trust, null, 2) + "\n");
    ok(`pi will load this folder's settings without asking`);
    line(`   (${here})`);
  }
} catch (e) {
  // Not fatal: pi will simply ask, and the README says which answer to give.
  warn(`could not update ${TRUST} (${e.message}).`);
  line(`     Not a problem — pi will ask "Trust project folder?" on your first`);
  line(`     start instead. Answer ${c.b}Trust${c.off} (the first option).`);
}

// --- what plain `pi` starts, outside a lesson --------------------------------
// A module folder names its own defaultProvider/defaultModel, and pi's project
// settings override the global ones (`.pi/settings.json` beats
// `~/.pi/agent/settings.json`), so nothing written here can reach a lesson:
// inside a module, `pi` is still the tutor.
//
// Outside one there was no default at all. pi falls back to its own — google —
// which a student has no key for, so plain `pi` anywhere else failed, and the
// only way in was a flag. "Type pi --model netsci/assistant" is a sentence
// that has to be remembered, transcribed and got right, by the students least
// able to do any of the three. Setting it once here means the answer to "how
// do I use it for the mini-project?" is `pi`.
//
// Only when the slot is empty, or already ours. Someone with their own default
// has chosen it, and an installer for one course is not the thing to overrule
// that — say what was skipped and how to do it by hand instead.
say("Setting what plain `pi` starts outside a lesson");
const SETTINGS = path.join(os.homedir(), ".pi", "agent", "settings.json");
try {
  let settings = {};
  if (fs.existsSync(SETTINGS) && fs.statSync(SETTINGS).size > 0) {
    settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      throw new Error("not a JSON object");
    }
  }
  const current = settings.defaultProvider;
  if (current && current !== "netsci") {
    warn(`you already have a default model set (${current}) — leaving it alone.`);
    line(`     Your course models still work; name one when you want it:`);
    line(`\n         ${c.b}pi --model netsci/assistant${c.off}\n`);
  } else if (settings.defaultModel === "assistant" && current === "netsci") {
    ok("already set");
  } else {
    if (fs.existsSync(SETTINGS)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
      fs.copyFileSync(SETTINGS, `${SETTINGS}.bak-${stamp}`);
    }
    settings.defaultProvider = "netsci";
    settings.defaultModel = "assistant";
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
    ok("outside a lesson, `pi` now starts your course assistant");
  }
} catch (e) {
  // Never fatal: without it they need the flag, which is where we started.
  warn(`could not set your default model (${e.message}).`);
  line(`     Not a problem — outside a lesson, name it instead:`);
  line(`\n         ${c.b}pi --model netsci/assistant${c.off}\n`);
}

// --- the key -----------------------------------------------------------------
const rawKey = process.env.NETSCI_API_KEY;
// A key arrives by email and gets pasted, so it arrives wrapped in quotes, with
// a line break in the middle, or with a trailing space. Node's fetch throws a
// TypeError on a header value containing a newline — which the catch below used
// to report as "no network, or the server is down", sending the student to look
// at their wifi.
const key = rawKey?.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
if (rawKey && key !== rawKey.trim()) {
  warn("your key had quotes or spaces in it — I stripped them for this check,");
  line("     but fix the line in your profile too, or pi will keep sending them.");
}
if (key && !/^sk-nsci-[\w-]+$/.test(key)) {
  warn(`NETSCI_API_KEY does not look like a course key (it should start "sk-nsci-").`);
  line("     Check you copied the whole line, and nothing around it.");
}
if (key) {
  ok("NETSCI_API_KEY is set in this terminal");
  say("Trying one request against the course server");
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const ids = (body?.data ?? []).map((m) => m.id).join(", ");
      ok(`the server answered and your key works${ids ? ` — models: ${ids}` : ""}`);
    } else if (res.status === 401 || res.status === 403) {
      warn(`the server rejected your key (HTTP ${res.status}).`);
      line("     Check for a stray space or a missing character, and ask your instructor");
      line("     to reissue it if it still fails.");
      todo++;
    } else {
      warn(`unexpected reply from the server (HTTP ${res.status}). Tell your instructor.`);
      todo++;
    }
  } catch (e) {
    if (e?.name === "TimeoutError") {
      warn(`${BASE_URL} did not answer within 20 seconds.`);
      line("     Try again in a few minutes; tell your instructor if it persists.");
    } else if (e instanceof TypeError) {
      // Thrown before anything left the machine — the request itself was
      // malformed, which here always means the key.
      warn(`your key could not even be sent (${e.message}).`);
      line("     It has a character in it that cannot go in a request — usually a");
      line("     line break from a pasted email. Retype it on one line.");
    } else {
      warn(`could not reach ${BASE_URL} — no network, or the server is down (${e?.message ?? e}).`);
      line("     Try again in a few minutes; tell your instructor if it persists.");
    }
    todo++;
  }
} else {
  warn("NETSCI_API_KEY is not set in this terminal.");
  if (WIN) {
    line(`     In PowerShell, set it once and then open a ${c.b}new${c.off} terminal:`);
    line(`\n         ${c.b}setx NETSCI_API_KEY "sk-nsci-..."${c.off}\n`);
  } else {
    const profile = /zsh/.test(process.env.SHELL ?? "") ? "~/.zshrc" : "~/.bashrc";
    line(`     Add this line to ${c.b}${profile}${c.off}, then open a ${c.b}new${c.off} terminal:`);
    line(`\n         ${c.b}export NETSCI_API_KEY="sk-nsci-..."${c.off}\n`);
  }
  line(`     ${c.b}Do not paste the key into a file in this folder${c.off} — you push this`);
  line("     folder to GitHub, and a key committed there has to be revoked.");
  todo++;
}

// --- the notebook's own packages ---------------------------------------------
// The notebook declares its dependencies in its own header and uv builds them
// into a sandbox the first time it starts. That download is a couple of hundred
// megabytes, and it happens INSIDE the tutor's first notebook call: the student
// sees one status line and nothing else for minutes, decides it has frozen, and
// presses Ctrl-C. Do it here instead, where a long wait is expected and the
// screen says so. Everything lands in uv's shared cache, so the real start
// finds it already there.
//
// Warmed through a stand-in script with the same header rather than the
// notebook itself, which would run the lesson's cells.
if (have("uv")) {
  say("Downloading the notebook's Python packages (a few hundred MB, once)");
  try {
    const tpl = fs.readFileSync(path.join(process.cwd(), "notebook.template.py"), "utf8");
    const header = tpl.match(/^# \/\/\/ script\n(?:^#.*\n)*?^# \/\/\/$/m)?.[0];
    if (!header) throw new Error("no dependency header in notebook.template.py");
    const warm = path.join(os.tmpdir(), `netsci-warmup-${process.pid}.py`);
    fs.writeFileSync(warm, `${header}\n\nprint("ok")\n`);
    const r = run("uv", ["run", "--no-project", "--script", warm], { stdio: "inherit" });
    fs.rmSync(warm, { force: true });
    if (r.status === 0) ok("notebook packages ready — your first session starts fast");
    else throw new Error(`uv exited ${r.status}`);
  } catch (e) {
    // Never fatal: it is a head start, not a requirement. Without it the first
    // session simply pays the download, which is what happened before.
    warn(`could not pre-download the notebook packages (${e.message}).`);
    line("     Not a problem — your first session will download them instead,");
    line("     which makes its first minute slow. Nothing is broken.");
  }
}

// --- done --------------------------------------------------------------------
if (todo === 0) {
  say("You are set. Start your session with:");
  line(`\n     ${c.b}pi${c.off}\n`);
  line(`${c.dim}   (the first start also downloads your tutor's toolkit — give it a minute)${c.off}\n`);
  // Said once, here, because this screen is the one every student reads. It is
  // the same word in both places on purpose: the folder decides which one
  // answers, so there is no flag to remember and no wrong way to start.
  line(`   Your key works on the rest of the course too. ${c.b}pi${c.off} in any other`);
  line(`   folder starts your course assistant instead of the tutor —`);
  line(`   lecture questions, the mini-project, your other assignments.`);
  line(`${c.dim}   Not exams. In THIS folder 'pi' is always your tutor.${c.off}\n`);
} else {
  say(`Almost there — ${todo} thing(s) above still need you. Run me again afterwards.`);
  line(`${c.dim}   (nothing is broken; the steps above are one-time.)${c.off}\n`);
  process.exit(1);
}
