# Architecture diagrams

These pages show the heavily developed parts of the kit as Mermaid diagrams, each with the prose that explains what the diagram cannot. Each page describes how the code behaves now and lists the source files it is drawn from.

| Page | Covers | Source files |
|---|---|---|
| [Tool firewall and auto mode](tool-firewall-and-auto-mode.md) | decision pipeline, mode/policy matrix, judge, grants, cards, broker, learning, protected-paths | `packages/extensions/src/tool-firewall/`, `packages/extensions/third_party/protected-paths/` |
| [Human console, approvals and logging](console-and-logging.md) | every log and audit file, the approval broker, tool I/O capture | `packages/extensions/src/human-console/`, `packages/extensions/src/tool-capture/`, `packages/extensions/src/trace-ledger/` |
| [Subagents, orchestration and the task graph](subagents-and-orchestration.md) | spawning children, roles and trust, modes, lifecycle and cancel | `packages/extensions/third_party/subagent/`, `packages/extensions/src/orchestrator/`, `packages/extensions/src/task-graph/`, `packages/extensions/src/verifier-board/` |
| [Effort ledger and delegation launch contract](subagents-and-orchestration.md#the-launch-contract) | the single child-launch contract, governance extensions, the child-side self-check, effort tiers, the shared ledger and its reservations at every depth | `packages/extensions/src/delegation-guard/`, `packages/extensions/src/effort/`, `packages/extensions/third_party/subagent/launch.ts` |
| [Memory vault, compaction and context assembly](memory-compaction-context.md) | ctx-contributions, context-sieve, vault, recaps, compaction | `packages/extensions/src/context-sieve/`, `packages/extensions/src/memory-vault/`, `packages/extensions/src/compress/`, `packages/extensions/src/save/` |
| [Workflows and skill routing](workflows-and-skills.md) | workflow discovery and executor, skill router, verify gate | `packages/extensions/third_party/subagent/workflow.ts`, `packages/extensions/src/skill-router/`, `packages/extensions/src/verify-gate/`, `packages/kit/workflows/` |
| [Profiles and install](profiles-and-install.md) | installer, profiles, settings, firewall config, `/profile` | `packages/core/install.ts`, `packages/core/lib/`, `packages/kit/profiles/`, `packages/extensions/src/session-helpers/` |

For the prose behind the delegation rows, see [Effort](../effort.md) and [Agent orchestration](../agent-orchestration.md#child-governance).

## Keeping these pages true

The diagrams are Mermaid, so GitHub draws them from the page source, and `npm run docs:mermaid` checks that every diagram in the repository parses. That check covers syntax only. It cannot tell you that a diagram still matches the code, so when you change behaviour a page describes, update the page in the same commit. Check the names, files and flows on the page against the code, not against the old text, and keep the "Source files" list at the end of the page accurate.
