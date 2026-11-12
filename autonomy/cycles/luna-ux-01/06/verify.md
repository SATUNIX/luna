# Cycle 06 — Verify (run luna-ux-01, stream `ux`)

Base `49e17ff550ba`, branch `pi/luna-ux-01`, head `c3a74a2` (before the report commit).
`npm test` and `npm run check:all` were not run, per the cycle rules.

## Targeted checks

| Command | Result | Proof line |
| --- | --- | --- |
| `npm run smoke:command-contract` | PASS | `[command-contract-smoke] all 9 checks passed` |
| `npm run smoke:command-menu` | PASS | `[command-menu-smoke] all 11 checks passed` (locations now `/menu`) |
| `npm run smoke:control-center` | PASS | `[control-center-smoke] all 30 checks passed` (registered set = menu, kit, helpers; Settings shape) |
| `npm run smoke:menu-settings` | PASS | `[menu-settings-smoke] all 4 checks passed` |
| `node packages/core/reference.ts --check` | PASS | `[reference] OK: docs/reference.md is up to date.` |
| `npm run test:typecheck` | PASS | all 8 `tsc -p …` projects complete with no diagnostics |
| `npm run test:lint` | PASS | `eslint --flag unstable_native_nodejs_ts_config --max-warnings 0 .` exits 0 |
| `npm run verify` | PASS | `[verify] All checks passed.` |
| `npm run catalog` | PASS | no `git status` diff after regeneration |
| `npm run smoke:docs` | FAIL then PASS | fails on `report with no journal entry: luna-ux-01/03` until the report commit adds the line (operator G-0); the docs page-count assertion at `tests/docs-smoke.ts:328` already passes |
| `npm run smoke:env-isolation` | PASS (base) | `[env-isolation-smoke] OK` |
| `npm run smoke:workflow-resume` | PASS (base) | `workflow-resume-smoke: 41 checks passed` |

`smoke:docs` after the report commit (journal lines for `luna-ux-01/03` and `luna-ux-01/06`) is the
P0 gate repair; it is re-run on the final head.

## V-03 acceptance evidence

- `/menu` (`index.ts:171`), `/kit` (`:178`) and `/helpers` (`:183`) all pass `handler: open`;
  `kit`/`helpers` are exactly `description: "Alias of /menu"`; `registered.size === 3`.
- `registerShortcut(hubKey, …)` sends `/menu` (`index.ts:191`).
- `model.ts` has the `settings` page (`parent: "main"`) and rows `settings.pi` (prefill
  `/settings `), `settings.commandMenu`, `settings.hubKey`, `settings.pinned`, `settings.hidden`,
  `settings.display` (targetPage `display`).
- `grep registerCommand("settings"` is empty.
- Location strings and docs use `moved → /menu …`; only menu-UI text changed. `packages/kit`,
  `PI_KIT_*`, `Symbol.for("pi-kit.*")`, the npm name, `core/eval/live/run.ts` `/kit` mounts and
  `ui.json` are untouched.
- Both Settings-page assertions now state the shape: six page rows, the by-id list including
  `settings.display`, five setting item rows, and `settings.display` is `kind: "page"`.
- `docs/control-center.md` mermaid reaches Doctor through `Updates & health`, matching
  `doctor.parent === "updates"`.

## Review

An independent `reviewer` subagent (it did not write the change) read the full
`49e17ff550ba..c3a74a2` diff against the charter and the V-03 acceptance and returned **PASS**,
with one warning only: `c3a74a2` bundles the Settings-shape assertions with the mermaid edge fix,
which it called small and V-03-scoped but "one logical change per commit" would prefer split.
The step-1 workflow reviewer had earlier returned FAIL because the implementer left the fixes
staged and uncommitted; that work was finished in `c3a74a2` and re-reviewed to PASS. No critical
finding remains. The full diff is 46,868 characters excluding the lockfile and records (under the
60,000 review threshold).

## Gate / budget

The only reproducible cycle-05 gate failure was the `smoke:docs` journal line (fixed in the report
commit). `smoke:firewall-gate` / `smoke:redaction-corpus` are host-load budgets owned by DE-93;
`smoke:env-isolation` / `smoke:workflow-resume` pass on this base. V-73 was deferred for the diff
budget.
