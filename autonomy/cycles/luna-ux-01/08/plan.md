# Cycle 08 — Plan (run luna-ux-01, stream `ux`)

Goal: re-land the reviewed V-73 alias-wording fix so every pure alias starts
`Alias of /<target>` and the command contract rejects an alias whose target does not exist.

## Items

### 1. V-73 — one wording for pure aliases, enforced (board, P2 ranked 6)

Why: the board item is the one assigned item not already done on the base. It is UI polish
(consistent `/` menu descriptions) plus a contract rule that would have caught the drift. Evidence
in `review.md`.

Change: cherry-pick the reviewed cycle-05 commits `384dcf4` and `00ff7c8`, which:

- change `packages/extensions/src/tool-firewall/index.ts` `firewall:reload`/`firewall:status` and
  `packages/extensions/src/web-console/index.ts` `webui` to start `Alias of /<target>`;
- add `AliasDeclaration`, `aliasDeclarationsInSource`, `firstDescriptionInSlice` and the
  `alias-target-missing` rule to `packages/core/lib/command-contract.ts`, captured from the source
  by a separate helper (not by widening `registeredCommandsInSource`);
- add fixture cases in `tests/command-contract-smoke.ts` (good target, built-in target, missing
  target, parser cases) and regenerate `docs/reference.md`.

Proof: `git grep -n 'Alias for' packages/extensions/src` empty; `npm run smoke:command-contract`
covers `alias-target-missing` with a passing and a failing fixture; `npm run catalog` leaves no
diff; `npm run smoke:firewall-approvals`, `smoke:firewall-gate`, `smoke:redaction-corpus`,
`test:typecheck`, `test:lint`, `npm run verify` pass.

## Checks budget

Only targeted smokes; never `npm test` or `npm run check:all`. V-73's code diff is 19,329
characters (measured `git diff --no-renames 384dcf4^..00ff7c8 -- . ":(exclude)package-lock.json"
":(exclude)autonomy/"`), well under the 30,000 stop-taking threshold, so one small second item
remains possible; it will only be taken if V-73 is complete, verified and pushed and budget
remains.

### 2. `withOverlayFrame` dim leak (HANDOFF carry-over, defect)

Why: `overlay-frame.ts:124` called `const inner = build(finish)` unguarded; a throwing `build`
left the transcript dim patch installed with no overlay open. A real, evidenced defensive bug in
the stream's overlay area. Taken after V-73 was complete, verified and pushed, since it fits the
remaining diff budget.

Change: wrap `build(finish)` in try/catch in both byte-identical copies; restore once and rethrow.
Add control-center-smoke case (f).

Proof: `npm run smoke:control-center`, `smoke:workflow-panel`, `test:typecheck`, `test:lint`,
`npm run verify`; the new case fails without the try/catch (the patch stays installed).

## Not taken

Back navigation, overlay mouse forwarding, idle-cat blink and the `smoke:web-console` runtime —
see `review.md` "Carried over".
