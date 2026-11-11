# Proposal — the idle cat blink frame is dead code

- Run: `luna-ux-01`, cycle 01. Status: **deferred**, not implemented (see cycle 01 `review.md`,
  "Checked and set aside").
- Surface: status bar / cat animation (`packages/extensions/third_party/custom-footer`).

## Finding

`cat.ts:36` gives the `idle` state a five-frame animation whose index 4 is the sleepy face
`=^-.-^=`, and `tests/cat-status-smoke.ts:95` asserts "idle blinks to the sleepy face". But the
renderer never advances idle frames: `catView` (`index.ts:387-391`) computes
`since = result && TRANSIENT.has(state) ? result.at : now`, and `idle` is not in `TRANSIENT`, so
`renderCat("idle", now - now)` is always called with elapsed 0 and only frame 0 (`=^o.o^=`) can
ever render.

Evidence: `renderCat("idle", 0) === "=^o.o^="`, `renderCat("idle", 1050) === "=^o.o^="`,
`renderCat("idle", 4200) === "=^-.-^="` — but the third call is the direct table path, which no
runtime caller reaches. The docs already describe this as future work: `docs/status-bar-and-costs.md`
lists "a blinking or looking-around idle cat" under *Not covered*, and says the resting face does
not blink.

## Why it was not taken in cycle 01

The two sides contradict each other and the operator's intent is ambiguous: commit `3a245e6`
added the blink frames on purpose and commit `a858801` updated the smoke to claim idle blinks,
while the docs and the renderer say it does not. Fixing it means either (a) driving an idle blink
timer (a behaviour change with a render loop and a power cost, and a doc change), or (b) deleting
the dead frame and the test assertion (a documented capability the operator added). Both are
larger than the cycle's budget and neither is clearly the intended one.

## Suggested resolution

Decide the intent first. If the idle blink is wanted, drive it from the existing ticker once
`/footer cat` is on and update `docs/status-bar-and-costs.md` to move it out of *Not covered*.
If not, remove the blink frame from `ANIMATIONS.idle` and change the smoke to assert a stable
frame. Either way the table, the smoke and the doc must agree.
