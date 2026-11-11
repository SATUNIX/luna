# Cycle 07 — Plan (run luna-ux-01, stream `ux`)

Base `629d99874c10` (head of `stream/ux`). Mode: **improve**, one board item (PG-12). V-03 is
already complete on the base (see `review.md`), so no change is made for it.

Goal: tell the owner when the kit's trunk is ahead of the installed copy, in one line, at start-up
and at `/update`, without blocking start-up.

## Item PG-12 (P1, steward board)

### Finding and evidence

`packages/extensions/src/kit-update/index.ts` never computes or prints a commit gap. The git path
(`:636-660`) compares the installed commit with the branch head (`main !== commit`) and moves the
`next` target to `main@<sha>`, but reports only a target string. `session_start` (`:1190-1207`)
notifies `summaryLine(report)` and returns early when `hasUpdates(report)` is false, so an install
on the `latest` release whose `main` has moved learns nothing. `/update`'s `formatReport`
(`:711-770`) has no gap line either. Confirmed by reading the code and by the existing
`smoke:kit-update` suite, which has no "commits ahead" assertion.

### Change

1. Add an exported pure function in `packages/extensions/src/kit-update/index.ts`:

   ```ts
   export interface TrunkAheadState { channel: string; ahead: number }
   export function trunkNotice(state: TrunkAheadState): string | null
   ```

   Returns `null` when `ahead <= 0` or `channel` is empty, else exactly
   `trunk is ${ahead} commit${ahead === 1 ? "" : "s"} ahead — /update channel ${channel}`.
   The wording is fixed and uses the real channel the install follows; the notice never itself
   names a channel that `/update channel` rejects.

2. Compute the gap in `checkForUpdates` for a git install: after `ls-remote` gives the branch head,
   run the injected `git` as `["-C", kit.root, "rev-list", "--count", `HEAD..${main}`]` (best
   effort, same `git` seam as the rest). Store the parsed non-negative integer on the report as
   `kit.trunkAhead`; leave it absent when git fails or returns no number, so the notice is silent
   when offline or in sync. For the `local` kind leave `trunkAhead` unset (no channel; the existing
   `/update kit` path already covers it).

3. Surface it:
   - `session_start`: notify `trunkNotice(...)` **before** the `if (!hasUpdates(report)) return;`
     early return, so a trunk gap shows even when the release channel is otherwise current. Keep
     the existing background `void check(cwd).then(...).catch(() => {})` shape so start-up never
     blocks on the check or its timeout.
   - `formatReport`: append the notice as its own line when present, so `/update status` and the
     non-UI `/update` output print it; the interactive bare `/update` (no argument, UI mode) also
     notifies it before its selector.
   Do not change `summaryLine` (its single-line "up to date" contract is tested).

4. `tests/update-notice-smoke.ts` (`smoke:update-notice`, added to `package.json` scripts as the
   allowed exact new smoke script):
   - pure function: `{channel:"trunk", ahead:19}` → `trunk is 19 commits ahead — /update channel trunk`;
     `{channel:"next", ahead:1}` → singular; `ahead:0` and empty channel → `null`;
   - integration with the existing fake git: a `latest` install whose `main` is N ahead yields
     `report.kit.trunkAhead === N` and a non-null `trunkNotice`; an in-sync install yields no gap
     and a null notice; an unreachable remote (`reachable:false`) yields no gap and the check still
     returns offline;
   - start-up: with a fake git whose promise never resolves, the `session_start` handler resolves
     promptly and records no notice; with a gap report it notifies exactly the one notice line.

5. Docs: `docs/updates.md` (one paragraph: the notice, when it appears, that it is silent offline
   or in sync), `packages/extensions/src/kit-update/README.md`. Run `node packages/core/reference.ts --check`
   (no command/extension metadata change is intended).

### Deviation from the board wording

The board's example action is `/update channel trunk`, but `trunk` is not an accepted channel:
`packages/core/lib/distribution.ts:124` (`/^(latest|next|X.Y.Z)$/`) and `kit-update`'s
`isChannelName` (`:1035`) both reject it. The channel that follows the trunk (`main`) is `next`.
The notice therefore names the install's real channel; the pure function still names whatever
channel the state carries, so a repo whose branch is `trunk` would read `/update channel trunk`.
Adding `trunk` as a channel alias is proposed separately, not done here.

## Checks that prove it

- `npm run smoke:update-notice` (new) — the acceptance test.
- `npm run smoke:kit-update` — no regression in `/update` behaviour, channels and plumbing.
- `npm run test:typecheck` and `npm run test:lint` — strict TypeScript.
- `node packages/core/reference.ts --check` and `npm run smoke:docs` — docs/metadata coherence.
- Do **not** run `npm test` or `npm run check:all`; the host gate runs the full suite.

## Not this cycle

- **V-73** re-land: its ~33k-character diff would cross the 30k stop-taking threshold after PG-12.
- Settings → Display back navigation, overlay mouse forwarding, idle-cat blink, human-console
  multi-card focus theft, web-console shared-runtime smoke, `withOverlayFrame` dim leak — carried
  proposals, none blocking PG-12.

## Proposal to file

`autonomy/proposals/luna-ux-01-07-trunk-channel-alias.md` — make `trunk` an accepted alias of the
`next` channel so the board's exact `/update channel trunk` wording becomes valid, or none if the
team prefers `next` only.
