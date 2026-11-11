# Cycle 03 plan — `luna-ops-01` (stream ops)

Mode: **fix**. The base fails an acceptance check (`smoke:docs`), and the assigned A-01 item is not
satisfied on it. A-91 is already merged and needs verification only.

## Item A-01 (P0) — fix the red gate and complete the journal check

Justification: charter priority 0 (a failing acceptance check on the pushed head) and assigned board
item A-01, whose acceptance is "exactly one line per `autonomy/cycles/**/report.md` on the branch".

Change:
1. Add the missing journal line for the core stream's merged cycle
   `- luna-core-01/01 | Board: none | successful | <summary>` to `autonomy/JOURNAL.md`. Its report
   has no `Board:` lines, so `none` is the value the checker derives.
2. Harden `checkJournal` (packages/core/lib/journal.ts): an entry whose cycle directory exists but
   has no `report.md` is a failure (`journal entry has no report: <key>`), closing the reverse drift
   recorded in `autonomy/proposals/luna-ops-01-02-journal-orphan-entry.md`. The host close-out
   exception is unaffected (a close-out report is still a report file).
3. Add a `tests/docs-smoke.ts` fixture: an entry next to a directory with no `report.md` must be
   reported. Existing fixtures (missing entry, dangling decision, board mismatch, legacy layout,
   close-out warning) stay.
4. Record the decision in `autonomy/decisions/luna-ops-01-03-team-journal.md` (`Board: A-01`) and
   link it from this cycle's journal line.

Checks that prove it: `npm run smoke:docs` (real tree plus the new fixture; fails before the entry
is added, passes after), `node packages/core/check-all.ts --check-wiring`, `npm run test:typecheck`,
`npm run test:lint`. A negative run (delete the `luna-core-01/01` line) must fail with that key
named.

Sequencing: the `luna-ops-01/03` journal line and this cycle's `report.md` land in the same final
commit, so the hardened orphan check never sees a reportless entry on the branch.

## Item A-91 (P0, verify only)

Already merged in cycle 02 (`bd90afe`, `13e608f`). No code change. Prove it with
`npm run smoke:autonomy` and `npm run smoke:eval-footprint`, which load the long-horizon profile and
assert every `HARNESS_COMMANDS` name is registered and that `subagents` is absent.

## Deliverables

`review.md`, `plan.md`, `verify.md`, `report.md`, the journal entry/decision file, and the
`checkJournal` hardening with its fixture. No `package.json` script changes; no command added to the
kit; no dependency changes.

## Explicitly not in this cycle

- New proposal for the cross-stream merge/journal process gap (recorded in `review.md`).
- B-011, `npmDeliveryEnabled` docs, installer doc drift: stale or unevidenced (see `review.md`).
