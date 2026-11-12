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

## State after cycle 03 (branch `pi/luna-guard-01`, HEAD `a54463f`)

- Priority-0 gate repaired: `packages/extensions/src/secret-guard/extension.json` now declares
  `node:crypto`, matching the generated `shared/refusal-record.ts` import that cycle 02 added
  without updating the manifest. `smoke:extension-manifest-hooks` exits 0. Commit `52ca07c`.
- PG-24 carry-over landed: one structured `tool_refused` record per refusal from tool-firewall and
  secret-guard (guard, cause, matched token/rule, command digest, session id; never command text),
  best-effort append with rotation past 4 MiB. Commits `1b216ca`, `08ceb2d`, `87e50a8`,
  `0d1a677`, `ae85343`.
- Secret-content evidence gap closed: `tests/firewall-refusal-record.ts` now pins a
  `cause: "secret-content"` refusal whose `matched` is the pattern label and whose record contains
  neither the fake secret value nor the payload. Commit `7df2593`.
- Independent reviewer verdict PASS. Diff vs base `e52f4362f991`: 58,006 characters excluding
  lockfile and cycle/run records (review limit 60,000).

## Open / next

1. Proposal `autonomy/proposals/luna-guard-01-02-register-refusal-record-script.md`: register the
   standalone refusal suite in `package.json` (control path, operator). The acceptance spec's name
   `tests/firewall-refusal-record-smoke.ts` cannot be used until then.
2. `luna-ops/luna-metrics.py` should consume `tool_refused` records instead of scraping session
   JSONL.
3. Cycle 01 proposals stay open: quoted search token command scan, `glob` adapter coverage,
   standalone benign-corpus script registration.
