# Cycle 31 report — luna-core-01

Outcome: successful
Mode: fix

Board: none - no board items were assigned this cycle.

Workflow: refused the item-2 `workflow_run` plan with "plan-allowance: only up to 1 more agent would fit this request" after the review scouts and item-1 review; item 2 then used the `subagent` fallback (implementer) and the coordinator's direct independent review, because the E3 child budget was spent by the time a reviewer subagent was requested.

## Items

Item: memory-vault first-prompt recall loses the recap when a recall error is swallowed (HANDOFF #15) - d00f106 - `npm run smoke:memory-vault` check 17 (write a recap, `session_start`, send a non-string prompt that throws after the old clear point, then a real prompt and assert the `Earlier sessions` recap is still offered) fails on the base with `TypeError` at `tests/memory-vault-smoke.ts:552` and passes after the fix (18/18); root cause: `if (isUserPrompt) firstPrompt = false;` ran before `searchMemories`/`assemble`, and the `catch` returned `undefined` with the flag already consumed, so the recap and pinned block were never offered again that session; fix: consume the flag only after recall succeeds, immediately before the `!final` early return, leaving every non-throw path unchanged; independent reviewer (subagent): PASS.

Item: skill hints clipped mid-word and the documented cost was ~2× low (discoverability + token efficiency) - c5db84d - `npm run smoke:skill-routing` section 6 (`hintText` leaves short text unchanged, cuts at the last whitespace and appends one `…`, and a real long description's result stays <= 161 chars and never ends mid-word); measured over the 34 shipped hidden skills: mid-word cuts 25 -> 0, rendered hint average 245.5 -> 242.0 chars (~61 tokens); root cause: `index.ts` rendered `description.slice(0, 160)`, and `match.ts`'s comment still claimed a name+path ~30-token hint; fix: exported pure `hintText` in `match.ts`, used in `index.ts`, and both comments corrected; independent review (coordinator, who did not write the change): PASS.

## Verification

`smoke:memory-vault` 18/18, `smoke:skill-routing` (precision/recall 1.000), `smoke:docs`, `npx tsc -p tests/tsconfig.json`, targeted eslint on all changed `.ts`, `npm run verify` — all green. Item 1 falsified against the base (fails without the fix). Review diff 14,002 chars, under the 30,000 stop. Never ran `npm test` or `npm run check:all`.

## Left for next cycle / notes

- HANDOFF #15 is now **done** (d00f106); proposal `luna-core-01-28-memory-vault-first-recall-flag.md` can be closed.
- New proposal `autonomy/proposals/luna-core-01-31-skill-trigger-lifetime.md`: the `re:` switch-off is process-lifetime, not per-session as documented — operator decision (HANDOFF #12, still open).
- New proposal `autonomy/proposals/luna-core-01-31-memory-search-exclude.md`: `searchMemories` reads a snippet for every already-injected note before the caller filters; needs an `exclude` set.
- V-10/V-11 remain done; V-07/V-08 still need the operator's in-tree finding list.
- Recommendation to the steward: with the host gate green on a clean checkout, merge `pi/luna-core-01` into `stream/core`.
