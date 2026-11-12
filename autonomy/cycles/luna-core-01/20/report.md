Outcome: partial
Mode: improve

# Cycle 20 report — `luna-core-01`, stream `core`

Board: V-10 progress - renamed the remaining user-facing prose in 26 changed files to Luna; the whole-repo smoke walk and its docs text remain for the next cycle.

Item: V-10 sub-item 3a rename the remaining user-facing prose — 85e93fa, c3ca15c — `npm run smoke:brand` (17/17), `smoke:kit-update` (40/40) and the kit/install/profile/docs/distribution smokes, `test:typecheck`, targeted eslint.

What changed: display strings and comments in `packages/core/{install,uninstall,lib/identity,lib/paths,lib/settings,shared/kit-source,.env.example,distribution.json,helpers/*}`, `packages/extensions/src/{kit-update,session-helpers,remote-control,web-console}/**`, `packages/autonomy/image/gate.sh`, six `tests/*-smoke.ts` pins, plus one `[Unreleased] Changed` bullet. External identities are unchanged and the diff is 50,506 chars.

Verification: independent reviewer **PASS** on `a5b6d4ec1fb1..c3ca15c`; the earlier `85e93fa` review's two `mkdtempSync` prefix findings were reverted in `c3ca15c`. A pre-existing lens self-scan blocker at `install.ts:68`/`settings.ts:152` is unchanged at base and untouched here.

Remaining: whole-repo `smoke:brand` walk, `docs/branding.md` scope text, scope-widening CHANGELOG bullet (next cycle).
