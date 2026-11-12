# memory-vault: a memory updated in-session is never re-shown

Cycle-28 review finding (recorded as a proposal; not fixed this cycle). Stream `core` covers
memory recall and token efficiency.

## Finding

`packages/extensions/src/memory-vault/index.ts:145-147` builds
`const chosen = new Set(injected);` and drops every hit whose `h.rel` is already injected;
`:184` records each shown memory by `h.rel`. `saveMemory` updates an existing note in place and
keeps the same relative path (`packages/extensions/src/memory-vault/vault.ts:494-541`, the
`action: "updated"` return carries `rel: path.relative(root, target)`).

So after a note is recalled once, a later `memory_save`/`/remember` update to that same note is
filtered out for the rest of the session, and the model keeps acting on the stale snippet it was
shown earlier. The once-per-session rule was meant to stop repeating unchanged content, not to
pin the first version.

## Proposed fix (needs a small design choice)

Track a content fingerprint (for example the note's mtime+size or a short body hash) with the
injected `rel`, and treat a hit as already injected only when the fingerprint is unchanged. A
changed note is offered again, replacing the stale one. Alternative: key `injected` on
`rel + content-hash`. Test: inject a memory on prompt 1; `saveMemory` with new body; prompt 2 in
the same session must include the new body. Update `docs/memory.md`'s once-per-session wording.
