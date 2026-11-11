# Cycle 02 — Review

Run `luna-ops-01`, branch `pi/luna-ops-01`, base `dc71c739409e` (head of `stream/ops`).
Stream: **ops** — autonomy harness, installer, workflows command, CI and gate speed.

## Charter and precedence

`autonomy/CHARTER.md` read in full. This cycle's board items outrank HANDOFF carry-overs
(charter priority 2 over 3). Cycle 01's uninstall fix is a carry-over (priority 3): its
acceptance ran red on `check-all`, `check-all:smoke:env-isolation` and
`check-all:smoke:workflow-redaction`, but those two smokes pass on this branch's head
(see gate check below), so the red gate is not reproducible here. The work itself was sound
and is left for a later item rather than taken before A-91.

## Gate check (priority 0)

- `npm run smoke:env-isolation` → exit 0, `[env-isolation-smoke] OK`.
- `npm run smoke:workflow-redaction` → exit 0, `workflow-redaction-smoke: 4 checks passed`.
- The cycle-01 rejection named these plus `check-all`, which cannot be run here (10+ min).
  Neither failing smoke reproduces on `dc71c739409e`, so this branch is not red. Recorded,
  not taken.

## Findings

### A-91 [P0] HARNESS_COMMANDS names a command the kit no longer registers

Confirmed against the code:

- `packages/autonomy/lib/rpc.ts:214` requires `subagents` among the seven harness commands.
- `a69f0ef` (2026-11-10, "trim the delegation surface") removed `/subagents`; the
  registered-command sweep over `packages/extensions/**` has no `registerCommand("subagents")`.
- The worker image installs `long-horizon` (`packages/autonomy/image/Dockerfile:73`), whose
  `include` (`packages/kit/profiles/long-horizon.json`) contains no extension that
  registers `subagents`; the six other required names all come from in-profile extensions
  (`goal-core`, `handoff`, `verify-gate`, `tool-firewall`, `orchestrator`, `trace-ledger`).
- Three tests pin the removal: `tests/docs-smoke.ts:421`, `tests/run-query-smoke.ts:396`,
  `tests/subagent-observability-smoke.ts:135`. Fix the list, never re-register the command.

Two further faults in the same check, as the board notes:

- `packages/autonomy/lib/runtime.ts:511` writes the `get_commands` frame and never times it
  out: a reply that never arrives leaves `workerProblem()` null and the session runs
  unverified.
- `harnessFailure`/`harnessOk` are cleared only in the constructor (`runtime.ts:182-183`) and
  set at `runtime.ts:508-509`; a single bad session latches and kills the run at the next
  step boundary (`engine.ts:486`), and a later, good session cannot clear it.

Evidence: rpc.ts:214; runtime.ts:182-183,508-511; engine.ts:486,671; long-horizon.json;
Dockerfile:73; `git show a69f0ef`.

### A-01 [P1] Team journal

Confirmed absent on the branch: `autonomy/JOURNAL.md` and `autonomy/decisions/` do not exist;
`.gitattributes` ends with `*.zip binary`. `autonomy/cycles/**/report.md` exists for
`luna-improve-01` 04–09 (and legacy layouts). Board item is real and self-contained, but it
is P1 and its acceptance owns `tests/docs-smoke.ts`; taken after A-91 only if budget allows.

### New problems (scouted, not taken)

None found that block A-91/A-01. The HANDOFF carry-overs (B-011 `eval/run.ts:21`,
installer doc drift, `npmDeliveryEnabled()` vs `docs/releasing.md`) are unchanged and stay
recorded.

## Decision

Mode: **fix mode** (A-91 is a real, evidenced, P0 defect). A-91 is the cycle's item.
A-01 is P1 on the same board and follows it if budget and time remain.
