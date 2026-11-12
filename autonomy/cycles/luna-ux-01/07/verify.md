# Cycle 07 — Verify (run luna-ux-01, stream `ux`)

Base `210390b86be2` (head of `stream/ux`), branch `pi/luna-ux-01`, code head `04a98bf2`.
`npm test` and `npm run check:all` were not run, per the cycle rules; checks below are the
targeted scripts named by `check-all --for-changed`.

## Changed paths and check plan

`node packages/core/check-all.ts --for-changed="$(git diff --name-only 210390b86be2..HEAD | tr '\n' ',')"`
printed the plan for 12 changed paths (exit 0). Each named check was then run:

| Check | Result |
| --- | --- |
| `npm run docs:check` | RAN — PASS, `[docs-nav-check] OK: nav entries exist and internal links resolve.` |
| `npm run smoke:docs` | RAN — PASS, `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved`. |
| `npm run smoke:eval-footprint` | RAN — PASS, `all 13 checks passed`. |
| `npm run smoke:launch-screen` | RAN — PASS, `all 16 checks passed`. |
| `npm run smoke:new-extension` | RAN — PASS, `new-extension smoke: OK`. |
| `npm run smoke:subagent-roles-isolation` | RAN — PASS, `all 7 checks passed`. |
| `npm run smoke:workflow-notify` | RAN — PASS, `10 checks passed`. |
| `npm run smoke:workflow-panel` | RAN — PASS, `22 checks passed`. |
| `npm run test:lint` | RAN — PASS, exit 0, `eslint --max-warnings 0 .`. |
| `npm run test:typecheck` | RAN — PASS, exit 0, all eight `tsc -p` projects. |
| `npm run verify` | RAN — PASS, `[verify] All checks passed.` |

Additional cycle-named checks not selected by the plan but relevant to the touched files were run
explicitly: `npm run smoke:tui-layout` — PASS, `5 checks passed` (the panel width change is in the
vendored subagent renderer this smoke lays out).

## Item evidence

- **D1 launch screen ASCII parity** — `npm run smoke:launch-screen` 16/16. The new footer-parity
  case compares `asciiThemeName(name)` with `footerGlyphs(themeNamed(name)).ascii` for
  `iso-dark, ansi-dark, tty-dark, ascii, gitops-dark, high-contrast-dark, "", marathon`, so the two
  renderers cannot drift. With the fix reverted the ISO cases fail (no ASCII block art).
- **D2 workflow panel column widths** — `npm run smoke:workflow-panel` 22/22. The 2c case fails on
  the pre-fix source (`AssertionError: phase rows share one width, so done/total is one column`),
  and the added `renderText` case fails on `488b64f9` without the strip fix
  (`AssertionError: the text fallback has no terminal sequences`). Both pass at HEAD.
- `node packages/core/gen-notices.ts` was run in the SOURCE.md commit; `git status` showed no
  remaining notices drift and `smoke:new-extension` / `verify` pass.

## Independent review

Two read-only reviewer subagents examined `git diff 210390b86be2..HEAD` against
`autonomy/CHARTER.md`. The first returned FAIL on two points: the launch-screen docs edit had
mangled a paragraph, and `cell()` leaked `truncateToWidth`'s ANSI resets into the plain-text
fallback. Both were fixed (`98127528`, `04a98bf2`), the fixes were verified to fail without the
change, and a narrow re-review of the fixes returned PASS. Scope check found no touched charter,
`package.json` scripts, operator control paths, kit themes, web UI, footer fitting logic or cat.

## Diff size

`git diff --no-renames 210390b86be2..HEAD` excluding the lockfile and cycle records: 23316 bytes,
under the 30000-character stop line. No new items were taken after that measurement.
