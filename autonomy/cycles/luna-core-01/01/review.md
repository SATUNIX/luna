# Cycle review — luna-core-01 / 01 (continuation)

Base commit: `d932d6f02e41` (head of `stream/core`, the cycle start). A previous attempt at this
cycle recorded two fixes (eval `--category` false green, context-sieve message-budget env var) and
those commits (`d30b7f0`, `8b3013f`, `b6d5cbc`) are already merged into this base; they are history,
not this session's diff. This session continues the cycle from that base.

Steward board: no assigned items. Stream areas: rebrand, memory recall, discoverability, agent
efficacy, token efficiency, defects (V-10, V-11, V-07, V-08).

## What was checked (with commands)

- Defect-id lookup: `grep -rn "V-07\|V-10\|V-11\|V-08"` over `docs/` and `autonomy/` found no
  in-tree finding list, so those IDs remain unactionable; carry-over.
- `.env.example` and `docs/INSTALL.md` env tables vs extension manifests, with a throwaway Node
  script that walks every `extension.json` (`packages/extensions/src`, `.../third_party`):
  - `docs/INSTALL.md` environment table rows vs the named extension's `env[]`: exactly one bad row,
    `PI_KIT_GUIDELINES_FILE` (see Item 1).
  - Vars documented in `.env.example` / `docs/INSTALL.md` but declared by no manifest (so absent
    from the generated `docs/reference.md`): `PI_KIT_LEAN_CTX`, `PI_KIT_VERIFY_PENDING_TTL_MS`,
    plus the phantom `PI_KIT_GUIDELINES_FILE` (Item 1).
  - Every var a manifest declares appears in `docs/reference.md` (no generation gap).
- Green baseline on the touched surfaces: `node packages/core/reference.ts --check` PASS,
  `npm run smoke:docs` PASS.

## Findings

### Item 1 (defect / discoverability — the documented guidelines env var is a no-op)

`docs/INSTALL.md:215` documents `PI_KIT_GUIDELINES_FILE` for the `guidelines` extension, but:

- `packages/extensions/src/guidelines/index.ts:37` reads `process.env.PI_KIT_GUIDELINES_PATH`;
- `packages/extensions/src/guidelines/extension.json:23` declares `["PI_KIT_GUIDELINES_PATH"]`;
- `packages/extensions/src/guidelines/README.md:11,20` documents `PI_KIT_GUIDELINES_PATH`.

Only INSTALL.md has the wrong name. A user who follows the install page sets a variable nothing
reads. `docs/reference.md:497` (generated) lists `PI_KIT_GUIDELINES_PATH` with empty Purpose and
no links, because `packages/core/reference.ts` fills Purpose from INSTALL.md's table and finds no
row whose name matches. Fixing the name fixes the reference row too.

### Item 2 (discoverability — documented settings absent from the interface reference)

`.env.example` documents `PI_KIT_LEAN_CTX` ("Set to 0 to disable the lean-ctx preflight warning")
and `PI_KIT_VERIFY_PENDING_TTL_MS` ("How long a verification pending marker stays valid, in ms"),
and `docs/architecture/profiles-and-install.md:353` documents `PI_KIT_LEAN_CTX`, but no extension
manifest declares either. `docs/reference.md` is generated from each manifest's `env[]`, so both
settings are missing from the page that is meant to list every environment variable an extension
reads. `PI_KIT_LEAN_CTX` is read only by `session-helpers/index.ts:535`; `PI_KIT_VERIFY_PENDING_TTL_MS`
is defined by `verify-gate/index.ts:177` (`isVerifyPendingActive`) and mirrored by
`conductor/index.ts:196` and `orchestrator/index.ts:271`.

## Mode

Fix mode for both items: each is a demonstrated docs-vs-code mismatch with a proving check.

## Out of scope (recorded, not worked)

- Broad env-manifest drift where a var is documented only in an architecture page and read by
  several extensions (e.g. `PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS`, `PI_KIT_VERDICT_MAX_AGE_MS`). A
  targeted sweep needs an ownership rule; proposal territory.
- `.github/CODEOWNERS:43` names `/packages/core/gitlab-release.ts`, which does not exist
  (outside the stream area, and a `.github/` edit).
- `docs/releasing.md` release examples use older patch versions (cosmetic; re-drifts each release).
