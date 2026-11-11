# Plan — cycle 10, run `luna-core-01`, stream `core`

Mode: **fix**.

## Item 1 (P0, board PG-55) — make the blocked-publication operator answer work

**Justification (charter).** Charter priority 2 (steward board) and priority 4 (defect in merged
code): the run's own operator option "Remove the identifier and resume" cannot work because
`runStep` re-parks before any cycle starts (review.md). Without this, a P0 feature merged in cycle 09
is silently unusable: the only real choice is "Stop the run".

**Change.**

1. `packages/autonomy/lib/lifecycle.ts` — add an optional `id?: string` to `PendingAnswer`.
2. `packages/autonomy/lib/engine.ts` — set `id: q.id` in the `PendingAnswer` built by `answer()`.
3. `packages/autonomy/lib/templates/self-improve.ts` — in `runStep`, when
   `!si.current && publishBlockedCycles >= 2`:
   - if `state.pendingAnswer?.id === "publish-blocked"`, clear `state.pendingAnswer` and fall
     through (one cycle runs with the existing `## Publication blocked` prompt note);
   - otherwise enter `blocked` as today.
   Because the answered cycle leaves `publishBlocker`/`publishBlockedCycles` set when it is still
   refused, the next `runStep` parks again: exactly one cycle per answer, self-limiting.
4. `docs/autonomy.md` — state the resume rule next to the existing stop paragraph.

**Tests.**

- Extend `tests/autonomy-selfimprove-smoke.ts` with a case: run reaches `blocked` on
  `publish-blocked` after two merged-but-unpublished cycles; enqueue
  `answer { text: "Remove the identifier and resume" }`; assert one further cycle runs
  (`prompts.length === 3`), the run parks again on `publish-blocked`, and the answer is consumed
  (`pendingAnswer` empty). The existing stop test (`:638`) and clean-publish test (`:699`) must stay
  green.
- A fake destination and a commit the scan refuses are already provided by the existing fixture
  (`internal/private-note.txt`); reuse it.

**Checks.** `node tests/autonomy-selfimprove-smoke.ts`, `node tests/autonomy-smoke.ts`,
`node tests/autonomy-cli-smoke.ts`, `npx tsc -p tests/tsconfig.json`, `npm run test:lint`,
`node tests/docs-smoke.ts` (docs changed). Never `npm test` / `npm run check:all`.

**Evidence of need.** The missing exit path (review.md, code) and the uncovered test gap
(`tests/autonomy-selfimprove-smoke.ts:638-668`).

## Not taken

- PG-57: complete in cycle 09, no defect found.
- PG-51 timing guards and operator-decision proposals: lower priority than the P0 defect and would
  push the reviewable diff past the stop-new-items mark.

## Budget

One `workflow_run` plan: `implementer`, then a gated `reviewer` (`max_loops` 1), worst case 4
agents. Expected reviewable diff ~3–5k chars, well under both budgets.
