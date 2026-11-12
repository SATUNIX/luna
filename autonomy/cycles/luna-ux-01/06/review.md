# Cycle 06 — Review (run luna-ux-01, stream `ux`)

Base: `49e17ff550ba` (head of `stream/ux`). Branch `pi/luna-ux-01`. Area: TUI overlays, the `/`
menu, launch screen, animation and polish (V-01, V-02, V-03, V-05, V-09).

## State at the start

- `git log --oneline 49e17ff550ba..HEAD` is empty: this cycle starts on the `stream/ux` head.
- Cycle 05 (both V-03 and V-73) ended completed but was **not merged**: acceptance red. Its work
  and report live on `origin/attempts/luna-ux-01/cycle-05` (`5cf8344`, `ba3ab0e`, `3d6fdc1`,
  `384dcf4`, `00ff7c8`). Cycle 04's V-03 pair is `origin/attempts/luna-ux-01/cycle-04`
  (`27b22de`, `a48d910`).
- The branch is **already red on `smoke:docs`** before any change: `autonomy/cycles/luna-ux-01/03/report.md`
  has no `autonomy/JOURNAL.md` line (P0 in the steward backlog and the operator steering).

## P0 — the red gate (reproduced)

```
$ npm run smoke:docs
AssertionError [ERR_ASSERTION]: autonomy/JOURNAL.md disagrees with the cycle reports
+ [ 'report with no journal entry: luna-ux-01/03; add: - luna-ux-01/03 | Board: V-01, V-03 | partial | <summary>' ]
```

`tests/docs-smoke.ts:491` calls `checkJournal(ROOT)` (`packages/core/lib/journal.ts`), which pairs
every `autonomy/cycles/<run>/<NN>/report.md` with a journal line and compares the `Board:` sets.
`autonomy/cycles/luna-ux-01/03/report.md` has `Board: V-01 done` + `Board: V-03 blocked`, so the
line must name `V-01, V-03` with outcome `partial`. Cycle 05 fixed this in `3d6fdc1`; that commit
was never merged. Fix: add exactly that line (operator wording), plus the new `luna-ux-01/06`
line, in the report commit.

The other cycle-05 gate failures — `smoke:env-isolation`, `smoke:redaction-corpus`,
`smoke:workflow-resume`, `smoke:firewall-gate` — are **not reproducible** on this base:
`smoke:env-isolation` and `smoke:workflow-resume` both pass here (below). The operator steering
attributes `firewall-gate`/`redaction-corpus` to wall-clock budgets under host load and assigns
them to DE-93. No test change is made for them.

```
$ npm run smoke:env-isolation   → [env-isolation-smoke] OK
$ npm run smoke:workflow-resume → workflow-resume-smoke: 41 checks passed
```

## V-03 — fold `/settings` into `/menu`, rename kit → menu (P1, the steward backlog's only item)

The reviewed implementation already exists on the cycle-05 branch and was approved there by two
reviewers. Re-checked against the actual code and the acceptance points:

- `index.ts`: `registerCommand("menu", …)` with the old `/kit` description and page completions;
  `kit` and `helpers` on the same `open` handler, both `description: "Alias of /menu"`; the
  `alt+m` shortcut sends `/menu` (`pi.sendUserMessage("/menu", …)`).
- `extension.json`: `registers.commands` = `menu, kit, helpers`; summary names `/menu` with both
  aliases. `command-menu.ts`: `PINNED_KIT_COMMANDS` starts `menu`; `ALL_COMMANDS_LOCATION` and
  `locationOfRow` build `moved → /menu …`.
- `model.ts`: `{ id: "settings", title: "Settings", parent: "main" }`, main row `page.settings`,
  and the settings rows `settings.pi` (`prefill: "/settings "`), `settings.commandMenu`,
  `settings.hubKey`, `settings.pinned`, `settings.hidden`, plus the `settings.display` page row.
- `values.ts`: `HubValues` gains `commandMenu`/`hubKey`/`pinnedCommands`/`hiddenCommands`, filled
  from a `MenuSettingsView` passed by `index.ts` (no import of `command-menu.ts` from values).
- No `registerCommand("settings"` in the kit (`grep` empty); no `ui.json` write; `packages/kit`,
  `PI_KIT_*`, `Symbol.for("pi-kit.*")`, the npm name and `core/eval/live/run.ts` are untouched.
- Remaining `/kit` in docs are `packages/kit/` path references only (allowed); every `/kit`
  command reference is an alias mention.

**The Settings-page shape (operator steering).** The page has six rows: five setting item rows
plus the explicit `settings.display` page link. The operator says the two assertions "now see six
rows" and to name the shape rather than widen a filter.
- `tests/control-center-smoke.ts:324-337` asserts the full six-id list (including
  `settings.display`) and then `filter(kind !== "page").length === 5`. That names the shape.
- `tests/menu-settings-smoke.ts:134-135` only counts `filter(kind !== "page").length === 5` and
  never asserts the total is six; it is weaker than the control-center test.
Decision: **keep five setting item rows plus one explicit page-link row**, and make both
assertions state that shape explicitly (assert six rows on the page, five non-page, and the
`settings.display` link). The operator's second option — a five-row page — would drop the
Settings → Display entry the design calls for.

## V-73 — one alias wording, enforced (assigned, deferred)

Cycle 05 implemented it (`384dcf4`, `00ff7c8`): `Alias of /<target>` for `firewall:status`,
`webui`, and the `alias-target-missing` rule in `packages/core/lib/command-contract.ts`. It is
**sound but cannot be merged this cycle**: the full cycle-05 diff is 65,288 characters excluding
the lockfile and record files, above the 60,000-character review budget; V-03 alone is 45,670 and
V-73 adds ~19,600 on top. The steward backlog for this cycle names V-03 as the only item.
Deferred to a later cycle; the commits stay on `origin/attempts/luna-ux-01/cycle-05` and are
carried in `HANDOFF.md`.

## New defect found this cycle

`docs/control-center.md:54` (and cycle-05's copy): the mermaid draws `Y["System"] --> D[Doctor]`,
but `PAGES` gives `doctor` `parent: "updates"` (`model.ts:96`), reached only as
System → Updates & health → Doctor. The table above it is right; the edge is not. `smoke:docs`
only checks the "levels strip plus N pages" wording, so it never caught it. One-line fix in the
V-03 docs commit.

## Proposals checked against the code (all still valid)

- `luna-ux-01-01-human-console-multi-card-focus-theft.md` — valid: `processPending` fires one
  `void processOne` per file (`human-console/index.ts:465,474-479`) and the input hold is checked
  once per file, not across files.
- `luna-ux-01-01-idle-cat-blink.md` — valid (deferred intent): `=^-.-^=` is in `idle`
  (`cat.ts:36`) and the smoke asserts the blink (`tests/cat-status-smoke.ts:95`), but `idle` is not
  in `TRANSIENT`, so `catView` passes `now - now` (`index.ts:387-391`); docs say it does not blink.
- `luna-ux-01-04-overlay-mouse-forwarding.md` — valid: no `handleMouse` path in
  `overlay-frame.ts` / `hub.ts` / `wf-panel.ts`.
- `luna-ux-01-04-settings-display-back-navigation.md` — valid: `hub.ts` resolves Back through the
  single static `parent`, so Settings → Display → Back lands on System.
- New minor finding (proposal, not fixed): `withOverlayFrame` leaves its dim patch installed if
  `build(finish)` throws (`overlay-frame.ts:124`).

## Mode

Fix mode. The cycle's first obligation is the red `smoke:docs` gate; the assigned board item is a
re-land of reviewed improve work, taken after the gate.

## Budget

V-03 re-land ≈ 45,670 characters of diff plus two small fix hunks, under both the 30,000
stop-starting mark (already exceeded by the board item itself) and the 60,000 review threshold.
No V-73, no new broad work.
