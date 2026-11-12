# Cycle 01 report — luna-fleet-01 (stream `fleet`)

Outcome: partial
Mode: improve

Board: O-01 progress - Exposed the tested owner inbox through `/autonomy inbox` (list, answer, waiting runs), so a pi user can read and answer owner cards without leaving pi; PG-06/PG-07/PG-08/PG-09's full surface and the walkthrough remain.

Item: O-01/PG-09 owner inbox from pi - ee2860b,e85aef2,923f4f0,47c8558 - `node tests/autonomy-command-smoke.ts` (14 checks)

## What changed and why

The CLI's owner inbox (`pi-autonomy inbox`, `packages/autonomy/cli.ts:684-740`) was complete and
pinned by `tests/autonomy-inbox-smoke.ts`, but the pi extension could not reach it: no `inbox`
branch, USAGE line, completion or test, so `/autonomy inbox` answered `unknown command`. O-01
requires working from pi without a Claude session, so an owner holding a card had to leave pi.

`ee2860b` adds the `inbox` case: no argument runs the fleet waiting view, a validated run id runs
`inbox --run <id>` with `--file` (resolved with the existing helper), `--answer` and `--value`
passed through to the existing `run()` helper; it also updates USAGE, the description,
completions, the extension README, `docs/autonomy.md` and the generated `docs/reference.md`.
The command is record-only (the CLI writes `control/inbox.json` and the board, never run state),
so it needs no confirmation gate, matching `steer`.

`e85aef2` fixes a real follow-up defect: the first version forwarded `--value` as two arguments,
and the CLI rejects a space-separated value starting with `--` (`--value needs a value`), so
"Keep the --local branch" could not be answered; it now sends one `--value=<text>` argument, with
a pinned `--force it` case.

## Tests and justification for the changed test

The inbox block in `tests/autonomy-command-smoke.ts` is purely additive: no existing assertion was
changed or removed. It pins the fleet argv, the run argv, the equals-form literal answer with shell
metacharacters, `--file` resolution against the working directory, rejection of an unknown flag and
of malformed run ids before any process starts, a refused (exit 3) result at error level, and that
`help` now lists `inbox`. Run against a clean `af7ad8915d5c` tree, the same file fails at `findCall`.
One temporary `workflow_run` reviewer FAIL asked for the `--file` test and a more accurate docs
citation; `923f4f0` added both, and a second independent reviewer returned PASS. Its docs warning
(settlement applies to a run's cards, not the fleet view) was fixed in `47c8558`.

## Left and next

- **O-01 remainder**: PG-06 host event log, PG-07 live `/autonomy` widget, PG-08 web console panel,
  the rest of PG-09 (creating cards from pi; today `--file` writes them) and the recorded
  non-Claude walkthrough. O-01 stays **progress**.
- **A-92 dispatch template**: still absent from `packages/autonomy/lib/templates/`; the work waits
  on `origin/attempts/luna-fleet-01/cycle-09` (`fbd20c6`..`56d9503`, 56k reviewable diff) and needs
  its own cycle and re-verification with `node tests/autonomy-dispatch-smoke.ts`.
- Carry-overs unchanged: re-adopt an already-assigned dispatch item on resume; replace the fixed
  300 ms lock-contention window; cycle-03 PG-42 work on its attempts branch; the
  `luna-fleet-01-04-autonomy-control-ids.md` proposal; cycle-11's `oneLine` duplication and
  malformed-row `undefined` warnings.
- The commit `47c8558` message lost two backticked words to shell expansion during commit; its
  diff is the docs-only settlement scoping described above.

## Checks

All seven derived checks ran and passed (`docs:check`, `smoke:autonomy-command`,
`smoke:autonomy-inbox`, `smoke:docs`, `smoke:new-extension`, `test:lint`, `test:typecheck`,
`verify`); details in `verify.md`. Reviewable diff 11,338 chars.
