# Cycle 18 review (run `luna-ops-01`, ops stream)

Mode: fix. Precedence at cycle start: (0) branch/gate, (1) upstream/integration sync, then
board items PG-60, PG-63.

## Branch and gate at cycle start

- `HEAD` = `796317776190` (the cycle-17 head). Clean tree.
- `origin/stream/ops` = `a7cb461fa43c` (the relaunch re-land). `git merge-base origin/stream/ops
  HEAD` = `616aa0638e43`: the run branch and the published integration branch **diverged**.
- `git merge-base --is-ancestor a7cb461f HEAD` → false. The run branch is **not** a descendant of
  the published integration branch.

## Finding 1 (P0, board PG-60) — the run branch lost the cycles 08-15 work

`git diff --stat origin/stream/ops..HEAD` (23 files, 404+/690-) showed the run branch **deleting**
work that is published on `stream/ops`:

- `packages/autonomy/lib/unpublished.ts` deleted (113 lines) — the PG-56 "merged work not yet
  published" surface, landed in cycle 15.
- `autonomy/cycles/luna-ops-01/15/{plan,report,review,verify}.md` deleted, and cycle 13/14
  installer/`--scope` changes absent.
- `packages/autonomy/cli.ts` 748 lines on HEAD vs 807 on `stream/ops`; `packages/core/install.ts`
  and `docs/autonomy.md` likewise older.

Root cause: cycles 16 and 17 were built on the stranded cycle-12 head (`2e3155f`, behind the
cycle-12 `-s ours` bridge `b2a409a` over `e3c7fc9`) instead of syncing the integration branch, so
they never received cycles 08-15 in the relaunched lineage.

Evidence: `git diff --name-status origin/stream/ops..HEAD`; `git show origin/stream/ops:packages/autonomy/lib/unpublished.ts`.

## Finding 2 (P0, board PG-60) — the promotion range is refused, exactly

`node packages/core/prepush-scan.ts range origin/stream/ops..HEAD`:

```text
pre-push scan: commit 3c7c8aede6c2 message line 1: blocked identifier (value redacted)
pre-push scan: commit 3c7c8aede6c2 packages/core/journal.ts:3: blocked identifier (value redacted)
...
pre-push scan: commit 22fdf7f26dc4 autonomy/cycles/luna-ops-01/08/review.md:70: blocked identifier (value redacted)
pre-push scan: 37 finding(s) in 29 commit(s); push refused.
```

The findings all name the pre-rename commits (`3c7c8ae`, `a482425`, `c3a1ecb`, `f1da979`,
`22fdf7f`) that the cycle-12 `-s ours` bridge (`b2a409a`) pulled into the run branch ancestry.
They are not reachable from `stream/ops`, so every fast-forward of `stream/ops` from the run
branch is refused. This is the same condition cycles 12 and 15 repaired with a re-land; it
recurred because cycles 16/17 never synced.

## Finding 3 (board PG-63) — already pinned, not reproducible

`origin/stream/ops..HEAD` at cycle start showed the cycle-17 fixtures were present on the run
branch. Running them: `npm run -s smoke:autonomy-review-inputs` → **23/23**, including
"a host upstream sync of a large trunk is not counted as the cycle's own diff; an oversized own
diff is still rejected" and the conflict-resolving variant. The two board counts (ux 114034 vs
own 32996; ops 60598 vs 60000) do not reproduce on this head: `upstreamMergeScope` (`lib/review.ts`)
plus `readReviewDiff {restrict}` already scope to the cycle's own paths, and the fixtures prove a
257-char / 402-char judged diff against the 60000 budget with a 60001-char negative control still
refused. No production change is owed; the deliverable is the pin, present since cycle 17.

## New problems found

- The stray remote branch `tmp-sync` was created by an accidental `git push origin HEAD` while the
  work was on a temporary branch; the remote refuses deletion (`deletion prohibited`). It points
  at the cycle's integration-sync merge and is harmless, but the operator may want to remove it.
- Otherwise no new defect in the ops area was found within the cycle budget; the review budget
  (`git diff 7963177..HEAD` minus records) reached 35900 characters on the sync alone, past the
  30000 stop-new-items line, so no further item was opened.
