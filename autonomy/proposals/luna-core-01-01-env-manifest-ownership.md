# Proposal — an ownership rule for extension environment variables

Stream: `core`. Author: cycle `luna-core-01/01`. Date: 2026-11-11.

## Problem

`docs/reference.md` is generated from each extension manifest's `env[]` list
(`packages/core/reference.ts`). A variable that is read in code but declared by no manifest is
therefore absent from the interface reference, and `docs/INSTALL.md` can document a name the code
does not read (both were real in cycle `luna-core-01/01`: `PI_KIT_GUIDELINES_FILE` was a no-op, and
`PI_KIT_LEAN_CTX` / `PI_KIT_VERIFY_PENDING_TTL_MS` were missing from the reference).

The cycle fixed those three instances and added one guard to `tests/docs-smoke.ts`: every INSTALL
environment-table row must name an existing manifest whose `env[]` declares that variable. That
guard pins the *documentation → manifest* direction only. It does not cover a variable that is read
by code and absent from both INSTALL and the manifests.

`tests/extension-manifest-hooks-smoke.ts` records that a general bidirectional check is "not
feasible": a static scan of `process.env.PI_KIT_*` cannot attribute a read to one owning extension,
because helpers, conductors and orchestrators re-read variables another extension defines.

## Evidence

A throwaway scan over `packages/extensions/src/**` and `packages/extensions/third_party/**`
(jobs in `autonomy/cycles/luna-core-01/01/review.md`) found at least
`PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS` and `PI_KIT_VERDICT_MAX_AGE_MS` read in code and declared by no
manifest, plus the two fixed here. `.env.example` is the closest thing to a complete list, but it is
not tied to the manifests.

## Suggested approach (operator decides)

1. Adopt an explicit rule: **an environment variable has exactly one owning extension** — the one
   that defines its default or parses it — and only the owner lists it in `env[]`; other readers
   refer to the owner in a comment or README.
2. Make `.env.example` the single human-maintained source, and add a check (extend
   `packages/core/reference.ts` or a new `tests/`) that fails when a `PI_KIT_*` name in
   `.env.example` is declared by no manifest, and when a manifest `env[]` name is absent from
   `.env.example`. That is a two-way list check on *declared* names, which does not need read
   attribution.
3. Sweep the existing drift once, assigning each variable to an owner, then let the check keep it
   closed.

Items 2 and 3 touch `package.json` scripts only if a new npm script is wanted; the check itself can
run from an existing test entry point. This proposal deliberately does not change the charter or
any control path.

## Why it is not in this cycle

The sweep spans many manifests and needs an ownership decision per variable; doing it here would
exceed the cycle's diff budget and mix a policy decision into a defect fix. The two user-facing
defects found were fixed and guarded.
