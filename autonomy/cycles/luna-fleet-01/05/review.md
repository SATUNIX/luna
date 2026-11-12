# Cycle 5 review — stream `fleet` (luna-fleet-01/05)

Base: `83a3ad872d47`. Mode: **fix**, carrying cycle 4's sound O-01/PG-03 work and repairing the
acceptance failures that kept it off `stream/fleet`.

## Branch state

- At review time `git log --oneline 83a3ad872d47..HEAD` was empty; no fleet cycle was merged
  into the base. The sound cycle-4 carry is now committed on this branch as `bc82356`, with its
  gate repairs in the commit that follows it.
- Cycle 4 ended `Outcome: partial` with a PASS review but the host acceptance was red on
  `check-all`, `check-all:smoke:eval-footprint`, `check-all:smoke:new-extension`,
  `check-all:smoke:subagent-roles-isolation` and `check-all:verify`. Its work is on
  `origin/attempts/luna-fleet-01/cycle-04` at `bc79bd1`, not merged.
- Cycle 4's attempt branch does not carry `autonomy/runs/luna-fleet-01/HANDOFF.md`; the base's
  handoff describes the same state.

## Why cycle 4 was rejected (reproduced on base plus its code diff)

Applying `git diff 83a3ad872d47..origin/attempts/luna-fleet-01/cycle-04` (38,037 chars, records
excluded) to the base reproduces every named failure:

1. `node tests/eval-footprint-smoke.ts` — `3/11 FAILED`: the longer `workflow_status` description
   raised the measured text above the reviewed `packages/core/eval/footprint-baseline.json`:
   balanced `9016` vs `8919`, lite `7711` vs `7614`, delegation `4827` vs `4730`.
2. `node tests/subagent-roles-isolation-smoke.ts` — `AssertionError: the delegation tool text is
   4977 chars, over the 4,900 budget` (`tests/subagent-roles-isolation-smoke.ts:322`). The role
   smoke counts `description + promptSnippet + parameters`, so the same description grew it past
   the ceiling even where the eval baseline margin existed.
3. `node tests/new-extension-smoke.ts` and `node packages/core/verify.ts` —
   `THIRD_PARTY_NOTICES.md is stale — run 'node packages/core/gen-notices.ts'`. The new
   `packages/extensions/third_party/subagent/SOURCE.md` note was never regenerated into the
   notices file.

Root cause in all three: cycle 4 changed user-visible tool text and third-party notes without
updating the reviewed budget artefacts and generated files that the repository's checks pin.

## Items

### O-01 [P0] — owner visibility (PG-03, PG-06, PG-07, PG-08, PG-09)

PG-03 is delivered by the cycle-4 diff and is the only sound piece small enough to carry: it adds
autonomous container runs to `workflow_status` and `/workflows` (`run-query.ts`), with spend,
blocker and supervisor liveness, plus tests and docs. PG-06–PG-09 and the non-Claude walkthrough are
still absent and remain open.

### A-92 [P0] — dispatch template and atomic board claim

Not started. The dispatch template needs a new run kind plus an atomic board claim under the real
board lock; that is a larger change than this cycle's remaining budget after the carry.

## Red-gate note

Cycle 3's intermittent `smoke:workflow-resume` red is still not reproduced on this base (cycle 4
ran it green). Nothing on this branch changes the resume engine; if the host gate reports it, the
failing assertion line is quoted rather than dismissed.

## Other findings

- `autonomy/proposals/luna-fleet-01-04-autonomy-control-ids.md`: `/workflows` control completion
  offers autonomy ids that `workflow_control` cannot act on. Carried as the cycle-4 proposal; not a
  blocker for the list.
- `bringUp()` replacing relay/proxy children without awaiting the old child remains an open
  handoff note; unrelated to this item.
- No new defect outside the stream was found that outranks the red gate.
