# Cycle 32 — Review (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Base `88572f57c2ed`; branch `pi/luna-ux-01`.

## Charter and carry-over

`autonomy/CHARTER.md` is the acceptance standard: evidence, tests, docs, green checks, one
logical change per commit. The board item is DE-98 (P1): five merged ux cycles carry
user-visible changes with no `CHANGELOG.md` entry, and the pairing QR fixture was cut from 25 to
21 rows. `AGENTS.md` requires a CHANGELOG entry per user-visible change; no gate enforces it.

Cycle 31 was rejected because its reviewed diff held only `plan.md` and `review.md`. The real
work is on `origin/pi/luna-ux-01-cycle31`, not the attempts ref: commits `40913ec` (seven
Unreleased entries plus the 25-row fixture) and `cdfa1bc`/`c65624b` (its records). The attempts
branch has only the superseded `bdebd5a` record commit. This cycle therefore starts by bringing
over the sound source change and writing fresh cycle-32 records.

## Findings (evidence)

- `CHANGELOG.md` `## [Unreleased]` had no entry for any of the ux changes merged in
  `5e6b7a7b0f..88572f5`; the section jumped from pre-existing entries to `## [0.3.0-beta.2]`.
  `git show eb739d5 -- tests/tui-layout-smoke.ts` shows `const size = 21` replacing 25 while both
  addresses were lengthened.
- A scout verified all seven restored entries against the merged code: `wf-panel.ts:689-706`
  (selection by run id), `:786-831` (height budget and clamp), `run-model.ts:321-323`
  (newest first), `values.ts:305-306` and `hub.ts:187` (raw `securityEffective`),
  `custom-footer/index.ts:277-279, 301-305, 513` (todo component and effective ASCII),
  `widgets.ts:10-32, 46-50`, `render.ts:92-97, 161-170, 184, 231-232, 338-386`,
  `width.ts:37-56`, `remote-control/index.ts:2, 133-155`. All substantively accurate.
- One claim was overstated: the `/remote` bullet said the fix was pinned by
  `smoke:remote-control`, but `tests/remote-control-extension-smoke.ts:260-262` uses an ASCII
  fixture and passed before the CJK fix. Only `smoke:tui-layout` fails on the original bug. The
  bullet was corrected to name the pin honestly; `smoke:remote-control` still exercises the panel.
- The QR fixture is now `size = 25` with the long IPv4/IPv6 addresses (`tests/tui-layout-smoke.ts`),
  stricter than the original 25-row fixture and consistent with `docs/remote-control.md` ("about
  25 rows").
- The scout found no other TUI/overlay/menu/launch/animation change in the board's commit range
  missing an entry. Older pre-range ux changes and non-TUI user-visible changes are outside DE-98's
  assigned list; they are recorded here rather than folded into this cycle.

## Candidate items and precedence

1. DE-98 release record and QR fixture — board item, evidence above, small and verifiable.
2. HANDOFF carry-over: `autonomy/proposals/luna-ux-01-30-run-card-input-hold.md` (run cards never
   register an input hold). It is a real defect but outranks neither the board item nor this
   cycle's scope, and needs its own reproduction; deferred.
3. Idle-cat blink — still waiting on an intent decision; not this cycle.

No red gate, no upstream conflict. Work is fix mode: one board item plus the evidence-backed
record correction.
