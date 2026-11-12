# Proposal — memory-vault recall over-fetch reads snippets it discards

Status: proposed. Author: cycle 31, run `luna-core-01`, stream `core`.

## Finding

`packages/extensions/src/memory-vault/index.ts:163` calls `searchMemories` with
`limit: cfg.recallLimit + injected.size + pinnedLines.length` so the `chosen` filter at `:164` can
drop already-injected notes and still leave `recallLimit` hits. `searchMemories`
(`packages/extensions/src/memory-vault/vault.ts:573-584`) slices to that limit and then
`readFileSync`s a snippet for **every** candidate before the caller filters. With N already-injected
memories, every prompt reads and parses N extra note files whose bodies are discarded.

## Proposed change

Add an optional `exclude?: ReadonlySet<string>` to `searchMemories`; skip scoring/snippet reads for
excluded `rel`s before the slice, so the over-fetch limit can drop to `recallLimit + pinnedLines`.
Output is unchanged; it removes N file reads per prompt. Pin with a smoke assertion on the number of
note reads (or an excluded-rel test) in `tests/memory-vault-smoke.ts`. Deferred this cycle because it
touches the search signature and ranking order, a wider change than the flag fix.
