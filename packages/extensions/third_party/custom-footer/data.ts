/**
 * Status bar data: pricing, incremental session totals, cost provenance, the git branch and
 * install profile (read cheaply, never through a subprocess), and the read-only registries other
 * extensions publish on globalThis (effort, unattended state, compaction, child counts).
 *
 * Nothing here runs per render: callers refresh at events and the renderer reads the cache.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- numbers ----------------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `String(value)` for a value of any type (registry fields are whatever the publisher stored). */
const toText = (value: unknown): string => String(value);

export function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

// --- pricing and cost provenance --------------------------------------------------------------

export type Pricing = {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  source: string;
};

export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number };

export const DEFAULT_PRICING: Pricing = { source: "unconfigured (cost unknown)" };

function readPricingFile(filePath: string): Partial<Pricing> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  // A file that is not an object is unreadable config: the caller keeps the prior pricing.
  if (!isRecord(parsed)) throw new Error(`${filePath} is not a JSON object`);
  const raw = parsed;
  const values = {
    inputPerMTok: numberFrom(raw.inputPerMTok ?? raw.input_per_mtok ?? raw.input),
    outputPerMTok: numberFrom(raw.outputPerMTok ?? raw.output_per_mtok ?? raw.output),
    cacheReadPerMTok: numberFrom(raw.cacheReadPerMTok ?? raw.cache_read_per_mtok ?? raw.cacheRead),
    cacheWritePerMTok: numberFrom(raw.cacheWritePerMTok ?? raw.cache_write_per_mtok ?? raw.cacheWrite),
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function pricingPaths(cwd: string): string[] {
  return [path.join(cwd, ".pi-kit", "costs.json"), path.join(agentDir(), "pi-kit", "costs.json")];
}

export function loadPricing(cwd: string, previous: Pricing): { pricing: Pricing; warning?: string } {
  let pricing: Pricing = { ...DEFAULT_PRICING };
  try {
    for (const filePath of pricingPaths(cwd)) {
      const filePricing = readPricingFile(filePath);
      if (!filePricing) continue;
      pricing = { ...pricing, ...filePricing, source: filePath };
      break;
    }
  } catch (error) {
    return { pricing: previous, warning: `status bar kept its prior pricing because the cost config could not be read: ${(error as Error).message}` };
  }
  const envOverrides = {
    inputPerMTok: numberFrom(process.env.PI_KIT_COST_INPUT_PER_MTOK),
    outputPerMTok: numberFrom(process.env.PI_KIT_COST_OUTPUT_PER_MTOK),
    cacheReadPerMTok: numberFrom(process.env.PI_KIT_COST_CACHE_READ_PER_MTOK),
    cacheWritePerMTok: numberFrom(process.env.PI_KIT_COST_CACHE_WRITE_PER_MTOK),
  };
  const active = Object.entries(envOverrides).filter(([, value]) => value !== undefined);
  if (active.length > 0) pricing = { ...pricing, ...Object.fromEntries(active), source: `${pricing.source} + env override` };
  return { pricing };
}

/** Where a cost figure comes from. An unknown cost is unknown, never zero. */
export type Cost = { kind: "reported" | "estimated" | "unknown"; value?: number };

/**
 * `estimated`: computed from the user's configured per-million-token prices. `reported`: the sum of
 * the provider/model catalogue costs pi recorded on each message (only when that is above zero: a
 * zero there means the model has no price in pi's catalogue, not that the session was free).
 * `unknown`: neither is available.
 */
export function costOf(totals: UsageTotals, pricing: Pricing): Cost {
  const pairs: Array<[number, number | undefined]> = [
    [totals.input, pricing.inputPerMTok],
    [totals.output, pricing.outputPerMTok],
    [totals.cacheRead, pricing.cacheReadPerMTok],
    [totals.cacheWrite, pricing.cacheWritePerMTok],
  ];
  const configured = pairs.some(([, rate]) => rate !== undefined);
  const complete = pairs.every(([count, rate]) => count === 0 || rate !== undefined);
  if (configured && complete) return { kind: "estimated", value: pairs.reduce((sum, [count, rate]) => sum + (count * (rate ?? 0)) / 1_000_000, 0) };
  if (totals.cost > 0) return { kind: "reported", value: totals.cost };
  return { kind: "unknown" };
}

/** Kept for callers of the previous contract: a number, or undefined when unknown. */
export function estimateCost(totals: UsageTotals, pricing: Pricing): number | undefined {
  return costOf(totals, pricing).value;
}

// --- incremental session totals ---------------------------------------------------------------

function addEntry(totals: UsageTotals, entry: unknown): boolean {
  const msg = (entry as { type?: string; message?: { role?: string; usage?: Record<string, unknown> } })?.message;
  if ((entry as { type?: string })?.type !== "message" || msg?.role !== "assistant") return true;
  const u = msg.usage;
  if (!u) return false;
  totals.input += numberFrom(u.input) ?? 0;
  totals.output += numberFrom(u.output) ?? 0;
  totals.cacheRead += numberFrom(u.cacheRead) ?? 0;
  totals.cacheWrite += numberFrom(u.cacheWrite) ?? 0;
  totals.total += numberFrom(u.totalTokens) ?? ((numberFrom(u.input) ?? 0) + (numberFrom(u.output) ?? 0) + (numberFrom(u.cacheRead) ?? 0) + (numberFrom(u.cacheWrite) ?? 0));
  totals.cost += numberFrom((u.cost as { total?: unknown } | null | undefined)?.total) ?? 0;
  return true;
}

export const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });

export function sessionTotals(entries: unknown): { totals: UsageTotals; partial: boolean } {
  const totals = emptyTotals();
  let partial = false;
  if (!Array.isArray(entries)) return { totals, partial };
  for (const entry of entries) if (!addEntry(totals, entry)) partial = true;
  return { totals, partial };
}

/**
 * Session totals that only look at entries added since the last refresh. Session entries are
 * append-only within a branch, so a long session costs O(new entries) per event instead of
 * O(all entries); a shorter or re-rooted list (fork, tree switch, compaction rewrite) is detected
 * by length and last-id and recomputed once.
 */
export function createTotalsCache() {
  let count = 0;
  let lastId: unknown;
  let totals = emptyTotals();
  let partial = false;
  return {
    update(entries: unknown): { totals: UsageTotals; partial: boolean } {
      if (!Array.isArray(entries)) return { totals, partial };
      const anchor = count > 0 ? (entries[count - 1] as { id?: unknown } | undefined)?.id : undefined;
      if (entries.length < count || (count > 0 && anchor !== lastId)) {
        totals = emptyTotals();
        partial = false;
        count = 0;
      }
      for (let i = count; i < entries.length; i++) if (!addEntry(totals, entries[i])) partial = true;
      count = entries.length;
      lastId = (entries[count - 1] as { id?: unknown } | undefined)?.id;
      return { totals: { ...totals }, partial };
    },
    reset() {
      count = 0;
      lastId = undefined;
      totals = emptyTotals();
      partial = false;
    },
  };
}

// --- cheap environment reads (no subprocess, cached by the caller) ------------------------------

/** The current git branch (or short commit when detached) from .git/HEAD; undefined outside a repository. */
export function readBranch(cwd: string): string | undefined {
  try {
    let dir = path.resolve(cwd);
    for (let i = 0; i < 40; i++) {
      const dotGit = path.join(dir, ".git");
      // Ask the file system once instead of "does it exist" and then "what is it": a missing .git is the normal case.
      let dotGitStat: fs.Stats | undefined;
      try {
        dotGitStat = fs.statSync(dotGit);
      } catch {
        dotGitStat = undefined;
      }
      if (dotGitStat) {
        let gitDir = dotGit;
        if (dotGitStat.isFile()) {
          const pointer = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
          if (!pointer) return undefined;
          gitDir = path.resolve(dir, pointer);
        }
        const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
        return ref ?? (/^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : undefined);
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    /* not a repository, or unreadable */
  }
  return undefined;
}

/** The install profile recorded by the installer (project marker first, then the global one). */
export function readProfile(cwd: string): string | undefined {
  for (const file of [path.join(cwd, ".pi", ".pi-kit.json"), path.join(agentDir(), ".pi-kit.json")]) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const profile = isRecord(parsed) ? parsed.profile : undefined;
      if (typeof profile === "string" && profile) return profile;
    } catch {
      /* try the next marker */
    }
  }
  return undefined;
}

export type FirewallView = { mode?: string | undefined; policy?: string | undefined };

/** The firewall mode/policy the installer or /auto recorded, for the diagnostics line. */
export function readFirewall(): FirewallView | undefined {
  const file = process.env.PI_KIT_FIREWALL_CONFIG?.trim() || path.join(agentDir(), "pi-kit", "firewall.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const raw = isRecord(parsed) ? parsed : undefined;
    return { mode: typeof raw?.mode === "string" ? raw.mode : undefined, policy: typeof raw?.policy === "string" ? raw.policy : undefined };
  } catch {
    return undefined;
  }
}

// --- registries other extensions publish ------------------------------------------------------

// Each registry is read through the shape its publisher documents; anything the footer cannot
// rely on is `unknown` and checked where it is used.
const registry = (name: string): unknown => (globalThis as Record<symbol, unknown>)[Symbol.for(name)];

export type EffortView = {
  code: string;
  label: string;
  pinned: boolean;
  pendingCode?: string | undefined;
  usage?: { live: number; total: number; maxTotal: number; scouts: number; maxScouts: number } | undefined;
};

type EffortSnapshotLike = {
  code?: unknown;
  label?: unknown;
  pinned?: unknown;
  pendingTier?: unknown;
  ledger?: unknown;
  usage?: { live?: number; total?: number; scouts?: number } | null;
  limits?: { maxTotal?: number; maxScouts?: number } | null;
};

export function readEffort(): EffortView | undefined {
  const reg = registry("pi-kit.effort") as { snapshot(): EffortSnapshotLike | null | undefined } | undefined;
  if (!reg) return undefined;
  try {
    const s = reg.snapshot();
    if (!s || typeof s.code !== "string") return undefined;
    const pending = typeof s.pendingTier === "string" ? s.pendingTier : undefined;
    return {
      code: s.code,
      label: toText(s.label ?? ""),
      pinned: Boolean(s.pinned),
      pendingCode: pending ? `E${["minimal", "focused", "standard", "thorough", "exhaustive"].indexOf(pending) + 1}` : undefined,
      usage: s.ledger && s.usage ? { live: s.usage.live ?? 0, total: s.usage.total ?? 0, maxTotal: s.limits?.maxTotal ?? 0, scouts: s.usage.scouts ?? 0, maxScouts: s.limits?.maxScouts ?? 0 } : undefined,
    };
  } catch {
    return undefined;
  }
}

export type SecurityView = { requested: string; effective: string; warning: boolean };
function isSecurityRegistry(value: unknown): value is { snapshot: () => unknown } {
  return isRecord(value) && typeof value.snapshot === "function";
}
export function readSecurity(): SecurityView | undefined {
  const reg = registry("pi-kit.security");
  if (!isSecurityRegistry(reg)) return undefined;
  try {
    const s: unknown = reg.snapshot();
    if (!isRecord(s) || typeof s.requested !== "string" || typeof s.effective !== "string") return undefined;
    return { requested: s.requested, effective: s.effective, warning: Array.isArray(s.warnings) && s.warnings.length > 0 };
  } catch { return undefined; }
}

export type UnattendedView = { active: boolean; label: string; boundary?: string | undefined; autoApprove?: boolean | undefined; misconfigured?: boolean };

/**
 * Unattended state is what the firewall ENFORCES (its registry), never what the environment claims.
 * The variable set without an enforcing registry is shown as a misconfiguration, not as protection.
 */
export function readUnattended(env: NodeJS.ProcessEnv = process.env): UnattendedView | undefined {
  const reg = registry("pi-kit.unattended") as { active?: unknown; boundary?: string | null; autoApprove?: boolean; label?: unknown } | undefined;
  if (reg?.active === true) return { active: true, label: toText(reg.label ?? "unattended"), boundary: reg.boundary ?? undefined, autoApprove: reg.autoApprove };
  if (env.PI_KIT_UNATTENDED === "1") return { active: false, label: "unattended requested, not enforced", misconfigured: true };
  return undefined;
}

export type CompactionView = { enabled: boolean | null; reason?: string | undefined; thresholdTokens?: number | null | undefined };

export function readCompaction(): CompactionView | undefined {
  const reg = registry("pi-kit.compaction") as { enabled?: boolean | null; reason?: string | null; thresholdTokens?: number | null } | undefined;
  if (!reg || (reg.enabled !== true && reg.enabled !== false)) return undefined;
  return { enabled: reg.enabled, reason: reg.reason ?? undefined, thresholdTokens: reg.thresholdTokens ?? undefined };
}

export type AgentsView = { live: number; failed: number };

/** Live children and the failures since `failedBase` (the count when this request started). */
export function readAgents(failedBase = 0): AgentsView | undefined {
  const reg = registry("pi-kit.subagents") as { snapshot(): { live?: number; failures?: number } } | undefined;
  if (!reg) return undefined;
  try {
    const s = reg.snapshot();
    return { live: s.live ?? 0, failed: Math.max(0, (s.failures ?? 0) - failedBase) };
  } catch {
    return undefined;
  }
}

export function agentFailureCount(): number {
  const reg = registry("pi-kit.subagents") as { snapshot(): { failures?: number } } | undefined;
  try {
    return reg?.snapshot().failures ?? 0;
  } catch {
    return 0;
  }
}
