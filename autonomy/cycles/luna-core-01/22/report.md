Outcome: successful
Mode: improve

# Cycle 22 report — `luna-core-01`, stream `core`

Board: V-10 done - landed the reviewed whole-repository brand smoke (sub-item 3b) that cycle 21
implemented but never merged, and closed the journal-gate defect that rejected that cycle.

Item: V-10 sub-item 3b whole-repository brand smoke — e19f880, 1acb83c — `npm run smoke:brand`
(18/18, walk over `WORKSPACE_ROOT`) plus `npm run smoke:docs` (journal gate green).

Justification for landing a cherry-pick: the change is a board item that was implemented, green in
its own tree and rejected only by a record-gate failure, so re-implementing it would be duplication.

What changed: cherry-picked cycle 21's two reviewed commits (`origin/attempts/luna-core-01/cycle-21`)
unchanged. `tests/brand-smoke.ts` now walks `WORKSPACE_ROOT` from `packages/core/lib/paths.ts`,
skipping generated/vendored trees, the top-level `autonomy/` records by absolute path,
`package-lock.json`, `CHANGELOG.md`, `docs/branding.md` and itself; it allows only the documented
identities (legacy regexes, the `satunix-pi-system-<version>.tgz` tarball name, two internal
`fs.mkdtempSync` prefixes). `docs/branding.md` gains the whole-repository scope text; `CHANGELOG.md`
gains one `[Unreleased] Changed` bullet. No npm/bin/env/path/compose/symbol/urn identity changed.

Why cycle 21 was rejected (root cause): the docs smoke's journal gate
(`packages/core/lib/journal.ts:94`, driven by `tests/docs-smoke.ts`) requires an `autonomy/JOURNAL.md`
line for every `cycles/<run>/<NN>/report.md` on the branch; cycle 21 ran `smoke:docs` before writing
its report, so its verify was green but the clean-checkout gate was red. Fix: this cycle's journal
line is written with its report and `smoke:docs` re-run after.

Verification: `smoke:brand` 18/18, `smoke:docs`, `test:typecheck`, `npx eslint tests/brand-smoke.ts`
all pass; independent reviewer **PASS** with a regression probe that made the smoke fail `file:line`.
Diff ~13,094 chars over 3 non-record files; no `package.json` scripts, `package-lock.json`,
`.github/`, or `autonomy/CHARTER.md` touched.

Left / next cycle: V-10 has no remaining sub-item. Residue outside the scanned scope is deliberate —
`autonomy/` records, `.pi/` state, `CHANGELOG.md` history, `package-lock.json`, and the
`.github/codeql/codeql-config.yml` `name:` line, an operator decision in
`autonomy/proposals/luna-core-01-19-codeql-config-name.md`. No new proposal was needed.
