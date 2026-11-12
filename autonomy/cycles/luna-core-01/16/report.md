# Cycle 16 report — `luna-core-01`, stream `core`

Outcome: complete (fix mode). Two scout-found defects fixed, each pinned by a test that fails on base
`8669a88` and passes on head `1f3d0c0`. All targeted checks green; diff (records excluded) 18,358 chars.
Mode: fix.
Base `8669a88`; no assigned board items, so no `Board:` lines. Review/plan record commit `07db0be`.
Item: memory-vault first-prompt recall lost pinned/relevant memories when recaps were oversized — `d3bb1a1`, `7e5b03a` — `smoke:memory-vault` 13/13 (new checks 13/14 fail on base).
Item: context-sieve uncharged join separators + missed `lastInjected` cleanup on the empty early return — `1f3d0c0` — `smoke:context-budget` 14/14 (2/14 on base).
Verification: `smoke:memory-vault` 13/13, `smoke:context-budget` 14/14, `smoke:ctx-contributions` 13/13, `test:typecheck`, targeted eslint, `smoke:docs` PASS; never `npm test`/`check:all`. The reviewer hung twice without a verdict, so the base-vs-head checks replaced it; recovery record `.pi/recovery/1-osc-bash-sleep-60-echo-done-workflow-sta.md`.
Left: reviewer hang (harness, outside the stream) carried to HANDOFF; HANDOFF #4 (test-only) and two low doc drifts deferred; V-07/V-08/V-10 still need the operator's finding list.
