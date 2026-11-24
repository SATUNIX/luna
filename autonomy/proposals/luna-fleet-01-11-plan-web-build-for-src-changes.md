# Plan `smoke:web-build` for a change under `packages/web-ui/src/`

Cycle 11, stream `fleet` (fleet control plane: PG-08, O-01). Proposal, not a change: the file
involved decides which checks a diff must run, which this charter treats as gate policy the
operator owns.

## Evidence

`packages/web-ui/src/**` is TypeScript that is compiled into **committed** browser bundles
(`packages/web-ui/public/js/*.js`, `mobile/js/*.js`, `mobile/dev/*.js`) by
`node packages/web-ui/build-web.ts`, and `smoke:web-build` is the check that fails when a committed
bundle is stale (`build-web.ts --check`).

`packages/core/lib/check-map.ts` has no rule for `packages/web-ui/**`. So a diff that touches only
`packages/web-ui/src/public/js/autonomy.ts` plans just the always-checks:

```
$ node packages/core/check-all.ts --for-changed="packages/web-ui/src/public/js/autonomy.ts"
check-all: run: test:lint
check-all: run: test:typecheck
check-all: run: verify
```

`smoke:web-build` is planned only when the *generated* `public/js/*.js` is itself in the diff
(it is a `package.json` script target, added by `scriptTargets`). A worker that follows the derived
plan exactly therefore never runs the one check that catches a forgotten `npm run build:web`.

This is not hypothetical: cycle 10 of this run (`origin/attempts/luna-fleet-01/cycle-10`, commit
`3f7e5074`) edited `packages/web-ui/src/public/js/{autonomy,wire}.ts` without regenerating
`public/js/autonomy.js`. Its note records the derived plan as `smoke:web-ui-client, test:lint,
test:typecheck, verify` — all green — while the host gate went red on `check-all:smoke:web-build`
and `check-all:smoke:web-ui-client` (the client smoke imports the committed `.js`, so it ran the
old bundle). Cycle 11 repaired it by regenerating the bundle (`28468828`).

## Proposed change

One row in `CHANGED_PATH_CHECKS` (`packages/core/lib/check-map.ts`):

```ts
{ glob: "packages/web-ui/src/**", checks: ["smoke:web-build", "smoke:web-ui-client"] },
```

and, for the server half of the same surface, so a route change plans the suites that exercise it:

```ts
{ glob: "packages/web-ui/server/**", checks: ["smoke:web-ui-api", "smoke:web-ui-security", "smoke:web-ui-server"] },
```

The second row is a separate gap observed the same way: `--for-changed=packages/web-ui/server/autonomy.ts`
today plans no route test at all, so a change to `GET /api/autonomy` is not implied to run
`smoke:web-ui-api` (its documented shape and skips) or `smoke:web-ui-security` (token refusal, 405).

## Cost

Two extra checks for a web-ui source change. `smoke:web-build` is a `tsc` emit into a temp dir
(seconds); `smoke:web-ui-client` is the existing offline ui smoke; the three server smokes start a
local server on a loopback port and are already in the suite. `tests/autonomy-selfimprove-smoke.ts`
(`check-map: a changed-path diff implies the host gate's checks`) is where the expectation belongs.

## Why it is not in this cycle

`packages/core/lib/check-map.ts` decides which checks a change must pass, i.e. gate policy. The
stream charter and the cycle prompt both reserve that for the operator, so it is proposed here
rather than changed.
