/**
 * Subagent — child launch contract.
 *
 * Every child pi session is started through delegation-guard's registry
 * (`globalThis[Symbol.for("pi-kit.delegation")]`), never by building extension arguments here:
 * the guard decides which protections the child must load, refuses the launch when one cannot be
 * located, reserves against the shared effort budget (at every depth) and hands back the child's
 * environment. Extensions may not import each other, hence the registry.
 *
 * If the guard is not loaded, nothing is launched: a child without it would run without the
 * mandatory protections or a budget, which must never be a silent fallback.
 */
import type { AgentConfig } from "./agents.ts";

export const DELEGATION_KEY = Symbol.for("pi-kit.delegation");

export type LaunchKind = "discretionary" | "recovery" | "mandatory" | "user" | "workflow";

export interface LaunchRequest {
  cwd: string;
  kind: LaunchKind;
  role: string;
  scout?: boolean | undefined;
  readOnly?: boolean | undefined;
  /** The read-only part of a role's tool list (`readOnlyTools`): a recovery launch runs with exactly these. */
  readOnlyTools?: string[] | undefined;
  requestedTier?: string | undefined;
  extraExtensions?: string[] | undefined;
  needsSubagent?: boolean | undefined;
  baseEnv?: Record<string, string | undefined> | undefined;
  /** Workflow launches: the run id and the token effort's openRunScope returned for it. */
  runId?: string | undefined;
  runToken?: string | undefined;
}

export interface LaunchSlot {
  id: string | null;
  attach(pid: number | undefined): void;
  settle(outcome: string): void;
}

export type PreparedLaunch =
  | { ok: true; args: string[]; env: Record<string, string | undefined>; loaded: string[]; required: string[]; slot: LaunchSlot; childTier: string; tools?: string[] | undefined }
  | { ok: false; code: string; reason: string };

interface DelegationRegistry {
  prepareChild(request: LaunchRequest): PreparedLaunch;
}

export function prepareChildLaunch(request: LaunchRequest): PreparedLaunch {
  const registry = (globalThis as Record<symbol, unknown>)[DELEGATION_KEY] as DelegationRegistry | undefined;
  if (!registry) {
    return {
      ok: false,
      code: "no-guard",
      reason: "the delegation-guard extension is not loaded, so a child cannot be started with the mandatory protections and an effort budget. It is in every shipped profile: run /profile to re-apply yours, or /reload if you just installed it.",
    };
  }
  try {
    return registry.prepareChild(request);
  } catch (error) {
    return { ok: false, code: "guard-error", reason: `delegation-guard failed (${error instanceof Error ? error.message : String(error)}); refusing to start an unguarded child.` };
  }
}

/**
 * The tools that can only read. Everything else can change state: `bash` and `powershell` run any
 * command, and an extension or MCP tool (or a `*` pattern) is not known to be harmless.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** A role is read-only when its tool list is explicit and names only read tools (no shell, write, edit or delegation). */
export function isReadOnlyRole(agent: AgentConfig, tools: string[] | undefined): boolean {
  const list = tools ?? agent.tools;
  return Boolean(list && list.length > 0 && list.every((t) => READ_ONLY_TOOLS.has(t)));
}

/**
 * The read tools of a role that is not read-only (a scout with `bash`), or undefined when the role is
 * already read-only or has no read tool. delegation-guard charges a recovery launch only on this list
 * and then hands it back, so the child runs with exactly these tools.
 */
export function readOnlyTools(agent: AgentConfig, tools: string[] | undefined): string[] | undefined {
  const list = tools ?? agent.tools;
  if (!list || list.length === 0 || isReadOnlyRole(agent, list)) return undefined;
  const narrowed = list.filter((t) => READ_ONLY_TOOLS.has(t));
  return narrowed.length > 0 ? narrowed : undefined;
}

/** Scouts are the investigation-only role; a role may also say `scout: true` in its frontmatter. */
export function isScoutRole(agent: AgentConfig): boolean {
  return agent.name === "scout" || agent.scout === true;
}
