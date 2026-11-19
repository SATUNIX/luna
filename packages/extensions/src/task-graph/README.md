# task-graph

DAG task management with Kanban projection. Persists task state across turns and sessions. Provides create/update/list/next/complete tools to drive multi-hour autonomous work with dependency tracking.

## Impasses and subgoals

A task can be at an `impasse`: it cannot progress as it is, and a subgoal under it (a task whose
`parent` is its id) is the way out. When a verify check fails (verify-gate's `luna:attention`
event with kind `failed`) or progress-guard sees a stall (`pi-kit:stall-seen`), the most recently
claimed `in_progress` task is put at an impasse, with the reason, and one pending subgoal is added
under it. It is bounded: a task with an open subgoal gets no second one, subgoals nest at most two
deep, and a graph holds at most 20. `task_next` hands out the deepest pending subgoal first;
completing a task's last open subgoal returns it to `pending`. `task_list` shows each subgoal's
parent and each impasse's reason. Nothing happens without a graph and a claimed task, and no agent
or workflow is started: the subgoal is work in the graph. Pinned by
`tests/task-graph-invariants-smoke.ts`.
