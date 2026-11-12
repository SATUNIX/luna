# Cycle 18 plan (run `luna-ops-01`, ops stream)

Mode: fix. Goal: make the run branch a descendant of the published integration branch again
(restoring the cycles 08-15 work) and give the integrator a leak-scan-clean re-land candidate for
`stream/ops`, while confirming PG-63 stays pinned.

## Item 1 — Sync the run branch with `origin/stream/ops` (PG-60, priority 1)

Justification: the run branch deleted `packages/autonomy/lib/unpublished.ts` (PG-56, cycle 15) and
the cycle-15 records, and carried older `cli.ts`/`install.ts` — a real, evidenced regression from
missing the per-cycle integration sync. The charter's priority 1 (sync before board work) applies.

Change: `git merge origin/stream/ops` into the run branch; resolve the single `HANDOFF.md` conflict
to the cycle-17 state; the union restores the deleted files and keeps the cycle-16/17 work.

Checks: `test:typecheck`; `smoke:autonomy-cli` (the four PG-56 checks and the restored
`unpublished.ts`); `smoke:autonomy` 32/32; `smoke:install-marker`; `smoke:docs`.

## Item 2 — Re-land candidate for `stream/ops` (PG-60)

Justification: after item 1 the run branch still carries the stranded `e3c7fc9`/`22fdf7f` ancestry,
so `range origin/stream/ops..HEAD` stays refused with 37 findings. The prompt permits re-landing the
content as new commits off the published base.

Change: create a single commit off `origin/stream/ops` (`a7cb461f`) whose tree is the run-branch
tree, verify its scan is clean, and push it as `pi/luna-ops-01-reland` for the integrator to
fast-forward `stream/ops`. Record the stranded shas. Do not force-push, do not bypass the hook, do
not move `stream/ops` from the worker.

Checks: `node packages/core/prepush-scan.ts range origin/stream/ops..pi/luna-ops-01-reland` →
1 commit, no findings; `git diff --stat pi/luna-ops-01-reland HEAD` shows no content difference.

## Item 3 — Confirm PG-63 (board)

Justification: the board says the post-sync merge review is rejected as too large; cycle 17 added
the end-to-end fixtures but the item is assigned again.

Change: none — verify the fixtures still run on this head.
Checks: `npm run -s smoke:autonomy-review-inputs` → 23/23.

## Stop condition

Do not open a new item once the review-budget measurement passes 30000 characters. The sync merge
alone reaches 35900, so items beyond the two board items are out of scope this cycle.
