# Writing Extensions

## Quick start

```sh
npm run new -- my-extension     # also runs npm run catalog
# implement packages/extensions/src/my-extension/index.ts
# fill packages/extensions/src/my-extension/extension.json
npm run catalog
npm run verify
```

## The hard rules

1. **Self-containment:** import only `node:*` built-ins and `typebox`. No sibling imports. No `packages/core/lib` imports. `npm run verify` will fail on violations.
2. **One stable name:** set `name` in `extension.json` once. Never change it. Profiles and the catalog key on this name.
3. **Schema-valid metadata:** every field in `extension.json` must pass `packages/core/schema/extension.schema.json`.

## extension.json fields

| Field | Required | Notes |
|---|---|---|
| `name` | yes | kebab-case, stable identity |
| `summary` | yes | One sentence, ≥10 chars |
| `category` | yes | safety \| workflow \| planning \| memory \| execution \| ui |
| `entry` | yes | Relative path to .ts entry, usually `"index.ts"` |
| `hooks` | yes | Which lifecycle events this extension registers |
| `profiles` | yes | Which profiles include it by default |
| `platforms` | yes | Which OS it supports |
| `runtime` | yes | Declares all external deps (node builtins, npm, services, models) |
| `status` | yes | stable \| beta \| experimental \| stub |
| `provenance.origin` | yes | custom \| vendored \| external |
| `homeRepo` | no | Set to the git URL once extracted to its own repo |

`stable`/`beta` may ship in any profile; `experimental`/`stub` may ship **only** in an
experimental profile (`packages/kit/profiles/*.json` with `"experimental": true`) or nowhere (`profiles: []`
for a quarantined `stub`). See the verify checks below.

## What `npm run verify` enforces (with a worked failure for each)

`packages/core/verify.ts` is the gate CI runs. Every check below fails the build; the parenthetical is
what you'd see if you broke it.

| Check | Fails when | Worked failure |
|---|---|---|
| **Schema** | `extension.json` violates `extension.schema.json` | Set `status: "wip"` → `extension.json schema invalid: data/status must be equal to one of the allowed values` |
| **tsc --noEmit** | any `.ts` doesn't type-check | Add `const x: number = "s"` → `type check failed` |
| **Self-containment** | an extension imports a sibling or `packages/core/lib` | `import x from "../other/util"` → `self-containment violation ... imports outside extension dir` |
| **Name collision** | two manifests share a `name` | Duplicate a `name` → `name collision: "foo" also in packages/extensions/third_party/foo` |
| **context-sieve monopoly** | a non-`context-sieve` file returns `{ systemPrompt }` from `before_agent_start` | `return { systemPrompt }` elsewhere → `self-injection violation` |
| **Profile↔manifest drift** (1.3) | `extension.json.profiles` ≠ actual `packages/kit/profiles/*.json` membership | Add your ext to `balanced.json` but not its manifest → `profile metadata drift for "foo": ... [] != [balanced]` |
| **Orphaned real extension** (1.3) | a `stable`/`beta` ext ships in no profile | Set `profiles: []` on a `beta` ext → `orphaned extension "foo": status beta but shipped in no profile` |
| **Stub/TODO quarantine** (1.3) | a `stub`/`experimental` ext (or a `(stub)`/`: TODO` string) ships in a non-experimental profile or lite | Put a `stub` ext in `balanced` → `stub/experimental extension "foo" ... ships in non-experimental context [balanced]` |
| **Firewall starter policy** (2.1) | the shipped policy is `allow`-by-default, has 0 deny rules, or the embedded/mirror copies diverge | Set `defaults.unknown: "allow"` in `default-policy.json` → `defaults.unknown must not be 'allow'` |
| **Security pattern parity** (2.2) | the firewall deny list drops a pentest `DESTRUCTIVE_COMMANDS` pattern, or secret-guard drops a `PROTECTED_PATTERNS` entry | Delete an `rm -rf` rule from the policy → `firewall starter policy is missing pentest DESTRUCTIVE_COMMANDS patterns` |
| **Skills catalogue + frontmatter** (3.1) | a `SKILL.md` lacks `name`/`description`/`category`, or `skills-catalogue.md` is stale | Edit a skill's category → `docs/skills-catalogue.md is stale — run 'npm run catalog'` |
| **Capability matrix drift** (3.3) | `docs/capability-matrix.md` no longer matches packages/kit/profiles/manifests | Add an extension → `docs/capability-matrix.md is stale — run 'npm run catalog'` |
| **Docs nav + links** (3.3) | an `mkdocs.yml` nav entry has no file, or a doc has a broken relative link | Rename a doc without updating nav → `docs nav/link check failed: nav entry has no file` |

The self-containment lint scans every `.ts` module in an extension at any depth, so a violation in a nested file such as `sub/bad.ts` is reported just like one in `index.ts`.

To reproduce any of these safely: make the change, run `node packages/core/verify.ts`, observe the
FAIL, then revert. `npm run eval` (the offline fixture harness) and `npm run test:security`
cover *behavioural* regressions the static gate can't see.

## Hooks

The authoritative hook list is the `hooks.items.enum` in
`packages/core/schema/extension.schema.json`; `extension.json` must declare exactly the
events the extension registers with `pi.on(...)`. The table below mirrors that enum.

| Hook | Category | Fires |
|---|---|---|
| `tool_call` | Tool | Before a tool is executed; can block it |
| `tool_result` | Tool | With a tool's result; can modify it |
| `project_trust` | Startup | Before pi decides whether to trust a project with dynamic configs; user/global extensions can decide or defer |
| `resources_discover` | Startup | After `session_start`, so extensions can contribute skill/prompt/theme paths |
| `session_start` | Session | When a session starts or resumes |
| `session_info_changed` | Session | When the session display name is set or cleared |
| `session_shutdown` | Session | Before a session runtime is torn down (quit, reload, new, resume, fork) |
| `session_before_switch` | Session | Before `/new` or `/resume`; can cancel |
| `session_before_fork` | Session | Before `/fork` or `/clone`; can cancel |
| `session_before_compact` | Session | Before compaction; can cancel or customize |
| `session_compact` | Session | After a successful compaction |
| `session_compact_failed` | Session | After a compaction fails or is aborted |
| `session_before_tree` | Session | Before `/tree` navigation; can cancel or customize the summary |
| `session_tree` | Session | On `/tree` navigation |
| `before_agent_start` | Agent | Before an agent run; can inject a message or adjust the prompt |
| `agent_start` | Agent | When a low-level agent run begins |
| `agent_end` | Agent | When a low-level agent run ends |
| `agent_settled` | Agent | When pi will not continue running automatically (no retry, compaction, or follow-up left) |
| `before_provider_request` | Provider | After the provider payload is built, before the request is sent; can replace it |
| `before_provider_headers` | Provider | After the outgoing HTTP headers are assembled; can mutate them |
| `after_provider_response` | Provider | After the HTTP response arrives, before its stream is consumed |
| `ui_prompt_start` | UI | When a blocking user-facing UI prompt opens |
| `ui_prompt_end` | UI | When that user-facing UI prompt closes |
| `turn_start` | Turn | At the start of each turn |
| `turn_end` | Turn | At the end of each turn |
| `message_start` | Message | When a message starts |
| `message_update` | Message | For assistant streaming updates |
| `message_end` | Message | When a message ends; can replace the finalized message |
| `tool_execution_start` | Tool execution | When tool execution starts |
| `tool_execution_update` | Tool execution | With a tool's partial result |
| `tool_execution_end` | Tool execution | When tool execution ends |
| `context` | Agent | With the message context before the provider call; can modify it |
| `user_bash` | User bash | For user `!`/`!!` commands; can intercept |
| `input` | Input | With raw user input; can intercept, transform, or handle |
| `model_select` | Model | When the active model changes |
| `thinking_level_select` | Model | When the thinking level changes (notification only) |

## Writing skills

A skill is a runbook the model loads on demand, not a slogan. Keep the `description` (the only part
that costs tokens until the skill loads) tight and put depth in the body and `references/`.

```
packages/kit/skills/<name>/
├── SKILL.md          # frontmatter + when-to-use + procedure + heuristics + anti-patterns
├── references/       # deep material loaded on demand (checklists, tables, examples)
└── scripts/          # optional helper scripts the model can invoke
```

`SKILL.md` sections (aim for 40 to 90 lines):

- **Frontmatter**: `name`, `category`, and a sharp `description` of the form "what + when". The
  description must contain a `Use ...` trigger clause; `npm run verify` fails a skill without one,
  because a bare purpose statement gives the model nothing to match against.
- **When to use / when not to use**: an explicit trigger and anti-trigger.
- **Procedure**: numbered steps, each with an action and a stop condition.
- **Decision heuristics**: the judgement calls (for example, read a range, not the whole file,
  when the symbol is known).
- **Anti-patterns**: the failure modes the skill exists to prevent (loops, over-reading).
- **Done / verification**: what "finished" looks like.
- **References**: links to `references/*.md` for depth.

A skill that names a domain-only tool (for example pentest governance calls) must say it applies
only when that domain extension is loaded. After adding or recategorising a skill, run
`npm run catalog` to regenerate `docs/skills-catalogue.md`.

## Vendored extensions

If you need to adapt an upstream extension (e.g. Windows compatibility fixes), put it in `packages/extensions/third_party/<name>/` and add a `SOURCE.md`:

```markdown
# SOURCE

- Upstream: git:github.com/someone/pi-ext-foo
- Commit: abc1234
- Date: 2026-06-17
- Changes: Replaced POSIX path assumptions with node:path.win32; see inline comments.
```

## Splitting to its own repo

```sh
npm run extract -- my-extension
```

See `CONTRIBUTING.md` for the full split-out procedure.
