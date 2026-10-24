# Memory vault, compaction and context assembly

This page covers how the kit keeps context useful over a long session and across sessions. It maps the durable memory vault and its per-turn recaps, the assembly of contribution files into the system prompt and one hidden message, the compaction state that `session-helpers` computes and publishes, the triggers and summarisers that decide when and how a session is compacted, and one run that touches all of them. Each section names the hooks, files and environment variables involved. The six diagrams show the components and data flow, context assembly, the memory lifecycle, the compaction state and triggers, the summary path, and one run end to end.

pi separates durable memory (memory-vault, an Obsidian-compatible Markdown vault under `~/.pi/vault` by default) from in-session context assembly (context-sieve, the single reader of `.pi/ctx-contributions/sessions/<session-id>/*.json`; the flat `.pi/ctx-contributions/*.json` directory is the fallback when no session id is available). context-sieve merges those files into the system prompt or one hidden message. The `effort` extension may also return a system prompt, but only through its own marked block. Memory is managed by explicit tools (`memory_save`, `memory_search`, `memory_forget`, `/remember`, `/memory`) and automatically by per-turn recaps produced at `agent_end`.

Compaction is triggered by pi itself (at the context window minus `reserveTokens`, plus overflow recovery), by the kit's fixed-budget `trigger-compact` (default 100k tokens) when that would fire first, or manually (`/compress`, `/compact`, `/trigger-compact`). Summaries are produced natively by pi, deterministically by `/compress`, or, without compacting, by `save`'s check-in summariser. `goal-core` persists `.pi/GOAL.yaml` and re-materialises the goal contribution at every `session_start` while a goal is set, so the goal reaches the model through ordinary prompt assembly and survives compaction. context-sieve's `session_before_compact` is an explicit no-op that does not read `GOAL.yaml`; `/compress` reads `.pi/GOAL.yaml` itself and pins it above the conversation as `## Active goal`.

## Component and data flow

Producers write JSON contribution files into `<cwd>/.pi/ctx-contributions/` (session-scoped at `<cwd>/.pi/ctx-contributions/sessions/<session-id>/` when the host exposes a session id, with the flat directory as the fallback). context-sieve is the only component that reads them and decides what becomes part of the system prompt and what becomes its one hidden message. It is not the only source of hidden messages: memory-vault injects its own (`memory-recall`) and skill-router adds a `skill-router` message listing matching skills (nothing pins either message), `effort` adds its standing-mode reminder (`tests/effort-standing-smoke.ts`), and progress-guard's `turn_end` returns its looping nudge as a hidden `custom_message` entry inside the run that is looping, besides writing it as a contribution for the next prompt (`tests/progress-guard-agsix-smoke.ts`). memory-vault and the compaction extensions write to disk independently of the assembly path.

```mermaid
flowchart LR
    P["Producers: goal-core, guidelines, caveman, orchestrator, memory-local, progress-guard, recovery-orchestrator, autonomous-loop, conductor, plan-mode"]
    CF[("ctx-contributions/sessions/ID/*.json, or the flat directory")]
    CS["context-sieve"]
    SP["System prompt"]
    HM["Hidden message: context-sieve"]
    GK[("project .pi/GOAL.yaml")]
    MV["memory-vault"]
    V[("Vault directory: Memory, Projects/p/Memory, Projects/p/Recaps, MEMORY.md, .pi-index, .trash")]
    RM["Hidden message: memory-recall"]
    PGT["progress-guard turn_end"]
    PGM["Hidden message: progress-guard, inside the run"]
    CP["compress"]
    SV["save"]
    SN[("Latest Compact.md and Compacts/*.md")]

    P --> CF
    CF --> CS
    CS --> SP
    CS --> HM
    GK -.->|"re-materialised at session_start"| P
    GK -.->|"pinned as Active goal"| CP
    MV <--> V
    MV --> RM
    PGT --> PGM
    CP -->|"/compress summary"| SN
    SV -->|"/save snapshot and compaction copies"| SN
```

Relevant environment variables and files: `PI_KIT_VAULT` (vault root), `PI_KIT_CTX_BUDGET_TOKENS` and `PI_KIT_CTX_MESSAGE_BUDGET_TOKENS` (context-sieve budgets), `PI_KIT_COMPACT_THRESHOLD_TOKENS` (trigger-compact threshold), `PI_KIT_COMPRESS_MAX_CHARS` (`/compress` budget), `PI_KIT_SAVE_VAULT` (save target vault) and `PI_KIT_SAVE_ON_COMPACT`. Without a vault, `save` writes to `<cwd>/.pi/snapshots`.

## Context assembly (ctx-contributions to system prompt and hidden message)

context-sieve creates its session directory at `session_start` (`<cwd>/.pi/ctx-contributions/sessions/<session-id>/`, or the flat `<cwd>/.pi/ctx-contributions/` when no valid session id is available) and reads it at each `before_agent_start`. It ignores leftovers from a prior session by skipping files whose modification time is older than the process-start epoch minus a 2 s grace window that absorbs coarse filesystem timestamps. The epoch is captured once at module load, before any extension's `session_start` handler runs, so the skip rule does not depend on extension load order: a producer that re-materialises its contribution before or after context-sieve's handler is still included. A contribution file larger than 256 KiB (`MAX_CONTRIBUTION_BYTES`) is skipped before parsing. A non-finite or absent `priority` is treated as `0`, and ties are broken by `id`, so assembly order is deterministic whatever the directory-read order. In the flat fallback directory, files written earlier in the same process are newer than the epoch and are never aged out; restart the process to shed them.

Contributions with an explicit `channel` go where they ask; otherwise the ids in `DYNAMIC_IDS` (per-turn content such as memory, delegation and loop nudges) go to the hidden message and the rest go to the system prompt. Each channel is budgeted and truncated separately.

```mermaid
flowchart TD
    S["session_start: create the session directory, clear lastInjected"]
    R["before_agent_start: read *.json except sieve-budget.json"]
    SK{"mtime older than the process-start epoch minus 2 s?"}
    SKIP["skip as a prior-session leftover"]
    BIG{"over 256 KiB, or not a valid contribution?"}
    DROP["skip the file"]
    CH{"channelOf: explicit channel, or id in DYNAMIC_IDS?"}
    SY["system list"]
    MS["message list"]
    WIN["budgetFor: scale each budget to the model's context window"]
    BS["assembleWithBudget: sort by priority desc then id, cap at the smaller of own and remaining budget, truncate"]
    SAME{"any contribution new or changed since lastInjected?"}
    OUT1["systemPrompt = event.systemPrompt plus blocks"]
    OUT2["hidden message: customType context-sieve, display false"]
    NOMSG["do not inject the message again"]
    TL[("session directory sieve-budget.json telemetry")]

    S --> R
    R --> SK
    SK -->|yes| SKIP
    SK -->|no| BIG
    BIG -->|yes| DROP
    BIG -->|no| CH
    CH -->|"id not in DYNAMIC_IDS"| SY
    CH -->|"id in DYNAMIC_IDS"| MS
    SY --> WIN
    MS --> WIN
    WIN --> BS
    BS --> OUT1
    BS --> SAME
    SAME -->|"yes: inject only those, name the unchanged ones"| OUT2
    SAME -->|no| NOMSG
    OUT1 --> TL
    OUT2 --> TL
    NOMSG --> TL
```

Budgets are 4096 system tokens (`PI_KIT_CTX_BUDGET_TOKENS`) and 1200 message tokens (`PI_KIT_CTX_MESSAGE_BUDGET_TOKENS`), with `CHARS_PER_TOKEN = 4`, and each contribution's own `budgetTokens` is applied as well. With a known model context window the defaults are cut to 10% (system) and 3% (message) of the window when that is smaller, never below 64 tokens, and any budget, even an explicit one, is held to half the window. An unknown window (no model, or `contextWindow <= 0`) keeps the configured numbers and is recorded as `null` in `sieve-budget.json`, together with `windowClamped`. Message-channel contributions are compared one by one with `lastInjected`, a map from contribution id to the text last injected for it this session. Only new or changed contributions are injected; the unchanged ones are named in a single "(Still current, injected earlier in this conversation: ...)" line, and when nothing is new or changed no message is injected and `message.skippedUnchanged` is `true`. The injected ids are recorded under `message.injected` in `sieve-budget.json`. A contribution that disappears is dropped from `lastInjected`, so it is injected again if it comes back, and `lastInjected` is cleared at `session_start` and after every compaction (`tests/context-budget-smoke.ts`).

## Memory lifecycle (save, search, recap)

Explicit tools and the automatic recap queue both write deduplicated Markdown notes into scope-specific vault folders. Search and recall read a BM25 index built from those notes, but only the automatic recall path applies the relevance floor. Subagent children never recap or recall. The first prompt of a session also gets the three most recent recaps ("Where we left off") and the pinned memories; every prompt gets at most `recallLimit` (3) memories that clear the floor (`minScore` 1.5 and, for multi-term queries, two matching terms), each memory at most once per session. The recall message is capped at 2400 characters and is cleared for reinjection at compaction.

```mermaid
flowchart LR
    T1["memory_save tool"]
    T2["/remember command"]
    AGR["agent_end: digestTurn, then the isTrivial check"]
    RC["recap model: recapModel or the session model, 90 s timeout, at most 2 pending"]
    PR["parseRecap"]
    AR["appendRecap"]
    AP["autoPromote: decision, preference, gotcha"]
    SM["saveMemory: redact, slugify, dedupe, atomic write under withLock"]
    FG["memory_forget: move to .trash"]
    PG["writeIndexPages: MEMORY.md and Projects/p/p.md"]
    ID[("index.json in .pi-index: mtimeMs, meta, tf, len, tokens, titleTokens")]
    RF[("Projects/p/Recaps/YYYY-MM-DD.md")]
    MO[("Memory/slug.md or Projects/p/Memory/slug.md")]
    QS["memory_search and /memory search: loadIndex plus BM25, no floor"]
    RCL["recall at before_agent_start: BM25 gated by passesFloor"]
    RM["hidden message: memory-recall"]

    T1 --> SM
    T2 --> SM
    AGR --> RC
    RC --> PR
    PR --> AR
    AR --> RF
    PR --> AP
    AP --> SM
    SM --> MO
    SM --> PG
    AR --> PG
    FG --> PG
    PG --> ID
    MO --> ID
    ID --> QS
    ID --> RCL
    RF --> RCL
    RCL --> RM
```

## Compaction state and triggers

`session-helpers` computes the effective compaction state in `compaction-state.ts` from the real settings files, using pi's own precedence: global `<agent dir>/settings.json`, then the project's `.pi/settings.json` deep-merged over it (the project wins, and an untrusted project's file is not read). `compaction.enabled` defaults to on, `reserveTokens` to 16384 and `keepRecentTokens` to 20000, and pi's own trigger is the context window minus `reserveTokens`. The state is published on `globalThis[Symbol.for("pi-kit.compaction")]` as `{ enabled, thresholdTokens, reason }`, where `thresholdTokens` is the earliest automatic trigger (pi's or the kit's). `custom-footer` reads it, and `/compaction` shows and changes it. It is recomputed at `session_start`, `model_select` and `before_agent_start`, and cleared at `session_shutdown`. When compaction is off, the model reports no window, or `reserveTokens` leaves no room, the state carries a `reason` that is warned about once per session.

`trigger-compact` adds a fixed-budget trigger, `PI_KIT_COMPACT_THRESHOLD_TOKENS` or `/compact-threshold` (saved in `<agent dir>/pi-kit/trigger-compact.json`, default 100k). It is level-triggered and re-arms once usage is back at or below the threshold. It obeys both switches (pi's `compaction.enabled` and its own on/off) and never fires in a one-shot child (a subagent, or print or JSON mode), because `ctx.compact()` aborts the running agent. It stands down when pi's own trigger is at or below the kit threshold, or when pi is about to compact on this turn anyway, so the two never fire together. A turn that ends without tool calls is the end of a run, so the trigger waits for `agent_settled` instead of aborting a run that is finishing. A compaction that has to interrupt a live run sends a resume message when it completes, unless something else has already continued the run.

```mermaid
flowchart TD
    SET[("pi settings: global, then project when trusted")]
    KTS[("trigger-compact.json and PI_KIT_COMPACT_THRESHOLD_TOKENS")]
    WIN["model context window"]
    CSTATE["computeCompactionState in compaction-state.ts"]
    PUB[("globalThis pi-kit.compaction: enabled, thresholdTokens, reason")]
    FT["custom-footer and the /compaction command"]
    SET --> CSTATE
    KTS --> CSTATE
    WIN --> CSTATE
    CSTATE --> PUB
    PUB --> FT

    TE["turn_end: ctx.getContextUsage tokens"]
    A1{"tokens above the kit threshold and the trigger armed?"}
    REARM["re-arm once usage is at or below the threshold"]
    A2{"kit trigger on, pi auto-compaction on, not a one-shot child, turn not aborted?"}
    A3{"pi's own trigger at or below the kit threshold, or reached this turn?"}
    STAND["stand down: pi compacts by itself, inside the run"]
    A4{"turn ended without tool calls?"}
    SETTLE["wait for agent_settled, then ctx.compact"]
    LIVE["ctx.compact on the live run, then a resume message when it completes"]
    TE --> A1
    A1 -->|no| REARM
    A1 -->|yes| A2
    A2 -->|no| STAND
    A2 -->|yes| A3
    A3 -->|yes| STAND
    A3 -->|no| A4
    A4 -->|yes| SETTLE
    A4 -->|no| LIVE
```

## Compaction summaries

Manual commands and automatic compaction all pass through `session_before_compact`, which decides who produces the summary, and then `session_compact`, where other extensions react to the new summary. context-sieve and `custom-compaction` return `undefined` from `session_before_compact`, because pi's hook can cancel or replace the summary but cannot amend the summariser's instructions. `/save` is separate: it runs pi's summariser over the current branch as a side call and writes the snapshot, and the session is not compacted.

```mermaid
flowchart TD
    CMDS["/trigger-compact, /compact, /compress"]
    AUTO["kit trigger, or pi's own threshold and overflow recovery"]
    SBC["session_before_compact"]
    NOOP["context-sieve and custom-compaction: no-op, return undefined"]
    CMP{"instructions start with the compress marker?"}
    DET["compress: deterministic summary, active goal pinned"]
    NAT["pi native LLM summary"]
    SC["session_compact"]
    MVC["memory-vault: clear the injected set"]
    CSC["context-sieve: clear lastInjected"]
    SVC["save: copy the summary to Latest Compact.md and Compacts"]
    SAVE["/save: summariser side call, no compaction"]
    CMDS --> SBC
    AUTO --> SBC
    SBC --> NOOP
    SBC --> CMP
    CMP -->|yes| DET
    CMP -->|no| NAT
    DET --> SC
    NAT --> SC
    SC --> MVC
    SC --> CSC
    SC --> SVC
    SAVE --> SVC
```

The default threshold is 100k tokens. `/compress` uses `PI_KIT_COMPRESS_MAX_CHARS` (default 16000, minimum 4000) and keeps the first turn, the newest turns and, within budget, a share of the earlier summary. `save` skips the on-compact copy when `PI_KIT_SAVE_ON_COMPACT` is exactly `"0"`. The `compress` extension only acts when the custom instructions begin with its `[[pi-kit:compress]]` marker, so `/compact` and automatic compaction keep pi's native LLM summary.

## One run end to end

A single session showing the compaction state being published, goal persistence, context assembly, recap writing, and a threshold-triggered compaction whose summary is copied to disk.

```mermaid
sequenceDiagram
    participant User
    participant SH as session-helpers
    participant GK as goal-core
    participant Sieve as context-sieve
    participant Model
    participant MV as memory-vault
    participant Vault
    participant TC as trigger-compact
    participant PI as pi
    participant Save as save

    SH->>SH: session_start: compute the compaction state and publish it
    User->>GK: /goal text
    GK->>GK: write .pi/GOAL.yaml and the goal-core.json contribution
    Note over Sieve: session_start creates the session contribution directory
    User->>Sieve: prompt
    Sieve->>Sieve: read contributions, split channels, budget to the model window
    Sieve-->>Model: system prompt plus a hidden context-sieve message
    MV-->>Model: hidden memory-recall message, the first prompt also gets recaps and pinned memories
    Model-->>User: answer
    MV->>MV: agent_end: digestTurn, then the recap model
    MV->>Vault: appendRecap and promote decision, preference and gotcha candidates
    TC->>TC: turn_end: tokens over the kit threshold, pi's own trigger is later
    TC->>PI: ctx.compact
    PI->>Sieve: session_before_compact
    Sieve-->>PI: undefined, so the native summary is used
    PI->>Save: session_compact
    Save->>Vault: copy the summary to Latest Compact.md and Compacts
    PI->>Sieve: session_compact
    Sieve->>Sieve: clear lastInjected
    PI->>MV: session_compact
    MV->>MV: clear the injected set
```

## Source files

- `packages/extensions/src/context-sieve/index.ts` — assembly of `.pi/ctx-contributions/sessions/<id>/*.json` (or the flat directory), channels, budgets scaled to the context window, `sieve-budget.json`, no-op `session_before_compact`.
- `packages/extensions/src/goal-core/index.ts` — `/goal`, `.pi/GOAL.yaml` and the re-materialised `goal-core.json` contribution.
- `packages/extensions/src/memory-vault/index.ts` — memory tools, recaps, recall, the hidden `memory-recall` message.
- `packages/extensions/src/memory-vault/vault.ts` — vault disk layout, config, index, dedupe, index pages, migration.
- `packages/extensions/src/memory-vault/recap.ts` — recap prompt, parse and promote.
- `packages/extensions/src/memory-vault/search.ts` — BM25 search and the relevance floor.
- `packages/extensions/src/session-helpers/compaction-state.ts` — `computeCompactionState`, `publishCompaction`, the published `pi-kit.compaction` shape and the once-per-session warning.
- `packages/extensions/src/session-helpers/index.ts` — the `/compaction` command and the hooks that refresh and publish the state.
- `packages/extensions/third_party/trigger-compact/index.ts` — threshold trigger, stand-down rules, `/trigger-compact` and `/compact-threshold`.
- `packages/extensions/third_party/custom-footer/data.ts` — reads the published compaction state.
- `packages/extensions/src/compress/index.ts` — `/compress`, the deterministic summary and the pinned goal.
- `packages/extensions/src/custom-compaction/index.ts` — no-op `session_before_compact` and the unsupported-template notice.
- `packages/extensions/src/save/index.ts` — `/save`, and the copy of each compaction summary to `Latest Compact.md`.
- `packages/extensions/src/guidelines/index.ts` — an example contribution producer.
- `packages/extensions/src/progress-guard/index.ts` — the loop nudge: a contribution for later prompts and the hidden `turn_end` `custom_message` inside the run.
