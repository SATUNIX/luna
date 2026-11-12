# Cycle 13 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Priority 0 (red gate) outranks board item PG-09.

## Item 1 — Re-land cycle 12 and repair its rejected acceptance check

Justification: charter priority 0 (a failing acceptance check / broken pushed state) and the
cycle prompt's instruction to cherry-pick the sound work from
`origin/attempts/luna-ux-01/cycle-12` and fix what the rejection names.

Change:
- Cherry-pick the reviewed cycle 11/12 commits unchanged (overlay frame + mouse, `/kit` reveal,
  docs/journal repair, non-run console hold, `ask_human` hold, cycle 10 report correction).
- Give workflow-run approval cards an exception to the console input hold. They use the run
  broker, which owns its own two-per-run cap (`RUN_OUTSTANDING_MAX`). A module counter
  (`openRunCards`) makes non-run cards and child requests wait behind open run cards, so the V-02
  focus fix still covers the non-run path while the broker's two slots stay reachable. Resume
  questions keep their real hold.
- Update `docs/security.md`, `docs/autonomy-gate.md`, `CHANGELOG.md`, and the two console smokes
  (`tests/firewall-overlay-queue-smoke.ts` run-card case, the pre-existing
  `tests/firewall-workflow-approvals-smoke.ts` contract stays unchanged).

Checks:
- `npm run smoke:firewall-workflow-approvals` — the exact check the host gate failed on; must
  pass all 10 cases.
- `npm run smoke:firewall-overlay-queue` — non-run serialisation, `ask_human` hold, and the new
  run-card exception.
- `npm run smoke:firewall-approvals`, `npm run smoke:human-console-auth`,
  `npm run smoke:human-console-broker`, `npm run smoke:autonomy-gate-overlay`.
- `npm run smoke:docs`, `npm run test:typecheck`, `npm run test:lint`.
- Independent reviewer over `git diff 7647d1b2f347..HEAD`.

## Not started — board PG-09 (`pi-autonomy inbox`)

The diff is already 44289 characters from re-landing cycle 12, over the 30000 stop-new-items
line. The inbox would be a new command plus a new smoke; starting it risks exceeding the 60000
merge-review budget. Recorded as `blocked` with the reason in `report.md`; the next cycle can
take it from a smaller base.

## Checks not run here

`npm test` and `npm run check:all` are not run in a cycle; the host gate runs the full suite on a
clean checkout.
