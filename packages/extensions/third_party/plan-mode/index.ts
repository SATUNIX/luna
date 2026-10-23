import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

const READ_ONLY_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);

const PLAN_NOTICE = `[PLAN MODE ACTIVE] Read-only exploration. Only use: read, bash (read-only), grep, find, ls. Do NOT write, edit, or modify files. Type /plan to exit.`;

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

export default function (pi: ExtensionAPI) {
  let planModeEnabled = false;

  function contribPath(cwd: string): string {
    return path.join(contribDir(cwd), "plan-mode.json");
  }

  function writeContrib(cwd: string): void {
    const dir = contribDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      contribPath(cwd),
      JSON.stringify({ id: "plan-mode", priority: 90, budgetTokens: 200, content: PLAN_NOTICE }),
      "utf8",
    );
  }

  function deleteContrib(cwd: string): void {
    try { fs.unlinkSync(contribPath(cwd)); } catch { /* best effort */ }
  }

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = resolveSessionId(ctx.sessionManager);
    // Clear any stale plan-mode contribution
    deleteContrib(ctx.cwd);
    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
      writeContrib(ctx.cwd);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!planModeEnabled) return undefined;
    if (!READ_ONLY_TOOLS.has(event.toolName)) {
      const msg = `plan-mode: blocked ${event.toolName} (read-only mode active — /plan to exit)`;
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      return { block: true, reason: msg };
    }
    return undefined;
  });

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration)",
    handler: async (_args, ctx) => {
      planModeEnabled = !planModeEnabled;
      if (planModeEnabled) {
        writeContrib(ctx.cwd);
        ctx.ui.notify("Plan mode ON (read-only)", "info");
      } else {
        deleteContrib(ctx.cwd);
        ctx.ui.notify("Plan mode OFF", "info");
      }
    },
  });
}
