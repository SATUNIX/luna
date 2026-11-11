# Cycle 13 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix
Board: PG-09 blocked - the re-landed cycle 12 diff is about 44600 characters, over the 30000 stop-new-items line, so the new inbox command was not started.

Item: Re-land the reviewed cycle 11 overlay-frame, mouse-forwarding and `/kit` reveal work - fdfce6b, f6a1dfd - smoke:control-center 34/34, smoke:command-menu 12/12
Item: Re-land the reviewed cycle 12 non-run console hold and `ask_human` hold (V-02) - 06ac984, 7846eab, 4d686da, f66d741 - smoke:firewall-overlay-queue
Item: Repair the rejected cycle 12 red gate: keep the run broker's two workflow-run cards and defer non-run cards behind them - 028c9ec - smoke:firewall-workflow-approvals 10/10, smoke:firewall-overlay-queue 35/35
Item: Narrow the run-card exception wording after review - 0992f63 - smoke:docs

## What changed

Cycle 12 was rejected because its V-02 fix held input for **every** console card. Workflow-run
approval cards are the exception the run broker owns: it deliberately allows two outstanding
prompts per run (`RUN_OUTSTANDING_MAX = 2`). Taking the shared hold made the broker's second slot
unreachable, so `tests/firewall-workflow-approvals-smoke.ts:140` failed with `1 !== 2`, and two
parallel runs waited on each other's pause questions.

The repair removes the input-owner hold from run cards. A module counter (`openRunCards`) makes
non-run approval cards and child requests wait behind open run cards, so the V-02 focus fix still
covers the path it was written for. The resume question and `ask_human` keep their own holds. The
overlay smoke now pins the two-run-card case and the deferral of a plain child request; the
existing workflow smoke keeps the broker contract unchanged. Docs, CHANGELOG and the two console
pages state the exception.

No board item was started after that: the branch already carries the reviewed cycle 11/12 work
and measures about 44600 characters from base (under the 60000 merge-review budget, over the 30000
stop-new-items line).

## Verification

`smoke:firewall-workflow-approvals`, `smoke:firewall-overlay-queue`, `smoke:firewall-approvals`,
`smoke:human-console-auth`, `smoke:human-console-broker`, `smoke:autonomy-gate-overlay`,
`smoke:control-center`, `smoke:command-menu`, `smoke:docs`, `test:typecheck` and `test:lint` all
pass. An independent reviewer read the full diff against the charter and returned PASS; its one
substantive docs warning was fixed in `0992f63`. Full `check-all` is left to the host gate.

## Open

- PG-09 (`pi-autonomy inbox`) remains for a later cycle that starts from a smaller diff.
- Pre-existing lens findings in `human-console/index.ts` (reflective `Reflect.get`/`Reflect.apply`
  and an unwrapped `JSON.parse`) are untouched; they are not introduced by this cycle.
- Nothing pushed beyond `pi/luna-ux-01`; no tag, release or merge.
