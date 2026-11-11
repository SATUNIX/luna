# Future work and known limitations

Open items, each stated as a limitation that exists today, with what would close it. Nothing here
is a commitment or a schedule; see [Roadmap](roadmap.md) for direction and [Beta status](beta.md)
for what the beta does and does not cover. An item is removed when the code and a test close it,
not when it is written up.

Where an item implies a behaviour change in a safety mechanism (approvals, compaction,
delegation), the change is reviewed as a change to that mechanism, not as a bug fix.

## Verification that was not possible for this release

These are gaps in *evidence*, not known bugs. Each names the person or environment that can close
it.

| Not verified | Why | Who can close it |
|---|---|---|
| Behaviour against real model providers: the effort prompts, the auto-mode judge's verdicts, the completion reviewer, delegation quality | The release was prepared without provider credentials; every suite uses deterministic fakes or the real pi runtime without a model | An operator with a provider, running a representative task at each effort tier |
| The autonomous runner on rootless Podman, on macOS and Windows, and in a run of hours or days | `smoke:autonomy-container` ran on Docker only, in a disposable sandbox; the in-container boundary probe (`packages/autonomy/tests/boundary-probe.ts`) is manual-only | An operator, per [Autonomous runs](autonomy.md) |
| A full autonomous run against a real model provider | The relay talks to a local fake upstream in every test | An operator with a provider key and a small budget |
| The web console's Content-Security-Policy in a browser | No browser was used | Anyone with a browser: open the console and check the progress bars render |
| The full check suite on Windows and on Node 24 | CI runs the suite on Linux with Node 26, and the pi-compat lanes with Node 22; Windows runs the per-profile install check only | CI matrix extension |
| `git` and `npm` delivery for `/profile` and for the update path against the real public repository | No release tag exists yet, and local mode is what the suites can exercise | The first release, then a run of `/update` from an install of it |
| Interactive use on pi 1.x | The suites drive pi's runtime without a terminal; pi 1.0 made the fullscreen TUI the default and that was not exercised by hand | An operator, running each profile interactively on pi 1.3 |

## Delegation and recovery

- **A child that fills its context window** is now told why (compaction off, a failed recovery,
  clamped output) and is not retried in a loop. `subagent` adds a kit-authored hint only to a
  child that ended with no message at all (`tests/subagent-nesting-smoke.ts`); one that fills its
  window after replying still shows the child's own message, with no overflow or compaction hint.
- **`trigger-compact`'s mid-run resume** sends a visible user message and has been tested only
  with fakes. It never runs inside child sessions.
- **Recovery itself starts only on a progress-guard escalation or a bare `/boost`.** A repeat
  verification FAIL does not enter recovery, but the verify-fail signal returns the policy's
  `split` move at E3 and above: a steer plus the workflow card, from `decide()` in
  `packages/extensions/src/effort/strategy.ts`. A first FAIL returns no move, and a check that
  regresses sends nothing (`tests/verify-failclosed-smoke.ts`, `tests/workflow-strategy-smoke.ts`).
  The wider gap remains: no single "worse" signal (a test count, a checkpoint diff or a
  `verifier-board` verdict flip) tells recovery that an attempt made things worse, and "the same
  problem" has no settled definition for the signature. Whether scouts should run on a second
  provider for independence, whether an extension can drive `/fork` itself, and a token ceiling
  before recovery gives up are also open ([Recovery orchestration mode](recovery-orchestration-mode.md)).
- **Effort budgets are accounting, not enforcement.** A hostile process owned by the same user can
  edit the ledger. Enforcing tiers at the operating-system level would need a supervisor outside
  the session.

### Limits of the delegation kernel

Each is a limit of the delivered kernel, not a bug in a test.

- **"No model too small" is a hypothesis.** The kit footprint meter shows the `balanced` kit tool
  text at 8,919 characters over 13 tools and the delegation tools at 4,730, under their ceilings; the kit
  floor stays near 9,500 and `pi-lens` and pi core are unmeasured. Nothing shows that data plans
  raise completion on a small model, and a syntactically valid plan can still be a bad one
  (`tests/eval-footprint-smoke.ts` pins the meter). The live `small-model/plan-valid-rate` fixture
  records a rate per model and never reaches a model in CI; running it, plus an outcome eval per
  model, would close the question.
- **"No task too large" is unproven.** Size is handled by replanning across turns inside the tier
  allowances, and no test runs a large task. Delivered recursion is one nested `workflow()` level
  plus `expand` within one run; process depth stays 1, a deliberate retreat until grandchild
  cancellation is proven (`tests/workflow-plan-smoke.ts` pins the expansion bounds, nothing pins a
  large task). A large-task eval and a cancellation test below the direct child would close it.
- **E5 "by default" is an instruction, not enforcement.** Tests pin the text that tells the agent to
  plan substantial work; only a live run can show a model following it (`tests/workflow-strategy-smoke.ts`).
  A recorded live run at E5 on a substantial task would close it.
- **At default effort an autonomous request affords two gated items, or scouts plus one.** Each
  item's plan costs 4 and the engine request affords 8, so later items fall back to `subagent`
  (`tests/autonomy-selfimprove-smoke.ts`). A larger engine allowance, or smaller plans that fit,
  would close it.
- **The ladder order and its thresholds are judgement.** `planMinTier` 5, `splitMinTier` 3,
  `delegateScore` 3, `reviewLines` 400 and `stallAfter` 2 are unmeasured defaults in the `strategy`
  block of `effort.json`, and no evidence shows that workflows, the ladder or the card improve
  outcomes (`tests/workflow-strategy-smoke.ts` pins the defaults and the moves). Comparing outcomes
  with the policy on and off, and measuring each threshold, would close it.
- **A budget can still be overshot.** A live agent can pass a budget after its slot was granted,
  input tokens are not counted, and retries count on the ledger but not in the run's `launched`
  total (`tests/workflow-ledger-smoke.ts`, `tests/effort-smoke.ts`). Whole-request accounting that
  includes input tokens, reconciled after each child ends, would close it.
- **A script's return value is not checked.** A script cannot make a failed step read as `passed`,
  but it can return a misleading value that the host has no way to judge
  (`tests/workflow-hooks-smoke.ts`). An acceptance check on the value, such as a structured output
  or a verifier verdict, would close it.
- **A revision check runs at events.** A PASS or fingerprint is re-read after a tool result and at
  `turn_end`, so an edit by another process is seen at the next event, not before the next action
  (`tests/verify-failclosed-smoke.ts`). A filesystem watch, or a check before every action, would
  close it.
- **Cancellation is proven to one level.** A run's AbortController reaches its direct child; below
  that, `proc.kill` does not. With process depth 1 that is the whole delivered chain, but a child
  given a second nesting level is not covered (`tests/workflow-control-smoke.ts`). Process
  groups, or a cancellation test through a grandchild, would close it.
- **Direct `subagent` is not a run.** It keeps its run log (`.pi/subagent/<id>.log`,
  `runs.jsonl`) and has no run directory or `unknown` state; "a one-step run" holds in result shape
  only (`tests/run-query-smoke.ts`). A run record and journal for direct delegation would close it.
- **A bash-capable child can still run `pi`.** Named-tool tests claim named tools only: a role with
  `bash` can start another agent process outside the ledger (`tests/delegation-guard-smoke.ts`).
  An operating-system boundary, not a tool list, would close it.
- **Scripts in the autonomous container are not delivered.** The container runs no sandboxed script
  workflow, because `bwrap` is absent and an unattended `policy_ask` is denied (see
  [Autonomous runs](autonomy.md); no test covers it because it is not delivered). A sandbox proven
  inside the container and an unattended approval path for it would close it.

### Known issues

- **`protected-paths` has its own shell walker.** The tool firewall's `shell.ts` and
  `protected-paths`' `directWriteTargets` are two regular-expression sets, so a shell shape fixed
  in one must be fixed in the other (follow-up A-90 on the operator's board, outside this
  repository). `tests/protected-paths-corpus-smoke.ts` covers the shapes both understand today; a
  shared shell-walker module, which the extension contract today forbids, would close it.
- **`smoke:workflow-resume` flaked once in a sandbox.** It failed once and passed on rerun; the
  cause was not established and no reproduction is recorded. Re-run it after a failure, and treat
  a repeat as a defect.

## Approvals and the firewall

The [Agentic security, alignment and autonomy proposal](proposals/agentic-security-and-alignment.md)
sets out coordinated security levels, trusted content admission, intent review, OpenAPPA integration
and verified container autonomy. It includes a staged pi 0.99.2 compatibility workstream and
acceptance gates. The [Security level](security-level.md) control implements the local lever;
content screening, the OpenAPPA flow engine, intent ledger, detector, authenticated operator
events and verified off-boundary attestation remain unimplemented. Relaxed has no additional
medium-tier routine admission set. Remaining proposal work is not a current guarantee.

- **Inline interpreter code is matched coarsely, not understood.** The firewall and
  `protected-paths` share one fail-closed rule: inline code run by a listed interpreter family,
  wrapper or shell that mentions an agent-configuration segment or distinctive tail next to any
  write- or exec-capable call is high and blocked, and it over-blocks such code by design
  ([Security](security.md) lists the families, wrappers and shells). It cannot see a path computed
  entirely at runtime with no distinctive segment or tail in the command text (character codes,
  decoded strings, a value read from a file), an unlisted interpreter or wrapper, nor code run from
  a script file; closing that needs
  the operating-system or container boundary below, not more text matching.
- **It is a guard rail, not a sandbox.** Containing what an allowed tool can reach needs an
  operating-system or container boundary (the autonomous runner provides one).
- **Low-tier actions run unasked in every mode**, including covered core-tool reads, explicitly
  allowed external APIs and plain shell network GETs. Read-like external names confer no authority
  (`tests/firewall-shell-smoke.ts`, `tests/firewall-gate-smoke.ts`). Tightening allowed reads would
  require a separate policy choice.
- **Package-manager and opaque-tool network use cannot be attributed to a host** in unattended
  runs; the container network is the stop.
- **`secret-guard` is in two profiles only.** It loads in `balanced` and `autonomous`; whether the
  other profiles should load it needs data on its false-positive rate (its path rule blocks every
  write to a path containing `secret` or `credentials`).
- **Unreviewed companion shell/edit tools** (for example `pi-lean-ctx`) need exact policy entries
  or operator approval; parsing a shell-looking field cannot confer trust
  (`tests/firewall-shell-smoke.ts`). Reviewed companion helpers have shipped entries, but
  multi-target mutations still ask. Covering more shapes requires reviewed effect adapters.
- **Exact tool names do not bind implementations.** Replacement code inherits the policy for its
  registered name, and direct I/O by in-process extensions is outside interception. No test proves
  isolation or implementation binding; that needs a boundary outside the pi process. See
  [Security model](security.md#what-the-boundary-does-not-guarantee).
- **Nested-call evidence uses synthetic events.** `tests/firewall-gate-smoke.ts` models pi 1.3's
  `parentToolCallId` and child ids and proves parent approvals do not authorise children. No smoke
  drives the real codemode worker or `ctx.executeTool()` through the installed pi runtime.
- **Unattended mode trusts the supervisor's claim** that its boundary exists. It requires the
  contract to be on a read-only mount (or another user's unwritable file) seen from the initial
  user namespace, which an agent's shell cannot fake, and a forged launch from an interpreter is a
  safety-setting override. What remains: something that can run code inside the pi process, or
  act as root. Tying the contract to a secret only the supervisor holds would close the last gap,
  and would also let workers under a rootless engine run unattended, which the namespace rule
  currently refuses. The autonomy boundary probe does not yet report whether the worker is in the
  initial user namespace.
- **The `pentest-governance-domain` extension's human-console approval request** is still written
  with plain `fs` calls and remains on the ESLint allowlist as a known gap; moving it to the
  safe-write helper is pending. The human console's own request, answer and audit files and the
  tool firewall's request file use the helper.
- **Inline interpreter code that builds a credential path at run time** (rather than naming it
  literally) is not recognised by the classifier.
- **Approvals bind command text, not effect.** An approved `git push` follows a re-pointed remote,
  and an approved script runs after an edit. Binding an approval to the resolved effect (the remote
  URL, the script's content hash) would close it, at the cost of more prompts.
- **A script the agent wrote can set the unattended variables** where the classifier sees only
  `bash run.sh`. The provenance rule stops it from working; the classifier cannot see it.

## Profiles and compaction

- **A profile switch cannot undo** package payloads that `pi install` already fetched, a
  concurrent write to pi's settings, or a hard kill of pi part-way through. Rollback restores the
  settings files it snapshotted. The verifier may also roll back a good switch where Luna's
  entry cannot be identified (symlinked or unusual npm layouts); git and npm delivery of `/profile`
  are less exercised than local mode.
- **`lite` and small windows.** pi's default compaction reserve (16384 tokens) on a 32k window makes
  pi compact almost every turn; `/compaction status` now warns, but the `lite` profile does not yet
  carry its own `compaction` settings.
- **`autonomous` and `long-horizon`** load nearly the same set; the difference is the autonomous run
  tooling ([Autonomous runs](autonomy.md)).

## Remote control

- **Critical-tier approval cards start on *Allow once*,** like every other card (the SEC-5
  decision, [Remote control](remote-control.md#the-yes-first-decision-sec-5)). Starting critical
  cards on *Deny*, or requiring an explicit gesture for them, would compensate further.
- **The Android app lock is off by default.** Turning it on by default needs a first-run flow that
  explains it.

## Web console

- The session panel shows an unknown context percentage as 0%.
- The login link is passed to `xdg-open` as an argument, and the token file is readable by the agent
  the console drives (both are documented in [Web console](web-console.md); the firewall classifies
  reading the token file as a credential read, which asks you but is not a lock). Moving the token
  behind a one-time exchange, so it never appears in a command line, would close the first.

## Releases and repository governance

- **Signed release tags.** Tags are annotated, not signed, and `/update` verifies no signature.
  Signing `v*` tags, publishing the allowed signers and verifying them in `/update` would bind a
  release to the operator's key.
- **A branch-namespace rule** restricting who may create which branch names.
- **A scheduled settings drift check** that fails when the live repository settings differ from
  `.github/expected-settings.json`; it is run by hand before releases.
- **A blocking ReDoS rule in the `semgrep` job.** ESLint rejects non-literal regular expressions,
  and CodeQL's ReDoS queries block a merge only through the declared code-scanning merge
  protection; no Semgrep rule for slow patterns is added.
- **Image scanning in CI.** Container images are scanned by hand when they change
  ([Vulnerability management](vulnerability-management.md#risk-acceptance-register)).

## Dependencies

Candidates that were evaluated and deliberately not adopted for the beta (`pi-readseek` 0.12.x,
`pi-subagents`, TypeScript 7) are recorded with their reasons: TypeScript 7 and `pi-readseek` in
[Supply chain](supply-chain.md), and `pi-subagents` in
[Lessons from the private system](private-system-lessons.md). Revisit each with its own review.

## Quality of long-running work

- **Long-context reliability in planning and assessment.** Plan quality can degrade silently in very
  long sessions. Open question: which of the sieve, the goal file and the task graph carries the
  load, and how to measure it.
- **Skill disclosure and use.** How often skills are actually loaded when relevant, and whether the
  routing hints help or duplicate machinery, has not been measured.
- **Injection review.** A written review of untrusted-content handling across context contributions,
  tool results and memory recall (an injection inventory with a test per path) is still to be done.

## Related records

- [Roadmap](roadmap.md)
- [Security model](security.md)
- [Recovery orchestration mode](recovery-orchestration-mode.md): the design behind `recovery-orchestrator`
