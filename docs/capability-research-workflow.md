# Capability Research & Integration Workflow

This page describes how an agent (or a human) should research, plan, and integrate new
capabilities — extensions, skills, prompts — into this kit. It is **documentation only**: there is
no runtime skill for it yet. Follow it whenever the ask is "find good pi packages / extensions and
wire the best ones in," or "improve the kit's coding capability, efficiency, or usability."

The goal is high-ROI additions that **run in the background** (auto-triggered, minimal visible tool
surface) rather than tools the operator must remember to invoke.

## 1. Survey the ecosystem

- Read the pi package gallery at <https://pi.dev/packages> and the community index at
  <https://awesome-pi.site/extensions/>.
- Pull exact metadata from the npm registry (not the web UI, which blocks scraping):

  ```sh
  curl -s https://registry.npmjs.org/<pkg>/latest \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.version,j.license,JSON.stringify(j.dependencies||{}),JSON.stringify(j.pi||{}))})"
  ```

- For each candidate capture: **license**, **runtime deps** (native/WASM binaries matter for
  vendoring vs referencing), **trigger model** (auto/hook vs manual tool), and whether it runs
  **where the agent runs** (local) or needs an external service.

## 2. Gap-analyse against what's already installed

- List current extensions (`packages/extensions/src/`, `packages/extensions/third_party/`) and their categories. Do **not** recommend a
  package that duplicates an existing one (e.g. we already have memory, subagents, MCP routing,
  compaction, safety layer).
- Only real gaps are worth ROI. Score each candidate on **ROI × background-preference**: highest
  value is a package that improves coding quality or cuts context/token cost *without* adding a
  tool the model has to call.

## 3. Respect the kit's architecture (hard constraints)

- **Injection monopoly.** Only `packages/extensions/src/context-sieve` may return `{ systemPrompt }` from
  `before_agent_start`; any local extension that wants to add to the system prompt must instead write
  a `.pi/ctx-contributions/sessions/<session-id>/<id>.json` file containing `{id, priority, budgetTokens,
  content}` (the flat `.pi/ctx-contributions/<id>.json` is the legacy fallback, used only
  when the host exposes no session id and resolved with the canonical safe-id pattern in
  `packages/extensions/src/verifier-board/todo-read.ts`). context-sieve assembles these contributions under a
  token budget, and `packages/core/verify.ts` lint 5b enforces this injection monopoly. See
  `packages/extensions/src/guidelines/index.ts` and `packages/extensions/third_party/caveman/index.ts` for the pattern.
- **Load order.** context-sieve wipes contributions on `session_start` and reads them in
  `before_agent_start`. `packages/extensions/third_party/*` loads after `packages/extensions/src/*`, so vendored producers write in
  `session_start` (survives the wipe) and adjust per-turn in `input` (which precedes
  `before_agent_start`).
- **Self-containment.** Vendored extensions may not import outside their own directory or from
  `packages/core/lib`. External npm packages live in `node_modules/` and are exempt from this lint.
- **Minimal visible surface.** Prefer behavior-only extensions (event hooks, no registered tools).
  For packages that do register agent tools, keep them dormant/filtered in the everyday `balanced`
  profile so the always-visible surface stays ~ read/write/edit/bash/grep + run/verify.

## 4. Choose an integration mode

| Mode | When | How |
|---|---|---|
| **Vendor** (`packages/extensions/third_party/<name>/`) | Small, low/zero-dep, needs local modification, or must ship inside the kit package | Copy/reimplement source, add `SOURCE.md` + `extension.json`, keep self-contained |
| **External reference** (`packages/core/sources.json`, `mode:"reference"`) | Heavier native/WASM deps, or a maintained npm pi package | Add entry with `source`, `entry`, `provides`, `profiles`; `packages/core/install.ts` installs it as an independent pi package when a selected profile includes its name |

## 5. Wire it in

1. Vendored: `packages/extensions/third_party/<name>/{SOURCE.md,extension.json,index.ts}`.
2. External: add to `packages/core/sources.json` (`provides`, `profiles`, pinned `source`, `entry`, `review`).
3. Add the extension name to the relevant `packages/kit/profiles/*.json` `include` arrays
   (including `lite` if it suits small models).

## 6. Verify (always)

```sh
npm run verify                         # schema + tsc + self-containment + injection-monopoly lint
npm run smoke:package                  # the npm tarball still has everything each profile needs
node packages/core/install.ts --profile balanced --dry-run
npm run catalog                        # regenerate docs/EXTENSIONS.md
npm run docs:build
```

Then do a live check for background behavior (e.g. confirm the contribution file appears/disappears
as expected).

---

Worked example: a pass that added `pi-lens` (real-time diagnostics), the vendored `caveman`
(conversational-output compression, scoped off for report/doc writing) and `pi-readseek`. A later
pass evaluated `pi-lean-ctx`, `pi-impact-analyzer` and newer versions of the others against their
tarballs and in a real pi terminal, and found that two should not be default (see
[Supply chain](supply-chain.md)). The reviews are recorded in `packages/core/sources.json`.
