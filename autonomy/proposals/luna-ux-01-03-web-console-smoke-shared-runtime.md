# Proposal — `smoke:web-console` mutates the checkout and is not runner-safe

- Run: `luna-ux-01`, cycle 03. Stream: `ux` (found while investigating the cycle-02 acceptance
  failure; outside this stream's area, so recorded, not fixed).

## Finding

`tests/web-console-smoke.ts` names the real checkout as its runtime directory:

- `tests/web-console-smoke.ts:95` `pidPath = path.join(webUiRoot, ".runtime", "server.pid")`
- `tests/web-console-smoke.ts:139-140` `console.token` and `server.log` under the same
  repo-relative `packages/web-ui/.runtime`.

It starts a detached server whose token file is created with `flag: "wx"` (exclusive create). Two
concurrent instances therefore race on the same path.

Evidence: running four copies of `npm run smoke:web-console` in parallel each fails with

```text
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /web UI started/. Input:
'console: the web UI server exited while starting (code 2).\nLog tail:\n… pi-console: refusing to start: PI_CONSOLE_TOKEN_FILE could not be read (ENOENT).'
    at run (file:///work/tests/web-console-smoke.ts:129:12)
```

A single run passes (`web-console smoke: OK`), including from a clean worktree of the cycle-02
branch tip.

## Why it matters

`packages/core/check-all.ts:70-76` already lists `smoke:web-console` in `SERIAL` precisely because it
"writes the repo-relative `packages/web-ui/.runtime` and starts a server whose token file is
exclusive-create". That saves `npm run check:all`, but any other runner that re-runs the smoke — for
example a per-check contract entry such as `check-all:smoke:web-console` — can launch it beside the
aggregate run and lose the same race. The cycle-02 acceptance report went red with exactly
`check-all` and `check-all:smoke:web-console` exit 1, while the smoke passes standalone; the shared
runtime path is the only shared resource the smoke uses.

## Suggested change (owner's call)

Sandbox the smoke the way `tests/web-ui-rpc-smoke.ts:267` and `tests/web-ui-test-harness.ts:235`
already do: set `PI_CONSOLE_RUNTIME_DIR` to a temp directory instead of resolving
`packages/web-ui/.runtime`, and keep the detached server's pid/token/log there. That removes the
shared path, lets the smoke run under any concurrency, and leaves `SERIAL` free to cover only the
genuinely heavyweight checks. No product code changes.

This is a test-reliability fix in another stream's area; the `ux` stream cycle 03 does not take it.
