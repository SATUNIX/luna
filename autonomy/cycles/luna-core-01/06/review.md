# Review — cycle 06, run `luna-core-01`, stream `core`

Base `ce87a25c92de` (head of `stream/core`, cycle 05 merged). Reviewable diff at start: 0 chars.
Charter read in full. This stream's precedence: this cycle's prompt and the assigned board items
outrank older shared charter bookkeeping.

## Assigned board items checked against the code

- **PG-10 (trunk channel) — already done and merged in cycle 05.** `ce87a25` contains the opt-in
  `trunk` channel: `packages/extensions/src/kit-update/index.ts:139-141,475,652-661` infer `trunk`
  from an `integration/luna` ref and plan its branch head; `packages/core/install.ts` resolves
  `--channel trunk`; `tests/kit-update-channel-smoke.ts` + `smoke:kit-update-channel` exist
  (`package.json:254`). No work needed. The acceptance quoted in this cycle's prompt is already
  met by that test. A `git log --oneline ce87a25c92de..HEAD` is empty, so nothing carried over.

- **PG-27 (eval baseline) — absent, confirmed.** No `packages/core/eval/baseline.ts`, no
  `tests/eval-baseline-smoke.ts`, no `packages/core/eval/baselines/` artifact (only the unrelated
  `footprint-baseline.json`). `packages/core/eval/run.ts` runs 17 fixtures and prints a scorecard
  (`--json` gives `{total,passed,failed,results}` at `run.ts:76`) but records nothing to disk. A
  dated baseline + freshness check does not exist. This is the next board item and is startable on
  a clean diff.

## Consolidation of cycle 05 (which changed the trunk channel)

Cycle 05 was an improve cycle; this cycle starts with a fix/cleanup pass over it, after board work.
A scout verified the previously filed `autonomy/proposals/luna-core-01-05-npm-trunk-channel.md`:

1. **Live docs drift (priority 6).** Four prose channel enumerations still list only
   `latest`/`next`/pinned although `trunk` is shipped and documented elsewhere:
   `docs/index.md:40`, `docs/architecture/profiles-and-install.md:252`,
   `docs/repository-topology.md:24-25`, `docs/migration.md:7-8`. No gate pins them
   (`tests/docs-smoke.ts` does not read these enumerations).
2. **Latent npm misfire (not reachable today).** `packages/core/lib/distribution.ts:130` accepts
   `trunk` for every delivery, and `npmKitSource` (`install.ts:271-275`) would build the
   nonexistent `npm:@satunix/pi-system@trunk`; `planChannelSwitchSteps`' npm branch
   (`kit-update/index.ts:1077-1083`) and two pinned notes (`:624`, `:667`) do the same. It is
   guarded off by `npmDeliveryEnabled()` (`install.ts:214`) because `distribution.json` has no
   `npm.enabled`, so it is not a live bug — but it is an untested edge of the change cycle 05 made.

## New problems found elsewhere

None large enough to pull into this cycle. The scout's only other in-area finding was the same
npm/trunk latent path; anything else worth doing goes to
`autonomy/proposals/luna-core-01-06-<slug>.md` rather than this cycle.

## Mode

**Fix mode** for the P0 board item is not needed (no red gate). The cycle is **improve mode**
(PG-27 is an assigned board improvement) plus the consolidation pass above. Higher-priority work
(0 red gate, 1 upstream conflict) is green: the branch is at the merged head and the targeted
checks named by cycle 05 all passed.
