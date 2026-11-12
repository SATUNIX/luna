# Cycle 17 plan (run `luna-ops-01`, ops stream)

Mode: fix. Budget: ~$5 / 3 h. Work precedence: P0 upstream merge (done), then PG-60, PG-63.

## Item 1 — P0 upstream merge (done)

Merged `refs/upstream/trunk` (`5a888fe`) as `bfb0b18`, keeping both timing guards. Checks already run.
No further action.

## Item 2 — PG-60: ops publication

Justification: the board item is P0 and names the exact leak-scan refusal that blocked cycles 08-10 from
reaching the trunk (charter priority 2; PG-55 fail-loud requirement).

Change: verify the current publication state and make it honest. The relaunch already re-landed cycles
08-15 onto `origin/stream/ops` (`a7cb461`), so the item's 08-10 defect is repaired; record that, record
the exact promotion-range refusal (`37 findings / 25 commits`, first `22fdf7f .../08/review.md:70`), and
record the stranded shas. Produce a re-land candidate of this cycle's commits off `a7cb461` if it can be
done without force-push (a new local branch only; never push `stream/ops`).

Checks: `node packages/core/prepush-scan.ts range 2e3155f..HEAD` (run-branch push, clean) and
`range origin/stream/ops..HEAD` (promotion refuses, as recorded). `git ls-remote origin refs/heads/stream/ops`.

## Item 3 — PG-63: post-sync review budget (main code item)

Justification: two named in-repo failures (ux cycle 05 counted 114034 vs own 32996; ops cycle 14 counted
60598 vs budget 60000), every stream syncs the trunk each cycle, so every stream pays it. The item says
the counted size is the whole merge side and points at the multi-parent scope computation.

Change: reproduce end to end first. Add an acceptance fixture to
`tests/autonomy-review-inputs-smoke.ts` that drives the real self-improve template through a cycle that
merges a large upstream trunk and then changes one small file, and asserts the merge decision is under
budget; a second shape with a 60k+ own code diff must stay rejected with the same message. If the first
shape is red, fix the scope computation in `packages/autonomy/lib/review.ts` (multi-parent path) /
`packages/autonomy/lib/templates/self-improve.ts` (`resolves`/`start` wiring). Keep the A-02 record cap
(`REVIEW_RECORD_STAT_BUDGET`) unchanged.

Checks: `npm run -s smoke:autonomy-review-inputs`, `npm run -s smoke:autonomy-selfimprove`,
`npm run -s test:typecheck`. Never `npm test` / `npm run check:all` here — the host gate runs the full
suite on a clean checkout.

## Out of scope (proposals only)

- The run branch's stranded ancestry and the `stream/ops` re-land are integrator actions; recorded in the
  cycle-16 publication proposal, not performed here.
