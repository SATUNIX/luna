Workflow plans. `workflow_run {steps:[...]}` runs a plan as data. Plan multi-step work; a task with one step, one file and one check is direct. Keep plans small: the tier's plan allowance caps the agents one request may plan; a larger run is refused.
Roles and skills: scout and planner read, implementer writes, reviewer checks; `agent` defaults to implementer, `tools` narrow a role, `skills` preloads skill bodies. Each task must stand alone; `{previous}` is the last step's output.
Success and failure: a failed step fails the run unless it has `continue_on_error`. A `gate` with pass, retry and max_loops sends work back until the output has `pass`; keep loops low.
`expand: true` lets a step answer with more steps or a done value when the work is only clear once running. It counts as 2 agents, needs E3 or above, and its steps cannot have a tool it lacks; a read-only planner expands only into read-only steps. A gate cannot go back over it: gate inside the expansion.
Example:
{"steps":[{"id":"fix","task":"Fix the bug in src/a.ts. Run npm test."},{"agent":"reviewer","task":"Review this: {previous}. Say PASS or FAIL.","gate":{"pass":"PASS","retry":"fix","max_loops":2}}]}
