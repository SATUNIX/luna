# Proposal — filter `/workflows` control completions to controllable runs

Found in cycle 4 (`luna-fleet-01/04`) while adding autonomous rows to the run list.

`packages/extensions/third_party/subagent/workflow-tools.ts:847-853` builds the argument
completion for `status`, `panel`, `pause`, `skip`, `resume` and `stop` from every `queryRuns()` row.
Now that autonomous container rows are included, `/workflows pause <tab>` offers autonomy ids, and
choosing one answers "No live run" or "No run" because `workflow_control` acts only on the
in-process registry and recorded subagents. The list itself is the right place for a read-only
autonomy row; only the control commands should filter.

Suggested fix: for `status`/`panel`, keep every format; for `pause|skip|resume|stop`, offer only
rows whose format is `script`, `yaml` or `subagent`. Add one completion assertion to
`tests/run-query-smoke.ts` (autonomy id absent for `stop`, present for `status`). This is a small
follow-up to `tests/run-query-smoke.ts`, not a control-path change.
