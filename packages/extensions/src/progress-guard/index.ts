import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// progress-guard: the auto-boost / anti-loop layer. It watches for two cheap "stuck"
// signals — the same action repeating, and many reads since the last edit — and helps the
// agent break out instead of grinding. It is *assistance, not bug-fixing*.
//
// Autonomy dial (PI_KIT_GUARD_MODE, overridable at runtime with /boost):
//   - "auto"    : inject a guidance nudge (into the running loop and as a context-sieve
//                 contribution for the next prompt) AND notify.
//   - "suggest" : notify a suggestion only, never inject (default).
// The autonomous profile should set PI_KIT_GUARD_MODE=auto; other profiles stay "suggest".
//
// It never blocks a tool and never emits a system prompt — guidance goes into the running loop
// as a hidden custom message (returned from turn_end on pi >=0.87.0, steered on older pi), and
// into later prompts through a context-sieve ctx-contribution. When it cannot detect enough, it
// does nothing. Escalation beyond assistance is the operator's or
// docs/recovery-orchestration-mode.md's job.

const WINDOW = 40;
const COOLDOWN_TURNS = 4; // don't re-nudge the same signature within N turns
const CONTRIB_ID = "progress-guard";
const WRITE_HINT = /^(write|edit|create|apply|str_replace|multi_?edit|patch|insert|append)/i;
const READ_HINT = /^(read|grep|glob|ls|find|cat|search|rg)/i;

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

const REPEAT_LIMIT = intEnv("PI_KIT_GUARD_REPEAT", 3);
// 10, not 6: a fresh session commonly opens with a burst of 6-9 reads while it orientates,
// and firing there was a false positive. Ten reads without a write is a real stall signal.
const READ_STALL = intEnv("PI_KIT_GUARD_STALL", 10);
// Oscillation: minimum length of a strictly-alternating A→B→A run (since the last write)
// that counts as a loop. Default 3 fires on A→B→A. (Epic 5 Sprint 5.2.)
const OSC_MINLEN = intEnv("PI_KIT_GUARD_OSC", 3);
// After a signature has been nudged this many times and still recurs, escalate to
// recovery-orchestrator (assistance isn't working). (Epic 5 Sprint 5.2/5.3.)
const ESCALATE_AFTER = intEnv("PI_KIT_GUARD_ESCALATE", 2);

// Detect an A→B→A oscillation: exactly two distinct action signatures, strictly alternating,
// over the last OSC_MINLEN+ actions since the last write. Exported for the eval harness.
export function findOscillation(signatures: string[], minLen: number = OSC_MINLEN): string | null {
  if (signatures.length < minLen) return null;
  const tail = signatures.slice(-minLen);
  const distinct = new Set(tail);
  if (distinct.size !== 2) return null;
  for (let i = 1; i < tail.length; i++) if (tail[i] === tail[i - 1]) return null;
  return `osc:${[...distinct].sort().join("|")}`;
}

// Guard mode resolution (Epic 5 Sprint 5.1): auto when the operator forced it (/boost),
// when an autonomous-loop is armed (fresh marker file), or when PI_KIT_GUARD_MODE=auto.
// Exported so the eval harness can assert arming flips the mode with no env var. The marker
// carries a heartbeat `at` refreshed by autonomous-loop on each iteration: a marker older
// than the TTL was left by a crashed loop and must NOT pin resolveMode to auto later.
export function autonomousArmed(cwd: string): boolean {
  try {
    const marker: unknown = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "autonomous-loop.armed.json"), "utf8"));
    if (typeof marker !== "object" || marker === null || Reflect.get(marker, "armed") !== true) return false;
    const markerAt: unknown = Reflect.get(marker, "at");
    // A legacy/fresh marker with no parseable heartbeat cannot be trusted to still be live:
    // treat missing or unparseable `at` as expired so a stale marker cannot pin auto mode
    // indefinitely. Only a parseable `at` within TTL keeps the loop armed.
    if (typeof markerAt !== "string") return false;
    const at = Date.parse(markerAt);
    if (Number.isNaN(at)) return false;
    const ttl = Number(process.env.PI_KIT_LOOP_ARM_TTL_MS);
    const ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 30 * 60 * 1000;
    return Date.now() - at <= ttlMs;
  } catch {
    return false;
  }
}

export function resolveMode(cwd: string, runtimeMode: "auto" | "suggest" | null): "auto" | "suggest" {
  if (runtimeMode) return runtimeMode;
  if (autonomousArmed(cwd)) return "auto";
  return process.env.PI_KIT_GUARD_MODE === "auto" ? "auto" : "suggest";
}

// REL-5: the escalation marker is scoped per session like the contributions (B-005), so a
// child or a second session in the same cwd neither consumes nor deletes this session's
// marker. A session without a usable id keeps the legacy flat path. recovery-orchestrator
// resolves the same path (self-containment: duplicated, not imported).
function escalationFile(cwd: string, sessionId: string | undefined = currentSessionId): string {
  const base = path.join(cwd, ".pi", "recovery");
  return isSessionId(sessionId) ? path.join(base, "sessions", sessionId, "escalation.json") : path.join(base, "escalation.json");
}

function writeEscalation(cwd: string, signature: string, reason: string, count: number): void {
  try {
    const file = escalationFile(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ signature, reason, count, at: new Date().toISOString(), ...(currentSessionId ? { sessionId: currentSessionId } : {}) }),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

interface Action {
  tool: string;
  target?: string | undefined;
  argsHash: string;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function hash(s: string): string {
  // small, dependency-free string hash (djb2) -> hex
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function targetOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const cand = o.path ?? o.file_path ?? o.filePath ?? o.file ?? o.pattern ?? o.command ?? o.query;
  return typeof cand === "string" ? (cand.length > 120 ? cand.slice(0, 120) : cand) : undefined;
}

function isWrite(tool: string): boolean {
  return WRITE_HINT.test(tool) || /write|edit/.test(tool.toLowerCase());
}
function isRead(tool: string): boolean {
  return !isWrite(tool) && (READ_HINT.test(tool) || tool.toLowerCase().includes("read"));
}
function short(t: string): string {
  return t.length > 56 ? "…" + t.slice(-53) : t;
}

// B-005: contribution files are scoped per session so concurrent sessions sharing a cwd
// (child agents do) cannot overwrite each other. The resolver is duplicated in each producer
// (not imported) because every extension must stay independently extractable
// (packages/core/verify.ts self-containment lint).
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
let currentSessionId: string | undefined;

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function resolveSessionId(sessionManager?: unknown): string | undefined {
  try {
    const id = (sessionManager as { getSessionId?: () => unknown } | undefined)?.getSessionId?.();
    return isSessionId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function contribDir(cwd: string, sessionId: string | undefined = currentSessionId): string {
  const base = path.join(cwd, ".pi", "ctx-contributions");
  return isSessionId(sessionId) ? path.join(base, "sessions", sessionId) : base;
}

function contribPath(cwd: string): string {
  return path.join(contribDir(cwd), `${CONTRIB_ID}.json`);
}

function writeContribution(cwd: string, content: string): void {
  try {
    const p = contribPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ id: CONTRIB_ID, priority: 78, budgetTokens: 320, content }), "utf8");
  } catch {
    /* best-effort */
  }
}

function clearContribution(cwd: string): void {
  try {
    fs.rmSync(contribPath(cwd), { force: true });
  } catch {
    /* ignore */
  }
}

export default function (pi: ExtensionAPI) {
  let cwd = process.cwd();
  let turn = 0;
  let readsSinceWrite = 0;
  let lastActedSignature = "";
  let lastActedTurn = -COOLDOWN_TURNS;
  let runtimeMode: "auto" | "suggest" | null = null;
  // Whether the session has any write-capable tool active. Resolved once per session; when
  // we cannot tell (no API), assume true so a real stall is never silently suppressed.
  let writeCapable = true;
  let escalated = new Set<string>();
  const recent: Action[] = [];
  const sinceWrite: string[] = []; // coarse signatures (tool|target) since the last write
  const actCounts = new Map<string, number>(); // how many times we've nudged each signature

  function mode(): "auto" | "suggest" {
    return resolveMode(cwd, runtimeMode);
  }

  function digest(): string {
    return recent.slice(-8).map((a) => (a.target ? `${a.tool}:${short(a.target)}` : a.tool)).join(" → ") || "(none)";
  }

  // Returns [signature, message] for the first firing signal, or null.
  function detect(): [string, string] | null {
    // 1) repetition: same argsHash appears REPEAT_LIMIT+ times in the window
    const counts = new Map<string, number>();
    for (const a of recent) counts.set(a.argsHash, (counts.get(a.argsHash) ?? 0) + 1);
    for (const a of recent) {
      if ((counts.get(a.argsHash) ?? 0) >= REPEAT_LIMIT) {
        const what = a.target ? `'${short(a.target)}'` : `\`${a.tool}\``;
        return [
          `repeat:${a.argsHash}`,
          `you have repeated the same action on ${what} ~${counts.get(a.argsHash)}× without progress`,
        ];
      }
    }
    // 2) oscillation: A→B→A alternation since the last write (the case simple repeat misses)
    const osc = findOscillation(sinceWrite);
    if (osc) {
      return [osc, "you are oscillating between the same two actions without progress (A→B→A)"];
    }
    // 3) read-without-progress: many reads since the last edit. AG-06 fix: the signature
    // must NOT embed the live count (it previously did — "stall:6", "stall:7", ... — so
    // every firing was treated as a brand-new signature and escalation's per-signature
    // counter never accumulated past 1). Keep the count in the message, not the signature.
    // Only meaningful when a write-capable tool is active: in a read-only session there is
    // no edit the agent *could* make, so "reads since last edit" is not a stall.
    if (writeCapable && readsSinceWrite >= READ_STALL) {
      return ["stall", `${readsSinceWrite} reads since your last edit — you likely have enough context`];
    }
    return null;
  }

  function nudgeContent(reason: string): string {
    return [
      `## progress-guard: possible loop`,
      "",
      `Signal: ${reason}.`,
      "Stop and self-reflect against your goal: is this advancing it, or repeating? Then do ONE of:",
      "- take the smallest **different** next action, or",
      "- **delegate** the stuck investigation to a fresh sub-agent (`agent-orchestration`) that works",
      "  in its own context and returns only the answer you need — not raw output, or",
      "- report the completed findings or the concrete blocker when further authorized work is not useful.",
      "Read-only research can make progress without writes. Do not edit files merely to reset this detector.",
      "",
      `Recent actions: ${digest()}`,
      "Skill: `self-reflection-and-recovery`. If assistance is not enough, see",
      "docs/recovery-orchestration-mode.md.",
    ].join("\n");
  }

  // The stronger, autonomous checkpoint injected once a loop signature keeps recurring. It is
  // written unconditionally (not only in "auto" mode): the operator should not have to run
  // /reflect or arm anything for a repeated loop to get a review/delegate nudge.
  function reviewDelegateContent(signature: string, reason: string, count: number): string {
    return [
      "## progress-guard: review / delegate checkpoint (automatic)",
      "",
      `The signal \`${signature}\` has now fired ${count} times: ${reason}.`,
      "This is the point to stop and review rather than continue the current streak:",
      "1. Re-read your goal and confirm the last N actions serve it. If not, say so and change approach.",
      "2. Prefer delegating the stuck step to a fresh sub-agent (`agent-orchestration`) so it gets an",
      "   unpolluted context and returns only the answer.",
      "3. If the loop is a repeated failure, capture the concrete blocker (what you tried, what failed,",
      "   what is needed) instead of retrying it a fourth time.",
      "",
      `Recent actions: ${digest()}`,
      "Skill: `self-reflection-and-recovery`.",
    ].join("\n");
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    currentSessionId = resolveSessionId(ctx.sessionManager);
    clearContribution(cwd); // start clean each session
    // A read-only session (no write/edit/bash-class tool active) can never "write to make
    // progress", so the reads-since-edit stall is not a meaningful signal there.
    try {
      const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
      if (Array.isArray(active) && active.length > 0) {
        writeCapable = active.some((t) => isWrite(t) || /bash|shell|exec|apply_patch/i.test(t));
      } else {
        writeCapable = true;
      }
    } catch {
      writeCapable = true;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    cwd = ctx.cwd ?? cwd;
    const ev = event as { toolName?: string; input?: unknown };
    const tool = ev.toolName ?? "unknown";
    const action: Action = { tool, target: targetOf(ev.input), argsHash: hash(tool + " " + stableStringify(ev.input)) };
    recent.push(action);
    if (recent.length > WINDOW) recent.shift();

    // AG-06 fix: a write ATTEMPT is no longer treated as progress here — only a
    // confirmed-successful write (see tool_result below) resets the stall/oscillation
    // state. Resetting on tool_call let an attempt-a-failing-edit-repeatedly loop reset
    // its own detection on every attempt, before the result (success or failure) was
    // even known.
    if (!isWrite(tool)) {
      // record a coarse signature for oscillation detection (any non-write action)
      sinceWrite.push(`${tool}|${action.target ?? ""}`);
      if (sinceWrite.length > WINDOW) sinceWrite.shift();
      if (isRead(tool)) readsSinceWrite += 1;
    }
    return undefined; // never block
  });

  pi.on("tool_result", async (event, ctx) => {
    const ev = event as { toolName?: string; isError?: boolean };
    const tool = ev.toolName ?? "unknown";
    if (isWrite(tool) && !ev.isError) {
      // progress was actually made: reset the stall counter and stand down any active nudge
      cwd = ctx.cwd ?? cwd;
      readsSinceWrite = 0;
      lastActedSignature = "";
      sinceWrite.length = 0;
      recent.length = 0;
      actCounts.clear();
      escalated = new Set<string>();
      clearContribution(cwd);
      // A confirmed-successful write means the stall resolved, so drop any escalation
      // marker written by a prior escalation. Otherwise recovery-orchestrator consumes a
      // stale marker on the next turn and enters deep recovery for a problem that is gone.
      try { fs.rmSync(escalationFile(cwd), { force: true }); } catch { /* best-effort */ }
    }
    return undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    turn += 1;
    const c = ctx;
    const hit = detect();
    if (!hit) return undefined;
    const [signature, reason] = hit;

    // Every firing turn counts toward escalation, even while the operator-facing nudge is
    // in cooldown. Previously the counter only advanced when a nudge was *acted* on, and
    // the cooldown then swallowed the following firings — so a slowly-repeating stall could
    // never reach ESCALATE_AFTER. Gating only the message on the cooldown fixes that while
    // still avoiding a notification on every single turn.
    const detections = (actCounts.get(signature) ?? 0) + 1;
    actCounts.set(signature, detections);

    const inCooldown = signature === lastActedSignature && turn - lastActedTurn < COOLDOWN_TURNS;
    // The guidance also goes into this run (EFF-5): the contribution file is read by
    // context-sieve only when the next prompt starts, which is too late for a loop inside one
    // long run. A custom_message entry returned from turn_end is appended after this turn's tool
    // results, so the next model request of the same run sees it. The file stays for the next run.
    let inRun: string | null = null;
    if (!inCooldown) {
      lastActedSignature = signature;
      lastActedTurn = turn;
      const msg = `progress-guard: ${reason}. Auto review/delegate checkpoint incoming. (/boost status)`;
      if (mode() === "auto") {
        inRun = nudgeContent(reason);
        writeContribution(cwd, inRun);
        if (c.hasUI) c.ui.notify(`${msg} [auto-nudged]`, "warning");
      } else if (c.hasUI) {
        c.ui.notify(msg, "warning");
      }
    }

    // Autonomous review/delegate injection (no /reflect, no mode switch): once the same
    // signature keeps recurring, inject the stronger checkpoint via context-sieve AND write
    // the recovery marker so recovery-orchestrator can act on it. This is the automatic
    // replacement for the manual /reflect step.
    if (detections >= ESCALATE_AFTER) {
      const checkpoint = reviewDelegateContent(signature, reason, detections);
      writeContribution(cwd, checkpoint);
      // Delivered in the run on the episode's first escalation and then at most once per cooldown.
      if (!inCooldown || !escalated.has(signature)) inRun = checkpoint;
      // Write the escalation marker once per detection episode. A recurring signature keeps
      // `escalated` set, so once the consumer deletes the marker it is NOT immediately
      // re-written on the next stuck turn — only a new episode (progress reset clears the set,
      // or a different signature) writes a fresh marker. This prevents a consumer that
      // consumes-and-deletes the marker from being re-escalated in a tight loop.
      if (!escalated.has(signature)) {
        escalated.add(signature);
        writeEscalation(cwd, signature, reason, detections);
        if (c.hasUI) c.ui.notify(`progress-guard: recurring '${signature}' — injected an automatic review/delegate checkpoint and recovery marker.`, "warning");
      }
    }

    if (inRun === null) return undefined;
    // pi >=0.87.0 makes turn_end an actionable boundary: it carries `entries` and appends the
    // entries a handler returns. Older pi has no `entries` field and ignores the return value,
    // so there the nudge is sent as a steering message instead: the agent loop polls steering
    // right after turn_end and adds it before the next model request of the same run. (A
    // non-steering custom message would only reach the session history, i.e. the next prompt.)
    // tests/progress-guard-agsix-smoke.ts "reach the model inside the looping run" covers both.
    if (!Array.isArray(event.entries)) {
      pi.sendMessage({ customType: CONTRIB_ID, content: inRun, display: false }, { deliverAs: "steer" });
      return undefined;
    }
    // Chain onto the entries earlier turn_end handlers proposed; a returned list replaces them.
    return { entries: [...event.entries, { type: "custom_message", customType: CONTRIB_ID, content: inRun, display: false }] };
  });

  pi.registerCommand("reflect", {
    description: "Inject a self-reflection checkpoint (goal vs recent actions: progressing or looping?).",
    handler: async (_args, ctx) => {
      const c = ctx;
      const content = [
        "## Self-reflection checkpoint",
        "",
        "Answer briefly against your current goal, then act on the answer:",
        "1. Are my recent actions advancing the goal, or repeating?",
        "2. If looping: what is the single smallest **different** next action?",
        "3. Should the stuck step be delegated to a fresh sub-agent that returns only the answer?",
        "",
        `Recent actions: ${digest()}`,
        "Skill: `self-reflection-and-recovery`.",
      ].join("\n");
      writeContribution(c.cwd ?? cwd, content);
      if (c.hasUI) c.ui.notify("progress-guard: reflection checkpoint queued for the next turn.", "info");
    },
  });

  pi.registerCommand("boost", {
    description: "Auto-boost control: /boost [on|off|status]. 'on' auto-nudges on detected loops this session.",
    handler: async (args, ctx) => {
      const c = ctx;
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on") {
        runtimeMode = "auto";
        if (c.hasUI) c.ui.notify("progress-guard: auto-boost ON for this session (auto-nudge on loops).", "info");
      } else if (arg === "off") {
        runtimeMode = "suggest";
        clearContribution(c.cwd ?? cwd);
        if (c.hasUI) c.ui.notify("progress-guard: auto-boost OFF (suggest-only).", "info");
      } else {
        if (c.hasUI) {
          c.ui.notify(
            `progress-guard: mode=${mode()} | reads-since-edit=${readsSinceWrite} | window=${recent.length} | write-capable=${writeCapable} | thresholds repeat≥${REPEAT_LIMIT}, stall≥${READ_STALL}`,
            "info",
          );
        }
      }
    },
  });
}
