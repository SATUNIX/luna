# Cycle 12 — Review (run `luna-ux-01`, stream `ux`)

Base `7647d1b2f347` (head of `stream/ux`). Read: `autonomy/CHARTER.md`, the cycle 11 report and
HANDOFF on `origin/attempts/luna-ux-01/cycle-11`, this run's open proposals, and
`git log --oneline 7647d1b2f347..HEAD`.

## Priority 0 — the red gate (cycle 11 was not merged)

Cycle 11's code and records were sound, but the host gate failed on
`check-all:smoke:docs`. Reproduced on a clean worktree of
`origin/attempts/luna-ux-01/cycle-11`:

```text
node tests/docs-smoke.ts
AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports
+ 'report with no journal entry: luna-ux-01/11; add: - luna-ux-01/11 | Board: ...'
```

Root cause: the cycle 11 record commit wrote `report.md` but no `autonomy/JOURNAL.md` line, and
its board lines were `- Board: ...` bullets; the checker's `^Board:` parser reads none of them.
Fix: cherry-pick the four cycle 11 commits, add the journal line, and use the report's board
format. `node tests/docs-smoke.ts` then exits 0. This is the red-gate repair and it also restores
the reviewed overlay and `/kit` fixes (`faa6c2b`, `7394173` here).

## Priority 2 — board item V-02 (focus theft), remaining gap

The input-owner registry shipped (`CHANGELOG.md:407-413`; firewall, `ask_human`, pentest and the
two kit overlays use it), but the human console still opens sibling cards concurrently:

- `packages/extensions/src/human-console/index.ts:438` checks `inputHeld()` once, then
  `:443-447` calls `answerApproval`/`answerQuestion` without taking a hold.
- `processPending` (`:465-479`) starts one `void processOne(...)` per pending file in the same
  synchronous loop. The first card never holds input, so the second request sees input free and
  `ctx.ui.select` pushes a second dialog over the first and calls `setFocus()`. Keys typed for
  the first card can answer the second.
- `processRunApproval` (`:367-376`) has the same bare check, and `session_shutdown` (`:507`)
  never calls `releaseInputHolds`.
- Open proposal `autonomy/proposals/luna-ux-01-01-human-console-multi-card-focus-theft.md`
  records exactly this gap; no test covers two pending files in one scan.

Evidence that the gap is real and untested: the existing console cases in
`tests/firewall-overlay-queue-smoke.ts:475-720` all queue one request at a time, so they pass
with the bare check.

## Other checks

- V-01, V-03, V-05, V-73, PG-59: not re-verified, per the steward (their work is already on the
  branch; the trunk merge-base `5a888fe5` and ancestors `4dfac36`, `43fbfb0` confirm it).
- Cycle 10 report `:53-55` still says cycle 08/09 code is "not on `stream/ux`"; the steward
  showed that is false. Corrected as a record-only commit this cycle.
- No new defect found in the overlay frame or command menu beyond what cycle 11 fixed.

Mode: **fix** (red gate first, then the open V-02 gap).
