# SOURCE

- Upstream: `pi-caveman` — `git:github.com/jonjonrankin/pi-caveman` (`extensions/caveman.ts`), MIT.
  Concept in turn based on [caveman](https://github.com/JuliusBrussee/caveman) by Julius Brussee.
- Date: 2026-07-03
- Changes (reimplementation, not a verbatim port):
  - Upstream injects its compression directive by returning `{ systemPrompt }` from
    `before_agent_start`. That is **forbidden** in this kit — `packages/core/verify.ts` lint 5b reserves
    system-prompt assembly to `extensions/context-sieve`. Rewritten to instead write a
    `.pi/ctx-contributions/sessions/<session-id>/caveman.json` contribution (the flat
    `.pi/ctx-contributions/caveman.json` when pi exposes no session id) that context-sieve assembles
    under budget.
  - Removed the animated TUI campfire status bar and all `@earendil-works/pi-tui` usage
    (self-contained: `node:fs`/`node:path`/`node:os` only).
  - Dropped the `wenyan` (Classical Chinese) intensity families; kept `lite`/`full`/`ultra`/`micro`.
  - Added **session-flip detail suppression**: invoking a report/doc skill or prompt turns caveman
    off for the rest of the session (`detailTriggers`, configurable).
  - Added an **always-on content guard** to the injected directive: it applies only to
    conversational/explanatory prose and must never compress file contents, code, reports, findings,
    or documents — even during coding sessions.
  - Config file preserved at `~/.pi/agent/caveman.json` (`defaultLevel`, `detailTriggers`).
  - `/caveman` command preserved (toggle / level / on / off / status).
  - 2026-09-24: contribution file moved to the per-session directory (B-005); non-string
    `detailTriggers` entries in the config are ignored.
  - The config file is read as unknown and checked: one that is not a JSON object, or a
    `defaultLevel` that is not a known level, falls back to the defaults (nothing pins this).
