# Cycle 10 — Review (run luna-ux-01, stream `ux`)

Base `aad264ed68f1` (head of `stream/ux`). Read `autonomy/CHARTER.md`, the run HANDOFF, the
cycle-07 report, the rejected `origin/attempts/luna-ux-01/cycle-09` records and the open
proposals. Two read-only scouts checked the assigned items and the stream area against the code.

## Assigned board items

- **PG-59 [P0] is already satisfied at the base.** Cycle 07 fixed it (`ec30653`, `3b913d5`).
  `sessionStartNotice` (`packages/extensions/src/kit-update/index.ts:760-766`) returns only the
  trunk line when there is a gap. `tests/update-notice-smoke.ts:261-269` seeds pi's built-in
  `Updates available: pi X → Y. Run /update.` notice by object identity and asserts the kit notes
  are exactly the trunk line; a kit summary with the same wording would still fail. The pi-0.99.2
  case is `tests/update-notice-smoke.ts:286-298`. `npm run -s smoke:update-notice` →
  `all 8 checks passed` (exit 0). No change needed; re-verify and record.
- **V-05 [P2] is already satisfied at the base.** `smoke:launch-screen` → `all 11 checks passed`.
  One guarded `ctx.ui.setHeader` call (`control-center/index.ts:45-58`, invoked at `:68-75`),
  widths 20/40/60/80/120, reduced motion, timer self-stop and `dispose`, ASCII and
  `launchScreen: "off"` are all pinned in `tests/launch-screen-smoke.ts`. No change needed;
  re-verify and record.

## Rejected cycle-09 work that is sound and not yet in `stream/ux`

`origin/attempts/luna-ux-01/cycle-09` has four reviewed commits based on this exact base. The
rejection was about bookkeeping (claimed `dbf1c35` and V-73; unnamed real commits), not about
the code. The back-navigation fix the report claimed is already merged on this base as
`43fbfb0` (`hub.ts:368-392` carries the visited-page `stack`), so there is nothing to bring over
for it. These four are real defects at HEAD and are carried over here:

1. `8ad9349` — `allCommands()` (`control-center/index.ts:105-111`) emits every
   `builtinCommandNames()` entry and then every `pi.getCommands()` entry; pi's always-loaded
   extensions report `mcp`/`llama` through both, so the All commands page lists them twice.
   Fix: a `seen` set, built-ins first. Test: RPC `/menu all-commands` case.
2. `19c447b` — `hub.ts:283` returns `"back"` when the second/values RPC dialog is cancelled,
   contradicting `docs/control-center.md:101-102` ("a timeout counts as cancel ... closes the
   hub"); the operator lands on the parent page and must cancel again. Fix: return `undefined`.
3. `62edc31` — test hardening for the two new cases (a built-in `getCommands()` entry never
   dispatches; the duplicate-name assertion pins built-ins).
4. `33c35d8` — `hub.ts:328` always builds `SettingsList(items, 15)` and never reads
   `tui.terminal.rows`; with the frame's two borders and the search/hint lines a 24-row terminal
   renders ~26 lines, so the host scrolls the top border, page title and search off-screen. Fix:
   derive `maxVisible` from the terminal rows at render time. Test: a fake 24-row `tui`.

## New candidate not taken this cycle

- `overlay-frame.ts:135-148` forwards no `handleMouse` and lays inner content out at the full
  width before `frameLines` clips it to `width - 4`. Real, but it needs a pointer-event contract
  across the hub, the vendor panel and the pi-tui fake, which is larger than this cycle's budget.
  Written up as a proposal.

## Outcome

Fix mode. Two carried-over control-center defects, their test hardening, and the short-terminal
overlay defect are the cycle's work; the two assigned items are re-verified, not re-implemented.
