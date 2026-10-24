# Memory vault

`memory-vault` gives pi durable memory in an **Obsidian-compatible vault**. The default is
`~/.pi/vault`; open that folder as a vault in Obsidian.

```
MEMORY.md                               index of every memory (regenerated)
Memory/<slug>.md                        global memories: apply in every project
Projects/<project>/<project>.md         project hub: memories + recent recaps
Projects/<project>/Memory/<slug>.md     project memories
Projects/<project>/Recaps/<date>.md     automatic per-turn recaps
Projects/<project>/Workflows/<run>/     workflow runs with `vault: true`
Projects/<project>/.pi-project.json     the canonical root that owns this folder
.pi-index/                              search index, lock, errors.log (hidden from Obsidian)
.trash/                                 forgotten notes (recoverable)
```

`<project>` is named after the git root (else the working directory), so every subdirectory of
a repository shares one project. Each project folder records the canonical, symlink-resolved
root that owns it in `Projects/<project>/.pi-project.json`. The first root to open a name keeps
the plain folder, including a folder written before ownership was recorded; another repository
with the same directory name gets `<name>-<hash of its canonical path>`, so it never recalls
or is injected with the first one's recaps and memories. Nothing is moved or deleted
(`tests/memory-vault-smoke.ts`, check 12).

A root reached through a symlink uses the folder its canonical path already owns, whichever
path opened it first. A recorded owner is looked up without taking the vault lock. A folder is
never taken over because its recorded owner path no longer exists, so a moved repository (or a
vault synced from a machine with different checkout paths) starts a `<name>-<hash>` folder. Its
first session then writes a warning to `.pi-index/errors.log` and the session UI naming the
old folder; to keep its history, set `"path"` in that folder's `.pi-project.json` to the new
canonical path (`tests/memory-vault-smoke.ts`, check 12).

## Two kinds of memory

**Automatic: recaps.** After each substantive turn (one with tool calls, or a long answer), a
small model writes a recap: a title, what was done, the next step, files touched, and
decisions. It is appended to `Projects/<project>/Recaps/<date>.md`. Decisions, preferences
and gotchas it flags are promoted to memory notes in that project, deduplicated; a promoted
note is never global (`tests/memory-vault-smoke.ts`, check 5). Trivial turns and subagent
children are skipped. The first prompt of every new session gets the last three recaps, so
pi knows where you left off.

**On request: memory notes.** When you say "remember …", the agent uses the `memory` skill
and `memory_save`. One note per memory, with frontmatter (`type: fact | decision | preference
| gotcha | reference`, `scope`, `tags`, dates, `source`). Saving something with the same or a
near-identical title updates the existing note instead of copying it.

## Recall

Memories are recalled into a **hidden message** before your prompt, never into the system
prompt (that would break prompt caching). Recall is scoped to the current project plus
global memories. It is gated by relevance (BM25 with stopwords and stemming, a minimum score,
and two matching terms for multi-word prompts). Each memory is injected at most once per
session.

## Commands and tools

| | |
| --- | --- |
| `/remember <text>` | Save directly (`/remember global: …` for every project) |
| `/memory` | Status: vault path, counts, settings |
| `/memory recent` | Latest recaps for this project |
| `/memory search <q>` · `/memory forget <id>` · `/memory migrate` | Search, forget (to `.trash`), import memory-local |
| `memory_save`, `memory_search`, `memory_forget` | The agent's tools |

## Settings

`~/.pi/agent/pi-kit/memory.json` (environment variables override it):

```json
{
  "vault": "~/.pi/vault",
  "recaps": true,
  "recapModel": "openrouter/deepseek/deepseek-v4.1-flash",
  "autoPromote": true,
  "recallLimit": 3,
  "minScore": 1.5
}
```

The matching variables are `PI_KIT_VAULT`, `PI_KIT_RECAPS`, `PI_KIT_RECAP_MODEL`,
`PI_KIT_MEMORY_AUTOPROMOTE`, `PI_KIT_MEMORY_RECALL_LIMIT` and `PI_KIT_MEMORY_MIN_SCORE`.
`recapModel` should be a cheap, fast model. The default is the session's model.

Secrets (tokens, keys, `password=`-style values) are redacted before anything is written.
`/save --project <p>` also writes into the vault's project folder when the vault exists.

The older `memory-local` store (`~/.pi/agent/memory-local/memories.json`) is imported
automatically once. Do not load `memory-local` next to `memory-vault`: both register
`memory_search`, and pi keeps only one of them.
