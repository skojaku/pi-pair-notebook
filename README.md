# pi-pair-notebook

A [pi](https://pi.dev) package that turns a coding agent into a **Socratic
tutor teaching one student inside a [marimo](https://marimo.io) notebook**.

The student talks to the tutor in the terminal; the notebook beside it is the
shared whiteboard, and it fills up as the lesson goes — figures, widgets, photos
of their pen-and-paper work, and notes quoting their own answers. What the
session produces is a notebook the student keeps and an instructor grades.

This is the machinery. The lesson is not in here: a **module folder** supplies
the curriculum, the premade cells and the tutor's behaviour contract, and this
package supplies the tools that operate on them. See
[`sk-classroom/advnetsci-pair-notebook-m02-small-world`](https://github.com/sk-classroom/advnetsci-pair-notebook-m02-small-world)
for a complete module.

Drop the lesson and the same tools make a **pair agent** for a team working in
their own notebook — a mini-project, where nothing is tutored and the notebook
is the assignment. One file decides which of the two a folder is; see
[The other shape](#the-other-shape-a-mini-project).

## What is in here

This repository is the software, and only the software. The teaching material
— chapter scripts, premade cells, the artwork, the notebook a module builds —
lives with the course, and a module pins a version of this by tag.

| | |
|---|---|
| `extensions/` | the pi extension: the `nb_*` toolkit, chapter orchestration, the checkpoint ceremony, the verbatim log, the referee |
| `setup/setup-pi.mjs` | the installer a student runs **before pi exists**, so it cannot be delivered as a pi package — a module vendors it at publish time. It writes the course provider block, `tutor` and `assistant` included (see below) |
| `review/` | the harness that drives a real session against a module: E2E setup and teardown, checkpoint probes, the widget and dialog drivers |

## Install

```bash
pi install git:github.com/skojaku/pi-pair-notebook@v0.9.0
pi install npm:@juicesharp/rpiv-ask-user-question@2.4.0   # required companion
```

A module folder normally declares both in its `.pi/settings.json`, and pi
installs them itself on startup — students run nothing by hand:

```json
{
  "packages": [
    "git:github.com/skojaku/pi-pair-notebook@v0.9.0",
    "npm:@juicesharp/rpiv-ask-user-question@2.4.0"
  ]
}
```

Requirements: pi ≥ 0.84 (Node ≥ 24) and `uv`, which is what actually runs the
notebook. Nothing else — the toolkit speaks HTTP to marimo from Node, so there
is no `bash`, `curl` or `jq` on a student's list. The tutor model may be
text-only; photographs are read by a separate vision model.

It also **runs the notebook server itself**: it starts
`uvx marimo edit --sandbox --no-token --headless notebook.py` when the session
opens, opens the student's page in their browser, and stops it when the session
ends. There is no launcher script to keep in step across module folders, and
nothing platform-specific in a shell.

The module's `.pi/settings.json` carries the rest of what a launcher used to
pass on the command line:

```json
{
  "defaultProvider": "netsci",
  "defaultModel": "tutor",
  "defaultThinkingLevel": "low",
  "hideThinkingBlock": true
}
```

So the student's whole command is `pi`.

### `assistant`, and why it is not this package's business

The installer writes a fourth model into the student's provider block,
`assistant`, and nothing in here ever names it. It is the same course key with
the tutor's Socratic contract removed — for lecture questions, the
mini-project, the rest of a course — and it exists as a separate alias
precisely so that loosening it cannot reach a graded session.

**The folder decides which one answers, so there is no flag to remember.** The
installer sets `netsci/assistant` as the global default in
`~/.pi/agent/settings.json`, and a module's own `.pi/settings.json` names
`netsci/tutor` — project settings beat global ones in pi, so `pi` is the tutor
inside a lesson and the assistant everywhere else. Same word, no wrong way to
start it. A student who already has a default of their own keeps it and is
shown the `--model` form instead; a settings file that will not parse is left
alone rather than replaced.

It is in the installer only because the installer is the one thing that writes
`~/.pi/agent/`, and pi will not use a model that is not declared in
`models.json`. The alias itself, and what it is allowed to be used for, belong
to the course gateway.

Which leaves the student who set up before the alias existed. Their clone pins
a toolkit tag and pi skips pinned packages on update, so a gateway that grows
an alias reaches them through nothing at all — the server serves it and their
pi refuses to offer a model it has no local declaration for. The repair is two
lines in a terminal, asked of the people least able to type them.

`nb_update_setup` is that repair as a tool: it reads the gateway's own
`/v1/models`, appends whatever the student's provider block is missing, and
does nothing else. It is deliberately **not** a system prompt telling the
tutor to edit the file — `models.json` is what makes pi run at all, and a
mangled write takes the tutor down with it, mid-lesson, on the machine of
someone who cannot get it back from a shell. So: an unreadable file is left
alone rather than "fixed", other providers are never touched, entries that
already exist are never rewritten, the student is asked yes/no first, and the
write is a temp file and a rename.

It needs a gateway whose `/v1/models` reports `input` — the modalities. A
gateway too old to send them would have every alias written down as text-only,
and `nb_view_image` would then find no image-capable model on the provider and
start asking students to describe their drawing in words: a silent,
plausible-looking failure caused by the tool that was meant to repair their
setup. So it declines instead. `name` and `reasoning` are cosmetic by
comparison and are allowed to default.

## What it gives the agent

One toolkit, `nb_*`, instead of raw bash and marimo code-mode boilerplate. The
model sends only cell bodies; the extension generates the plumbing, keeps the
student's terminal quiet (one friendly status line per call), and enforces the
things a prompt cannot.

| tool | does |
|---|---|
| `nb_add_template` | insert a premade, tested cell from the module's `cells/`. Refuses a build for a checkpoint that comes after the open one |
| `nb_add_cell` | an improvised cell — detours, fresh examples. Reviewed before insertion (see below) |
| `nb_add_exercise` | instructions + a pre-filled code box + ▶ Run, with a 📨 send button once it has run |
| `nb_edit_cell` / `nb_delete_cell` | fix or remove cells the tutor added |
| `nb_read` | read widget values out of the live notebook |
| `nb_view_image` | look at a student's uploaded photo through a vision model |
| `nb_run` | scratchpad Python — checking the student's arithmetic, never announcing it |
| `checkpoint_done` | the whole closing ceremony: append the log row, render the note cell from the script's skeleton with the student's verbatim words, ask what's next |
| `log_detour` | record an off-script question and the souvenir cell that answered it |
| `chapter_done` | gate the chapter transition on the student's own answer, write the handoff brief, load the next chapter |
| `nb_fresh_start` | clear the notebook when the student chooses to start over |
| `nb_update_setup` | add course models their pi does not know about yet, with their yes/no and a backup. Only when they ask (see above) |

Six behaviours are worth knowing about, because they are what make the
artifact trustworthy rather than plausible:

- **It puts the notebook back.** A 60–90 minute lesson outlives a closed tab, a
  sleeping laptop and an OOM-killed server, and any one of those used to end
  the notebook for the rest of the session — the tutor announced that the
  whiteboard needed restarting and nobody could restart it. A tab that has gone
  is reopened mid-wait; a server that has died is started again once a minute
  at most; and the student sees neither, only a tool call that took longer.
  A server someone else started (`MARIMO_URL`) is never touched.
- **The pickers take typed answers.** pi's `ctx.ui.select` swallows every
  printable key: a student answering by typing sees nothing appear and their
  Enter then picks whatever row the cursor is on. Both halves of that were
  reproduced live. Every picker this package opens therefore carries a
  ✎ *Let me type something instead* row, and the tutor is handed their actual
  words.

- **Chapter-at-a-time context.** The tutor never holds the whole curriculum.
  The extension injects one `CHAPTER SCRIPT` at a time and, at `chapter_done`,
  builds a handoff brief (progress, verbatim quotes, the tutor's own notes) and
  compacts the conversation with that brief as the summary. Same session, same
  visible transcript, fresh model context per chapter.
- **The student's words are copied, not retold.** Typed answers are captured
  from the transcript, and the note cell's «verbatim» slots are filled from that
  capture — anything the model sends for those slots is discarded. Pairing
  answers with slots by hand failed five different ways in five live runs.
- **`checkpoint_done` refuses.** No build for the checkpoint, no photo on a
  pen-and-paper checkpoint, an empty answer, a note that quotes words the
  student never typed, a chapter that is not finished. Every refusal names its
  own fix, and every one gives up after one or two tries and logs anyway — a
  guard that can strand a student is worse than the fault it catches.
- **Improvised cells are reviewed** (`extensions/nb_review.py`, Python AST, run
  in the kernel before insertion): marimo renders only a cell's last expression,
  so displays that would silently vanish get wrapped in one `mo.vstack`,
  unrescuable cells are refused with an instruction, and ASCII-art diagrams are
  flagged.

Two smaller ones in the same spirit: the checkpoint id a tool is given is
**snapped back onto the script** when it is a near miss (`cp3-clustering` for
`cp3_clustering` otherwise silently disables the note skeleton, both guards and
the closing tally at once), and the gaps a guard gives up on — a build that
never happened, a paper checkpoint with no photo, an appeal — are now **stamped
on the row and printed in the summary** instead of being written and read by
nobody.

There is also a **referee**: the notebook carries a ⚖️ box the student can press
to appeal over the tutor's head. The whole situation — their case, the log, the
script, the recent conversation — goes to a stronger model, and its ruling comes
back as a binding `REFEREE VERDICT` message. Appeals are logged as
participation, never as defiance.

## What a module folder must provide

The extension resolves everything from the **current working directory** — pi
runs in the module folder:

```
lesson/index.json          chapters, in order, each with a title + opening
lesson/ch*.yaml            checkpoints: goal, build, ask, accept, hints,
                           reveal_after, fresh_variants, note skeleton
cells/<name>.py            premade cell bodies, each with a `# describe:` line
                           that nb_add_template reads back to the tutor
assets/                    images the scripts refer to; uploads land here too
notebook.template.py       pristine starter notebook (imports + helpers only)
notebook.py                the working copy — the graded artifact
session_artifacts/         log, summary, archives, the student's signal file
AGENTS.md                  the tutor's behaviour contract, auto-loaded by pi
.pi/settings.json          packages, thinking level, compaction
```

Both `lesson/*.yaml` files and `cells/*.py` carry their schema in a header
comment. The one rule that is not obvious: **`cells/*.py` must be
self-describing.** `nb_add_template` returns the `# describe:` line and the
tutor is told to describe the artifact *only* from it — a tutor once called a
4-person network "5-person" because it was guessing.

## The other shape: a mini-project

A tutored module is one student, one lesson, one `notebook.py`. A
**mini-project** is a team of three in a Classroom repository whose notebook is
the assignment itself — no lesson, no checkpoints, nothing graded on how the
conversation went. The same toolkit is worth as much there: an agent that edits
the *live* notebook is the difference between a team watching their idea run
and a team told to re-run a file somebody changed behind their back.

**There is no mode to set.** A folder either has `lesson/index.json` in it or
it does not, and that one file decides:

| | tutored module | mini-project |
|---|---|---|
| the notebook | `notebook.py`, from the template | whatever the repository ships (below) |
| `bash` | taken away — a shell scrolls past a lesson | left on: it is a git repository and the team has to commit in it |
| `nb_add_cell`, `nb_edit_cell`, `nb_delete_cell`, `nb_read`, `nb_run`, `nb_view_image`, `nb_notebook_url` | ✓ | ✓ |
| `nb_add_template`, `nb_add_exercise`, `checkpoint_done`, `chapter_done`, `log_detour`, `nb_fresh_start`, `nb_submit` | ✓ | hidden — there is no script to close, no `cells/` to insert from, and `nb_fresh_start` would clear the assignment. `nb_submit` mints a `submit/…` tag, which means "grade this" for a Pair Notebook and nothing for a mini-project |

Which notebook, in order: `PAIR_NOTEBOOK_FILE`, then `pair-notebook.json`
(`{"notebook": "assignment/mini-project.py"}`), then `notebook.py` if it is
there, then — the common case — the one marimo notebook in the folder or one
level under it. Two candidates and no `notebook.py` is the only failure, and it
says so by name rather than claiming the notebook is unreachable. The choice is
written into `session_artifacts/marimo_server.log` at every start.

A mini-project repository therefore needs two files of its own:
`.pi/settings.json` naming this package (the toolkit does not exist in a folder
that has not asked for it — which is also why nothing here may be installed
globally: it starts a notebook server in whatever folder pi opens in), and an
`AGENTS.md` saying what the team's agent may and may not touch. The lesson
contract is not it.

## Environment

| variable | what |
|---|---|
| `MARIMO_URL` | an ALREADY RUNNING marimo server. Set it and the toolkit attaches instead of starting one — that is how the review harness pins a session. Unset (the normal case) it starts its own |
| `PAIR_NOTEBOOK_FILE` | the notebook to work in, relative to the folder pi started in. Overrides everything above; absolute paths and `..` are refused |
| `TUTOR_VISION_MODEL` | `provider/model-id` for reading photographs. Unset → an image-capable model on the tutor's own provider, then any zero-cost one; none found → the tutor asks the student to describe the drawing in words, which is a valid pass |
| `TUTOR_REFEREE_MODEL` | `provider/model-id` for the ⚖️ appeal. Unreachable → the tutor resolves the appeal itself, generously |

## Local development

```bash
pi -e /path/to/pi-pair-notebook/extensions/notebook-tool.ts   # load the working tree
```

`-e` also works under `--no-extensions`, which is how the review harness pins a
run to exactly one copy of the toolkit. To iterate against a checkout instead of
a tag, point `.pi/settings.json` at the directory: a local path package
(`"../toolkit"`, relative to the settings file) is loaded in place, without
copying.

Releases are pinned by tag. Bump `version` in `package.json`, tag `vX.Y.Z`, and
update the module folders that reference it — a module and its toolkit are
tested together, so nothing here floats on `main`.

## Credits

The two-call kernel protocol (`GET /api/sessions`, `POST /api/kernel/execute`)
was learned from [marimo-pair](https://github.com/marimo-team/marimo-pair),
whose `execute-code.sh` this package used to vendor and shell out to.
Dialogs come from
[`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono).
Everything else is MIT; see [`LICENSE`](LICENSE).

Built for **SSIE 641 Advanced Network Science** at Binghamton University.
