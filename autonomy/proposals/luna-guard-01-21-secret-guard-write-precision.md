# Proposal: narrow secret-guard's write path check to real credential names

**Status:** owner/steward review needed. R3 (guard) change, so it cannot merge unattended.
**Evidence of need:** `tests/secret-guard-smoke.ts`, `src/credentials-view.ts` and
`docs/secrets.md` are ordinary repository files, yet the write tool refused them because
`isSecretPath` reused `SECRET_PATH_PATTERNS`, whose broad `/secret/` and `/credentials/`
substring forms match any path containing those words. The read side had already been
narrowed for the same reason (`SECRET_READ_*` patterns), so writes were the odd one out.

**Sound implementation already exists** on `origin/attempts/luna-guard-01/cycle-20`, commit
`0f91baae` (all checks passed except the unrelated gate checks named in that cycle's receipt;
the host refused it only because a guard path is R3). Re-verify before landing.

## Change

In `packages/extensions/src/secret-guard/index.ts`, match writes against:

- credential basenames: the canonical read names plus a plain `secret`/`secrets` file
  (`^secrets?(\.(json|ya?ml|toml|env|txt))?$`) and `credentials` variants;
- exact path segments: `/(?:^|\/)(?:secret|secrets|credentials)\//i`, `.ssh/`, and
  `.pi/agent/auth.json`.

Keep the broad substring `SECRET_PATH_PATTERNS` for the shell scan, where a path token's
basename is unambiguous, and keep the content-secret scan for every write. Both sides stay
covered by two-sided tests: real credential files and directories still block; ordinary
secret-named source, tests and docs are allowed.

Files touched by the existing commit:

- `packages/extensions/src/secret-guard/index.ts`
- `packages/extensions/src/secret-guard/README.md`
- `tests/secret-guard-smoke.ts` (two-sided corpus additions, no assertion removed)
- `docs/security.md`, `docs/future-work.md`
- `packages/core/lib/protection-coverage.ts` (profile-exemption reason text)

## Why it matters

The false positive is a guard-precision bug in the stream's own area (F-12, PG-23..PG-26):
a repository cannot write its own smoke test or a UI view module whose name mentions
credentials, and users hit the same refusal on ordinary names. It does not weaken a true
positive: real credential files, credential directories, protected paths and secret content
still block, and the tests prove both directions.

## Acceptance

- `npm run smoke:secret-guard` green, including the new allow/block corpus.
- `npm run test:typecheck`, `npm run test:lint`, `npm run verify` green.
- No shell-scan pattern or content-secret rule removed.
