# Cycle 6 plan — stream `fleet` (luna-fleet-01/06)

Mode: **fix**. Priorities: (0) red gate / broken branch, then the carried O-01/PG-03 item.

## Work chosen

1. **Carry cycle 5's sound PG-03 work and repair its red gate.**
   - Justification: priority 0 and priority 3. Cycle 5's code passed an independent review but the
     host acceptance failed on `check-all:smoke:docs` because the cycle-5 report had no
     `autonomy/JOURNAL.md` line (`tests/docs-smoke.ts:491`, checker in
     `packages/core/lib/journal.ts`). The work is real owner value for O-01: it answers "what is
     running" for autonomous container runs from `workflow_status` and `/workflows`.
   - Change: cherry-pick `bc82356`, `e53e06e`, `c22dc0e` onto the base; add the missing
     `luna-fleet-01/05` journal line.
   - Checks: `node tests/docs-smoke.ts`, `node tests/run-query-smoke.ts`,
     `node tests/eval-footprint-smoke.ts`, `node tests/subagent-roles-isolation-smoke.ts`,
     `node tests/new-extension-smoke.ts`, `node packages/core/verify.ts`,
     `node tests/workflow-panel-smoke.ts`, `node tests/autonomy-run-smoke.ts`, both `tsc`
     projects, eslint on the changed TypeScript.
   - Docs: the carry already updates `docs/autonomy.md`, `docs/workflows.md`,
     `docs/reference.md`, `docs/roadmap.md`, `SOURCE.md` and the notices. `README.md` needs no
     change: it links to `docs/autonomy.md` and does not describe `workflow_status` formats.

## Not chosen (recorded for the next cycle)

- **O-01 PG-06/PG-07/PG-08/PG-09 and the non-Claude walkthrough**: the carried diff is 45,557
  characters, over the 30,000 stop for new items.
- **A-92 dispatch template and atomic `board claim`**: same budget reason; needs
  `tests/autonomy-dispatch-smoke.ts` and a new run kind, too large to start safely here.

## Acceptance

- `node tests/docs-smoke.ts` passes (the named red check).
- Every targeted check above passes on the pushed head.
- The reviewable diff stays under 60,000 characters.
- `report.md` records O-01 as progress and A-92 as blocked with the reason.
