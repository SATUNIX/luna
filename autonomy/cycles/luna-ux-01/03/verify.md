# Cycle 03 — Verify (run luna-ux-01, stream `ux`)

- Base `876471a5bdbe`, HEAD `c231372`. Diff (lockfile and cycle/run records excluded): **31267
  characters** — measured with
  `git diff --no-renames 876471a5bdbe..HEAD -- . ":(exclude)package-lock.json" ":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c`.
- Item 1 (V-01 re-land) is landed and reviewed; Item 2 (V-03) not taken (budget rule).

## Checks run on the final tree

| Check | Result |
| --- | --- |
| `npm run smoke:control-center` | PASS — `[control-center-smoke] all 28 checks passed`, including border/dim/restore and byte-identity cases |
| `npm run smoke:workflow-panel` | PASS — `workflow-panel-smoke: 14 checks passed`, including the panel border and dim/restore |
| `npm run test:typecheck` | PASS — exit 0 |
| `npm run test:lint` | PASS — exit 0 |
| `cmp src/control-center/overlay-frame.ts third_party/subagent/overlay-frame.ts` | PASS — `COPIES IDENTICAL` |
| `npm run smoke:web-console` | PASS — `web-console smoke: OK` (single run; the recorded cycle-02 failure does not reproduce) |
| `git diff 876471a5bdbe..HEAD --name-only` | PASS — no `packages/web-ui/`, `tool-firewall/`, `package.json` or lockfile path |

Never ran `npm test` or `npm run check:all` (host gate owns the full suite).

## Independent review

A `reviewer` subagent that did not write the change (workflow run
`2026-11-11T06-01-37-764Z-plan-dedf`, `step-2`, `PASS`) reviewed `git diff 876471a5bdbe..HEAD`
against the charter and `03/plan.md`. It confirmed the re-land matches the reviewed commits exactly
(`git diff 72d1f4c ddf1c39 -- . ':!autonomy'` and `git diff 404b13a c231372 -- . ':!autonomy'` are
empty), the two copies are byte-identical, both call sites restore on `done`/`dispose`, the diff
touches no control path, and documented behaviour is updated. No must-fix and no warning.

An earlier `scout` (run `2026-11-11T05-57-28-261Z-scout-56a3f9`) independently re-read the module
and tests, ran the smokes on a worktree of the branch tip, and confirmed `git apply --check` for
`72d1f4c`+`404b13a` onto the base is clean.

## What the change proves

- Both kit TUI overlays render inside a rounded box drawn in `theme.fg("border", …)`; the transcript
  behind an open overlay comes back with the `dim` colour and reverts after `done` and `dispose`.
- Widths 40 and 12 keep every visible line within the width; width 8 does not throw; the two
  `overlay-frame.ts` copies are byte-identical.
- The change is confined to the UX stream: `hub.ts`, `wf-panel.ts`, the two new `overlay-frame.ts`
  files, the two smokes, `docs/control-center.md` and `CHANGELOG.md`.

## Acceptance-failure attribution

The cycle-02 red run (`check-all`, `check-all:smoke:web-console` exit 1) is not attributable to this
change: the diff touches no `packages/web-ui/` code or `package.json` scripts, and the smoke passes
standalone and from the branch worktree. Two concurrent `smoke:web-console` runs reproduce the same
`PI_CONSOLE_TOKEN_FILE … ENOENT` failure on the shared repo-relative `packages/web-ui/.runtime`
path, so the smoke is runner-order sensitive; proposed in
`autonomy/proposals/luna-ux-01-03-web-console-smoke-shared-runtime.md`.

## Left for next cycle

- **V-03** (fold `/settings` into the `/` menu; rename `kit` → `menu`): fully planned in
  `02/plan.md` and validated in `02/review.md`; not started because this cycle's diff already
  passed the 30000-character stop threshold.
- Latent ≤3-character hidden-command reveal gap (`command-menu.ts:184`); V-03 removes it.
