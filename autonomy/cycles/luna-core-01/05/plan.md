# Plan — cycle 05, run `luna-core-01`, stream `core`

Base `266dcf6e2ef5`. Mode: **fix** (P0 gate) then **improve** (PG-10).

## Item 1 (P0 gate, not a board item) — green the merged candidate

Already committed as `4ab96f8`: add the `luna-core-01/02` line to `autonomy/JOURNAL.md`
(`Board: V-11, V-101 | successful`) and rewrite cycle 02's two board lines into the
`Board: <ID> done - ...` form the checker reads. Proof: `node tests/docs-smoke.ts` exits 0 and
`npm run smoke:redaction-corpus` exits 0. No diff outside those two files.

## Item 2 (board PG-10) — `trunk` channel for the integration branch

**Justification.** `integration/luna` is where every merged cycle lands, but `kit-update` could
only follow release tags (`latest`) or `main` (`next`), so a merged cycle needed a `main` merge
before a dogfooder's `/update` could see it. The board measured 19 commits / +658 lines unseen.
A third opt-in channel makes a merged cycle usable the same day — the largest felt effect per
line on the board (VISION focus: effectiveness).

**Change (commits `27d638b`, `2be85f8`).** Add `trunk` = head of the kit's integration branch,
canary and opt-in, never the default:

- `packages/core/distribution.json` + `lib/distribution.ts`: `git.trunkBranch`
  (`integration/luna`), schema/interface, `isChannel` accepts `trunk`,
  `channelOfGitSource` maps an exact `trunkBranch` ref to `trunk`.
- `packages/extensions/src/kit-update/index.ts`: `isChannelName` accepts `trunk`; git channel
  inference returns `trunk` for the trunk ref; `tags`/target/`planChannelSwitch` resolve it to
  the branch head; status legend names it.
- `packages/core/install.ts`: `--channel trunk` resolves to the branch ref; usage and the
  invalid-channel message name it.
- Docs: `docs/updates.md`, `docs/INSTALL.md`, `docs/getting-started.md`, `docs/reference.md`,
  `docs/architecture/profiles-and-install.md`, the kit-update README and `docs/EXTENSIONS.md`.

**Tests.** `tests/kit-update-channel-smoke.ts` (`smoke:kit-update-channel`, the allowed
`package.json` exception) reuses the offline `kit-update-smoke` harness: detection returns
`channel: "trunk"` / `pinned: false` for an `@integration/luna` ref; a trunk update/switch
plans the branch head, not a tag or `main`; the offline installer resolves `--channel trunk`;
`latest` stays the default. 6 checks.

**Checks to run (only these; never `npm test` / `npm run check:all`).**
`npm run smoke:docs`, `npm run smoke:kit-update`, `npm run smoke:kit-update-channel`,
`npm run smoke:redaction-corpus`, `npm run smoke:env-isolation`,
`npm run smoke:workflow-resume`, `npx tsc -p tests/tsconfig.json`, `npm run test:typecheck`,
`npm run test:lint`, `node packages/core/reference.ts --check`. A `reviewer` subagent that did
not write the change reviews the whole diff (`VERDICT: PASS`).

## Not this cycle (recorded in `review.md` and the handoff)

- **PG-27 (eval baseline)** — confirmed absent, but the diff is past the 30,000 stop-new-items
  mark; deferred to the next cycle.
- **`trunk` on npm delivery + prose enumerations** —
  `autonomy/proposals/luna-core-01-05-npm-trunk-channel.md`.
