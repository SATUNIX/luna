# Cycle 01 — Review (run luna-ux-01, stream `ux`)

- Branch `pi/luna-ux-01`, cycle start `a43f32bae871` (head of `stream/ux`).
- Mode chosen: **improve** — the assigned board item V-05 is an evidenced capability gap; the
  steward P0 was checked first.
- Note: this path also held the records of an earlier incarnation of run `luna-ux-01/01`
  (commits `a732895`..`e7f29cc`, content preserved in git history). Those records are replaced
  here because the harness restarted this run at cycle 01 from the merged stream head; the old
  journal line is updated in the same change so `smoke:docs` stays green.

## Steward P0 — CI red on the integration candidate (checked first, priority 0)

Steward report: `ci-complete`, `pi-compat (0.85.1)` and `pi-compat (0.99.2)` fail on candidate
`d827f5063521` (integration/luna + stream/ux) after one rerun. `verify` is not listed as failing.

Evidence gathered here (no network, no old-pi tarball):

- The candidate object is not present locally (`git cat-file -t d827f5063521` → not a valid
  object) and the only remote ref is this branch (`git ls-remote /git/remote.git` shows
  `refs/heads/pi/luna-ux-01` and `refs/autonomy/reset`, both at `a43f32b`). The integration
  candidate cannot be rebuilt or diffed from this checkout.
- The check the previous cycle identified as the only failing one at the candidate,
  `smoke:docs` (journal/report consistency), **passes at this head**:
  `npm run -s smoke:docs` → `[docs-smoke] OK: 14 documented commands validated, ...` exit 0.
  `autonomy/JOURNAL.md:18` still carries `- luna-ux-01/03 | ...`.
- An older pi cannot be installed offline: the npm cache holds only
  `pi-tui-1.4.0.tgz` (`grep` of `/opt/npm-cache/_cacache/index-v5`), and every local pi tree
  (`/work`, `/opt/pi-tools`, `/opt/pi-kit`) is 1.4.0.
- Every check named as a plausible version-sensitive failure was run at this head and is green:
  `smoke:control-center`, `smoke:command-contract`, `smoke:observability-contracts`,
  `smoke:pi-host-peers`, `smoke:prompt-arguments`, `smoke:liveness-containment`,
  `smoke:command-menu`, `smoke:docs` — all exit 0.
- The compat lane runs `check:all --skip=smoke:package,test:typecheck,test:lint` on Node 22 with
  pi 0.85.1 / 0.99.2 installed over the pin (`ci.yml:116-155`); `ci-complete` only aggregates.
  So the red must be pi-version- or Node-22-sensitive, and it is not reproducible here.

Conclusion: no code change on this branch is justified by the available evidence. The candidate
predates the cycle 06 journal repair (same finding as cycle 09), or the failure lives in
`integration/luna` content this checkout cannot see. Recorded in `report.md` under the P0; a
rebuilt candidate must be used to confirm. A speculative compat edit would violate charter item 1
(no evidenced problem) and could regress the pinned lane.

## Board item V-05 — custom Luna launch screen

Hypothesis checked against the code:

- pi 1.4 exposes the API: `dist/core/extensions/types.d.ts:114-117` declares
  `setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined)`
  and `examples/extensions/custom-header.ts:49-68` is a working component. `VERSION` is exported
  from the package root (`dist/index.d.ts:2`).
- The installed `@earendil-works/pi-tui` exports `visibleWidth` and `truncateToWidth` from its
  root (`dist/index.d.ts:35`; `dist/utils.d.ts:16,84`).
- Luna does not use the API: `grep -rn "setHeader" packages tests --include=*.ts` finds only
  web-server `res.setHeader` calls, never `ctx.ui.setHeader`. At startup the terminal therefore
  shows pi's stock header — no Luna identity, no first actions, no motion. That is a real,
  demonstrated capability gap for the `ux` stream (V-05), and the docs have no launch-screen
  section (`docs/control-center.md` headings at lines 1,10,28,60,76,99,134,148,167,182,190).
- Wiring constraint confirmed: `registerCommandMenu` (`control-center/index.ts:43-64`) owns the
  only `pi.on("session_start")` handler; `fakePi` and the command-menu test store handlers in a
  `Map` (`harness.ts:323`, `command-menu-smoke.ts:100-140`), so a second registration would
  replace the first and break `smoke:command-menu`. The header call must go inside the existing
  handler, after `curated = true` and **before** the `commandMenu === "all"` return (line 52).
- `PI_KIT_INTERNAL_CHILD=1` already returns before the handler is registered
  (`control-center/index.ts:112`), so a child session never reaches the header; the extra guard
  is still asserted by the test as the prompt requires.
- `readUiFile()` (`command-menu.ts:79-89`) is the loose `pi-kit/ui.json` reader; `readHubKey()`
  (`index.ts:30-35`) returns `hubKey` or `alt+m`. `PI_KIT_ASCII === "1"` is the established ASCII
  convention (`third_party/custom-footer/render.ts:118-123`). `PI_KIT_REDUCED_MOTION` appears
  nowhere yet, so it must be declared in `extension.json` `env` and the generated
  `docs/reference.md` refreshed with `npm run catalog`.

## Other checks (nothing taken)

- Custom-footer F-1/F-2 fixes from the earlier incarnation are on the base and their regression
  tests are green in `smoke:status-bar`.
- The open proposals under `autonomy/proposals/luna-ux-01-*.md` (idle-cat blink, human-console
  focus theft, web-console shared runtime, trunk channel alias) are outside this cycle's assigned
  item and remain proposals; none blocks V-05.
- HANDOFF for run `luna-ux-01` does not exist in this checkout (`find autonomy/runs` shows only
  `luna-ops-01`); it is recreated at the end of this cycle.
