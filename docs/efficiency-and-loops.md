# Efficiency and Loops

How Luna helps the agent do more with fewer tool calls, and recover when it starts
looping — especially on small local models.

## The problem

Small models tend to (1) read the same files repeatedly, (2) over-gather before acting, and
(3) repeat near-identical commands without progressing. Left alone this burns context and
stalls.

## The layers

### 1. Cheaper file I/O (behaviour-only)
- **`pi-readseek`** provides hash-anchored read/edit/grep plus structural code maps and AST
  search, so navigating a repo costs far fewer calls than full-file reads.
- **`caveman`** keeps the agent's own output terse.

These need no model action — they just make each call cheaper. **`pi-lean-ctx`** (which
compresses bash/read/grep output) is opt-in and in no profile: it needs the external `lean-ctx`
CLI and adds shell and edit tools the firewall does not classify as shell (see
[Supply chain](supply-chain.md)). The `lite` surface relies on `pi-readseek` instead.

### 2. Facts: `trace-ledger`
Records every tool call/result to `.pi/trace.jsonl` (tool, target, args hash, ok/error),
warns once when the same file is read 3×, and answers `/trace` (calls, errors, distinct
files read, top repeated reads). It's the data the guard reasons over.

### 3. Guidance: skills
Loaded on demand (the orchestrator points the model at them):
- **`codebase-navigation`** — locate before reading; read ranges; read once.
- **`self-reflection-and-recovery`** — fewest calls to a verified result; a loop self-check.
- **`self-reflection-and-recovery`** — notice looping → reflect → delegate.
- **`agent-orchestration`** — give each sub-agent only what it needs.
- **`context-management`** — reset context without losing the thread.

### 4. Auto-boost: `progress-guard`
Detects three cheap "stuck" signals — the same action **repeating**, an A→B→A
**oscillation** (alternating between two actions with no edit between), or many **reads
since the last edit** — and helps break out:
- **`suggest`** mode (default): notifies a suggestion; you delegate or keep working.
- **`auto`** mode: injects a guidance nudge (never a system prompt) that tells the model to
  reflect and, if looping, delegate the stuck step to a fresh sub-agent that returns only the
  answer. The nudge reaches the model inside the run that is looping, as a hidden message pi
  appends after the turn's tool results (returned from `turn_end` on pi 0.87.0 and later,
  steered into the run on older pi), and is kept as a `context-sieve` contribution for the
  next prompt (`tests/progress-guard-agsix-smoke.ts`).

A `bash` command that only looks at files (`cat`, `head`, `tail`, `sed -n`, `grep`, `rg`, `ls`,
`find` and the like, with no redirect, in-place edit or delete) counts as a read, and when
three or more reads since the last edit went through `bash` the nudge adds "Read files with the
read tool". In the worker logs 1,055 of 2,660 `bash` calls were file reads against 191 `read`
calls, which hid them from the stall counter and skipped `read`'s anchored output
(`tests/progress-guard-agsix-smoke.ts`).

**Auto mode is automatic on unattended runs:** arming `autonomous-loop`
(`/loop <goal>`) writes `.pi/autonomous-loop.armed.json`, and `progress-guard` flips to
`auto` when that marker is present — no `PI_KIT_GUARD_MODE=auto` needed. `/boost on|off`
still overrides per session.

**How an armed loop ends.** After each finished turn `autonomous-loop` queues
`Continue: <goal>`, up to `PI_KIT_LOOP_MAX` (default 20) times. It stops instead when the
operator runs `/loop stop`, when the model calls the `loop_complete` tool (its steer names this
tool; the shipped firewall policy allows it without a prompt), or when the turn ended with an
operator abort (Esc) or a provider error, which it reports in a warning
(`tests/liveness-containment-smoke.ts`, `tests/tool-firewall-smoke.ts`).

It never blocks a tool. A write clears the signal.

### 5. Deep escalation: `recovery-orchestrator`
When assistance isn't enough — the same signature keeps firing after
`PI_KIT_GUARD_ESCALATE` (default 2) nudges — `progress-guard` writes the session's
`.pi/recovery/sessions/<session id>/escalation.json` and that session's `recovery-orchestrator`
enters the deep
[recovery-orchestration mode](recovery-orchestration-mode.md): it writes a recovery report
scaffold and steers the multi-agent root-cause pass (fresh scouts + a forked top-10 of
causes + a primary/backup plan + a delegated fix). Non-destructive; bounded to
`PI_KIT_RECOVERY_MAX_ATTEMPTS` (default 2) per signature before escalating to the operator.
On demand, a bare `/boost` enters the same flow. Ships in `long-horizon`/`self-improving`.

## Threshold calibration

The detection thresholds are first-principles defaults, validated against **scripted
fixtures** in the eval harness (`packages/core/eval/fixtures.ts`) rather than mined from live sessions
— Luna is hardened offline, so no live-session `.pi/trace.jsonl` corpus was used to fit
them. The reasoning:

| Signal | Env | Default | Rationale |
|---|---|---|---|
| Repeat | `PI_KIT_GUARD_REPEAT` | 3 | 1–2 identical actions are normal (retry after a fix); the 3rd identical action with no progress is the earliest point a loop is unambiguous without false-firing on legitimate retries. |
| Oscillation | `PI_KIT_GUARD_OSC` | 3 | A→B→A (length 3, exactly 2 distinct alternating actions) is the shortest run that distinguishes a genuine ping-pong loop from normal interleaving. Shorter would fire on ordinary A→B→C work. |
| Read stall | `PI_KIT_GUARD_STALL` | 10 | Ten reads with no edit is well past "orient then act"; a model that thrashes typically exceeds this. Lower risks nagging during legitimate investigation. It is ignored entirely in a session with no write-capable tool active. |
| Escalate | `PI_KIT_GUARD_ESCALATE` | 2 | Nudge twice; if the same signature still recurs, assistance isn't working — hand off to the deep recovery pass rather than nudging indefinitely. |
| Recovery cap | `PI_KIT_RECOVERY_MAX_ATTEMPTS` | 2 | Two deep root-cause passes per signature; past that, escalate to the operator instead of spawning further. |

Re-tune by exporting the env vars above; they have not been fitted to a corpus of real
sessions.

## Bounding what the model reads

Tool results are most of what an agent re-reads on every request (62% of prompt characters in
the autonomy worker logs that were measured), so a result that can carry log or transcript text
is capped before it reaches the model. `workflow_status` (a list, a run's steps, a subagent log
tail) and the workflow-finished notice keep the first two thirds and the last third of 12,000
characters and say how much was dropped and where the full text lives; a tailed log line is cut at
600 characters first, because those lines are JSON events with whole partial results in them. Set
`PI_KIT_TOOL_RESULT_MAX_CHARS` (at least 1,000) to change the cap. The verify gate's own
diagnostics and check output were already bounded (1,500 to 4,000 characters). Pinned by
`tests/run-query-smoke.ts`. **Not covered:** pi's built-in `bash` and `read` keep pi's own
50 KB limit, and other extensions' tools are not capped.

## Discovery on demand

What a request carries up front is kept to what most sessions use; the rest is one step away.

- **Lazy run tools.** `workflow_status` and `workflow_control` register inactive
  (`defaultActive: false`, honoured by pi 1.x; an older pi ignores it and leaves them active) and
  wake when a run starts: a `workflow_run` or `workflow` call, a background `subagent` call, or a run
  an operator command starts. They were 1,636 characters of text in every request of a session that
  never started a run (`tests/lazy-run-tools-smoke.ts`). The script `workflow` tool stays active: it
  is how a run starts.
- **Two skills listed, the rest searchable.** pi lists a skill in the system prompt unless it sets
  `disable-model-invocation`; only `coding-agent-workflow` and `verification-loop` are listed now.
  `general-agent-workflow` and `memory` are matched by `skill-router` triggers and found with
  `skill_search` like the other 34 (`tests/skill-routing-smoke.ts`).
- **Shorter always-on text.** The effort block, the caveman style, and the `todo` and `memory_save`
  descriptions say the same thing in fewer words. The footprint meter below measures the result.
- **Quieter children.** A governed child does not rediscover skills, commands or themes, and a
  read-only role does not reload the project's context files (see `docs/agent-orchestration.md`).

On the meter, `balanced` went from 11,091 to 8,735 characters in all (tools, snippets, guidelines
and system additions), `lite` from 9,674 to 7,348, and the delegation tools from 4,725 to 3,089
characters up front.

## Measuring the footprint

A small model pays for every character of tool description and parameter schema before it reads
the task, so the kit's floor is a measured number. `packages/core/eval/footprint.ts` loads a
profile against a fake pi in a temp HOME, fires its `session_start` handler and totals three
things: the name, description and parameter schema of every tool it registers; the one-line
snippets and guideline rules those tools add to pi's system prompt; and what the profile's
`before_agent_start` handlers add to the system prompt on a first turn (the effort block and the
caveman style). Companion packages (`pi-readseek`, `pi-lens`) register tools that reach the model
in every request but cannot be loaded offline, so the baseline records their measured cost
(`companions`, taken from a real pi with the pinned release and tied to its `source`: a version
bump fails until it is measured again) and the report adds it. pi's own base prompt is left out. The derived token figure is `ceil(chars / 4)`; `--json`
also reports `totalChars`, the sum of the three.

```bash
node packages/core/eval/footprint.ts --profile lite --json
node packages/core/eval/footprint.ts --profile balanced --write-baseline
```

Without `--write-baseline` the command prints the profile, its characters, the derived tokens and
every tool, then compares the result with `packages/core/eval/footprint-baseline.json`. A tool
text, tool list or delegation total that differs from the reviewed record fails with the delta
and a reminder to update the baseline only when the change is deliberate; a profile with no
baseline row fails until `--write-baseline` records it. `--json` prints the same measurement as
one deterministic object, so two runs of unchanged code are byte-identical. `--write-baseline`
keeps the reviewed ceilings and rewrites the file only when the measured numbers changed, so an
up-to-date baseline stays byte-for-byte the same. A malformed or foreign baseline is a clean
error (exit 2) and is left untouched, so remove the file to regenerate it.

`lite` has a hard ceiling on the kit's tool text plus its companions' (`totalCeiling`, 9,000
characters; `pi-readseek` is most of it), and registers no delegation or workflow tool
(nothing in the test suite pins either; the meter reports them). `pi-lens` adds 18,800 characters to every other profile, which
is why their companion-inclusive totals are several times the kit-only figure: that cost is
reported, not yet reduced.

Every shipped profile has a baseline row (tools, snippets and guidelines, system additions), not
only `balanced` and `lite`. The meter is a development tool: no test pins its figures, the prompt
prefix that survives a turn, or the CLI's output, because they change with every kit-text edit.

## Measuring Memento mode

Memento mode ([Generations](autonomy.md#generations)) is opt-in per model because it helps some
models and not others. `packages/core/eval/memento.ts` is an offline harness for deciding whether
to opt a model in. It compares two arms on the same tasks:

- a **single attempt**, and
- a run in **generations**,

with each arm getting the same budget per task (minutes and dollars).

- **Pairing.** Each arm runs once per task, one at a time, and the arm that goes first alternates
  between tasks. Each arm gets its own frozen copy of the shared budget.
- **Scoring.** An arm's report is parsed with type guards (`success`, `minutes`, `usd`), never
  cast. A report that spends more minutes or dollars than the budget counts as a failure and is
  tallied as over budget. A report that does not parse, or an arm that throws, counts as a failure
  and is tallied as invalid.
- **Statistics.** Each arm's success rate gets a Wilson 95% score interval (an arm with no tasks
  gets [0, 1]). The verdict is `generations` or `single` only when that arm's whole interval lies
  above the other's. When the intervals overlap, the verdict is `inconclusive`. The paired counts
  (both, single only, generations only, neither) are reported but do not change the verdict.
- **Output.** The harness writes one Markdown proposal: the budget, a table per arm, the paired
  counts, the verdict, and what to do next. It names `/effort memento on <model>` only when the
  verdict is `generations`. The file is new and 0600 (the directory is created 0700), and an
  existing file is never overwritten. The harness never writes the opt-in
  (`<agent dir>/pi-kit/autonomy.json`) or any other configuration. Acting on a proposal is the
  operator's decision.

Arms are functions, so a caller can plug in its own runner. The command line only replays a
recorded results file; it launches no model and does not use the network:

```bash
npm run eval:memento -- --results results.json --out proposals/
```

`results.json` holds `model` (`provider/model`), `budget` (`minutes` above 0, `usd`), and `pairs`, a
list of `{task, single, generations}` with unique task ids, where each arm is
`{success, minutes, usd}`. A malformed file exits 1 and writes nothing.

Tests: `tests/memento-eval-smoke.ts` (`npm run smoke:memento-eval`). It checks the interval
against published values (Newcombe 1998), pins the verdicts, including the reported Memento
figures (3/13 vs 14/22 and 10/21 vs 10/29, both inconclusive), and drives fake arms and the
command line with a temp HOME and agent dir.

**Not covered:** nothing in Luna records a results file from real runs yet, and no model has
been measured.

## Quick reference

| Want | Use |
|---|---|
| See if you're repeating reads/commands | `/trace` |
| Reassess now | `/boost` |
| Auto-nudge on loops this session | `/boost on` |
| Enter deep recovery now | `/boost` |
| Tune sensitivity | `PI_KIT_GUARD_REPEAT`, `PI_KIT_GUARD_STALL`, `PI_KIT_GUARD_OSC` |
| Auto-boost on autonomous runs | arm `/loop <goal>` (automatic) or `PI_KIT_GUARD_MODE=auto` |
| Measure a profile's tool text and tokens | `node packages/core/eval/footprint.ts --profile <name> --json` |
