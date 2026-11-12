# Plan — cycle 09, run `luna-core-01`, stream `core`

Mode: **fix**. Base `5a888fe5dcf2`. Budget ~$5 / 3 h; reviewable-diff read budget 60,000 chars,
stop taking new items past 30,000.

## Items

### Item 1 (board PG-55) [P0] — carry over the blocked-publish stop

**Justification (charter 1, reliable):** a publication the leak scan refuses used to be logged once
while the run kept cycling, stacking merged-but-unpublishable commits with no visible blocker and
nothing for the operator. Cycle 08 implemented and reviewed it; it failed merge only on a missing
journal entry. Work precedence (2) puts this board item first, and (the rejection) is bookkeeping
outside this item.

**Change (cherry-pick, no re-implementation):** `8992891` and `a6aa5c7` from
`origin/attempts/luna-core-01/cycle-08`, which touch `packages/autonomy/cli.ts`,
`packages/autonomy/lib/lifecycle.ts`, `packages/autonomy/lib/templates/self-improve.ts`,
`tests/autonomy-selfimprove-smoke.ts`, `docs/autonomy.md`, `CHANGELOG.md`. The scan, its patterns and
its exceptions are untouched.

**Checks:** `node tests/autonomy-selfimprove-smoke.ts` (41 checks: status/state expose the blocker
and `unpublished`; the prompt names the refused commit and location; block after two merged-but-
unpublished cycles; clean publish clears all three; a non-merged cycle does not reset the streak);
`node tests/autonomy-cli-smoke.ts`; `node tests/autonomy-smoke.ts`.

### Item 2 (board PG-57) [P1] — name the declared output path in the step task

**Justification (charter 1, effective/token-efficient):** a step that declares `outputs` fails after
spending its tokens because only the system prompt mentions writing files; the subagent never sees
the contract in its task. Baseline: 2 failures in `luna-ux-01` (c05 16,991 output tokens; c10
48,445), and in both the gated review step never ran, so the parent re-did the review by hand.

**Change (local to `runStep` in `packages/extensions/third_party/subagent/workflow.ts`):**

1. When `step.outputs` is non-empty, append to the rendered `task` a labelled block that names each
   declared file by its **absolute** path (`path.join(runDir, name)`) and states the step fails if
   that exact file is absent.
2. Change the failure at 1015-1018 to name the absolute path(s):
   `declared output(s) not written: <abs path>`. Update the two tests that assert the old text
   (`tests/workflow-smoke.ts:295`, `tests/workflow-plan-smoke.ts:317-318`) and extend
   `tests/workflow-smoke.ts` with the acceptance fixture: a step whose subagent writes the file
   passes and its task names the absolute path; one whose subagent does not fails, the error names
   the path, and the fake launcher ran exactly once (no re-review cost).

**Checks:** `node tests/workflow-smoke.ts`, `node tests/workflow-plan-smoke.ts`,
`npx tsc -p tests/tsconfig.json`, `node tests/docs-smoke.ts` (docs unchanged but the journal gate
must stay green), `npm run test:lint`.

## Not this cycle

- PG-51 (cycle-08 carry-over): sound but 27,519 reviewable chars; bringing it over would exceed the
  60,000 read budget with PG-55 + PG-57. Left on the attempt branch, recorded in the handoff.
- Other HANDOFF carry-overs (operator decisions / needs the operator's list).

## Acceptance

`report.md` + `verify.md` written, `autonomy/JOURNAL.md` gains the `luna-core-01/09` line, targeted
smokes pass, an independent reviewer approves the diff, and the reviewable diff stays under 60,000
chars.
