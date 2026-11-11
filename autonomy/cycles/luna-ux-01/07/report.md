# Cycle 07 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: fix

Board: PG-12 done - a git install now prints one line, `trunk is N commits ahead — /update channel next`, at start-up, on bare `/update`, and under `/update status`, without ever blocking start-up.

Board: V-03 done (already on the base) - verified `/menu` primary with `/kit` and `/helpers` aliases, the `alt+m` shortcut and the Settings page; no change was needed or made this cycle.

Item: PG-12 trunk-ahead notice - `fc6f1d4` (pure `trunkNotice`, best-effort `trunkAhead` via the git seam, start-up notify before the `hasUpdates` return, `formatReport` line, `tests/update-notice-smoke.ts`, docs), `115758e` (review fixes: accurate `trunkAhead` comment, empty-channel contract, bare-`/update` notify, alias proposal), `d1df582` (point the notice at `next`, the channel that follows `main`; harden the non-finite guard; extend the smoke to 7 checks) - `npm run smoke:update-notice` (7), `npm run smoke:kit-update` (40), `npm run test:typecheck`, `npm run test:lint`, `node packages/core/reference.ts --check`, `npm run smoke:docs`.

## What changed and why

The owner had no way to learn the kit's trunk had moved: `kit-update`'s `session_start` only
reported release-channel updates and returned early when `!hasUpdates(report)`, and its git path
compared hashes without counting commits. A `latest` install whose `main` moved 19 commits ahead
stayed silent until the owner asked an agent to run `git`.

`trunkNotice({ channel, ahead })` is a pure export. `checkForUpdates` now runs
`["-C", root, "rev-list", "--count", "HEAD..<main>"]` through the existing injected git seam in the
git branch, stores a defensive `trunkAhead` (absent offline or non-numeric, `0` in sync), and never
touches `available`/`hasUpdates`/`summaryLine`. Start-up notifies before its early return, still
inside the non-awaited `void check(...)`; the bare interactive `/update` notifies before its
selector; `formatReport` appends the line for `/update status`. The smoke's "hang" case pins that a
git call that never returns cannot delay start-up.

## Deviation from the board's example action

The board's PG-12 wording was `/update channel trunk`, but `trunk` is not a channel:
`packages/core/lib/distribution.ts:124` (`CHANNEL`) and `kit-update`'s `isChannelName`
(`index.ts:1035`) accept only `latest`, `next`, or an exact version, so that command prints
`Unknown channel "trunk"`. The channel that follows `main` is `next`. The notice therefore names
`next` (`TRUNK_CHANNEL`), an action that actually moves the copy to the newer commits — naming the
installed channel (`latest` or a pin) would print a command that cannot. The rationale and the
change needed to make `trunk` valid are filed in
`autonomy/proposals/luna-ux-01-07-trunk-channel-alias.md` (a core/ops change, not `ux`).

## Verification

Targeted checks pass: `smoke:update-notice` (7), `smoke:kit-update` (40), `test:typecheck`,
`test:lint`, `reference.ts --check`, `smoke:docs`. `verify.md` lists every command and proof line.
Two independent reviewers returned FAIL on earlier heads — an unpushed commit, then the
wrong-channel notice — and both were fixed; the host's `verify_completion` verified the final head.
The full diff is 25,731 characters excluding the lockfile and records. V-73 stays deferred for the
30,000-character stop-taking threshold.
