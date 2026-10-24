# Workflows

A **workflow** is a saved chain of subagent steps. It runs on a **deterministic executor**, so
code rather than a model decides what runs next. Steps pass work to each other through a
shared **run directory** (the blackboard). A review gate can loop back to an earlier step.
An interrupted run can be resumed.

Use a workflow when the same multi-step delegation keeps coming up: plan → implement →
review, reproduce → fix → verify, or fan out → synthesise. For a one-off delegation, the
`subagent` tool (single, parallel or chain) is enough.

## Running

| Surface | Use |
| --- | --- |
| `/workflow list` | Available workflows and their inputs (`*` = required) |
| `/workflow run feature goal="add rate limiting to /api/orders"` | Start a run in the background. The footer shows progress, and the summary is posted into the session when it finishes. `/workflow run` with no name opens a picker. |
| `/workflow status [run-id]` | Recent runs, or one run's steps |
| `/workflows [run-id]` | The workflow panel: this session's runs with their phases, agents and narration (see [The /workflows panel](#the-workflows-panel)) |
| `/workflow pause <run-id>` | Pause a live run: it starts no new agents (see [Pausing, stopping and skipping](#pausing-stopping-and-skipping)) |
| `/workflow skip <run-id>` | Stop the agents running now, record their steps as `skipped`, and go on |
| `/workflow stop <run-id>` | Stop an active run (it can be resumed) |
| `/workflow resume <run-id>` | Unpause a live paused run; otherwise continue an interrupted or failed run from its current step |
| `workflow_run` tool | The agent runs a workflow itself: `{name, inputs}`, `{name: "list"}`, or `{resume: "<run-id>"}` |
| `workflow_status` tool | The agent inspects runs; a live run shows `(active)` or `(active, paused)` |
| `workflow_control` tool | The agent controls a live run: `{runId, action}` with `pause`, `resume`, `stop` or `skip` |

Esc cancels a `workflow_run` started by the agent. The current step's subagent is stopped,
the run is marked `interrupted`, and it can be resumed.

## Pausing, stopping and skipping

Every live run in the session has one control (`control.ts`). The `workflow_control` tool and the
`/workflow pause|resume|skip|stop` commands both call the same function (`controlRun`), so they
behave the same. Only runs started in this pi process can be controlled; any other run id is
refused with the list of live ones.

| Action | Effect |
| --- | --- |
| `pause` | The executor waits at its scheduler gate before it launches any agent, so a paused run starts no new agents. Agents already running keep running and finish. `state.json` gets `"paused": true` while it lasts, and the run model shows `paused`. |
| `resume` | Opens the gate; the next step launches. For a run that is not live, use `workflow_run {resume}` or `/workflow resume` instead. |
| `stop` | Aborts the run's AbortController, which stops its running agents. The run ends `interrupted` and can be resumed. A step that was waiting at a paused gate never launches and keeps its old status. |
| `skip` | Stops only the agents running now (each agent has its own AbortController under the run's). Their steps are recorded as `skipped` with the error "skipped by operator", and the run goes on: a later `when` sees `skipped`, and a parallel group whose members were skipped passes. A skipped step's `outputs:` check does not run. Skip never passes a review gate: a skipped gate step, or a skipped member of a group that has a `gate`, fails that gate, so the run loops back to `retry` (while `max_loops` lasts) or ends `failed`, and the step after the gate does not run. With nothing running, `skip` is refused. |

`workflow_control` is allowed by the shipped firewall policy as `process_control`, like
`subagent_stop`.

### Resuming an interrupted writer step

A run stopped while a step was running leaves that step `aborted` (or `running`, after a crash).
If that step can write, re-running it on resume would run on top of whatever it already changed.
A step is a writer unless every tool it can use (its `tools:`, or else its role's) is `read`,
`grep`, `find` or `ls`; a role with `bash` or with no tool list is a writer. So resuming a run
whose current step, or any unfinished member of its current parallel group, is an interrupted
writer asks first, with a select whose default is No:

- "No, leave the run interrupted" (also Esc): the run is not resumed.
- "Re-run the interrupted step(s)": resume as before.
- "Skip the interrupted step(s)": mark them `skipped`, then continue with the next step (or the
  group's other unfinished members). A skipped step that has a `gate` (or a skipped member of a
  gated group) fails that gate, as a live `skip` does: the run loops back to `retry` or ends
  `failed`.

A headless resume of such a run is refused. Steps that never launched, and read-only steps, ask
nothing.

Checked by `tests/workflow-control-smoke.ts` (`npm run smoke:workflow-control`), which also
checks that both firewall policy copies hold the same `workflow_control` rule.

## Where workflows live

| Location | Source | Trust |
| --- | --- | --- |
| `packages/kit/workflows/*.md`, `*.js` | shipped with the kit (YAML: `feature`, `bugfix`, `research`; scripts: [the built-ins](script-workflows.md#built-in-script-workflows)) | trusted |
| `~/.pi/agent/workflows/*.md`, `*.js` | yours, available in every project | trusted |
| `.pi/workflows/*.md`, `*.js` | the project's | needs a digest grant or interactive approval (see below) |

`*.md` files are YAML workflows (this page). `*.js` files are
[script workflows](#script-workflows). Both kinds share one set of names, and a later location
overrides an earlier one with the same `name`, whatever its kind. Luna reads only these
directories; Claude Code's `.claude/workflows/` is not read.

### Trusting a project workflow

A project workflow can start any delegated work, so before it runs (a new run or a resume,
from `workflow_run` or `/workflow`) Luna checks for a grant for the file's exact SHA-256:

- a digest listed in `PI_KIT_TRUSTED_WORKFLOWS` (`;`-separated), or
- a digest you trusted earlier, stored in `<agent dir>/pi-kit/trusted-workflows.json` (mode 0600).
  protected-paths blocks agent writes to that file, so the agent cannot plant a grant.

Without a grant, an interactive session asks with a select whose first, default option is No:

| Choice | Effect |
| --- | --- |
| `No, don't run it` (or Esc) | The run is cancelled. |
| `Run once` | This run goes ahead. Nothing is stored, so the next run asks again. |
| `Trust this digest` | This run goes ahead and the digest is stored, so later runs of the same file, headless ones included, are not asked. |

A headless session (no UI, for example `pi -p`) is refused unless a grant exists, and the error
names the digest to grant. Editing the file changes its digest, so the old grant stops applying.
A malformed store grants nothing. To revoke a grant, delete its entry from the store. These rules
are checked in `tests/workflow-smoke.ts`, and the protected store in `tests/protected-paths-smoke.ts`.

## Script workflows

A script workflow is a JavaScript file that starts with a literal `meta` object:

```js
export const meta = {
  name: 'find-flaky-tests',                       // required, same pattern as a YAML name
  description: 'Find flaky tests and propose fixes', // required, shown in the trust prompt
  whenToUse: 'CI shows retries',                  // optional, shown in the list
  phases: [{ title: 'Scan', detail: 'grep logs' }, { title: 'Fix', model: 'provider/model' }],
}
```

The registry reads `meta` without running the script. Only whitespace and comments may come
before it. It must be a pure literal: strings (template strings without `${}`), numbers,
`true`, `false`, `null`, arrays and objects with plain or quoted keys, plus comments and
trailing commas. Variables, calls, spreads, computed or shorthand keys, methods, regexes,
duplicate keys and `__proto__` are parse errors, and so is an expression that continues after
the literal (end it with `;` or a new line). `phases[]` entries need a `title` and may have
`detail` and `model` strings. Other keys are ignored. A script larger than 1 MiB is not listed,
and an entry named `*.js` that is not a regular file (a directory or a FIFO) is skipped silently
(`tests/workflow-registry-smoke.ts`).
Errors show up under "Invalid workflow files" in `/workflow list`. A YAML and a script workflow
with the same name in one directory is an error, and the script is skipped.

`workflow_run list` and `/workflow list` show script workflows as `(<source>, script)`. The
[`workflow` tool](script-workflows.md) runs them; `workflow_run` with a script's name returns an
error that points to it.

Opening a script for a run (`openScriptWorkflow` in `workflow-tools.ts`) applies the same trust
rules as a project YAML workflow: kit and user scripts open without a prompt, and a project
script needs a digest grant or the No-first select described above. A script's
`workflow(name)` call goes through the same function, with the calling workflow named in the
prompt, so a nested project script is gated as well. That includes a project script that
shadows a kit or user name. The script text it returns is the exact bytes whose SHA-256 was
checked. These rules are checked in `tests/workflow-meta-smoke.ts`
(`npm run smoke:workflow-meta`) and `tests/workflow-registry-smoke.ts`
(`npm run smoke:workflow-registry`).

## Format

A workflow is a Markdown file. The YAML frontmatter is the definition; the body is
documentation for people.

```yaml
---
name: feature                       # lowercase id; what /workflow run uses
description: One line shown in /workflow list
inputs:
  goal: { description: What to build, required: true }
  area: { description: Where to look, default: the whole repository }
vault: false                        # true: copy the finished run into the memory vault
steps:
  - id: scout                       # unique across the workflow
    agent: scout                    # a role: scout, planner, implementer, reviewer, delegator, or yours
    task: |
      Map the code relevant to: {{inputs.goal}} (look in {{inputs.area}})
  - id: plan
    agent: planner
    skills: [task-decomposition]    # SKILL.md bodies preloaded into this step's subagent
    task: |
      Plan {{inputs.goal}} using these findings:
      {{steps.scout.output}}
  - id: implement
    agent: implementer
    task: |
      Implement: {{steps.plan.output}}
      Previous review, if any: {{steps.review.output?}}
  - id: review
    agent: reviewer
    task: "Review against the plan: {{steps.plan.output}}"
    gate:
      pass: "/(?:^|\\n)VERDICT: PASS\\s*$/"     # text, or /regex/ (case-insensitive)
      retry: implement                            # an earlier top-level step to go back to
      max_loops: 2
---
```

### Step fields

| Field | Meaning |
| --- | --- |
| `id` | Required. `a-z0-9_-`, starting with a letter. |
| `agent` | The role to run. Required unless `skill` is given (which defaults the role to `implementer`). |
| `skill` | Shorthand for a step that exists to apply one skill: the skill is preloaded and the role defaults to `implementer`. |
| `task` | Required. The subagent's task, a template (see below). The subagent can't see anything else, so make it self-contained. |
| `skills` | Extra skills preloaded into the subagent's system prompt. |
| `tools` | Restrict the subagent's tools, e.g. `[read, grep, find, ls]`. |
| `extensions` | Extra kit extensions for the isolated child, e.g. `[memory-vault]` so it can call `memory_save`. |
| `model`, `thinking` | Per-step model (`provider/id`) and thinking level. The default is the role's `model:`, else the session model. |
| `max_runtime` | Wall-clock limit for this step: `90s`, `20m`, `2h`. |
| `outputs` | Files (relative to the run directory) the step must write. It fails if they are missing. |
| `when` | `{ step: <earlier id>, status: passed \| failed \| skipped }` (or a list). Otherwise the step is skipped. |
| `gate` | After the step passes, its output must match `pass`. If it doesn't, go back to `retry` (up to `max_loops`, default 2). When the loops run out, the run fails. A step skipped by `skip` or on resume fails its gate; a step skipped by its own `when` does not check it. |
| `continue_on_error` | A failure of this step doesn't fail the run. |
| `parallel` | A list of steps run concurrently (up to 4 at once) instead of `agent`/`task`. The group passes when every member passes. Groups can't nest. |

### Templates

| Expression | Value |
| --- | --- |
| `{{inputs.<name>}}` | A run input (after defaults) |
| `{{steps.<id>.output}}` | That step's final answer (for a parallel group: every member's answer under `## <id>`) |
| `{{steps.<id>.status}}` | `passed`, `failed`, `skipped`, … |
| `{{file:<path>}}` | A file in the run directory (up to 64 KiB). Paths can't leave the run directory. |
| `{{run.dir}}`, `{{run.id}}`, `{{loop}}` | Run directory, run id, current gate loop |

Add `?` to make a missing value empty instead of an error, for example
`{{steps.review.output?}}` on the first pass through a gate loop. Values are inserted
verbatim; nothing inside them is re-expanded.

## The blackboard (run directory)

Each run gets `.pi/workflows/runs/<run-id>/`:

```
state.json          status, current step, gate loops, per-step status/attempts/cost/run ids
steps/<id>.md       every step's final answer (what {{steps.<id>.output}} reads)
<anything else>     artefacts steps were asked to write, e.g. plan.md, report.md
```

Every step's subagent is told the run directory and the files already in it, so tasks can
say "write your findings to `findings.md`" and later steps can use `{{file:findings.md}}`.
Read-only roles (scout, planner) can't write files. Use their `{{steps.<id>.output}}`
instead. With `vault: true`, a passed run is copied to
`~/.pi/vault/Projects/<project>/Workflows/<run-id>/`, so it can be picked up from another
session or opened in Obsidian.

### Redaction and file modes

The executor redacts secrets before it writes `state.json` or `steps/<id>.md`: the run's
`inputs`, each step's answer and the step and run errors. Known secret shapes become
`[REDACTED]`. These are the rules the trace ledger applies to its targets (authorization headers,
`password`/`secret`/`token`/`api_key` assignments, `user:password@` in URLs, `sk-` and `gh*_`
tokens) plus secret-guard's content patterns (private key blocks, which are removed whole, AWS key
ids and secret keys, Slack tokens, GitHub tokens, `sk-` keys, credential assignments). Every
`state.json` written this way carries `"redacted": true` and a `redactionPolicy` name. This is
best-effort hygiene, not a security boundary. A secret in a shape the rules don't know is written
as is, and files a step writes itself are not touched.

Because a later step's `{{steps.<id>.output}}` reads `steps/<id>.md`, it gets the redacted
answer. A step's own prompt is built from the in-memory inputs, so it still gets the real input
values. A resumed run reads its inputs back from `state.json`, though, so it gets the redacted
ones.

The executor creates the run directory and `steps/` with mode 0700 and writes `state.json` and
`steps/<id>.md` with mode 0600, and it sets those modes again on each write. The redaction
rules are copies, because extensions are self-contained. `npm run verify` and
`tests/workflow-redaction-smoke.ts` fail if a copy stops being byte-identical to
`src/trace-ledger/index.ts` or `src/secret-guard/index.ts`. The same test checks that redaction runs in linear time on adversarial
input, and that a run's files are redacted and have the right modes.

Each step is an ordinary subagent run, so it also has a log under `.pi/subagent/`
(`/subagents`, `subagent_status id=<run>`). The step's run ids are recorded in
`state.json`. A corrupt or wrong-shape `state.json` is ignored and not listed by
`/workflow status`, rather than crashing the status listing. The persisted state must
also carry a non-negative integer `cursor` and a finite `executions` count, or it is
treated as corrupt and skipped the same way. Each entry in `steps` must be a mapping whose
`status` is one of the known step statuses and whose `attempts` and `cost` are numbers and
`runIds` is an array of strings, and every value in `loops` must be a number; otherwise the
whole state is treated as corrupt.

## Execution rules

- Steps run top to bottom. A failing step fails the run, unless it has `continue_on_error`.
- Gates loop back to `retry`, and every step from there to the gate runs again.
- A run is capped at 60 step executions, counting loops.
- Resuming re-runs the interrupted step (in a parallel group, only the members that hadn't
  passed) and continues from there. `inputs` and finished outputs are kept.
- Subagents in a workflow get the same governed launch as any subagent: `--no-extensions` plus
  the parent's protections, the companions and the step's `extensions`, with the child's own
  protection check (see [Agent orchestration](agent-orchestration.md#child-governance)). A subagent
  can't start another workflow.
- **Effort budgets apply.** `/workflow run` and `/workflow resume` are user-directed launches, limited
  only by the platform ceilings. The `workflow_run` tool, which the model calls, spends the
  discretionary [effort](effort.md) budget like any delegation and is hidden at E1. The `research`
  workflow starts three scouts at once, so as a model-started workflow it needs an effort tier that
  allows three scouts (E5); use `/workflow run research` at lower tiers.

## Live telemetry

While a workflow runs, the subagent extension keeps an in-process record of it, the run model
(`run-model.ts`). The run model is what a status view reads; it is not written to disk.

- **Phases.** Every top-level step is a phase, listed in definition order when the run starts.
  A phase is `pending`, `running`, `passed`, `failed`, `skipped` or `aborted`. On resume, phases
  start with the status saved in `state.json`; a step left `running` by a crash shows as `pending`.
- **Agents.** Every step execution is one agent, with id `<step id>#<n>`, so a step re-run by a
  gate loop appears as `implement#1`, `implement#2`. Members of a parallel group belong to the
  group's phase. Each agent records its label (the step id), phase, role, model, token usage
  (input, output, cache read and write, cost, turns), elapsed time and status (`running`,
  `passed`, `failed`, `skipped` or `aborted`), plus the subagent run id and the error text when
  there is one. Usage and the last progress line update after every child message, while the
  agent still runs. A step skipped by `when` is recorded as a `skipped` agent; a step whose
  template fails is a `failed` agent that never launched. In a script run an agent can also be
  marked `cached` (answered from a resumed run's journal) and carry the `group` (the nested
  `workflow()` it ran in), and a phase can name its `parent` group phase.
- **Runs.** A run records its kind (`yaml` or `script`), name, the workflow's description, definition file and source (kit, user or project), status (`running`, `passed`, `failed`,
  `interrupted`), whether it is paused, elapsed time, the usage summed over its agents and a
  count of approvals (`noteApproval`). A script run also records its sandbox mode, `budget.total`
  and the sha256 of the script it executed. A resumed run keeps its id,
  and its record starts again with this execution's agents. When a run ends, any agent still
  marked running is marked `aborted`. The registry keeps every active run and the 20 most
  recently finished ones.
- **Events.** Listeners receive `run_start`, `phase`, `agent` and `run_end` events, each with a
  copy of the record, a `control` event when a live run is paused or resumed, and an `approvals`
  event when an approval is counted. A listener that throws is ignored, so telemetry cannot fail a run.
- The `pi-kit.subagents` status snapshot (`{ live, finished, failures }`) also reports
  `workflows`, the number of workflow runs active in this process.

Records hold labels, ids, model names, counters and error text, never prompts or step outputs.
Checked by `tests/workflow-telemetry-smoke.ts` (`npm run smoke:workflow-telemetry`); the script-run fields (cached, group, parent, approvals, sandbox, budget, digest) by `tests/workflow-panel-smoke.ts`.

## The /workflows panel

`/workflows` shows the workflow runs of this pi session, read from the run model above
(`wf-panel.ts`). Runs started in another pi process are not shown; use `/workflow status` for
those. The panel is modelled on Claude Code's workflow panel and shows YAML runs and
[script workflow](script-workflows.md) runs (started by the `workflow` tool) alike; both can be
saved with `s`.

In the TUI it opens as an overlay on pi 1.3.0 or newer (on older pi, as a plain custom component,
the control-center hub's rule; `tests/workflow-panel-smoke.ts` checks the rule and the options
passed on the installed pi). It has two views:

- **Run list** (`/workflows`): one row per run, newest first, with a status dot, name, status,
  done/total agents, elapsed time and run id. ↑↓ select, Enter opens a run, Esc closes the panel.
- **Run view** (Enter on a run, or `/workflows <run-id>`):
  - a header with the workflow's name and description, then the run's status (and `paused`),
    done/total agents, how many were `cached` (when any), elapsed time and id. A third line holds
    the badges that apply: `sandbox: reduced` when the script ran in the reduced sandbox,
    `approvals: k` when the run model has counted k tool-firewall approvals for the run, and
    `budget: N% (used/total output tok)` when the run has a `budget.total` (warning colour from
    80%, error colour from 100%). The workflow engine does not count child approvals yet, and the
    `workflow` tool sets a budget only while ultracode standing mode has one (`/effort ultracode
    --budget N`), so otherwise only the sandbox badge appears for tool-started runs;
  - **Phases** with done/total: each phase's status dot, status and its done/total agents. A
    nested `workflow()` call shows as a `▸ <name>` group whose phases are indented under it; the
    group counts its own agents and those of its phases;
  - **Agents** with done/total: each agent's id (`<step id>#<n>`), model, tokens (input plus
    output; cache reads and writes are not counted), elapsed time and status with a coloured dot.
    An `agent()` call answered from a resumed run's journal (nothing launched) has a `◆` dot
    instead of `●`. Agents of a nested `workflow()` are indented under a `▸ <name>` line.
    ↑↓ select an agent; the selected agent's error, or else its last progress line, shows below
    the list. Ten agents show at a time and the list scrolls with the selection;
  - **Narrator**: the last six lines of the run's narration, such as `+14s scan#1 passed, 12.3k tok`.
    Narration starts when the extension loads and records run start and end, phase status
    changes, agent starts and ends (with tokens and the error; a journal answer is narrated as
    `reused from the journal`, and a nested workflow's lines start with `▸ <name>:`), pause and
    resume, and counted approvals. The last 40
    lines of each run are kept in memory; nothing is written to disk.
  - the footer keys `↑↓ select · k skip · x stop · p pause · s save · esc back`. Elapsed times
    tick once a second while the panel is open.

| Key | Effect |
| --- | --- |
| `x` | Stop the run. Asks first, inside the panel, with "No, keep it running" highlighted; Enter on it or Esc keeps the run, and only "Stop the run" stops it, through the same `controlRun` as `workflow_control`. A run that is not live has nothing to stop. |
| `k` | Skip the selected agent when it is running: it is cut off, recorded as `skipped` (its `agent()` call returns `null` in a script run) and the run goes on; other running agents are not touched. A finished agent, or a run that is not live, has nothing to skip. |
| `p` | Pause a live run, or resume it when it is paused (`controlRun`). The footer shows `p resume` while paused, for YAML and script runs. |
| `s` | Save the run's workflow into the project's `.pi/workflows/`. Asks first with "No, don't save" highlighted; when the file already exists the second choice is "Overwrite …", so an overwrite is No-first too. A YAML run's definition is copied under the same file name; the copy is a project workflow, so it overrides the kit or user workflow of the same name in this project and goes through the [trust prompt](#trusting-a-project-workflow) when it runs. A script run's script is saved as `.pi/workflows/<name>.js` only while the file still hashes to the sha256 of the script the run executed (checked when `s` is pressed and again at the write), and that digest is then trusted ("Trust this digest", in every project); for a script run the question names the sha256 and the second choice is "Save and trust …" or "Overwrite … and trust it", so the saved script runs without the trust prompt until the file changes. A run of a project workflow has nothing to save. The save is refused when `.pi`, `.pi/workflows` or the target file is a symlink (or not a directory / regular file), so a planted link cannot redirect the write outside the project. |
| `Esc` | Back from a run to the list, then close the panel. In a stop or save choice, Esc means No. |

Outside the TUI (RPC, `pi -p`, JSON mode) `/workflows [run-id]` prints the same content as text
(as a notification when the mode has a UI, otherwise on stderr): the list followed by every run,
or the one run asked for. The text lists each failed agent's error under it. A subagent child
does not register `/workflows`.

While a run is active the footer status (`setStatus`, key `workflows`) summarises it:
`wf <name>: done/total agents`, plus `paused`, `budget N%` and `approvals: k` when they apply, or
`wf: <n> running · done/total agents` (and how many are paused) for several runs. It clears when
no run is active. The subagent extension's `session_start` handler points it at the session's
footer (sessions with a UI only), and `session_shutdown` clears it.

Checked by `tests/workflow-panel-smoke.ts` (`npm run smoke:workflow-panel`): a render snapshot of
the run view and list, the keys, the No-first stop and save choices, a YAML run feeding the
panel, the text fallback and the overlay; for script runs, the `▸` groups, the `◆` dot and the
badges, `k` skip, the No-first script save (digest trusted, overwrite, an edited script refused),
the status line, and real engine runs (fake children) feeding the groups, `◆` on resume, the
sandbox badge, `p` pause, `k` and `s`. `tests/workflow-hooks-smoke.ts`
(`npm run smoke:workflow-hooks`) checks that a script run shows in the panel with its phases and
agents.

## Shipped workflows

- **feature**: scout → plan → implement ↔ review (gate).
- **bugfix**: reproduce → diagnose → fix ↔ verify (gate). The reviewer re-runs the
  reproduction itself.
- **research**: three parallel scouts (code, tests, history) → synthesis → durable facts
  saved to memory; the run is copied to the vault.

## Writing your own: checklist

1. Put it in `~/.pi/agent/workflows/<name>.md` (all projects) or `.pi/workflows/`.
2. Give every task everything the subagent needs. It sees only its task, preloaded skills,
   and the run-directory note.
3. Pass results between steps with `{{steps.<id>.output}}`. Use files only when a writing
   role produces an artefact.
4. Gate on something the role reliably prints, and anchor it so an echoed template or a quoted
   report can't match. The shipped `feature` and `bugfix` gates pass only when the reviewer's
   last non-blank line is `VERDICT: PASS`; `VERDICT: PASS or FAIL`, `Passing...`, or a PASS
   quoted before the reviewer's own FAIL all fail (checked in `tests/workflow-smoke.ts`).
5. `/workflow list` shows validation errors for files that don't parse.

## Worktree isolation for workflow agents

`packages/extensions/third_party/subagent/worktree.ts` gives a writing workflow agent its own git
worktree. The [script-workflow engine](script-workflows.md#isolation-and-the-writer-lock) uses it
for `agent(..., {isolation: "worktree"})` and its writer lock; the YAML workflows above do not.

- `createWorkflowWorktree({cwd, runId, index})` runs git in the `cwd` it is given (the tool's
  `ctx.cwd`). It creates `<repo>/.pi/worktrees/<runId>/<index>` on branch
  `luna/wf/<runId>/<index>` from the checkout's `HEAD`. `.pi/` is git-ignored, so the main checkout
  stays clean. A run id is letters, digits, `_` and `-` (up to 64), and the index is a
  non-negative integer.
- With the child's cwd set to the worktree, the worktree is its workspace: the worktree has its
  own `.git` file, which is where tool-firewall's workspace lookup stops.
- `finishWorkflowWorktree(tree, {journalFile})` removes the worktree and its branch when nothing
  changed (a clean status and `HEAD` still at the base commit). A changed worktree is kept with
  its branch and never merged. Its outcome (branch, head, commit count, whether it has uncommitted
  changes, and the reason) is appended to `journalFile` (mode 0600) when one is given. If git
  refuses the removal, the worktree is kept and journaled too. If the worktree was removed but
  its branch could not be deleted, the outcome is `removed` with a reason naming the branch.
- Before it runs git in the worktree, `finishWorkflowWorktree` checks that the worktree's `.git`
  file still names the git dir recorded at creation, and that git dir's `commondir` still names
  the common dir. If either changed, the worktree is kept and journaled without being inspected.
  Its git commands name that git dir explicitly and run with `core.fsmonitor=false`,
  `core.hooksPath=/dev/null` and `submodule.recurse=false`, and its status check uses
  `--ignore-submodules=dirty`, so it never enters a nested repo (whose config, such as a clean
  filter, the agent controls); a staged or moved gitlink still counts as a change. A planted
  fsmonitor command, hook or nested-repo clean filter does not run in the parent
  (`smoke:workflow-worktree`).
- At most 16 worktrees per checkout are live at once. A request beyond that waits for a slot
  rather than failing, and an abort signal cancels the wait.
- `withCheckoutLock(cwd, fn)` runs writers that work in the main checkout one at a time, in
  arrival order. The lock lives in this process, so it orders one pi session's writers, not
  other processes.
- `protected-paths` blocks writes to git's `hooks/`, `config`, `info/` and `worktrees/` in the
  repository's git common directory, and a linked worktree's own `.git` file, under both firewall
  policies. From inside a worktree it also blocks the main checkout's protected entries. What it
  finds for a cwd the first time (the session's cwd when it loads) is kept, so rewriting the
  `.git` file later drops none of it. A `.git` file that does not name a real git dir blocks every
  write (`tests/workflow-worktree-smoke.ts`).

Checked in `tests/workflow-worktree-smoke.ts` (`npm run smoke:workflow-worktree`).
