# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/trigger-compact.ts`
- Date: 2026-06-17
- Changes:
  - 2026-09-15: The upstream `COMPACT_THRESHOLD_TOKENS` constant was hardcoded at 100k, which
    fires auto-compaction far too early on large-context-window models (e.g. a 1.3M window).
    Made the threshold configurable: `PI_KIT_COMPACT_THRESHOLD_TOKENS` env var (managed-install
    override, highest precedence), a new `/compact-threshold [amount|reset]` command that
    persists to `<agent dir>/pi-kit/trigger-compact.json`, falling back to the original 100k
    default when neither is set. `/trigger-compact` (manual, immediate compaction) is unchanged.
  - 2026-09-30: Rebuilt against pi 0.85.1's real semantics. `ctx.compact()` is
    `AgentSession.compact()`, which aborts the running agent first and never resumes it, while pi's
    own threshold compaction (`contextWindow - reserveTokens`) runs inside the run and continues it.
    So: (1) never call `ctx.compact()` in a one-shot child (`PI_KIT_INTERNAL_CHILD=1`, print/json
    mode) - the aborted child ended with no final message; (2) stand down when pi's own trigger is at
    or below ours or fires on the same turn (no double compaction); (3) mid-run compactions resume the
    interrupted run once, a final turn waits for `agent_settled`, and an operator interrupt
    suppresses the trigger; (4) level trigger with re-arming replaces the edge trigger, so a resumed
    session already above the threshold fires once and a threshold that compaction cannot get under
    cannot loop; (5) unknown usage (no window, `tokens: null` after a compaction) is never read as 0;
    (6) `compaction.enabled`/`reserveTokens` are read with pi's precedence and trust rules.
  - 2026-10-15: typed for strict TypeScript (no behaviour change).
  - The settings file is read as unknown; its `compaction` block is used only when it is a plain
    object, as before, without a cast (nothing pins this).
