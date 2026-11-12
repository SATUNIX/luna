# Cycle 5 plan — stream `fleet` (luna-fleet-01/05)

## Choice

Mode: **fix**. The red gate outranks everything: cycle 4's O-01/PG-03 work is sound but its branch
fails three repository checks, so this cycle carries that diff and repairs the failures. No new
board item is started: the carried diff is ~38k characters and the cycle rule says to stop taking
new items once the reviewable diff passes 30k.

## Item 1 (O-01 / PG-03) — autonomous runs in `workflow_status` and `/workflows`

**Justification:** O-01 is the top backlog item; PG-03 is its listing surface and cycle 4 delivered
it. Without it the owner still cannot see an autonomous container run, its spend or its blocker
from pi. The work is evidence-backed (cycle 4 review, `run-query.ts` stores listed) and already
reviewed PASS once; this cycle only makes it pass the repository checks.

**Change:**
- Carry `run-query.ts` autonomy rows (state, contract title, spend/budget, blocker, supervisor-lock
  liveness with host/pid-reuse/heartbeat checks), `workflow-tools.ts` wiring, `tests/run-query-smoke.ts`
  fixtures, and the docs (`docs/autonomy.md`, `docs/workflows.md`, `docs/roadmap.md`, vendored
  `SOURCE.md`).
- Shorten the `workflow_status` description so the delegation tool text stays under 4,900 and the
  balanced/lite footprints stay under their ceilings, while still naming autonomous runs.
- Regenerate `docs/reference.md`, `THIRD_PARTY_NOTICES.md` and update
  `packages/core/eval/footprint-baseline.json` to the measured values in the same commit.
- Carry `autonomy/proposals/luna-fleet-01-04-autonomy-control-ids.md` unchanged.

**Checks that prove it:**
- `node tests/run-query-smoke.ts` — autonomy rows, title, spend, blocker, liveness fixtures.
- `node tests/eval-footprint-smoke.ts` — baseline and ceilings.
- `node tests/subagent-roles-isolation-smoke.ts` — delegation text under 4,900.
- `node tests/new-extension-smoke.ts` and `node packages/core/verify.ts` — notices and validation.
- `node tests/workflow-panel-smoke.ts`, `node tests/autonomy-run-smoke.ts`, `node tests/docs-smoke.ts`,
  both `tsc` projects, and eslint on the changed files.
- No `npm test`, no `npm run check:all`.

## Item 2 (A-92) — blocked

Not started. No capacity after the carry; the dispatch template and atomic board claim need their
own cycle with `tests/autonomy-dispatch-smoke.ts`.

## Acceptance for this cycle

- The carried diff passes every named red check on a clean checkout.
- An independent reviewer that did not write the change approves the diff against this plan and
  `autonomy/CHARTER.md`.
- `verify.md` and `report.md` are pushed, and the reviewable diff stays under 60k characters.
