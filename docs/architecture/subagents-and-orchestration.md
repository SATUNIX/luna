# Subagents, orchestration and the task graph

The subagent subsystem lets a root pi session delegate a self-contained task to a separate `pi`
process with its own context. The `subagent` tool resolves a role from the kit, user and project
agent directories, then asks `delegation-guard` how to start the child. That launch contract is the
one place that decides which extensions a child loads, reserves the child's slot in the shared effort
ledger and hands back the child's environment. Every child loads the mandatory protections its
parent has (`tool-firewall`, `secret-guard`, `protected-paths`) and every governance extension the
parent runs, that is, each one whose manifest declares `childGovernance: true`. Its effort tier is
never above its parent's. A launch that cannot meet the contract is refused, and a child that starts
without a protection its parent has blocks every tool call and exits with code 78. Roles run in
single, parallel or chain mode, and chain threads each step's output into the next step through a
`{previous}` placeholder. Background and detached runs report back through follow-up messages, while
Esc, `session_shutdown` and `subagent_stop` provide cancel and kill paths. On top of this, the
`orchestrator` extension is a context and steering layer, and the `task-graph`, `verifier-board` and
`human-console` extensions share file contracts under `.pi/` to plan work, record independent
verdicts and broker approvals.

For the tier table and the limits, see [Effort](../effort.md). For the operator-facing summary of the
rules on this page, see [Child governance](../agent-orchestration.md#child-governance).

## Component map and data flow

This flowchart shows the runtime pieces and where their state lives. The orchestrator writes
context-contribution and classification files and reads the verdict board. The `subagent` tool drives
child processes through the launch contract and records run state. The task graph and verifier board
are tools the agents call, and they and the human console each own a small file contract under the
project `.pi` directory. Children reserve against the same ledger as the root, so delegation cannot
multiply by nesting.

```mermaid
flowchart LR
    root["Root pi session"]
    orch["orchestrator extension"]
    contrib[".pi/ctx-contributions/sessions/ID/orchestrator.json"]
    cls[".pi/task-classification/sessions/ID.json"]
    sieve["context-sieve"]
    tg[".pi/task-graph.json"]
    vb[".pi/verdicts.json"]
    goal[".pi/GOAL.yaml, written by goal-core"]
    vg["verify-gate"]
    subgraph launch["Launching a child"]
        tool["subagent tool"]
        roles["Role resolution: kit, user, project"]
        runner["runner: runAgent"]
        guard["delegation-guard: prepareChild"]
        ledger[("Effort ledger, one file per request")]
        child["Child pi process, mode json"]
        fw["tool-firewall in the child"]
    end
    subgraph runstate["Run state"]
        state[".pi/subagent/RUN_ID.log and runs.jsonl"]
        live["Live registry, in process"]
    end
    human[".pi/human-console pending and resolved"]
    root --> orch
    orch --> contrib
    orch --> cls
    contrib --> sieve
    sieve -->|"steering text"| root
    vb -->|"read by the completion gate"| orch
    root --> tool
    tool --> runner
    roles --> runner
    runner -->|"kind, role, tier"| guard
    guard -->|"reserve a slot"| ledger
    guard -->|"args, env, slot"| runner
    runner -->|"spawn, task on stdin"| child
    child -.->|"reserves for its own children"| ledger
    child --> fw
    fw -->|"pending approval"| human
    human -->|"resolved answer"| fw
    runner --> state
    runner --> live
    root --> tg
    root -->|"record_verdict"| vb
    goal --> vg
    vg -->|"verify and review verdicts"| vb
```

The file contracts, and who touches them:

| File | Written by | Read by |
|---|---|---|
| `.pi/subagent/<run id>.log`, `.pi/subagent/runs.jsonl` | `subagent` runner | `subagent_status`, `/subagents`, `subagent_stop` |
| `<agent dir>/pi-kit/effort/ledgers/<scope>.json` | `effort` (root opens it, every descendant reserves in it) | `effort`, `/effort status` |
| `.pi/task-graph.json` | `task-graph` tools | `task-graph` tools, `verify-gate` (definition of done) |
| `.pi/verdicts.json` | `verifier-board`, `verify-gate`, `conductor` validator | `orchestrator`, `verifier-board` |
| `.pi/verify-pending/<run>.json` (legacy `.pi/verify-pending.json` still read), `.pi/verify-report.md` | `verify-gate` | `orchestrator`, `conductor` (pending marker) |
| `.pi/ctx-contributions/` | `orchestrator` | `context-sieve` |
| `.pi/task-classification/sessions/<session id>.json` (`.pi/task-classification.json` for a session without an id) | `orchestrator` | `provider-router`, same session only (`tests/model-routing-smoke.ts`) |
| `.pi/human-console/pending` and `resolved` | `tool-firewall` (pending), `human-console` (resolved) | both |

## Role resolution and trust gate

The nesting limit is checked first: a child that already sits at `PI_KIT_SUBAGENT_MAX_DEPTH` (default
2) cannot delegate further. Agent roles are then loaded from up to three directories and merged into
a map keyed by name, with later sources overriding earlier ones: kit, then user, then the nearest
project `.pi/agents`. The default `agentScope` is `user`, which means kit plus user roles. Project
roles need `agentScope: "project"` or `"both"`, and they must clear a trust gate, either an
interactive confirmation or a matching digest in `PI_KIT_TRUSTED_PROJECT_ROLES`. The digest covers the
role's name, system prompt, tools and model. A headless session cannot confirm, so it is blocked.

```mermaid
flowchart TD
    start["subagent tool call"] --> depth{"PI_KIT_SUBAGENT_DEPTH below PI_KIT_SUBAGENT_MAX_DEPTH, default 2?"}
    depth -->|no| refuse["Refused: nesting limit reached"]
    depth -->|yes| scope["agentScope: user, project or both"]
    scope --> kit["Kit roles: packages/kit/agents, always"]
    scope --> user["User roles: agent dir agents, for user and both"]
    scope --> project["Nearest project .pi/agents, for project and both"]
    kit --> merge["Map by name, later source wins"]
    user --> merge
    project --> merge
    merge --> shadow["Shadowed names recorded in the discovery result"]
    merge --> mode{"Exactly one mode, and background not with chain?"}
    mode -->|no| badmode["Refused: provide exactly one mode"]
    mode -->|yes| trust{"A requested project role whose digest is not in PI_KIT_TRUSTED_PROJECT_ROLES?"}
    trust -->|no| role
    trust -->|yes| ui{"Interactive session?"}
    ui -->|no| blocked["Blocked: needs operator approval"]
    ui -->|yes| confirm{"Operator approves?"}
    confirm -->|no| cancelled["Cancelled"]
    confirm -->|yes| role
    role["AgentConfig: name, systemPrompt, tools, model, thinking, skills, extensions, effort, scout, maxRuntimeMs"] --> spawn["runAgent launches the child through delegation-guard"]
```

### Conductor roles

`conductor` applies the same rule to its own launches:

- **Specialists.** Every `dispatch_specialist` role is a project file in `.pi/agents`, so it must clear
  the same trust gate: an exact digest in `PI_KIT_TRUSTED_PROJECT_ROLES` (computed the same way as
  subagent's, so one grant covers a role for both tools), or the operator's choice in an interactive
  session. The question starts on "No, do not run this project role". Without a grant, a headless
  session is blocked.
  The gate runs before a dispatch slot is reserved, so a refusal costs no budget. The launcher reads
  the role file again and refuses to start it if its content no longer matches what was approved
  (`tests/conductor-recursion-smoke.ts`).
- **Validator.** `dispatch_validator` reads its prompt only from the extension's own
  `agents/validator.md`. It never reads `.pi/agents/validator.md`, and conductor no longer writes that
  file into the project (`tests/conductor-validator-smoke.ts`).
- **Task on stdin.** The validator's evidence bundle and a specialist's task are written to the
  child's stdin, which print mode merges into the prompt, never put on argv, so a task over Linux's
  128 KiB single-argument limit still launches and the task is not visible through `ps`
  (`tests/conductor-validator-smoke.ts`, `tests/conductor-recursion-smoke.ts`). `dual-review` sends
  its reviewer prompt and diff the same way (`tests/dual-review-smoke.ts`).
- **Other delegation tools.** While `.pi/engagement/engagement.json` holds an engagement record whose
  phase is not yet `close-out`, the `tool_call` hook blocks `subagent`, `workflow_run` and
  `dual_review`, so `dispatch_specialist` is the only model-callable way to start a discretionary
  child. Advancing the engagement to `close-out` with `/engagement phase close-out` lifts the block. In
  a headless session the only delegation path while the block holds is a specialist whose digest is in
  `PI_KIT_TRUSTED_PROJECT_ROLES` (`tests/conductor-recursion-smoke.ts`).

## The launch contract

`prepareChild` in `packages/extensions/src/delegation-guard/index.ts` is the only code that builds a
child's extension arguments and environment. It publishes itself on a `globalThis` registry
(`Symbol.for("pi-kit.delegation")`) because extensions may not import one another, and every
launcher looks it up there: the subagent runner through `launch.ts`, `verify-gate`, and the
`conductor` specialist and validator paths. If the registry is missing, the launcher refuses to
start the child. There is no unguarded fallback.

```mermaid
flowchart TD
    A["Launcher asks for a child: kind, role, scout, read-only, requested tier"] --> B{"delegation-guard loaded?"}
    B -->|no| R1["Refused: no-guard"]
    B -->|yes| C{"effort loaded?"}
    C -->|"no, and kind is not mandatory"| R2["Refused: no-effort"]
    C -->|yes| D["required = governance extensions the parent runs, mandatory protections the parent has, delegation-guard and effort"]
    D --> E{"Every required extension found on disk?"}
    E -->|no| R3["Refused: governance-missing"]
    E -->|yes| F["Add companions, role or step extensions, and subagent when the role's tools name it"]
    F --> G["Reserve a slot in the effort ledger"]
    G -->|denied| R4["Refused, with the ledger's reason"]
    G -->|granted| H["Order: delegation-guard, protected-paths, secret-guard, tool-firewall, other governance, companions"]
    H --> I["Args: --no-extensions and one -e per extension"]
    H --> J["Env: PI_KIT_CHILD_REQUIRE, PI_KIT_EFFORT, PI_KIT_EFFORT_CAP, PI_KIT_EFFORT_LEDGER, PI_KIT_INTERNAL_CHILD"]
```

What the child loads:

- **Required set (`requiredForChild`).** Every extension whose `extension.json` says
  `childGovernance: true` that the parent has actually loaded, plus the mandatory protections the
  parent has. `delegation-guard` and `effort` are always required. In the kit the governance
  extensions are `delegation-guard`, `effort`, `tool-firewall`, `secret-guard`, `protected-paths` and
  `pentest-governance-domain`.
- **Order.** `delegation-guard` first, so its blocking hook runs before anything else, then
  `protected-paths`, `secret-guard` and `tool-firewall`, then the remaining governance extensions by
  name, then the optional ones. The firewall is always ahead of anything that could act.
- **Optional additions only add.** The companions `finish-reason-retry` and `todo` load when the
  operator has them enabled, `PI_KIT_SUBAGENT_EXTENSIONS=a,b` replaces the companion list (never the
  governance set), and a role's or workflow step's `extensions:` adds more. A role whose tools include
  `subagent` also gets the `subagent` extension, which is how a `delegator` child can delegate again.
  An unknown optional extension is skipped, because it is not a protection.
- **Isolation.** By default a child is isolated: `--no-extensions` plus exactly that set.
  `conductor` specialists and validators use `isolation: "ambient"` because their children need the
  operator's own extensions (for example MCP servers). The guard then hands back only the
  environment, and the child-side check below still applies. `PI_KIT_SUBAGENT_ISOLATE` no longer
  disables isolation, and the guard removes it from the child's environment.

The child verifies its own protections before any tool runs:

```mermaid
sequenceDiagram
    participant P as Parent launcher
    participant C as Child process
    participant G as delegation-guard in the child
    P->>C: spawn with PI_KIT_CHILD_REQUIRE listing the required names
    C->>G: session_start
    G->>G: compare the required names with the protections registered in this process
    alt every required protection registered
        G-->>C: tool_call hook lets tools through
        C-->>P: normal run
    else one is missing
        G->>C: write the reason to stderr, set exit code 78
        G-->>C: tool_call hook blocks every tool call
        C-->>P: exit 78, EX_CONFIG
        P->>P: treat the result as fatal, never retry
    end
```

Where the contract fails closed:

1. The guard is not loaded, so the launcher refuses (`no-guard`).
2. `effort` is not loaded and the launch is not mandatory verification (`no-effort`).
3. A required protection cannot be located next to the extension (`governance-missing`).
4. The ledger denies the reservation, or the policy or ledger cannot be read.
5. A protection did not load inside the child, which blocks every tool and exits 78.

Mandatory verification is the one exception to the budget rules: with no `effort` extension, or no
readable ledger, it runs unbudgeted rather than not at all. It never skips the protections.

### Who starts a child

| Launcher | Launch kind | Isolation | Notes |
|---|---|---|---|
| `subagent` tool (single, parallel, chain) | `discretionary` | isolated | Each task or chain step reserves its own slot. The `effort` argument can ask for a lower tier. |
| `workflow_run` tool | `discretionary` | isolated | Hidden together with `subagent` at E1. |
| `/workflow run` and `/workflow resume` | `user` | isolated | You typed it, so only the platform ceilings bound it. |
| Completion reviewer (`/verify`, `verify_completion`) | `mandatory` | isolated | Role `reviewer`, read-only, tools `read,grep,find,ls`. |
| `dispatch_specialist` (`conductor`) | `discretionary` | ambient | Read-only when the role's tool list is non-empty and names only `read`, `grep`, `find` and `ls`, the same rule as `subagent` (`tests/conductor-specialist-bounds-smoke.ts`). |
| `dispatch_validator` (`conductor`) | `mandatory` | ambient | Role `validator`, read-only. |
| `recovery-orchestrator` | starts no child | none | Opens the recovery budget on the effort registry when `progress-guard` escalates a stuck loop. |

### The shared effort ledger

The root's `effort` extension opens one ledger file per user request under
`<agent dir>/pi-kit/effort/ledgers/`. A child receives its path in `PI_KIT_EFFORT_LEDGER` and reserves
against the same file, so the root's limits bound the whole tree. Reservations are atomic (an
exclusive lock file around each read-modify-write), a charge is never refunded, and settling a child
frees only its concurrent slot. A child's tier is its parent's tier or lower, and is passed down as
both a pin (`PI_KIT_EFFORT`) and a cap (`PI_KIT_EFFORT_CAP`). Slots whose process has died are
reclaimed, and ledgers older than a day are pruned when a root session starts.

```mermaid
flowchart TD
    req["reserve: kind, role, scout, read-only"] --> kind{"kind"}
    kind -->|user| U["Platform ceilings only: total and concurrent"]
    kind -->|mandatory| M{"Fewer than 6 mandatory launches this request?"}
    kind -->|recovery| RC{"Recovery open, read-only scout, under 2 invocations, none running?"}
    kind -->|discretionary| DT{"Tier allows delegation, below the session ceiling?"}
    DT -->|no| DENY
    DT -->|yes| DL{"Under the total, concurrent and scout limits of the tighter of the root's tier and this child's tier?"}
    U -->|within| GRANT
    U -->|over| DENY
    M -->|yes| GRANT
    M -->|no| DENY
    RC -->|yes| GRANT
    RC -->|no| DENY
    DL -->|yes| GRANT
    DL -->|no| DENY
    DENY["Denied with a code and reason: launch refused, never retried"]
    GRANT["Granted: charge recorded, no refund, child tier is clamped to the parent's"]
    GRANT --> SETTLE["settle: slot released when the child ends, charge stays"]
```

If the policy or the ledger cannot be read, discretionary, recovery and user launches are refused.
At E1 the `subagent` and `workflow_run` tools are taken out of the prompt for the turn, because they
could only be refused, and they return while the recovery budget is open or once a higher tier is
chosen.

## Single delegation end to end

A typical single-agent run. The runner creates the run log, asks the guard for the launch, spawns the
child with the task on stdin, and settles the slot when the child ends. The child's `tool-firewall`
writes a pending approval to the shared `.pi/human-console` directory, and the attended root session's
`human-console` extension polls that directory, prompts the operator and writes a resolved file that
the child reads back.

```mermaid
sequenceDiagram
    participant Root
    participant Tool as subagent tool
    participant Runner
    participant Guard as delegation-guard
    participant Ledger as effort ledger
    participant State as run state
    participant Child
    participant Console as human-console
    Root->>Tool: subagent with agent and task
    Tool->>Runner: runAgent
    Runner->>State: createRunLog and start record
    Runner->>Guard: prepareChild for this attempt
    Guard->>Ledger: reserve a slot
    alt refused
        Ledger-->>Guard: denied with a reason
        Guard-->>Runner: not ok
        Runner-->>Tool: stopReason denied, fatal and not retried
        Tool-->>Root: failure with a hint
    else granted
        Ledger-->>Guard: slot id
        Guard-->>Runner: args, env, slot and child tier
        Runner->>Child: spawn pi mode json, no-session, no-extensions plus the guard's set
        Runner->>Child: stdin Task plus task body
        Runner->>Ledger: attach the child's pid
        Child->>Child: self-check of required protections
        Child->>Console: when a call needs approval, tool-firewall writes a pending file
        Console-->>Child: resolved json, allow or deny
        Child-->>Runner: JSONL message and tool events
        Runner->>State: append log and heartbeat
        Runner->>Ledger: settle the slot, the charge stays
        Runner->>State: close the end record
        Runner-->>Tool: SingleResult with finalOutput
        Tool-->>Root: final answer or failure hint
    end
```

The child's argv is `--mode json -p --no-session`, then `--model`, `--thinking` and `--tools` when
set, then the guard's `--no-extensions` and `-e` arguments, then `--append-system-prompt` pointing at
a temporary file holding the role's prompt and any preloaded skills. The runner adds
`PI_KIT_SUBAGENT_DEPTH` (parent depth plus one), `PI_KIT_SUBAGENT_STATE_DIR` and, unless already set,
a shorter `PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS` (`PI_KIT_SUBAGENT_APPROVAL_TIMEOUT_MS`, default 2 minutes)
so an approval nobody answers fails closed quickly. The task travels over stdin, which print mode
merges into the prompt, so a large chained task cannot hit the 128 KiB argument limit. The run log
records the extensions loaded, the child's tier and its slot id, or the reason a launch was refused.

## Modes and previous threading

The tool requires exactly one mode. Single runs one agent and task. Parallel runs up to eight tasks
under a concurrency limit, and single and parallel can be detached with `background: true`. Chain
runs steps sequentially and substitutes each step's prior output into the next step's task, so it
cannot be backgrounded. A failed step stops the chain. A detached step ends the call early: that
child keeps running in the background and the later steps are not started. Every task or step is its
own launch and reserves its own slot, so a refused launch fails just that parallel task, or stops the
chain at that step.

```mermaid
flowchart TD
    req["subagent call"] --> mode{"Exactly one mode required"}
    mode --> single["single: agent plus task"]
    mode --> parallel["parallel: tasks array"]
    mode --> chain["chain: sequential steps"]
    parallel --> conc["At most 8 tasks, concurrency PI_KIT_SUBAGENT_CONCURRENCY, default 4"]
    conc --> claim["mapWithConcurrencyLimit"]
    single --> bg
    parallel --> bg["background true: every child launches at once and the call returns immediately"]
    bg --> settled["onSettled notifies the operator and the agent later"]
    chain --> sub["substitutePrevious replaces the previous placeholder"]
    sub --> prev["previous is the prior step's finalOutput"]
    prev --> stepfail["Failed step stops the chain"]
    prev --> detach["Detached step returns early"]
    prev --> last["Last step's output is returned"]
    claim --> slot["Each child reserves its own slot: a refused launch fails only that task"]
    sub --> slot
```

## Lifecycle, cancel and kill switch

A spawned child is cancel-by-default: the parent's abort signal is passed to the child, so Esc kills
it as an `aborted` run. `background: true` and `PI_KIT_SUBAGENT_DETACH_SIGNAL=1` restore detach. Idle,
stream-cap and wall-clock budgets each end the run with a distinct `KillReason`, the operator can stop
runs with `subagent_stop` or `/subagent-stop`, and `session_shutdown` stops all live children. Every
kill sends SIGTERM and escalates to SIGKILL after five seconds.

Only a transient failure is retried: a spawn failure, or a non-zero exit with no usable output, up
to `PI_KIT_SUBAGENT_RETRIES` times (default 1). Nothing else is. A refused launch and a child that
exits 78 are fatal, because retrying a policy outcome cannot help and would only spend attempts.
Aborts and operator stops are fatal too, and the idle, stream-cap and wall-clock kills are never
retried, whether or not the child produced output. Each attempt is a new launch, so a retry reserves
another slot and the first attempt's charge stays. An end record that never arrives leaves the run
marked `orphaned` in the status views.

```mermaid
stateDiagram-v2
    [*] --> Reserving
    state "Reserving a slot (prepareChild)" as Reserving
    state "Denied: no slot, or a protection cannot be located" as Denied
    state "Running (heartbeat updates the parent)" as Running
    state "Completed: exit 0" as Completed
    state "Failed: exit non-zero" as Failed
    state "Exit 78: child protection missing" as Config
    state "Retry of a transient failure, once by default" as Retry
    state "Detached: parent stopped waiting" as Detached
    state "Aborted: Esc or parent cancel" as Aborted
    state "Timeout: idle watchdog" as Idle
    state "Stream cap: byte cap" as Cap
    state "Wall-clock ceiling" as Wall
    state "Stopped by operator" as Stopped
    state "Orphaned: no end record, pid gone" as Orphan
    state "SIGTERM then SIGKILL" as Kill
    Reserving --> Denied: refused
    Reserving --> Running: granted and spawned
    Denied --> [*]: fatal, never retried
    Running --> Completed
    Running --> Failed
    Running --> Config
    Running --> Detached: background true, or DETACH_SIGNAL=1 and a cancel
    Detached --> Completed: result arrives via onSettled
    Running --> Aborted
    Running --> Idle
    Running --> Cap
    Running --> Wall
    Running --> Stopped: subagent_stop, /subagent-stop or session_shutdown
    Aborted --> Kill
    Idle --> Kill
    Cap --> Kill
    Wall --> Kill
    Stopped --> Kill
    Failed --> Retry: no usable output
    Retry --> Reserving: new launch, new slot
    Config --> [*]: fatal, never retried
    Kill --> [*]
    Completed --> [*]
    Failed --> [*]
    Running --> Orphan: seen later in the status view
    Orphan --> [*]
```

The `orchestrator` extension is a steering layer only. It scores each request, writes a
context-contribution and a classification file, and reads the verdict board to decide whether the
mission may be reported complete; it starts no children itself. A child never steers itself:
`orchestrator` disables itself when `PI_KIT_INTERNAL_CHILD=1`, and a child does not load it unless a
role or step names it in `extensions:`.

## Task graph and verifier board

Two small extensions give the agents shared state under `.pi/`. They are tools the agents call, not
part of the launch contract, and a child only has them when a role's or workflow step's
`extensions:`, or `PI_KIT_SUBAGENT_EXTENSIONS`, adds them.

- **`task-graph`** keeps a dependency graph of tasks in `.pi/task-graph.json`, with the statuses
  `pending`, `in_progress`, `done` and `blocked`. Parallel implementers are separate processes, so
  every mutating call holds an exclusive lock file (`.pi/task-graph.lock`). `task_create` validates
  `depends_on`, `task_next` claims the next unblocked pending task by marking it `in_progress` in the
  same locked step (two implementers cannot receive the same task), and `task_update` and
  `task_complete` refuse `done` while a dependency is unfinished. A claim records `claimedAt`, any
  `task_update` of an `in_progress` task renews it, and `task_next` returns a claim older than
  `PI_KIT_TASK_GRAPH_LEASE_MS` (default one hour, `0` disables expiry) to `pending` before it picks,
  so a crashed implementer's task is handed out again. A claim without `claimedAt`, written by an
  older build, is left alone. `task_clear` removes every task, for a new plan in the same project
  (`tests/task-graph-invariants-smoke.ts`).
- **`verifier-board`** keeps the latest verdict per source in `.pi/verdicts.json`, through
  `record_verdict`, `verdict_status` and `/verdicts`. The sources `verify`, `review` and
  `validator:<id>` are reserved for independent writers (`verify-gate` and the `conductor` validator),
  so `record_verdict` refuses them. Board writes share `.pi/verdicts.lock` with the validator.
- **The completion gate** in `orchestrator` fails closed. It blocks when the board is missing,
  unreadable or empty, while a verify run is still pending, when any verdict has failed or is older
  than 24 hours (`PI_KIT_VERDICT_MAX_AGE_MS`), and when no trusted source has passed.

The verdict freshness contract is shared by `verifier-board`, `orchestrator` and `conductor`:
every passing verdict needs a string timestamp that parses to a date no later than the current
time and within the configured maximum age. Missing, non-string, empty, malformed and future
timestamps block completion until verification records fresh evidence. All independent writers
emit ISO timestamps. The extensions retain local readers to preserve self-containment;
`tests/verifier-board-trust-smoke.ts` is their conformance suite, checking both trusted and
untrusted records against board status and both completion gates. `tests/verify-failclosed-smoke.ts`
covers the verification lifecycle. Timestamp freshness does not bind a verdict to a particular
goal or repository revision.

## Source files

- `packages/extensions/src/delegation-guard/index.ts`: `prepareChild`, `requiredForChild`, governance discovery from `extension.json`, the child-side self-check and exit 78.
- `packages/extensions/src/effort/index.ts`, `packages/extensions/src/effort/ledger.ts`, `packages/extensions/src/effort/policy.ts`: tiers, the shared ledger, atomic reservations and `setRecoveryActive`.
- `packages/extensions/src/effort/policy/effort.json`: the five tiers, the platform ceilings and the recovery budget.
- `packages/extensions/third_party/subagent/launch.ts`: the launcher side of the contract, `prepareChildLaunch`, read-only and scout role checks.
- `packages/extensions/third_party/subagent/runner.ts`: `runAgent`: argv, model selection, per-attempt reservation and settling, env vars, budgets, cancel and retry.
- `packages/extensions/third_party/subagent/child-process.ts`: spawn, stdin delivery, JSONL streaming, kill escalation, byte caps.
- `packages/extensions/third_party/subagent/tools.ts`: the `subagent` tool, mode validation, trust gate, nesting check, `subagent_stop` and `settledNotifier`.
- `packages/extensions/third_party/subagent/agents.ts`: `discoverAgents`, kit, user and project directories, name precedence and shadowed names.
- `packages/extensions/third_party/subagent/result.ts`: `substitutePrevious` and `classifyFailure` (a denied or exit 78 launch is fatal).
- `packages/extensions/third_party/subagent/logging.ts`: run ids, `.pi/subagent/<runId>.log` and `.pi/subagent/runs.jsonl`.
- `packages/extensions/third_party/subagent/live.ts`: in-process live-run registry and orphan PID guards.
- `packages/extensions/third_party/subagent/status.ts`: run table and the `orphaned` state.
- `packages/extensions/third_party/subagent/config.ts`: defaults and env knobs for depth, concurrency, budgets, retries and approval timeout.
- `packages/extensions/src/verify-gate/index.ts`: the completion reviewer launch (`mandatory`).
- `packages/extensions/src/conductor/index.ts`, `packages/extensions/src/conductor/validate/validator.ts`: specialist and validator launches.
- `packages/extensions/src/recovery-orchestrator/index.ts`: opens the recovery budget.
- `packages/extensions/src/orchestrator/index.ts`: classification, context contribution and verification steering.
- `packages/extensions/src/task-graph/index.ts`: `task_create`, `task_update`, `task_list`, `task_next`, `task_complete` and `task_clear` over `.pi/task-graph.json`.
- `packages/extensions/src/verifier-board/index.ts`: `record_verdict`, `verdict_status` and `.pi/verdicts.json`.
- `packages/extensions/src/human-console/index.ts`: pending and resolved polling and the `.pi/human-console` file contract.
- `packages/extensions/src/tool-firewall/index.ts`: `brokerApproval` for headless children.
- `packages/kit/agents/scout.md`, `planner.md`, `implementer.md`, `reviewer.md`, `delegator.md`: role frontmatter and system prompts.
