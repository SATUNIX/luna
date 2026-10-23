import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ledger from "./ledger.ts";
import { installedProfile, isModelKey, MEMENTO_PROFILES, mementoAllowance, modelKey, optInPath, readOptIn, writeOptIn } from "./memento.ts";
import { clampTier, loadPolicy, mementoGenerations, normalizeTier, renderPrompt, renderStanding, tierLabel, tierLimits, tierOf, withEffortBlock, workflowLimits } from "./policy.ts";
import type { EffortPolicy, LimitOverrides, TierLimits } from "./policy.ts";
import { DEFAULT_SIZE, lastStandingEntry, parseStandingArgs, STANDING_ENTRY_TYPE, STANDING_OFF, STANDING_REMINDER_TYPE, standingData, WAKE_CHAIN_CAP, WORKFLOW_RESULT_TYPE, WORKFLOW_TOOL } from "./standing.ts";
import type { StandingState } from "./standing.ts";

// Self-containment rule: import only node:* builtins and the pi peer, plus this extension's own
// files. No sibling-extension imports. See CONTRIBUTING.md.
//
// effort is an execution policy: how deep and how broad the agent works, and how much it may
// delegate. It is independent of the model's thinking level, the profile and every permission
// (docs/effort.md). It owns
//   - the five tiers (policy/effort.json) and /effort,
//   - one prompt contribution per turn, replaced (never appended twice) at the user-turn boundary,
//   - the shared delegation ledger every launch point reserves against, at any depth,
//   - a small registry (globalThis[Symbol.for("pi-kit.effort")]) other extensions read: the footer
//     for the tier chip, delegation launch points for reservations.

export const REGISTRY_KEY = Symbol.for("pi-kit.effort");
const PROTECTIONS_KEY = Symbol.for("pi-kit.protections");

/** Tell the shared protections registry this extension is loaded (a child verifies it before running tools). */
function registerProtection(name: string): void {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[PROTECTIONS_KEY] as { add?: (n: string) => unknown } | undefined;
  if (!existing) g[PROTECTIONS_KEY] = new Set<string>([name]);
  else if (typeof existing.add === "function") existing.add(name);
}

export type EffortSource = "default" | "user" | "env" | "cap";

export interface EffortSnapshot {
  version: 1;
  /** Canonical tier id in force for the current turn. */
  tier: string;
  code: string;
  label: string;
  source: EffortSource;
  /** True when a run or a parent pinned the tier: /effort then only saves a default for later. */
  pinned: boolean;
  /** The highest tier this process may use (set for children), or null. */
  cap: string | null;
  limits: TierLimits;
  usage: ledger.Usage;
  ledger: string | null;
  /** A tier chosen with /effort that starts at the next user turn, when it differs from `tier`. */
  pendingTier: string | null;
  /** Problems reading the policy or the user's config (shown by /effort status). */
  warnings: string[];
  /** False when the policy could not be loaded: delegation is then refused, never unbudgeted. */
  healthy: boolean;
}

export interface ReserveInput {
  kind: ledger.LaunchKind;
  role: string;
  scout?: boolean;
  readOnly?: boolean;
  /** The child's requested tier; it is clamped to this process's tier (a child is never higher). */
  requestedTier?: string;
  /** Workflow launches: the run id and the token openRunScope returned for it. */
  runId?: string;
  runToken?: string;
}

/** A workflow run's pinned scope: every agent of the run reserves with this id and token. */
export type RunScope = { ok: true; runId: string; runToken: string; ledger: string } | { ok: false; code: string; reason: string };

/** Thrown by reserveWorkflow for every denial except "concurrency" (which it waits out). */
export class WorkflowLedgerError extends Error {
  readonly code: string;
  constructor(code: string, reason: string) {
    super(reason);
    this.name = "WorkflowLedgerError";
    this.code = code;
  }
}

export interface ReserveWorkflowOptions {
  /** Aborting stops the wait for a slot; the promise then rejects with code "aborted". */
  signal?: AbortSignal;
  /** How often a waiting reservation asks again (default 250 ms). */
  pollMs?: number;
}

export type Reservation =
  | { ok: true; id: string | null; childTier: string; env: Record<string, string>; attach(pid: number | undefined): void; settle(outcome: string): void }
  | { ok: false; code: string; reason: string };

/** Ultracode standing mode as other extensions read it (the firewall, the workflow tool). */
export interface StandingSnapshot extends StandingState {
  /** Completion turns in a row since your last message. */
  wakeChain: number;
}

export interface EffortRegistry {
  version: 1;
  snapshot(): EffortSnapshot;
  /**
   * Ultracode standing mode. `preauthorised` is true only after the operator answered Yes to the
   * No-first select in this session; the firewall then runs `workflow` calls without asking.
   */
  standing(): StandingSnapshot;
  reserve(input: ReserveInput): Reservation;
  /** Only the trusted recovery extension calls this; the model cannot open the recovery budget. */
  setRecoveryActive(active: boolean, reason?: string): void;
  /**
   * True while recovery is active and `role` is one of the read-only roles the recovery budget may
   * start. A launcher that would reserve a discretionary slot for such a role reserves a recovery
   * slot first, so recovery help does not spend (and is not blocked by) the discretionary budget.
   */
  recoveryEligible(role: string, readOnly?: boolean): boolean;
  /**
   * Open a script-workflow run's scope in this session's workflow ledger. The scope is pinned: it
   * outlives the per-turn ledger rotation, so a background run keeps its count across user turns.
   * Refused in child processes and when the policy is unavailable.
   */
  openRunScope(runId: string): RunScope;
  /**
   * Reserve a slot for one agent of a workflow run. A "concurrency" denial is waited out (polling
   * until a slot frees or `signal` aborts); every other denial throws a WorkflowLedgerError.
   */
  reserveWorkflow(input: { runId: string; runToken: string; role: string }, options?: ReserveWorkflowOptions): Promise<Extract<Reservation, { ok: true }>>;
  onChange(listener: () => void): () => void;
}

/** A mandatory verification launch when no ledger exists: allowed, unbudgeted, carries no effort env. */
function unbudgeted(childTier: string): Reservation {
  const env: Record<string, string> = {};
  return { ok: true, id: null, childTier, env, attach: () => {}, settle: () => {} };
}

/** Tools through which the model starts children of its own accord. Hidden while the tier allows none. */
export const DELEGATION_TOOLS = ["subagent", "workflow_run"];

const USAGE_REFRESH_MS = 2000;
const LEDGER_KEEP_MS = 24 * 60 * 60 * 1000;
const MANDATORY_MAX = 6;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function configPath(): string {
  return process.env.PI_KIT_EFFORT_CONFIG?.trim() || path.join(agentDir(), "pi-kit", "effort.json");
}

function ledgerDir(): string {
  return path.join(agentDir(), "pi-kit", "effort", "ledgers");
}

/** Wait `ms`, or less when the signal aborts first (the caller then sees `signal.aborted`). */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface UserConfig {
  tier: string | null;
  limits: LimitOverrides;
  warnings: string[];
}

/** Read <agent dir>/pi-kit/effort.json. A missing file is normal; malformed content is ignored with a warning, never fatal. */
export function readConfig(policy: EffortPolicy, file = configPath()): UserConfig {
  const out: UserConfig = { tier: null, limits: {}, warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") out.warnings.push(`ignored ${file}: not valid JSON`);
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    out.warnings.push(`ignored ${file}: not an object`);
    return out;
  }
  const cfg = raw as { default?: unknown; limits?: unknown };
  if (cfg.default !== undefined) {
    const tier = normalizeTier(policy, cfg.default);
    if (tier) out.tier = tier;
    // JSON.stringify, not String(): an object such as {"toString": 1} cannot be converted to a
    // primitive, and String() would throw instead of warning.
    else out.warnings.push(`ignored default "${typeof cfg.default === "string" ? cfg.default : JSON.stringify(cfg.default)}" in ${file}: not an effort tier`);
  }
  if (cfg.limits && typeof cfg.limits === "object" && !Array.isArray(cfg.limits)) {
    for (const [id, value] of Object.entries(cfg.limits as Record<string, unknown>)) {
      if (!tierOf(policy, id)) {
        out.warnings.push(`ignored limits for unknown tier "${id}" in ${file}`);
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const limits: Partial<TierLimits> = {};
      for (const key of ["maxConcurrent", "maxTotal", "maxScouts"] as const) {
        const n = (value as Record<string, unknown>)[key];
        if (n === undefined) continue;
        if (typeof n === "number" && Number.isInteger(n) && n >= 0) limits[key] = n;
        else out.warnings.push(`ignored limits.${id}.${key} in ${file}: not a non-negative integer`);
      }
      out.limits[id] = limits;
    }
  }
  return out;
}

/** Save the default tier, keeping every other key in the file. Atomic. */
export function saveDefault(tier: string | null, file = configPath()): void {
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch {
    /* start from an empty file */
  }
  const next: Record<string, unknown> = { schemaVersion: 1, ...existing };
  if (tier === null) delete next.default;
  else next.default = tier;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

interface Resolved {
  tier: string;
  source: EffortSource;
  pinned: boolean;
  cap: string | null;
  warnings: string[];
}

/**
 * Precedence, highest first: a pin from the environment (PI_KIT_EFFORT: set by an autonomous run
 * or by the parent for a child), then the user's saved default, then the policy default. A cap
 * (PI_KIT_EFFORT_CAP, set for children) is applied last and can only lower the result. An invalid
 * pin is reported and ignored; an invalid cap fails closed to the lowest tier.
 */
export function resolveEffective(policy: EffortPolicy, env: NodeJS.ProcessEnv, config: UserConfig): Resolved {
  const warnings: string[] = [];
  let tier = policy.default;
  let source: EffortSource = "default";
  const saved = config.tier;
  if (saved) {
    tier = saved;
    source = "user";
  }
  let pinned = false;
  const pinRaw = env.PI_KIT_EFFORT?.trim();
  if (pinRaw) {
    const pin = normalizeTier(policy, pinRaw);
    if (pin) {
      tier = pin;
      source = "env";
      pinned = true;
    } else warnings.push(`ignored PI_KIT_EFFORT="${pinRaw}": not an effort tier`);
  }
  let cap: string | null = null;
  const capRaw = env.PI_KIT_EFFORT_CAP?.trim();
  if (capRaw) {
    cap = normalizeTier(policy, capRaw);
    if (!cap) {
      warnings.push(`PI_KIT_EFFORT_CAP="${capRaw}" is not an effort tier; using the lowest tier`);
      const lowest = policy.tiers[0];
      if (!lowest) throw new Error("effort policy has no tiers");
      cap = lowest.id;
    }
    const clamped = clampTier(policy, tier, cap);
    if (clamped !== tier) {
      tier = clamped;
      source = "cap";
    }
    pinned = true;
  }
  return { tier, source, pinned, cap, warnings };
}

function say(ctx: ExtensionCommandContext | ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else process.stderr.write(`[effort] ${text}\n`);
}

const isChildProcess = () => Boolean(process.env.PI_KIT_EFFORT_LEDGER?.trim());
/** Any kit child, budgeted or not: standing mode is refused in all of them. */
const isKitChild = () => isChildProcess() || process.env.PI_KIT_INTERNAL_CHILD === "1";

export default function (pi: ExtensionAPI) {
  let policy: EffortPolicy | null = null;
  let loadError: string | null = null;
  try {
    policy = loadPolicy();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  let config: UserConfig = { tier: null, limits: {}, warnings: [] };
  let active: Resolved | null = null; // in force for the current turn
  let pending: Resolved | null = null; // chosen, applies at the next user turn
  let ledgerFile: string | null = process.env.PI_KIT_EFFORT_LEDGER?.trim() || null;
  let scopeSeq = 0;
  let sessionTotalBefore = 0;
  let sessionKey = `${process.pid}`;
  let usage: ledger.Usage = ledger.usageOf(null);
  let usageAt = 0;
  let warnedLoad = false;
  let recoveryOn = false;
  // Workflow runs opened by this process, each pinned to the workflow ledger it was opened in.
  const runFiles = new Map<string, string>();
  // Ultracode standing mode: session-only, recorded with appendEntry so a reload or resume restores it.
  let standing: StandingState = { ...STANDING_OFF };
  let wakeChain = 0;
  // Tools this extension took out of the active set, so it only ever puts back its own removals.
  const hidden = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => { try { l(); } catch { /* a listener must not break effort */ } });

  const recompute = (): Resolved | null => (policy ? resolveEffective(policy, process.env, config) : null);
  const label = (id: string) => (policy ? tierLabel(policy, id) : id);
  const limitsFor = (id: string): TierLimits => (policy ? tierLimits(policy, id, config.limits) : { maxConcurrent: 0, maxTotal: 0, maxScouts: 0 });

  function refreshUsage(force = false): void {
    if (!ledgerFile) return;
    const now = Date.now();
    if (!force && now - usageAt < USAGE_REFRESH_MS) return;
    usageAt = now;
    usage = ledger.usageOf(ledger.readLedger(ledgerFile));
  }

  function snapshot(): EffortSnapshot {
    refreshUsage();
    const a = active ?? recompute();
    const tier = a?.tier ?? "standard";
    const t = policy ? tierOf(policy, tier) : null;
    const pend = pending && pending.tier !== tier ? pending.tier : null;
    return {
      version: 1,
      tier,
      code: t?.code ?? "E3",
      label: t?.label ?? "Standard",
      source: a?.source ?? "default",
      pinned: a?.pinned ?? false,
      cap: a?.cap ?? null,
      limits: limitsFor(tier),
      usage,
      ledger: ledgerFile,
      pendingTier: pend,
      warnings: [...(loadError ? [loadError] : []), ...config.warnings, ...(a?.warnings ?? [])],
      healthy: policy !== null,
    };
  }

  /** Open a fresh delegation scope for a root session's user turn. Children reuse the parent's ledger. */
  function openScope(): void {
    if (isChildProcess() || !policy || !active) return;
    try {
      fs.mkdirSync(ledgerDir(), { recursive: true });
      if (ledgerFile) {
        const previous = ledger.readLedger(ledgerFile);
        if (previous) sessionTotalBefore = previous.sessionTotalBefore + previous.total;
      }
      const scope = `${sessionKey}-${++scopeSeq}`;
      ledgerFile = path.join(ledgerDir(), `${scope}.json`);
      ledger.createLedger(ledgerFile, {
        scope,
        tier: active.tier,
        limits: limitsFor(active.tier),
        recovery: { maxInvocations: policy.recovery.maxInvocations, maxConcurrent: policy.recovery.maxConcurrent, roles: policy.recovery.roles, active: false },
        sessionTotalBefore,
        sessionCeiling: policy.ceilings.maxTotal,
        mandatoryMax: MANDATORY_MAX,
        ceilings: policy.ceilings,
      });
      usage = ledger.usageOf(null);
      usageAt = Date.now();
    } catch (error) {
      ledgerFile = null; // delegation is refused ("no ledger"), never unbudgeted
      process.stderr.write(`[effort] could not open the delegation ledger: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  /**
   * Keep the model-launchable delegation tools out of the prompt while the tier allows no
   * delegation (E1): their descriptions cost about 850 tokens a turn and could only ever be
   * refused. They come back at the next user turn after a higher tier is chosen, and while the
   * trusted recovery extension has recovery active (recovery may start read-only scouts). Only
   * tools this extension removed are ever restored; a tool the profile or operator removed stays
   * removed. Skipped quietly on a pi without active-tool control.
   */
  function syncDelegationTools(): void {
    try {
      if (!active || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
      const noDelegation = limitsFor(active.tier).maxTotal === 0 && !recoveryOn;
      const current = pi.getActiveTools();
      let next = current;
      if (noDelegation) {
        const remove = DELEGATION_TOOLS.filter((t) => current.includes(t));
        remove.forEach((t) => hidden.add(t));
        if (remove.length) next = current.filter((t) => !remove.includes(t));
      } else if (hidden.size) {
        const restore = [...hidden].filter((t) => !current.includes(t));
        next = [...current, ...restore];
        hidden.clear();
      }
      if (next !== current) pi.setActiveTools(next);
    } catch {
      /* tool activation is an optimisation, never a reason to fail a turn */
    }
  }

  function pruneLedgers(): void {
    try {
      const dir = ledgerDir();
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (Date.now() - fs.statSync(file).mtimeMs > LEDGER_KEEP_MS) fs.rmSync(file, { force: true });
      }
    } catch {
      /* nothing to prune */
    }
  }

  /** This session's workflow ledger, created on first use (only when no file exists) and reused (also across a reload). */
  function workflowLedger(): string {
    if (!policy || !active) throw new Error("the effort policy is unavailable");
    const file = path.join(ledgerDir(), `${sessionKey}-workflows.json`);
    const wf = workflowLimits(policy);
    const lowest = policy.tiers[0];
    if (!lowest) throw new Error("effort policy has no tiers");
    ledger.createLedgerIfAbsent(file, {
      scope: `${sessionKey}-workflows`,
      // Agents of a run start at the lowest tier: the snapshot tier and limits bound what they may delegate.
      tier: lowest.id,
      limits: limitsFor(lowest.id),
      recovery: { maxInvocations: 0, maxConcurrent: 0, roles: [], active: false },
      sessionTotalBefore: 0,
      sessionCeiling: policy.ceilings.maxTotal,
      mandatoryMax: MANDATORY_MAX,
      ceilings: policy.ceilings,
      workflow: { concurrent: wf.workflowConcurrent, totalPerRun: wf.workflowTotalPerRun, sessionTotal: wf.workflowSessionTotal },
    });
    // An existing file is never replaced: an unreadable one, or one without a workflow section, refuses.
    if (!ledger.readLedger(file)?.workflow) throw new Error("the workflow ledger exists but is unreadable or not a workflow ledger");
    return file;
  }

  function reserveWorkflowSlot(input: ReserveInput): Reservation {
    if (!policy || !active) return { ok: false, code: "no-policy", reason: `the effort policy could not be loaded (${loadError ?? "unknown"}), so workflow agents cannot be budgeted.` };
    const file = input.runId ? runFiles.get(input.runId) : undefined;
    if (!file) return { ok: false, code: "run-scope", reason: "no workflow run scope is open for this run id in this session" };
    const lowest = policy.tiers[0];
    if (!lowest) return { ok: false, code: "no-policy", reason: "the effort policy has no tiers" };
    const result = ledger.reserve(file, { kind: "workflow", role: input.role, runId: input.runId, runToken: input.runToken, requesterTier: active.tier, requesterLimits: limitsFor(active.tier), requesterLabel: label(active.tier) });
    if (!result.ok) return result;
    const id = result.id;
    const childTier = lowest.id;
    return {
      ok: true,
      id,
      childTier,
      env: { PI_KIT_EFFORT: childTier, PI_KIT_EFFORT_CAP: childTier, PI_KIT_EFFORT_LEDGER: file },
      attach: (pid) => ledger.attach(file, id, pid),
      settle: (outcome) => ledger.settle(file, id, outcome),
    };
  }

  const topTier = (): string | null => policy?.tiers[policy.tiers.length - 1]?.id ?? null;

  /** Whether the workflow tool is in the active tool set (the standing block is shown only then). */
  function workflowToolActive(): boolean {
    try {
      return pi.getActiveTools().includes(WORKFLOW_TOOL);
    } catch {
      return false;
    }
  }

  function setStanding(next: StandingState): void {
    standing = { ...next, preauthorised: next.on && next.preauthorised };
    if (!standing.on) wakeChain = 0;
    try {
      pi.appendEntry(STANDING_ENTRY_TYPE, standingData(standing));
    } catch {
      /* a pi without session entries keeps the state for this process only */
    }
    notify();
  }

  const registry: EffortRegistry = {
    version: 1,
    snapshot,
    standing: () => ({ ...standing, wakeChain }),
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setRecoveryActive(activeNow) {
      recoveryOn = activeNow;
      if (ledgerFile) ledger.setRecoveryActive(ledgerFile, activeNow);
      syncDelegationTools();
    },
    recoveryEligible(role: string, readOnly?: boolean): boolean {
      return Boolean(policy && recoveryOn && readOnly !== false && policy.recovery.roles.includes(role));
    },
    openRunScope(runId: string): RunScope {
      if (isChildProcess()) return { ok: false, code: "child", reason: "workflow runs start only in the root session, not in a child" };
      if (!policy || !active) return { ok: false, code: "no-policy", reason: `the effort policy could not be loaded (${loadError ?? "unknown"}), so a workflow run cannot be budgeted.` };
      if (runFiles.has(runId)) return { ok: false, code: "run-scope", reason: `workflow run "${runId}" already has a scope; a run id is opened once` };
      let file: string;
      try {
        fs.mkdirSync(ledgerDir(), { recursive: true });
        file = workflowLedger();
      } catch (error) {
        return { ok: false, code: "no-ledger", reason: `the workflow ledger could not be created or read (${error instanceof Error ? error.message : String(error)})` };
      }
      const opened = ledger.openRun(file, runId);
      if (!opened.ok) return opened;
      runFiles.set(runId, file);
      return { ok: true, runId, runToken: opened.runToken, ledger: file };
    },
    async reserveWorkflow(input, options = {}) {
      const pollMs = Math.max(10, options.pollMs ?? 250);
      for (;;) {
        if (options.signal?.aborted) throw new WorkflowLedgerError("aborted", "the wait for a workflow agent slot was aborted");
        const r = reserveWorkflowSlot({ kind: "workflow", ...input });
        if (r.ok) return r;
        if (r.code !== "concurrency") throw new WorkflowLedgerError(r.code, r.reason);
        await delay(pollMs, options.signal);
      }
    },
    reserve(input: ReserveInput): Reservation {
      if (input.kind === "workflow") return reserveWorkflowSlot(input);
      if (!policy || !active) {
        // Mandatory verification is not budgeted work, so an unhealthy policy must not disable it.
        if (input.kind === "mandatory") return unbudgeted(policy?.default ?? "standard");
        return { ok: false, code: "no-policy", reason: `the effort policy could not be loaded (${loadError ?? "unknown"}), so delegation cannot be budgeted. Fix it or work directly.` };
      }
      const file = ledgerFile;
      if (!file) {
        if (input.kind === "mandatory") return unbudgeted(active.tier);
        return { ok: false, code: "no-ledger", reason: "the delegation ledger for this request is unavailable, so delegation cannot be budgeted. Work directly." };
      }
      const childTier = clampTier(policy, input.requestedTier ?? active.tier, active.tier);
      const result = ledger.reserve(file, {
        kind: input.kind,
        role: input.role,
        scout: input.scout,
        readOnly: input.readOnly,
        requesterTier: active.tier,
        requesterLimits: limitsFor(active.tier),
        requesterLabel: label(active.tier),
      });
      if (!result.ok) {
        if (input.kind === "mandatory" && result.code === "no-ledger") return unbudgeted(childTier);
        refreshUsage(true);
        notify();
        return result;
      }
      const id = result.id;
      refreshUsage(true);
      notify();
      return {
        ok: true,
        id,
        childTier,
        env: { PI_KIT_EFFORT: childTier, PI_KIT_EFFORT_CAP: childTier, PI_KIT_EFFORT_LEDGER: file },
        attach: (pid) => ledger.attach(file, id, pid),
        settle: (outcome) => {
          ledger.settle(file, id, outcome);
          refreshUsage(true);
          notify();
        },
      };
    },
  };
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = registry;
  registerProtection("effort");

  pi.on("session_start", async (event, ctx) => {
    (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = registry;
    if (!policy) {
      if (!warnedLoad) {
        warnedLoad = true;
        say(ctx, `effort policy could not be loaded (${loadError}); delegation is disabled until it is fixed.`, "warning");
      }
      return;
    }
    config = readConfig(policy);
    active = pending = recompute();
    try {
      const id = (ctx.sessionManager as { getSessionId?: () => unknown } | undefined)?.getSessionId?.();
      if (typeof id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(id)) sessionKey = id;
    } catch {
      /* keep the pid-based key */
    }
    if (!isChildProcess()) pruneLedgers();
    openScope();
    const reason = event?.reason;
    restoreStanding(ctx, reason);
    const warnings = [...config.warnings, ...(active?.warnings ?? [])];
    if (warnings.length && reason !== "reload") say(ctx, warnings.join("\n"), "warning");
    notify();
  });

  pi.on("session_shutdown", async () => {
    listeners.clear();
    recoveryOn = false;
    if ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] === registry) Reflect.deleteProperty(globalThis, REGISTRY_KEY);
  });

  // The user-turn boundary: a tier chosen with /effort takes effect here, the delegation scope is
  // renewed for the new request, and exactly one effort block replaces any earlier one.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!policy) return undefined;
    // A workflow's completion message that starts a turn while idle is a wake; your message ends the chain.
    if (event.messageType === "custom" && event.message.customType === WORKFLOW_RESULT_TYPE) wakeChain++;
    else if (event.messageType === "user") wakeChain = 0;
    if (standing.on && wakeChain > WAKE_CHAIN_CAP && !(await continueWakeChain(ctx))) return undefined;
    if (pending && (pending.tier !== active?.tier || pending.source !== active.source)) {
      active = pending;
      notify();
    } else active ??= recompute();
    if (!active) return undefined;
    recoveryOn = false; // the recovery budget is per request: it closes with the previous one
    openScope();
    syncDelegationTools();
    notify();
    let body = renderPrompt(policy, active.tier);
    const standingShown = standing.on && workflowToolActive();
    if (standingShown) {
      try {
        body = `${body}\n\n${renderStanding(standing.size, standing.budget)}`;
      } catch (error) {
        process.stderr.write(`[effort] could not read the standing prompt: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (!standingShown) return { systemPrompt: withEffortBlock(event.systemPrompt ?? "", body) };
    const reminder = `Reminder: ultracode standing mode is on (size guideline ${String(standing.size)} agents, budget ${standing.budget === null ? "none" : `${String(standing.budget)} output tokens`}); run substantial work as a workflow script, and do small tasks directly.`;
    return { systemPrompt: withEffortBlock(event.systemPrompt ?? "", body), message: { customType: STANDING_REMINDER_TYPE, content: reminder, display: false } };
  });

  /**
   * The wake-chain cap: more than WAKE_CHAIN_CAP completion turns in a row ask whether the agent may
   * go on. No (the default), Escape or no screen stops this turn; the result stays in the
   * conversation for your next message. Yes starts the count again from this turn.
   */
  async function continueWakeChain(ctx: ExtensionContext): Promise<boolean> {
    const no = "No, stop and wait for my next message";
    const yes = `Yes, let the agent continue (asks again after ${String(WAKE_CHAIN_CAP)} more)`;
    let choice: string | undefined;
    if (ctx.hasUI) {
      try {
        choice = await ctx.ui.select(`A workflow result has started ${String(wakeChain)} turns in a row without a message from you. Let the agent continue?`, [no, yes]);
      } catch {
        choice = undefined;
      }
    }
    if (choice === yes) {
      wakeChain = 1;
      return true;
    }
    try {
      ctx.abort();
    } catch {
      /* nothing to stop */
    }
    say(ctx, `effort: stopped after ${String(wakeChain)} workflow completion turns in a row. The result is in the conversation; send a message to continue.`, "warning");
    return false;
  }

  /** Bring standing mode back from the session's entries: only in a root session with a screen, at E5. */
  function restoreStanding(ctx: ExtensionContext, reason: string | undefined): void {
    let entries: unknown[] = [];
    try {
      const manager: unknown = ctx.sessionManager;
      const getBranch: unknown = typeof manager === "object" && manager !== null ? Reflect.get(manager, "getBranch") : undefined;
      const list: unknown = typeof getBranch === "function" ? Reflect.apply(getBranch, manager, []) : [];
      if (Array.isArray(list)) entries = list;
    } catch {
      /* no entries to restore from */
    }
    const saved = lastStandingEntry(entries);
    standing = { ...STANDING_OFF };
    wakeChain = 0;
    if (!saved?.on) return;
    // Not here: the entry is left as it is, so the session keeps it for a later resume on a screen.
    if (isKitChild() || !ctx.hasUI || active?.tier !== topTier()) return;
    // The pre-authorisation is never restored: session files are not firewall-protected, so a
    // restored entry brings back the size and budget only; a fresh Yes re-authorises.
    standing = { ...saved, preauthorised: false };
    if (reason !== "reload") say(ctx, `Ultracode standing mode restored for this session; workflow runs are asked per call${saved.preauthorised ? " (run /effort ultracode again to pre-authorise them)" : ""}. /effort ultracode off turns it off.`);
  }

  function statusText(): string {
    const s = snapshot();
    const lines = [`Effort: ${s.code} ${s.label} (${s.source === "default" ? "default" : s.source === "user" ? "saved default" : s.source === "env" ? "pinned by PI_KIT_EFFORT" : "capped by the parent"})${s.pinned && s.source !== "env" ? "" : ""}`];
    if (s.pendingTier) lines.push(`  next message: ${label(s.pendingTier)}`);
    lines.push(`  limits: ${s.limits.maxConcurrent} concurrent, ${s.limits.maxTotal} total, ${s.limits.maxScouts} scout${s.limits.maxScouts === 1 ? "" : "s"} (children per request, counted at every depth)`);
    if (s.ledger) lines.push(`  this request: ${s.usage.live} running, ${s.usage.total}/${s.limits.maxTotal} used, ${s.usage.scouts}/${s.limits.maxScouts} scouts`);
    if (s.pinned) lines.push("  pinned: /effort saves a default for later sessions but does not change this one");
    lines.push(standingLine());
    for (const w of s.warnings) lines.push(`  warning: ${w}`);
    lines.push("Effort sets how deep and broad the work is and how much it delegates. It does not change the model, its thinking level, the profile or any permission.");
    return lines.join("\n");
  }

  function helpText(): string {
    if (!policy) return "Effort policy unavailable.";
    const rows = policy.tiers.map((t) => {
      const l = limitsFor(t.id);
      return `  ${t.code} ${t.label.padEnd(10)} ${String(l.maxConcurrent).padStart(2)} concurrent  ${String(l.maxTotal).padStart(2)} total  ${l.maxScouts} scout${l.maxScouts === 1 ? " " : "s"}   /effort ${t.id}`;
    });
    return [`Effort tiers (default ${label(policy.default)}):`, ...rows, "", "  /effort <name|E1..E5|1..5>   set and save the default (applies from your next message)", "  /effort status               show the tier, limits and this request's use", "  /effort reset                forget the saved default", "  /effort memento [on|off]     Memento mode opt-in for a model (off by default)", "  /effort ultracode [--size N] [--budget N|none]   E5 plus standing mode (also /effort uc, /effort e5 --standing)", "  /effort ultracode off        back to opt-in workflows; revokes the pre-authorisation"].join("\n");
  }

  function choose(id: string, ctx: ExtensionCommandContext): void {
    if (!policy) return;
    try {
      saveDefault(id);
    } catch (error) {
      say(ctx, `effort: could not save ${label(id)} (${error instanceof Error ? error.message : String(error)}); it applies to this session only.`, "warning");
    }
    config = { ...config, tier: id };
    pending = recompute();
    notify();
    if (standing.on && id !== topTier()) {
      setStanding({ ...standing, on: false, preauthorised: false });
      say(ctx, "Ultracode standing mode is off (it needs E5); workflow runs are asked per call again.");
    }
    const s = snapshot();
    const applies = s.pinned ? "Saved as your default, but this session is pinned and keeps its tier." : active && active.tier === pending?.tier ? "Already in force." : "Applies from your next message.";
    say(ctx, `Effort set to ${label(id)}. ${applies}`, "info");
  }

  function standingLine(): string {
    if (!standing.on) return "  ultracode: off (a workflow runs only when you ask for one, and each call is asked)";
    const budget = standing.budget === null ? "no budget" : `budget ${String(standing.budget)} output tokens a run`;
    const auth = standing.preauthorised ? "workflow runs pre-authorised for this session" : "each workflow call still asked";
    const shown = workflowToolActive() ? "" : "; the workflow tool is not available in this session, so the standing block is not shown";
    return `  ultracode: on, size guideline ${String(standing.size)} agents, ${budget}, ${auth}${shown}`;
  }

  /**
   * /effort ultracode | uc | e5 --standing: E5 plus standing mode. Operator-only: refused in a child
   * and without a screen. One No-first select decides whether workflow runs are pre-authorised for
   * this session. `off` returns to opt-in and revokes the pre-authorisation; live runs continue.
   */
  async function standingCommand(words: string[], ctx: ExtensionCommandContext): Promise<void> {
    if (!policy) return;
    const parsed = parseStandingArgs(words);
    if (!parsed.ok) {
      say(ctx, `effort: ${parsed.error}. Use /effort ultracode [--size N] [--budget N|none], or /effort ultracode off. Nothing was changed.`, "error");
      return;
    }
    if (parsed.action === "status") {
      say(ctx, standingLine().trim());
      return;
    }
    if (parsed.action === "off") {
      if (!standing.on) {
        say(ctx, "Ultracode standing mode is already off.");
        return;
      }
      setStanding({ ...standing, on: false, preauthorised: false });
      say(ctx, "Ultracode standing mode is off: a workflow runs only when you ask for one, and each call is asked again. Runs already going continue.");
      return;
    }
    if (isKitChild()) {
      say(ctx, "effort: ultracode can only be switched on in the root session, not in a child. Nothing was changed.", "error");
      return;
    }
    if (!ctx.hasUI) {
      say(ctx, "effort: switching ultracode on needs a screen to confirm on. Nothing was changed.", "error");
      return;
    }
    const top = topTier();
    if (!top) return;
    const current = pending ?? active;
    if (current?.pinned && current.tier !== top) {
      say(ctx, `effort: this session is pinned at ${label(current.tier)}, and ultracode needs ${label(top)}. Nothing was changed.`, "error");
      return;
    }
    const size = parsed.size ?? (standing.on ? standing.size : DEFAULT_SIZE);
    const budget = parsed.budget === undefined ? (standing.on ? standing.budget : null) : parsed.budget;
    const no = "No, keep asking per workflow";
    const yes = "Yes, allow workflow runs this session";
    // No-first: pi's confirm defaults to Yes, so this is a select whose first (default) answer is No.
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(`Ultracode: ${label(top)} with standing mode (size guideline ${String(size)} agents, ${budget === null ? "no budget" : `budget ${String(budget)} output tokens a run`}). Allow the agent to start workflow runs without asking each time, for this session?`, [no, yes]);
    } catch {
      choice = undefined;
    }
    if (choice === undefined) {
      say(ctx, "Ultracode was not switched on. Nothing was changed.");
      return;
    }
    if (pending?.tier !== top) choose(top, ctx);
    setStanding({ on: true, preauthorised: choice === yes, size, budget });
    say(ctx, `Ultracode standing mode is on${choice === yes ? ": workflow runs are pre-authorised for this session" : ": each workflow call is still asked"}. /effort ultracode off returns to opt-in.${workflowToolActive() ? "" : " The workflow tool is not available in this session, so this has no effect until it is."}`);
  }

  /** The current session model's opt-in key, or null. */
  const currentModel = (ctx: ExtensionCommandContext): string | null => modelKey(ctx.model?.provider, ctx.model?.id);

  function mementoStatus(ctx: ExtensionCommandContext): string {
    if (!policy) return "Effort policy unavailable.";
    const s = snapshot();
    const optIn = readOptIn();
    const profile = installedProfile(ctx.cwd ?? process.cwd());
    const model = currentModel(ctx);
    const tierMax = mementoGenerations(policy, s.tier);
    const allowance = mementoAllowance({ tierMax, profile, model, optIn });
    const lines = [
      `Memento mode (generations): ${allowance.maxGenerations} for the current model at ${label(s.tier)} (${allowance.reason}).`,
      `  tiers: ${policy.tiers.map((t) => `${t.code} ${mementoGenerations(policy, t.id)}`).join(", ")}`,
      `  profile: ${profile ?? "unknown"} (allowed in ${MEMENTO_PROFILES.join(" and ")})`,
      `  opted-in models (${optInPath()}): ${optIn.models.size ? [...optIn.models].map(([k, v]) => (v.maxGenerations === null ? k : `${k} (max ${v.maxGenerations})`)).join(", ") : "none"}`,
      ...optIn.warnings.map((w) => `  warning: ${w}`),
      "Off by default. `/effort memento on [provider/model] [--max N]` opts a model in (you confirm it), `/effort memento off [provider/model]` opts it out. pi-autonomy reads the same allowance: a run whose contract enables generations uses at most this many for its worker model at its tier, and one generation when it is 0.",
    ];
    return lines.join("\n");
  }

  async function mementoCommand(words: string[], ctx: ExtensionCommandContext): Promise<void> {
    if (!policy) return;
    const sub = (words.shift() ?? "status").toLowerCase();
    if (sub === "status") {
      say(ctx, mementoStatus(ctx));
      return;
    }
    if (sub !== "on" && sub !== "off") {
      say(ctx, `effort: unknown memento command "${sub}". Use /effort memento [status|on|off] [provider/model] [--max N]. Nothing was changed.`, "error");
      return;
    }
    let max: number | null = null;
    const maxAt = words.indexOf("--max");
    if (maxAt >= 0) {
      const value = words[maxAt + 1] ?? "";
      const ceiling = policy.memento.maxGenerationsCeiling;
      if (sub === "off" || !/^\d{1,2}$/.test(value) || Number(value) > ceiling) {
        say(ctx, sub === "off" ? "effort: --max only goes with /effort memento on. Nothing was changed." : `effort: --max needs a whole number from 0 to ${ceiling}. Nothing was changed.`, "error");
        return;
      }
      max = Number(value);
      words.splice(maxAt, 2);
    }
    const named = words[0];
    if (words.length > 1 || (named !== undefined && !isModelKey(named))) {
      say(ctx, `effort: "${words.join(" ")}" is not a <provider>/<model id>. Nothing was changed.`, "error");
      return;
    }
    const model = named ?? currentModel(ctx);
    if (!model) {
      say(ctx, "effort: no model is selected; name one as <provider>/<model id>. Nothing was changed.", "error");
      return;
    }
    if (sub === "off") {
      try {
        writeOptIn(model, null);
      } catch (error) {
        say(ctx, `effort: could not update ${optInPath()} (${error instanceof Error ? error.message : String(error)}).`, "error");
        return;
      }
      say(ctx, `Memento mode is off for ${model}.`);
      return;
    }
    // Opting in widens what a task may do, so only the operator, on a screen, in an allowed profile, may do it.
    if (isChildProcess()) {
      say(ctx, "effort: Memento mode can only be switched on in the root session, not in a child. Nothing was changed.", "error");
      return;
    }
    if (!ctx.hasUI) {
      say(ctx, "effort: switching Memento mode on needs a screen to confirm on. Nothing was changed.", "error");
      return;
    }
    const profile = installedProfile(ctx.cwd ?? process.cwd());
    if (!profile || !MEMENTO_PROFILES.includes(profile)) {
      say(ctx, `effort: Memento mode is only available in the ${MEMENTO_PROFILES.join(" and ")} profiles (installed: ${profile ?? "unknown"}). Nothing was changed.`, "error");
      return;
    }
    const tiers = policy.tiers.map((t) => `${t.code} ${max === null ? mementoGenerations(policy, t.id) : Math.min(max, mementoGenerations(policy, t.id))}`).join(", ");
    const no = "No, keep Memento mode off for this model";
    const yes = `Yes, allow Memento mode for ${model}`;
    // No-first: pi's confirm defaults to Yes, so this is a select whose first (default) answer is No.
    const choice = await ctx.ui.select(`Allow Memento mode for ${model}? A long task may then be worked in generations, each a fresh agent continuing from the last one's notebook (${tiers}).`, [no, yes]);
    if (choice !== yes) {
      say(ctx, `Memento mode stays off for ${model}. Nothing was changed.`);
      return;
    }
    try {
      writeOptIn(model, { maxGenerations: max });
    } catch (error) {
      say(ctx, `effort: could not update ${optInPath()} (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`, "error");
      return;
    }
    say(ctx, `Memento mode allowed for ${model}${max === null ? "" : ` (at most ${max} generations)`}. Saved in ${optInPath()}.`);
  }

  pi.registerCommand("effort", {
    description: "Choose how deep and broad the agent works and how much it delegates: `/effort` (picker), `/effort <minimal|focused|standard|thorough|exhaustive | E1..E5>`, `/effort status`, `/effort reset`, `/effort memento [status|on|off] [provider/model]` (per-model Memento opt-in, off by default), `/effort ultracode [--size N] [--budget N|none] | off` (alias uc, or e5 --standing: E5 plus standing workflow mode). Independent of thinking level, profile and permissions.",
    getArgumentCompletions: (prefix: string) => {
      const options = policy ? [...policy.tiers.map((t) => t.id), ...policy.tiers.map((t) => t.code), "status", "reset", "memento", "ultracode", "uc", "help"] : ["status", "help"];
      return options.filter((v) => v.toLowerCase().startsWith(prefix.trim().toLowerCase())).map((v) => ({ value: v, label: v }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim();
      if (!policy) {
        say(ctx, `effort: the policy could not be loaded (${loadError}).`, "error");
        return;
      }
      const word = arg.toLowerCase();
      const words = arg.split(/\s+/).filter(Boolean);
      if (words[0]?.toLowerCase() === "memento") {
        await mementoCommand(words.slice(1), ctx);
        return;
      }
      const head = words[0]?.toLowerCase() ?? "";
      if (head === "ultracode" || head === "uc") {
        await standingCommand(words.slice(1), ctx);
        return;
      }
      const standingAt = words.findIndex((w) => w.toLowerCase() === "--standing");
      if (standingAt >= 0) {
        const named = normalizeTier(policy, words.find((_w, i) => i !== standingAt) ?? "");
        if (standingAt === 0 || named !== topTier()) {
          say(ctx, `effort: --standing goes only with ${label(topTier() ?? "")}: /effort e5 --standing (or /effort ultracode). Nothing was changed.`, "error");
          return;
        }
        await standingCommand(words.filter((_w, i) => i !== 0 && i !== standingAt), ctx);
        return;
      }
      if (word === "status") {
        say(ctx, statusText());
        return;
      }
      if (word === "help" || word === "?") {
        say(ctx, helpText());
        return;
      }
      if (word === "reset") {
        try {
          saveDefault(null);
        } catch (error) {
          say(ctx, `effort: could not update ${configPath()} (${error instanceof Error ? error.message : String(error)}).`, "error");
          return;
        }
        config = { ...config, tier: null };
        pending = recompute();
        notify();
        say(ctx, `Saved default cleared; new sessions use ${label(policy.default)}.`);
        if (standing.on && pending?.tier !== topTier()) {
          setStanding({ ...standing, on: false, preauthorised: false });
          say(ctx, "Ultracode standing mode is off (it needs E5); workflow runs are asked per call again.");
        }
        return;
      }
      if (!arg) {
        if (!ctx.hasUI) {
          say(ctx, `${statusText()}\n\n${helpText()}`);
          return;
        }
        const s = snapshot();
        const options = policy.tiers.map((t) => `${t.code} ${t.label}${t.id === s.tier ? "  (current)" : ""} — ${limitsFor(t.id).maxTotal === 0 ? "no delegation" : `up to ${limitsFor(t.id).maxTotal} children`}`);
        const choice = await ctx.ui.select("Effort — depth and breadth of work (not thinking, profile or permissions)", options);
        if (choice === undefined) return;
        const picked = policy.tiers[options.indexOf(choice)];
        if (picked) choose(picked.id, ctx);
        return;
      }
      const tier = normalizeTier(policy, arg);
      if (!tier) {
        say(ctx, `effort: "${arg}" is not an effort level. Use ${policy.tiers.map((t) => `${t.id} (${t.code})`).join(", ")}. Nothing was changed.`, "error");
        return;
      }
      choose(tier, ctx);
    },
  });
}
