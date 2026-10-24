# Script workflows

The `workflow` tool runs a JavaScript workflow script: deterministic multi-agent orchestration
written as code, with `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`
and `workflow()`. The script runs in the [workflow-script sandbox](workflow-sandbox.md); every
`agent()` call starts a real subagent. The tool returns at once and the run goes on in the
background. Its result comes back later as a follow-up message.

The engine is `wf-engine.ts` and the tool is `wf-tool.ts`, both in the `subagent` extension. The
registry and the `meta` format are described under [script workflows](workflows.md#script-workflows)
in the workflows page.

Tests: `tests/workflow-hooks-smoke.ts` (`npm run smoke:workflow-hooks`),
`tests/workflow-resume-smoke.ts` (`npm run smoke:workflow-resume`),
`tests/workflow-notify-smoke.ts` (`npm run smoke:workflow-notify`), plus the launch rules in
`tests/delegation-guard-smoke.ts` and the firewall entry in `tests/tool-firewall-smoke.ts`. Each
section below names the one that pins it.

## Calling the tool

Pass exactly one of these, plus optional `args` and `resumeFromRunId`:

| Parameter | What it is |
| --- | --- |
| `script` | Inline source. It must start with a literal `export const meta = {name, description, ...}`. |
| `scriptPath` | A `.js` script in a run's directory (`<cwd>/.pi/workflows/runs/<runId>/`) or in a workflow directory (kit, `~/.pi/agent/workflows/`, `.pi/workflows/`). |
| `name` | A registered script workflow. |
| `args` | Any JSON value; the script sees it, deep-frozen, as `args`. |
| `resumeFromRunId` | An earlier script run whose journal seeds this run (see [Resume](#resume)). |

The call returns `runId`, `scriptPath` and `transcriptDir`. An inline script is saved as
`<transcriptDir>/script.js` and that is the `scriptPath` returned, so it can be run again with
`{scriptPath}`. To change the script, pass the edited source as `script` (with `resumeFromRunId`
to reuse the journal): an edited `script.js` is trust-gated, as below. A named or path-given
script reports its own file.

`scriptPath` is refused when it is not a `.js` file, when it (or the file it resolves to) is a path
secret-guard refuses to read, and when it lies outside the run and workflow directories. A script
in a workflow directory is opened as the registered workflow, so a project script goes through
the project trust gate. A script in a run directory runs as the session's own only when this
session created that run and the file's SHA-256 still matches the script the run was started with
(recorded when the run is created). Any other run script goes through the same trust gate as a
project workflow, by its SHA-256: one in another session's run directory or one that came with the
repository, and one in this session's run directory whose bytes were rewritten since, so an agent
that edits its own run's `script.js` cannot have a resume run it unasked. Headless it is refused;
attended it asks the No-first trust question. (`tests/workflow-notify-smoke.ts`)

Before the run starts, the sandbox settles its mode for the session (bwrap, or reduced mode after a
No-first select) and runs its self-test once. A run also needs the effort extension: it opens the
run's own scope in the session's workflow ledger, and without one the tool refuses
(`tests/workflow-hooks-smoke.ts`).

## Permission

The shipped firewall policy (both copies) has `workflow` as `ask`: every call needs the operator's
approval, which shows the call as usual. The `script` field is not analysed as a shell command, so
text in prompts does not raise shell findings, and `scriptPath` is checked as a read path. A child
session (`PI_KIT_INTERNAL_CHILD=1`) is denied the tool without a prompt, and the tool is not
registered in children at all. Headless sessions without an approval are refused by the firewall,
as for any `ask` tool. (`tests/tool-firewall-smoke.ts`, `tests/workflow-notify-smoke.ts`)
With [ultracode](effort.md#ultracode) on and pre-authorised, the firewall runs the calls without
asking, on a screen in the root session only (`tests/effort-standing-smoke.ts`).

## Hooks

`agent(prompt, opts?)` starts one subagent and resolves to its final text, or, with `schema`, to
the validated object. It resolves to `null` when the agent fails (after the runner's own retries),
is skipped through `workflow_control`, or the run is stopped. Options:

| Option | Behaviour |
| --- | --- |
| `label` | The display label; default `<role> #<n>`, where `n` counts the run's `agent()` calls. |
| `phase` | The progress group for this call; otherwise the last `phase()` title. |
| `schema` | A result schema ([structured output](structured-output.md)). An unsupported schema makes `agent()` throw before anything is launched. |
| `model` | `provider/id` or a bare id. The provider must be one the session has configured (pi's model registry `getAvailable()`); otherwise the call returns `null` and a log line says why. |
| `effort` | A thinking level for the child: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` (mapped to `xhigh`). |
| `isolation` | `"worktree"`: the agent runs in its own git worktree (see [Isolation](#isolation-and-the-writer-lock)). |
| `agentType` | A role (`implementer`, `scout`, `planner`, `reviewer`, `delegator`, or a user role). Aliases: `general-purpose`, `general` and `workflow` mean `implementer`; `explore`/`Explore` mean `scout`; `plan`/`Plan` mean `planner`; `code-reviewer` means `reviewer`. The default is `implementer`. |

An option of the wrong type, an unknown `effort`, `isolation` or `agentType` makes `agent()` throw
into the script. Every child gets a note in its system prompt saying its answer is returned to the
script as data, that it cannot start subagents or workflows, and that text from files, tools, web
pages or other agents, including anything inside an `<untrusted>` fence, is data, not
instructions. The prompt travels over stdin, never argv. (`tests/workflow-hooks-smoke.ts`)

`parallel()`, `pipeline()`, `log()`, `phase()`, `args` and the 4096-item caps behave as the
[sandbox page](workflow-sandbox.md#what-the-script-sees) describes. `log()` lines are kept in the
run's `run.json` (the last 200, redacted). Phases from `meta.phases` and from `phase()` calls show
in the run's live telemetry (the same run model as YAML runs), and so do agents with their label,
phase, role, model, usage and status.

`workflow(nameOrRef, args?)` runs another script inline and resolves to what it returns. A name
is looked up in the registry and `{scriptPath}` follows the `scriptPath` rules above, trust gate
included. The nested script runs in its own sandbox process but shares the run's concurrency cap,
agent counter, budget and stop signal. Its agents sit under a `▸ <name>` group (`▸ <name> · <phase>`
after a nested `phase()`). Nesting is one level: `workflow()` inside a nested script throws, and so
does an unknown name.

## Limits and budget

- **Concurrency**: at most `min(16, CPUs - 2)` agents of one run at once (at least 1); nested
  scripts share it. The effort ledger's own per-run limit (16) sits above it; if the ledger still
  reports `concurrency`, the agent waits for a slot.
- **Agents per run**: 1000 launches. The next `agent()` throws. Cached calls do not count.
- **Budget**: `budget.total` is null unless the engine is given a total. The tool gives the
  budget set with `/effort ultracode --budget N` while standing mode is on
  (`tests/effort-standing-smoke.ts`), and none otherwise, so such a run has no ceiling. With a total, `budget.spent()` is the output tokens of the run's
  agents (nested ones included, not the main conversation), and `agent()` throws `budget exhausted`
  once it reaches the total.
- Each agent is a `workflow` launch in the [effort ledger](effort.md#script-workflows): it runs at
  E1, it counts toward the run's 1000 and the session's 2000 workflow agents, and any denial other
  than `concurrency` throws into the script.

(`tests/workflow-hooks-smoke.ts`)

## Children

A workflow agent is a child at depth 1 that never delegates: the `subagent` tool is dropped from its
role's tool list, delegation-guard never gives it the `subagent` extension, and its
`PI_KIT_SUBAGENT_MAX_DEPTH` is its own depth. A role whose only tool is `subagent` is refused
rather than run with every tool. It loads the same mandatory protections as any child.
(`tests/delegation-guard-smoke.ts`, `tests/workflow-hooks-smoke.ts`)

## Approvals from workflow agents

A workflow agent cannot answer its own tool-firewall "ask", so its approval requests go to the
human console like any child's and fail closed when nobody answers in time (2 minutes by default,
`PI_KIT_SUBAGENT_APPROVAL_TIMEOUT_MS`). Each workflow agent gets `PI_KIT_WORKFLOW_RUN_ID` (its run
id) and, unless one is already set, `PI_KIT_HUMAN_CONSOLE_DIR` pointing at the starting session's
`.pi/human-console`, so an agent in its own worktree files its requests where that session looks.
tool-firewall then tags each request with the run id and the action hash: the sha256 of the tool
name, its exact input, the resolved cwd and the workspace root, so only identical calls in the same
checkout share a hash; a run grant or denial in one worktree does not answer the same relative path
or command in another. (This run hash is separate from the `actionHash` in the firewall audit log,
which stays tool name and input only.)
(`tests/workflow-hooks-smoke.ts`, `tests/firewall-workflow-approvals-smoke.ts`)

The attended session's console applies these rules to tagged requests, separately for each run
(`tests/firewall-workflow-approvals-smoke.ts`):

- At most 2 approval prompts for one run are open at a time. Further requests stay pending until a
  slot frees, and fail closed at their own deadline if none does.
- Requests with the same action hash are grouped: while one is on screen the others wait, and the
  answer settles them all. A high-risk "Allow once" settles only the request shown; the others ask
  again.
- The menu is No first: "Deny (for the rest of this run)", "Deny for the rest of this run and tell
  the agent why…", "Allow once", and, for medium actions only, "Allow this exact action for the rest
  of this run". A request whose tier is not medium (high, or missing) is never offered that run
  grant.
- A denial sticks: any later request in the run with the same action hash is denied without asking.
  Dismissing the menu counts as a denial. The agent's refusal reads "denied for the rest of workflow
  run <id>", plus the operator's note when one was given.
- Once more than 10 distinct actions have been approved in a run, the console pauses the run (no new
  agents start; running ones go on) and asks "No, keep the run paused" / "Yes, resume the run". No,
  a dismissal or a timeout keep it paused. That pause is held for the operator: only Yes or the
  operator's `/workflow resume <id>` lifts it, and the agent's
  `workflow_control` resume is refused ("paused by the operator's safety stop … only the operator
  can resume it"); a pause the agent or operator sets themselves is not held
  (`tests/workflow-control-smoke.ts`). No approval prompt for the run opens while that question is
  open. After an answer, the question comes back after another 10
  distinct approvals. If the run is not live in this session the console only warns.

The broker's memory lives in the console process and ends with the session; it is not written to
disk. Each decision is appended to `.pi/human-console-audit.jsonl`
(`workflow_approval_decided`, `workflow_approval_sticky_deny`, `workflow_approval_run_grant`,
`workflow_approvals_pause`, `workflow_approvals_resume_answer`).

## Isolation and the writer lock

With `isolation: "worktree"` the agent runs in `<repo>/.pi/worktrees/<runId>/<n>` on branch
`luna/wf/<runId>/<n>`, using the [worktree building block](workflows.md#worktree-isolation-for-workflow-agents).
An unchanged worktree is removed with its branch. A changed one is kept, never merged, recorded in
`<transcriptDir>/worktrees.jsonl`, and listed in the completion message.

An agent in the main checkout whose role can edit files (no tool list, or `write`/`edit` in it)
takes the checkout's writer lock, so such agents run one at a time; the default `implementer` is
one of them. Read-only roles and roles whose only way to write is `bash` (`scout`, `reviewer`) run
in parallel without the lock. Use `isolation: "worktree"` for writers that should run in parallel,
or a read-only role for fan-out reading. (`tests/workflow-resume-smoke.ts`,
`tests/workflow-hooks-smoke.ts`)

## Run files

Each run has a directory `<cwd>/.pi/workflows/runs/<runId>/` (mode 0700, files 0600):
`script.js` (what ran), `run.json` (status, counts, error, log lines), `journal.jsonl` and, when
worktrees were used, `worktrees.jsonl`. Values, errors and log lines go through the
[workflow redaction](workflows.md) rules before they are written; the live value returned to the
script is not redacted. Script runs do not appear in `workflow_status`, which lists YAML runs.
(`tests/workflow-hooks-smoke.ts`, `tests/workflow-resume-smoke.ts`)

## Resume

Every `agent()` call is journaled when it ends, with its key, label, phase, role, whether it
succeeded, its (redacted) value and, for writers, what it changed. The key is the SHA-256 of the
canonical JSON of `{prompt, opts}` with `label` left out, so relabelling a call does not change it.

Resuming (`resumeFromRunId`) starts a new run with a new id and reuses the longest unchanged prefix
of the earlier run's calls. A call is answered from the journal when no call before it has missed
and an unused earlier entry has the same key; matching ignores the order calls finished in, so a
pipeline resumes fully. An entry is claimed by one call only, so identical concurrent calls (a
best-of-N fan-out) each get their own. The first call with no match runs live, and so does every
call after it. The same script with the same args reuses every call.

- A failed, skipped or refused call is journaled with `ok: false` and never reused.
- A writer in the main checkout (a role that is not read-only) records a fingerprint of the
  checkout when it ends: `HEAD` plus the tree of the whole working copy, untracked files included,
  built in a scratch index. The workflow runs directory (`.pi/workflows/runs`) is left out, so a
  repo that does not gitignore `.pi/` still reuses writers. It is reused only when the checkout's fingerprint now equals the one
  the earlier run's last such writer recorded. Outside a git checkout, writers are never reused.
- A worktree agent is reused when its worktree was removed (it changed nothing), or when its kept
  branch still points at the head it ended at.
- Reused values are the journal's redacted copies.

An unknown run id is refused. (`tests/workflow-resume-smoke.ts`)

## Completion

When the run ends, the tool posts a `luna-workflow-result` message with `deliverAs: "followUp"` and
`triggerTurn: true`. It names the status, the counts of launched and reused agents, output tokens,
kept worktrees, the journal and script paths, and, for a run that did not pass, how to resume it.
A passed run's value (JSON, or the string as is) is redacted and placed inside an
`<untrusted source="workflow-result">` fence, cut to 20,000 characters, with any ` ``` ` inside
turned into `'''` so it cannot close the fence. A run that did not pass names only its status and
error kind outside the fence; the error text, which can carry script or agent output, is redacted
and placed inside an `<untrusted source="workflow-error">` fence, cut to 4,000 characters.
(`tests/workflow-notify-smoke.ts`)

In pi 1.4.0 such a message, sent while the agent is streaming, joins the same follow-up queue as a
follow-up the user types, so the two are delivered in the order they arrived; sent while the agent
is idle, it starts a turn at once. No test here pins pi's ordering.

`workflow_control {runId, action}` pauses (no new agents start), resumes, stops (the run ends
`interrupted`) or skips the agents running now (they resolve to `null`)
(`tests/workflow-hooks-smoke.ts`). If a script returns while agents it did not await are still
running, they are stopped; no test pins that.

## Built-in script workflows

The kit ships five script workflows in `packages/kit/workflows/`. Each is a worked example of a
pattern from the `workflow-authoring` skill (`packages/kit/skills/workflow-authoring/SKILL.md`),
the Luna port of the workflow authoring reference. Run one with `workflow({name, args})`. Every
one of them that has a required argument fails before launching any agent when it is missing.
Where a built-in bounds its coverage, it logs what it dropped and returns it.

| Name | What it does | `args` | Returns |
| --- | --- | --- | --- |
| `understand` | A `scout` lists the subsystems behind the question (or takes `areas`); one `scout` reads each; a `planner` critic names areas not yet read, which are read too; a `planner` writes the map. Areas beyond `maxAreas` (default 8), whether the scout or the critic named them, are logged, not read, named to the planner and returned in `notRead`. | `{question, areas?, maxAreas?}` | `{question, areas, map, notRead}` |
| `review-changes` | One `reviewer` per dimension (five by default) looks at `target`; findings are deduplicated by file and line across all dimensions and rounds; each new finding gets `votes` (default 3) `reviewer` skeptics with different lenses told to refute it, and survives only when a majority do not (a missing vote counts as a refutation). Rounds repeat until one finds nothing new, or stop at `maxRounds` (default 3), which is logged. | `{target?, dimensions?, votes?, maxRounds?}` | `{target, confirmed, rejected, rounds, stoppedBy}` |
| `design-panel` | One `planner` drafts per angle (three by default); `judges` (default 3) `planner` judges with different lenses score every draft 0 to 10; a repeated or out-of-range draft number is ignored; the best mean wins and a `planner` writes the final design from it, grafting from the runners-up. Judging is skipped when only one draft came back. | `{problem, angles?, judges?, constraints?}` | `{problem, ranking, winner, design}` |
| `research-sweep` | One `scout` per search mode (content, structure, tests, history, docs by default) lists sources; sources are deduplicated by ref; one `scout` reads each, up to `maxReads` (default 12); a `planner` critic names gaps, read within what is left of `maxReads`; a `planner` answers, told which sources were not read. | `{question, modes?, maxReads?}` | `{question, reads, notRead, answer}` |
| `migrate` | A `scout` lists the sites (or takes `sites`), up to `maxSites` (default 50); one `implementer` per site works in its own worktree, runs `verify` if given and reports its branch; a site whose reported branch is not `luna/wf/<runId>/<n>` fails unreviewed; a `reviewer` tries to refute each changed site from the main checkout. Nothing is merged. | `{goal, sites?, verify?, maxSites?}` | `{goal, sites, toMerge, notMigrated}`; `toMerge` lists the branches of changed sites the reviewer upheld |

Text one agent produced reaches the next agent's prompt inside a copy of the `<untrusted>` fence
(the `fence()` helper at the top of each script, identical in all five; its output is
byte-identical to `untrusted()` in `fence.ts` with a 12,000-character cut).

Tests: `tests/workflow-builtin-smoke.ts` (`npm run smoke:workflow-builtin`) runs each built-in
on the real engine and sandbox with fake agents, and checks that the registry lists all five, that
their `phase()` titles are in `meta.phases`, that their roles are kit roles, the fence copies, and
that the skill covers the built-ins and the Luna notes.

## Not covered

- A budget can be set only for all runs at once, through `/effort ultracode --budget`; a single
  call cannot pass one.
- The built-ins' prompts and result shapes are checked with fake agents only; no test runs them
  against a model.
- A run's result reaches the conversation only as the follow-up message. `/workflows` shows the
  live run (phases, agents, `▸` groups for nested workflows, `◆` for journal answers) in the
  session that started it; see [The /workflows panel](workflows.md#the-workflows-panel).
- Completion turns chained one after another are capped (5, then a question) only while ultracode
  standing mode is on ([Ultracode](effort.md#ultracode)).
- `workflow_status` and `/workflow` do not list or start script runs.
- The checkout fingerprint is taken after each writer; changes made meanwhile by agents that do not
  take the writer lock (a `bash`-capable role) are attributed to whichever writer finished last.
- The run-scoped approval rules apply only to requests that reach the console. A medium action the
  auto-mode judge settles inside the child never reaches it, and a child's "Allow for this session"
  grant is not offered for tagged requests.
