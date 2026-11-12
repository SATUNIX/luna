# Cycle 07 review — stream ux (luna-ux-01)

Base: `b91bc34ec41d` (head of `stream/ux`). Cycle mode: **fix**.

## Inputs read

- `autonomy/CHARTER.md` (acceptance standard).
- `autonomy/runs/luna-ux-01/HANDOFF.md` (current state after cycle 06).
- Previous cycle records under `autonomy/cycles/luna-ux-01/06/` and the branch log
  `git log --oneline b91bc34..HEAD` (empty at cycle start).
- Open proposals under `autonomy/proposals/luna-ux-01-*.md`, including
  `luna-ux-01-06-duplicate-builtin-commands.md` (the handoff names it, but only the handoff
  copy exists on this branch).

## P0 — upstream merge conflict (priority 1)

`git merge refs/upstream/trunk` conflicted in exactly two files:

- `package.json`: each side added one smoke script. Resolution keeps both
  `smoke:update-notice` (stream) and `smoke:kit-update-channel` (upstream).
- `packages/extensions/src/kit-update/index.ts`: upstream added the `trunk` branch/tag fields
  and the `trunk` channel planner; the stream added `trunkAhead` (the commit-gap count that
  feeds the trunk notice). Resolution keeps both: `branchHead(remote, dist.trunkBranch)` and
  `tags.trunk`, plus the `HEAD..main` count that sets `trunkAhead`.

Evidence: merge commit `03bc064`; `grep '^<<<<<<<\|^=======\|^>>>>>>>'` on both files returns
nothing. After the merge `npm run test:typecheck`, `npm run test:lint`,
`npm run smoke:update-notice`, `npm run smoke:kit-update-channel` and
`npm run smoke:launch-screen` all pass.

## Board items

### PG-59 [P0] smoke:update-notice reddens pi-compat lanes

Confirmed against the code, not just the advisory:

- `tests/update-notice-smoke.ts:260-266` asserts the whole `notes` array deep-equals exactly one
  trunk notice.
- The session-start handler (`packages/extensions/src/kit-update/index.ts:1254-1257`) notifies the
  trunk notice and then falls through to `hasUpdates(report)` → `ctx.ui.notify(summaryLine(...))`.
  On a pi older than the test pin (`PI_TAGS` latest `1.4.0`), `report.pi.available` is true, so a
  second kit notice `Updates available: pi X → 1.4.0. Run /update.` follows. On the pinned
  pi 1.4.0 there is no pi update, which is why the test only fails in pi-compat.
- Root cause: no precedence rule between the trunk-gap notice and the generic summary notice.

### V-05 [P2] Luna launch screen

Already shipped on this branch by cycles 01–02. A scout checked every acceptance point against
`launch-screen.ts`, `control-center/index.ts`, `tests/launch-screen-smoke.ts`,
`docs/control-center.md` and `extension.json`: all PASS (single `setHeader` from the existing
`session_start`, TUI-only, child-safe, `launchScreen: "off"`, widths 20/40/60/80/120 within
`visibleWidth`, reduced motion starts no timer, animated timer self-stops and `dispose` stops it,
ASCII printable, env declared, docs section present). `npm run smoke:launch-screen` reports
`all 11 checks passed`. No V-05 code change is needed this cycle.

## Carry-overs and defects (not taken)

HANDOFF carry-overs remain real; a scout confirmed both against the code:

1. `/mcp` and `/llama` are listed twice on All commands: `allCommands()`
   (`packages/extensions/src/control-center/index.ts:106-111`) pushes
   `builtinCommandNames()` (which includes `mcp`/`llama`) and then every `pi.getCommands()`
   entry, which also reports those extension commands. No test covers duplicate rows.
2. A cancelled/timeout value dialog returns `"back"` (`hub.ts:283`), so on a subpage it reopens
   the parent instead of closing, contradicting `docs/control-center.md` ("a timeout counts as
   cancel ... closes the hub"). The existing RPC test never reaches the second dialog.

They are not taken this cycle because the mandatory upstream merge alone puts the review diff far
past the 30000-character stop line; the handoff records them for a later cycle.

## Diff budget

`git diff --no-renames b91bc34..HEAD` excluding lockfile and record paths is 263,044 characters
after the merge, dominated by upstream files. Cycle-owned changes are kept to PG-59 only.
