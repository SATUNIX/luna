Outcome: successful
Mode: fix

No board items were assigned this cycle. The work is a real token-efficiency defect found during
review (Finding B); a separate regression attempt was reverted after independent review.

Tests changed, and why: `tests/effort-standing-smoke.ts` adds two assertions inside the existing
standing check (a second unchanged turn repeats no reminder — fails on the base, which always
returned it — and a size change re-emits it). No assertion was weakened or deleted.

Board: none

Item: deduplicate the standing-mode reminder - 1865ed4 - `npm run smoke:effort-standing` (13/13;
the new second-unchanged-turn assertion fails on the base) and `npm run smoke:effort` (38/38).
Finding: `packages/extensions/src/effort/index.ts:760-775` added the hidden standing reminder as a
new custom user-role message every turn while standing mode was on, even though the full
`policy/standing.md` text is in that same turn's system prompt; the 152-168-char string
(~40 tokens) accumulated forever. Root cause: no `lastReminder` state. Fix: track it, emit the
reminder only when new/changed, set it to null when standing is off or the `workflow` tool is
inactive, and clear it in `session_start`/`session_compact`. `docs/effort.md` now describes the
deduped behaviour. Independent reviewer subagent: **PASS**, no must-fix.

Workflow: refused the workflow run could not be budgeted (plan-allowance): E3 allows 8 planned
agents a request; the review scout plan plus the first item plan (which was rejected by its
reviewer and retried) used all 8, so the second item used the `subagent` fallback (implementer and
an independent reviewer).

Not done / next cycle: (1) the cycle-24 `-es` stemmer regression (`bus`/`buses`, `gas`/`gases`,
`lens`/`lenses`) is real but no heuristic fix survived review — a rule keyed on the plural's
stripped base also breaks silent-e plurals (`cases -> cas` vs `case -> case`), a net regression;
the attempted commit was reverted and the evidence is in `review.md`. Needs a lexicon or an
operator trade-off decision. (2) Proposal `luna-core-01-25-standing-reminder-dedupe.md` covers the
remaining E5 plan/card duplication (Finding C). (3) Proposal
`luna-core-01-25-brand-smoke-scope.md` covers the brand smoke skipping `.jsonl` and the
unscanned/undocumented `pi-kit` namespace (Finding D); the V-10 rename itself is complete
(`smoke:brand` 18/18). (4) HANDOFF #1 firewall timing noise is out of stream; #6/#7/#12 remain
operator decisions; V-07/V-08 still need the operator's finding list.
