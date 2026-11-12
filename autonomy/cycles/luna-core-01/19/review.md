# Cycle 19 review — `luna-core-01`, stream `core`
Base `75e072404559` (head of `stream/core`, cycles 01–17). Charter read in full. Assigned board
item **V-10 [P1] rebrand pi-system -> Luna**, sub-items 1–2 carried on
`origin/attempts/luna-core-01/cycle-18` and sub-item 3 still open.

## Findings

1. **Red gate: cycle 18's branch fails `verify` (and so `check-all`).** On the carried-over tree
   `npm run verify` ends `FAIL: docs/reference.md is stale — run 'npm run catalog'` (exit 1).
   Root cause: cycle 18 added `docs/branding.md`, which names `PI_SYSTEM_GIT_SOURCE`, and
   `reference.ts`'s `whereEnv()` links an env var to the first docs page (alphabetically) that
   mentions it — `branding.md` sorts before `migration.md`. `catalog` was never rerun on the
   attempt branch. Evidence: `node packages/core/reference.ts` regenerated the row from
   `[migration](migration.md)` to `[branding](branding.md)`.
2. **V-10 sub-item 3: repo-wide prose.** A scan of `WORKSPACE_ROOT` (skipping `node_modules`,
   `.git`, `dist`, `site`, `.pi`, `autonomy`, `package-lock.json`; stripping the identity patterns
   in `tests/brand-smoke.ts`) leaves **100 hits in 29 files**. 45 are user-visible strings/tests:
   `kit-update/index.ts` (38, `/update` status/step labels), `tests/kit-update-smoke.ts` (7),
   `kit-update-channel-smoke.ts`, `session-helpers/index.ts` (`pi-system:` prefixes at 223, 819,
   821), `install.ts:112,595`, `uninstall.ts:94`, `kit-root-trust-smoke.ts:262,314`,
   `install-marker-smoke.ts:618`, `profile-transaction-smoke.ts:68`, `remote-control/host.ts:305`,
   `web-console/index.ts:541`. The rest are comments and internal temp-dir prefixes. The identity
   regexes (`kit-update/index.ts:240`, `session-helpers/index.ts:323`, `web-ui/remote-version.ts:16`)
   and the shared-helper messages (`*/shared/kit-source.ts` x4) stay contractual.
3. **HANDOFF carry-overs** #10 (context-sieve message framing) and #11 (two one-line doc drifts) are
   already proposals and are not this cycle's assigned item; #1, #4–#9 are out of stream or blocked
   on the operator. No upstream ref exists (`refs/upstream/trunk` absent), so priority 1 is moot.

## Decision

Fix mode for finding 1 (red gate, priority 0): carry the sound sub-items 1–2 and repair `verify`.
Improve mode for finding 2 (assigned V-10): sub-item 3 was implemented but the resulting
`75e072404559..HEAD` diff reached 83,814 chars, over the 60,000 review cap, so it was reverted and
preserved on `origin/attempts/luna-core-01/cycle-19-subitem3` for the next cycle (its own diff is
~53k). This cycle therefore lands the carried sub-items 1–2 plus the gate fix and reports V-10
progress. Finding 3 stays proposals.
