# Cycle 09 review — luna-ops-01

Base: `83a3ad8` (branch `pi/luna-ops-01`). Assigned work: **PG-50**, **PG-53**.
Charter: `autonomy/CHARTER.md` (real evidenced problem, tested, documented, scoped, gate-run).
Stream: ops (autonomy harness, installer, workflows command, CI and gate speed).

## Prior state

Cycle 08 is complete and verified at `ab212b0` (PG-20, PG-45, DE-93). Working tree clean at
review time; no unpushed commits. HANDOFF records PG-46 as carried, not taken (reviewed diff
49,415 chars > 30,000 stop line).

## P0 gate repair — pre-push leak scan blocked the unpublished range

**Problem.** The `11:03:42Z` push was refused:
`publication blocked by pre-push leak scan: 3c7c8aede6c2 message line 1: blocked identifier (value redacted)`.
Commit `3c7c8aede6c2`'s subject carried a board id in the old shape; the owner renamed every board
id at `10:15Z` (`P-<n>` → `PG-<n>`, `D-<n>` → `DE-<n>`), and the leak scan blocks the old shape in
commit messages as well as added lines. Cycle records 06–08 carried old ids too. `git
packages/core/prepush-scan.ts range 83a3ad8..HEAD` reported 35 findings in 16 commits.

**Fix (operator-provided recipe, unpublished range only).** Backed up
the branch locally as `backup/pre-rename-20261111`, then ran `git filter-branch` over
`83a3ad8..HEAD` with a `--msg-filter` and `--tree-filter` rewriting the old-shaped ids in messages
and tracked files to `PG-<n>`/`DE-<n>`. No force-push, no deletion or rewind of a ref, no
`--no-verify`, no hook or scan change. `node packages/core/prepush-scan.ts range 83a3ad8..HEAD` now
reports `17 commit(s) checked, no blocked identifiers or private paths`; no subject or tracked file
after `83a3ad8` matches the old shape. Pushed as `HEAD:stream/ops` (fast-forward), published head
`c01c4488a000774a75507fd56cca834c6b394f6b`.

## PG-50 — bound concurrent acceptance gates on one host

**Problem.** Acceptance checks are the expensive, CPU/IO-heavy part of a cycle. Nothing bounds
how many supervisors run their gate at once on one host. Evidence:

- `packages/autonomy/lib/runlock.ts` locks **one run**: a single owner per run directory
  (`supervisor.lock`). It has no host scope.
- `packages/autonomy/lib/runtime.ts:573-587` (`runCheck`) spawns the gate container immediately
  via `helper()` (`runtime.ts:227-243`). Gate container names are unique per spawn
  (`docker.ts:57-70`), so there is no name collision and no serialization.
- `packages/autonomy/lib/runcfg.ts:21-45` has `gate.{memory,cpus,timeoutMinutes}` but no
  concurrency field; `EngineOptions` (`engine.ts:193-202`) likewise.
- The only host namespace is `stateHome()` (`paths.ts:6-7`, `$PI_AUTONOMY_HOME`), already shared
  by every run of the user.

**Impact.** Several runs on one host contend for CPU/RAM/IO during their gates. A heavy gate can
starve a sibling run and make an unrelated check flake, which is exactly the PG-50 measure:
share of cycles rejected for a gate failure unrelated to the change (baseline 14 of 25 on
2026-11-11).

**Intended change (host-side only).** Add a per-host slot bound of N (default 2, `0` = unbounded)
read once by the supervisor. Before an acceptance gate, the supervisor takes one of N slots,
holding it for the whole gate; the wait is a visible `gate-wait` phase with a heartbeat and does
**not** accrue against the run's wall-clock budget. Nothing inside the gate container changes; no
check is skipped or relaxed.

**Acceptance test.** Start three gate phases with N=2: at most two overlap, the third waits then
runs; a killed holder frees its slot; N=0 behaves as today; the wait phase is visible in run
status.

## PG-53 — tool-firewall refuses unattended mode on the worker

**Problem.** Every worker session log opens with
`tool-firewall: WARNING — unattended mode was requested (PI_KIT_UNATTENDED) but is NOT active:
this process is not in the initial user namespace ...`. Evidence: cycle 08
`steps/08/agent-11..14.log`; luna-ux-01 cycle 10 `steps/10/agent-12.log`; `unattended.ts`
namespace proof.

**Consequence.** The contract says unattended, but the firewall escalates every non-routine call.
Cycle 08 asked a person twice; each answer restarts the session (~30 calls, 88 min, $0.555);
the manager firewall logged 10 operator prompts, 2,319 s waiting and one timeout.

**Decision: not fixed this cycle.** Fixing it is a security-review decision, not a scoped ops
change. The check may not be deleted or loosened (it is a fail-closed control; see the standing
preference "fail-closed harness must not be loosened"). The two honest paths are:

1. Run the worker in the initial user namespace (container configuration owned by the operator),
   or
2. Make the namespace test two-sided and admit a genuine container worker while still refusing an
   `unshare`-ed user process, with both halves pinned by a test.

Path 2 needs a precise provenance argument and a second independent check; path 1 is an
operator/security decision outside this stream. Filed as a proposal
(`autonomy/proposals/luna-ops-01-09-tool-firewall-unattended-namespace.md`) with the evidence and
both options, so the next cycle inherits a scoped decision rather than a silent warning.

## Out of scope / proposals

- `--scope project` install writes the global `<agent dir>/.env` (`install.ts:728-739`) though
  `docs/INSTALL.md:65` promises project-only writes → proposal (operator decision).
- Missing cycle-06 installer proposal cited by `HANDOFF.md:48-49`; raw stack traces from
  `install.ts:120/416/511` → restore the proposal.

## Advancement

Fix mode. One item (PG-50) implemented and tested; PG-53 recorded as an operator/security
decision.
