import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { writeFileSafe } from "./shared/safe-fs.ts";

export function iterationLimit(value: string | undefined): number {
  const parsed = Number(value ?? 20);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : 20;
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
  return path.join(contribDir(cwd), "autonomous-loop.json");
}

// Arm-time marker (Epic 5 Sprint 5.1): other extensions (progress-guard) detect that an
// unattended loop is running by the presence of this file, instead of requiring the operator
// to set PI_KIT_GUARD_MODE=auto. Written when armed, removed when stopped/exhausted.
function armMarkerPath(cwd: string): string {
  return path.join(cwd, ".pi", "autonomous-loop.armed.json");
}

function writeArmMarker(goal: string, cwd: string, sessionId: string): void {
  try {
    // Workspace state: never written through a committed symlink (./shared/safe-fs.ts).
    // `at` is the freshness heartbeat: progress-guard ignores a marker older than its TTL, so a
    // marker left behind by a crashed loop cannot pin resolveMode to auto in later sessions.
    // `sessionId` records which session owns the loop for operators and future reaping.
    writeFileSafe(armMarkerPath(cwd), JSON.stringify({ armed: true, goal, sessionId, at: new Date().toISOString() }), { root: cwd });
  } catch {
    /* best-effort */
  }
}

function deleteArmMarker(cwd: string): void {
  try { fs.unlinkSync(armMarkerPath(cwd)); } catch { /* already gone */ }
}

function writeContrib(goal: string, cwd: string): void {
  writeFileSafe(
    contribPath(cwd),
    JSON.stringify({
      id: "autonomous-loop",
      priority: 100,
      budgetTokens: 500,
      content: `## Autonomous Loop Active\nGoal: ${goal}\nContinue working toward this goal. When the goal is met, call the loop_complete tool with a short reason to end the loop.`,
    }),
    { root: cwd },
  );
}

function deleteContrib(cwd: string): void {
  try { fs.unlinkSync(contribPath(cwd)); } catch { /* already gone */ }
}

/**
 * REL-1: the stop reason of the run's last assistant message, or undefined when the run has no
 * assistant message. "aborted" is an operator abort (Esc); "error" is a provider error.
 */
export function lastStopReason(event: Partial<AgentEndEvent> | undefined): { stopReason: string; errorMessage: string | undefined } | undefined {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let loopGoal: string | null = null;
  let loopActive = false;
  let loopIterationsLeft = 0;
  let loopCwd = "";
  let sessionId = "";
  let unsubscribe: (() => void) | undefined;

  function stop(): void {
    loopActive = false;
    loopGoal = null;
    loopIterationsLeft = 0;
    if (loopCwd) { deleteContrib(loopCwd); deleteArmMarker(loopCwd); }
  }

  pi.on("session_start", async (_event, ctx) => {
    loopCwd = ctx.cwd;
    currentSessionId = resolveSessionId(ctx.sessionManager);
    loopActive = false;
    loopGoal = null;
    loopIterationsLeft = 0;
    sessionId = ctx.sessionManager?.getSessionId?.() ?? String(process.pid);
    // Do not remove another session's workspace markers on child startup.
    unsubscribe?.();
    unsubscribe = pi.events?.on("pi-kit:recovery-blocked", (data: unknown) => {
      // Event-bus data is unknown: only an object naming this loop's cwd and session stops it.
      if (typeof data !== "object" || data === null) return;
      if (Reflect.get(data, "cwd") === loopCwd && Reflect.get(data, "sessionId") === sessionId) stop();
    });
  });

  pi.on("session_shutdown", async () => { if (loopActive) stop(); unsubscribe?.(); });

  pi.registerCommand("loop", {
    description: "Enable autonomous loop: /loop <goal> starts the loop; /loop stop ends it.",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (goal === "stop" || goal === "") {
        stop();
        ctx.ui.notify("Autonomous loop stopped. Previously queued messages or external processes may still need cancellation in Pi.", "info");
        return;
      }
      loopGoal = goal;
      loopActive = true;
      const limit = iterationLimit(process.env.PI_KIT_LOOP_MAX);
      loopIterationsLeft = limit;
      loopCwd = ctx.cwd;
      writeContrib(goal, ctx.cwd);
      writeArmMarker(goal, ctx.cwd, sessionId);
      ctx.ui.notify(`Autonomous loop active. Goal: ${goal}\nMax iterations: ${limit}. Use /loop stop to exit.`, "info");
    },
  });

  // REL-2: the model cannot run slash commands, so it ends the loop with this tool.
  pi.registerTool({
    name: "loop_complete",
    label: "Loop: complete",
    description: "End the autonomous loop (/loop) because its goal is met. Call once the work is done and verified.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the goal is met (for example, the check that now passes)" }),
    }),
    async execute(_toolCallId, params) {
      const text = loopActive
        ? `Autonomous loop ended: ${params.reason}`
        : "No autonomous loop is armed; nothing to end.";
      if (loopActive) stop();
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!loopActive || !loopGoal) return;
    // REL-1: an operator abort or a provider error ends the loop instead of re-queueing Continue.
    const last = lastStopReason(event);
    if (last?.stopReason === "aborted" || last?.stopReason === "error") {
      stop();
      const detail = last.stopReason === "aborted" ? "the turn was aborted" : `the provider returned an error${last.errorMessage ? `: ${last.errorMessage}` : ""}`;
      ctx?.ui?.notify?.(`Autonomous loop stopped: ${detail}. Run /loop <goal> to start it again.`, "warning");
      return;
    }
    if (loopIterationsLeft <= 0) {
      stop();
      return;
    }
    // Heartbeat: refresh the marker's timestamp so a live loop stays fresh to progress-guard.
    writeArmMarker(loopGoal, loopCwd, sessionId);
    loopIterationsLeft--;
    pi.sendUserMessage(`Continue: ${loopGoal}`, { deliverAs: "followUp" });
  });
}
