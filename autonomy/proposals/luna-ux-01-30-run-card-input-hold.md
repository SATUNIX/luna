# Run approval cards are invisible to the shared input owner

Run `luna-ux-01`, cycle 30 (stream `ux`). Status: **implemented in cycle 33** (`1a34f8f`):
the console now waits out its local run-card counter in `askToResume` and `ask_human` within their
own timeout, re-checks before showing, and fails closed; run cards still take no shared hold.
Pinned by `tests/firewall-workflow-approvals-smoke.ts` case 2g and
`tests/firewall-overlay-queue-smoke.ts` case 24e.

## Finding

The non-run console card was fixed for V-02 focus theft: `packages/extensions/src/human-console/
index.ts:466-478` wraps `answerApproval`/`answerQuestion` in `withInputHold`, taken before the
first await, so a sibling pending file defers to the next 1 Hz poll.

Workflow-run approval cards take a different path and never register a hold:
`index.ts:383-402` checks `inputHeld()`, increments a local `openRunCards` counter and calls
`answerApproval` directly. `runCardHolder()` (`:306-309`) is consulted only by non-run pending
files (`:463`). The two other card paths gate only on the shared registry:

- `askToResume` (`:347-357`): `showWhenFree(... if (inputHeld()) return ...)`;
- `ask_human` (`:546-554`): same shape.

So while a run approval card is open, `inputHeld()` reports free.

## Reproduction

The broker allows two concurrent run cards (pinned by `firewall-overlay-queue-smoke.ts` case 24d).
Queue eleven distinct run approvals plus a twelfth with a different action hash so two run cards
are open; answer the eleventh. `settle()` sets `pause = true` and `askToResume` runs while the
twelfth card is still displayed. `showWhenFree` sees no holder and pushes the "Resume it?" card on
top of the open approval. An interactive `ask_human` question can do the same instead of waiting.

## Impact

The same focus theft the branch fixed for non-run cards: the newer `select` takes the keyboard,
and arrow/Enter intended for one request can answer the other. No held notice is emitted.

## Suggested fix

Make run cards visible to the shared owner: wrap each run `answerApproval` in
`withInputHold(RUN_CARD_HOLD, ...)` and admit a run card when `inputHeld()` is either free or the
same run-card label (so the broker's second card still opens); then remove `openRunCards` /
`runCardHolder`. If pinned test 24d forbids that shape, add a local wait for `openRunCards === 0`
and re-check `runCardHolder()` inside both `showWhenFree` callbacks under the same deadline.

## Evidence to pin

`tests/firewall-workflow-approvals-smoke.ts`: leave a twelfth run card open, answer the eleventh,
and assert no resume prompt is shown until the twelfth closes (fails on the current source).

## Docs

`docs/security.md` (input-owner contract) and the human-console section it describes: every card,
including grouped run approvals, holds input while it is open.
