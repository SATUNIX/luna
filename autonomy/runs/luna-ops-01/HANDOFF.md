# Run `luna-ops-01` — handoff

State after cycle 04 (branch `pi/luna-ops-01`, base `43ace850dc29`):

- Cycle 04: **successful**, mode fix. Two things: (1) repaired the red gate — `smoke:docs` failed
  because `integration/luna` had merged in `autonomy/cycles/luna-ux-01/01/report.md` with no journal
  line; added the line (`d9143a6`). (2) board item V-41, docs-only: one new record
  `autonomy/proposals/V-04-unify-workflows.md` inventories the shipped `/workflow` / `/workflows`
  surface and every remaining caller, marks the pre-`3c4c571` design as superseded, and names the
  doc sweep as follow-up (`86a6b44`, `64edc7b`, `8a5a0de`, `e112c29`). No code changed.
- The journal-drift failure has now happened twice (`luna-core-01/01` cycle 03, `luna-ux-01/01`
  cycle 04). The in-repo `checkJournal` is correct and must not be weakened; the durable fix is in
  the merge step that brings another stream's report onto `integration/luna`, which is outside this
  repository. Do not re-add a per-merge manual line as the "solution"; consider raising the merge
  step as an operator-owned proposal only if a future cycle is asked to.
- Open follow-up from V-41: the **doc sweep** — apply the change rows in §2 of
  `autonomy/proposals/V-04-unify-workflows.md`; regenerate `docs/reference.md`/`docs/EXTENSIONS.md`
  with `npm run catalog` and `THIRD_PARTY_NOTICES.md` with `node packages/core/gen-notices.ts`, never
  by hand. The next board item should drive this, not this proposal.
- Never re-register `/subagents`: three tests pin its removal (`tests/docs-smoke.ts`,
  `tests/run-query-smoke.ts`, `tests/subagent-observability-smoke.ts`).
- Proposal-size lesson: the V-41 proposal was first written at 58 KB with pasted grep/source
  transcripts and pushed the cycle diff to 60206 bytes, over the 60000 review cap. Record findings
  and counts, not transcripts; measure `git diff … | wc -c` after every commit.
- A-01 is complete (journal detects drift both ways). Cycle 03's decisions stand.
- Open but not taken: installer doc drift (lite skill count, `--scope project` `.env` claim,
  unknown `--profile` stack trace); `npmDeliveryEnabled()` vs `docs/releasing.md`.
- Next cycle: take the top ready board item verbatim. Working tree clean and pushed; targeted checks
  pass and the independent whole-diff review returned PASS.
