# Cycle 26 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Base `5e0050c7a539`. Two items, in priority order.

## Item 1 (P0) — make `smoke:workflow-resume`'s queue case deterministic

**Why (charter 1):** the previous cycle's acceptance named `check-all:smoke:workflow-resume`
(exit 1); this cycle reproduced it under CPU contention (see `review.md`). The check is the
gate, and a flaky check hides real regressions and blocks cycles.

**Change:** in `tests/workflow-resume-smoke.ts`, replace the finding "a stopped run's writer
leaves the checkout queue" with the file-gated form already used at `:336-356`:

- gate the holder's post-child fingerprint on a `hold` file via a `git` wrapper in `PATH`, so the
  writer lock is held for as long as the test wants (no timer);
- wait on observable state (`entered` file, and the queued run's registered agent) instead of
  `sleep(300)`;
- stop the queued run in the same turn as the observation, assert `cancelled/stopped`, release
  `hold`, then let the holder finish.

No production code changes; the assertion set stays the same (no loosening).

**Proves it:** the reproduced failure command
(`taskset -c 0 node tests/workflow-resume-smoke.ts` with three `taskset -c 0 yes` processes)
exits 0 and prints `workflow-resume-smoke: 41 checks passed`; the same suite also passes
unloaded. `npm run test:typecheck` and `npm run test:lint` cover the edited test file.

**Docs:** no user-visible behaviour changes. The test file's header comment gains one line about
the deterministic queue case and `docs/script-workflows.md` already names the test at `:116`; no
doc edit is needed unless the reviewer finds the claim stale.

## Item 2 (P3) — carry over cycle 25's two stream fixes

**Why (charter 3, handoff):** cycle 25 ended completed and its diff was approved; only the gate
was red. Its commits are already cherry-picked here:

- `1c9d199` hub Security page Effective row (`smoke:control-center`);
- `879b956` + `c9e586e` `/workflows` list cursor identity and its prune fallback
  (`smoke:workflow-panel`).

**Change:** keep them as they are; re-run their smokes, `smoke:docs`, typecheck and lint on this
base. If a reviewer finds a genuine gap, fix it in a follow-up commit rather than amending.

## Acceptance checks to run (never `npm test` / `npm run check:all`)

- `npm run smoke:workflow-resume` (loaded and idle)
- `npm run smoke:control-center`
- `npm run smoke:workflow-panel`
- `npm run smoke:docs` (records + `autonomy/JOURNAL.md` line in the same push)
- `npm run test:typecheck`, `npm run test:lint`

## Out of scope

Hub tiny-terminal frame/mouse edges, idle-cat frames, inert Settings value rows: already open
proposals, not this cycle. The low-probability `workflow-hooks-smoke.ts` timer races go into a
proposal.
