# Cycle 05 — Verification (run luna-ops-01, stream `ops`)

Base `4da2716e9c9f`, head at verification `72c5af7`. Targeted checks only; `npm test` and
`npm run check:all` were left to the host gate.

Plan for the full changed path set
(`node packages/core/check-all.ts --for-changed="$(git diff --name-only 4da2716e9c9f..HEAD | tr '\n' ',')"`):
7 run checks (`docs:check`, `smoke:docs`, `smoke:redaction-corpus`, `smoke:workflow-policy`,
`test:lint`, `test:typecheck`, `verify`). Every one was run and passed.

| Check | Status | Evidence |
|---|---|---|
| `npm run -s smoke:redaction-corpus` x20 under load | RAN, PASS | 20/20 passed with four CPU burners busy; check 5 (fake clock) and check 4 both green each run |
| `npm run -s smoke:redaction-corpus` | RAN, PASS | 6/6 checks; check 5 rejects the quadratic probe and accepts linear and 10x-slower probes without reading the real clock |
| `npm run -s smoke:workflow-policy` | RAN, PASS | 5 checks, 31 mutations caught, including missing pi-compat `--shard`, shard-count disagreement and missing shard axis |
| `npm run -s test:typecheck` | RAN, PASS | exit 0 on `39c2e6c`, `f7c7031` and `72c5af7` |
| `npm run -s test:lint` | RAN, PASS | exit 0 on the same heads |
| `npm run -s smoke:docs` | RAN, PASS | 14 commands, 62 links, 97 pages; no record/journal error |
| `npm run -s docs:check` | RAN, PASS | nav entries and internal links resolve |
| `npm run -s verify` | RAN, PASS | "All checks passed" (extension/profile/manifest validation) |
| `npm run -s smoke:pi-host-peers` | RAN, PASS | 4/4; both pi-compat lanes still install every host peer at the lane's version |
| `npm run -s smoke:release-workflow` | RAN, PASS | 11/11; pinned images and release paths unchanged |
| `npm run -s smoke:firewall-gate` | RAN, PASS | 20/20 (independent reviewer); `tests/firewall-gate-smoke.ts` is unchanged by this cycle |
| CI matrix expansion | RAN, PASS | static parse of `ci.yml`: `pi` x `shard` = 8 lanes, both `pi` values `advisory: false`, shards 1..4, `--shard=<i>/4` |
| DE-106 PR wall-time acceptance | SKIPPED | no GitHub runs available offline; median of three PR runs under 12 min is not measurable in this checkout |
| Independent whole-diff review | RAN, PASS | reviewer subagent PASS on `39c2e6c` and `f7c7031`; its comment/mutation warnings were fixed in `72c5af7` |

## Notes

- DE-105's acceptance (20 consecutive runs under parallel load) is covered by the 20/20 run above,
  with four busy cores standing in for CI's parallel checks.
- DE-106 is proven at the workflow-policy and matrix level. The runtime target depends on GitHub
  runners and cannot be reproduced locally; the host's PR runs are the remaining measurement.
- The reviewer confirmed `check:all` shards are disjoint and complete (skip before sharding,
  round-robin after) and that `ci-complete` still needs `pi-compat`.
