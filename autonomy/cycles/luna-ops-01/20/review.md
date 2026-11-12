# Cycle 20 review — luna-ops-01 (ops stream)

Charter read in full. Precedence at start: (0) gate green and tree clean at `6aeb90441a4b`
(`git diff 6aeb90441a4b..HEAD` is empty), (1) no upstream conflict, (2) board item PG-52 (P1),
then (3) HANDOFF carry-overs, (4) defects, (5) security, (6) tests/docs, (7) cleanup.

Cycle 19 closed successful by landing PG-52: `packages/core/lib/check-map.ts` maps changed-path
globs to checks, `check-all.ts --for-changed=<a,b>` prints the plan, and the cycle prompt requires
deriving the verify list from the diff and recording every check RAN or SKIPPED. This cycle is a
consolidation pass over that change, per the charter's "new code is where the next bugs are".

## PG-52 follow-up — the cycle-19 map still misses reds it exists to catch

The map is real and wired (`packages/core/lib/check-map.ts`, `--for-changed`), but it is a coarse
hand table. Reproduced gaps at `6aeb90441a4b`, all with
`node packages/core/check-all.ts --for-changed=<path>`:

1. **Both sides of a byte-copy pair are not mapped.** PG-52's motivating incident was
   `smoke:workflow-notify`, which asserts the functions in
   `packages/extensions/third_party/subagent/fence.ts` are byte-identical to **two** sources:
   `packages/autonomy/lib/templates/common.ts` (`clip`/`untrusted`) and
   `packages/extensions/src/secret-guard/index.ts` (the secret-read-path predicates)
   (`tests/workflow-notify-smoke.ts:59-64`). A change to either **source** side can break it, yet:
   - `--for-changed=packages/extensions/src/secret-guard/index.ts` prints
     `check-all: skipped: smoke:workflow-notify` and `skipped: smoke:secret-guard`.
   - `--for-changed=packages/autonomy/lib/templates/common.ts` prints
     `skipped: smoke:workflow-notify`.
   Only the `third_party` copy side (row `packages/extensions/third_party/**`) is mapped, so a
   cycle that diverges a source copy still cannot see its own red — exactly the failure mode the
   board item names (luna-guard-01/03).

2. **A changed test file never plans its own check.** The map keys on source-directory globs
   only. `--for-changed=tests/autonomy-selfimprove-smoke.ts` prints no
   `check-all: run: smoke:autonomy-selfimprove` at all (it plans only the always checks). The
   package.json script that runs a changed test file is mechanically known
   (`packages/core/lib/wiring.ts` `scriptTargets()` builds file -> scripts), so this can be derived
   instead of hand-maintained.

3. **Plan mode prints a contradictory informational line, twice per normal run.**
   `checkNames()` (`packages/core/check-all.ts`) prints
   `check-all: skipping test:security: …` before the `--for-changed` plan, which runs nothing. It is
   also printed twice in a normal run because `buildRuns()` calls `checkNames()` again
   (`--list 2>&1 | grep -c 'skipping test:security'` = 2; `--for-changed=docs/guide.md` = 1).
   Cycle 19's own reviewer flagged this as a non-blocking follow-up.

Root cause of (1) and (2): the selector only consults a static directory table, so relationships
that live in tests (a byte-copy pair; a script that runs a file) are invisible. Fix: add the pair
rows as data, and union the static table with the checks whose script directly runs a changed file
(`scriptTargets`), keeping the table (data) as the spine. Suppress the informational line in plan
mode and print it once per run.

## Other candidate items checked

- **No open board item besides PG-52** (prompt's assigned list).
- **HANDOFF carry-overs**: the re-land requirement (the run branch carries the cycle-12 `-s ours`
  bridge, integrator must fast-forward `stream/ops` from `pi/luna-ops-01-reland`) is an operational
  fact, not a code change; nothing else is owed.
- **Proposals** `autonomy/proposals/luna-ops-01-*.md` hold deferrals (journal flake, firewall
  unattended namespace, installer CLI, publication re-land) — none is this stream's assigned work
  and none blocks PG-52.
- **Upstream**: integration head is an ancestor of the branch head; no merge conflict.

Mode: **fix** (consolidation of the merged PG-52 improvement), single item.
