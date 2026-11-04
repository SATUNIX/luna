# Cycle 09 — Plan

- Run: `luna-improve-01`, cycle 09
- Branch: `pi/luna-improve-01`
- Cycle base (HEAD): `b05a67174f759bf8e7520fdb0b7adca38585e6ed`
- **Mode: Fix mode.** The review found a correctness bug (`uninstall.ts` argument handling) and a
  dead-code item. A fix-mode cycle is required; cycle 08 was also fix mode, so no
  "consolidate after improving" pass applies.

## /goal

Complete cycle 09 of `luna-improve-01`: make `packages/core/uninstall.ts` reject invalid and
unknown arguments with a clear error and exit 1 (with a regression test), remove the dead
`getExternalByProfile()` export, then record `autonomy/cycles/luna-improve-01/09/report.md`. The
cycle is done when the install-marker and sources smokes plus typecheck/lint are green, an
independent reviewer passes the diff, and the report is pushed.

## Work items and charter justification

### Item 1 (F-1) — validate `uninstall.ts` arguments — priority 3 (correctness/reliability)

- **Intended change.** In `packages/core/uninstall.ts`, add a flag-validation loop before scope
  resolution, mirroring `packages/core/install.ts:89-105`:
  - `VALUE_FLAGS = ["--scope"]`, `BOOLEAN_FLAGS = ["--dry-run", "--yes"]`.
  - Reject an unknown argument (`unknown argument "<arg>"`).
  - Reject a value flag whose value is missing or starts with `--` (`<flag> needs a value`).
  - Reject `--scope` other than `global|project`.
  - Print `[uninstall] <problem>` and a `usage: uninstall.ts ...` line to stderr, then
    `process.exit(1)`.
- **Why.** Today `--scope bogus`, a trailing `--scope`, and any unknown flag are silently ignored,
  and the script falls through to auto-detected scope. On the destructive path that can remove the
  wrong install. `install.ts` already has this guard for the install path; uninstall was missed.
- **Proving check.** Extend `tests/install-marker-smoke.ts` (mirroring `testInvalidScopeRejected`
  and `testUnknownFlagsRejected`) with `--scope bogus`, `--scope` with no value, and `--dryrun`:
  assert exit 1, assert the message, and assert `PI_FAKE_LOG` stays empty (no `pi` call). Run
  `npm run smoke:install-marker`.

### Item 2 (F-2) — delete dead `getExternalByProfile()` — priority 6 (dead code)

- **Intended change.** Delete the unreferenced exported function from
  `packages/core/lib/sources.ts:43-46`.
- **Why.** No caller anywhere in the repo; not part of a public entry (`package.json` has no
  `exports`, only a `bin` map). Dead surface.
- **Proving check.** `npm run test:typecheck`, `npm run test:lint`, `npm run smoke:sources`.

Both items are disjoint in kind but sequential in commit order (Item 1 first, Item 2 second) so each
can be independently reviewed and reverted.

## Out of scope / deferred

- eval `--category` missing-value validation (`packages/core/eval/run.ts:21`) — recorded in
  `BACKLOG.md`, low impact.
- installer raw `writeFileSync` (`packages/core/install.ts:738`) — already documented as pending in
  `docs/future-work.md:95`.
- B-007 operator proposal — out of bounds.

## Task graph

- `t1` — F-1: validate uninstall.ts arguments.
- `t2` — F-2: delete dead getExternalByProfile().

## Verification plan

1. `npm run smoke:install-marker` and `npm run smoke:sources` green.
2. `npm run test:typecheck` and `npm run test:lint` green.
3. Independent reviewer checks `git diff b05a671..HEAD` against this plan and the charter, per item.
4. Acceptance: repo `verify`/gate on a clean checkout of the pushed head.
