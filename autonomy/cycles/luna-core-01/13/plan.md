# Plan — cycle 13, run `luna-core-01`, stream `core`
Mode: fix. Base `fc13571d21c7`. Board PG-19/V-81 are already merged (review); the one item is the
docs-drift defect.
## Fix: stale `session_start` "wipe" claim
Finding: context-sieve no longer wipes; admission is epoch/mtime-scoped, yet the integration
workflow page and one comment still assert a wipe and build their load-order rationale on it.
Change: rewrite the "Load order" bullet in `docs/capability-research-workflow.md` to state that
context-sieve skips prior-session files by module-load epoch, so producer/reader order does not
matter; correct the caveman comment at `index.ts:194`.
Test: add a `smoke:docs` regression guard that the page no longer contains "wipes contributions on
`session_start`" and does describe the epoch admission.
Proof: `npm run smoke:docs`, `npm run smoke:eval-footprint`, `npm run smoke:paperwork-budget`,
`npm run test:typecheck`, `npm run test:lint`. Never `npm test` or `npm run check:all`.
Record: PG-19 done, V-81 done (re-verified), one fix item.
