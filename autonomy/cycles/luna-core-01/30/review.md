# Cycle 30 review — luna-core-01

Base `12a464e594e8` (head of `stream/core`, cycle 29 merged). Read `autonomy/CHARTER.md`, the
cycle-29 `report.md`/`verify.md`, `autonomy/runs/luna-core-01/HANDOFF.md`, the open proposals under
`autonomy/proposals/luna-core-01-*.md`, and `git log --oneline 12a464e..HEAD` (empty: the branch
starts at the recorded head).

## Assigned board items

The board lists **DE-96** ("leak scan refuses the product's own identifiers") and **DE-97**
("brand smoke walks dotfiles it should never read, and is not deterministic"), both marked
P0/P1. Both were implemented and merged by cycle 29; their commits are already in this cycle's
base:

- DE-96: `ee08e5f` — `packages/core/lib/leak-scan.ts` (separate `ROADMAP_ID`, `allowRoadmapIds`,
  `user`/`username` placeholder lookahead, `--answer` carve-out) and `packages/core/prepush-scan.ts`
  (commit messages and `autonomy/cycles|proposals|runs` added lines pass `allowRoadmapIds: true`).
- DE-97: `72bae06` — `tests/brand-smoke.ts` (`isDotenvName` skips every dotenv but `.env.example`,
  `file:line`-only findings, `brandFiles` from `git ls-files` with a fixed-skip fallback).

Re-verified this cycle, on this base:

- `npm run smoke:prepush-scan` — PASS, `16 checks passed`.
- `npm run smoke:brand` — PASS, `all 23 checks passed`.
- The four real reproductions are admitted:
  - `packages/container/capability/compose/compose.dev.yaml:9` holds
    `PI_KIT_PATH=<home>/user/dev/luna`, a placeholder home path; `blockedMatches` admits it while
    `<home>/alice/...` and `<home>/user.dev/...` still match (`tests/prepush-scan-smoke.ts:104-113`).
  - `docs/autonomy.md:204` documents the inbox example `--answer <id>`; the `--answer` carve-out
    admits it (`leak-scan.ts:104`).
  - a run record under `autonomy/cycles/` citing a legacy id passes, while the same id in
    `docs/` prose is refused and printed as `file:line` only (`prepush-scan-smoke.ts:240-253`).
  - a commit subject citing a legacy id passes (`prepush-scan-smoke.ts:232-238`).

Conclusion: **DE-96 done, DE-97 done**, on the base. No new code change is required to satisfy
their acceptance criteria; the publication freeze is a host/trunk operation, not agent work.
Cycle 29 chose the context-aware carve-out path (not the "identifier class stays strict, change
the record format" option); this review does not reopen that choice.

## In-stream defects found

### D1 (HANDOFF #16) — a memory updated mid-session is never re-shown

`packages/extensions/src/memory-vault/index.ts:92` keeps `const injected = new Set<string>()`
keyed only by vault-relative path. `:145-147` filters candidates with `!chosen.has(h.rel)`, so a
`rel` injected once is dropped for the rest of the session. `vault.ts:494-545` `saveMemory`
updates an existing note in place (atomic rewrite) and returns the **same** `rel`; `searchMemories`
(`vault.ts:567-585`) re-reads the fresh body from disk every turn, but the stale `rel` filter
hides it. So after a note is recalled, a `memory_save`/`/remember` update to it is invisible and
the model keeps acting on the earlier snippet until `session_start` or `session_compact` clears
the set (`index.ts:106,117`). Confirmed independently by a scout and by the existing proposal
`autonomy/proposals/luna-core-01-28-memory-vault-injected-path.md`.

Root cause: `injected` records "this note was shown", not "this note's content was shown".
Proposed fix: key `injected` by `rel` with a content fingerprint; treat a hit as already injected
only when the fingerprint is unchanged. The scout flagged that `mtime+size` can collide (same-ms,
same-size rewrite; coarse-mtime filesystems) and that a body hash is stronger; `loadIndex` already
computes `mtimeMs` per note (`vault.ts:432,449`) and `SearchHit` carries `file`, so a fingerprint
from the file is reachable. Pinned lines render title + rel only and an update keeps the title
(`vault.ts:531`), so fingerprinting pins is harmless. `injected.size` is used for the over-fetch
limit (`index.ts:146`); the map must keep one entry per rel.

### D2 — 4-character plurals never meet their singular (memory recall)

`packages/extensions/src/memory-vault/search.ts:25`: `if (t.length <= 4 || ...) return t;` runs
before the `-s` rule (whose own minimum is 4). So `stem("logs") === "logs"` while
`stem("log") === "log"`; the same for `docs`/`doc`, `cars`/`car`, `apis`/`api`. Notes and queries
share `stem()` (`tokenize`, `search.ts:44-50`), so a note saved with a 4-character plural is
invisible to the singular query, contradicting `docs/memory.md`'s claim that light stemming makes
common inflections meet. Found by a scripted scout; not fixed in cycle 27 (that cycle's reverted
variant was the different `-es`/silent-e case). This is a narrow, testable change: let the `-s`
rule (min 4) apply at length 4 (`< 4`), keeping the `ss` guard.

## Checked and not taken

- The other open proposals (skill-router session lifetime, codeql name, npm trunk channel,
  firewall-load timing, `-es`/silent-e, memory-vault first-recall flag) are unchanged: operator
  decisions, out of stream, or not pinnable with the current harness. `luna-core-01-27` is a
  refuted no-op.
- `docs/reference.md:54` links `/remember` to `control-center.md` instead of `memory.md`; this is
  generated by `packages/core/reference.ts:254` (`whereCommand` picks whichever page names the
  command most often) and the `control-center.md` lists dominate. Low value, and it is a generated
  artefact; not taken.
