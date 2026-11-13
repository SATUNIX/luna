# herdr

[herdr](https://herdr.dev) is a terminal workspace manager for running several coding agents side
by side. Luna works in it unchanged, and two pieces make it better. They are independent: either
works without the other.

## herdr's own pi integration

```sh
herdr integration install pi
```

This writes `herdr-agent-state.ts` into pi's extensions directory. It reports whether the pane's
agent is working, blocked or idle, and which session it is. Luna does not copy it. It is managed by
herdr, so update it with herdr.

## Luna's `herdr` extension

Enabled by the `lite`, `balanced`, `long-horizon`, `self-improving` and `engagement` profiles. It does
nothing unless pi runs inside a herdr pane (`HERDR_ENV=1`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`
set), and never in a subagent child. It registers no tools or commands.

| Luna event | What herdr shows |
| --- | --- |
| A tool-firewall approval card opens | A "Luna needs you" notification, and the pane marked blocked until the card closes |
| `ask_human` asks a question | The same |
| An automatic verify check fails | A "Luna: a check failed" notification |
| A run of 30 seconds or longer ends | A "Luna finished" notification |

The blocked state reaches herdr through the `herdr:blocked` event on pi's event bus, which herdr's
pi integration turns into the pane state. Without that integration herdr still shows the
notifications, but not the blocked state from Luna.

Other extensions announce themselves on the `luna:attention` bus channel: a payload with a boolean
`active` opens or closes a blocking ask, one without it is a one-off notice. They never import the
herdr extension, so it can be removed or replaced without touching them.

| Variable | Effect |
| --- | --- |
| `PI_KIT_HERDR=off` | Disable the extension |
| `PI_KIT_HERDR_NOTIFY_MIN_SECONDS` | Shortest run that raises "finished" (default 30, `0` for every run) |

## The agent-state file

Every Luna agent that reports its state writes one small JSON file, `<id>.json`, in
`~/.local/state/luna/agents` (override with `LUNA_AGENT_STATE_DIR`; never under pi's agent
directory). The schema (`packages/core/shared/agent-state.ts`, one writer with generated copies):

| Field | Meaning |
| --- | --- |
| `state` | `working`, `blocked`, `done`, `failed`, `stopped` or `parked` |
| `waitingFor` | Only while `blocked`: the approval or question, in a line |
| `tail` | The last 400 characters of what the agent said or did |
| `worktree`, `costUsd` | Where it works and what it has spent, when known |
| `source`, `pid`, `since`, `updatedAt` | `session` or `autonomy`; the process; when the state last changed; the last write |

The `herdr` extension writes one for its pane (`pi-<pid>`): done while a new session sits idle at the prompt, working when a run starts, blocked with
the approval or question while one is open, then done, stopped (aborted, or pi exiting mid-run) or failed
when it ends, or parked when a ceiling parks the run (`tests/herdr-smoke.ts`). Autonomous runs write `autonomy-<run>` and an `outcome.md`
([the run directory](autonomy.md#the-run-directory)). A reader needs only the directory:
`readAgentStates` returns the valid files and ignores the rest. The file is a status report, not an
instruction, and a failed write never affects the agent.

Not covered: only a session inside herdr writes a file (the extension is a no-op elsewhere); the web
console does not read the files yet; there is no `luna agents` command. A killed process leaves its
last state in place, so check `pid` and `updatedAt` before trusting `working`.
`tests/agent-state-smoke.ts` pins the schema and the autonomy mapping; `tests/herdr-smoke.ts` pins
the blocked-approval state.

herdr decides whether to display a notification (it may be disabled, rate limited or have no
foreground client); Luna sends it and moves on, and never waits on herdr.

Not covered: a custom profile that does not include the extension gets no notifications; add `herdr`
to it to enable it (it is a no-op outside herdr).
An aborted or failed run does not raise "finished". Autonomous runs (`/autonomy`) run in a container and do not emit attention events, so a
blocked run does not notify herdr. `tests/herdr-smoke.ts` pins the herdr side against a stubbed
socket; `tests/firewall-approvals-smoke.ts` and `tests/human-console-broker-smoke.ts` pin the approval
and question events. The verify-gate failure notice is not pinned by a test, and nothing tests against
a live herdr.
