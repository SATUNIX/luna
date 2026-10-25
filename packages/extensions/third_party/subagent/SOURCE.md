# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/subagent/`
  (`index.ts` + `agents.ts`).
- Date: 2026-07-03
- Changes:
  - **Restored the full upstream mechanism** (this had previously been reduced to a single-shot
    spawner). Now vendored verbatim: single / parallel (concurrency 4, max 8) / chain (`{previous}`
    output threading) modes, agent-role discovery from `~/.pi/agent/agents/*.md` and
    `.pi/agents/*.md`, per-agent `model` + `tools` restriction, JSON-mode streaming of
    usage/cost/turns, and TUI rendering.
  - Imports pi bundled peers only (`@earendil-works/pi-tui`, `@earendil-works/pi-ai`,
    `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `typebox`) plus the local
    `./agents.ts` — self-contained per the kit lint.
  - `tsconfig.json` gains `allowImportingTsExtensions` so `import ... from "./agents.ts"` typechecks.
  - Role definitions (`planner`, `implementer`, `reviewer`, `scout`, `delegator`) are shipped and
    materialized by the `orchestrator` extension into `.pi/agents/`, not bundled here.
  - **Kit hardening for reliability** (2026-09-16):
    - Nested delegation with a depth guard. Each child receives `PI_KIT_SUBAGENT_DEPTH` = parent
      depth + 1; the tool refuses to spawn once depth reaches `PI_KIT_SUBAGENT_MAX_DEPTH` (default
      2, 0 disables delegation). A new `delegator` role carries the `subagent` tool so agents can
      delegate to agents without runaway fan-out.
    - Idle watchdog on by default (`PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS`, default 15 min, 0 disables).
      Previously the default was 0, so a child blocked forever wedged the parent's tool call.
    - `PI_KIT_SUBAGENT_DETACH_SIGNAL=1` lets a long child outlive a parent cancel instead of being
      SIGTERM'd with it.
    - Spawn failures are now captured and reported as `Subagent launch failed: <errno>` instead of
      a bare non-zero exit, and failures carry an actionable hint in their output.
    - Observability + recovery: every run writes `.pi/subagent/<id>.log` (child events + stderr +
      lifecycle) and start/end records to `.pi/subagent/runs.jsonl`; `runSingleAgent` returns
      `logPath` and tool output cites it on failures. A `subagent_status` tool lists recent runs and
      tails a log, and `packages/core/subagent-status.ts` (npm run subagent:status) does the same
      from a terminal, including `--follow`. Override the location with `PI_KIT_SUBAGENT_STATE_DIR`;
      children inherit the resolved top-level state dir so nested runs aggregate in one place.
      Per-token delta events are omitted from the log (the matching `message_end` carries the full
      content), so a long run no longer writes tens of thousands of synchronous lines or bloats the
      log to its cap.
    - Children DETACH by default when the parent tool call is cancelled (interrupt, turn end), so a
      long delegation is not silently destroyed and its result stays retrievable from the run log;
      set `PI_KIT_SUBAGENT_DETACH_SIGNAL=0` to restore kill-on-cancel.
    - Operator control: `subagent_stop` tool and `/subagent-stop [<id>|all]` command terminate
      running children (in-process, SIGTERM then SIGKILL) and recorded orphans by pid (verified on
      Linux against /proc before signalling). `/subagents` gives a check-in table; run pids are
      recorded in the registry so a later process can stop a child whose parent died.
    - Default stream cap raised from 64 MiB to 256 MiB; stored per-message text is bounded (200 KiB)
      with the full stream preserved in the run log, bounding parent memory without losing output.
    - The child's final assistant text is kept unbounded on the result (`finalOutput`) so chain mode
      and success output still receive the complete deliverable even though the stored message list
      is bounded. Parallel mode now reports `isError` when every task in the batch failed (a
      deliberately surfaced contract change; a 0/N batch is a real failure).
    - `subagent_status` validates its `id` against `^[A-Za-z0-9._-]+$` before reading a log, so a
      model-supplied id cannot traverse out of the state dir. The tool is allowlisted read_only in
      the shipped firewall policy.
    - Automatic retry of *transient* failures only: a spawn failure, or a non-zero exit with no
      usable output, is retried up to `PI_KIT_SUBAGENT_RETRIES` times (default 1) with
      `PI_KIT_SUBAGENT_RETRY_BACKOFF_MS` (default 2000) between attempts; usage is summed across
      attempts and `result.attempts` reports the count. Limits (timeout/stream-cap) and operator
      stops are never auto-retried because they may already have produced work.
    - A detached child (one still running after the parent stopped waiting) raises a UI notification
      when it finally finishes, via the `onSettled` hook, so a detached delegation is not forgotten.
    - Status surfaces (`subagent_status`, `/subagents`, `subagent-status.ts`) report turns, cost
      and attempt count per run; the stored message list is capped (400) so a very long child
      cannot grow parent memory without bound.
    - **Modularised** into `types.ts` / `config.ts` / `logging.ts` / `result.ts` / `child-process.ts` /
      `runner.ts` / `tools.ts` / `status.ts` / `live.ts` with a thin `index.ts`; the public API
      (`runAgent`, `runSingleAgent`, `getResultOutput`, `isFailedResult`, `projectRoleDigest`, the
      default export) is unchanged.
  - **Stuck-run recovery + live TUI progress** (2026-09-17):
    - **True detach.** `PI_KIT_SUBAGENT_DETACH_SIGNAL=1` (the default) used to only clear the
      child's abort signal while the parent kept `await`ing the still-open child, so a parent
      cancel or interrupt never returned control — the reported "tool-use counter stops and the
      main agent does not continue". The run now races the settle promise against the abort and
      returns immediately with `stopReason: "detached"` / `detached: true` / `runId`; the child
      keeps working and its outcome (log close + `onSettled` notification) is finalized in the
      background exactly once. `PI_KIT_SUBAGENT_DETACH_SIGNAL=0` still kills on cancel.
    - **Wall-clock ceiling** (`PI_KIT_SUBAGENT_MAX_RUNTIME_MS`, default 30 min, 0 disables). The
      idle watchdog keys on output, so a child that drips bytes could defeat it and run forever;
      this is the backstop. A wall-clock kill reports its own `stopReason: "wall-clock"`.
    - **Live heartbeat** (`PI_KIT_SUBAGENT_HEARTBEAT_MS`, default 5 s, 0 disables) emits a periodic
      elapsed/idle/bytes update while the child is silent, so a long tool call no longer looks
      frozen.
    - **Correct pi events.** `child-process.ts` previously looked for `tool_result_end`, which
      current pi does not emit; it now handles `tool_execution_start` / `tool_execution_end` and
      emits a live parent update naming the tool and target ("running read src/app.ts · 12s · …").
    - **Bounded headless approvals.** Internal children get a shorter `PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS`
      default (`PI_KIT_SUBAGENT_APPROVAL_TIMEOUT_MS`, default 2 min) so a tool-firewall "ask" the
      headless child cannot answer fails closed in minutes, not the 15-minute root default that
      raced the idle watchdog.
    - The subagent tool now drives a persistent TUI footer status (`ui.setStatus("subagent", …)`) for
      the duration of a delegation and clears it on finish; each update carries agent, step, turn
      count, elapsed time, last tool+target, and run id.
  - **Overhaul (2026-09-23):**
    - Built-in roles resolve from `packages/kit/agents` (trusted "kit" source) under user and
      project roles; the default scope finds them, headless children included. Role
      frontmatter gains `thinking`, `skills` (preloaded), `extensions`, `max_runtime`; a role's
      `model:` is honoured unless `PI_KIT_SUBAGENT_INHERIT_MODEL=1`.
    - Children are isolated (`--no-extensions` plus an allowlist); the task goes over stdin;
      stdout/stderr decode as UTF-8 streams.
    - Esc kills children (`background: true` opts into detached runs, delivered back as a
      session message); live children stop on session shutdown.
    - Run ids carry a random suffix; `runs.jsonl` is compacted; dead runs show `orphaned`.
    - Chain `{previous}` substitution is literal; chain returns the unbounded final output.
    - Workflows (`workflow.ts`, `workflow-tools.ts`): declarative step chains with a run
      directory, parallel groups, gates, resume.
    - Project-workflow trust is a No-first select ("No, don't run it" / "Run once" / "Trust this
      digest"); trusted digests are stored in `<agent dir>/pi-kit/trusted-workflows.json`, and
      headless runs are refused without a digest grant.
  - **Single governed launch contract (0.2.4-beta.0):** `isolation.ts` is gone and `launch.ts` is new.
    Every child, at any depth, is started through the `delegation-guard` extension
    (`packages/extensions/src/delegation-guard`), which decides the child's extensions (the parent's
    protections first, then companions), reserves a slot in the shared effort ledger and verifies the
    protections inside the child, failing closed. `runner.ts` reserves a slot per attempt and settles
    it; `result.ts` treats a denied or misconfigured launch (exit 78) as fatal, not retryable; role
    frontmatter gains `effort` and `scout`; `/workflow` launches are kind "user". The
    `PI_KIT_SUBAGENT_ISOLATE` switch no longer disables isolation. See `docs/agent-orchestration.md`.
  - **Read-only means read tools only:** `isReadOnlyRole` (`launch.ts`) counts only `read`, `grep`,
    `find` and `ls` as read-only, so a role with `bash` is not. `readOnlyTools` gives such a role's
    read tools to delegation-guard; when the guard charges the launch to the recovery budget it hands
    them back as `tools`, and `runner.ts` replaces the child's `--tools` with them. See
    `docs/effort.md`.
  - `loadInheritParentModel` checks the native settings file's `warnings.subagentInheritModel`
    field instead of casting the file; anything but `true` means false (nothing pins this).
  - **Workflow telemetry:** `run-model.ts` is new: an in-process run registry (`RunModel`, phases,
    per-agent records and events) that `workflow.ts` feeds. `runner.ts` gains an `onUsage` callback
    (running usage after each assistant message), and `live.ts` adds `workflows` (active runs) to
    the `pi-kit.subagents` snapshot. See `docs/workflows.md` ("Live telemetry").
  - **Workflow run control (E5 G4):** `control.ts` is new: one control per live run (an
    AbortController, a scheduler gate the executor awaits before each launch, and a child
    AbortController per running agent) behind `controlRun`. `workflow-tools.ts` adds the
    `workflow_control {runId, action}` tool, `/workflow pause|skip`, routes `/workflow stop` and a
    live `/workflow resume` through it, and asks a No-first select before a resume re-runs an
    interrupted writer step. See `docs/workflows.md` ("Pausing, stopping and skipping").
  - **Run-scoped approvals (E5 S7):** `control.ts` also publishes `controlRun` as
    `globalThis[Symbol.for("pi-kit.workflow-control")]`, so the human console can pause a run; its
    safety pause (origin `safety`) is held, and the `workflow_control` tool's resume (origin
    `agent`) is refused until the operator resumes the run. For a
    workflow launch `runner.ts` sets `PI_KIT_WORKFLOW_RUN_ID` (and drops it otherwise) and, when it
    is unset, points `PI_KIT_HUMAN_CONSOLE_DIR` at the starting session's console. See
    `docs/script-workflows.md` ("Approvals from workflow agents").
  - **Workflow-script sandbox (Luna, kit-original):** `wf-sandbox.ts` and `wf-runner.mjs` run one
    untrusted workflow script in raw QuickJS (the pinned `quickjs-wasi@3.6.3` dependency) under
    `node --permission`, `prlimit` and `bwrap`, and broker its hook calls as JSON lines. Nothing in
    the extension calls it yet. See `docs/workflow-sandbox.md`; pinned by
    `tests/workflow-sandbox-smoke.ts`.
  - **Structured results (E5 S3):** `runAgent` takes `schema`. `structured-output/check.ts` checks it
    before launch; `structured-output/index.ts` is the child-only `StructuredOutput` tool that
    `runner.ts` loads with `-e`; `schema.ts` is a byte-identical copy of
    `packages/role-runner/src/schema.ts`. The host re-validates the child's submitted arguments,
    retries once, then returns `null`. See `docs/structured-output.md`.
  - **Safe writes and shared redaction (2026-10-24):** run files, logs, the live state and the
    worktree journal are written through the generated `shared/safe-fs.ts` (no symbolic link
    followed under the workspace; temporary prompt files are created exclusively), `redact.ts`
    applies the kit's shared table (`shared/redact.ts`) after its own rules, and workflow gate
    patterns and structured-output patterns use the shared `shared/safe-regex.ts` check
    (`tests/workspace-symlink-smoke.ts`, `tests/redaction-corpus-smoke.ts`, `tests/workflow-smoke.ts`).
