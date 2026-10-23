# SOURCE

- Written from scratch for this kit (no upstream pi example exists for custom compaction).
- Date: 2026-06-17
- Purpose: none at present. The extension is a **no-op**: it does not change compaction. On
  `session_start`, when `PI_KIT_COMPACT_TEMPLATE` is set, it warns that template injection is
  unsupported by the current Pi compaction API and points to `/compact <instructions>`; it never
  reads the template file.
- Hook: `session_before_compact` returns `undefined`, so Pi runs its native, goal-agnostic
  summarization with the full prepared input and the operator's `customInstructions`
  (`tests/compaction-continuity-smoke.ts`).
- Superseded: at T3+ the `context-sieve` extension is the single authority for
  model-visible system-prompt assembly and injection; neither extension replaces pi's
  native compaction summarization, and `custom-compaction` is only shipped in the T1
  `balanced` profile (`tests/docs-smoke.ts`).
