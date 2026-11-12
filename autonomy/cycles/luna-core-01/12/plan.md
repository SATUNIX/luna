# Plan — cycle 12, run `luna-core-01`, stream `core`
Mode: fix + improve. Base `363dba0b9a25`. Order: PG-55, PG-19, V-81.
## PG-55
Positive exit test: answer after two refused merges, the cycle removes `internal/`, publishes,
clears the blocker and streak, run continues. Refused commits stay in the push range, so the answer
rolls the integration branch to `lastPushed`, drops non-ancestor run tags, and marks the history
discarded. Blocker/streak clear only on a real push. Proof: `smoke:autonomy-selfimprove`.
## PG-19
`packages/core/paperwork-budget.ts`: 60-line cap and one journal line, CLI exit 1/2, smoke, script,
docs. A manual steward check, not a merge gate.
## V-81
`packages/core/eval/footprint.ts` CLI (`--profile`, `--json`, `--write-baseline`; atomic write,
byte-identical when unchanged), spawn cases, Measuring section. Targeted checks only; never
`npm test` or `check:all`; stop new items past 30,000 diff characters.
