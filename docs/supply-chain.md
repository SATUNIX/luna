# Supply chain

How the kit sources third-party code, what installing it pulls in, and the current `npm audit`
status. The CI checks that enforce this are listed in [CI security](ci-security.md).

## What installing the kit pulls in

The kit has **no runtime dependencies of its own**: `@earendil-works/pi-coding-agent` and
`typebox` are peer dependencies that pi itself provides, and everything else is dev-only
(`tests/clean-install-smoke.ts` installs the packed artefact and confirms there is nothing to
install).

A release is a `vX.Y.Z` tag of the public repository, created only after the full check suite
and security scans pass. pi clones it and runs `npm install --omit=dev` in the clone (as for every
git package). Because npm installs peer dependencies, that can place an extra copy of pi and
`typebox` inside the clone. The running pi never loads that copy: it resolves
`@earendil-works/pi-coding-agent` imports in extensions to itself. Everything comes from the
public npm registry at the lockfile's pinned, integrity-checked versions.

If npm delivery is switched on, every version will also carry npm provenance, so
`npm audit signatures` can verify where it was built.

## Vendored code

Twelve extensions under `packages/extensions/third_party/` adapt upstream code. Each has a
`SOURCE.md` recording its upstream, what was changed and when, and `THIRD_PARTY_NOTICES.md`
(generated from them by `node packages/core/gen-notices.ts`; `npm run verify` fails on drift)
carries the licence text and credits. The notice for pi's own example extensions is the upstream MIT
licence with its copyright holder and year.

## External sources (`packages/core/sources.json`)

External pi packages are pinned to an exact version and reviewed before enabling. They are
`reference` mode: the installer registers each one as its own pi package at the pinned version
when a selected profile includes it. None is bundled into the kit package. The review text in
`sources.json` records what each one does, and which newer versions were evaluated and why they
were not adopted.

| Package | Version | In a profile? | Native or opaque parts | Notes |
|---|---|---|---|---|
| `pi-lens` | 4.4.4 | balanced, long-horizon, autonomous, self-improving, pentest | `@ast-grep/napi` (native `.node`), `@ast-grep/cli` platform binary and tree-sitter WASM | MIT; Node >=22.19.0. Diagnostics on edit plus 13 pi tools, with exact firewall policy entries. See registration review below. |
| `pi-readseek` | 0.4.26 | long-horizon, autonomous, self-improving, pentest, lite | `@jarkkojs/readseek` native CLI and xxhash-wasm | MIT. Hash-anchored reads and edits. 0.10.1 changed licence, entry and dependencies and was not adopted. |
| `pi-lean-ctx` | 3.10.5 | **none (opt-in)** | The external `lean-ctx` Rust CLI, not bundled | Apache-2.0. Registers extra shell, read and edit tools that the firewall does not classify as shell and `secret-guard` does not inspect. Installed by `install.ts --all` only when its CLI is on `PATH`. |

The container overlay (`packages/container/overlays/pi/settings.json`) pins `pi-mcp-adapter@2.8.0`,
checked by `validate-pentest-env.sh`; the 3.x line adds native and remote dependencies and was not
adopted.

Native-binary risk is contained by exact version pins, `reference` (not bundle) mode, and the
`review` field per source. A kit release that changes a pin moves companions on the next
`/update`.

### Companion downloads at run time

pi-lens fetches missing linters, formatters, scanners and language servers on demand, as npm
installs of unpinned latest packages or GitHub release downloads. That happens inside the pi
process, where the firewall sees no tool call, and outside the pinned, checksum-verified set
above. The tool firewall therefore sets `PI_LENS_DISABLE_LSP_INSTALL=1` and
`PI_LENS_DISABLE_TOOL_INSTALL=1` when it loads. Only an explicit `0` turns installs back on;
any other value, such as an empty string, `true` or `yes`, is set to `1`, because pi-lens disables
installs only on exactly `1` (`tests/tool-firewall-smoke.ts`). Tools already on `PATH` or in `~/.pi-lens/tools` keep working.

The pinned pi-lens 4.4.4 honours both switches, including managed tool refreshes
(`dist/index.js:31908`, `:32844`, `:32968`, `:33057`, `:37129`, `:80154` in that package).
`tests/tool-firewall-smoke.ts` pins the kit's defaults and preserves explicit operator values.
It tests the kit, not the companion's implementation of those switches.

These switches do not disable missing tree-sitter grammar downloads. Those have a separate
project-trust gate (`dist/index.js:56547`) and check SHA-256 only when the grammar has a matching
manifest entry (`:53837`). Vendored grammars refuse a download fallback. This is not a promise
of an offline companion; no test in the kit executes these download paths.

### pi-lens registration review

The pin is based on static inspection of the unpacked 3.8.63 and 4.4.4 packages. Neither
package was executed or imported for this review, so loading in a real TUI, provider-backed
write/edit hooks and dependency installation are not validated here. The packages register
pi tools from `dist/index.js:717` (3.8.63) and `dist/index.js:149051` (4.4.4), the latter
combining always-active and situational tools before registration at `:149180`. Configuration
can disable tools; situational tools can be activated for subsequent turns.

Every tool in the 4.4.4 pi registration loop has an exact entry in both copies of the shipped
firewall policy. The table records the policy risk class and benign-input tier. An `ask`
entry produces the firewall's `unknown_exec` effect at high tier, regardless of a benign
preview input; read and discovery entries produce `read` at low tier. Credential paths raise
read helpers to high. `tests/tool-firewall-smoke.ts` pins all 13 identities, classes, tiers,
real `tool_call` decisions and credential-path blocks; `tests/firewall-shell-smoke.ts` also
pins path-array handling and the new `analysisRoot` field. The table's line references are
inside 4.4.4's `dist/index.js`.

| Tool | Policy risk class / underlying effect | Tier | Decision | Definition |
|---|---|---|---|---|
| `ast_grep_search` | `read_only`: structural search, including dump mode | low | allow | `:144109` |
| `ast_grep_outline` | `read_only`: syntax outline | low | allow | `:144606` |
| `ast_grep_replace` | `file_write`: structural replacement | high | ask | `:143705` |
| `lsp_navigation` | `code_exec`: includes mutations and server commands | high | ask | `:145564` |
| `lens_diagnostics` | `read_only`: diagnostics, including active scans | low | allow | `:141559` |
| `lens_diagnostic_mark` (new) | `file_write`: can insert suppression comments | high | ask | `:143287` |
| `symbol_search` (new) | `read_only`: indexed identifier search | low | allow | `:146791` |
| `module_report` | `read_only`: source module report | low | allow | `:146332` |
| `project_report` (new) | `read_only`: project graph report | low | allow | `:146655` |
| `read_symbol` | `read_only`: symbol body | low | allow | `:146445` |
| `read_enclosing` | `read_only`: enclosing symbol body | low | allow | `:146532` |
| `effective_config` (new) | `read_only`: redacted configuration provenance | low | allow | `:146737` |
| `pi_lens_activate_tools` (new) | `tool_discovery`: activates registered situational tools | low | allow | `:139317` |

The new explicit path inputs are `symbol_search.paths`, `effective_config.file` and
`lens_diagnostic_mark.filePath`; existing firewall fields cover them. `lens_diagnostics`
adds `analysisRoot` alongside `path` and `paths`; the firewall checks all three. The new
`project_report` and activator accept no paths. `read_symbol` adds an optional `kind` selector,
covered by the kit's adapter. Mutation helpers require approval for every call; the firewall
also checks `lsp_navigation.newFilePath` and the paths of `ast_grep_replace` and
`lens_diagnostic_mark` as write targets (`tests/firewall-shell-smoke.ts`). Activation grants no authority to
execute the activated tools; their individual calls still pass through the firewall.

Removed pi registrations are `ast_grep_dump` and `ast_dump` (3.8.63
`dist/tools/ast-dump.js:104` and `:107`) and standalone `lsp_diagnostics`
(`dist/tools/lsp-diagnostics.js:142`). Dump is now a search option, and LSP diagnostics route
through `lens_diagnostics` (4.4.4 `dist/index.js:141727`). Older policy names are retained
for other reviewed companion surfaces; an entry is not evidence that 4.4.4 registers it.
The MCP registry is separate (`dist/index.js:5352`) and does not register extra pi tools.

Commands retained from 3.8.63 are `lens-toggle`, `lens-context-toggle`, `lens-widget-toggle`,
`lens-tdi`, `lens-health`, `lens-tools` and `lens-allow-edit` (3.8.63 `dist/index.js:425`,
`:434`, `:443`, `:476`, `:509`, `:625`, `:698`; 4.4.4 `dist/index.js:148733`, `:148740`,
`:148747`, `:148765`, `:148820`, `:148972`, `:149038`). `lens-booboo` is removed
(3.8.63 `:460`); `lens-map` and `lens-perf` are added (4.4.4 `:148797`, `:148954`).

Hooks retained are `resources_discover`, `session_start`, `tool_call`, `tool_result`,
`turn_start`, `agent_end`, `turn_end`, `session_shutdown` and `context` (3.8.63
`dist/index.js:748`, `:761`, `:896`, `:1544`, `:1574`, `:1578`, `:1607`, `:1680`, `:1695`;
4.4.4 `dist/index.js:149184`, `:149207`, `:149518`, `:149602`, `:149641`, `:149743`,
`:149882`, `:150034`, `:150204`). `session_before_fork` is removed (3.8.63 `:887`);
`session_tree`, `tool_execution_end` and conditional `agent_settled` are added (4.4.4
`:149492`, `:149612`, `:150019`). These hooks still run inside pi: the firewall does not
sandbox a companion's code or its diagnostic subprocesses, and a read-only policy class
is not process isolation. Active diagnostic scans can launch configured local analysers.

The profile JSON selects the companion as a whole: `balanced` includes `pi-lens` and has
no per-tool filter. Installer filters scope the kit's own extensions/skills/prompts, not
a separately registered companion's tools. No kit test claims a diagnostics-only pi-lens
surface in balanced. The policy decisions above apply wherever its tools are exposed.

4.4.4's manifest is MIT (`package.json:92`), has native ast-grep dependencies (`:128`), and
optional `web-tree-sitter` and `jiti` (`:152`); runtime TypeScript is no longer a direct
dependency. It has no `preinstall`, `install` or `postinstall` script. Its source `prepare`
hook builds, downloads core grammars, sets up git hooks, stamps a lock and warms the loader
(`:20`); it is not a registry tarball install hook. The ast-grep CLI dependency still needs
a platform binary lifecycle step (`dist/index.js:34523`); this review did not inspect
or execute dependency tarballs. Native and WASM components remain opaque supply-chain risk.

The earlier pi 1.3 host-dependency warning applies to 3.8.63's `pi-tui` and `typebox`
dependencies (`package.json:77`). In the supplied 4.4.4 manifest they are optional peers:
`pi-tui="*"`, `pi-coding-agent="*"`, `typebox="^1.0.0"` (`package.json:136`). The typebox
range still differs from pi's recommended `"*"`, but pi 1.3's
`collectExtensionPackageWarnings` checks host packages in `dependencies`, so this manifest
does not meet that warning condition. This was checked against the installed pi loader's
source; no TUI compatibility claim is made.

### Evaluating a candidate

Read its tarball (`npm pack <name>@<version>`, then inspect `package.json` for `pi` entries,
peer ranges, dependencies, scripts and licence). If it loads into pi, install it into a scratch
`PI_CODING_AGENT_DIR` with `pi install npm:<name>@<version>` and start pi in a terminal to see what
it registers and whether it degrades cleanly. Record the result in `review`. Do not adopt a
version on the strength of its changelog.

## `npm audit` status (2026-09-30, npm 10.9)

`npm audit` reports **0 vulnerabilities** for the full dependency tree, including dev
dependencies, and `npm audit signatures` verifies every registry signature and 84 attestations
(385 locked packages). CI blocks on high or critical advisories (`npm audit --audit-level=high`),
on OSV-Scanner findings and, for pull requests, on dependency review.

The dev tree includes `mermaid` and `jsdom`, used only by `npm run docs:mermaid` to check that the
documentation's diagrams parse. They are never installed by a user of the kit.

## Lockfile integrity

`npm run security:lockfile` (`packages/core/lockfile-check.ts`, part of CI) fails when a package
in `package-lock.json` resolves from anywhere but `https://registry.npmjs.org`, lacks a sha512
`integrity` hash, or declares an install script that is not on its reviewed allowlist. CI installs
with `--ignore-scripts`, so even allowlisted scripts never run there.

## pi versions

The kit supports `@earendil-works/pi-coding-agent` **0.85.1 and newer** (its `peerDependencies`
floor) on Node 22.19 or newer, which is pi's own requirement. The dev dependency pins the version
the whole suite is tested against, **1.3.0**. CI's `pi-compat` matrix runs the check suite at the
floor, **0.85.1**, and at the last pi 0.x release, **0.99.2**; both must pass. Type checking and
lint run only against the pin, because they read pi's type declarations and older releases export
fewer type names; the extensions load as erased TypeScript, so the rest of the suite is what
establishes that an older pi works. When a pi
release newer than the pin is under review, it runs there as an advisory lane first: its failure
is the signal to review before the pin moves. Moving the pin or the floor is a reviewed change;
Dependabot does not bump pi minors or TypeScript majors.

pi 1.x no longer publishes a shrinkwrap, so its own dependencies are hoisted beside it instead of
nested under it, and since 1.2 `before_agent_start` also fires for runs an extension starts with a
custom message; such an event carries no `prompt`, and the kit's handlers treat only a user prompt
as the operator's request. pi's extension documentation states that calls a tool makes through
`ctx.executeTool()`, as codemode and tool search do, go through the same `tool_call` and
`tool_result` handlers as model-issued calls; nothing in this repository tests nested calls yet.

pi 0.99 changed its distribution (the runtime is bundled) and its tool-call and overflow
internals. The suite's runtime pins were made to follow pi's own behaviour rather than its source
layout, and the results at each version are recorded in the release notes for the beta.
