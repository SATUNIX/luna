# Plan — cycle 12, run `luna-core-01`, stream `core`

Mode: fix + improve. Base `363dba0b9a25`. Order follows the steward backlog: PG-55, then PG-19,
then V-81 (P1, only if budget remains). One logical change per commit.

## Item A — PG-55 positive exit path (P0, first)

**Justification.** Board item; the operator's "Remove the identifier and resume" answer is the only
exit from the two-unpublished-cycle park. `f24a144` made the answer run one cycle,
`tests/autonomy-selfimprove-smoke.ts:670`, but no test proves the intended success path, and the
steward records the item as not done.

**Change.** Extend `tests/autonomy-selfimprove-smoke.ts` with a case that parks on `publish-blocked`
at two refused merges, answers, then runs a cycle whose script removes the leak so the cycle
publishes: assert the cycle merges, `publishBlocker`/`publishBlockedCycles` clear
(`self-improve.ts:233-234`), the run leaves the blocked state, and a further cycle starts. If the
test exposes a real defect on that path, fix it in `packages/autonomy/lib/templates/self-improve.ts`
(or wherever the trace points) in the same commit.

**Proof.** `node tests/autonomy-selfimprove-smoke.ts` (new case fails without the added coverage
only if a defect exists; it must pass with the code as fixed). Typecheck for any product edit.

**Docs.** `docs/autonomy.md` already states the one-cycle-per-answer rule; update only if the fix
changes it.

## Item B — PG-19 paperwork budget (P0)

**Justification.** Board item; of the trunk's +658 added lines, 79 % are autonomy docs, and cycle
11's four cycle docs total 245 lines. A measured cap is the token-efficiency gate the board asks
for. Adding a `smoke:<name>` script is explicitly reviewable (`review.ts:170-187`).

**Change.** New `packages/core/autonomy/paperwork-budget.ts`: a pure
`checkPaperworkBudget(dir, { limitLines })` that reads `review.md`, `plan.md`, `report.md`,
`verify.md` in a cycle directory, returns per-file line counts and the overruns, and a `main` CLI
that prints the per-file breakdown and exits 1 when the total exceeds the cap (default 60). New
`tests/paperwork-budget-smoke.ts`: a 120-line fixture fails with the per-file breakdown and a named
overrun; a 40-line fixture passes; the CLI exit codes match. Add
`"smoke:paperwork-budget": "node tests/paperwork-budget-smoke.ts"` to root `package.json`.
Document the cap where cycle bookkeeping is described (`docs/autonomy.md`).

**Proof.** `node tests/paperwork-budget-smoke.ts`; `node packages/core/check-all.ts --list | grep paperwork-budget`.

## Item C — V-81 footprint CLI (P1, budget permitting)

**Justification.** Board item; the module's own header documents a command that prints nothing.

**Change.** Add a `main` guard + CLI to `packages/core/eval/footprint.ts`: `--profile NAME`,
`--json`, `--write-baseline`; `--json` prints the footprint plus `tokens = ceil(toolText/4)`, an
unknown profile exits non-zero on stderr, `--write-baseline` rewrites `footprint-baseline.json`
only when the measurement differs. Add spawn cases to `tests/eval-footprint-smoke.ts`: two
`--profile lite --json` runs are byte-identical, an unknown profile fails, `--write-baseline` leaves
the file byte-identical when unchanged. Add a Measuring section to `docs/efficiency-and-loops.md`.

**Proof.** `node tests/eval-footprint-smoke.ts`.

## Checks

Targeted scripts only: `smoke:autonomy-selfimprove`, `smoke:paperwork-budget`, `smoke:eval-footprint`,
`test:typecheck`, `test:lint`, `smoke:docs` at the end. Never `npm test` or `npm run check:all`.
Reviewable diff measured after every commit; new items stop past 30,000 characters.
