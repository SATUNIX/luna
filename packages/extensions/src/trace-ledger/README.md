# trace-ledger

Structured observability ledger at layer 6. Records tool calls, tool results, agent boundaries, and turn summaries to `.pi/trace.jsonl`. Powers post-session analysis and provides raw material for the skill-forge self-improvement loop.

The ledger is never truncated. Before an append, a ledger over 4 MiB is renamed to
`.pi/trace.jsonl.1`, replacing the previous copy, and a fresh file is started; `/trace` reads a
bounded tail of the live file only (`tests/trace-ledger-bound-smoke.ts`).
