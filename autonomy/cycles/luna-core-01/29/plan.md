# Cycle 29 plan — luna-core-01

Goal: unblock publication by making the leak scan honest about its own product identifiers (DE-96,
P0) and make the brand smoke safe and deterministic (DE-97, P1). Mode: **fix**. Base `ddf7084`.

Order: DE-96 first (it is the P0 and the publication freeze), then DE-97. One logical change per
commit; each commit message names finding, root cause, fix and the proving check.

## Item A — DE-96: context-aware leak scan

Justification: charter §"What counts as an improvement" 1 and the board DE-96 acceptance; evidence
in `review.md`.

Change (all in `packages/core/lib/leak-scan.ts`, `packages/core/prepush-scan.ts`):

1. Split the case-sensitive alternation: keep `BLOCKED_CASE` for macOS home paths and `SR-` ids;
   move `\b[RPMD]-\d{1,2}\b` to its own `ROADMAP_ID` regex.
2. Add `blockedMatches(line, options?: { allowRoadmapIds?: boolean })` (default strict, so the
   export and existing callers are unchanged). When `allowRoadmapIds` is false, drop a roadmap-id
   match whose match index is immediately preceded by `--answer\s+` — the product's documented
   inbox card-id example (a).
3. Make the home-path classes ignore the conventional placeholder usernames `user` and `username`
   (b): `/home/<placeholder>` and `/Users/<placeholder>`/`<drive>:\Users\<placeholder>` no longer
   match, while a real username still does.
4. `prepush-scan.ts`: scan the commit identity/message with `allowRoadmapIds: true` (d); scan an
   added line with `allowRoadmapIds` true when the file is under `autonomy/cycles/`,
   `autonomy/proposals/` or `autonomy/runs/` (c), false otherwise. Every other class stays strict.
5. Update the `leak-scan.ts` header and `docs/security-standard.md` (Suppressions) to state the
   two documented exceptions.

Checks: `npm run smoke:prepush-scan`, extended in `tests/prepush-scan-smoke.ts`:
- runtime-built fixtures (comment says why: the test file is itself scanned) for (a) `--answer`
  card id, (b) `<home>/user/...` placeholder and the real `<home>/<name>` still refused, and the bare
  legacy id in product prose still refused;
- an end-to-end push case: a run record under `autonomy/cycles/` citing a legacy id passes (c);
- an end-to-end push case: a commit subject citing a legacy id passes (d);
- an end-to-end refusal: the same id in `docs/` prose still fails.
Falsify: revert the `--answer`/placeholder handling and the `prepush-scan.ts` context and the new
cases fail.

## Item B — DE-97: safe, deterministic brand smoke

Justification: charter 1/4 and the cycle-22 review finding; evidence in `review.md`.

Change (`tests/brand-smoke.ts` only):

1. `isTextFile` returns false for a dotenv name (`.env`, `.env.*`, …) except the documented
   template `.env.example`; the set is also filtered by the same rule.
2. The failure message becomes `file:line` with no text.
3. Replace the raw filesystem walk with `brandFiles(root)`: list tracked files with
   `git -C <root> ls-files -z` (explicit allowlist), fall back to the fixed-skip filesystem walk
   only when `root` is not a git worktree; apply `SKIP_DIRS`/`SKIP_NAMES`/`SKIP_FILES` and
   `isTextFile` on top. Factor the scan into `scanBrand(root) => { scanned, problems }` so the
   smoke can exercise a temporary tree.

Checks: `npm run smoke:brand`, extended with two temporary git-repo cases:
- a tracked populated `.env` is not scanned and no problem line contains its value, while a
  tracked `.env.example` is scanned and a `pi-system` finding is reported as `file:line` only;
- the file set is identical before and after an untracked ignored file exists.
Keep `scanned.length > 100` and the `packages/core/install.ts` / `capability.yaml` scope
assertions. Falsify: restore `isTextFile` accepting `.env`, the text in the message, or the raw
walk; the new cases fail.

## Records

`review.md`, `plan.md`, `verify.md`, `report.md` under this directory; HANDOFF updated; no
`autonomy/BACKLOG.md` edit; out-of-stream problems go to `autonomy/proposals/`.
