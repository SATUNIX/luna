import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { writeFileSafe } from "./shared/safe-fs.ts";

// orchestrator: the autonomy layer over the `subagent` tool. It scores each user request and,
// when a task is non-trivial, writes a high-priority ctx-contribution steering the main agent to
// run a plan -> implement -> validate flow. It NEVER returns { systemPrompt } — context-sieve is
// the sole injection authority; the orchestrator only drops a contribution file for it to assemble.
//
// Role definitions are no longer copied into each project's .pi/agents: the subagent extension
// resolves the shipped roles from packages/kit/agents directly. The copies drifted (they still
// told headless children to call ask_human after the kit roles were fixed) and, because
// materialization never overwrote, fixes never reached existing projects.

const DEFAULT_THRESHOLD = parseInt(process.env.PI_KIT_ORCH_THRESHOLD ?? "3", 10);

// B-005: contribution files are scoped per session so concurrent sessions sharing a cwd
// (child agents do) cannot overwrite each other. The resolver is duplicated in each producer
// (not imported) because every extension must stay independently extractable
// (packages/core/verify.ts self-containment lint).
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
let currentSessionId: string | undefined;

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function contribFile(cwd: string): string {
  return path.join(contribDir(cwd), "orchestrator.json");
}

// A subagent child must never steer itself or its parent: print mode reports the child's task
// as an "interactive" input, and the child shares the parent's .pi/ctx-contributions directory.
// Children normally run without this extension (subagent isolation); this is defence in depth
// for children spawned by other means.
function isInternalChild(): boolean {
  return process.env.PI_KIT_INTERNAL_CHILD === "1";
}

function scoreComplexity(text: string): number {
  const t = text.toLowerCase();
  let s = 0;
  if (/\b(implement|build|refactor|migrate|rewrite|redesign|integrate|overhaul|port|scaffold)\b/.test(t)) s += 2;
  if (/\b(across|end-to-end|end to end|multiple|several|entire|whole|throughout|full)\b/.test(t)) s += 1;
  if ((t.match(/\band\b/g)?.length ?? 0) >= 2 || /\bthen\b/.test(t)) s += 1;
  const paths = t.match(/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|json|md|yaml|yml)\b/g)?.length ?? 0;
  if (paths >= 2) s += 1;
  if (text.length > 280) s += 1;
  if (/\b(plan|thorough|comprehensive|carefully|production|robust|properly)\b/.test(t)) s += 1;
  if (/\b(feature|system|pipeline|architecture|workflow|module|service)\b/.test(t)) s += 1;
  return s;
}

// Complexity selects routing, not authorization to change artifacts. Recognize
// explicit investigation/planning requests before emitting an implementation flow.
function isReadOnlyRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(read[ -]only|plan[ -]only|review[ -]only)\b|\b(do not|don't|without)\s+(?:making\s+)?(?:any\s+)?(?:changes|edit(?:ing)?|implement(?:ing)?|modif(?:y|ying))/i.test(t)) return true;
  const request = t.replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/, "").replace(/^please\s+/, "");
  if (!/^(?:review|inspect|investigate|analy[sz]e|explain|assess|audit|plan|(?:produce|create|write|prepare|make)\s+(?:a\s+)?(?:\w+\s+){0,3}(?:plan|review|assessment|report))\b/.test(request)) return false;
  // Explicit subsequent implementation remains an implementation request.
  return !/\b(?:and|then)\s+(?:also\s+)?(?:implement|fix|edit|build|apply|modify)\b/.test(request);
}

export const DIRECTIVE_BUDGET_TOKENS = 800;

export function directive(score: number): string {
  return [
    `## Delegation policy (task complexity: ${score})`,
    "",
    "The installed orchestration policy authorises delegation at this complexity; complexity alone",
    "does not grant permission. Follow any user restriction and the current effort budget. Delegate through",
    "the `subagent` tool (built-in roles: scout, planner, implementer, reviewer) and keep your own",
    "context lean — let sub-agents hold the detail. Each subagent task must be self-contained (exact",
    "paths, acceptance criteria, expected output): a subagent cannot see this conversation. Standard flow:",
    "",
    "1. **planner** — investigate and produce a concrete plan (read-only). If discovery is heavy, run",
    "   a **scout** first and pass its findings to the planner.",
    "2. **implementer** — execute the plan with scoped edits. If the planner marked work units as",
    "   independent (disjoint files), spawn implementers in **parallel** (subagent `tasks`); otherwise",
    "   run them one at a time.",
    "3. **reviewer** — validate the result. It is the final gate: if its Verdict is FAIL, loop back to",
    "   an implementer with the reviewer's must-fix list. Do NOT report the task done until the",
    "   reviewer passes.",
    "",
    "Prefer chain mode for the simple linear case:",
    "`subagent({ chain: [ {agent:'planner',task:'…'}, {agent:'implementer',task:'{previous}'}, {agent:'reviewer',task:'{previous}'} ] })`.",
    "",
    "If these coordination tools are available (full install), use them: record the planner's work",
    "units with `task_create` (and `task_next` to hand the next unblocked one to an implementer), and",
    "call `verify_completion` after review: only a passing trusted verifier completes the board.",
    "A subagent PASS recorded with `record_verdict` is untrusted. Set `/goal` to survive compaction.",
    "",
    "Read the relevant runbook skill's SKILL.md before acting (small models often skip skills",
    "otherwise) — `skill_search` finds it; e.g. `agent-orchestration`, `task-decomposition`, and",
    "`self-reflection-and-recovery` if you notice you are looping.",
  ].join("\n");
}

// AG-02 fix: docs/agent-orchestration.md's "Manual entry points" section documented
// /orchestrate-plan and /orchestrate-implement-review as existing commands; neither was
// registered. Implemented as real, working directive variants (same steering mechanism
// as /orchestrate, scoped to a specific requested sub-flow and an explicit task string)
// rather than either leaving the doc claim false or adding a new fake stub.
function planOnlyDirective(task: string): string {
  return [
    "## Manual delegation: plan only (/orchestrate-plan)",
    "",
    `Task: ${task}`,
    "",
    "Produce a plan WITHOUT making any changes. Do NOT implement or edit anything in this context:",
    "",
    "1. If discovery is heavy, run a **scout** via `subagent` first and pass its findings to the planner.",
    "2. Run a **planner** via `subagent` (read-only tools) to investigate and",
    "   produce a concrete implementation plan for the task above.",
    "3. Report the plan back to the operator. Do not proceed to implementation unless asked.",
    "",
    "Skill: `agent-orchestration`, `task-decomposition`.",
  ].join("\n");
}

function implementReviewDirective(task: string): string {
  return [
    "## Manual delegation: implement + review (/orchestrate-implement-review)",
    "",
    `Task: ${task}`,
    "",
    "Run the full planner → implementer → reviewer flow via `subagent`,",
    "looping implementer ↔ reviewer until the reviewer passes:",
    "",
    "1. **planner** — investigate and produce a concrete plan (read-only).",
    "2. **implementer** — execute the plan with scoped edits.",
    "3. **reviewer** — validate the result. If its Verdict is FAIL, loop back to an implementer with",
    "   the reviewer's must-fix list. Do NOT report the task done until the reviewer passes.",
    "",
    "Call `verify_completion` after review: only its trusted PASS completes the verifier board.",
    "A subagent PASS via `record_verdict` remains untrusted.",
    "",
    "Skill: `agent-orchestration`, `self-reflection-and-recovery`.",
  ].join("\n");
}

function writeContributionContent(cwd: string, content: string): void {
  try {
    // Workspace state: never written through a committed symlink (./shared/safe-fs.ts).
    writeFileSafe(
      contribFile(cwd),
      JSON.stringify({
        id: "orchestrator",
        priority: 80,
        budgetTokens: DIRECTIVE_BUDGET_TOKENS,
        content,
      }),
      { root: cwd },
    );
  } catch {
    /* best effort */
  }
}

function writeDirective(cwd: string, score: number): void {
  writeContributionContent(cwd, directive(score));
}

function clearDirective(cwd: string): void {
  try { fs.rmSync(contribFile(cwd), { force: true }); } catch { /* ignore */ }
}

// AG-01 fix: provider-router previously read `task_type` from goal-core.json, but
// goal-core never wrote one (only free-text prompt contributions) - so the strong-model
// route had no real input in production and always fell through to the hot-path model.
// orchestrator already computes a real per-input complexity score on every `input`
// event (used to decide whether to write a delegation directive); expose that same
// signal to provider-router via a small, well-known-path file (per session, see below), the same cross-extension
// file-contract convention this kit already uses for .pi/verdicts.json etc.
// ORC-9: scoped per session like the contributions (B-005), so another session or a child
// in the same cwd never routes on this session's score. A session without a usable id
// keeps the legacy flat .pi/task-classification.json. provider-router resolves the same path.
function classificationFile(cwd: string, sessionId: string | undefined = currentSessionId): string {
  const base = path.join(cwd, ".pi");
  return isSessionId(sessionId)
    ? path.join(base, "task-classification", "sessions", `${sessionId}.json`)
    : path.join(base, "task-classification.json");
}

function writeClassification(cwd: string, score: number): void {
  try {
    writeFileSafe(
      classificationFile(cwd),
      JSON.stringify({ score, taskType: score >= DEFAULT_THRESHOLD ? "complex" : "simple", at: new Date().toISOString(), ...(currentSessionId ? { sessionId: currentSessionId } : {}) }),
      { root: cwd },
    );
  } catch {
    /* best effort */
  }
}

function clearClassification(cwd: string): void {
  try { fs.rmSync(classificationFile(cwd), { force: true }); } catch { /* ignore */ }
}

// AG-04 fix: verdicts older than this are no longer trusted as proof of a current-state
// pass, even if their stored `pass` flag is still true — a long-running session can
// pass a check, keep editing for hours, and never re-verify. Missing, malformed and
// future timestamps cannot establish freshness either. Kept in parity with
// verifier-board and conductor without runtime sibling imports.
const VERDICT_MAX_AGE_MS = Number(process.env.PI_KIT_VERDICT_MAX_AGE_MS) || 24 * 60 * 60 * 1000;

// Shared completion contract: tests/verifier-board-trust-smoke.ts pins all local readers.
function isStale(at: unknown): boolean {
  if (typeof at !== "string") return true;
  const parsed = Date.parse(at);
  const now = Date.now();
  return Number.isNaN(parsed) || parsed > now || now - parsed > VERDICT_MAX_AGE_MS;
}

// Sources reserved for independent, non-model writers (verify-gate writes `verify`/`review`,
// conductor validators write `validator:<id>`). Kept in parity with verifier-board's
// isTrustedVerdictSource (self-containment forbids importing it): an untrusted-only board
// must not satisfy completion (WU-1 trust hardening).
const TRUSTED_SOURCE_PATTERNS: RegExp[] = [/^verify$/i, /^review$/i, /^validator:/i];

function isTrustedVerdictSource(source: unknown): boolean {
  const s = typeof source === "string" ? source.trim() : "";
  return s.length > 0 && TRUSTED_SOURCE_PATTERNS.some((p) => p.test(s));
}

// verify-gate writes this marker while an async, non-awaited turn_end verify run is
// still in flight (AG-04 race fix) — same well-known-path convention as
// .pi/verdicts.json, read here without importing verify-gate (self-containment). The
// TTL mirrors verify-gate.isVerifyPendingActive (PI_KIT_VERIFY_PENDING_TTL_MS, default
// 30 min): a marker left by a SIGKILLed/crashed session must not block completion forever.
// REL-5: verify-gate writes one .pi/verify-pending/<run>.json per run; the legacy flat
// .pi/verify-pending.json is still honoured.
function verifyPending(cwd: string): boolean {
  let runs: string[] = [];
  try {
    const dir = path.join(cwd, ".pi", "verify-pending");
    runs = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
  } catch {
    /* no per-run markers */
  }
  return [path.join(cwd, ".pi", "verify-pending.json"), ...runs].some(freshPendingMarker);
}

function freshPendingMarker(file: string): boolean {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const marker: unknown = JSON.parse(raw);
    // String() is the conversion Date.parse applies itself; a missing startedAt still parses to NaN.
    let startedAt = Date.parse(String(isRecord(marker) ? marker.startedAt : undefined));
    if (Number.isNaN(startedAt)) startedAt = fs.statSync(file).mtimeMs;
    const ttl = Number(process.env.PI_KIT_VERIFY_PENDING_TTL_MS);
    const ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 30 * 60 * 1000;
    return Date.now() - startedAt <= ttlMs;
  } catch {
    return false;
  }
}

// Definition-of-done gate (Epic 4 Sprint 4.1): the mission may not be reported complete while
// any verdict on the verifier board (.pi/verdicts.json) is failing. Reads the same file
// verifier-board / verify-gate write. Exported pure function so the eval harness can drive it.
//
// AG-04 fix: this previously treated a missing file, a malformed/unreadable board, or an
// empty verdicts object as "not blocked" — i.e. no verification ever having happened was
// indistinguishable from everything passing. It now fails closed in all three cases,
// matching verifier-board's own summarize() (which already treats an empty board as
// FAIL). A verify run still in flight (see verifyPending above) is also blocking, so a
// mission can't complete based on a stale/absent board read that raced an in-progress
// check.
export function missionCompleteBlocked(cwd: string): { blocked: boolean; failing: string[] } {
  if (verifyPending(cwd)) return { blocked: true, failing: ["verify (in progress)"] };

  const file = path.join(cwd, ".pi", "verdicts.json");
  let board: unknown;
  try {
    if (!fs.existsSync(file)) return { blocked: true, failing: ["(no verdicts recorded — verification has not run)"] };
    board = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { blocked: true, failing: ["(verdict board unreadable or corrupt)"] };
  }
  const verdicts = isRecord(board) ? board.verdicts : undefined;
  if (!isRecord(verdicts) || Array.isArray(verdicts)) {
    return { blocked: true, failing: ["(verdict board malformed)"] };
  }
  const sources = Object.keys(verdicts);
  if (sources.length === 0) {
    return { blocked: true, failing: ["(no verdicts recorded yet)"] };
  }
  const failing = sources.filter((k) => {
    const v = verdicts[k];
    return !isRecord(v) || v.pass !== true || isStale(v.at);
  });
  if (failing.length > 0) return { blocked: true, failing };
  // Every recorded source passes and is fresh, but completion also requires at least one
  // trusted, independent source. An untrusted-only board is not proof of current-state
  // correctness (WU-1).
  if (!sources.some((source) => isTrustedVerdictSource(source))) {
    return { blocked: true, failing: ["(no trusted verdict source — need verify, review, or validator:<id>)"] };
  }
  return { blocked: false, failing: [] };
}

export default function (pi: ExtensionAPI) {
  let cwd = "";
  let forcedOn = false;
  let forcedOff = false;
  let verificationRequired = false;
  let correctionSent = false;
  let autoVerificationExpected = false;

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    currentSessionId = resolveSessionId(ctx.sessionManager);
    verificationRequired = false;
    correctionSent = false;
    autoVerificationExpected = false;
    // Do not delete another agent's live workspace contribution on startup.
    // context-sieve excludes unchanged preexisting directives for this session.
  });

  // A board is a completion contract for work, not a prerequisite for conversation.
  pi.on("tool_result", async (event) => {
    if (process.env.PI_KIT_VERIFY_ON_TURN !== "1") return;
    if (!event.isError && ["write", "edit"].includes(event.toolName)) {
      // Ordinary document/report edits do not imply an automatic npm verification contract.
      // Explicit implementation workflows still require a board without a script.
      try {
        const pkg: unknown = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
        const scripts = isRecord(pkg) ? pkg.scripts : undefined;
        const verify = isRecord(scripts) ? scripts.verify : undefined;
        if (typeof verify === "string" && verify.trim()) {
          verificationRequired = true;
          autoVerificationExpected = true;
        }
      } catch { /* no project verification contract */ }
    }
  });

  // Queue corrections while the current loop can still consume them. agent_end
  // is too late: Pi can leave that steer pending until the next user request.
  // Our own continuation must never create an unbounded self-steering loop.
  pi.on("turn_end", async (event, ctx) => {
    if (event.message?.role !== "assistant" || event.message.stopReason !== "stop") return undefined;
    if (process.env.PI_KIT_ORCH_DISABLE === "1" || isInternalChild()) return undefined;
    // verify-gate awaits the actual run and owns its result/correction. It may
    // run before OR after this hook, so the verify entry and board-presence
    // placeholders may still describe the previous run: never diagnose those here.
    // Other sources (e.g. a reviewer verdict) remain this hook's responsibility.
    const verifierOwnsResult = autoVerificationExpected && pi.getCommands().some((command) => command.name === "verify");
    autoVerificationExpected = false;
    if (!verificationRequired || correctionSent) return undefined;
    const dir = cwd || ctx?.cwd || "";
    if (!dir) return undefined;
    const board = missionCompleteBlocked(dir);
    const failing = verifierOwnsResult
      ? board.failing.filter((source) => !source.startsWith("verify") && !source.startsWith("("))
      : board.failing;
    if (verifierOwnsResult && failing.length === 0) {
      correctionSent = true;
      return undefined;
    }
    if (!board.blocked || failing.length === 0) return undefined;
    let results = failing.join(", ");
    try {
      const board: unknown = JSON.parse(fs.readFileSync(path.join(dir, ".pi", "verdicts.json"), "utf8"));
      // A null board keeps the reason, as reading a property of it (and throwing) did before.
      if (board !== null) {
        const recorded = isRecord(board) ? board.verdicts : undefined;
        results = failing.map((source) => {
          const verdict = isRecord(recorded) ? recorded[source] : undefined;
          // Any writer can put anything in the board file: unknown, rendered as before.
          const summary: unknown = isRecord(verdict) && verdict.summary ? verdict.summary : "no check result";
          return `${source}: ${String(summary).slice(0, 200)}`;
        }).join("; ");
      }
    } catch { /* retain the precise missing/corrupt-board reason */ }
    const message =
      `[orchestrator verification diagnostic] Check result: ${results}. ` +
      `This is an automatic extension diagnostic, not a new user request. ` +
      `The user's requested outcome still governs: an intentionally failing test or an accurately reported blocker does not need to become PASS. ` +
      `If you already reported this failure accurately, finish concisely without further tools. ` +
      `Otherwise fix only unexpected task failures within the user's scope, or correct your report to disclose the failed check. ` +
      `Do not investigate the verifier infrastructure or search .pi for a way to clear the result. ` +
      `Never fabricate a PASS or edit .pi/verdicts.json to silence this diagnostic. ` +
      `Slash commands such as /verify are operator commands, not shell commands.`;
    correctionSent = true;
    ctx?.ui?.setStatus?.("orchestrator", `blocked: ${failing.join(",")}`);
    try {
      pi.sendMessage({ customType: "orchestrator-verification", content: message, display: true },
        { triggerTurn: true, deliverAs: "followUp" });
    } catch {
      /* if steering is unavailable, the status + notify still signal the block */
      ctx?.ui?.notify?.(message, "warning");
    }
    return undefined;
  });

  pi.on("input", async (event, ctx) => {
    if (process.env.PI_KIT_ORCH_DISABLE === "1" || isInternalChild()) return;
    if (event.source === "extension") return;
    cwd = ctx.cwd;
    verificationRequired = false;
    correctionSent = false;
    autoVerificationExpected = false;
    const text = event.text?.trim() ?? "";
    // Leave commands / skill invocations / trivial inputs alone.
    if (text.startsWith("/") || text.length < 12) {
      if (!forcedOn) clearDirective(cwd);
      clearClassification(cwd);
      return;
    }
    if (forcedOff) {
      clearDirective(cwd);
      clearClassification(cwd);
      return;
    }
    const score = forcedOn ? Math.max(DEFAULT_THRESHOLD, scoreComplexity(text)) : scoreComplexity(text);
    writeClassification(cwd, score);
    if (isReadOnlyRequest(text)) {
      clearDirective(cwd);
      ctx.ui?.setStatus?.("orchestrator", "read-only request");
      return;
    }
    if ((forcedOn || score >= DEFAULT_THRESHOLD) && pi.getActiveTools().includes("subagent")) {
      verificationRequired = true;
      writeDirective(cwd, score);
      ctx.ui?.setStatus?.("orchestrator", `delegating (${score})`);
    } else {
      clearDirective(cwd);
      ctx.ui?.setStatus?.("orchestrator", "");
    }
  });

  pi.registerCommand("orchestrate", {
    description: "Control autonomous delegation: /orchestrate [on|off|auto|status]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      const dir = cwd || ctx.cwd;
      if (arg === "on" || arg === "always") {
        if (!pi.getActiveTools().includes("subagent")) {
          ctx.ui.notify("orchestrate: enable the subagent tool before requesting delegation", "warning");
          return;
        }
        forcedOn = true; forcedOff = false;
        writeDirective(dir, DEFAULT_THRESHOLD);
        ctx.ui.notify("orchestrate: ON (always delegate)", "info");
      } else if (arg === "off") {
        forcedOff = true; forcedOn = false;
        verificationRequired = false;
        clearDirective(dir);
        ctx.ui.notify("orchestrate: OFF (never auto-delegate this session)", "info");
      } else if (arg === "auto" || arg === "") {
        forcedOn = false; forcedOff = false;
        ctx.ui.notify(`orchestrate: AUTO (threshold ${DEFAULT_THRESHOLD})`, "info");
      } else if (arg === "status") {
        const mode = forcedOn ? "ON" : forcedOff ? "OFF" : "AUTO";
        ctx.ui.notify(`orchestrate: ${mode} · threshold ${DEFAULT_THRESHOLD} · built-in roles + ~/.pi/agent/agents`, "info");
      } else {
        ctx.ui.notify(`orchestrate: unknown option "${arg}"`, "error");
      }
    },
  });

  pi.registerCommand("orchestrate-plan", {
    description: "Delegate planning only, no changes: /orchestrate-plan <task>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      const dir = cwd || ctx.cwd;
      if (!task) {
        ctx.ui.notify("orchestrate-plan: usage: /orchestrate-plan <task>", "error");
        return;
      }
      if (!pi.getActiveTools().includes("subagent")) {
        ctx.ui.notify("orchestrate-plan: subagent tool is unavailable", "error");
        return;
      }
      // Sent as a message, not a contribution file: the next user input cleared or replaced the
      // file before the agent ever read it, so these commands had no effect. The input hook
      // ignores source "extension", so this message is not re-scored.
      clearDirective(dir);
      verificationRequired = false;
      correctionSent = false;
      ctx.ui.setStatus?.("orchestrator", "plan-only");
      pi.sendUserMessage(planOnlyDirective(task), typeof ctx.isIdle === "function" && !ctx.isIdle() ? { deliverAs: "followUp" } : undefined);
    },
  });

  pi.registerCommand("orchestrate-implement-review", {
    description: "Delegate the full plan → implement → review loop: /orchestrate-implement-review <task>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      const dir = cwd || ctx.cwd;
      if (!task) {
        ctx.ui.notify("orchestrate-implement-review: usage: /orchestrate-implement-review <task>", "error");
        return;
      }
      if (!pi.getActiveTools().includes("subagent")) {
        ctx.ui.notify("orchestrate-implement-review: subagent tool is unavailable", "error");
        return;
      }
      clearDirective(dir);
      verificationRequired = true;
      correctionSent = false;
      ctx.ui.setStatus?.("orchestrator", "implement+review");
      pi.sendUserMessage(implementReviewDirective(task), typeof ctx.isIdle === "function" && !ctx.isIdle() ? { deliverAs: "followUp" } : undefined);
    },
  });
}
