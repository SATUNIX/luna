# Cycle review — luna-core-01 / 01

Base commit: `dc71c739409e` (head of `stream/core`, includes all merged `luna-improve-01` cycles).
Steward board: no assigned items. Stream areas: rebrand, memory recall, discoverability, agent
efficacy, token efficiency, defects (V-10, V-11, V-07, V-08).

## What was checked (with commands)

- Whole-repo check inventory: `node packages/core/check-all.ts --list` (229 scripts).
- Green baseline on the touched surfaces:
  `smoke:docs` PASS, `smoke:capability-matrix` PASS, `smoke:extensions-catalogue` PASS,
  `smoke:command-menu` PASS (11/11), `smoke:memory-recall` PASS (7/7),
  `smoke:memory-vault` PASS (11/11), `smoke:compress` PASS (8/8),
  `smoke:context-budget` PASS (12/12). No red baseline.
- Defect-id lookup for the assigned IDs (`grep -rn "V-07\|V-10\|V-11\|V-08"` over `docs/`,
  `autonomy/`): no matching finding list exists in-tree, so the IDs are not actionable from the
  repository; recorded here as a carry-over, not worked.
- Compress budget probe (large `previousSummary`, 10–500 turns): summary stays ≤ budget
  (4000 → 3840 max). No token-budget bug there.
- Memory-vault `loadConfig`, `digestTurn`, `parseRecap`, `isTrivial`: reviewed; input validation is
  sound (env/file/defaults, non-finite rejected). No evidenced defect found.
- `docs/reference.md` completeness: reference is generated from each extension's `extension.json`
  `env[]` (`packages/core/reference.ts` header). So any code-read env var missing from a manifest
  is invisible in the reference.

## Deviations treated as non-issues

- `.github/CODEOWNERS:43` names `/packages/core/gitlab-release.ts`, which does not exist. Not
  fixed: `.github/` is outside the stream's area and a `.github/` edit is avoided by this run's
  convention (prior cycle reports state "no `.github/`"). Carry-over only.
- `docs/releasing.md` release examples use older versions (`0.2.4-beta.4`, `0.3.0-beta.1`), current
  package version is `0.3.0-beta.2`. Cosmetic example drift; not fixed (low value, and it re-drifts
  every release).
- Env manifests drift broadly (17 code-read `PI_KIT_*` vars are undeclared in their manifests);
  `tests/extension-manifest-hooks-smoke.ts:122` documents that a general bidirectional check is not
  feasible. Only the one user-facing var below is fixed.

## Items selected

### Item 1 (defect, agent efficacy — eval harness false green)
`packages/core/eval/run.ts:24` read the category filter as
`args[args.indexOf("--category") + 1] ?? null`:
- `node packages/core/eval/run.ts --category` (no value) → `?? null` → filter `null` → runs ALL 17
  fixtures and exits **0**. This is the false green: a malformed invocation is indistinguishable
  from a full pass. Independently reproduced by the reviewer against `dc71c739409e`.
- `--category securty` (typo) already selected zero fixtures and exited **1** (the pre-change file
  had a zero-fixture guard printing "no fixtures ran — check --category filter"), but with no
  indication that the category name itself was unknown.
Fix: validate the value against the categories present in `fixtures`; on missing value, unknown
category, or an empty selection, print a usage line to stderr and exit 2 (the unknown-category
message is new; the missing-value false green is removed).

### Item 2 (discoverability — user-facing env var absent from the reference)
`packages/extensions/src/context-sieve/index.ts:298` reads
`process.env.PI_KIT_CTX_MESSAGE_BUDGET_TOKENS`, and
`docs/architecture/memory-compaction-context.md:43` documents it as a user setting, but
`packages/extensions/src/context-sieve/extension.json` declares
`"env": ["PI_KIT_CTX_BUDGET_TOKENS"]` only. `docs/reference.md:469` is generated from that manifest,
so the message-budget var is missing from the single reference page a user reads.
Fix: add the var to the manifest, regenerate `docs/reference.md`, and pin context-sieve in the
existing `ENV_ALLOWLIST` of `tests/extension-manifest-hooks-smoke.ts:125` so it cannot drift again.

## Mode

Fix mode for both items (each is a demonstrated, fixable misbehaviour with a proving check).
