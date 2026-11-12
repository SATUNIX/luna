# Cycle 01 verification — luna-fleet-01

Changed files: `packages/extensions/src/autonomy-run/index.ts`,
`tests/autonomy-command-smoke.ts`, `packages/extensions/src/autonomy-run/README.md`,
`docs/autonomy.md`, generated `docs/reference.md`, plus this cycle's record files.
Check plan from `node packages/core/check-all.ts --for-changed="<changed paths>"`:
docs:check, smoke:autonomy-command, smoke:docs, smoke:new-extension, test:lint,
test:typecheck, verify.

## Checks

- `npm run docs:check` — RAN, PASS: `[docs-nav-check] OK: nav entries exist and internal links resolve.`
- `npm run smoke:autonomy-command` — RAN, PASS: `[autonomy-command-smoke] OK (14 checks)`, including the new inbox cases.
- `npm run smoke:autonomy-inbox` — RAN, PASS: `[autonomy-inbox-smoke] all 5 checks passed` (CLI contract unchanged).
- `npm run smoke:docs` — RAN, PASS: `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; ...`
- `npm run smoke:new-extension` — RAN, PASS: `new-extension smoke: OK`.
- `npm run test:lint` — RAN, PASS (exit 0). Plus `npx eslint --max-warnings 0` on both changed TS files, exit 0.
- `npm run test:typecheck` — RAN, PASS (exit 0, all tsconfig projects).
- `npm run verify` — RAN, PASS: `[verify] All checks passed.`

Not run (cycle rule; the host gate runs the full suite on a clean checkout): `npm test`,
`npm run check:all`.

## The new test fails on the base

The cycle's test file, copied into a clean `git archive af7ad8915d5c` tree and run there, exits 1
at `findCall` ("the expected CLI call was made"): without the `inbox` case the command answers
`unknown command "inbox"` and spawns nothing. With the change, 14/14 checks pass.

## Independent review

- First reviewer (subagent) returned **FAIL**: the documented `--file` pass-through had no test
  (charter rule 2), and `docs/autonomy.md` cited the extension test for CLI settlement.
- Fixed in `923f4f0`: a `--file cards.json` assertion pins the cwd-resolved path, an unknown flag
  asserts no spawn plus the usage note, and the docs cite `tests/autonomy-inbox-smoke.ts` for
  settlement and `tests/autonomy-command-smoke.ts` for forwarding.
- Second reviewer (workflow step, did not write the change) re-read the whole diff and returned
  **PASS**, with two non-blocking warnings: the docs sentence generalised run-level settlement to
  the fleet view (fixed in `47c8558`), and `--answer` ids starting with `--` are rejected by the
  CLI (not reachable with real card ids). It re-ran all five checks and measured the reviewable
  diff at 11,320 chars.

## Scope and review budget

- Reviewable diff `af7ad8915d5c..HEAD` excluding lockfile and cycle/run records: 11,338 chars,
  well under the 30,000 stop and 60,000 review cap.
- No change to `autonomy/CHARTER.md`, `autonomy/BACKLOG.md`, any `package.json` `scripts`, the
  lockfile, CI, release files, or unrelated sources.
- O-01 is **progress**: PG-06 host event log, PG-07 live widget, PG-08 web console panel, PG-09's
  full owner-inbox surface (the card file is still written by the CLI/`--file`) and the
  non-Claude walkthrough remain.
