Outcome: partial
Mode: fix

**Why these tests changed.** `tests/firewall-shell-smoke.ts` gains the five F-12 board cases plus
top-level null-extra and known-field-null cases; each was shown to fail on the pre-fix classifier.
`tests/secret-guard-smoke.ts` gains two-sided cases: secret-guard source reads and the
`config/credentials` block fail/pass on opposite sides of the fix, and the existing exfil cases
still block. No test was loosened.

Board: F-12 done - null/undefined-valued extra adapter keys no longer make an edit incomplete, while two real operations, unknown operations, null-only entries, explicit null values and known fields with null stay HIGH.
Board: PG-23 progress - the 40-command benign corpus now runs in the gate via tool-firewall-smoke, and the transfer-verb false positive on `secret-guard` source is fixed; standalone script registration remains an operator/control-path proposal.

Item: F-12 ignore null/undefined adapter keys - 615f198 - `node tests/firewall-shell-smoke.ts` (new allow cases fail on the pre-fix classifier) and `node tests/tool-firewall-smoke.ts`.
Item: PG-23 benign-command corpus and secret-guard transfer-verb precision - 9829eac, 8f6078b - `node tests/tool-firewall-smoke.ts` (40 commands, 3 handlers, all allowed) and `node tests/secret-guard-smoke.ts` (two-sided, including `cat config/credentials/db.txt` still blocked).

**What is left and why.**
- PG-23's acceptance names a standalone `tests/firewall-benign-corpus-smoke.ts` registered in
  `package.json`. The cycle prompt refuses a merge when `package.json` `scripts` change, so the
  corpus ships as `tests/firewall-benign-corpus.ts` invoked by the already-wired
  `tests/tool-firewall-smoke.ts`. Proposal `luna-guard-01-01-register-benign-corpus-script.md`.
- `rg -n "secret-guard" … | head -3` still blocks: a quoted search pattern is tokenised as a
  path. Proposal `luna-guard-01-01-quoted-search-token-command-scan.md`.
- `glob` is still absent from the adapter `shapes` table and every call is `incomplete_adapter`
  HIGH. Proposal `luna-guard-01-01-glob-adapter-coverage.md`.
- The F-12 diff was independently reviewed (PASS). PG-23's diff did not get a second reviewer:
  the E3 child budget (3/3) was used by the F-12 workflow and the PG-23 implementer. Host merge
  review is the independent check for PG-23. This is a process gap, not a known code failure.

**For the next cycle.** The guarded false-positive class is now pinned from both sides. Continue
with the corpus registration proposal if the operator accepts it, then the quoted-search token
role and the `glob` adapter gap. The exact-segment rule (`secret`, `secrets`, `credentials`) is
deliberately narrow; do not widen it back to substring matching, which is what blocked
`packages/extensions/src/secret-guard/` in the first place.
