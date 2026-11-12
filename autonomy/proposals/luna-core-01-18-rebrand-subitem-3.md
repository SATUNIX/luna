# Proposal — V-10 rebrand sub-item 3: the remaining user-facing and comment prose

Cycle 18 took V-10 in two green sub-items (docs scope, then system surfaces). The brand smoke now
walks documentation, `packages/**/*.md`, `packages/container/**`, `website/index.html` and package
manifests. The rest of the repository still has about 1000 `pi[- ]system` hits, almost all
deliberate identities listed in `docs/branding.md`. The remaining **prose** block is concentrated in
four places; each needs its own commit because each changes user-facing text or tests:

1. **`packages/extensions/src/kit-update/index.ts` (42 hits).** `/update` status lines, notes and
   step labels say `pi-system …` (`packages/extensions/src/kit-update/index.ts:620,624,641,646,707,
   769-771,782,788,797,912,969,979,1027,1031,1034,1037,1042,1045,1048,1050,1052,1056,1060,1063,
   1067,1072,1091,1108,1130,1138,1267,1302-1308`). They are display strings, so they become Luna.
   `tests/kit-update-smoke.ts` (48 hits) and `tests/kit-update-channel-smoke.ts` (6) pin many of
   them and must be updated in the same commit; the legacy source fixtures stay.
2. **`packages/extensions/src/session-helpers/index.ts` (7 hits).** The load/apply notifications
   (`:223,819,821`) prefix messages with `pi-system:`; those become `Luna:`. `tests/profile-command-
   smoke.ts`, `tests/install-profile-filter-smoke.ts` and the other install smokes may match them.
3. **Installer banners and comments.** `packages/core/install.ts:595` prints `[install] pi-system`
   and `packages/core/uninstall.ts:94` prints `[uninstall] pi-system`; both become Luna. Comments in
   `install.ts:3`, `uninstall.ts:3`, `paths.ts:2,7`, `build-npm.ts`, `pack-check.ts` and
   `publish-plan.ts` describe the old project name and can say Luna. The smoke must then widen to
   the whole repository.
4. **Remaining prose outside the current scope.** `.github/codeql/codeql-config.yml:1` `name:
   pi-system CodeQL configuration` (control path — operator decision, out of bounds for an agent
   edit), `packages/core/distribution.json` `$comment` "How pi-system is delivered" (allowed file,
   identity fields stay), `packages/extensions/src/web-console/index.ts:541` and
   `.../remote-control/host.ts:305` "Run this from the pi-system checkout" (display prose), and the
   `packages/core/helpers/*` comments.

Suggested order: (a) the two visible prefixes in install/uninstall/session-helpers; (b) kit-update
plus its tests; (c) widen the smoke to the rest of the repository and finish the comments. Each is
one reviewed commit with the matching smokes and `docs/branding.md` updated if a new identity
category appears. Never change the npm/bin/env/path/compose/symbol/urn identities, the identity
regexes, `distribution.json` values, or CHANGELOG history.
