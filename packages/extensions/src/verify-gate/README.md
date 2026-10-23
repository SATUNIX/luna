# verify-gate

Checks that the work is actually done. It is not tied to npm or to any test
runner.

## /verify and verify_completion

`/verify [focus]` (operator) and the `verify_completion` tool (agent) run the
same three steps:

1. **Definition of done.** It collects the goal (`.pi/GOAL.yaml`), the todo
   list (`TODO.md`), the task graph (`.pi/task-graph.json`), the last five user
   requests, and the optional focus text.
2. **Check command (optional).** It runs `PI_KIT_VERIFY_CMD`, or else
   `package.json` `scripts.verify`. A project with no check command is normal.
3. **Independent review.** It starts an isolated reviewer: a child
   `pi -p --no-session` with read-only tools (`read,grep,find,ls`) and the same
   model. The reviewer gets only the definition of done, the git change summary,
   and the check output. It never sees the builder's reasoning. It turns the
   definition of done into criteria and marks each one `PASS`, `FAIL`, or
   `UNKNOWN` with evidence.

The reviewer output is parsed strictly. If the output has no criteria, or the
verdict contradicts the criteria, the review counts as not run. It is never
read as a pass.

## Results

| Board source | Meaning |
|---|---|
| `verify` | The check command result. With no check command, this entry is removed when a review ran. |
| `review` | The reviewer result: criteria met, or the list of unmet criteria. |

Fail closed: if no check command ran and no review ran, `verify` is recorded as
FAIL ("nothing was checked").

The full report goes to `.pi/verify-report.md`, with each criterion and its
evidence, the summary, and the next actions. `/verdicts` shows the board and
the definition of done.

In interactive mode `/verify` runs in the background and notifies you when it
finishes. While it runs, its own `.pi/verify-pending/<run>.json` blocks mission completion. Each
run removes only its own file, so overlapping runs keep completion blocked until the last one
finishes; the legacy `.pi/verify-pending.json` is still honoured (`tests/verify-failclosed-smoke.ts`).

A verdict write waits up to about 1.3 s for a busy verifier-board lock. A write that still fails
is listed under "Verifier board NOT updated" in the report and named in the `/verify` and
automatic-mode notifications; the board keeps its earlier verdict (`tests/verify-failclosed-smoke.ts`).

A successful `write` or `edit` tool result turns a recorded `verify` or `review` PASS into a FAIL
marked `stale`. A run during which such an edit happened records its PASS as that stale FAIL and
its report has a "Stale" section. Either way mission completion stays blocked until verification
runs again. Only `write` and `edit` tool results in this pi process count as edits: a `bash`
command that changes files (`sed -i`, `git checkout`, a formatter) or an edit by another process
does not mark a verdict stale (`tests/verify-failclosed-smoke.ts`).

## Automatic mode

`PI_KIT_VERIFY_ON_TURN=1` keeps the fast path. After successful `write` or
`edit` tools, at the final turn it runs only the check command. It skips
projects without `scripts.verify`. It does not start a reviewer.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PI_KIT_VERIFY_CMD` | unset | Check command. Overrides `scripts.verify`. |
| `PI_KIT_VERIFY_REVIEW` | on | `0` turns the reviewer off. |
| `PI_KIT_VERIFY_REVIEW_MODEL` | current model | Model for the reviewer, as `provider/id`. |
| `PI_KIT_VERIFY_REVIEW_TIMEOUT_MS` | `900000` | Reviewer timeout. |
| `PI_KIT_VERIFY_ON_TURN` | `0` | `1` runs the check command after edits. |
