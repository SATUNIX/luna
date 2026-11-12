# Cycle 33 — Review (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Base `3925c17a2485`; branch `pi/luna-ux-01`.

## Charter and carry-over

`autonomy/CHARTER.md` is the acceptance standard: evidence, tests, docs, green checks, one
logical change per commit. The assigned board item is DE-98 (CHANGELOG/QR fixture). Cycle 32
already landed that work (`7cf9075`), and this cycle's review re-checked it against HEAD rather
than redoing it.

## Findings (evidence)

### DE-98 is complete at HEAD

A scout audited each of the seven `## [Unreleased]` entries against the merged code and the
fixture. `git diff 7cf9075..HEAD -- CHANGELOG.md tests/tui-layout-smoke.ts` is empty, so the
cycle-32 work is intact. Each entry matches its code: `wf-panel.ts:686-706` (selection by run
id), `:829-833` (tail clamp), `hub.ts:187`/`values.ts:306` (`securityEffective`),
`custom-footer/index.ts:277-280` (todo widget re-cut by width), `remote-control/index.ts:139,
147-153` (wrap by `visibleWidth`), `widgets.ts:48-51` plus `index.ts:513` (toolPhrase/ASCII),
`render.ts:170,231-232,350,356,384-386` (column cuts), `width.ts:39,54-55` (VS16/keycap/tab).
The pairing QR fixture is `const size = 25` at `tests/tui-layout-smoke.ts:215`, with both long
addresses. `npm run smoke:tui-layout` 4/4 and `npm run smoke:docs` pass. No missing or inaccurate
entry was found; no source change is needed for DE-98.

### Carry-over defect: run cards are invisible to two prompt paths (V-02)

`autonomy/runs/luna-ux-01/HANDOFF.md` and
`autonomy/proposals/luna-ux-01-30-run-card-input-hold.md` record an open focus-theft defect:
workflow-run approval cards deliberately do not take the shared input hold
(`packages/extensions/src/human-console/index.ts:303-309`), because the broker allows two
outstanding prompts per run. Non-run console cards consult the local `runCardHolder()`
(`index.ts:463`), but `askToResume` (`:347-358`) and `ask_human` (`:546-557`) consult only
`inputHeld()`. So while one of the broker's two run cards is still open, `inputHeld()` is free and
`showWhenFree` pushes the resume question or an `ask_human` select on top of it.

The naive fix (wrap run `answerApproval` in `withInputHold`) is wrong: it makes the second run card
abandon its slot at `index.ts:383-388` and breaks
`tests/firewall-overlay-queue-smoke.ts:877-879`, which pins two run cards open together while
`inputHeld()` stays `undefined`. The fix must keep run cards out of the shared registry and teach
the two local prompt paths to drain `runCardHolder()`.

A second scout checked the rest of the stream for new defects. The strongest was a separate
`ui.json` settings clobber in `custom-footer/index.ts:68-97` (`/footer`/`/tips` rewrite the shared
file from a six-field projection, dropping `hubKey`, `commandMenu`, `launchScreen`,
`reducedMotion`). It is a real defect, but the carry-over input-hold defect outranks it, and it is
recorded as a proposal for the steward.

## Candidate items and precedence

1. DE-98 — verified complete at HEAD; no new commit, record it done.
2. HANDOFF carry-over — run-card input hold (V-02 focus theft). Fix mode, one logical change with
   a new test in `tests/firewall-workflow-approvals-smoke.ts` and a `docs/security.md` update.
3. `ui.json` settings clobber — real but a newly found defect (priority 4); proposal written,
   deferred.

No red gate, no upstream conflict. non-record diff starts at zero.
