# Proposal — human-console can open concurrent cards (focus theft)

- Run: `luna-ux-01`, cycle 01. Status: **open**, not implemented.
- Surface: TUI overlays / input owner (V-02 focus theft),
  `packages/extensions/src/human-console/index.ts`.

## Finding

`processPending` fires one `void processOne(...)` per pending file in a single synchronous loop
(`index.ts:474-479`):

```ts
for (const name of names) {
  const file = path.join(dir, name);
  if (processing.has(file)) continue;
  processing.add(file);
  void processOne(ctx, file).catch(() => { /* never let a pending-file race crash the host */ });
}
```

`processOne` checks the registry **once** and then opens the card directly
(`index.ts:438-448`):

```ts
const holder = inputHeld();
if (holder) { noteHeld(ctx, id, request, holder); return; }
...
if (request.kind === "approval") result = await answerApproval(ctx, request, ...);
else { const asked = await answerQuestion(ctx, request, ...); ... }
```

`answerApproval`/`answerQuestion` call `ctx.ui.select` / `ctx.ui.confirm` (`index.ts:187`, `:223`,
`:236`). Crucially, the human console never *takes* a hold of its own: nothing in `processOne`
calls `holdInput`/`withInputHold`, and it does not use `showWhenFree`. So while one card is open,
`inputHeld()` still reports free, and the next pending file in the same scan opens a second
`ctx.ui.select` on top of the first. pi's `select` pushes a dialog and calls `tui.setFocus()`, so
the second card steals the keyboard from the first; the operator's keystrokes can answer the wrong
request. `processing` only dedupes the *same* file, not concurrent cards.

The input-owner contract (`docs/security.md`, `shared/input-owner.ts:1-22`) says every prompt an
agent can raise must hold input while it is open; the firewall, `ask_human` and the two kit
overlays do (`showWhenFree` / `withInputHold`). The human console is the exception.

This is the same weakness the refuted `input-hold-race` proposal pointed at, but the real gap is
not a TOCTOU between the check and the call: it is that a console card never registers a hold, so
sibling requests are not serialized at all.

## Why it was not taken in cycle 01

The stream's fix set was the two confirmed custom-footer defects, then the curated `/` menu
(reverted). This is concurrency between requesters in a separate extension and needs its own
regression test in the overlay-queue smoke. Cycle budget stayed on the smaller, finished changes.

## Suggested resolution

- Wrap the console's card in a hold — `withInputHold("human-console", () => answerApproval(...))`
  or `showWhenFree` — so a card blocks sibling cards and other overlays, and releases on
  `session_shutdown` through `releaseInputHolds`.
- Keep one card at a time explicitly: `processPending` should note that a card is open (a module
  flag set for the duration of the hold) and leave sibling files for a later 1 Hz poll, so a burst
  of requests does not open a stack of dialogs.
- Add a case to `tests/firewall-overlay-queue-smoke.ts` (or a human-console smoke) that queues two
  pending files, answers the first, and asserts the second was not shown until the first closed.
