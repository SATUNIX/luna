# Proposal — human-console defers on a one-shot hold check

- Run: `luna-ux-01`, cycle 01. Status: **deferred**, not implemented (see cycle 01 `review.md`,
  "Checked and set aside").
- Surface: TUI overlays / input owner (V-02 focus theft).

## Finding

`human-console/index.ts:438` (plain child request) and `:367` (run request) test `inputHeld()`
once and then call `ui.select` / `ui.confirm`. Between the check and the call another holder can
take the input hold, so a card can still steal focus from the prompt the deferred path had just
decided not to open over. The input-owner module's own contract says "Re-check after each wait"
(`shared/input-owner.ts`), and the firewall and `ask_human` paths use `showWhenFree`, which does
just that. The window is narrow (headless/hosted child requests), which is why it is not pinned.

## Why it was not taken in cycle 01

The stream's fix set was the two confirmed custom-footer defects; this is a separate extension
(`human-console`) with concurrency semantics that deserve their own test. The existing
`tests/firewall-overlay-queue-smoke.ts` covers the firewall/ask_human defers but not
human-console's bare check.

## Suggested resolution

Route the two human-console prompt paths through `showWhenFree` (or re-check `inputHeld()` after
the await and re-queue if a hold was taken), then add a case to the overlay-queue smoke that takes
a hold in the gap and asserts the prompt waits instead of opening over the holder.
