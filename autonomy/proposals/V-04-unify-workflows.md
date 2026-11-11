# Proposal — V-04: unify `/workflow` and `/workflows` (board item V-41)

- Run: `luna-ops-01`, cycle 04. Branch: `pi/luna-ops-01`. Date: 2026-11-11.
- Status: **record-only**. This proposal changes no code and no existing doc. It records the
  shipped behaviour, inventories the remaining callers, and names the follow-up doc sweep.
- Supersedes: the original pre-2026-11-11 design for V-04 (bare `/workflows` or a run id opening
  the panel; exported `runWorkflowCommand`) was superseded by commit `3c4c571`. That design must
  not be re-proposed or re-implemented.

## Evidence

Commands were run on this branch. The first two counts show the size of the grep; the filtered
caller output is the evidence base for the inventory in section 2. The handler and smoke-test
outputs are the evidence for section 1. `git show --stat 3c4c571` is the evidence for section 3.

```
$ git grep -n '/workflows\?\b' -- '*.ts' '*.md' '*.json' ':(exclude)autonomy/proposals/V-04-unify-workflows.md' | wc -l
629
$ git grep -n '/workflow' -- docs packages THIRD_PARTY_NOTICES.md ':(exclude)autonomy/proposals/V-04-unify-workflows.md' | wc -l
352
```

Both counts exclude this proposal file itself, so they stay reproducible once the file is tracked.
The filtered command below keeps only slash-command references; its `grep -E` drops filesystem
paths such as `.github/workflows/`, `.pi/workflows/`, `packages/kit/workflows/...` and
`tests/workflow-*.ts` because a `/` or `-` follows the name. It prints the 195 candidate command
lines the inventory in section 2 is built from. A few escaped path fragments in test regexes
(`tests/release-workflow-smoke.ts`, `tests/typescript-coverage-smoke.ts`) survive the filter; they
are path assertions, not command callers.

```
$ git grep -n '/workflows\?\b' -- '*.ts' '*.md' '*.json' ':(exclude)autonomy/proposals/V-04-unify-workflows.md' | grep -E '(^|[^A-Za-z0-9_.-])/workflows?([^A-Za-z0-9_/-]|$)'
CHANGELOG.md:48:  and `/recover` are removed: use `workflow_status`, `workflow_control`, `/workflows` and a bare
CHANGELOG.md:56:  Bare `/workflows` now lists runs instead of opening the panel; the panel is `/workflows panel [id]`,
CHANGELOG.md:57:  and `/workflows <run-id>` is now `/workflows status <id>`. `/workflow` is an alias of the same
CHANGELOG.md:114:  `/workflow run` and approved scripts are unchanged. See [Effort](docs/effort.md#plan-allowance)
CHANGELOG.md:132:  `partial`; a typed `/workflow resume` refuses a new expansion the same way. `expand` is refused with
CHANGELOG.md:382:  `subagent`. A typed `/workflow run` still works at E1, `workflow_status` and `workflow_control` stay
CHANGELOG.md:426:  `subagent` allowance. `/workflow run` and approved scripts are unchanged.
CHANGELOG.md:440:  `workflow_control` with `action: "stop"`; `/subagents` to `/workflows`; and
CHANGELOG.md:1182:- **The overlay tests pass on pi older than 1.3.0.** The control centre and the `/workflows` panel
CHANGELOG.md:1294:- **The /workflows panel for script runs.** A nested `workflow()` shows as a `▸ <name>` group in
CHANGELOG.md:1305:- **The /workflows panel.** `/workflows [run-id]` shows this session's workflow runs, modelled on
CHANGELOG.md:1335:  by the new `workflow_control {runId, action}` tool and `/workflow pause|resume|skip|stop`.
CHANGELOG.md:1341:  (`<agent dir>/workflows`) and project (`.pi/workflows`) directories are now listed by
CHANGELOG.md:1342:  `workflow_run list` and `/workflow list`, read from a literal-only `export const meta = {...}`
CHANGELOG.md:1522:  `/workflow resume <id>`); the agent's `workflow_control` resume is refused with a message saying
THIRD_PARTY_NOTICES.md:358:    frontmatter gains `effort` and `scout`; `/workflow` launches are kind "user". The
THIRD_PARTY_NOTICES.md:374:    `workflow_control {runId, action}` tool, `/workflow pause|skip`, routes `/workflow stop` and a
THIRD_PARTY_NOTICES.md:375:    live `/workflow resume` through it, and asks a No-first select before a resume re-runs an
THIRD_PARTY_NOTICES.md:466:    `registerWorkflowTools`' `spawnChild` seam reaches `/workflow` (`tests/workflow-plan-smoke.ts`).
autonomy/cycles/luna-ops-01/02/report.md:33:  re-register it — `a69f0ef` removed it and the panel is `/workflows`) and added
autonomy/cycles/luna-ops-01/04/plan.md:16:## Item B (V-41 [P2]): inventory `/workflow` and `/workflows`
autonomy/cycles/luna-ops-01/04/plan.md:26:  - every remaining `/workflow` or `/workflows` caller with an action for each: **change**, **keep**
autonomy/cycles/luna-ops-01/04/plan.md:28:  - a statement that the pre-2026-11-11 design (bare `/workflows` or a run id opening the panel,
autonomy/cycles/luna-ops-01/04/review.md:40:## V-41 [P2] V-04 part 1: inventory `/workflow` and `/workflows` callers
autonomy/cycles/luna-ops-01/04/review.md:46:  with `description: "Alias of /workflows. …"`.
autonomy/cycles/luna-ops-01/04/review.md:47:- Alias documented: `docs/reference.md:67` (alias) and `:68` (`/workflows`).
autonomy/cycles/luna-ops-01/04/review.md:54:Conclusion: the design landed in `3c4c571`; the original pre-2026-11-11 design (bare `/workflows`
autonomy/cycles/luna-ops-01/04/review.md:56:re-proposed. The genuinely open work is a documentation sweep of remaining `/workflow` callers,
docs/agent-orchestration.md:51:`delegation-guard` builds. Every launch path uses it: the `subagent` tool, `/workflow`, the
docs/agent-orchestration.md:137:operator surface `/workflows`); every run also writes `.pi/subagent/<id>.log` and
docs/agent-orchestration.md:164:- `/workflow run feature goal=…` / `bugfix` / `research`: the same flows as saved, resumable
docs/architecture/subagents-and-orchestration.md:85:| `.pi/subagent/<run id>.log`, `.pi/subagent/runs.jsonl` | `subagent` runner | `workflow_status`, `/workflows`, `workflow_control` |
docs/architecture/subagents-and-orchestration.md:244:| `/workflow run` and `/workflow resume` | `user` | isolated | You typed it, so only the platform ceilings bound it. |
docs/architecture/subagents-and-orchestration.md:368:runs with `workflow_control` or `/workflows stop`, and `session_shutdown` stops all live children. Every
docs/architecture/subagents-and-orchestration.md:409:    Running --> Stopped: workflow_control, /workflows stop or session_shutdown
docs/architecture/workflows-and-skills.md:5:Each step is a subagent launch like any other, so it goes through the delegation launch contract: `delegation-guard` decides which extensions the step's child loads and reserves a slot in the shared effort ledger. A `/workflow` command is launch kind `user`, because you typed it, and is bounded only by the platform ceilings. The `workflow_run` tool is launch kind `workflow`: it opens a run scope, is charged its worst case against the tier's plan allowance before anything starts, and is hidden at E1. `/workflow run` is not tier-limited. See [Subagents, orchestration and the task graph](subagents-and-orchestration.md) for the contract and [Effort](../effort.md) for the limits.
docs/architecture/workflows-and-skills.md:11:`discoverWorkflows` scans `*.md` (excluding `readme.md`) in `PI_KIT_WORKFLOWS_DIR` or the shipped kit directory, then the agent's `workflows` directory, then `<cwd>/.pi/workflows`, and a later source overrides an earlier one of the same name. Only project-sourced workflows are untrusted: they need an exact SHA-256 digest grant (listed in `PI_KIT_TRUSTED_WORKFLOWS`, or stored in `<agent dir>/pi-kit/trusted-workflows.json` by an earlier "Trust this digest") or the operator's answer to a No-first select ("No, don't run it" / "Run once" / "Trust this digest"), and the same check applies to a resumed run. A headless session has no select, so it is refused without a grant (`tests/workflow-smoke.ts`). `PI_KIT_INTERNAL_CHILD=1` means the workflow tools and the `/workflow` command are not registered inside a child at all. A step's role is resolved from the kit and user role directories only, so a project role cannot be used by a workflow.
docs/architecture/workflows-and-skills.md:22:    OVER --> RUN["workflow_run tool and /workflow command"]
docs/architecture/workflows-and-skills.md:40:    START["workflow_run or /workflow"] --> LOAD["discoverWorkflows, trust check, resolveInputs"]
docs/architecture/workflows-and-skills.md:76:The shipped `feature` workflow has four steps (`scout`, `plan`, `implement`, `review`) with the gate on `review`: the last non-blank line of its reply must be `VERDICT: PASS` (case is ignored), or the cursor goes back to `implement` with the review as feedback, at most twice. Invoked as a slash command, `/workflow` runs in the background as launch kind `user` and posts its summary into the session with `sendMessage` using `deliverAs: "followUp"`, while the `workflow_run` tool is launch kind `workflow`, charged its worst case against the tier's plan allowance before the first launch, and returns the summary plus the run directory. Aborting (Esc) cancels the active child and leaves the run `interrupted`, which can be resumed with `workflow_run {resume: id}` or `/workflow resume <id>`.
docs/architecture/workflows-and-skills.md:82:    participant T as workflow_run or /workflow
docs/architecture/workflows-and-skills.md:92:        U->>T: /workflow run feature goal=...
docs/architecture/workflows-and-skills.md:197:- `packages/extensions/third_party/subagent/workflow-tools.ts`: `workflow_run`, `workflow_status`, `workflow_control`, the `/workflow` command, the project-workflow trust prompt, the resume prompt for interrupted writer steps and the launch kind (`user` for the command).
docs/architecture/workflows-and-skills.md:199:- `packages/extensions/third_party/subagent/wf-panel.ts`: the `/workflows` panel (overlay in the TUI, text elsewhere) and its narrator, checked by `tests/workflow-panel-smoke.ts`.
docs/control-center.md:25:`/workflow` follows, so a subagent never advertises a terminal hub.
docs/control-center.md:37:| Work | Goal, todos, verify, delegation, recovery, memory, engagement, lab | `/goal`, `/todos`, `/verify`, `/orchestrate*`, `/workflows`, `/boost`, `/remember`, `/memory`, `/engagement`, `/improve`, `/review` |
docs/effort.md:115:| **User-directed** (`/workflow` and similar commands you run) | the platform ceilings only | You asked for it. |
docs/effort.md:152:tier you set to `maxTotal` 0) refuses with code `tier`, while `/workflow run` stays available there
docs/effort.md:203:with `/workflow` would, with a line saying the step cannot start other agents (`tests/effort-smoke.ts`).
docs/reference.md:67:| `/workflow` | `subagent` | Alias of /workflows. … | [workflows](workflows.md) |
docs/reference.md:68:| `/workflows` | `subagent` | Every workflow and subagent run, live or finished: list them, show one, stop one or all. … | [workflows](workflows.md) |
docs/script-workflows.md:183:  operator's `/workflow resume <id>` lifts it, and the agent's
docs/script-workflows.md:216:`workflow_status` and `/workflows`, labelled `script`.
docs/script-workflows.md:382:- A run's result reaches the conversation only as the follow-up message. `/workflows panel` shows the
docs/script-workflows.md:384:  session that started it; see [The /workflows panel](workflows.md#the-workflows-panel).
docs/script-workflows.md:387:- `workflow_status` and `/workflows` list script runs; `/workflow run` does not start them.
docs/structured-output.md:9:`subagent` tool, `/workflow` and YAML workflows do not expose it.
docs/workflows.md:16:| `/workflow list` | Available workflows and their inputs (`*` = required) |
docs/workflows.md:17:| `/workflow run feature goal="add rate limiting to /api/orders"` | Start a run in the background. The footer shows progress, and the summary is posted into the session when it finishes. `/workflow run` with no name opens a picker. |
docs/workflows.md:18:| `/workflow status [run-id]` | Recent runs, or one run's steps |
docs/workflows.md:19:| `/workflows` | Every run of this workspace, of every format, live or finished |
docs/workflows.md:20:| `/workflows panel [run-id]` | The workflow panel: this session's runs with their phases, agents and narration (see [The /workflows panel](#the-workflows-panel)) |
docs/workflows.md:21:| `/workflow pause <run-id>` | Pause a live run: it starts no new agents (see [Pausing, stopping and skipping](#pausing-stopping-and-skipping)) |
docs/workflows.md:22:| `/workflow skip <run-id>` | Stop the agents running now and record their steps as `skipped` |
docs/workflows.md:23:| `/workflow stop <run-id>` | Stop an active run (it can be resumed) |
docs/workflows.md:24:| `/workflow resume <run-id>` | Unpause a live paused run; otherwise continue an interrupted or failed run from its current step |
docs/workflows.md:111:  `/workflow resume` has no run scope to charge, so it refuses a new expansion the same way; it
docs/workflows.md:127:`/workflow pause|resume|skip|stop` commands both call the same function (`controlRun`), so they
docs/workflows.md:134:| `resume` | Opens the gate; the next step launches. For a run that is not live, use `workflow_run {resume}` or `/workflow resume` instead. |
docs/workflows.md:182:from `workflow_run` or `/workflow`) Luna checks for a grant for the file's exact SHA-256:
docs/workflows.md:223:Errors show up under "Invalid workflow files" in `/workflow list`. A YAML and a script workflow
docs/workflows.md:226:`workflow_run list` and `/workflow list` show script workflows as `(<source>, script)`. The
docs/workflows.md:247:name: feature                       # lowercase id; what /workflow run uses
docs/workflows.md:248:description: One line shown in /workflow list
docs/workflows.md:296:| `parallel` | A list of steps run concurrently (up to 4 at once in a run you start with `/workflow run`; in a model-started run, the tier's `maxConcurrent`) instead of `agent`/`task`. The group passes when every member passes. Groups can't nest. |
docs/workflows.md:369:(`/workflows`, `workflow_status {id: <run>}`). Such a step is not listed as a run of its own, but
docs/workflows.md:372:`/workflow status`, rather than crashing the status listing. The persisted state must
docs/workflows.md:394:- **Effort budgets apply.** `/workflow run` and `/workflow resume` are user-directed launches, limited
docs/workflows.md:445:## The /workflows panel
docs/workflows.md:447:Bare `/workflows` lists the runs of every format as text (`tests/run-query-smoke.ts`).
docs/workflows.md:448:`/workflows panel [run-id]` opens the panel, which shows the workflow runs of this pi session, read from the
docs/workflows.md:450:`/workflows` or `workflow_status` for those, and `workflow_status {id}` and `workflow_control` for
docs/workflows.md:459:- **Run list** (`/workflows panel`): one row per run, newest first, with a status dot, name, status,
docs/workflows.md:461:- **Run view** (Enter on a run, or `/workflows panel <run-id>`):
docs/workflows.md:496:Outside the TUI (RPC, `pi -p`, JSON mode) `/workflows panel [run-id]` prints the same content as text
docs/workflows.md:499:does not register `/workflows`.
docs/workflows.md:539:5. `/workflow list` shows validation errors for files that don't parse.
packages/extensions/src/control-center/doctor.ts:151:  if (r.subagents) lines.push({ label: "Subagents", value: r.subagents, command: "/workflows", ok: true });
packages/extensions/src/control-center/index.ts:12: * Nothing registers in an internal child session (`PI_KIT_INTERNAL_CHILD=1`), the rule `/workflow`
packages/extensions/src/control-center/model.ts:162:  { id: "subagents", label: "Subagents", page: "delegation", kind: "action", valueKey: "subagents", legacy: "/workflows" },
packages/extensions/src/control-center/model.ts:163:  { id: "workflow", label: "Workflows", page: "delegation", kind: "action", legacy: "/workflow" },
packages/extensions/src/effort/ledger.ts:20: *  - "user" launches are ones the person typed (a /workflow command): they are not the agent's own
packages/extensions/src/effort/strategy.ts:66:const REVIEW_STEER = "This is a large diff: `/workflow run review-changes` reviews it by dimension and checks its own findings.";
packages/extensions/src/human-console/index.ts:245:// workflow_control resume is refused; only the operator's Yes here or /workflow resume lifts it.
packages/extensions/src/human-console/index.ts:339:        // paused, the same as No: /workflow resume still lifts it.
packages/extensions/third_party/subagent/SOURCE.md:114:    frontmatter gains `effort` and `scout`; `/workflow` launches are kind "user". The
packages/extensions/third_party/subagent/SOURCE.md:130:    `workflow_control {runId, action}` tool, `/workflow pause|skip`, routes `/workflow stop` and a
packages/extensions/third_party/subagent/SOURCE.md:131:    live `/workflow resume` through it, and asks a No-first select before a resume re-runs an
packages/extensions/third_party/subagent/SOURCE.md:222:    `registerWorkflowTools`' `spawnChild` seam reaches `/workflow` (`tests/workflow-plan-smoke.ts`).
packages/extensions/third_party/subagent/control.ts:15: * resume (the `/workflow resume` command, the /workflows panel or the console's own Yes) clears
packages/extensions/third_party/subagent/control.ts:19: * state.json and the run model). The `workflow_control` tool, the `/workflow` command and a
packages/extensions/third_party/subagent/control.ts:142:        if (this.heldFlag && origin !== "operator") return { ok: false, message: `Run ${id} was paused by the operator's safety stop (too many distinct approvals); only the operator can resume it, with /workflow resume ${id} or from the console.` };
packages/extensions/third_party/subagent/control.ts:166:  /** Skip one running agent by its run-model id (the /workflows panel's `k`); the others go on. */
packages/extensions/third_party/subagent/control.ts:229:/** The process-wide registry that workflow_run, /workflow and workflow_control share. */
packages/extensions/third_party/subagent/control.ts:254:    return { ok: false, message: `No live run "${runId}" in this session.${live.length ? ` Live runs: ${live.join(", ")}.` : ""}${action === "resume" ? " To continue an interrupted run, use workflow_run {resume: \"<run-id>\"} or /workflow resume <run-id>." : ""}` };
packages/extensions/third_party/subagent/index.ts:21: *   run-query.ts      one view over every run format (`workflow_status`, `/workflows`)
packages/extensions/third_party/subagent/index.ts:22: *   wf-panel.ts       the /workflows panel (TUI overlay, text elsewhere)
packages/extensions/third_party/subagent/result.ts:71:  if (result.stopReason === "stopped") return "Stopped by operator (workflow_control or /workflows stop).";
packages/extensions/third_party/subagent/run-model.ts:56:/** What a run was started from: shown by the /workflows panel. Holds no prompts or inputs. */
packages/extensions/third_party/subagent/run-query.ts:17: * `workflow_status` and `/workflows` both read `queryRuns`, so the tool, the command and the
packages/extensions/third_party/subagent/run-query.ts:279:/** The list `workflow_status` and `/workflows` show: every format, newest first. */
packages/extensions/third_party/subagent/runner.ts:121:  // "user": a launch the person typed (a /workflow command), bounded only by the platform ceilings.
packages/extensions/third_party/subagent/status.ts:4: * Shared by `run-query.ts` (which `workflow_status` and `/workflows` read) and the stop path in
packages/extensions/third_party/subagent/status.ts:74: * Shared by the `workflow_control` tool and the `/workflows stop` command.
packages/extensions/third_party/subagent/status.ts:82:        ? `Running subagents (${running.length}):\n\n${formatRunTable(running)}\n\nStop one with workflow_control {runId: "<id>", action: "stop"} or /workflows stop <id>; all with all: true or /workflows stop all.`
packages/extensions/third_party/subagent/tools.ts:8: * workflow-tools.ts), and the operator surface is `/workflows`.
packages/extensions/third_party/subagent/tools.ts:195:    // The /workflows status line reports to this session's footer.
packages/extensions/third_party/subagent/wf-engine.ts:729:  // Pause and resume show in the run model (the /workflows panel) while the run is live.
packages/extensions/third_party/subagent/wf-panel.ts:2: * The /workflows panel (E5 slice G5): live workflow runs of this session, modelled on Claude Code's
packages/extensions/third_party/subagent/wf-panel.ts:4: * and controls this session's live runs only; `/workflows` (run-query.ts) is the surface that also
packages/extensions/third_party/subagent/wf-panel.ts:23: * control-center hub pattern) through `/workflows panel [run-id]`. Outside the TUI, that command
packages/extensions/third_party/subagent/wf-panel.ts:347:    out.push(paint.dim("No workflow runs in this session. Start one with /workflow run <name>."));
packages/extensions/third_party/subagent/wf-panel.ts:363:/** The panel's text fallback outside the TUI: `/workflows panel` (every live run) or `/workflows panel <run-id>`. */
packages/extensions/third_party/subagent/wf-panel.ts:862: * Start narrating the session's runs, and bind the panel to `/workflows panel [run-id]` (the
packages/extensions/third_party/subagent/wf-panel.ts:863: * command itself is registered in workflow-tools.ts, so `/workflow` is its alias).
packages/extensions/third_party/subagent/workflow-tools.ts:3: * `/workflows` and its alias `/workflow`). Pause, resume, stop and skip of a live run all go
packages/extensions/third_party/subagent/workflow-tools.ts:98:/** Record a "Trust this digest" grant (also used by the /workflows panel for a script it saved). */
packages/extensions/third_party/subagent/workflow-tools.ts:187:  if (!ctx.hasUI || !ctx.ui?.select) return `Blocked: run ${state.id} was interrupted while writer step(s) ${names} ran; they may have left partial changes. Resume it interactively (/workflow resume ${state.id}) to choose whether to re-run or skip them.`;
packages/extensions/third_party/subagent/workflow-tools.ts:577:/** A panel opener, bound by wf-panel.ts: the `/workflows` command's `panel` subcommand. */
packages/extensions/third_party/subagent/workflow-tools.ts:606:const COMMAND_USAGE = "/workflows | list | status [id] | panel [id] | run <name> key=value… | resume <id> | pause <id> | skip <id> | stop <id|all>";
packages/extensions/third_party/subagent/workflow-tools.ts:657:        const tail = producedResult(r.state.status) ? `\n\nFinal step (${last?.id}) output: ${dir}/steps/${last?.id}.md` : r.state.status === "interrupted" ? `\n\nResume with workflow_run {resume: "${r.state.id}"} or /workflow resume ${r.state.id}` : "";
packages/extensions/third_party/subagent/workflow-tools.ts:724:  // One command for both names: `/workflows` is the surface, `/workflow` is its alias. Bare
packages/extensions/third_party/subagent/workflow-tools.ts:725:  // `/workflows` lists runs of every format, past runs included; `list` keeps showing the saved
packages/extensions/third_party/subagent/workflow-tools.ts:813:      notify(`workflow ${name}: started${resume ? ` (resuming ${resume.id})` : ""}. /workflows status to follow, /workflows stop <id> to stop.`);
packages/extensions/third_party/subagent/workflow-tools.ts:861:    description: `Alias of /workflows. ${COMMAND_USAGE}`,
packages/kit/skills/agent-orchestration/SKILL.md:6:triggers: ["delegate this", "delegate to", "use subagents", "use sub-agents", "spin up agents", "spawn agents", "in parallel with agents", "planner agent", "implementer agent", "reviewer agent", "scout agent", "/workflow", "run a workflow", "run the workflow", "pi workflow", "use of subagents", "leverage subagents", "using subagents", "heavy use of subagents"]
packages/kit/skills/agent-orchestration/SKILL.md:51:- `/workflows` shows every run in the workspace, live or finished; `workflow_status` lists a
packages/kit/skills/workflow-authoring/references/scripts.md:28:  whenToUse: 'CI shows retries',                       // optional, shown in /workflow list
packages/kit/workflows/feature.md:68:Run it with `/workflow run feature goal="add rate limiting to the /api/orders endpoint"`, or
tests/docs-smoke.ts:423:  { kind: "command", name: "/subagents", replacement: "`/workflows`", pattern: /\/subagents(?=$|[\s"'`)\].,;:])/, removed: !registeredCommands.has("subagents") },
tests/docs-smoke.ts:435:assert.ok(registeredCommands.has("workflow") && registeredCommands.has("workflows"), "the subagent extension registers /workflows and its /workflow alias");
tests/effort-smoke.ts:909:  // /workflow run is a "user" launch, which the tier does not bound.
tests/effort-smoke.ts:937:      // /workflow run is a user launch: it is not the agent's own initiative, so E1 allows it.
tests/effort-standing-smoke.ts:205:    assert.match(noTool.last(), /workflow tool is not available/);
tests/effort-standing-smoke.ts:219:    assert.doesNotMatch(s.last(), /workflow tool is not available/, "the switch-on notice");
tests/effort-standing-smoke.ts:221:    assert.doesNotMatch(s.last(), /workflow tool is not available/, "the status line");
tests/firewall-overlay-queue-smoke.ts:879:      for (const command of ["/kit", "/workflows panel"]) {
tests/release-workflow-smoke.ts:106:    assert.match(jobs.get("gate") ?? "", /uses:\s*\.\/\.github\/workflows\/ci\.yml/, "the gate is the same CI workflow every pull request runs, by local path (the same commit)");
tests/release-workflow-smoke.ts:108:    assert.match(jobs.get("security") ?? "", /uses:\s*\.\/\.github\/workflows\/security\.yml/, "the security workflow of the same commit is a gate too");
tests/run-query-smoke.ts:11://   4. /workflows lists past runs; /workflow is an alias.
tests/run-query-smoke.ts:13://      recorded orphans; /workflows stop does the same.
tests/run-query-smoke.ts:268:// 4. /workflows lists past runs, and /workflow is an alias.
tests/run-query-smoke.ts:273:  assert.ok(workflows, "/workflows is registered");
tests/run-query-smoke.ts:276:  assert.ok(listed.includes(SCRIPT_ID), `/workflows must list a finished script run:\n${listed}`);
tests/run-query-smoke.ts:277:  assert.ok(listed.includes(YAML_ID), `/workflows must list a finished YAML run:\n${listed}`);
tests/run-query-smoke.ts:278:  assert.ok(listed.includes(SUBAGENT_ID), `/workflows must list a background subagent:\n${listed}`);
tests/run-query-smoke.ts:279:  assert.ok(!listed.includes(YAML_CHILD_ID) && !listed.includes(SCRIPT_CHILD_ID), `/workflows must not list a run's children:\n${listed}`);
tests/run-query-smoke.ts:281:  assert.ok(alias, "/workflow is still registered");
tests/run-query-smoke.ts:284:  assert.ok(seen.join("\n").includes(SCRIPT_ID), "/workflow is an alias of /workflows and lists the same runs");
tests/run-query-smoke.ts:290:  ok("/workflows lists past runs, /workflow is its alias, status <id> shows a past run, and panel opens the live view");
tests/run-query-smoke.ts:364:  // /workflows stop <id|all> uses the same paths.
tests/run-query-smoke.ts:378:  assert.equal(fake3.killed(), true, "/workflows stop all stops a live background child");
tests/run-query-smoke.ts:379:  ok("/workflows stop <id|all> stops background subagents through the same code");
tests/run-query-smoke.ts:400:  assert.match(notes.join("\n"), new RegExp(SUBAGENT_ID), "/workflows still lists the background subagent");
tests/run-query-smoke.ts:401:  ok("workflow_status is read_only and workflow_control process_control; the removed tools and commands are gone and /workflows still lists runs");
tests/subagent-observability-smoke.ts:134:  // 8. the removed commands are gone, and the surviving /workflows check-in still reports the run
tests/subagent-observability-smoke.ts:140:  assert.match(summary, new RegExp(runId), "/workflows must report the finished run");
tests/subagent-observability-smoke.ts:141:  assert.match(summary, /scout/, "/workflows must name the run's agent");
tests/subagent-roles-isolation-smoke.ts:313:    assert.ok(pi.commands.find("workflows"), "/workflows survives the trim");
tests/typescript-coverage-smoke.ts:29:  [/^packages\/kit\/workflows\/[^/]+\.js$/, "script workflows: the workflow tool runs them as plain JavaScript in the QuickJS sandbox, which does not strip types"],
tests/workflow-control-smoke.ts:15://   6. the workflow_control tool drives a live run through the same API; /workflow pause, skip,
tests/workflow-control-smoke.ts:17://      and yields to /workflow resume.
tests/workflow-control-smoke.ts:437:  // 6. The workflow_control tool and the /workflow command drive the same API.
tests/workflow-control-smoke.ts:471:    assert.equal(h.control.paused, false, "/workflow resume unpauses a live run");
tests/workflow-control-smoke.ts:473:    assert.equal(h.control.paused, true, "/workflow pause");
tests/workflow-control-smoke.ts:479:    assert.match(textOf(refused), /paused by the operator's safety stop .*only the operator can resume it, with \/workflow resume/);
tests/workflow-control-smoke.ts:482:    assert.equal(h.control.paused, false, "/workflow resume lifts a held pause");
tests/workflow-control-smoke.ts:487:    assert.match(notes.at(-1) ?? "", /Skipping a/, "/workflow skip");
tests/workflow-control-smoke.ts:494:    ok("workflow_control and /workflow pause|resume|skip|stop use the same control API; a safety-stop pause yields only to the operator");
tests/workflow-hooks-smoke.ts:5://      the /workflows panel (wf-panel.ts) lists the script run with its phases and agents.
tests/workflow-hooks-smoke.ts:664:    assert.match(panel, /Workflows \(1 run/, "the /workflows panel lists the script run");
tests/workflow-hooks-smoke.ts:668:    ok("parallel() and pipeline() run agents with labels and phases; a failed agent is null; log() lines and telemetry are recorded; /workflows shows the run");
tests/workflow-panel-smoke.ts:2:// Offline checks for the /workflows panel (wf-panel.ts, E5 slice G5).
tests/workflow-panel-smoke.ts:19://      its timer. `/workflows panel [id]` is the command that opens it (workflow-tools.ts).
tests/workflow-panel-smoke.ts:21://      extension registers /workflows and /workflow, and neither in a subagent child.
tests/workflow-panel-smoke.ts:230:    assert.deepEqual(P.renderListLines([], P.plainPaint), ["Workflows (0 runs, 0 active)", "No workflow runs in this session. Start one with /workflow run <name>."]);
tests/workflow-panel-smoke.ts:436:  // 8. Text outside the TUI; an overlay in the TUI (opened by `/workflows panel`).
tests/workflow-panel-smoke.ts:500:    assert.ok(pi.commands.find("workflows"), "/workflows is registered");
tests/workflow-panel-smoke.ts:501:    assert.ok(pi.commands.find("workflow"), "/workflow is registered as its alias");
tests/workflow-panel-smoke.ts:510:    assert.equal(child.commands.find("workflows"), undefined, "a subagent child has no /workflows");
tests/workflow-panel-smoke.ts:511:    assert.equal(child.commands.find("workflow"), undefined, "a subagent child has no /workflow alias");
tests/workflow-panel-smoke.ts:515:    ok("supportsOverlay matches control-center; /workflows and its alias registered, and neither they nor the workflow tools reach a child");
tests/workflow-plan-smoke.ts:869:/** `/workflow resume <id>` as an operator types it, to the summary it posts. */
tests/workflow-registry-smoke.ts:4://   1. `.js` scripts are found in the kit, user (<agent dir>/workflows) and project (.pi/workflows)
tests/workflow-telemetry-smoke.ts:120:    // "user" launches (a typed /workflow) are bounded by platform ceilings, not the effort tier's
```

```
$ sed -n '720,880p' packages/extensions/third_party/subagent/workflow-tools.ts
      return textResult(r.message, !r.ok);
    },
  });

  // One command for both names: `/workflows` is the surface, `/workflow` is its alias. Bare
  // `/workflows` lists runs of every format, past runs included; `list` keeps showing the saved
  // workflow definitions, and `panel` opens the live TUI panel.
  const runCommand = async (args: string, rawCtx: ExtensionContext): Promise<void> => {
    const ctx = rawCtx;
    const cwd = ctx.cwd ?? process.cwd();
    const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const notify = (m: string, l: "info" | "warning" | "error" = "info"): void => {
      if (ctx.ui?.notify) ctx.ui.notify(m, l);
      else process.stderr.write(`${m}\n`);
    };
    if (!sub) {
      notify(formatRunList(queryRuns(cwd)));
      return;
    }
    if (sub === "list") {
      notify(listText(cwd));
      return;
    }
    if (sub === "panel") {
      if (!panelOpener) {
        notify("The workflow panel is not available in this session.", "warning");
        return;
      }
      await panelOpener(ctx, rest[0]);
      return;
    }
    if (sub === "status") {
      const id = rest[0];
      if (!id) {
        notify(formatRunList(queryRuns(cwd)));
        return;
      }
      if (!isValidRunId(id)) {
        notify("Invalid run id.", "error");
        return;
      }
      const text = describeRun(cwd, id);
      notify(text ?? `No run "${id}".`, text ? "info" : "error");
      return;
    }
    if (sub === "stop" && rest[0] === "all") {
      notify(stopEveryRun(cwd, "operator"));
      return;
    }
    if (sub === "stop") {
      const r = stopRun(cwd, rest[0] ?? "", "operator");
      notify(r.message, r.ok ? "info" : "warning");
      return;
    }
    // A live run is controlled through control.ts; `resume` of a run that is not live
    // continues it from its state.json below.
    if (sub === "pause" || sub === "skip" || (sub === "resume" && runControls.has(rest[0] ?? ""))) {
      const r = controlRun(rest[0] ?? "", sub);
      notify(r.message, r.ok ? "info" : "warning");
      return;
    }
    if (sub === "run" || sub === "resume") {
      let name = rest[0];
      let inputs = parseKv(rest.slice(1));
      let resume: RunState | undefined;
      if (sub === "resume") {
        const s = loadState(cwd, rest[0] ?? "");
        if (!s) {
          notify(`No run "${rest[0] ?? ""}".`, "error");
          return;
        }
        resume = s;
        name = s.workflow;
      } else if (!name) {
        const { workflows } = discoverWorkflows(cwd);
        if (!ctx.hasUI || !ctx.ui.select || !workflows.length) {
          notify(listText(cwd));
          return;
        }
        const pick = await ctx.ui.select("Run workflow", workflows.map((w) => `${w.name} — ${w.description}`));
        if (!pick) return;
        const [picked = ""] = pick.split(" — ");
        name = picked;
        const w = workflows.find((x) => x.name === picked);
        if (!w) throw new Error(`workflow ${picked}: not found`);
        for (const [k, spec] of Object.entries(w.inputs)) {
          const v = ctx.ui.input ? await ctx.ui.input(`${name}: ${k}${spec.required ? " (required)" : ""}`, spec.description) : undefined;
          if (v === undefined && spec.required) return;
          if (v) inputs = { ...inputs, [k]: v };
        }
      }
      // Commands run outside a turn: the workflow runs in the background, drives the footer,
      // and posts its summary into the session when done so the agent can pick it up.
      notify(`workflow ${name}: started${resume ? ` (resuming ${resume.id})` : ""}. /workflows status to follow, /workflows stop <id> to stop.`);
      void startWorkflow(ctx, name, inputs, { resume, launchKind: "user", spawnChild: deps.spawnChild, onProgress: (t) => {
        ctx.ui?.setStatus?.("workflow", t.slice(0, 120));
      } })
        .then((r) => {
          try {
            ctx.ui?.setStatus?.("workflow", undefined);
          } catch {
            /* session may be gone */
          }
          const text = r.error !== undefined ? `workflow ${name}: ${r.error}` : `${summarizeRun(r.state, r.workflow)}\nRun directory: ${path.join(runsRoot(cwd), r.state.id)}`;
          try {
            pi.sendMessage({ customType: "workflow-result", content: text, display: true }, { deliverAs: "followUp", triggerTurn: false });
          } catch {
            notify(text, r.error || r.state?.status !== "passed" ? "warning" : "info");
          }
        })
        .catch((error: unknown) => {
          notify(`workflow ${name} crashed: ${String(error)}`, "error");
        });
      return;
    }
    notify(`Unknown subcommand "${sub}". ${COMMAND_USAGE}`, "error");
  };

  const completions = (prefix: string) => {
    const words = prefix.trimStart().split(/\s+/);
    if (words.length <= 1) return ["list", "panel ", "run ", "status", "resume ", "pause ", "skip ", "stop "].filter((v) => v.startsWith(words[0] ?? "")).map((v) => ({ value: v, label: v.trim() }));
    if (words[0] === "run" && words.length === 2) {
      const { workflows } = discoverWorkflows(process.cwd());
      return workflows.filter((w) => w.name.startsWith(words[1] ?? "")).map((w) => ({ value: `run ${w.name} `, label: w.name, description: w.description }));
    }
    if (["status", "panel", "pause", "skip", "resume", "stop"].includes(words[0] ?? "") && words.length === 2) {
      const ids = queryRuns(process.cwd())
        .filter((r) => r.id.startsWith(words[1] ?? ""))
        .map((r) => ({ value: `${words[0]} ${r.id}`, label: r.id, description: `${r.format}: ${r.name} (${r.status})` }));
      const all = words[0] === "stop" && "all".startsWith(words[1] ?? "") ? [{ value: "stop all", label: "all" }] : [];
      return [...all, ...ids];
    }
    return null;
  };

  pi.registerCommand("workflows", {
    description: `Every workflow and subagent run, live or finished: list them, show one, stop one or all. ${COMMAND_USAGE}`,
    getArgumentCompletions: completions,
    handler: runCommand,
  });
  pi.registerCommand("workflow", {
    description: `Alias of /workflows. ${COMMAND_USAGE}`,
    getArgumentCompletions: completions,
    handler: runCommand,
  });
}
```

```
$ sed -n '264,292p' tests/run-query-smoke.ts
  ok("queryRuns merges run.json, state.json, the unrelated runs.jsonl rows and the live registry");
  live.finish("passed");
}

// 4. /workflows lists past runs, and /workflow is an alias.
{
  const notes: string[] = [];
  const cmdCtx = { cwd: ws, hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
  const workflows = pi.commands.get("workflows");
  assert.ok(workflows, "/workflows is registered");
  await workflows.handler("", cmdCtx);
  const listed = notes.join("\n");
  assert.ok(listed.includes(SCRIPT_ID), `/workflows must list a finished script run:\n${listed}`);
  assert.ok(listed.includes(YAML_ID), `/workflows must list a finished YAML run:\n${listed}`);
  assert.ok(listed.includes(SUBAGENT_ID), `/workflows must list a background subagent:\n${listed}`);
  assert.ok(!listed.includes(YAML_CHILD_ID) && !listed.includes(SCRIPT_CHILD_ID), `/workflows must not list a run's children:\n${listed}`);
  const alias = pi.commands.get("workflow");
  assert.ok(alias, "/workflow is still registered");
  const seen: string[] = [];
  await alias.handler("", { cwd: ws, hasUI: true, ui: { notify: (m: string) => seen.push(m) } });
  assert.ok(seen.join("\n").includes(SCRIPT_ID), "/workflow is an alias of /workflows and lists the same runs");
  await alias.handler(`status ${SCRIPT_ID}`, { cwd: ws, hasUI: true, ui: { notify: (m: string) => seen.push(m) } });
  assert.match(seen.at(-1) ?? "", /Format: script/);
  // `panel` still reaches the live view, now through the one command.
  await workflows.handler("panel", cmdCtx);
  assert.match(notes.at(-1) ?? "", /^Workflows \(/);
  ok("/workflows lists past runs, /workflow is its alias, status <id> shows a past run, and panel opens the live view");
}
```

```
$ git show --stat --format='commit %H%nAuthor: %an%nDate: %ad%n%n%s' 3c4c571
commit 3c4c571e3a2fd3a9052dd339bd273e0a6d624c8c
Author: Hey Its Tony
Date: Mon Nov 9 15:50:26 2026 +1000

feat(subagent): one query and one control surface for every run (S9)

 CHANGELOG.md                                       |   8 +
 THIRD_PARTY_NOTICES.md                             |   8 +
 docs/agent-orchestration.md                        |   2 +-
 docs/architecture/subagents-and-orchestration.md   |  10 +-
 docs/reference.md                                  |  27 +-
 docs/script-workflows.md                           |   7 +-
 docs/workflows.md                                  |  23 +-
 packages/core/policies/default.json                |   8 -
 .../src/pentest-governance-domain/index.ts         |   2 +-
 .../src/tool-firewall/default-policy.json          |   8 -
 packages/extensions/third_party/subagent/SOURCE.md |   8 +
 .../extensions/third_party/subagent/extension.json |   2 +-
 packages/extensions/third_party/subagent/index.ts  |   5 +-
 packages/extensions/third_party/subagent/result.ts |   2 +-
 .../extensions/third_party/subagent/run-model.ts   |   2 +-
 .../extensions/third_party/subagent/run-query.ts   | 337 +++++++++++++++++
 .../extensions/third_party/subagent/status.ts      |  58 ++-
 .../extensions/third_party/subagent/tools.ts       | 115 +-----
 .../extensions/third_party/subagent/types.ts       |   2 +-
 .../extensions/third_party/subagent/wf-panel.ts    |  33 +-
 .../third_party/subagent/workflow-tools.ts         | 310 ++++++++++------
 .../extensions/third_party/subagent/workflow.ts    |   2 +-
 tests/effort-smoke.ts                              |   4 +-
 tests/firewall-overlay-queue-smoke.ts              |   2 +-
 tests/run-query-smoke.ts                           | 403 ++++++++++++++++++++-
 tests/subagent-observability-smoke.ts              |  23 +-
 tests/workflow-control-smoke.ts                    |  12 +-
 tests/workflow-panel-smoke.ts                      |  21 +-
 tests/workflow-plan-smoke.ts                       |  16 +
 29 files changed, 1128 insertions(+), 332 deletions(-)
```

```
$ git grep -n 'runWorkflowCommand\|workflowCommandCompletions\|WORKFLOW_SUBCOMMANDS' -- . ':!autonomy'
(no output: the identifiers exist only in autonomy/cycles/luna-ops-01/04/{plan,review}.md)
$ grep -n 'registerCommand' packages/extensions/third_party/subagent/wf-panel.ts
(no output: wf-panel.ts registers no command)
```

## 1. Shipped behaviour

The shipped code has **one command handler** for both names, in
`packages/extensions/third_party/subagent/workflow-tools.ts`:

- `const runCommand = async (args: string, rawCtx: ExtensionContext): Promise<void> => {`
  at `:727`, under the comment "One command for both names: `/workflows` is the surface,
  `/workflow` is its alias" (`:724-726`).
- `pi.registerCommand("workflows", { ... handler: runCommand })` at `:855-859`.
- `pi.registerCommand("workflow", { ... description: "Alias of /workflows. ...", handler: runCommand })`
  at `:860-864`.

Semantics from the handler (`:727-835`):

| Input | Behaviour |
| --- | --- |
| bare `/workflows` (or bare `/workflow`) | `notify(formatRunList(queryRuns(cwd)))` — lists runs of every format. |
| `/workflows list` | `notify(listText(cwd))` — shows the saved workflow definitions. |
| `/workflows panel [id]` | calls the bound `panelOpener(ctx, rest[0])`; opens the panel. |
| `/workflows status <id>` | `describeRun(cwd, id)` — describes one run. `status` with no id lists runs. |
| `/workflows stop <id\|all>`, `pause <id>`, `skip <id>`, `resume <id>`, `run <name> ...` | the remaining control and launch branches. |
| a bare run id (e.g. `/workflows <id>`) | **not** a panel open. It matches no subcommand and falls through to `Unknown subcommand "<sub>". ...` at `:835`. The panel is reached only through `panel [id]`. |

The alias is the same handler: `/workflow` accepts exactly the same subcommands and arguments as
`/workflows`. The smoke test pins the shared registration and the main behaviours:
`tests/run-query-smoke.ts:268-291` (quoted in the evidence above) asserts that `/workflows` is
registered, that a bare `/workflows` lists finished script, YAML and background-subagent runs and
does not list a run's children, that `/workflow` is still registered and lists the same runs,
that `/workflow status <id>` shows a past run (`Format: script`), and that `panel` reaches the live
view through the one command. The test does not separately assert the bare-run-id fallthrough; the
handler's final `notify(\`Unknown subcommand ...\`)` at `:835` is what prevents a bare run id from
opening the panel.

The generated reference documents both rows at `docs/reference.md:67-68`: `:67` is the alias row
(`/workflow`, "Alias of /workflows. ...") and `:68` is the canonical surface (`/workflows`, "Every
workflow and subagent run ..."). The file's header says it is auto-generated by
`packages/core/reference.ts` and must be regenerated with `npm run catalog`, not hand-edited.

`packages/extensions/third_party/subagent/wf-panel.ts` **registers no command**. It exports the
panel, its renderer and `registerWorkflowPanel`, which binds the opener and the narrator; the
command itself is registered in `workflow-tools.ts`. The grep for `registerCommand` in `wf-panel.ts`
returns no output. This matches `docs/workflows.md:499` ("A subagent child does not register
`/workflows`.") and the module comment at `wf-panel.ts:862-863` ("the command itself is registered
in workflow-tools.ts, so `/workflow` is its alias").

**Module-locals.** The review's design vocabulary names `runWorkflowCommand`,
`workflowCommandCompletions` and `WORKFLOW_SUBCOMMANDS` as intentional module-locals and says they
must not be exported. The shipped tree does not contain those identifiers; the grep in the evidence
section finds them only in the cycle 04 plan and review. The equivalent shipped locals are
`runCommand` (`:727`), `completions` (`:838`) and `COMMAND_USAGE` (`:606`). None is exported. The
intent stands unchanged: the command handler, its completions and its subcommand list are
module-locals and must not be exported. The exported surface is `registerWorkflowTools`, the
workflow helpers and `bindWorkflowPanelOpener`, not the command implementation.

## 2. Remaining `/workflow` and `/workflows` callers

This table is built by reading every hit in the evidence section — the filtered 195-line view and
the raw 629-line list behind it — and classifying each line individually. **keep (alias)** means the
singular `/workflow` is intentionally the working alias (or a legacy/trigger/history reference) and
is correct as written. **keep (canonical)** means the plural `/workflows` is already the surface.
**change** means the text uses the singular as the primary command name and should say `/workflows`
in the follow-up doc sweep. **regenerate** means the file is generated; do not hand-edit it.

| File and lines | Occurrences | Action | Why |
| --- | --- | --- | --- |
| `docs/workflows.md:16-18,21-24,111,127,134,182,223,226,247,248,296,372,394,539` | singular `/workflow ...` | **change** to `/workflows ...` | user-facing command table and prose; the canonical surface is `/workflows` |
| `docs/workflows.md:19-20,369,445,447-450,459,461,496,499` | plural `/workflows ...` | **keep (canonical)** | already the surface; `:499` also records that a child registers no command |
| `docs/script-workflows.md:183,387` | singular `/workflow resume` and `/workflow run` | **change** to `/workflows ...` | operator-facing prose; canonical surface |
| `docs/script-workflows.md:216,382,384` | plural `/workflows ...` | **keep (canonical)** | already the surface |
| `docs/agent-orchestration.md:51,164` | singular `/workflow` and `/workflow run ...` | **change** to `/workflows ...` | user-facing launch-path and manual-entry prose |
| `docs/agent-orchestration.md:137` | plural `/workflows` | **keep (canonical)** | already the surface |
| `docs/architecture/subagents-and-orchestration.md:244` | singular `/workflow run` and `/workflow resume` | **change** to `/workflows ...` | architecture table's launch-kind row |
| `docs/architecture/subagents-and-orchestration.md:85,368,409` | plural `/workflows ...` | **keep (canonical)** | already the surface |
| `docs/architecture/workflows-and-skills.md:5,11,22,40,76,82,92,197` | singular `/workflow ...` | **change** to `/workflows ...` | architecture prose and diagrams; canonical surface. `:11` states the internal-child rule (`PI_KIT_INTERNAL_CHILD=1` means the `/workflow` command is not registered), the same rule as `control-center/index.ts:12`. |
| `docs/architecture/workflows-and-skills.md:199` | plural `/workflows` | **keep (canonical)** | already the surface |
| `docs/control-center.md:25` | singular `/workflow` | **change** to `/workflows` | control-centre rule prose; canonical surface |
| `docs/control-center.md:37` | plural `/workflows` | **keep (canonical)** | already the surface |
| `docs/effort.md:115,152,203` | singular `/workflow` and `/workflow run` | **change** to `/workflows ...` | effort prose; canonical surface |
| `docs/structured-output.md:9` | singular `/workflow` | **change** to `/workflows` | structured-output prose; canonical surface |
| `docs/reference.md:67-68` | alias row `:67`, canonical row `:68` | **keep; regenerate** | generated by `packages/core/reference.ts`; `npm run catalog` regenerates it. No hand edit. |
| `CHANGELOG.md:48,56-58,114,132,382,426,440,1182,1294,1305,1335,1342,1522` | singular and plural command references | **keep (history)** | changelog entries describe past releases; do not rewrite history. `:56-58` records the 3c4c571 change itself. |
| `THIRD_PARTY_NOTICES.md:358,374-375,466` | singular `/workflow ...` | **regenerate** | generated from `packages/extensions/third_party/subagent/SOURCE.md` by `node packages/core/gen-notices.ts`, not by `npm run catalog`. Change SOURCE.md first, then regenerate. |
| `packages/extensions/third_party/subagent/SOURCE.md:114,130-131,222` | singular `/workflow ...` | **change** to `/workflows ...` | source of the generated third-party notices; then regenerate notices |
| `packages/extensions/third_party/subagent/control.ts:15,19,142,229,254` | singular `/workflow ...` | **change** to `/workflows ...` | comments and operator-facing refusal text; canonical surface. `:142` tells the operator to use `/workflow resume`; `:254` repeats the resume hint. |
| `packages/extensions/third_party/subagent/control.ts:166` | plural `/workflows panel` | **keep (canonical)** | already the surface |
| `packages/extensions/third_party/subagent/workflow-tools.ts:3,98,577,606,724-725,813,861` | plural surface and explicit alias comments | **keep (canonical/alias)** | `:3` and `:724-725` state the surface/alias split; `:861` is the alias description; the rest are plural |
| `packages/extensions/third_party/subagent/workflow-tools.ts:187,657` | singular `/workflow resume` | **change** to `/workflows resume` | operator-facing resume hints in the interrupted-writer message and result tail |
| `packages/extensions/third_party/subagent/wf-panel.ts:347` | singular `/workflow run` | **change** to `/workflows run` | operator-facing empty-panel hint |
| `packages/extensions/third_party/subagent/wf-panel.ts:2,4,23,363,862,863` | plural surface and explicit alias | **keep (canonical/alias)** | `:863` states the alias; the rest are plural |
| `packages/extensions/third_party/subagent/index.ts:21-22` | plural `/workflows` | **keep (canonical)** | module map |
| `packages/extensions/third_party/subagent/result.ts:71` | plural `/workflows stop` | **keep (canonical)** | operator-facing stop text |
| `packages/extensions/third_party/subagent/run-model.ts:56` | plural `/workflows panel` | **keep (canonical)** | comment |
| `packages/extensions/third_party/subagent/run-query.ts:17,279` | plural `/workflows` | **keep (canonical)** | comment and list definition |
| `packages/extensions/third_party/subagent/runner.ts:121` | singular `a /workflow command` | **change** to `/workflows command` | launch-kind comment; canonical surface |
| `packages/extensions/third_party/subagent/status.ts:4,74,82` | plural `/workflows ...` | **keep (canonical)** | comments and stop text |
| `packages/extensions/third_party/subagent/tools.ts:8,195` | plural `/workflows` | **keep (canonical)** | comments |
| `packages/extensions/third_party/subagent/wf-engine.ts:729` | plural `/workflows panel` | **keep (canonical)** | comment |
| `packages/extensions/src/control-center/doctor.ts:151` | plural `/workflows` | **keep (canonical)** | command value |
| `packages/extensions/src/control-center/index.ts:12` | singular `/workflow` | **change** to `/workflows` | internal-child rule comment; canonical surface |
| `packages/extensions/src/control-center/model.ts:162` | plural `/workflows` | **keep (canonical)** | action value |
| `packages/extensions/src/control-center/model.ts:163` | singular `legacy: "/workflow"` | **keep (alias/legacy)** | explicitly a legacy alias mapping |
| `packages/extensions/src/effort/ledger.ts:20` | singular `a /workflow command` | **change** to `/workflows command` | launch-kind comment; canonical surface |
| `packages/extensions/src/effort/strategy.ts:66` | singular `/workflow run review-changes` | **change** to `/workflows run review-changes` | model steer; canonical surface |
| `packages/extensions/src/human-console/index.ts:245,339` | singular `/workflow resume` | **change** to `/workflows resume` | comments describing the operator's resume path |
| `packages/kit/skills/agent-orchestration/SKILL.md:6` | trigger `"/workflow"` | **keep (alias)** | skill trigger, not a command; the alias is intentional |
| `packages/kit/skills/agent-orchestration/SKILL.md:51` | plural `/workflows` | **keep (canonical)** | already the surface |
| `packages/kit/skills/workflow-authoring/references/scripts.md:28` | singular `shown in /workflow list` | **change** to `/workflows list` | authoring reference prose; canonical surface |
| `packages/kit/workflows/feature.md:68` | singular `/workflow run feature ...` | **change** to `/workflows run feature ...` | shipped workflow example; canonical surface |
| `tests/*` (e.g. `tests/run-query-smoke.ts:268-291`, `tests/docs-smoke.ts:423,435`) | singular and plural | **keep** | tests pin the alias and the canonical surface; changing them would weaken the pin |
| `autonomy/cycles/luna-ops-01/04/{plan,review}.md`, `autonomy/cycles/luna-ops-01/02/report.md:33` | the task record | **keep** | records of this inventory; not callers to sweep |

The table deliberately does not list filesystem paths such as `.github/workflows/`,
`.pi/workflows/`, `packages/kit/workflows/` (`docs/EXTENSIONS.md:58` names one), `docs/workflows.md`
as a document name, or test names like `workflow-smoke`; those are not slash-command callers. The
raw first grep (629 lines) includes them; the filtered command in the evidence section prints the
195 candidate command lines the table is checked against.

## 3. Superseded design — do not re-propose or re-implement

Commit `3c4c571` ("feat(subagent): one query and one control surface for every run (S9)") is the
change that unified the surfaces. Its commit message states the compatibility explicitly:

> Compatibility: bare `/workflows` used to open the panel and now lists runs; the panel moved to
> `/workflows panel [id]`, and `/workflows <run-id>` is now `status <id>`. `/workflow` keeps working
> as the alias of both.

The original pre-2026-11-11 design in this item — a bare `/workflows` or a run id opening the panel,
and an exported `runWorkflowCommand` — was superseded by `3c4c571`. It **MUST NOT** be re-proposed or
re-implemented. The shipped contract is the one in section 1: one handler, two command names,
`list`/`panel [id]`/`status <id>` as separate subcommands, and a bare run id is not a panel open.

The review's design names (`runWorkflowCommand`, `workflowCommandCompletions`,
`WORKFLOW_SUBCOMMANDS`) do not exist in the shipped tree; the actual module-locals are `runCommand`,
`completions` and `COMMAND_USAGE`, and they must not be exported. Re-introducing the old names or an
exported handler would reopen the design that `3c4c571` closed.

## 4. Follow-up: doc sweep (not performed here)

This proposal is a record only. It does **not** perform the doc sweep and changes no code or existing
doc. The follow-up is a separate, reviewable change that updates the **change** rows in section 2 to
the canonical `/workflows` wording:

- `docs/workflows.md` (16-18, 21-24, 111, 127, 134, 182, 223, 226, 247, 248, 296, 372, 394, 539)
- `docs/script-workflows.md` (183, 387)
- `docs/agent-orchestration.md` (51, 164)
- `docs/architecture/workflows-and-skills.md` (5, 22, 40, 76, 82, 92, 197)
- `docs/architecture/subagents-and-orchestration.md` (244)
- `docs/control-center.md` (25)
- `docs/effort.md` (115, 152, 203)
- `docs/structured-output.md` (9)
- `packages/extensions/third_party/subagent/SOURCE.md` (114, 130-131, 222), then regenerate
  `THIRD_PARTY_NOTICES.md` with `node packages/core/gen-notices.ts` (not `npm run catalog`)
- `packages/extensions/third_party/subagent/control.ts` (15, 19, 142, 229, 254)
- `packages/extensions/third_party/subagent/workflow-tools.ts` (187, 657)
- `packages/extensions/third_party/subagent/wf-panel.ts` (347)
- `packages/extensions/third_party/subagent/runner.ts` (121)
- `packages/extensions/src/control-center/index.ts` (12)
- `packages/extensions/src/effort/ledger.ts` (20)
- `packages/extensions/src/effort/strategy.ts` (66)
- `packages/extensions/src/human-console/index.ts` (245, 339)
- `packages/kit/skills/workflow-authoring/references/scripts.md` (28)
- `packages/kit/workflows/feature.md` (68)

The sweep should **not** touch:

- `docs/reference.md` or `docs/EXTENSIONS.md` by hand; they are generated and regenerated with
  `npm run catalog`.
- `CHANGELOG.md`; its singular references are history.
- explicit alias/legacy/trigger rows (`docs/reference.md:67`, `control-center/model.ts:163`,
  `agent-orchestration/SKILL.md:6`, the alias comments in `workflow-tools.ts` and `wf-panel.ts`).
- tests; they pin both names and the shared handler.
- the cycle 04 plan and review; they are the record for this item.

After the sweep, run `npm run -s docs:check`, `npm run -s smoke:docs` and the targeted workflow
smokes. The generated files must be regenerated only through their generators; a hand edit fails
the drift checks.

## Verification for this record

This file was created as the only change on the branch. The checks run for the record are:

```
$ git status --short
?? autonomy/proposals/V-04-unify-workflows.md
$ npm run -s docs:check
$ npm run -s smoke:docs
```

The two commands are expected to exit 0; the exact exit codes and outputs are recorded in the
commit message. `npm test` and `npm run check:all` are not run here (they take 10+ minutes each; the
host gate runs them).
