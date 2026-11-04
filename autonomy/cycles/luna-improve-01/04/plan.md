# Cycle 04 plan — luna-improve-01

- Mode: fix
- Base: `a385401`
- Goal: land cycle 02's two evidenced fixes on `pi/luna-improve-01`, prove each with its own
  smoke test, record the cycle and end on budget (operator steering).

## Items

### Item 1 — web console reports the real package version (charter priority 3)

- Change: drop the hard-coded `VERSION = "0.1.0"` in `packages/web-ui/server/routes.ts` and
  `packages/web-ui/server/configinfo.ts`; both call `kitVersion()` from `./remote-version.ts`.
- Test: extend `tests/web-ui-api-smoke.ts` to assert `/api/health` and `configInfo().app.version`
  equal the root `package.json` version and are not `0.1.0`.
- Docs: cycle records only; user-visible behaviour is the API value (already documented).
- Proven by: `npm run smoke:web-ui-api`.

### Item 2 — detached supervisor writes each log line once (charter priority 3)

- Change: add `fsutil.stdoutIsFile(path)`; add `defaultEngineLog(store, rt)` in
  `packages/autonomy/lib/engine.ts` that keeps `RunStore.log` as the single writer and echoes to
  `rt.log` only when stdout is not the log file.
- Test: extend `tests/autonomy-cli-smoke.ts` to spawn a child with stdout redirected to the log,
  call `defaultEngineLog` once, and assert the line appears exactly once.
- Proven by: `npm run smoke:autonomy-cli`.

## Checks

- `npm run smoke:autonomy-cli`
- `npm run smoke:web-ui-api`

The full `npm run check:all` is deliberately **not** run here: the operator states the host gate
runs it on the pushed head, and waiting on it is what made cycle 2 time out.
