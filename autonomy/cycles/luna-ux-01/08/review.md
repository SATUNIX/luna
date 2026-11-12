# Cycle 08 — Review (run luna-ux-01, stream `ux`)

Base `e22aac206685` (head of `stream/ux` after cycle 07), branch `pi/luna-ux-01`. Scope: TUI
overlays, the `/` command menu, launch screen, animation and polish.

## Board items checked against the code

### PG-12 — trunk-ahead notice (board calls it P1, ranked 12)

**Already done in cycle 07; nothing to change.** The notice is implemented on HEAD:

- `packages/extensions/src/kit-update/index.ts:730` `trunkNotice` is a pure export; it returns
  `trunk is N commit(s) ahead — /update channel <channel>` or `null`.
- `:652` computes `HEAD..<main>` through the injected git seam into `report.kit.trunkAhead`;
  `:764` appends the line in `formatReport`; `:1233` notifies at start-up before the `!hasUpdates`
  early return, inside the non-awaited background check; `:1278` notifies on bare `/update`.
- `tests/update-notice-smoke.ts` (7 checks) passes on this base:
  `[update-notice-smoke] all 7 checks passed`, including the never-resolving-git start-up case.
- Docs: `docs/updates.md:24`, `packages/extensions/src/kit-update/README.md:48`.

The one deviation from the board's literal wording (`/update channel trunk`) is deliberate and
documented: `trunk` is not a valid channel (`packages/core/lib/distribution.ts:124`,
`kit-update`'s `isChannelName` at `:1035`), so the notice names `next`, the channel that follows
`main`. The alias change is filed at `autonomy/proposals/luna-ux-01-07-trunk-channel-alias.md`
(core/ops, not `ux`). Acceptance is otherwise satisfied.

### V-73 — one wording for pure aliases, enforced (P2, ranked 6)

**Not on HEAD. This is the cycle's item.** Evidence:

- `git grep -n 'Alias for' packages/extensions/src` returns
  `web-console/index.ts:657: description: "Alias for /console ..."`.
- `tool-firewall/index.ts:1400`/`:1403` still append `(alias of /firewall reload|status)` instead
  of starting the description with `Alias of /<target>`.
- `packages/core/lib/command-contract.ts` has no `alias-target-missing` rule and never reads a
  registration's description; `git diff 384dcf4 HEAD -- packages/core/lib/command-contract.ts`
  is the exact inverse of the reviewed fix.

The fix was written and reviewed in cycle 05 (`384dcf4`, `00ff7c8` on
`origin/attempts/luna-ux-01/cycle-05`) but never merged because cycle 05/07 diffs had no room
under the stop-taking threshold. A scout confirmed HEAD's five touched files are byte-identical
to `384dcf4`'s parent (`git diff ba3ab0e HEAD -- <files>` is empty), so both commits cherry-pick
cleanly with no conflict.

## Carried over but not taken this cycle

- Back navigation from Display (proposal `luna-ux-01-04-settings-display-back-navigation.md`) —
  a page-stack change, larger than this cycle's budget.
- Overlay mouse forwarding (`luna-ux-01-04-overlay-mouse-forwarding.md`).
- Idle-cat blink intent (`luna-ux-01-01-idle-cat-blink.md`) — needs an operator intent decision
  before either driving or deleting the frame.
- `smoke:web-console` shared runtime (`luna-ux-01-03-web-console-smoke-shared-runtime.md`).
- `withOverlayFrame` dim leak (`overlay-frame.ts:124`) — **taken this cycle** as the second item
  after V-73; it was small, evidenced and in scope, so it was fixed rather than carried.

## New problems found

None beyond the above. The only withheld board item is V-73, and it is fully specified by
reviewed commits.

## Mode

**Fix mode.** There is a concrete, evidenced defect (three alias spellings and no check that an
alias target exists) with a reviewed, tested fix in the history.
