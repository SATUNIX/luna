# Cycle 07 — Review (run luna-ux-01, stream `ux`)

Base: `629d99874c10` (head of `stream/ux`). Branch `pi/luna-ux-01`. Area: TUI overlays, the `/`
menu, launch screen, animation and polish (V-01, V-02, V-03, V-05, V-09).

## State at the start

- `git log --oneline 629d99874c10..HEAD` is empty and `git status` is clean: the cycle starts on
  the `stream/ux` head that already carries cycles 01, 03, 04 and 06.
- No red gate reproduced on the base. `smoke:command-contract` (9), `smoke:command-menu` (11),
  `smoke:control-center` (30), `smoke:menu-settings` (4), `smoke:docs` and
  `node packages/core/reference.ts --check` all pass. The steward backlog names `smoke:docs` as
  fixed by cycle 06; the advisory's missing `luna-ux-01/03` journal line is already present
  (`autonomy/JOURNAL.md`), so no bookkeeping change is due this cycle.
- Steward backlog correction acknowledged: the wall-clock board item is **DE-95**, not DE-93, and
  belongs to the ops slice. `smoke:workflow-resume`, `smoke:env-isolation` and `smoke:web-console`
  are real checks; if this cycle's gate reports `tests/workflow-resume-smoke.ts:392` ("a stopped
  run's writer leaves the checkout queue") the report must quote it and not treat it as a flake.

## Board items checked against the code

### V-03 — fold `/settings` into `/` menu; `kit` → `menu` (P1)

**Already complete on the base.** The cycle-06 report records it as done and the code matches the
acceptance:

- `packages/extensions/src/control-center/index.ts:169` registers `menu` as primary with page
  completions; `:178` and `:183` register `kit`/`helpers` on the same `open` handler with
  `description: "Alias of /menu"`; the shortcut (alt+m default, `hubKey`) sends `/menu`
  (`:190`).
- `packages/extensions/src/control-center/extension.json` registers `commands: ["menu","kit","helpers"]`.
- `packages/extensions/src/control-center/command-menu.ts:26` builds `moved → /menu ▸ All commands`,
  so hidden-command locations read `moved -> /menu ...`; `:29` pins `menu`.
- `model.ts` carries the `settings` page (`{id:"settings",...}`) with the `/settings ` prefill row
  and the commandMenu/hubKey/pinnedCommands/hiddenCommands rows plus the Display page link
  (pinned by `tests/menu-settings-smoke.ts`).
- No kit command named `settings` is registered (pi's `/settings` built-in is untouched).
- `npm run smoke:command-contract`, `smoke:command-menu`, `smoke:control-center` and
  `smoke:menu-settings` pass on the base.

No further V-03 change is needed; re-doing it would churn merged code.

### PG-12 — tell the owner when the trunk is ahead, in one line (P1)

**Confirmed absent.** No code computes or prints a trunk-ahead/commits-ahead line:

- `packages/extensions/src/kit-update/index.ts:1190-1207` (`session_start`) only calls
  `ctx.ui.setStatus` and `ctx.ui.notify(summaryLine(report), "info")`.
- `formatReport` (`:711-770`) lists per-target version state but no commit gap.
- The git/local branches (`:636-686`) compare commit hashes (`main !== commit`,
  `merge-base --is-ancestor`) and set `available`/`target`, but never count commits and never
  surface "N commits ahead".

The owner only learns the gap by running git manually. This is a real discoverability gap
(charter §What counts as an improvement 1) with a pure-function shape that is cheap to test
offline, so it is this cycle's item.

## Carried over, not taken this cycle

- **V-73** (canonical `Alias of /<target>` wording + the `alias-target-missing` contract rule)
  is still not on the base (`command-contract.ts` has no such rule). Its two reviewed commits
  (`384dcf4`, `00ff7c8` on `origin/attempts/luna-ux-01/cycle-05`) are ~33k characters and would
  push the review budget past the 30k stop-taking threshold once PG-12 lands, so it waits again.
- Proposals re-confirmed against the code but not blocking: Settings → Display back navigation
  (single static `parent`), overlay mouse forwarding, idle-cat blink (`catView` passes
  `now - now`), human-console concurrent cards, web-console shared-runtime smoke,
  `withOverlayFrame` dim leak.

## Mode

**Fix/improve mix; taken as improve for PG-12.** The only remaining board item names a missing
capability (PG-12), and V-03 needs no change. Fix mode applies only if a targeted check is red,
and none is.
