# Cycle 13 — `luna-core-01`, stream `core`
Outcome: successful
Mode: fix
Board: PG-19 done - the paperwork budget is on the trunk at packages/core/paperwork-budget.ts (60-line cap, one journal line, CLI exit 1 overrun / 2 bad args), smoke:paperwork-budget 5/5 and check:all --list lists it; re-verified, no change needed.
Board: V-81 done - the footprint CLI (`--profile`, `--json`, `--write-baseline`) is on the trunk, smoke:eval-footprint 13/13 and the docs carry a Measuring section; re-verified, no change needed.
Item: stale `session_start` "wipe" docs - 47f48d0 - smoke:docs plus two new tests/docs-smoke.ts guards
The board re-listed PG-19 and V-81, both merged in cycle 12; they were re-verified green and left untouched, so the cycle is a consolidate pass. The one change fixes a real docs-drift defect: `docs/capability-research-workflow.md` and a caveman comment claimed context-sieve wipes contributions on session_start, while `context-sieve/index.ts` never deletes and instead skips files older than `SESSION_EPOCH_NS`; `guidelines/index.ts` already documented the epoch rule. The page and comment now match, guarded by two docs-smoke assertions that fail on the old text.
Left: no behaviour changed, so no functional test was added beyond the doc guard. HANDOFF carry-overs #1 (firewall-gate timing noise) and #2 (cycle-08 records) remain; #1 is outside this stream. Diff 48 insertions / 5 deletions across 5 files.
Next: cycle 14 keeps consolidating cycle 12's CLIs if an edge case appears, else takes the next evidenced core defect.
