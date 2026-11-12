# Cycle 22 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Base `f19788240eaa`. No new item: the re-landed carry-over already puts the
non-record diff past the 30000 stop-taking-new-work line (~42k, under the 60k review cap).

## Item 1 — Re-land the carried cycle-20/21 code (priority 3, handoff)

Justification: the previous attempt was rejected only for the missing `autonomy/JOURNAL.md`
line its own cycle-21 report required, not for its code. Re-land the code commits and keep the
rejected cycles' records off this branch.

Change: cherry-pick `d4d76da`, `5ffb5b5`, `589dbfd`, `b16f9e8`, `d3313e4`, `4933eac`,
`65c01af`, `e104fd7` (hubKey validation/consistency, launch-screen suppression repair,
`/workflows` panel height budget, docs and proposal). No new tests are needed: each commit
carries its own; the existing cases exercise them.

Checks: `smoke:control-center` 45/45, `smoke:launch-screen` 12/12,
`smoke:workflow-panel` 15/15, `smoke:command-menu` 14/14,
`smoke:suppression-inventory` 2/2, `smoke:typescript-coverage` 5/5, plus the negative runs
recorded in `review.md`.

## Item 2 — Board PG-12 (priority 2, already satisfied)

Justification: the board asks for a one-line trunk-ahead notice; the base already has it and
`tests/update-notice-smoke.ts` pins the line, in-sync silence and the timeout. No code change;
record the evidence and mark it done rather than reimplement.

Checks: `smoke:update-notice` 8/8.

## Item 3 — Repair the docs gate (priority 0, the rejection cause)

Change: add the one `autonomy/JOURNAL.md` line per cycle report this branch adds
(`luna-ux-01/22`), so `tests/docs-smoke.ts` `checkJournal` passes; never repeat the cycle-21
omission.

Checks: `smoke:docs`, `docs:check`, `docs:mermaid`.

## Verification

Targeted smokes for every changed file, `test:typecheck`, `test:lint`, then an independent
`reviewer` (did not write the change) over `git diff f19788240eaa..HEAD` against
`autonomy/CHARTER.md`. Record in `verify.md`, then `report.md` and `HANDOFF.md`.
