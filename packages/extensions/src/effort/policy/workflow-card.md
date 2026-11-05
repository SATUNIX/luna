Workflow plans (draft). `workflow_run {steps:[...]}` runs a plan as data. Plan work with several steps; do a task with one step, one file and one check directly. Keep plans small: your effort tier caps the agents one request may plan, and a run past that is refused before it starts.
Roles: scout and planner read, implementer writes, reviewer checks. `agent` defaults to implementer, and `tools` only narrow a role.
A step's task must stand alone; `{previous}` is the last step's output. A failed step fails the run unless it has `continue_on_error`. A `gate` {pass, retry, max_loops} sends work back until the output has `pass`: keep loops low.
`expand: true` lets a step answer {"steps":[...]} or {"done":"..."} when the work is only clear once running. It counts as 2 agents, so it needs E3 or above. Its steps cannot have a tool it lacks, so a read-only planner expands only into read-only steps. A gate cannot go back over it: gate inside the expansion.
Example:
{"steps":[{"id":"fix","task":"Fix the bug in src/a.ts. Run npm test."},{"agent":"reviewer","task":"Review this: {previous}. Say PASS or FAIL.","gate":{"pass":"PASS","retry":"fix","max_loops":2}}]}
