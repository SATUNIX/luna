# Cycle 01 — Verify (run luna-guard-01, stream `guard`)

Base `5f2fad2a7bb8`. Every command below was run on the pushed worktree after the last code
commit (`8f6078b`). No `npm test` or `npm run check:all` was run.

## Targeted checks

- `node tests/firewall-shell-smoke.ts` — **PASS** — `[firewall-shell-smoke] OK`. The new F-12
  allow cases fail on the pre-fix classifier (exit 1, `strictEqual` on the nested null-extra
  case) and pass with the fix.
- `node tests/firewall-gate-smoke.ts` — **PASS** — `[firewall-gate-smoke] all 19 checks passed`.
- `node tests/firewall-unattended-smoke.ts` — **PASS** — `[firewall-unattended-smoke] all 16 checks passed`.
- `node tests/tool-firewall-smoke.ts` — **PASS** — `[test:security firewall-benign-corpus] OK
  (40 commands, 3 handlers)` then `[test:security tool-firewall] OK`.
- `node tests/secret-guard-smoke.ts` — **PASS** — `[test:security secret-guard] OK`. The new
  `cat config/credentials/db.txt` block case fails with the exact-segment check removed
  (`AssertionError: should block: read below a credentials directory`) and passes with it.
- `node tests/protected-paths-corpus-smoke.ts` — **PASS** — `[protected-paths-corpus-smoke] OK`
  (the corpus also loads the `vendor/protected-paths` handler).
- `npm run test:typecheck` — **PASS** — exit 0 across all workspace tsconfigs.
- `npm run test:lint` — **PASS** — exit 0 with `--max-warnings 0`.

## Diff and review

- Reviewable diff at the last code commit: 21468 characters excluding lockfile and the cycle/run
  record directories (limit 30000; at most 60000 is read).
- No `package.json` change; no control path changed.
- Independent reviewer for F-12 (commit `615f198`) returned `VERDICT: PASS`, including a re-run
  of `firewall-shell-smoke` and `tool-firewall-smoke`.
- PG-23 did not get a second independent reviewer in this session: the effort contract
  (`3/3` child invocations at E3) was exhausted by the F-12 workflow and the PG-23 implementer.
  The host's merge review is the independent review for that diff. `report.md` records this.

## Remaining work (not failures)

- Register the corpus as its own `package.json` script: proposal
  `luna-guard-01-01-register-benign-corpus-script.md` (control path, not editable this cycle).
- `rg "secret-guard" … | head` still blocks: proposal
  `luna-guard-01-01-quoted-search-token-command-scan.md`.
- `glob` has no adapter shape: proposal `luna-guard-01-01-glob-adapter-coverage.md`.
