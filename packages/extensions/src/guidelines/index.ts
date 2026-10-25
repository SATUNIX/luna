import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { writeFileSafe } from "./shared/safe-fs.ts";

// AGENTS.md is deliberately not a candidate: pi already loads the first of AGENTS.md or
// CLAUDE.md in each directory into the system prompt as project context (not both), so
// re-injecting it here duplicated ~700+ tokens per turn.
const CANDIDATE_NAMES = ["GUIDELINES.md", ".pi/GUIDELINES.md"];

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

function readGuidelines(cwd: string): string | null {
  const envPath = process.env.PI_KIT_GUIDELINES_PATH;
  if (envPath && fs.existsSync(envPath)) return fs.readFileSync(envPath, "utf8");

  for (const name of CANDIDATE_NAMES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return null;
}

export default function (_pi: ExtensionAPI) {
  _pi.on("session_start", async (_event, ctx) => {
    currentSessionId = resolveSessionId(ctx.sessionManager);
    // Re-materialize the contribution so context-sieve can include it. The reader admits any
    // file written after its module-load epoch, so this does not depend on whether the
    // guidelines handler runs before or after context-sieve's session_start.
    const guidelinesText = readGuidelines(ctx.cwd);
    if (guidelinesText) {
      // Workspace state: never written through a committed symlink (./shared/safe-fs.ts).
      writeFileSafe(
        path.join(contribDir(ctx.cwd), "guidelines.json"),
        JSON.stringify({
          id: "guidelines",
          priority: 10,
          budgetTokens: 2000,
          content: `## Project Guidelines\n\n${guidelinesText.trim()}`,
        }),
        { root: ctx.cwd },
      );
    }
  });
}
