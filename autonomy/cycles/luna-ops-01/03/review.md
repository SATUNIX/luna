# Cycle 03 review — `luna-ops-01` (stream ops)

Base `a5d1811ab5da` (head of `stream/ops`, which already contains cycle 02). Working tree clean;
`git log --oneline a5d1811..HEAD` is empty. Read: `autonomy/CHARTER.md`,
`autonomy/runs/luna-ops-01/HANDOFF.md`, cycle 02 `report.md`/`verify.md`, the two proposals under
`autonomy/proposals/`, and the code the assigned items touch.

## Assigned items: already merged in cycle 02

- **A-91** is complete on this base. `packages/autonomy/lib/rpc.ts` `HARNESS_COMMANDS` is the six
  names `goal, handoff, verify, firewall:status, orchestrate, trace` (rpc.ts:216), `subagents` is
  gone, and `HarnessCheck` (rpc.ts:235) is per-session with `HARNESS_CHECK_TIMEOUT_MS = 30_000`
  (rpc.ts:219). `runtime.ts` resets it in `startWorker` (runtime.ts:494), arms the timeout
  (runtime.ts:504-508) and settles on the `get_commands` reply (runtime.ts:510-515). Cycle 02
  commits `bd90afe`, `13e608f` are ancestors of the base. Nothing to redo; verify only.
- **A-01**'s code is complete (`ff5d8ed`, `d1d0292` ancestors), but the **check it wired in now
  fails on this base** — see the red gate below. So the assigned item is not actually satisfied on
  the branch, and this cycle's work is A-01.

## Priority 0 — red gate: `smoke:docs` fails on the base

`npm run smoke:docs` exits 1 on a clean base:

```
AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports
+ [ 'report with no journal entry: luna-core-01/01; add: - luna-core-01/01 | Board: none | successful | <summary>' ]
- []
  at tests/docs-smoke.ts:491
```

Root cause: the base is `merge integration/luna into stream/ops`, and integration/luna carried the
core stream's cycle report `autonomy/cycles/luna-core-01/01/report.md` (present in `a5d1811`). The
core cycle predates A-01 and never wrote a journal line; the ops journal is run-agnostic
(`autonomy/JOURNAL.md` lists `luna-improve-01/04`…`/09`), so its report→entry check correctly flags
the missing line. The check is working; the data is incomplete. Because `smoke:docs` is part of the
host gate's suite, the branch is currently unmergeable. This is the cycle's top-priority fix.

## Defect found in A-01's checker (cleanup of the assigned item)

`checkJournal` (packages/core/lib/journal.ts:94) enforces report→entry and entry→existing-directory
(journal.ts:105-107), but an entry whose directory exists with **no `report.md`** passes. That is
the reverse drift the A-01 invariant ("exactly one line per report") implies, and it is already
recorded as an open proposal from cycle 02:
`autonomy/proposals/luna-ops-01-02-journal-orphan-entry.md`. A copied or mistyped key can therefore
linger forever. Small, tested hardening of the assigned item, so it is taken here (charter priority 7
on code the assigned item added), with the close-out exception preserved.

## Checked and not taken

- **B-011** (`HANDOFF.md`): "`eval/run.ts:21` ignores `--category` with no value". Already fixed on
  this base by core cycle 01 (`packages/core/eval/run.ts:34-47` refuses a missing/unknown value,
  exit 2). Stale carry-over.
- **`npmDeliveryEnabled()` vs `docs/releasing.md`** (`HANDOFF.md`): `install.ts:210-223` refuses npm
  delivery unless `distribution.json` enables it, and `docs/releasing.md:184` says npm delivery is
  not enabled. Consistent; no drift found.
- **Installer doc drift** (`HANDOFF.md`): no evidence located in this pass; left.
- **A-91** has no remaining work, so no new commits there.

## New problems for proposals (not this cycle)

- The red gate shows a process gap: another stream's merged cycle needs a journal line it cannot add
  itself. A mechanism to make the journal entry part of the cross-stream merge (rather than a later
  ops cycle) is a proposal candidate.
