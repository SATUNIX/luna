import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Self-containment rule: import only node:* builtins and the pi peer. No sibling-extension
// imports. See CONTRIBUTING.md.
//
// delegation-guard is the ONE place that decides how a child pi session is launched. Every
// launch path (the subagent tool and workflows, the completion reviewer, conductor specialists
// and validators) asks it for the child's extension arguments and environment instead of
// building them itself, so no path can forget a protection:
//
//   - the child loads the mandatory protections (tool-firewall, secret-guard, protected-paths)
//     and any task-specific governance the parent runs (pentest governance), every extension whose
//     manifest says `childGovernance: true` and that the PARENT actually has loaded;
//   - a protection that cannot be located, or an override that tries to drop one, refuses the
//     launch (fail closed, with the reason), never a silently weaker child;
//   - the launch reserves against the shared effort ledger (budgets bind at every depth) and the
//     child inherits its tier as a pin and a cap;
//   - inside the child this same extension checks, before any tool runs, that every required
//     protection registered itself; if one did not, the child blocks every tool call and exits
//     with EX_CONFIG so the parent sees a visible failure, not a quiet gap.
//
// The registry lives on globalThis so extensions stay self-contained.

export const DELEGATION_KEY = Symbol.for("pi-kit.delegation");
export const PROTECTIONS_KEY = Symbol.for("pi-kit.protections");
export const EFFORT_KEY = Symbol.for("pi-kit.effort");
const EX_CONFIG = 78;

/** The three protections every child needs whenever its parent has them. */
export const MANDATORY_PROTECTIONS = ["tool-firewall", "secret-guard", "protected-paths"] as const;
/** Kit extensions a child gets by default when the operator has them enabled (not governance). */
export const DEFAULT_COMPANIONS = ["finish-reason-retry", "todo"];

// --- what is registered in this process -------------------------------------------------------

type Protections = { has(name: string): boolean; list?(): string[]; add?(name: string): unknown };

/** Whatever sits under the key is a registry when it has a callable has() (a Set, or another helper's registry). */
function isProtections(value: unknown): value is Protections {
  return (typeof value === "object" || typeof value === "function") && value !== null && "has" in value && typeof value.has === "function";
}

function isIterable(value: object): value is Iterable<unknown> {
  return Symbol.iterator in value && typeof value[Symbol.iterator] === "function";
}

function hasAdd(value: unknown): value is { add(name: string): unknown } {
  return (typeof value === "object" || typeof value === "function") && value !== null && "add" in value && typeof value.add === "function";
}

function protections(): Protections | null {
  const value = (globalThis as Record<symbol, unknown>)[PROTECTIONS_KEY];
  return isProtections(value) ? value : null;
}

/** Register a protection name in the shared registry (creates it as a Set when absent). */
export function registerProtection(name: string): void {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[PROTECTIONS_KEY];
  if (!existing) g[PROTECTIONS_KEY] = new Set<string>([name]);
  else if (hasAdd(existing)) existing.add(name);
}

function loadedProtections(): unknown[] {
  const p = protections();
  if (!p) return [];
  if (typeof p.list === "function") return p.list();
  // Without list() the registry is read as a Set; one that cannot be iterated throws, as the spread always did.
  if (!isIterable(p)) throw new TypeError("the protections registry is not iterable");
  return [...p];
}

// --- locating extensions and their manifests --------------------------------------------------

function extensionsRoot(): string {
  const override = process.env.PI_KIT_EXTENSIONS_ROOT?.trim();
  if (override) return override;
  // <root>/packages/extensions/src/delegation-guard/index.ts -> <root>/packages/extensions
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

// Kit extensions are addressed by NAME, never by path. A role or workflow file that lists `extensions:` (or a
// settings file the project can write) must not be able to load arbitrary code, in-process and before any tool
// hook, into a governed child; a name that is not a plain registry name resolves to nothing and is skipped.
const KIT_EXTENSION_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function kitExtensionPath(name: string): string | null {
  if (!KIT_EXTENSION_NAME.test(name)) return null;
  for (const avenue of ["src", "third_party"]) {
    const p = path.join(extensionsRoot(), avenue, name, "index.ts");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Names of kit extensions whose manifest declares `childGovernance: true`. */
export function governanceExtensions(): string[] {
  const names: string[] = [];
  for (const avenue of ["src", "third_party"]) {
    const dir = path.join(extensionsRoot(), avenue);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith("_")) continue;
      if (readJson(path.join(dir, name, "extension.json"))?.childGovernance === true) names.push(name);
    }
  }
  return names.sort();
}

/** Kit extensions the operator enabled (global + project settings), or null when the kit entry is unfiltered / not found. */
export function enabledKitExtensions(cwd: string): Set<string> | null {
  let found: Set<string> | null = null;
  for (const file of [path.join(agentDir(), "settings.json"), path.join(cwd, ".pi", "settings.json")]) {
    const listed = readJson(file)?.packages;
    const packages: unknown[] = Array.isArray(listed) ? listed : [];
    for (const entry of packages) {
      if (!isRecord(entry) || typeof entry.source !== "string" || !Array.isArray(entry.extensions)) continue;
      const extensions: unknown[] = entry.extensions;
      const names = extensions
        .filter((e): e is string => typeof e === "string" && !e.startsWith("!"))
        .map((e) => e.match(/(?:src|third_party)\/([^/]+)\/index\.ts$/)?.[1])
        .filter((n): n is string => Boolean(n));
      if (names.length > 0) found = new Set(names);
    }
  }
  return found;
}

// --- the launch contract ----------------------------------------------------------------------

export type LaunchKind = "discretionary" | "recovery" | "mandatory" | "user" | "workflow";

export interface ChildRequest {
  /** The child's working directory (settings are read from here for project scope). */
  cwd: string;
  kind: LaunchKind;
  /** Agent name or purpose label, used for budgeting and messages. */
  role: string;
  scout?: boolean;
  readOnly?: boolean;
  /**
   * The read-only part of the role's tool list, when the role itself is not read-only (a scout with
   * `bash`). A launch charged to the recovery budget is charged on this list and the guard returns it
   * as `tools`, which the launcher must run the child with.
   */
  readOnlyTools?: string[] | undefined;
  requestedTier?: string;
  /** Extra kit extensions (names or absolute paths), e.g. from role frontmatter. They only add. */
  extraExtensions?: string[];
  /** The child may delegate further (its tool list names `subagent`). */
  needsSubagent?: boolean;
  /** Environment to derive the child's from (defaults to this process's). */
  baseEnv?: Record<string, string | undefined>;
  /**
   * "isolated" (default): the child loads exactly the guard's extension set (`--no-extensions`).
   * "ambient": the child keeps loading the operator's installed extensions (for launchers whose
   * children need tools those extensions provide, e.g. MCP servers in a pentest specialist); the
   * guard hands back only `-e <delegation-guard>` (so the check below always runs) and the
   * environment, and the child's own delegation-guard then verifies that every required protection
   * is loaded, failing closed when one is not.
   */
  isolation?: "isolated" | "ambient";
  /**
   * Workflow launches (kind "workflow"): the script-workflow run id and the run token effort's
   * openRunScope returned. The reservation is charged to that run's pinned scope, and the child
   * never gets the subagent extension, whatever the request or the operator's companions say.
   */
  runId?: string;
  runToken?: string;
}

export interface LaunchSlot {
  id: string | null;
  attach(pid: number | undefined): void;
  settle(outcome: string): void;
}

export type Prepared =
  | { ok: true; args: string[]; env: Record<string, string | undefined>; loaded: string[]; required: string[]; slot: LaunchSlot; childTier: string; tools?: string[] | undefined }
  | { ok: false; code: string; reason: string };

interface EffortRegistry {
  /** Present when the effort extension is new enough to know about recovery. */
  recoveryEligible?(role: string, readOnly?: boolean): boolean;
  reserve(input: { kind: LaunchKind; role: string; scout?: boolean | undefined; readOnly?: boolean | undefined; requestedTier?: string | undefined; runId?: string | undefined; runToken?: string | undefined }):
    | { ok: true; id: string | null; childTier: string; env: Record<string, string>; attach: (pid: number | undefined) => void; settle: (outcome: string) => void }
    | { ok: false; code: string; reason: string };
}

const refuse = (code: string, reason: string): Prepared => ({ ok: false, code, reason });

/**
 * Names the child must load: every governance extension (manifest `childGovernance: true`) that
 * the parent process actually registered, plus the mandatory protections the parent has. When
 * this process has no protections registry at all (nothing to inherit), only this guard itself.
 */
export function requiredForChild(): string[] {
  const parent = protections();
  const governance = governanceExtensions();
  const required = new Set<string>();
  for (const name of governance) if (parent?.has(name)) required.add(name);
  for (const name of MANDATORY_PROTECTIONS) if (parent?.has(name)) required.add(name);
  required.add("delegation-guard");
  required.add("effort");
  return [...required];
}

export function prepareChild(request: ChildRequest): Prepared {
  const effort = (globalThis as Record<symbol, unknown>)[EFFORT_KEY] as EffortRegistry | undefined;
  if (!effort) {
    if (request.kind !== "mandatory") return refuse("no-effort", "the effort extension is not loaded, so delegation cannot be budgeted. Add `effort` to the profile (it is in every shipped profile) or work directly.");
  }

  const required = requiredForChild();
  const ambient = request.isolation === "ambient";
  const paths = new Map<string, string>();
  const missing: string[] = [];
  // An ambient child loads the operator's installed extensions, so the guard cannot say which ones. It does say one
  // thing itself: this guard is loaded explicitly (`-e`), even when the child's settings would not load it, because
  // the child's own guard is what verifies that every required protection is present and exits 78 when one is not.
  for (const name of ambient ? ["delegation-guard"] : required) {
    const p = kitExtensionPath(name);
    if (p) paths.set(name, p);
    else missing.push(name);
  }
  if (missing.length) {
    return refuse("governance-missing", `cannot start a child: required protection${missing.length === 1 ? "" : "s"} ${missing.join(", ")} could not be located next to this extension (${extensionsRoot()}). A child is never started with weaker protection than its parent. Reinstall the kit.`);
  }

  // Optional additions never remove anything: defaults the operator enabled, an operator
  // override list (PI_KIT_SUBAGENT_EXTENSIONS), and what the role asks for.
  const env: Record<string, string | undefined> = { ...(request.baseEnv ?? process.env) };
  const enabled = enabledKitExtensions(request.cwd);
  const overrideRaw = env.PI_KIT_SUBAGENT_EXTENSIONS;
  const base = overrideRaw !== undefined ? overrideRaw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_COMPANIONS;
  const extras = new Set<string>();
  for (const name of base) if (overrideRaw !== undefined || !enabled || enabled.has(name)) extras.add(name);
  for (const name of request.extraExtensions ?? []) extras.add(name);
  if (request.needsSubagent) extras.add("subagent");
  // A workflow agent runs at depth 1 and never delegates further.
  if (request.kind === "workflow") extras.delete("subagent");
  const optional = new Map<string, string>();
  for (const name of ambient ? [] : extras) {
    if (paths.has(name)) continue;
    const p = kitExtensionPath(name);
    if (p) optional.set(name, p); // an unknown optional extension is skipped: it is not a protection
  }

  // While the trusted recovery extension has recovery active, a read-only recovery role (a scout) is
  // charged to the separate recovery budget first, so a session at the lowest effort can still get
  // help when stuck and recovery never eats the discretionary budget. Once that budget is used up
  // the launch falls back to the ordinary budget, which the tier then allows or refuses. A role that
  // is not read-only but offers its read tools (`readOnlyTools`) is charged to recovery as read-only
  // only on that narrower list, which is returned as `tools` for the child to run with.
  const narrowed = request.readOnly !== true && request.readOnlyTools && request.readOnlyTools.length > 0 ? [...request.readOnlyTools] : undefined;
  const reserveAs = (registry: EffortRegistry, kind: LaunchKind, readOnly: boolean | undefined) => registry.reserve({ kind, role: request.role, scout: request.scout, readOnly, requestedTier: request.requestedTier, ...(kind === "workflow" ? { runId: request.runId, runToken: request.runToken } : {}) });
  const recovery = Boolean(effort && request.kind === "discretionary" && effort.recoveryEligible?.(request.role, narrowed ? true : request.readOnly));
  let childTools = recovery ? narrowed : undefined;
  let reservation = effort
    ? recovery
      ? reserveAs(effort, "recovery", narrowed ? true : request.readOnly)
      : reserveAs(effort, request.kind, request.readOnly)
    : ({ ok: true as const, id: null, childTier: "standard", env: {}, attach() {}, settle() {} });
  if (!reservation.ok && effort && request.kind === "discretionary" && reservation.code === "recovery-budget") {
    childTools = undefined;
    reservation = reserveAs(effort, "discretionary", request.readOnly);
  }
  if (!reservation.ok) return refuse(reservation.code, reservation.reason);

  // Order matters, as it does in a profile: this guard first (its blocking hook must run before
  // any other extension's), then the path/secret guards that may precede the firewall, then the
  // firewall, then the remaining governance, then optional companions.
  const front = ["delegation-guard", "protected-paths", "secret-guard", "tool-firewall"];
  const ordered: Array<[string, string]> = [
    ...front.flatMap((n): Array<[string, string]> => {
      const p = paths.get(n);
      return p === undefined ? [] : [[n, p]];
    }),
    ...[...paths].filter(([n]) => !front.includes(n)).sort(([a], [b]) => a.localeCompare(b)),
    ...optional,
  ];
  const args: string[] = [];
  if (!ambient) args.push("--no-extensions");
  for (const [, p] of ordered) args.push("-e", p);

  // The knobs that could weaken a child are not passed on; the child derives them again.
  delete env.PI_KIT_SUBAGENT_ISOLATE;
  env.PI_KIT_INTERNAL_CHILD = "1";
  env.PI_KIT_CHILD_REQUIRE = required.join(",");
  for (const [key, value] of Object.entries(reservation.env)) env[key] = value;

  return { ok: true, args, env, loaded: ordered.map(([n]) => n), required, slot: { id: reservation.id, attach: reservation.attach, settle: reservation.settle }, childTier: reservation.childTier, ...(childTools ? { tools: childTools } : {}) };
}

export interface DelegationRegistry {
  version: 1;
  prepareChild(request: ChildRequest): Prepared;
  requiredForChild(): string[];
}

// --- child side -----------------------------------------------------------------------------

/** The required protection names this child process was told to have, from PI_KIT_CHILD_REQUIRE. */
export function childRequirements(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PI_KIT_CHILD_REQUIRE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function missingProtections(required: string[]): string[] {
  const loaded = new Set(loadedProtections());
  return required.filter((name) => !loaded.has(name));
}

export default function (pi: ExtensionAPI) {
  registerProtection("delegation-guard");
  const registry: DelegationRegistry = { version: 1, prepareChild, requiredForChild };
  (globalThis as Record<symbol, unknown>)[DELEGATION_KEY] = registry;

  let blocked: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    (globalThis as Record<symbol, unknown>)[DELEGATION_KEY] = registry;
    const required = childRequirements();
    if (required.length === 0) return; // a root session
    const missing = missingProtections(required);
    if (missing.length === 0) return;
    blocked = `delegation-guard: this child session is missing required protection${missing.length === 1 ? "" : "s"} (${missing.join(", ")}) that its parent has. Every tool call is refused.`;
    process.stderr.write(`${blocked}\n`);
    if (ctx.hasUI) ctx.ui.notify(blocked, "error");
    // A child that cannot enforce the boundary must not run: exit visibly so the parent reports
    // a launch failure rather than treating an unprotected child as healthy.
    process.exitCode = EX_CONFIG;
    setTimeout(() => process.exit(EX_CONFIG), 50);
  });

  pi.on("tool_call", async () => {
    if (blocked) return { block: true, reason: blocked };
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    if ((globalThis as Record<symbol, unknown>)[DELEGATION_KEY] === registry) Reflect.deleteProperty(globalThis, DELEGATION_KEY);
  });
}
