# Cycle 15 — `luna-core-01`, stream `core`
Outcome: partial — both items landed and targeted checks pass; the planned independent reviewer died without a verdict.
Mode: fix
Item: memory-vault first-prompt recall lost after a custom-message run — 1148397 — `smoke:memory-vault` 12/12 (new custom-message assertion; fails on base source)
Item: dead code in effort/context-sieve — 5febfc1 — `smoke:effort` 38/38, `smoke:ctx-contributions` 13/13
Board: none assigned this cycle.

Memory-vault now treats "first prompt" as the first user prompt: a custom-message run injects nothing and no
longer consumes the recap/pinned recall, so the real first user prompt still gets earlier-session history.
Docs `docs/memory.md` and `docs/architecture/memory-compaction-context.md` say "first user prompt". The effort
status ternary always returned `""`; the context-sieve `DYNAMIC_IDS` set named two ids no producer writes.
Both removed without behaviour change. Diff 8576 chars over 6 files, +13/−9.

The workflow run reported pass while its reviewer step found Item 2 unimplemented and the commit unpushed;
both were fixed and pushed directly. The follow-up independent reviewer did not return a verdict. Left: HANDOFF
#4 orchestrate-commands child-env hardening; V-07/V-08/V-10 need the operator's finding list; #1 out of stream.
