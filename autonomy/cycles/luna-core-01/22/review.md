# Cycle 22 review — `luna-core-01`, stream `core`

Base `59b2a82a7b9a` (head of `stream/core`, cycles 01–20); `autonomy/CHARTER.md` read in full.
Assigned: V-10 [P1]. Previous cycle 21 was rejected, not merged.

## Findings
1. **V-10 sub-item 3b is implemented but unmerged.** `origin/attempts/luna-core-01/cycle-21` carries
   `f7554ce` (whole-repository brand smoke) + `bed0c65` (scope wording, CHANGELOG). Both apply
   cleanly onto `59b2a82a7b9a` (verified by cherry-pick).
2. **Why cycle 21 failed acceptance.** Reproduced in a worktree of its head `c7a4688`:
   `npm run smoke:docs` exits non-zero with `AssertionError ... autonomy/JOURNAL.md disagrees with
   the cycle reports: report with no journal entry: luna-core-01/21` (`tests/docs-smoke.ts:526`,
   `packages/core/lib/journal.ts:94`). Root cause: the journal gate requires a `autonomy/JOURNAL.md`
   line for every `cycles/<run>/<NN>/report.md` on the branch, and cycle 21 added its `report.md`
   **after** running `smoke:docs`, so its own verify was green but the host's clean checkout was red.
   This was the whole `check-all` / `check-all:smoke:docs` failure; the code change itself is sound.
3. **The cherry-picked change is green on this base.** `npm run smoke:brand` = 18/18 over the
   whole-repository walk, and `npm run smoke:docs` passes (before cycle-22 records exist).
4. **Remaining V-10 acceptance holds.** `mkdocs.yml` `site_name: Luna`, README `# Luna` and Luna hero
   alt, AGENTS.md/CLAUDE.md name Luna, root `package.json` name `@satunix/pi-system`; `docs/branding.md`
   lists every deliberate category plus the rename proposal. Only the V-10 tail (sub-item 3b) was
   outstanding.
5. HANDOFF carry-overs checked against the code: #10/#11 are proposals, #4 is test-robustness,
   #1 is out of stream, V-07/V-08 still need the operator's finding list; no upstream ref, so
   priority 1 is moot.

## Decision
Improve mode: land V-10 sub-item 3b over the two reviewed cycle-21 commits, and close the process
defect that caused the rejection by writing cycle 22's `JOURNAL.md` line in the same commit as
`report.md` and re-running `smoke:docs` afterwards. No new work beyond the assigned item.
