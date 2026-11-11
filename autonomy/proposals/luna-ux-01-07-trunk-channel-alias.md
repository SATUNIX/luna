# Proposal — make `trunk` an accepted alias of the `next` channel

Run `luna-ux-01`, cycle 07 (stream `ux`). Status: proposal, not implemented.

## Finding

The steward board item PG-12 words its one-line notice action as
`/update channel trunk`. No such channel exists. Two validators reject it:

- `packages/core/lib/distribution.ts:124` — `CHANNEL = /^(latest|next|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/`;
  `isChannel` (`:126`) is what the installer (`packages/core/install.ts:224`) and the profile
  machinery accept.
- `packages/extensions/src/kit-update/index.ts` `isChannelName` (`:1035`) — the same pattern, used
  by `planChannelSwitchSteps` (`:1053`) before it will run `/update channel <name>`.

So `/update channel trunk` prints `Unknown channel "trunk". Use latest, next, or an exact version.`
The channel that actually follows the trunk (the `main` branch, `packages/core/distribution.json`
`git.branch`) is `next`.

## Why the cycle-07 notice names `next` instead

The PG-12 notice is implemented as a pure `trunkNotice({ channel, ahead })` that renders whatever
channel the state carries. The wiring always passes `next`, the channel that follows `main`, so
whatever channel the install is on (`latest`, `next`, or a pin) the owner sees
`trunk is N commits ahead — /update channel next` — an action that actually moves the copy to the
newer commits. Naming `trunk` there would have printed a command the same extension rejects.

## Proposed change (if the team wants the board's exact wording)

Accept `trunk` as a user-facing alias of the `next` channel in both validators and everywhere a
channel string is recorded or compared:

1. `distribution.ts`: accept `trunk` in `CHANNEL`; normalise it to `next` in `gitSourceFor` /
   `channelOfGitSource` so the recorded source and the marker stay canonical.
2. `install.ts`: map `--channel trunk` to the `next` source (unpinned branch).
3. `kit-update/index.ts`: accept `trunk` in `isChannelName` and in `planChannelSwitchSteps`,
   mapping it to `next` for the installer step and for the recorded channel.
4. Docs (`docs/updates.md`, `docs/INSTALL.md`, `docs/reference.md`) and the channels tests
   (`tests/kit-update-smoke.ts`, `tests/distribution-*-smoke.ts`).

This touches `packages/core` (installer and distribution) and is therefore a `core`/ops proposal,
not a `ux` change; it is filed here because PG-12 named the wording.

## Alternative

Keep `next` as the only name for the trunk-tracking channel, and the notice as implemented. This
is the cycle-07 choice; the notice remains actionable.
