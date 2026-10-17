/**
 * setup-pi.mjs refuses a uv that marimo's `--sandbox` will refuse.
 *
 * Seen in a graded m03-m04 session: uv 0.7.13 -> "uv 0.7.21 or newer is
 * required to manage sandbox environments" -> no notebook server -> a
 * submitted notebook with no work in it. The installer only asked whether uv
 * existed. These run the real installer with a fake `uv` first on PATH and a
 * throwaway HOME, and read what it says about uv. Whatever it does after that
 * (the key, the network) is not under test.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "setup", "setup-pi.mjs");
const POSIX = process.platform !== "win32";

function uvLine(versionOutput: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uv-check-"));
  try {
    const fake = path.join(dir, "uv");
    fs.writeFileSync(fake, `#!/bin/sh\necho '${versionOutput}'\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [SETUP], {
      encoding: "utf8",
      stdin: "ignore",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        HOME: dir,
        USERPROFILE: dir,
        NETSCI_API_KEY: "",
        NETSCI_BASE_URL: "http://127.0.0.1:9/v1",
      },
    });
    return (r.stdout ?? "").split("\n").filter((l) => /uv\b/.test(l)).join("\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("setup-pi.mjs checks the uv version", { skip: !POSIX }, () => {
  test("0.7.13 is too old, and the student is told how to update", () => {
    const out = uvLine("uv 0.7.13 (abc 2025-06-01)");
    assert.match(out, /too old/);
    assert.match(out, /0\.7\.21 or newer/);
    assert.match(out, /uv self update/);
  });

  test("0.7.20 is still too old (patch number counts)", () => {
    assert.match(uvLine("uv 0.7.20"), /too old/);
  });

  for (const v of ["0.7.21", "0.7.22", "0.8.0", "0.12.13", "1.0.0"]) {
    test(`${v} passes`, () => {
      const out = uvLine(`uv ${v} (abc 2026-01-01)`);
      assert.doesNotMatch(out, /too old/);
      assert.match(out, new RegExp(v.replace(/\./g, "\\.")));
    });
  }

  test("a version it cannot read is let through, not blocked", () => {
    assert.doesNotMatch(uvLine("uv dev-build"), /too old/);
  });
});
