# Cycle 01 — Plan (run luna-guard-01, stream `guard`)

Base `5f2fad2a7bb8`. Mode: **fix** (F-12) plus the PG-23 measurement and the minimal
secret-guard precision fix its corpus proves.

## Item F-12 — ignore null/undefined adapter keys

**Justification.** Charter priority 2 (board item rank 1) and 4 (reproduced defect): a benign
DeepSeek edit shape (`{"replace": {...}, "replace_2": null}`) is rated high
`incomplete_adapter`, `needsOperator` is true, and the agent stalls on an approval card (24 s and
121 s in the steward session). The live install carries a hot patch, evidence that production is
already paying for the fix.

**Change.**
- `packages/extensions/src/tool-firewall/classify.ts` `coveredEdit`: count only entries whose
  value is not null/undefined; require at least one real entry; keep the existing checks for
  two real operations, unknown operations, oldText/newText plus null extras.
- `adapterCovered`: when scanning top-level fields, ignore a null/undefined key **only if it is
  not a known shape field**; a known field with `null` stays a type mismatch (high).
- `tests/firewall-shell-smoke.ts`, coverage section ~626-655: five cases exactly as the board
  states (one real operation plus null extra key -> low; two real operations -> high; unknown
  operation -> high; entry with only a null key -> high; explicit null operation value -> high),
  plus the top-level null-extra-key case the fix also covers.
- `docs/security.md:47-51`: say that a null/undefined-valued *unknown* key carries no operation,
  while known fields and non-null unknown fields stay incomplete; name `tests/firewall-shell-smoke.ts`.

**Checks.** `node tests/firewall-shell-smoke.ts` (fails at base on the new low cases, passes
after), `node tests/tool-firewall-smoke.ts`, `npm run test:typecheck`, `npm run test:lint`.
No other classify rule changes.

## Item PG-23 — benign-command corpus (40 commands)

**Justification.** Board item PG-23; baseline 40/333 manager calls refused or failed (12 %), split
secret-guard 16, other_error 10, edit-tool 6, protected-paths 4. The corpus is the measurement
PG-26 needs and pins guard precision. Building it exposed one concrete false-positive class in the
shipped handlers: transfer-verb shell reads of `packages/extensions/src/secret-guard/*` are
blocked because the broad write-side `/secret/i` pattern matches the directory name.

**Change.**
- New helper `tests/firewall-benign-corpus.ts` with 40 real commands and the reason each is
  benign (the three named commands, git/ls/find/rg/grep/sed/cat reads, the repo's own
  `npm run smoke:*`/`test:typecheck` commands, `node packages/core/check-all.ts --list`, reads of
  `secret-guard` source). It loads `extensions/tool-firewall`, `extensions/secret-guard` and
  `vendor/protected-paths`, sends each command through the `tool_call` handler and asserts every
  handler allows it (headless: the strict, no-operator verdict). It is invoked from the already
  wired `tests/tool-firewall-smoke.ts`.
- `tests/secret-guard-smoke.ts`: two-sided cases for the transfer-verb fix. Allowed reads of
  ordinary source under a `secret`-named directory (`cat`, `head`, `sed`); still blocked:
  `cat .env`, `cp secrets.yaml /tmp`, `base64 ~/.ssh/id_rsa`, `tar czf /tmp/x .env`, and the
  protected-path exfil cases already covered there.
- `packages/extensions/src/secret-guard/index.ts`: make the command-scan secret match
  basename-aware (`SECRET_PATH_PATTERNS` against a path token's basename plus the existing read
  path patterns on the whole token), instead of matching the broad pattern against the whole
  command line. Protected-path matching is unchanged. No pattern list is removed or loosened.
- `autonomy/proposals/luna-guard-01-01-*.md`: ask the operator to register the standalone
  `firewall-benign-corpus-smoke.ts` script (this cycle may not edit `package.json` scripts), and
  propose the `glob` adapter gap.

**Checks.** `node tests/tool-firewall-smoke.ts` (corpus, fails at base on the transfer-verb rows,
passes after), `node tests/secret-guard-smoke.ts` (two-sided), `npm run test:typecheck`,
`npm run test:lint`. No `package.json` change.

## Out of scope, recorded as proposals

- `glob` adapter missing from `classify.ts` `shapes` (every glob call high) — next cycle.
- Standalone corpus script registration (control path).
- Quoted search-pattern tokens in transfer-verb pipelines (`rg "secret-guard" … | head`) are still
  treated as paths; needs a token-role rule, proposed rather than guessed.

## Goal

Fix F-12 end to end and land the PG-23 corpus with the false positive it proves, both tested and
documented, with no true positive weakened and no control path changed.
