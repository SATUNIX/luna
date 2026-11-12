# Cycle 06 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: fix

Board: V-03 done - `/menu` is now the primary control-centre command with `/kit` and `/helpers` as forwarding aliases, the `alt+m` shortcut sends `/menu`, and a Settings page holds the `/settings` prefill plus the commandMenu/hubKey/pinned/hidden/Display rows.

Item: V-03 fold `/settings` into the `/` menu; `kit` -> `menu` - `3dfe7c1` (primary `/menu` + Settings page; cherry-pick of reviewed cycle-04 `27b22de`), `8c3b677` (unique Settings Display row id; cherry-pick of `a48d910`), `c3a74a2` (Settings-shape assertions, Doctor mermaid edge, stale row messages) - `npm run smoke:command-contract` (9), `smoke:command-menu` (11), `smoke:control-center` (30), `smoke:menu-settings` (4), `node packages/core/reference.ts --check`, `npm run verify`.

## P0 gate repair (no Board line)

`smoke:docs` was red on the base — `autonomy/cycles/luna-ux-01/03/report.md` had no
`autonomy/JOURNAL.md` line (cycle 03 merged without it; cycle 05's fix was never merged). The
report commit adds that line and the `luna-ux-01/06` line. `npm run verify` and `npm run smoke:docs`
pass on the final head. The other cycle-05 reds were not reproducible here: `smoke:env-isolation`
and `smoke:workflow-resume` pass, and the operator attributes `smoke:firewall-gate` /
`smoke:redaction-corpus` to host-load budgets owned by DE-93. No test was changed for them.

## Why the Settings page has six rows

The operator steering asked which shape is kept. Decision: **five setting item rows plus one
explicit `settings.display` page link** (six rows on the page). `c3a74a2` makes both
`tests/control-center-smoke.ts` and `tests/menu-settings-smoke.ts` assert the shape by id and kind
(six total, five non-page, `settings.display` is `kind: "page"`) rather than passing behind a
`kind !== "page"` filter. The five-row alternative would drop the Settings → Display entry.

## Also fixed

`docs/control-center.md` drew `System --> Doctor`, but `PAGES` gives `doctor` parent `updates`
(`model.ts`); the mermaid now reaches Doctor through `Updates & health`. `smoke:docs` only checks
the page-count wording, so it never caught the edge. Found by an independent scout.

## Verification

Independent `reviewer` subagent (not the author) read `49e17ff550ba..c3a74a2` against the charter
and the V-03 acceptance: **PASS**, one warning (the `c3a74a2` bundle mixes a docs edge with test
assertions; both are V-03-scoped). Target smokes, `test:typecheck`, `test:lint`, `verify` and
`reference.ts --check` pass; `npm run catalog` leaves no diff. Full diff 46,868 characters excluding
the lockfile and records. `verify.md` lists every command and result. The implementer workflow step
left its fixes staged and uncommitted and its reviewer returned FAIL; the coordinator finished that
work in `c3a74a2` and it was re-reviewed to PASS.

## Left and why

- **V-73** (canonical `Alias of /<target>` wording + the `alias-target-missing` rule) is implemented
  on `origin/attempts/luna-ux-01/cycle-05` (`384dcf4`, `00ff7c8`) but is not merged. Adding it to
  V-03 puts the diff at ~65,000 characters, over the 60,000 review budget, so it is deferred. The
  steward backlog for this cycle names V-03 as the only item.
- Carried proposals, all re-confirmed against the code: Settings → Display Back navigation (single
  static `parent`), overlay wheel/click forwarding, idle-cat blink (`now - now`), human-console
  concurrent cards, web-console shared-runtime smoke. New minor finding: `withOverlayFrame` leaves
  its dim patch installed if `build(finish)` throws.

## Next cycle should know

- The `stream/ux` base now carries V-03; do not re-land it.
- `smoke:env-isolation` / `smoke:workflow-resume` are green on this base, so a future red is not
  this cycle's diff.
- To take V-73, cherry-pick `384dcf4` and `00ff7c8` from `origin/attempts/luna-ux-01/cycle-05`; it
  needs a cycle with room under the review budget.
