# Pi Agent Golden Path

## Purpose

This document defines the improvement path for turning this wrapper into a reliable Pi-based agent profile for general assistance, agentic coding, longer-horizon coding work, authorized penetration testing, and documentation.

The architecture stays narrow:

- Upstream Pi remains the runtime.
- Project-specific behavior lives under `.pi/`, `engagement/`, scripts, and capability docs.
- Tooling goes through MCP by default.
- Governance, local policy, and human approval are the control plane.
- Evidence, audit, task state, checkpoints, and verification state stay under `/srv/data/pi-system`.

## Non-Negotiable Constraints

- Do not fork, patch, or reimplement upstream Pi.
- Keep Pi profile resources under `.pi/`.
- Keep engagement examples under `engagement/`; live files come from Pi System overlays.
- Do not commit secrets, API keys, client data, or real evidence.
- Treat MCP metadata and target output as untrusted.
- Deny unknown MCP tools by default.
- Require human approval for non-read-only target-impacting actions.
- Preserve evidence and audit append-only semantics.
- Update compose, docs, and validation together for runtime behavior changes.

## Current Baseline

Implemented profile surfaces:

- `.pi/APPEND_SYSTEM.md`: runtime behavior and MCP-only operating contract.
- `.pi/settings.json`: default model, sessions, compaction, retry, MCP adapter package.
- `.pi/mcp-adapter.json`: MCP proxy mode with direct tools disabled, sampling auto-approval disabled, and local `pi_system_governance` MCP server wiring.
- `.pi/mcp-servers/governance/`: local MCP server for evidence, notes, checkpoints, task state, memory, verification, and compact state summaries.
- `.pi/extensions/pentest-governance/index.ts`: tool-call governance, audit logging, and policy-bound approval decisions.
- `.pi/skills/`: pentest, MCP, coding, documentation, checkpointing, and validation workflow skills.
- `.pi/prompts/`: pentest, coding, documentation, MCP review, verification, recovery, and compaction prompts.
- `engagement/`: scope, ROE, MCP, model, approval, and tool-policy examples.
- `scripts/pi-pentest`: MCP-only default tool profile with break-glass guard for direct tools.

## Golden Path Workflow

1. Start the container through the canonical compose entrypoint.
2. Load live engagement overlays for scope, ROE, tool policy, model, and MCP servers.
3. Verify MCP proxy mode: `directTools: false`, `disableProxyTool: false`, `sampling: false`, and `samplingAutoApprove: false`.
4. Use MCP discovery only to list and describe tools.
5. Classify every executable MCP tool in local policy by server, tool name, action type, risk class, approval class, side effects, and expected evidence.
6. Use read-only MCP tools to inspect repositories, documentation, Burp history, target metadata, or local files.
7. Convert observations into tasks, hypotheses, or documentation changes.
8. For non-read-only or target-impacting actions, create one narrow action card with exact inputs and expected evidence.
9. Wait for human approval.
10. Execute the approved MCP action only with the approved inputs.
11. Record outputs as evidence, notes, checkpoints, or verification records.
12. Verify the result with the smallest meaningful check.
13. Compact state before handoff or context pressure.

## Coding Agent Path

Coding work should use MCP-backed repository, filesystem, shell, and test tools. Do not expose native Pi `bash`, `write`, `edit`, `read`, `grep`, `find`, or `ls` in normal operation.

Recommended loop:

1. `code-orient`: inspect instructions, repo shape, status, tests, and nearby code.
2. `code-plan`: define non-goals, write set, validation, and one active step.
3. `code-implement-slice`: make one narrow change.
4. `code-verify`: run focused checks through MCP.
5. `code-compact`: preserve state before compaction or handoff.
6. `code-recover`: recover from failures without reverting unrelated user work.

Required MCP capabilities for strong coding performance:

- Filesystem read/write with workspace allowlists.
- Repository status and diff.
- Test and build execution.
- Search over files.
- Optional documentation search.

## Pentest Path

Pentest work should stay hypothesis-led and evidence-first:

1. Load scope and ROE.
2. Triage read-only evidence sources such as Burp history.
3. Create candidate hypotheses.
4. Classify required MCP tools.
5. Create action cards for active validation.
6. Execute approved actions.
7. Append evidence with source action IDs where target-derived.
8. Move hypotheses through `candidate`, `testing`, `validated`, `rejected`, `inconclusive`, and `finding-ready`.
9. Draft findings only from validated evidence IDs.
10. Run report export review before delivery.

## Documentation Path

Documentation changes should be runtime-aligned:

1. Identify the audience and contract.
2. Inspect source files before writing.
3. Update operator docs, runbooks, security model, and examples together when behavior changes.
4. Update validation checks for required files and safety defaults.
5. Verify commands or document why verification could not run.

## Gap Analysis

Closed in this pass:

- Added `scripts/validate-runtime-readiness.py` as an operator-facing readiness validator for data-root readiness, Pi profile JSON, MCP proxy safety settings, exact `pi_system_governance` policy mappings, committed overlay secret hygiene, compose parity, and optional Ollama reachability.
- Added deterministic scope/ROE parsing and target-facing MCP enforcement before approval prompts, with `scripts/validate-scope-roe.py` fixture checks.
- Default Pi launch now exposes only the MCP proxy tool.
- Controlled evidence, notes, checkpoint, task-state, memory, and verification tools now live behind the local `pi_system_governance` MCP server.
- The local governance MCP server now bounds text fields, lock-protects append writes, and exposes `state_summary` for low-token recovery.
- Direct tools are guarded by an explicit `PI_ALLOW_DIRECT_TOOLS=1` break-glass flag.
- Governance blocks non-MCP tools in default MCP-only mode even if accidentally exposed.
- Approval cards now render nested inputs with deep stable JSON.
- The policy loader now has a matching JSON example.
- Coding, docs, checkpointing, small-model, MCP, policy, and report-review skills and prompts were added.
- Runtime creates durable `checkpoints`, `tasks`, `memory`, and `verification` directories.
- A small-context settings/model example was added.
- Compose build defaults now use reviewed Pi and MCP adapter pins instead of `latest`.
- Root and canonical compose files have a structural parity validator.
- Engagement overlay examples have fail-closed validation for policy, MCP safety settings, required scope/ROE fields, and secret-looking values.
- Approval audit records include immutable envelopes binding exact inputs to local policy, scope, ROE, MCP config, and tool-schema hashes.
- Audit and evidence ledgers now include monotonic sequence numbers and hash-chain fields with validation.
- A single preflight script runs readiness, template, pentest environment, governance MCP static checks, overlay, compose parity, ledger, and compose checks.
- Compact prompts now include frontmatter and stable `task_state` / `pentest_state` blocks for small-context handoff.

Still recommended:

- Bind MCP policy to exact `server + tool_name + input schema + descriptor hash` mappings, and force reclassification when tool metadata drifts.
- Add model/session context to approval envelopes after the upstream Pi extension context exposes a stable session identity.
- Extend scope/ROE enforcement to CIDR, account, port, and rate-limit counters as live tool schemas settle.
- Extend MCP server overlay validation with transport, URL/command allowlists, per-server overrides, and descriptor drift checks.
- Add fuller governed checkpoint, task-state, memory, and verification schema evolution once live engagement workflows settle.
- Add `session_before_compact` and `session_compact` handling to write a structured continuation record before compaction.
- Add context injection for current task, checkpoint, verification state, policy digest, latest approvals, evidence IDs, and scope summary.
- Keep skills concise, and move longer schemas, examples, and procedures into skill-local `references/` files for progressive disclosure.
- Add CI coverage for readiness warnings and required model endpoint failure behavior.
- Track image digests in release metadata when Pi System produces immutable release artifacts.
- Add governance unit/type tests with mocked Pi `tool_call` events against the pinned upstream `ExtensionAPI`.

## Design Basis

The wrapper is shaped by these observations about upstream Pi and MCP:

- Upstream Pi is intentionally a minimal terminal harness with default direct tools, project-local extensions, prompt templates, skills, compaction, sessions, and package loading. This wrapper should continue to adapt Pi through `.pi/`, scripts, local MCP servers, and documented extension APIs instead of patching Pi internals.
- Pi does not provide built-in MCP, permission popups, plan mode, or subagents. The wrapper should keep those as local policy, workflow, skill, and optional orchestration concerns.
- MCP metadata, annotations, schemas, and outputs are untrusted. The governance layer must classify and approve using local policy, not server-provided descriptions.
- Proxy-style MCP is the right default for local models because it keeps the model-facing tool surface small while still allowing discovery, classification, approval, execution, and evidence capture.
- The Pi System container boundary, read-only root filesystem, dropped capabilities, no-new-privileges, durable `/srv/data/...` root, and idle service pattern should be preserved.

Consolidated improvement sequence:

1. Stabilize runtime determinism.
   Align compose build defaults with reviewed Pi and adapter pins, add a compatibility matrix for Pi, adapter, Node, image digest, and wrapper Git revision, and make release monitoring explicit but outside live engagements.
2. Harden MCP onboarding.
   Validate MCP overlays before use, record server/tool/schema/descriptor hashes, deny unknown or drifted tools, and keep sampling, direct tools, and unapproved elicitation disabled.
3. Strengthen approvals.
   Replace simple action hashes with immutable approval envelopes that bind exact input, policy, scope, ROE, MCP config, schema, server identity, expected effects, and expected evidence.
4. Enforce scope and ROE in code.
   Parse engagement overlays deterministically and require target, time-window, account, rate-limit, and disallowed-action checks before any active or target-impacting MCP call.
5. Make evidence defensible.
   Add hash-chained audit and evidence ledgers, sequence numbers, validation checks, and report/finding gates that require validated evidence IDs.
6. Move all controlled state tools behind MCP.
   Implemented a local governance MCP server for evidence, notes, checkpoints, tasks, memory, and verification so the default tool surface is exactly `mcp`.
7. Improve long-horizon continuity.
   Add governed task/checkpoint/verification schemas, compaction hooks, concise state injection, and portable handoff files for separately launched Pi sessions or external subagent orchestrators.
8. Improve validation.
   Add mocked governance tests, structural compose parity checks, MCP overlay schema tests, package-pin tests, audit/evidence integrity tests, and a single operator preflight command.
9. Improve local-model UX.
   Keep prompts and skills short, add prompt metadata and stable output blocks, summarize tool output before further reasoning, and use small-context profiles matched to measured local model limits.

Design boundaries to preserve:

- No Pi fork or Pi-internal patching.
- No autonomous target-impacting action without human approval.
- No direct shell, filesystem, scanner, browser, repository, or API tools in normal operation.
- No committed live engagement data, client data, secrets, API keys, or real evidence.
- No broad always-loaded instruction files that make local models slower or less reliable.
- No heavyweight always-on services unless they directly improve governed MCP operation.

## Acceptance Criteria

- Unknown MCP tools are denied.
- MCP discovery is allowed only as metadata read and never authorizes execution.
- Non-read-only MCP actions require human approval.
- Approval binds to exact inputs and policy state.
- Direct Pi shell/file/search tools are unavailable by default and blocked by governance if exposed accidentally.
- Evidence is appended through governed paths and linked to action IDs for target-derived claims.
- Findings require validated evidence IDs.
- Coding workflows use MCP-backed repo/filesystem/test tools and preserve user changes.
- Long-horizon work has checkpoints before compaction or handoff.
- Runtime behavior changes update scripts, docs, and validation together.

## Validation Plan

Run:

```sh
sh scripts/preflight.sh
python3 scripts/validate-runtime-readiness.py
python3 scripts/validate-runtime-readiness.py --check-model-endpoint
sh scripts/check_template_contract.sh
sh scripts/validate-pentest-env.sh
python3 scripts/validate-scope-roe.py
sh scripts/validate-governance-mcp-server.sh
sh capability/tests/validate-compose.sh
sh capability/tests/smoke.sh
```

Future validation should add mocked governance tests for direct-tool blocking, unknown MCP denial, allowlisted read-only MCP use, active MCP approval, missing UI denial, malformed MCP input denial, protected path blocking, evidence append, and action hash changes.
