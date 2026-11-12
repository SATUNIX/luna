# Cycle 07 — Plan (run luna-ops-01, stream `ops`)

Mode: **fix**. Review: `review.md`. Base `0b8b2c9bceb2`.

The assigned board items DE-105 and DE-106 are already merged and verified; this cycle takes the
three evidenced defects found in the same area, in priority order. Each item goes through one
`workflow_run` plan: an `implementer`, then a `reviewer` that did not write the change, gate `PASS`,
`max_loops` 1. Commit and push after each item. Stop taking new items once the review diff exceeds
30000 characters.

## Item A — project-scope install must not write the global `.env`

- **Justification**: charter priority 4 (defect), security/config correctness. `install.ts:758-771`
  scaffolds `<agent dir>/.env` for every scope, contradicting `docs/INSTALL.md:70`, which promises a
  project-scope install writes only `.pi/settings.json` and `.pi/.pi-kit.json`. A project install
  should not touch the operator's global agent directory.
- **Change**: gate the `.env` scaffold and its dry-run message on `scope === "global"`; leave global
  behaviour byte-identical. Update the installer comment to say why. Extend
  `tests/install-marker-smoke.ts` so the existing project-scope gate test also asserts the global
  `.env` is absent/unchanged and the dry run prints no scaffold line. Add a project-scope positive
  assertion that the project settings and marker are still written. Update `docs/INSTALL.md` if the
  wording needs to mention `.env` explicitly; keep the existing promise.
- **Checks**: `npm run -s smoke:install-marker`, `npm run -s test:typecheck`, `npm run -s test:lint`,
  `npm run -s smoke:docs`, `npm run -s docs:check`, `npm run -s verify`.

## Item B — argument validation must not block `--help`, and `--for-changed` must validate `--skip`

- **Justification**: two CLI correctness defects. `install.ts:98-115` validates before handling
  `--help`, so `install.ts --help --profile` exits 1 while `docs/INSTALL.md:58` promises `--help`
  exits 0 before install work. `check-all.ts:499-509` returns from `--for-changed` plan mode before
  `unknownSkips`, so a misspelt `--skip` exits 0 in plan mode and 2 otherwise, while the file header
  documents exit 2.
- **Change**: in `install.ts`, handle `--help`/`-h` before the argument-validation loop (still no
  install work, still stdout and exit 0). Extend `testHelpFlag` to cover `--help --profile` and
  `--help --bogus` without side effects. In `check-all.ts`, run `unknownSkips` before the
  `--for-changed` plan branch so both modes reject a misspelt skip with exit 2; keep valid plan-mode
  output unchanged. Add a plan-mode typo assertion to `tests/check-all-npm-smoke.ts`.
- **Checks**: `npm run -s smoke:install-marker`, `npm run -s smoke:check-all-npm`,
  `npm run -s test:typecheck`, `npm run -s test:lint`, `npm run -s smoke:docs`,
  `npm run -s docs:check`, `npm run -s verify`.

## Sequencing and budget

Item A first (larger correctness fix), then Item B. Run the targeted checks named above; never run
`npm test` or `npm run check:all`. Re-derive the final check set with
`node packages/core/check-all.ts --for-changed="$(git diff --name-only 0b8b2c9bceb2..HEAD | tr '\n' ',')"`
and record RAN/SKIPPED in `verify.md`.
