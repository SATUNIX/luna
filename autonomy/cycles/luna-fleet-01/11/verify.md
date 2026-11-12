# Cycle 11 verification — luna-fleet-01

## Targeted checks

- `node tests/eval-footprint-smoke.ts` — PASS (13/13, exit 0): "the new file records the measurement exactly" now compares `profiles.lite.toolText` by parsed equality; the stale-literal base failure is gone.
- `node tests/autonomy-cli-smoke.ts` — PASS (16/16, exit 0): fleet row carries numeric step/spend/budget and the blocker; text renders `step`, `spent $X of $Y`, `BLOCKED (question)`; a hostile `state.json` narrows extras and collapses a multi-line question.
- `node tests/autonomy-command-smoke.ts` — PASS (12/12, exit 0): exact fleet footer, empty-fleet clear, headless untouched, truncation and control-character collapse.
- `npm run smoke:docs` — PASS (14 documented commands, 62 links, 97 pages, exit 0), including the restored README paragraph and the added unusable-status sentence.
- `npm run test:typecheck` — PASS (all tsconfig projects, exit 0).
- `npx eslint --max-warnings 0` on the six changed TS files — PASS (exit 0).
- Reviewable diff `2c6b0737a66c..HEAD` excluding lockfile and cycle/run records — 22,003 chars before the docs-only commit; well under the 60,000 review cap.

Not run (per cycle rule): `npm test`, `npm run check:all`; the host gate runs them on a clean checkout.

## Independent review

A reviewer subagent that did not write the change read `git diff 2c6b0737a66c..HEAD`, the cycle
plan/review and `autonomy/CHARTER.md`, re-ran all five targeted checks, and returned **PASS**.
It confirmed both rejected defects are fixed: the README paragraph now contains the exact
`autonomy: 3 runs — 1 running, 1 blocked, 1 succeeded; blocked: <run> (<question>)` format with no
dangling prose, and the eval assertion can no longer accept `75960` for `7596`.

It raised three non-blocking warnings:

1. Duplicated `oneLine` in `store.ts:148` and the extension `index.ts:191` — accepted in the plan:
   the extension is deliberately self-contained (imports only pi and node builtins).
2. `docs/autonomy.md` omitted the unusable-status clearing condition — fixed in `8f37da4`.
3. `String(field(r, "run"))` could render `undefined` for a malformed blocked row — left as a
   warning; a real `listRuns` row always carries a run id, and the footer already clears on an
   unusable status. Recorded for a later cleanup.

## Scope check

- No changes to `autonomy/CHARTER.md`, `autonomy/BACKLOG.md`, any `package.json` `scripts`, the
  lockfile or the reviewed footprint baseline.
- O-01 is recorded as **progress**, not done: the four remaining surfaces and the walkthrough are
  still open.
