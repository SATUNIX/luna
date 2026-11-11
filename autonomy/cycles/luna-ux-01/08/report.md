# Cycle 08 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: fix

Board: V-73 done - every pure alias description now starts `Alias of /<target>` and the command contract rejects an alias whose target is not a registered command, prompt template or built-in.
Board: PG-12 done - already merged in cycle 07; re-verified on this base, no change needed.

Item: V-73 one wording for pure aliases, enforced - `be6c1bb` (cherry-pick of reviewed cycle-05 `384dcf4`+`00ff7c8`, plus a prompt-template fixture and a slice-boundary comment) - `npm run smoke:command-contract` (12); `git grep -n 'Alias for' packages/extensions/src` empty; `npm run catalog` no diff.
Item: `withOverlayFrame` dim leak (HANDOFF carry-over, not a board item) - `f546953` - `npm run smoke:control-center` (30), new case (f) fails without the try/catch; `npm run smoke:workflow-panel` (14).
Item: PG-12 trunk-ahead notice (board, already merged) - no code commit - `npm run smoke:update-notice` (7).

## What changed and why

**V-73.** The board's one assigned item still missing. Aliases used three spellings
(`tool-firewall` appended `(alias of /firewall …)`, `web-console` said `Alias for /console`), and
the command contract never read a description, so a renamed alias target would leave a forwarding
description pointing at nothing. The reviewed cycle-05 fix was re-landed: the three descriptions
now start `Alias of /<target>`, and `packages/core/lib/command-contract.ts` gains an
`alias-target-missing` rule fed by a separate `aliasDeclarationsInSource` helper (comments
stripped, slice stopped at `handler:`/`getArgumentCompletions:`; `registeredCommandsInSource` and
`HARNESS_COMMANDS` unchanged). `docs/reference.md` is regenerated.

**Overlay dim leak.** `overlay-frame.ts` installed the transcript dim patch then called
`const inner = build(finish)` unguarded: a throwing `build` returned no component to `dispose`, so
`compositeOverlays` stayed patched and every later transcript line stayed dim. Both hand copies
(control-center and the byte-identical `third_party/subagent` vendor copy) now restore the patch
once and rethrow, pinned by control-center-smoke case (f).

## Left over and notes for the next cycle

- PG-12 was already done in cycle 07 (the board still lists it). Its one deviation stands: the
  notice names `next`, not the board's `trunk`, because `trunk` is not a valid channel; the alias
  change is proposed in `autonomy/proposals/luna-ux-01-07-trunk-channel-alias.md`.
- Carried over and still not taken: back navigation from Display (page stack), overlay mouse
  forwarding, idle-cat blink intent (needs an operator decision), `smoke:web-console` shared
  runtime. All have proposals.
- `aliasDeclarationsInSource` truncates at `handler:`/`getArgumentCompletions:`, so a description
  placed after the handler would not be checked; documented and accepted (all current
  registrations put `description` first).
- Process: the first `workflow_run` implementer staged the V-73 cherry-pick but did not commit
  (the cycle-06 failure mode again); its own reviewer returned FAIL on that and the host gate
  mis-matched the verdict; the second workflow implementer returned no output. The change was
  then finished directly and a fresh reviewer passed the final head. Prefer checking
  `git status`/remote head after any implementer step.
- Full diff is 23,155 characters excluding the lockfile and records; no control path touched.
