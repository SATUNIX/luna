# memory-vault: a failed first-prompt recall may lose the recap for the session (not fixed)

Cycle-28 review finding. Code location: `packages/extensions/src/memory-vault/index.ts:140`
(`if (isUserPrompt) firstPrompt = false;`), inside the `try` opened at `:131`.

## Finding

The assignment sits before the throwing work that turns a first prompt into a recap/pinned block:
`searchMemories` (`:146`), the `assemble` loop (`:172-179`) and `formatHits` (`:184`). The intent
(comment `:122-124`) is that the flag is consumed by a completed first-prompt recall. If anything
after `:140` throws, the `catch` at `:186-188` returns `undefined` but `firstPrompt` is already
`false`, so the earlier-session recap and pinned block are never offered again that session.

## Why it was NOT fixed this cycle (reachability + testability)

- Reachability is narrow. Every file read in the recall path is already guarded: `loadIndex`
  (`vault.ts:418-462`) catches open/read/parse failures, `searchMemories` catches the note read
  (`vault.ts:578-582`), and `recentRecaps` catches `readdir` (`vault.ts:673-676`). The remaining
  throwable work is pure string/token math, so no realistic vault state makes the try body throw
  after `:140`.
- The obvious seam (a directory where `Recaps/<date>.md` is expected, making `recentRecaps`
  `readFileSync` throw `EISDIR`) throws at `:135`, **before** `:140`, so the flag is not consumed
  even on the base: a test using it passes on the base and does not pin the fix. The cycle's
  implementer and reviewer selected this seam; it was rejected on inspection.
- The project rule is that a behaviour claim names the test that pins it. The one-line move is
  harmless but cannot be pinned with the current harness, so it was left out rather than landed
  unverified.

## Proposed fix and test seam

Either (a) add a small fault-injection seam to the extension's `deps` (for example an optional
`recallHook`/`now`-style function used only in tests, mirroring the existing `complete`/`now`
deps) so a test can throw after `:140` and assert the second prompt still emits the recap; or
(b) restructure the handler so the flag is consumed only on the success exits (`before the
`if (!final) return undefined;` at `:180` and before the `return { message... }` at `:185`),
accepting that no test can currently distinguish it. Prefer (a): the fix is only worth landing
with a test that fails on the base.
