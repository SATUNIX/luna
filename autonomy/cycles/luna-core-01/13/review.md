# Review — cycle 13, run `luna-core-01`, stream `core`
Base `fc13571d21c7` (head of `stream/core`, holds cycles 01–12). Mode: **fix** (consolidate).
- **PG-19 done on the trunk.** `packages/core/paperwork-budget.ts` caps the four record files at 60
  lines plus one `JOURNAL.md` line (exit 1 overrun, 2 bad args); `smoke:paperwork-budget` 5/5 and
  `check:all --list` lists it. Landed at `packages/core/`, not the item's `packages/core/autonomy/`
  (no such directory); behaviour matches. Merged in cycle 12 (`d647f95`, `8a0fbe9`).
- **V-81 done on the trunk.** `node packages/core/eval/footprint.ts --profile lite --json` prints
  `chars`/`tokens` (`ceil(chars/4)`); an unknown profile exits 2 with a stderr message;
  `docs/efficiency-and-loops.md` has "Measuring the footprint"; `smoke:eval-footprint` 13/13.
  Merged in cycle 12 (`34ee17a`, `8a0fbe9`).
- **Defect found (docs drift).** `docs/capability-research-workflow.md:45-47` says context-sieve
  "wipes contributions on `session_start`" and that vendored producers "survive the wipe";
  `packages/extensions/third_party/caveman/index.ts:194` repeats "context-sieve's session_start
  wipe". The code no longer deletes: `context-sieve/index.ts:281-284` says "Never delete another
  session's contributions", and `readContributions` skips files older than `SESSION_EPOCH_NS`
  (line 128). `guidelines/index.ts:51-53` already states the epoch rule correctly, so the page and
  the caveman comment are stale.
- HANDOFF carry-overs checked: the firewall-gate timing noise (HANDOFF #1) is load-only and outside
  this stream's area, left to its proposal; dead-code line numbers in HANDOFF #9 do not reproduce.
