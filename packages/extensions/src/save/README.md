# save

`/save` writes a check-in snapshot of the session to disk. It does **not**
compact the conversation. The snapshot is for a human to read, and for another
agent or session to continue the work.

## What it does

1. It runs pi's own compaction summarizer (`generateSummary`) over the current
   branch as a side call, with extra instructions: current goal, step in
   progress, exact next action, blockers, and the paths and IDs the next agent
   needs. The session messages do not change.
2. The extension writes the result. The model does not write it, so the file
   exists even if the model narrates a tool call it never made.
   - `<target>/Latest Compact.md`: overwritten on every save.
   - `<target>/Compacts/YYYY-MM-DD HHmmss - save.md`: one log file per save.
3. It masks common secret shapes (private keys, `glpat-`, `ghp_`, `github_pat_`,
   AWS key IDs, `sk-`, JWTs, `Authorization: Bearer`/`Basic`/`token` headers,
   credentials in URLs such as `postgres://user:pass@host`, `password=`) before
   it writes. The header, `github_pat_` and URL shapes are tool-capture's
   patterns (`tests/save-smoke.ts`, `testRedactsToolCaptureShapes`).
4. For a vault project, it queues one prompt that tells the agent to update the
   project's `Current State.md` and save durable facts to memory. If the agent
   is busy, the prompt waits as a follow-up.

It also copies every real compaction summary (`/compact`, automatic compaction,
`/compress`) to the same target as a `compact` or `compress` log entry. So
`Latest Compact.md` always holds the newest summary of either kind.

## Where it writes

| Setting | Target |
|---|---|
| `PI_KIT_SAVE_VAULT` set and a project chosen | `<vault>/10_Projects/<project>/` |
| `PI_KIT_SAVE_DIR` set | that directory (relative to the workspace) |
| neither | `<workspace>/.pi/snapshots/` |

The project must already exist under `10_Projects/`. `/save` never creates a
project folder. The name match ignores case.

Project choice, in order: `--project`, the project of the last `/save` in this
session, `PI_KIT_SAVE_PROJECT`, then a picker (interactive mode only).

## Usage

```text
/save
/save --project "Pi Agent Kit"
/save --project "Pi Agent Kit" halfway through the TTL fix
/save --no-update            # write the snapshot only, no agent prompt
/save --update               # also prompt the agent when there is no project
```

Text that is not a flag becomes an operator note. The note goes into the file
and into the summarizer instructions.

To continue in a new session:

```text
Read vault/10_Projects/Pi Agent Kit/Latest Compact.md and continue from its next action.
```

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PI_KIT_SAVE_VAULT` | unset | Vault root. Turns on project targets. |
| `PI_KIT_SAVE_PROJECT` | unset | Default project |
| `PI_KIT_SAVE_DIR` | `.pi/snapshots` | Target when no project is chosen |
| `PI_KIT_SAVE_ON_COMPACT` | on | `0` stops copying compaction summaries |
| `PI_KIT_SAVE_TIMEOUT_MS` | `180000` | Summary call timeout |
| `PI_KIT_SAVE_RESERVE_TOKENS` | `16384` | Output budget for the summary (80% is used) |

## Notes

- `/save` makes one model call with the current model. It needs request auth for
  that model. If the call fails, nothing is written.
- In interactive mode the summary runs in the background, so you can keep
  working. A notification shows the file path when the write finishes. A local
  27B model took about 140 s in testing. In print and SDK modes, `/save` waits
  for the write. Only one save runs at a time.
- The snapshot covers the session as it was when you typed `/save`.
- The redaction is a safety net, not a guarantee. Read a snapshot before you
  share it.
- The agent-update step is a normal prompt. Its result depends on the model.
  Check `Current State.md` after it runs.
