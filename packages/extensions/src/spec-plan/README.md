# spec-plan

Encourages spec-before-code discipline. Warns (or blocks in strict mode) when the agent writes a large source file without a spec/plan document present in the project.

## Behaviour

On `tool_call` for `write` or `edit` targeting a source file (`.ts`, `.py`, `.go`, etc.) with at least `MIN_LINES` lines of changed content, checks for a spec file. For `write` the changed content is `content`; for `edit` it is the sum of the `edits[].newText` payloads (the live edit schema). Empty text (a pure deletion) contributes 0 lines; a single trailing newline is not counted as an extra line. If no spec file is found, emits a warning notification. In strict mode, blocks the change.

## Spec file locations checked

`SPEC.md`, `PLAN.md`, `DESIGN.md`, `ADR.md`, `docs/SPEC.md`, `docs/PLAN.md`, `docs/DESIGN.md`, `.pi/PLAN.md`, `_consolidation/CONSOLIDATION_PLAN.md`

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PI_KIT_SPEC_PLAN_MIN_LINES` | `30` | Minimum changed-content lines that triggers the check; a non-numeric value falls back to `30`, and values below `1` are clamped to `1` |
| `PI_KIT_SPEC_PLAN_STRICT` | warn | `1` blocks; `0`, `false`, `off` or `no` disables the check entirely; any other value warns |

## Profiles

Profiles: see `docs/EXTENSIONS.md` (generated from `packages/kit/profiles/*.json`).
