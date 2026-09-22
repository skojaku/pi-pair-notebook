/**
 * Keeping the package's skills in step with the student's `~/.pi/agent/skills`.
 *
 * A skill is how a rule the tutor needs *sometimes* stays out of the way the
 * rest of the time: pi reads every SKILL.md's frontmatter (a name and a
 * one-line description) into context, and the body only when the model asks
 * for it. That is the right shape for the long procedural passages the tutor
 * contract has accumulated — the closing ceremony, the figure palette, the
 * referee — which are a third of the file and matter on a minority of turns.
 *
 * The gap this closes. Until now the only thing that ever wrote a skill was
 * `setup/setup-pi.mjs`, which runs ONCE, before pi exists, on the day a
 * student sets up. So a skill added to this package after that day reached
 * nobody: the update channel moves the student's checkout, so the new
 * `skills/` directory is sitting right there on their disk, and nothing
 * copied it the last twenty centimetres. "Centrally managed" was true of the
 * file and false of the student.
 *
 * It takes effect on the NEXT launch, not this one — pi has already scanned
 * the skills directory by the time an extension runs. That is the same
 * guarantee the update channel gives, for the same reason, and students
 * relaunch between sittings.
 *
 * WHAT IT WILL NOT TOUCH. `setup-pi.mjs` also writes `classroom-teammates`,
 * which is not in this package and must survive; a student may have written
 * skills of their own. So a directory is only ever rewritten or removed if it
 * carries this package's marker file. Everything else is left exactly alone,
 * including a name collision — someone else's `lecture-quiz` is theirs.
 *
 * Removal is deliberate and is the half that makes this central management
 * rather than accumulation: a rule withdrawn from the package has to leave
 * the student's machine too, or the tutor goes on reading an instruction the
 * course has retracted.
 */

import fs from "node:fs";
import path from "node:path";

/** Dropped beside a SKILL.md we wrote. Its presence is the whole licence to
 *  rewrite or delete that directory. */
export const OWNED_MARKER = ".owned-by-pair-notebook";

/** Skill directory names we are willing to create. Anything else in the
 *  package's `skills/` is ignored rather than trusted: this string becomes a
 *  path under the student's home directory. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Skills that are ours but were written before the marker existed.
 *
 * `setup/setup-pi.mjs` has been installing `lecture-quiz` from this
 * package's own file since v0.14.0, with no marker beside it — so on every
 * machine set up before this sync shipped, the strict rule below would read
 * our own skill as a stranger's and refuse to ever update it again. That is
 * the whole fleet, and it is exactly the failure this module exists to end.
 *
 * Adopted on first sight: the marker is written and the skill joins the
 * normal path. The installer writes the marker itself now, so nothing new
 * lands here. Names may leave this list once no student is running a setup
 * older than v0.15.0 — and until then removing one silently strands it.
 */
const LEGACY_OURS = new Set(["lecture-quiz"]);

export interface SkillSyncReport {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
  /** Name -> why. Never thrown: a skill that will not write is a tutor with
   *  one less rule, not a session that fails to start. */
  failed: Record<string, string>;
}

function emptyReport(): SkillSyncReport {
  return { added: [], updated: [], removed: [], unchanged: [], failed: {} };
}

function readSkill(dir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    // pi keys a skill on its frontmatter `name:`. A file without one is not a
    // skill; shipping it would put a nameless entry in the student's catalogue.
    return /^---[\s\S]*?\bname:\s*\S/m.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Write through a temp file in the same directory, so an interrupted sync
 *  leaves the previous skill intact rather than half of the new one. */
function writeAtomic(target: string, text: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

export function syncSkills(sourceDir: string, targetDir: string): SkillSyncReport {
  const report = emptyReport();

  let names: string[];
  try {
    names = fs
      .readdirSync(sourceDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SAFE_NAME.test(e.name))
      .map((e) => e.name);
  } catch {
    // No skills/ in this package version. Nothing to install -- and nothing to
    // remove either: an absent source directory is far more likely to be a
    // packaging slip than a deliberate withdrawal of every skill at once, and
    // the destructive reading of that ambiguity is the one that cannot be
    // undone from a student's terminal.
    return report;
  }

  const wanted = new Set<string>();
  for (const name of names) {
    const text = readSkill(path.join(sourceDir, name));
    if (text === null) {
      report.failed[name] = "no SKILL.md with a frontmatter name";
      continue;
    }
    wanted.add(name);
    const dest = path.join(targetDir, name);
    const destFile = path.join(dest, "SKILL.md");
    const marker = path.join(dest, OWNED_MARKER);
    try {
      if (fs.existsSync(dest)) {
        if (!fs.existsSync(marker)) {
          if (!LEGACY_OURS.has(name)) {
            // Someone else's skill of the same name. Theirs wins; we do not
            // get to decide that ours is the one they meant.
            report.failed[name] = "a skill of that name is already there and is not ours";
            continue;
          }
          fs.writeFileSync(marker, "");
        }
        if (fs.readFileSync(destFile, "utf8") === text) {
          report.unchanged.push(name);
          continue;
        }
        writeAtomic(destFile, text);
        report.updated.push(name);
        continue;
      }
      fs.mkdirSync(dest, { recursive: true });
      writeAtomic(destFile, text);
      fs.writeFileSync(marker, "");
      report.added.push(name);
    } catch (e) {
      report.failed[name] = (e as Error).message;
    }
  }

  // Withdrawals: ours, and gone from the package.
  let installed: string[] = [];
  try {
    installed = fs
      .readdirSync(targetDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return report;
  }
  for (const name of installed) {
    if (wanted.has(name)) continue;
    const dest = path.join(targetDir, name);
    if (!fs.existsSync(path.join(dest, OWNED_MARKER))) continue;
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      report.removed.push(name);
    } catch (e) {
      report.failed[name] = (e as Error).message;
    }
  }

  return report;
}
