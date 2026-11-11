# Plan — cycle 06, run `luna-core-01`, stream `core`

Base `ce87a25c92de`. Mode: **improve** (board PG-27) + **consolidate** (cycle 05's trunk channel).

Goal: record the missing offline eval baseline (success rate, per-category, tokens) behind a dated
artifact and a freshness check, and close the two gaps cycle 05's trunk change left (docs drift and
the untested npm/`trunk` edge), all with tests and docs and within the diff budget.

## Item 1 (board PG-27) — dated eval baseline + freshness check

**Justification.** The board records that the eval success rate and gate time per cycle have never
been recorded, so no later cycle can prove it moved a number. `packages/core/eval/run.ts` measures
17/17 fixtures but writes nothing down; the design [REDACTED]
(`footprint-baseline.json`) is a single reviewed file with no notion of "when". Acceptance is
verbatim from the board: `node packages/core/eval/baseline.ts --write` produces a dated JSON
baseline (success rate, per-category, tokens) and `--check` fails when the newest baseline is
missing or older than 7 days, pinned by a new `tests/eval-baseline-smoke.ts`.

**Change.**
- New `packages/core/eval/baseline.ts`: a CLI + pure helpers. `--write` spawns
  `run.ts --json` (it is a top-level CLI that `process.exit`s, so spawn, do not import), validates
  the payload with `lib/guard.ts`, summarises totals + per-category rates, estimates `tokens` as
  `ceil(summaryText.length / 4)` (the repo's existing chars/4 ratio, clean-room source
  `packages/extensions/src/context-sieve/index.ts`; labelled `tokensBasis`; the offline harness has
  no provider usage) and writes `baselines/YYYY-MM-DD.json` atomically. `--check [--dir]` finds the
  newest dated file, fails closed on none/malformed, and fails when age > 7 days (age from the
  name/embedded date, never mtime — a clone rewrites mtime).
- Commit one real baseline `packages/core/eval/baselines/2026-11-11.json` so the record exists.
- New `tests/eval-baseline-smoke.ts` covering: `--write` shape/date/totals/per-category/tokens;
  `--check` fresh passes; missing fails; >7-day fails and exactly-7 passes; newest is selected;
  malformed newest fails closed; pure summariser/token estimator.
- `package.json`: the one allowed script addition `"smoke:eval-baseline": "node tests/eval-baseline-smoke.ts"`
  (next to `smoke:eval-footprint`). This is also what `lib/wiring.ts` requires for a new smoke file.
- Docs: one clause in `docs/ARCHITECTURE.md`'s eval bullet naming the baselines and the test; a
  `CHANGELOG.md` entry.

**Checks (only these; never `npm test` / `npm run check:all`).**
`node tests/eval-baseline-smoke.ts` (or `npm run smoke:eval-baseline`), `npx tsc -p packages/core/tsconfig.json`,
`npx tsc -p tests/tsconfig.json`, `npm run test:lint`, `node tests/docs-smoke.ts` if docs move,
`node packages/core/check-all.ts --check-wiring`. A `reviewer` subagent that did not write the change
reviews the diff and must end `PASS`.

## Item 2 (consolidation of cycle 05) — finish the `trunk` channel edges

**Justification.** Cycle 05 shipped `trunk`; four hand-written prose enumerations still omit it
(live docs drift, charter priority 6), and the git-only channel is accepted on the npm delivery path
where it builds a dist-tag nothing publishes (`install.ts:271-275`, `kit-update/index.ts:1077-1083`,
`:624`, `:667`). The npm path is unreachable while `npm.enabled` is absent, but it is untested and
becomes a real misfire the day it ships — an edge of the change this cycle is consolidating.

**Change.**
- `packages/core/install.ts`: refuse `--channel trunk` when the effective mode is npm, with
  "trunk is a git channel".
- `packages/extensions/src/kit-update/index.ts`: in the npm branch of `planChannelSwitchSteps`,
  refuse `trunk`; fix the two pinned notes to `latest|next`.
- `tests/kit-update-channel-smoke.ts`: add a case asserting npm + `trunk` is refused and the note
  no longer advertises it.
- Docs: add `trunk` to the four enumerations (`docs/index.md:40`,
  `docs/architecture/profiles-and-install.md:252`, `docs/repository-topology.md:24-25`,
  `docs/migration.md:7-8`).

**Checks.** `npm run smoke:kit-update-channel`, `npm run smoke:kit-update`, `npm run smoke:distribution`,
`npx tsc -p packages/core/tsconfig.json`, `npx tsc -p tests/tsconfig.json`, `npm run test:lint`,
`node tests/docs-smoke.ts`. Independent `reviewer` must end `PASS`.

## Out of scope this cycle (proposal)

The `review.md` "new problems" area is empty, so nothing new is proposed beyond keeping the record.
If item 2's npm rejection turns out to need more than the small bounded change above, the reviewer
may report FAIL and the implementer narrows to the docs enumerations only, leaving the code edge to
`autonomy/proposals/luna-core-01-06-npm-trunk-guard.md`.

## Budget guards

Stop taking new items once
`git diff --no-renames ce87a25c92de..HEAD -- . ":(exclude)package-lock.json" ":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c`
passes 30,000. Hard read budget 60,000. Item 1 is P0 and goes first; item 2 only if the diff allows.
