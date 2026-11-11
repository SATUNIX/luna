# Handoff — run `luna-core-01`, stream `core`

## Where the work stands

- Branch `pi/luna-core-01`, base `ce87a25c92de` (head of `stream/core`, cycle 05 merged). Cycle 06
  commits, all pushed: `9139ad6` (PG-27 eval baseline), `5fe9e95` (trunk consolidation), plus the
  records under `autonomy/cycles/luna-core-01/06/`.
- Cycle 06 outcome: **successful** (improve + consolidate).
- Reviewable diff 37,823 chars — under the 60,000 read budget, past the 30,000 stop-new-items mark.

## What cycle 06 did

1. **Board PG-27 (improve).** New `packages/core/eval/baseline.ts`: `--write` spawns
   `run.ts --json`, records `baselines/YYYY-MM-DD.json` (success rate, per-category stats, an
   offline chars/4 `tokens` estimate labelled `tokensBasis`); `--check` fails closed when the newest
   record is missing, malformed or older than 7 days (age from the dated name, never mtime).
   Committed the first baseline `baselines/2026-11-11.json`; new `tests/eval-baseline-smoke.ts` and
   the one allowed `smoke:eval-baseline` script; `docs/ARCHITECTURE.md` and `CHANGELOG.md` updated.
   Independent `reviewer` subagent returned `VERDICT: PASS`.
2. **Consolidation of cycle 05 (fix).** Added `trunk` to the four prose channel enumerations
   (`docs/index.md`, `docs/architecture/profiles-and-install.md`, `docs/repository-topology.md`,
   `docs/migration.md`), and refused the git-only channel on npm delivery in `install.ts` and
   `kit-update`'s npm switch (the two npm pinned notes now read `latest|next`), with one new
   `tests/kit-update-channel-smoke.ts` case.
3. **Board PG-10** was already done and merged in cycle 05; no work needed.

## Checks that were run

`node tests/eval-baseline-smoke.ts` (4), `smoke:kit-update-channel` (7), `smoke:kit-update` (40),
`smoke:distribution` (14), `npx tsc -p packages/core/tsconfig.json`, `npx tsc -p tests/tsconfig.json`,
`npm run test:lint`, `node tests/docs-smoke.ts`, `node packages/core/check-all.ts --check-wiring` —
all PASS. Never run `npm test` or `npm run check:all`. See `verify.md`.

## Merge

Cycle complete; targeted checks pass and PG-27 has an independent review. Item 2's delegated review
was blocked by the effort child budget, so the merge reviewer should look at `5fe9e95` closely.
Merge `pi/luna-core-01` into `stream/core` only after the acceptance checks pass on a clean checkout.

## Carry over to the next cycle

1. `packages/core/install.ts`'s npm/`trunk` guard is untested while `distribution.json` has no
   `npm.enabled`; add a test when npm delivery is enabled. The rest of
   `autonomy/proposals/luna-core-01-05-npm-trunk-channel.md` is implemented and can be closed.
2. Cycle 03's env-ownership work (`472a37f`, `0b02622`, `31d77ca`) is on
   `origin/attempts/luna-core-01/cycle-03` only; sound but not re-verified on this base.
3. Proposal `luna-core-01-03-codeowners-dead-path.md`: `.github/CODEOWNERS:43` names a path with 0
   tracked files. `.github/` is a control path — operator decision.
4. Defect IDs V-07/V-08/V-10 still have no in-tree finding list; need the operator's list.
5. The `coverage` CI job is red owner-side; not touched, per the steward.

## Rules for the next session

One logical change per commit (finding, root cause, fix, verification), push after each commit,
targeted checks only, diff read budget 60,000 chars and stop new items past 30,000, never edit
`.github/`, `autonomy/CHARTER.md`, or operator control paths (propose them instead). The only
allowed `package.json` edit is adding `smoke:<name>` → `node tests/<name>-smoke.ts`. Cite only the
new board-id shape (`PG-<n>`, `DE-<n>`); old single-letter-hyphen-digit ids are blocked by the
pre-push leak scan.
