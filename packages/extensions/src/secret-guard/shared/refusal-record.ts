// GENERATED from packages/core/shared/refusal-record.ts by packages/core/gen-shared.ts. Do not edit this copy:
// change the source and run `npm run gen:shared` (`npm run verify` fails when a copy differs).
/**
 * One structured record per refused tool call.
 *
 * The firewall and secret-guard both refuse calls, but only the firewall wrote a machine-readable
 * audit record (tool_seen / tool_blocked); a secret-guard refusal was a UI notice only, so its
 * cause could only be recovered by scraping session text afterwards. This helper appends one
 * `tool_refused` line to the same audit log for every refusal, whichever guard made it.
 *
 * A record names the guard, the cause, the non-secret rule identifier or token that matched, the
 * tool, a SHA-256 digest of the command (never the command text) and the session id. It must never
 * carry a secret value or a full command, and it must never break the tool call: every failure is
 * swallowed.
 *
 * Canonical source: packages/core/shared/refusal-record.ts. Extensions hold generated, byte-checked
 * copies (`npm run gen:shared`; `npm run verify` fails on drift).
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import { appendFileSafe } from "./safe-fs.ts";

/** The fields written for one refusal. `matched` is a rule id or path token, never a secret. */
export interface RefusalRecord {
  guard: "tool-firewall" | "secret-guard";
  cause: string;
  matched: string;
  tool: string;
  commandDigest?: string | undefined;
  sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SHA-256 hex of the command text, or undefined when there is no command to digest. */
export function commandDigest(command: unknown): string | undefined {
  if (typeof command !== "string" || !command) return undefined;
  return crypto.createHash("sha256").update(command).digest("hex");
}

/**
 * The session id from a pi extension context, with the legacy fallbacks the firewall uses: an older
 * runtime or test harness may put the id on the context itself, and a bare process id is the last
 * resort. Never throws.
 */
export function sessionIdOf(ctx: unknown): string {
  if (isRecord(ctx)) {
    try {
      const manager = ctx.sessionManager;
      if (isRecord(manager)) {
        const readId: unknown = manager.getSessionId;
        if (typeof readId === "function") {
          const id: unknown = (readId as () => unknown).call(manager);
          if (typeof id === "string" && id) return id;
        }
      }
    } catch {
      /* optional */
    }
    const legacy = ctx.sessionId;
    if (typeof legacy === "string" && legacy) return legacy;
  }
  return `pid-${process.pid}`;
}

function auditPath(): string {
  const configured = process.env.PI_KIT_FIREWALL_AUDIT_LOG;
  if (configured) return configured;
  return path.join(process.cwd(), ".pi", "tool-firewall-audit.jsonl");
}

/**
 * Appends exactly one `tool_refused` line to the firewall audit log. Best effort: a missing or
 * unsafe path, a permission error or a hostile symlink leaves the tool call unaffected.
 */
export function appendRefusal(record: RefusalRecord): void {
  try {
    const file = auditPath();
    // An operator-set path is trusted; the default lives under a workspace a cloned repository
    // controls, so the write must not follow links planted there (see ./safe-fs.ts).
    const options = process.env.PI_KIT_FIREWALL_AUDIT_LOG ? { mode: 0o600 } : { root: process.cwd(), mode: 0o600 };
    const digest = record.commandDigest ? { commandDigest: record.commandDigest } : {};
    const line = {
      timestamp: new Date().toISOString(),
      event: "tool_refused",
      guard: record.guard,
      cause: record.cause,
      matched: record.matched,
      tool: record.tool,
      ...digest,
      sessionId: record.sessionId,
    };
    appendFileSafe(file, `${JSON.stringify(line)}\n`, options);
  } catch {
    /* a refusal record must never break the tool call */
  }
}
