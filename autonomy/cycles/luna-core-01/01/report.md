Outcome: successful
Mode: fix

Cycle 1 of run `luna-core-01` (stream `core`). Base `dc71c739409e`. Two evidenced items fixed,
tested, documented, independently reviewed (VERDICT: PASS). Diff 7,371 chars — well inside the
review budget. No operator control path, `.github/`, `package.json` script, or charter changed.

Item: eval harness refused a missing/unknown `--category` instead of a false green - d30b7f0 - `node tests/eval-footprint-smoke.ts` (11/11; the new `--category`-with-no-value assertion fails against the pre-change `run.ts`, which ran all 17 fixtures and exited 0)
Item: context-sieve declared `PI_KIT_CTX_MESSAGE_BUDGET_TOKENS` so generated `docs/reference.md` lists it - 8b3013f - `node tests/extension-manifest-hooks-smoke.ts` ("3 pinned extensions declare the exact env vars their code reads"; the `ENV_ALLOWLIST` deepEqual fails without the manifest change)

## What and why

- `packages/core/eval/run.ts` read `--category` as `args[indexOf("--category") + 1] ?? null`, so a
  value-less flag fell through to the full fixture set and exited 0. The regression gate could report
  green while the operator believed a category ran. Now validated against the fixture categories:
  usage + exit 2 on missing/unknown/empty selection; real fixture failures stay exit 1.
- `context-sieve` reads two `PI_KIT_*` env vars but declared only one, and `docs/reference.md` is
  generated from those manifests, so `PI_KIT_CTX_MESSAGE_BUDGET_TOKENS` (documented in
  `docs/architecture/memory-compaction-context.md`) was absent from the reference. Declared it,
  regenerated the page, and pinned context-sieve in the existing targeted `ENV_ALLOWLIST`.

## Verification

Targeted checks only (never `npm test` / `npm run check:all`):
`node tests/eval-footprint-smoke.ts` PASS; `node tests/extension-manifest-hooks-smoke.ts` PASS;
`node packages/core/reference.ts --check` PASS; `npm run smoke:docs` PASS;
`npm run smoke:context-budget` PASS (12/12). See `verify.md` for commands and proving lines.

Independent `reviewer` over `git diff dc71c739409e..HEAD` (records excluded): **PASS** for both
items, merge guard satisfied. It independently reproduced the pre-change false green and corrected
one overstated sentence in `review.md` (the unknown-category case already exited 1; only the
missing-value case was the false green) — corrected in the record commit.

## Leftovers / next cycle

- `packages/core/eval/run.ts:9` header usage example still lists only
  `security|verification|orchestration` (runtime usage is now derived and correct); the new test
  asserts `status !== 0` rather than the exact `status === 2`. Both were reviewer warnings, left
  unworked to keep the reviewed diff unchanged.
- `.github/CODEOWNERS:43` names `/packages/core/gitlab-release.ts`, which does not exist. Outside the
  stream area and a `.github/` edit; not worked.
- `docs/releasing.md` release examples use older patch versions (`0.2.4-beta.4`, `0.3.0-beta.1`);
  cosmetic drift that recurs each release.
- Broad env-manifest drift: 17 code-read `PI_KIT_*` vars are undeclared in their manifests;
  `tests/extension-manifest-hooks-smoke.ts` documents that a general bidirectional check is not
  feasible. Only the one user-facing var was fixed. Candidate for a later targeted sweep.
- The assigned defect IDs V-07/V-08/V-10/V-11 have no in-tree finding list (`grep` over `docs/`,
  `autonomy/` found none), so they could not be worked. Need the operator's list.
- No proposals written this cycle.
