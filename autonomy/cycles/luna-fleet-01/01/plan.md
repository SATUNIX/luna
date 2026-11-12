# Cycle 01 plan — luna-fleet-01 (stream `fleet`)

Mode: **improve**. Board: O-01 (P0 owner visibility). Item taken: **PG-09 owner inbox from pi**.

## Item 1 — `/autonomy inbox`: read and answer owner cards from pi

**Evidence of need** (review.md, "O-01 / PG-09"): `pi-autonomy inbox` is complete and tested
(`packages/autonomy/cli.ts:684-740`, `tests/autonomy-inbox-smoke.ts`), and documented
(`docs/autonomy.md:718-756`), but `packages/extensions/src/autonomy-run/index.ts` has no `inbox`
branch, no USAGE line, no completion, and no test. An owner inside pi is told to "answer with:
`pi-autonomy inbox --run ...`" and must leave pi. O-01 requires operating from pi without a
Claude session, so this is a real, named gap (PG-09), not cosmetic.

**Change** (one logical change, in the extension):

- add `case "inbox"` to the command switch: with no argument, run `inbox` (the fleet
  "unpublished for 30+ minutes" view); with a run id, run `inbox --run <id>` and pass through
  `--file`, `--answer` and `--value`. Reuse `RUN_ID` for the run id, `resolveFile` for `--file`
  and the existing `run()` helper (text output, non-zero exit shown as an error). The CLI is
  record-only here (it never writes run state), so no confirmation dialog and no `hasUI` gate.
- add `inbox` to `USAGE` (`index.ts:118-132`), the command description and
  `getArgumentCompletions`.
- document it: `packages/extensions/src/autonomy-run/README.md` usage block and the "From inside
  pi" list in `docs/autonomy.md`; say that listing settles past-due cards (a write), name
  `tests/autonomy-command-smoke.ts` as the pin, and keep the CLI section's existing contract.

**Out of scope:** a confirm dialog that reads the card first (that read settles cards, so it
would change state before the confirmation); `--file` stays a plain pass-through with
`resolveFile`.

**Checks** (targeted only; never `npm test` or `npm run check:all`):

- `node packages/core/check-all.ts --for-changed=<changed>,` to derive the list (rerun after the
  change).
- `npm run smoke:autonomy-command` — new assertions: list argv, answer argv with one literal
  `--value` (shell metacharacters untouched), malformed run id spawns nothing, exit 3 rendered as
  an error, `help` now lists `inbox`.
- `npm run smoke:autonomy-inbox` — CLI contract unchanged.
- `npm run smoke:docs`, `npm run test:typecheck`, `npm run test:lint`.

## Task graph

One task: implement + test + document `/autonomy inbox`. Gate: an independent reviewer that did
not write it reads the diff against this plan and `autonomy/CHARTER.md` and ends PASS.

## Done when

The owner can list and answer inbox cards without a shell; the new checks fail on the base and
pass at HEAD; docs match the code; diff stays under the 30,000-char new-item stop; O-01 is
recorded as **progress** (PG-06/PG-07/PG-08 and the walkthrough remain).
