# The update channel

How a fix reaches a student who has already started the module.

`channel.json` names, per module, the toolkit tag its students should be
running. `extensions/channel-update.ts` reads it, moves the student's checkout,
and rolls the move back if the new tag does not come up.

## What students actually read

```
https://raw.githubusercontent.com/skojaku/pi-pair-notebook/release/channel.json
```

**`release`, not `main`.** `main` is where a tag is *proposed*; `release` is
what CI promotes once it has proved that tag boots.

`release` is protected: **no deletion, no force-push, and the rules apply to
the owner too** (`enforce_admins`). What that buys is that the branch is
append-only — nothing can rewrite or remove what CI promoted, by hand or by
accident, and a student's `channel.json` cannot vanish mid-term.

What it does NOT buy, and the earlier wording here promised: "only the
workflow can write it". Push restrictions by actor are an organisation
feature, and this is a personal repo, so an ordinary fast-forward push from
the owner still lands. The protection makes the branch tamper-evident and
undeletable; the discipline of promoting through CI is still discipline.
`channel-watch` re-checking the live file every six hours is the part that
notices if it was not followed.

`raw.githubusercontent`, never `api.github.com`: the API allows 60
unauthenticated calls an hour **per IP**, and a lecture hall behind one campus
NAT is one IP. The CDN caches for 300s, so a rollback reaches everyone within
five minutes.

## Promoting a tag

```sh
# 1. release the toolkit as usual — BUILDING.md → Releasing
#    (bump package.json version, publish, tag vX.Y.Z)

# 2. point the module at it on main
#    channel.json -> "m02-small-world": { "toolkit": "vX.Y.Z" }
git commit -am "channel: m02 -> vX.Y.Z" && git push
```

Pushing to `main` starts `channel-guard`. It refuses to promote unless, for
every module in the file:

| Check | Why it is fatal |
|---|---|
| the tag exists on the remote | a pin pi cannot resolve kills pi with a raw Node stack trace **before any extension loads** — nothing in this package could repair it |
| `package.json` version at that tag equals the tag | tag and manifest disagreeing is how the wrong code ships under the right name |
| every file in `REQUIRED` is present at that tag | a manifest entry pointing at a missing file is silently dropped: the extension ceases to exist and pi still exits 0 |
| pi boots that tag with the extension **loaded** | exit 0 alone proves nothing, for the reason above — the gate asserts the `--loaded--<tag>` marker the factory writes, on disk, and greps the boot log for "Failed to load extension" |
| the tag is not behind what `release` already advertises | stops a stale branch walking students backwards |

Only then does the workflow copy `channel.json` onto `release`.

**What none of that proves.** The gate boots the extension with an empty
`lesson/index.json` and a dead `MARIMO_URL`, so it reaches the factory and
`session_start` and stops. Every tool, guard, drift check and log field is
behind a call it never makes. A tag can pass every row of that table and still
be wrong in every row it writes — three bugs did exactly that in one afternoon,
health markers and all. This gate answers "will this tag brick a launch?".
"Is this tag fit for a student?" is answered by `npm test` and by Part D in the
course repo's `REVIEWING.md`, before the tag is cut.

`channel-watch` re-runs the same checks against the **live** `release` file on a
schedule, because a tag can be deleted long after it was promoted.

## Rolling back

Point `channel.json` at the older tag and push. Students return on their next
launch, within the CDN's five minutes. This is the mechanism's best property and
the reason it beats asking fifty people to edit a file.

For an emergency where you do not yet know which tag is good:

```json
{ "schema": 1, "frozen": true, "modules": { ... } }
```

`frozen` stops every student's channel where it stands, in one commit.

## What holds it down

Four properties, stated at the top of `extensions/channel-update.ts` and worth
repeating because they are the whole safety argument:

1. **The pin is only ever advanced to a tag already on that student's disk.**
   Fetch, check out, verify, *then* write the pin. The channel cannot create
   the one failure it could not repair.
2. **A tag that does not come up is rolled back locally, without anyone
   noticing it.** `notebook-tool.ts` writes a `loaded` marker in its factory
   and a `healthy` marker at the end of a session_start that actually put a
   chapter on screen. No `loaded` means the new code did not import — roll back
   on that same launch. `loaded` but never `healthy` across a whole launch
   means it imported and then died — roll back on the next one. One dead
   launch, or two.
3. **Nothing in it can delay a lesson.** No awaited network I/O at load. The
   roll-forward runs off the critical path behind a 45s deadline, and every
   failure — offline, timeout, bad JSON, unwritable file — leaves the pin
   exactly where it was.
4. **It never speaks to the student and never touches their work.** Two paths
   are written and no others: the module's `.pi/settings.json`, and state under
   `~/.pi/agent/pair-notebook-channel/`. `notebook.py`, `session_artifacts/`
   and `assets/` are the submission.

The updater is a **separate file, loaded second**. pi's loader catches per
extension path (`dist/core/extensions/loader.js:439-448`), so a sibling still
loads — and its factory still runs — when `notebook-tool.ts` throws at import.
That factory is the only code that executes on a launch pi has already decided
to kill, which is why the rollback lives there and runs synchronously. Second,
so `notebook-tool.ts` is already imported before anything is checked out from
under the loader. The marker helper is duplicated in both files on purpose:
share code between them and one syntax error takes down the toolkit *and* the
thing that repairs it.

## Why the checkout, and not just the pin

Measured on pi 0.84.2: **rewriting the pin does not move an already-installed
package.** `getGitInstallPath` keys the clone directory on host/path with no ref
component, and the startup `resolve()` reuses an existing directory as-is; only
the `pi update` / `pi install` CLI path reconciles. A module pinned `v0.8.0`
whose `.pi/settings.json` is edited to `v0.9.0` starts on `v0.8.0` forever,
without so much as a `FETCH_HEAD`. So the channel moves the checkout itself and
writes the pin to match.

## Turning it off

| | |
|---|---|
| one student, one machine | `PAIR_NOTEBOOK_NO_UPDATE=1 pi` |
| everyone, one commit | `"frozen": true` in `channel.json` |
| anything pi already skips | `PI_OFFLINE=1` is honoured |

## Rescues that live outside the channel

If a release ever does get through the gate, these are the repairs — and they
belong in the module README and the setup video, where no release can reach
them:

```sh
pi install git:github.com/skojaku/pi-pair-notebook@<known-good-tag> -l -a
```

Repairs the pin and the checkout together, and runs before any session or
extension machinery exists.

```sh
PI_OFFLINE=1 pi
```

Skips every package install, so even an unresolvable pin cannot fire. The tutor
will be missing — say so, or the silence reads as a second failure.

Do **not** publish `pi -ne`. It is what pi's own hint recommends, and it does
not work here: `--no-extensions` only filters the extension path list, while
package resolution still runs, so a bad tag crashes exactly as before.
