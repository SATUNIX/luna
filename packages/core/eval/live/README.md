# Live Pi sandbox evaluation

This opt-in harness calls a real configured model. It does not deploy or change
the operator's installed Pi package. The deterministic `npm run eval` remains
offline and is the CI default.

## Run

Requirements: Node, Docker Desktop/Engine, a built `pi-system:local`
image (Pi 0.76.0 was used for the recorded cycle evidence; the kit now pins 0.87.1), and a provider in `~/.pi/agent/models.json`.

From the kit checkout:

```sh
node packages/core/eval/live/run.ts --provider pentest --cases hello,clarification,coding,cyber-guided,verify-failure --timeout 300
node packages/core/eval/live/run.ts --variant lite --cases hello,clarification,coding,cyber --timeout 300
node packages/core/eval/live/run.ts --kit /path/to/unchanged-checkout --cases hello,clarification --timeout 120
```

Optional arguments: `--models <file>`, `--model <id>`, `--image <image>`.
The provider's first configured model is the default. Credentials can be literal
values or environment-variable references; command-based credential resolvers
are deliberately unsupported by this runner.

`focused` loads tool-firewall, secret-guard, trace-ledger, verify-gate,
orchestrator and context-sieve. `lite` loads every in-repository extension and
skill named by the `lite` profile (`packages/kit/profiles/lite.json`). External npm plugins, memory services,
MCP governance and multi-agent delegation are not evaluated by these fixtures.

## Isolation and unattended tools

Each invocation uses a random UUID for uniquely named disposable containers and an internal
Docker network. Agents and the synthetic vulnerable API have no published ports,
no Docker socket, no host home mount, and no direct external network. Containers
run as UID 10001 with a read-only root filesystem, all capabilities dropped,
no-new-privileges, resource limits, and bounded runtime/tool calls.

Only an inference relay connects to an external network. It forwards a small
allowlist of model API paths to the fixed configured upstream. Provider credentials
are delivered directly to the relay's stdin; they are absent from agent files,
container environment metadata and command arguments. The agent sees a synthetic
relay key. This is an inference access boundary, not a replacement for a separate
VM when evaluating hostile container-escape payloads.

A read-only, invocation-local firewall policy allows tools without interactive
approval. Secret/protected-path guards still apply. The policy is never installed
in the host Pi configuration. Writable files are disposable fixture workspaces,
session logs and temporary Pi settings. The kit mount remains read-only.

## Results and evidence

Results are under `.pi/live-eval/pi-eval-<run-id>/` (gitignored):

- `runtime.json` identifies the revision, selected surface and isolation flags.
- `summary.json` is replaced atomically after every case; `<case>/result.json` preserves the individual result. Case errors do not stop subsequent selected cases.
- `outcome` is `passed`, `failed`, `error`, or `pending_review`. `behavioralPassed` describes automated controls; `passed` is `null` while cyber report review is pending. `reportReview.status` remains `pending` until an independent reviewer records a review against protected target evidence in cycle artifacts. The runner does not grade factual prose.
- `agentDurationMs` ends when the Docker agent process exits (including Docker startup/stop overhead). `scoringDurationMs` covers evidence parsing and host validation; `durationMs` is the entire case including setup and scoring. These are wall times, not provider inference latency.
- `usage` preserves completed assistant-message records. `usageSummary.observed` sums available nonnegative finite token fields, including cache reads/writes. `totals` is null unless token coverage and the event/process lifecycle are complete. Missing fields are null rather than zero; interrupted runs retain observed consumption as a lower bound. Cost coverage is separate. No provider billing or hidden retry consumption is inferred.
- Missing, empty or malformed required event/lifecycle/target/verification evidence yields an `error` with artifact/code diagnostics; valid observed usage remains available even when later scoring fails.
- `<case>/host/events.jsonl` and `stderr.log` are captured by the host and are not mounted into the agent.
- `<case>/logs/session.jsonl`, `context.jsonl`, `lifecycle.jsonl`, and firewall logs expose extension behavior.
- `<case>/workspace/.pi/trace.jsonl` records tool activity; workspace outputs remain available for review.
- `proxy/requests.jsonl` records the actual model request/context without authentication headers.
- `target/requests.jsonl` records the synthetic API's independently observed requests.

Greeting assertions include queued messages and false verdict-board creation;
checking just the displayed greeting misses the original bug. Coding is checked
with separate host-supplied assertions, including cases absent from the editable
fixture tests. Cyber success requires the six authenticated/unauthenticated access
controls in the target's own log and a nonempty report. A complete request matrix
is behavioral success with `pending_review`, never a fully reviewed PASS. Report
prose still needs independent review for invented evidence or unsupported
extrapolation. Exit status is `0` only when every case fully passes, `1` for
failed/error controls (including no cases), and `2` when all behavioral controls
pass but report evidence review is pending. A separate review artifact records
that review; it does not rewrite the original run's outcome.

The offline regression suite is `node --test tests/live-evaluation-integrity.test.ts`.
It injects missing/corrupt evidence, interrupted event streams and partial usage,
and confirms later cases still produce results after a case failure.

`verify-failure` intentionally cannot pass its project check. Evaluation success
means the FAIL persists, the agent accurately reports it, exactly one diagnostic
is consumed, and nothing remains queued for the next user request.

The harness removes only the containers/network it created, including on errors.
Network cleanup runs only after successful creation by this invocation.
Validation containers have exact run-owned names and are force-removed in a
finally block, including when the validator CLI times out. Agent timeouts also
terminate the host Docker CLI after a bounded removal attempt, so a failed stop
cannot leave the case awaiting that CLI indefinitely.
Evidence and workspaces remain. A forcibly terminated host process may require
manual cleanup of its exact `pi-eval-<run-id>` resources. Model billing and
backend concurrency can affect timing; this is a small behavioral sample, not a
general model benchmark.
