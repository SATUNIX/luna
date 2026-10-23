import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// goal-core: owns the mission goal. Persists it to .pi/GOAL.yaml and contributes it to the
// model-visible prompt via a ctx-contribution (context-sieve is the single injection authority —
// we never inject the system prompt directly; context-sieve does not read GOAL.yaml during compaction).

function goalFile(cwd: string): string {
  return path.join(cwd, ".pi", "GOAL.yaml");
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

function contribFile(cwd: string): string {
  return path.join(contribDir(cwd), "goal-core.json");
}

function readGoal(cwd: string): string | null {
  try {
    const raw = fs.readFileSync(goalFile(cwd), "utf8");
    // B-019: a multi-line goal is persisted twice — `goal:` keeps the first line so the
    // naive single-line readers in verify-gate/verifier-board (and older goal-core) are
    // unaffected, and `goal_full:` carries a JSON-encoded single-line scalar that preserves
    // the exact text, including line breaks, for goal-core's own round trip. Files written
    // by the old code (`goal:` only) read back exactly as before.
    const full = raw.match(/^goal_full:\s*(.*)$/m);
    if (full?.[1] !== undefined) {
      try {
        const parsed: unknown = JSON.parse(full[1].trim());
        if (typeof parsed === "string" && parsed.trim()) return parsed;
      } catch {
        /* malformed goal_full — fall back to the `goal:` scalar below */
      }
    }
    const m = raw.match(/^goal:\s*(.*)$/m);
    return (m?.[1] ?? raw).trim() || null;
  } catch {
    return null;
  }
}

function writeContribution(cwd: string, goal: string): void {
  try {
    const dir = contribDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      contribFile(cwd),
      JSON.stringify({
        id: "goal-core",
        priority: 85,
        budgetTokens: 400,
        content: `## Active Goal\n${goal}`,
      }),
      "utf8",
    );
  } catch {
    /* best effort */
  }
}

function setGoal(cwd: string, goal: string): void {
  const dir = path.join(cwd, ".pi");
  fs.mkdirSync(dir, { recursive: true });
  const firstLine = goal.split(/\r?\n/)[0];
  const yaml = /[\r\n]/.test(goal)
    ? `goal: ${firstLine}\ngoal_full: ${JSON.stringify(goal)}\ncreated: ${new Date().toISOString()}\n`
    : `goal: ${goal}\ncreated: ${new Date().toISOString()}\n`;
  fs.writeFileSync(goalFile(cwd), yaml, "utf8");
  writeContribution(cwd, goal);
}

function clearGoal(cwd: string): void {
  try { fs.rmSync(goalFile(cwd), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(contribFile(cwd), { force: true }); } catch { /* ignore */ }
}

export default function (pi: ExtensionAPI) {
  let cwd = "";

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    currentSessionId = resolveSessionId(ctx.sessionManager);
    // Re-materialize the contribution if a goal survives from a prior session. context-sieve
    // includes any file written after its module-load epoch, so this is independent of
    // whether goal-core's session_start handler runs before or after context-sieve's.
    const goal = readGoal(cwd);
    if (goal) writeContribution(cwd, goal);
  });

  pi.registerCommand("goal", {
    description: "Set or clear the mission goal: /goal <description> | /goal clear | /goal show",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const dir = cwd || ctx.cwd;
      if (arg === "" || arg === "show") {
        const goal = readGoal(dir);
        ctx.ui.notify(goal ? `goal: ${goal}` : "goal: (none set) — use /goal <description>", "info");
        return;
      }
      if (arg === "clear") {
        clearGoal(dir);
        ctx.ui.notify("goal: cleared", "info");
        return;
      }
      setGoal(dir, arg);
      ctx.ui.notify(`goal set: ${arg}`, "info");
    },
  });
}
