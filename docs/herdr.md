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
set), and never in a subagent child. The one exception is the operator's `/herdr` command (below),
which works from any session. It registers no tools.

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

## The `/herdr` command

A small client for the herdr server, for the operator. It runs the `herdr` CLI found on `PATH`
(argument list, no shell, 10-second timeout) and works from any Luna session, inside a herdr pane
or not. It is not registered in a subagent child or with `PI_KIT_HERDR=off`, and it is a command,
not a tool: the model cannot call it.

| Command | What it does |
| --- | --- |
| `/herdr list` | Every agent herdr knows: its name (or pane), kind, state and directory |
| `/herdr read <agent> [lines]` | The agent's recent terminal output, 1 to 200 lines (default 40), with escape sequences and control characters removed, redacted, and capped at 8000 characters |
| `/herdr send <agent> <text>` | Submits `<text>` as a prompt (`herdr agent prompt`), at most 4000 characters and no control characters |
| `/herdr spawn <label> [dir]` | Opens a workspace in `dir` (default: the session's directory), always with `--no-focus` |

It never answers another agent's dialog: `send` asks herdr for the agent's state first and refuses
an agent that is `blocked` (waiting on an approval or a question), and herdr itself rejects a prompt
to a blocked agent (`agent_blocked`), which `/herdr` reports with "Nothing was sent". It never moves
focus: it has no focus, keys, attach or close command, and `spawn` passes `--no-focus`. A target
must look like an agent name or herdr id, so it cannot be read as a CLI option. Pinned by
`tests/herdr-smoke.ts` (`tests/herdr-client-checks.ts`) against a fake `herdr` on `PATH`.

Not covered: `send` does not wait for the agent to finish, and the state check and the prompt are
two calls, so an agent that becomes blocked between them is refused by herdr rather than by Luna.

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

## Agent mailboxes

`packages/core/shared/agent-mailbox.ts` lets agents on the machine leave each other short messages:
one inbox per agent id in `~/.local/state/luna/mailbox/<id>/` (beside the agent-state files; override
with `LUNA_MAILBOX_DIR`), one 0600 JSON file per message in a 0700 inbox. It is a library; no tool or
command uses it yet.

- `sendMessage` and `receiveMessages` check the caller against its agent-state file: the file must
  exist for the id, be a regular file and name the calling process's pid. The recipient must have one
  too.
- Subject (one line, 160 characters) and body (8,000 characters) pass through the kit's redaction table
  before they are stored.
- An inbox holds at most 100 messages and 512 KiB; a full one refuses. A message file over 64 KiB, a
  link or anything not a message is skipped on read.
- A symbolic link at the mailbox root, an inbox, a message or an agent-state file is refused, never
  followed; a message is created exclusively.

A message is data, never an instruction or an approval. Not covered: every agent runs as the same
user, who can write these files directly, so the pid check stops one agent impersonating another
through the library, not a determined process of that user; nothing is signed or encrypted.
`tests/agent-mailbox-smoke.ts` pins each rule.

herdr decides whether to display a notification (it may be disabled, rate limited or have no
foreground client); Luna sends it and moves on, and never waits on herdr.

Not covered: a custom profile that does not include the extension gets no notifications; add `herdr`
to it to enable it (it is a no-op outside herdr).
An aborted or failed run does not raise "finished". Autonomous runs (`/autonomy`) run in a container and do not emit attention events, so a
blocked run does not notify herdr. `tests/herdr-smoke.ts` pins the herdr side against a stubbed
socket; `tests/firewall-approvals-smoke.ts` and `tests/human-console-broker-smoke.ts` pin the approval
and question events. The verify-gate failure notice is not pinned by a test, and nothing tests against
a live herdr.
