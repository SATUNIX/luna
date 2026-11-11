# Run luna-guard-01 — handoff

## State after cycle 01 (branch `pi/luna-guard-01`)

- F-12 fixed in `packages/extensions/src/tool-firewall/classify.ts`: null/undefined-valued extra
  adapter keys are ignored; the five board cases and the top-level cases are in
  `tests/firewall-shell-smoke.ts`. Commit `615f198`.
- PG-23 corpus landed as `tests/firewall-benign-corpus.ts` (40 commands, each with a reason),
  loaded through tool-firewall, secret-guard and protected-paths and invoked by
  `tests/tool-firewall-smoke.ts`. Commit `9829eac`.
- secret-guard shell scan is token/basename aware; exact `secret`/`secrets`/`credentials` path
  segments still block. Commits `9829eac`, `8f6078b`. Tests:
  `tests/secret-guard-smoke.ts` (two-sided).
- All targeted checks pass: firewall-shell, firewall-gate, firewall-unattended, tool-firewall,
  secret-guard, protected-paths-corpus, typecheck, lint. No `package.json` change.

## Open / next

1. Proposal `autonomy/proposals/luna-guard-01-01-register-benign-corpus-script.md`: register a
   standalone corpus smoke (control path, operator).
2. Proposal `luna-guard-01-01-quoted-search-token-command-scan.md`: `rg "secret-guard" … | head`
   is still blocked; needs token-role parsing.
3. Proposal `luna-guard-01-01-glob-adapter-coverage.md`: `glob` has no adapter shape and is
   always HIGH incomplete_adapter.
4. Cycle 01 was recorded `partial` only because PG-23's standalone script registration is a
   control path; the corpus and false-positive fix themselves are merged-ready. PG-23's diff did
   not get a second subagent review (E3 child budget exhausted); host merge review covered it.
