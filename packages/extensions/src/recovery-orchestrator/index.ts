import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// recovery-orchestrator: the DEEP root-cause layer that progress-guard escalates into
// (docs/recovery-orchestration-mode.md, §2). When assistance (nudging) hasn't broken a loop,
// progress-guard writes .pi/recovery/sessions/<session-id>/escalation.json (see escalationPath
// below); on the next turn this extension enters recovery for that signature exactly once and:
//   1. writes a recovery report scaffold (.pi/recovery/<n>-<sig>.md),
//   2. drops a high-priority ctx-contribution steering the §2 flow (fresh scouts + forked
//      top-10 + synthesis + primary/backup plan + delegated fix) — context-sieve is the sole
//      injection authority, so we NEVER emit a systemPrompt,
//   3. bounds attempts per signature and, past the cap, escalates to the operator instead of
//      spawning further.
// It is NON-DESTRUCTIVE: it only writes report + contribution files; it never edits code or
// reverts changes. Detection of "fix failed / worse" is delegated to the verifier board.

const CONTRIB_ID = "recovery-orchestrator";
const MAX_ATTEMPTS = intEnv("PI_KIT_RECOVERY_MAX_ATTEMPTS", 2);
const SCOUTS = intEnv("PI_KIT_RECOVERY_SCOUTS", 3);

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
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

// REL-5: the escalation marker is scoped per session the same way, at
// .pi/recovery/sessions/<id>/escalation.json, so a child or a second session in this cwd can
// neither consume this session's marker nor delete it on its own session_start. A session
// without a usable id keeps the legacy flat .pi/recovery/escalation.json. progress-guard
// resolves the same path.
function escalationPath(cwd: string, sessionId: string | undefined = currentSessionId): string {
  const base = path.join(cwd, ".pi", "recovery");
  return isSessionId(sessionId) ? path.join(base, "sessions", sessionId, "escalation.json") : path.join(base, "escalation.json");
}

function contribPath(cwd: string): string {
  return path.join(contribDir(cwd), `${CONTRIB_ID}.json`);
}
function verdictsPath(cwd: string): string {
  return path.join(cwd, ".pi", "verdicts.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `obj[key]` when `obj` is an object, else undefined. */
function field(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

function safeSig(signature: string): string {
  return signature.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
}

// H-06 fix, partial: recovery previously handed back a 100%-blank template - every
// section ("Scout findings", "top-10 causes", ...) was an empty placeholder for the
// model to fill from scratch, with zero grounding in what actually happened. Extension-
// to-extension programmatic invocation of `subagent` (real scout fan-out) is not
// available through Pi's public extension API (no cross-extension tool-call mechanism -
// only the model can call a registered tool), so this does not fabricate scout output;
// it grounds the report in the one thing genuinely available offline: the real recorded
// action history from trace-ledger's .pi/trace.jsonl (same JSONL contract skill-forge's
// mineTrace reads - self-contained duplicate parsing per this repo's extension rule).
interface TraceEntry {
  kind?: "call" | "result";
  tool?: string;
  target?: string;
  status?: "ok" | "error";
}

// EFF-6: only a bounded byte tail is read (the ledger grows to 4 MiB before trace-ledger rotates
// it, and other writers append too), never the whole file. When the live file holds fewer than `n`
// entries (just after a rotation) the window is filled from the end of trace.jsonl.1.
const TRACE_TAIL_BYTES = 256 * 1024;

function readTailLines(file: string): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TRACE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytes).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

function toTraceEntry(line: string): TraceEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return null;
  const entry: TraceEntry = {};
  if (parsed.kind === "call" || parsed.kind === "result") entry.kind = parsed.kind;
  if (typeof parsed.tool === "string") entry.tool = parsed.tool;
  if (typeof parsed.target === "string") entry.target = parsed.target;
  if (parsed.status === "ok" || parsed.status === "error") entry.status = parsed.status;
  return entry;
}

function readRecentTrace(cwd: string, n: number): TraceEntry[] {
  const file = path.join(cwd, ".pi", "trace.jsonl");
  let entries = readTailLines(file).map(toTraceEntry).filter((e): e is TraceEntry => !!e);
  if (entries.length < n) entries = [...readTailLines(`${file}.1`).map(toTraceEntry).filter((e): e is TraceEntry => !!e), ...entries];
  return entries.slice(-n);
}

function traceGroundingSection(cwd: string): string {
  const entries = readRecentTrace(cwd, 30);
  if (entries.length === 0) return "(no trace-ledger data available for this session)";
  const calls = entries.filter((e) => e.kind === "call" && e.tool);
  const errors = entries.filter((e) => e.kind === "result" && e.status === "error").length;
  const toolCounts = new Map<string, number>();
  for (const { tool } of calls) if (tool) toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const recentTargets = calls
    .filter((e) => e.target)
    .slice(-8)
    .map((e) => `${e.tool}:${e.target}`);
  return [
    `- ${calls.length} tool calls in the trace window, ${errors} result(s) recorded as error.`,
    `- Most-called tools: ${topTools.map(([t, c]) => `${t} (${c}×)`).join(", ") || "(none)"}.`,
    `- Most recent targets: ${recentTargets.join(" → ") || "(none recorded)"}.`,
  ].join("\n");
}

export interface Escalation {
  signature: string;
  reason: string;
  count: number;
  at: string;
  sessionId?: string;
}

// Only `signature` is checked (as before typing); progress-guard and /recover write the other
// fields, which are taken on trust from the marker.
function isEscalation(value: unknown): value is Escalation {
  return isRecord(value) && typeof value.signature === "string";
}

export function readEscalation(cwd: string, sessionId: string | undefined = currentSessionId): Escalation | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(escalationPath(cwd, sessionId), "utf8"));
    // A marker naming another session is never acted on, wherever it was found.
    const owner = field(raw, "sessionId");
    if (owner !== undefined && owner !== sessionId) return null;
    if (isEscalation(raw)) return raw;
  } catch {
    /* none */
  }
  return null;
}

function boardPassing(cwd: string): boolean {
  try {
    const board: unknown = JSON.parse(fs.readFileSync(verdictsPath(cwd), "utf8"));
    const v = field(board, "verdicts");
    if (!v || typeof v !== "object") return true;
    const keys = Object.keys(v);
    return keys.length === 0 || keys.every((k) => field(field(v, k), "pass") !== false);
  } catch {
    return true;
  }
}

function recoveryContent(esc: Escalation, attempt: number, reportRel: string): string {
  return [
    `## recovery-orchestration: stuck on '${esc.signature}' (attempt ${attempt}/${MAX_ATTEMPTS})`,
    "",
    `Signal: ${esc.reason} (repeated ${esc.count}×). Assistance did not break the loop — run the`,
    "deep root-cause pass instead of grinding in this anchored context:",
    "",
    `1. **Fan out ${SCOUTS} fresh scouts** with the \`subagent\` tool (role \`scout\`, parallel) — each`,
    "   investigates independently and reports suspected causes. They must NOT see this context's",
    "   hypotheses or the attempt history (that would re-anchor them).",
    "2. **Interrogate the incumbent**: run one more `subagent` task that gets a digest of this",
    "   session's history (what was tried, what failed, the recorded actions in the report) and ask",
    "   it: \"What are we struggling with? List the **top 10 most likely causes.**\"",
    "3. **Synthesise** the scout reports + the top-10 into one ranked cause list; pick the single",
    "   most likely primary cause.",
    "4. **Plan primary + backup**: a fix for the primary cause, and a backup plan if it fails/regresses.",
    "   In a git repository `git-checkpoint` snapshots the working tree automatically each turn (the",
    "   operator can restore one when forking); there is nothing to call for it.",
    "5. **Delegate the repair** with the `subagent` tool to an `implementer` with JUST: the chosen",
    "   hypothesis, the target files, and the acceptance check — then call the `verify_completion`",
    "   tool so the verifier board clears. Forking the session and re-running the operator's verify",
    "   command are operator actions; if you need one, ask the operator instead of trying to run it.",
    "",
    `Fill in the recovery report at \`${reportRel}\` as you go. Skill: \`recovery-debugging\`,`,
    "`agent-orchestration`. Full method: docs/recovery-orchestration-mode.md.",
  ].join("\n");
}

function reportScaffold(esc: Escalation, attempt: number, cwd: string): string {
  return [
    `# Recovery report — ${esc.signature}`,
    "",
    `- Attempt: ${attempt}/${MAX_ATTEMPTS}`,
    `- Failing signature: \`${esc.signature}\``,
    `- Signal: ${esc.reason} (repeated ${esc.count}×)`,
    `- Entered: ${esc.at}`,
    "",
    "## Recorded action history (real, from trace-ledger — not a fill-in placeholder)",
    traceGroundingSection(cwd),
    "",
    "## Scout findings (fresh, independent — fill in once scouts have actually run)",
    Array.from({ length: SCOUTS }, (_v, i) => `- scout ${i + 1}: `).join("\n"),
    "",
    "## Incumbent top-10 likely causes (from the fork)",
    Array.from({ length: 10 }, (_v, i) => `${i + 1}. `).join("\n"),
    "",
    "## Ranked synthesis + chosen primary cause",
    "- primary: ",
    "",
    "## Primary plan",
    "- ",
    "",
    "## Backup plan (if primary fails/regresses)",
    "- ",
    "",
    "## Outcome",
    "- ",
    "",
  ].join("\n");
}

// Pure planner used by the eval harness and the runtime hook: given cwd + current state,
// decide whether to enter recovery and produce the artifacts to write.
export type RecoveryPlan =
  | { action: "none" }
  | { action: "cap"; escalation: Escalation; attempt: number }
  | { action: "enter"; escalation: Escalation; attempt: number; reportRel: string };

export function planRecovery(
  cwd: string,
  attemptsBySignature: Map<string, number>,
  sessionId: string | undefined = currentSessionId,
): RecoveryPlan {
  const esc = readEscalation(cwd, sessionId);
  if (!esc) return { action: "none" };
  if (!boardPassing(cwd)) {
    // board failing corroborates the stuck state; proceed
  }
  const prior = attemptsBySignature.get(esc.signature) ?? 0;
  const attempt = prior + 1;
  if (attempt > MAX_ATTEMPTS) return { action: "cap", escalation: esc, attempt };
  // Each entry gets its own report: start at the attempt number and take the first free name, so
  // a later episode (attempts restart at 1 after progress) never reuses a filled-in report.
  let n = attempt;
  const nameFor = (k: number) => path.join(".pi", "recovery", `${k}-${safeSig(esc.signature)}.md`);
  while (fs.existsSync(path.join(cwd, nameFor(n))) && n < attempt + 10_000) n++;
  const reportRel = nameFor(n);
  return { action: "enter", escalation: esc, attempt, reportRel };
}

// A successful write/edit is verified progress: the episode that escalated is over. Same
// tool-name test as progress-guard's isWrite (duplicated, not imported, so each extension stays
// independently extractable).
function isWriteTool(tool: string): boolean {
  return /^(write|edit|create|apply|str_replace|multi_?edit|patch|insert|append)/i.test(tool) || /write|edit/.test(tool.toLowerCase());
}

// Only a write to a named file outside `.pi/` counts as progress. The steer itself asks the model
// to fill in the recovery report under `.pi/recovery/`; if that bookkeeping write reset the count,
// following the steer would make the cap unreachable. A write naming no path is not counted.
function isProgressWrite(tool: unknown, input: unknown, isError: unknown, cwd: string): boolean {
  if (typeof tool !== "string" || !isWriteTool(tool) || isError === true) return false;
  if (!input || typeof input !== "object") return false;
  const o: Record<string, unknown> = { ...input };
  const target = o.path ?? o.file_path ?? o.filePath ?? o.file;
  if (typeof target !== "string" || target.trim() === "") return false;
  const rel = path.relative(path.resolve(cwd), path.resolve(cwd, target));
  return rel !== ".pi" && !rel.startsWith(`.pi${path.sep}`);
}

function writeContribution(cwd: string, content: string): void {
  try {
    const p = contribPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ id: CONTRIB_ID, priority: 90, budgetTokens: 480, content }), "utf8");
  } catch {
    /* best-effort */
  }
}

function clearEscalation(cwd: string): void {
  try { fs.rmSync(escalationPath(cwd), { force: true }); } catch { /* ignore */ }
}
function clearContribution(cwd: string): void {
  try { fs.rmSync(contribPath(cwd), { force: true }); } catch { /* ignore */ }
}

export default function (pi: ExtensionAPI) {
  let cwd = process.cwd();
  const attemptsBySignature = new Map<string, number>();

  function block(ctx: ExtensionContext, signature: string): void {
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? String(process.pid);
    const disposition = { state: "blocked", sessionId, cwd, signature, reason: "recovery attempt budget exhausted", at: new Date().toISOString() };
    // Same-session continuation owners can disarm synchronously before agent_end.
    // This is containment for the local loop, not a tree-wide scheduler/queue fence.
    pi.events?.emit("pi-kit:recovery-blocked", disposition);
    try {
      const file = path.join(cwd, ".pi", "recovery", `blocked-${safeSig(sessionId)}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(disposition), "utf8");
    } catch (error) {
      ctx.ui?.notify?.(`recovery: could not persist blocked disposition: ${String(error)}`, "error");
    }
    ctx.ui?.setStatus?.("recovery-orchestrator", "blocked: recovery budget exhausted");
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    currentSessionId = resolveSessionId(ctx.sessionManager);
    clearContribution(cwd);
    clearEscalation(cwd); // fresh session starts clean: only its own marker (REL-5)
  });

  // REL-3: attempts are counted per stuck episode, not per process. progress-guard uses the
  // fixed signature "stall" for every read stall, so without a reset unrelated, resolved
  // episodes added up to the cap. A successful write to a file outside .pi/ ends the episode for
  // every signature; recovery bookkeeping (the report under .pi/recovery/) does not.
  pi.on("tool_result", async (event, ctx) => {
    if (isProgressWrite(event.toolName, event.input, event.isError, ctx?.cwd ?? cwd)) attemptsBySignature.clear();
  });

  // Enter recovery at most MAX_ATTEMPTS times per escalated signature within one episode; a
  // successful write outside .pi/ (above) starts a new episode.
  pi.on("turn_end", async (_event, ctx) => {
    const c = ctx;
    cwd = c.cwd ?? cwd;
    const plan = planRecovery(cwd, attemptsBySignature);
    if (plan.action === "none") return;

    if (plan.action === "cap") {
      block(c, plan.escalation.signature);
      attemptsBySignature.set(plan.escalation.signature, plan.attempt);
      clearEscalation(cwd);
      const msg = `recovery-orchestrator: '${plan.escalation.signature}' still stuck after ${MAX_ATTEMPTS} recovery attempts — escalate to the operator (or dual-review).`;
      writeContribution(cwd, `## recovery: give up gracefully\n\n${msg}`);
      if (c.hasUI) c.ui.notify(msg, "error");
      return;
    }

    const { escalation: esc, attempt, reportRel } = plan;
    attemptsBySignature.set(esc.signature, attempt);
    try {
      const reportAbs = path.join(cwd, reportRel);
      fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
      fs.writeFileSync(reportAbs, reportScaffold(esc, attempt, cwd), { encoding: "utf8", flag: "wx" }); // created only if absent, in one step
    } catch {
      /* report is best-effort; the steer is the important part */
    }
    writeContribution(cwd, recoveryContent(esc, attempt, reportRel));
    // Open the small recovery delegation budget (read-only scouts) for this request. Only this trusted
    // code path can: a minimal-effort session may not delegate at will, but it can recover. The budget
    // closes with the next user turn (docs/effort.md).
    try {
      ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-kit.effort")] as { setRecoveryActive?(active: boolean, reason?: string): void } | undefined)?.setRecoveryActive?.(true, `recovery for ${esc.signature}`);
    } catch { /* effort is optional here */ }
    clearEscalation(cwd); // consumed — don't re-enter for the same escalation marker
    if (c.hasUI) c.ui.notify(`recovery-orchestrator: entered recovery for '${esc.signature}' (attempt ${attempt}/${MAX_ATTEMPTS}). See ${reportRel}.`, "warning");
  });

  pi.registerCommand("recover", {
    description: "Manually trigger recovery-orchestration for the current stuck state (/recover [signature]).",
    handler: async (args, ctx) => {
      const c: ExtensionContext = ctx;
      const dir = c.cwd ?? cwd;
      const signature = (args ?? "").trim() || "manual";
      // Seed an escalation the same way progress-guard would, then enter immediately.
      try {
        const file = escalationPath(dir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          JSON.stringify({ signature, reason: "operator invoked /recover", count: 1, at: new Date().toISOString(), ...(currentSessionId ? { sessionId: currentSessionId } : {}) }),
          "utf8",
        );
      } catch {
        /* ignore */
      }
      const plan = planRecovery(dir, attemptsBySignature);
      if (plan.action === "enter") {
        attemptsBySignature.set(plan.escalation.signature, plan.attempt);
        try {
          const reportAbs = path.join(dir, plan.reportRel);
          fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
          fs.writeFileSync(reportAbs, reportScaffold(plan.escalation, plan.attempt, dir), { encoding: "utf8", flag: "wx" }); // created only if absent, in one step
        } catch { /* ignore */ }
        writeContribution(dir, recoveryContent(plan.escalation, plan.attempt, plan.reportRel));
        clearEscalation(dir);
        if (c.hasUI) c.ui.notify(`recovery-orchestrator: recovery queued for '${signature}'. See ${plan.reportRel}.`, "info");
      } else if (plan.action === "cap") {
        block(c, signature);
        clearEscalation(dir);
        writeContribution(dir, `## Recovery blocked\nRecovery budget exhausted for '${signature}'. Report the blocker; await an operator decision. Do not retry unchanged recovery.`);
        if (c.hasUI) c.ui.notify(`recovery-orchestrator: '${signature}' has hit the attempt cap — escalate to the operator.`, "warning");
      }
    },
  });
}
