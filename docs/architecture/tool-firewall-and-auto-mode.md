# Tool firewall and auto mode

> Diagrams reflect the change that added `approvals.ts` (scoped, revocable approvals), the labelled outcomes and `unattended.ts`. If the code has changed since, regenerate them. They are Mermaid; the site needs the Mermaid custom fence enabled in `mkdocs.yml` to draw them, and otherwise shows them as code.

The `tool-firewall` extension decides, before every tool call runs, whether it may proceed, parsing shell commands and non-shell tools, classifying them into effects and one of four tiers, folding in session history, then either allowing, denying, or asking a human. In `auto` mode with the `coding` policy a small in-process judge decides medium actions, and high actions only when the operator previously allowed something similar in the same workspace. `manual` mode routes medium and high actions to the operator; the `engagement` policy does too, except that in `auto` mode a medium action whose effects are all `read` or `network_read` reaches the judge. Operator requests render as a bounded approval card or, headless, through the human-console broker. Every refusal is exactly one of three labelled outcomes: HARD DENY (policy says never), UNCERTAIN (the automatic layers could not settle it, or nobody could be asked) or OPERATOR DECISION (a human allowed or denied it); a high-confidence judge block is a fourth, labelled case. What the operator allows is remembered only as a scoped, inspectable, revocable approval. A worker started by the autonomy supervisor inside a container boundary runs in unattended mode: no prompts and no judge inside the zone, hard classes and anything outside the zone refused. `protected-paths` runs as a separate `tool_call` hook that blocks writes to secrets, control surfaces and firewall state.

## Components and where state lives

The firewall is wired through three `pi.on` hooks (`session_start`, `before_agent_start`, `tool_call`) plus a sibling `protected-paths` hook. Runtime configuration comes from `firewall.json` with environment overrides, the policy comes from `default-policy.json`, and all durable state lives under `~/.pi/agent/pi-kit/` and `<cwd>/.pi/`. Unattended mode is not configuration: it is decided once from the supervisor's environment and a read-only contract file.

```mermaid
flowchart LR
    subgraph hooks["pi tool_call hooks, in load order"]
        PPH["protected-paths hook"]
        SG["secret-guard hook, when enabled"]
        FW["tool-firewall decide()"]
    end
    subgraph analysis["analysis"]
        CL["classifyToolCall and parseShell"]
        TR["trajectoryFindings"]
        JG["judge runJudge, with confidence"]
        CARD["buildCard"]
    end
    subgraph operator["asking someone"]
        UI["interactive card, bounded"]
        BR["brokerApproval, bounded"]
        HC["human-console watcher"]
    end
    subgraph state["durable state"]
        CFG["firewall.json and env overrides"]
        POL["default-policy.json"]
        APR["firewall-approvals.json"]
        FB["firewall-feedback.jsonl and firewall-judgements.jsonl"]
        PRO["firewall-profile.json"]
        SES["firewall-sessions SESSION.json"]
        AUD["tool-firewall-audit.jsonl"]
        PEND["human-console pending and resolved"]
    end
    ENV["supervisor env: PI_KIT_UNATTENDED, _BOUNDARY, _CONTRACT"] --> UN["unattended.ts, decided once at load"]
    CON["read-only contract.json"] --> UN
    PPH --> FW
    SG --> FW
    FW --> CL
    FW --> TR
    FW --> JG
    FW --> CARD
    FW --> UN
    CARD --> UI
    CARD --> BR
    BR --> PEND
    PEND --> HC
    HC --> UI
    FW --> APR
    FW --> FB
    FB --> PRO
    FW --> CFG
    FW --> POL
    TR --> SES
    FW --> AUD
    ROOT["root session env PI_KIT_FIREWALL_ROOT_SESSION"] --> APR
    SUB["subagents inherit the root session and the unattended env"] --> ROOT
```

`protected-paths` blocks writes to secrets, the control surfaces, the firewall's state (including `firewall-approvals.json`) and the unattended contract path, plus `.git/`, `node_modules/`, `.pi/agents/`, `.pi/pentest/` and `.pi/engagement/` under the engagement policy (`PI_KIT_PROTECTED_PATHS` can only add entries; `PI_KIT_WRITE_ALLOWLIST` switches it to allowlist mode).

## Decision pipeline

Inside `decide`, the call is hashed, classified into findings, enriched with operator regex rules and trajectory findings, reduced to a tier, and summarised before any allow or block decision. Critical is a HARD DENY at once. In an unattended run the contract's rules apply next. Low runs. Everything else enters the approval, precedent, judge and operator path.

```mermaid
flowchart TD
    A["tool_call event"] --> B["toolName and input"]
    B --> C["actionHash sha256"]
    C --> D["classify shell and tools"]
    D --> E["operator regex rules"]
    E --> F["trajectory findings"]
    F --> G["effects recompute"]
    G --> H["effectiveTier"]
    H --> I["summarize and signature"]
    I --> J{"tier critical?"}
    J -- yes --> HD["HARD DENY, labelled"]
    J -- no --> U{"unattended run and still valid?"}
    U -- yes --> UZ["zone rules: see the unattended diagram"]
    U -- no --> K{"tier low?"}
    K -- yes --> L["allow by analyser"]
    K -- no --> M["approvals, precedents, judge, operator"]
```

## Decision matrix by mode and policy

The effective matrix depends on mode and policy. `manual` never auto-approves a new action above low and the judge is never called; only an exact approval given for this session, workspace and directory runs without asking. `auto` with `coding` lets the judge decide medium actions, and high actions only when the operator allowed something similar in this workspace; `engagement` disables learning and approvals and denies high actions when no operator is present. An exact approval never overrides a hard deny.

```mermaid
flowchart TD
    S["tier low"] --> A1["allow"]
    C["tier critical"] --> D1["HARD DENY"]
    M["tier medium"] --> MG{"exact approval here?"}
    MG -- yes --> MA["allow without asking"]
    MG -- no --> Q{"mode and policy"}
    Q -- manual --> H1["ask the operator"]
    Q -- "auto, coding" --> J1["judge"]
    Q -- "auto, engagement" --> R1{"effects only read or network_read?"}
    R1 -- yes --> J1
    R1 -- no --> H1
    J1 -- allow --> J2["allow"]
    J1 -- "block, high confidence or no confidence" --> JB["AUTO-MODE BLOCK, reason to the agent"]
    J1 -- "block unsure, unavailable, timeout" --> UNC["UNCERTAIN: escalate"]
    UNC --> H1
    H1 --> HR{"operator reachable?"}
    HR -- "card or console answers" --> OD["OPERATOR DECISION"]
    HR -- "nobody, or no answer in time" --> UF["UNCERTAIN refused, bounded"]
    T["tier high"] --> HG{"exact approval here?"}
    HG -- yes --> HA["allow without asking"]
    HG -- no --> Q2{"mode and policy"}
    Q2 -- manual --> H4["ask the operator"]
    Q2 -- "auto, coding" --> G1{"learned exact action in this workspace?"}
    G1 -- yes --> HA
    G1 -- no --> N1{"similar action allowed before in this workspace?"}
    N1 -- yes --> J3["judge scope check"]
    N1 -- no --> H4
    J3 -- allow --> J2
    J3 -- block --> H4
    Q2 -- engagement --> H5{"operator present?"}
    H5 -- yes --> H4
    H5 -- no --> H6["HARD DENY: needs an interactive operator"]
```

## A typical run

This sequence shows the common auto-mode path: a medium action reaches the judge with its inputs, every newly computed verdict is recorded as a judgement before the allow or block branch, a high-confidence block is returned to the agent with its reason, and an unsure one goes to the operator. In `manual` mode the judge is never called; high, unavailable-judge and non-judged cases fall through to the operator.

```mermaid
sequenceDiagram
    participant Agent
    participant FW as Tool firewall
    participant Judge
    participant Op as Operator
    participant Files as State files

    Agent->>FW: tool_call
    FW->>Files: read firewall.json, approvals and goal
    FW->>FW: parse, classify, trajectory, tier
    alt critical
        FW->>Files: audit tool_seen deny, outcome hard_deny
        FW-->>Agent: block [HARD DENY]
    else low
        FW->>Files: audit tool_seen allow
        FW-->>Agent: allow
    else exact approval in this workspace and session
        FW->>Files: audit tool_seen ask, tool_approved by grant
        FW-->>Agent: allow
    else manual medium or high
        FW->>Files: audit tool_seen ask
        FW->>Op: approval card, bounded
        Op-->>FW: allow or deny, or no answer in time
        FW->>Files: appendFeedback, addApproval on a session allow
        FW-->>Agent: allow, [OPERATOR DECISION] deny, or [UNCERTAIN] refused
    else auto judged
        FW->>Files: audit tool_seen ask
        FW->>Judge: request, goal, precedents, approvals, profile
        Judge-->>FW: verdict JSON with confidence
        FW->>Files: appendJudgement
        alt judge allows
            FW-->>Agent: allow
        else judge blocks with high confidence
            FW-->>Agent: block [AUTO-MODE BLOCK] with reason
        else judge unsure, unavailable, timed out, or a high block
            FW->>Files: audit tool_escalated, outcome uncertain
            FW->>Op: approval card tagged UNCERTAIN, bounded
            Op-->>FW: allow or deny, or no answer in time
            FW->>Files: appendFeedback, addApproval on a session allow
            FW-->>Agent: allow, [OPERATOR DECISION] deny, or [UNCERTAIN] refused
        end
    end
```

## Approvals: storage, scope and revocation

Every silent allow of a medium or high action is backed by an entry in `firewall-approvals.json`. An entry is bound to one exact action, workspace, working directory, policy and, for a session approval, root session; it records who or what granted it, when, and its expiry (24 hours for a session approval, 30 days for a learned one). Decisions read the file on every call, so `/firewall revoke` takes effect on the next tool call, and an entry of an unknown shape is ignored and reported, never treated as an allow.

```mermaid
flowchart TD
    CARD["card or console: Allow for this session"] --> SA["session approval: this exact action, workspace, cwd, root session, 24h"]
    ONCE["Allow once, repeated: 3 approvals in 2 sessions within 30 days in one workspace, no denial since"] --> LRN["learned exact action: persistent approval, that workspace, 30 days"]
    SA --> FILE["firewall-approvals.json, schemaVersion 1"]
    LRN --> FILE
    FILE --> USE{"same action, workspace, cwd, policy, root session, not expired, valid shape?"}
    USE -- yes --> RUN["allow without asking"]
    USE -- no --> ASK["judge or operator as usual"]
    LRN -.-> CHK{"a later denial, or learning off, or manual mode?"}
    CHK -- yes --> ASK
    REV["/firewall revoke id, session, workspace or all"] --> FILE
    REV --> FLOOR["floors: approvals before the revocation no longer count towards learning or judge eligibility"]
    BAD["invalid JSON, other schemaVersion, unknown shape or key"] --> IGN["ignored, reported on stderr, notice, list and audit"]
```

## Approval cards, the broker and recording

A headless request is written as a pending JSON file and answered by the human-console watcher, which presents the same menu and writes a resolved file. The wait is bounded by `PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS` and the turn's abort signal, and a console that cannot be written to is UNCERTAIN at once. A session allow becomes an approval under the root session id, so subagents inherit it; every operator decision appends feedback and can trigger background distillation.

```mermaid
sequenceDiagram
    participant Sub as Subagent
    participant FW as Tool firewall
    participant HC as Human console
    participant Op as Operator
    participant Store as Approvals and feedback

    Sub->>FW: tool_call
    FW->>HC: pending approval json, with timeout
    HC->>Op: menu allow once, allow session, deny, deny and tell
    Op-->>HC: choice
    HC-->>FW: resolved json
    FW->>Store: addApproval under the root session, workspace and cwd
    FW->>Store: appendFeedback
    Store->>Store: distillInBackground updates profile
    Note over Sub,Store: root session approvals shared with siblings and parent, same workspace only
    Sub->>FW: identical tool_call, same workspace
    FW->>Store: readApprovals
    Store-->>FW: exact match, not expired, valid
    FW-->>Sub: allow by grant
    Note over FW,HC: no answer before the deadline: refused as UNCERTAIN, the request is withdrawn
```

## Unattended mode

The supervisor sets `PI_KIT_UNATTENDED=1`, a known `PI_KIT_UNATTENDED_BOUNDARY` and `PI_KIT_UNATTENDED_CONTRACT` (a read-only JSON copy). `unattended.ts` decides once at load; nothing in a session can enable it, and a changed contract switches it off. Children read the same environment and validate the contract themselves.

```mermaid
flowchart TD
    E1{"PI_KIT_UNATTENDED is exactly 1?"} -- no --> OFF["not unattended: normal rules"]
    E1 -- yes --> E2{"boundary kind known? contract path absolute, readable, JSON,<br/>schemaVersion 1, authorised true, boundaryDigest, no contradiction,<br/>not in the workspace or agent dir, read-only for a non-root process,<br/>policy is not engagement?"}
    E2 -- no --> WARN["NOT unattended, loud warning: stderr, notice, /firewall status<br/>normal interactive or headless rules, fail closed"]
    E2 -- yes --> ON["unattended: publish the footer global, digest recorded"]
    ON --> CALL["each tool call: contract bytes unchanged?"]
    CALL -- changed or gone --> WARN
    CALL -- same --> R1{"critical, or a hard class?<br/>security control, destructive, exfiltration chain, the boundary or contract"}
    R1 -- yes --> HD["HARD DENY, actionable text"]
    R1 -- no --> R2{"needs authority outside the zone?<br/>host not in egress, remote not listed, publish, cloud or cluster"}
    R2 -- yes --> OUT["refused: outside the unattended zone, actionable text"]
    R2 -- no --> R3{"policy ask rule or a tool the policy does not name?"}
    R3 -- yes --> UNC["UNCERTAIN: nobody to ask"]
    R3 -- no --> R4{"low tier?"}
    R4 -- yes --> RUN["runs"]
    R4 -- no --> R5{"autoApprove true?"}
    R5 -- yes --> RUN2["runs: no card, no judge, no console request"]
    R5 -- no --> UNC
```

## Key files

- `packages/extensions/src/tool-firewall/index.ts` — hooks, `decide`, decision matrix, approvals, judge gate, card and broker branching, bounded prompts, outcomes, audit, `/firewall` and `/auto`.
- `packages/extensions/src/tool-firewall/approvals.ts` — the approvals file: schema, validation, expiry, scope matching, revocation and floors.
- `packages/extensions/src/tool-firewall/unattended.ts` — the run contract, unattended state, egress and remote checks, hard and outside-the-zone denials.
- `packages/extensions/src/tool-firewall/config.ts` — modes, policies, config file, state paths, known hosts (with sources and revocation), workspace root.
- `packages/extensions/src/tool-firewall/classify.ts` — effects, tiers, path classes, per-command handlers, hosts and remotes contacted, signatures and families.
- `packages/extensions/src/tool-firewall/shell.ts` — tokenizer and parser feeding the classifier.
- `packages/extensions/src/tool-firewall/trajectory.ts` — per-session state, trajectory findings, root-session sharing.
- `packages/extensions/src/tool-firewall/judge.ts` — judge prompt, in-process model call, verdict and confidence parsing, timeout.
- `packages/extensions/src/tool-firewall/card.ts` — bounded card, choices, detail view, outcome tag.
- `packages/extensions/src/tool-firewall/feedback.ts` — feedback record, redaction, learning thresholds, per-workspace scoping, precedents.
- `packages/extensions/src/tool-firewall/profile.ts` — judgements, distillation stats, global profile and its lock.
- `packages/extensions/src/tool-firewall/default-policy.json` — shipped tools and engagement command rules.
- `packages/extensions/src/human-console/index.ts` — pending/resolved broker, approval menu, `ask_human` (bounded).
- `packages/extensions/third_party/protected-paths/index.ts` — protected lists, allowlist mode, path matching, the approvals file and the contract path.
- `docs/autonomy-gate.md` — prose description of the same decision gate.
