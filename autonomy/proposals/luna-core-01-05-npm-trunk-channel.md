# Proposal: keep `trunk` git-only and finish the channel enumerations

Source: cycle 05 (`luna-core-01/05`) review, deferred because the reviewable diff had already
passed the 30,000 stop-new-items mark. Not a defect on the live path.

## 1. `trunk` is a git concept; npm delivery should reject it

`isChannel` (`packages/core/lib/distribution.ts:130`) and `isChannelName`
(`packages/extensions/src/kit-update/index.ts:1049`) accept `trunk` for every delivery. With
npm delivery explicitly enabled (`--mode npm`, `PI_KIT_DELIVERY=npm`, and
`npm.enabled: true` in `packages/core/distribution.json`), `--channel trunk` resolves through
`npmKitSource` (`packages/core/install.ts:272`) to `npm:@satunix/pi-system@trunk`, a dist-tag
that does not exist. The same fallthrough is in `planChannelSwitchSteps`
(`packages/extensions/src/kit-update/index.ts:1075`), and the npm pinned note advertises
`latest|next|trunk` (`:624`).

Today the path is unreachable in practice: `npmDeliveryEnabled()` is false in the shipped
distribution, so `--mode npm` is refused before the channel is used. It becomes a real defect
the day npm delivery is turned on.

Suggested fix: accept `trunk` only when the effective delivery is `git`. Reject it in
`npmKitSource` and in `planChannelSwitchSteps` with a note that `trunk` is a git channel, keep
the npm pinned note to `latest|next`, and add a case to `tests/kit-update-channel-smoke.ts`
asserting npm + `trunk` is refused. (The installer could still use `trunk` when migrating
*from* npm *to* git, which goes through `gitKitSource`.)

## 2. Finish the conceptual channel enumerations

The command grammars and most docs name `trunk`, but four prose enumerations still list only
`latest`/`next`: `docs/index.md:40`, `docs/architecture/profiles-and-install.md:252`,
`docs/repository-topology.md:24-25`, `docs/migration.md:7`. Either add `trunk` as the opt-in
canary channel or state that the list is release channels only. No gate depends on them.
