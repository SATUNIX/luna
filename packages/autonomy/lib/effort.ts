// Adapter for the kit's effort policy. The single source of truth is packages/core/lib/effort.ts
// (tiers, aliases, clamping); this module only loads it, so a checkout without it fails closed
// with a clear message instead of validating effort against a private copy that could drift.
//
// API used (all from core): normalizeTier(input) -> canonical id | null, clampTier(requested, cap),
// loadEffortPolicy(), tierLimits(id), tierLabel(id). Tests inject an object with the same shape.

// Type-only: erased at run time, so a checkout without core still loads this module (and fails closed below).
import type * as CoreEffort from "../../core/lib/effort.ts";
import type * as CoreMemento from "../../core/memento.ts";
import type { EffortPolicy as CoreEffortPolicy, EffortTier, TierLimits } from "../../core/lib/effort.ts";

export type { TierLimits };

/** The effort policy, as far as this package reads it: the default tier and the tiers by id (an injected policy needs no more). */
export type EffortPolicy = Pick<CoreEffortPolicy, "default"> & { tiers: Array<Pick<EffortTier, "id" | "level" | "code" | "label">> };

/** The part of core's effort module this package uses; an injected one (tests) has the same shape. */
export interface EffortApi {
  normalizeTier(input: unknown): string | null;
  clampTier(requested: string, cap: string): string;
  loadEffortPolicy(): EffortPolicy;
  tierLimits(id: string): TierLimits;
  tierLabel(id: string): string;
}

/** Core's effort module; null when it could not be loaded (coreEffortError says why). */
export let coreEffort: typeof CoreEffort | null = null;
export let coreEffortError: unknown = null;
try {
  coreEffort = await import("../../core/lib/effort.ts");
} catch (error) {
  coreEffortError = error;
}

/** The effort API to use: an injected one (tests), else core's; null when neither is available. */
export function effortApi(injected?: EffortApi | null): EffortApi | null {
  return injected ?? coreEffort;
}

export const EFFORT_UNAVAILABLE = "effort policy unavailable: packages/core/lib/effort.ts could not be loaded, so the effort tier cannot be validated";

// --- Memento allowance --------------------------------------------------------------------------
// The same per-model opt-in (<agent dir>/pi-kit/autonomy.json) and tier allowance `/effort memento`
// shows, through core (packages/core/memento.ts, which imports the effort extension's reader in
// place). Loaded like core's effort module: a checkout without it fails closed, to no generations.

export type TaskAllowance = CoreMemento.TaskAllowance;
export type TaskAllowanceInput = CoreMemento.TaskAllowanceInput;

/** Core's Memento module; null when it could not be loaded. */
export let coreMemento: typeof CoreMemento | null = null;
try {
  coreMemento = await import("../../core/memento.ts");
} catch {
  coreMemento = null;
}

/** The Memento allowance for a task; 0 (with the reason) when the reader could not be loaded or throws. */
export function taskMementoAllowance(input: TaskAllowanceInput): TaskAllowance {
  const none = (reason: string): TaskAllowance => ({ maxGenerations: 0, reason, model: null, profile: null, tierMax: 0, warnings: [] });
  if (!coreMemento) return none("the Memento opt-in reader (packages/core/memento.ts) could not be loaded");
  try {
    return coreMemento.taskMementoAllowance(input);
  } catch (error) {
    return none(`the Memento allowance could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
}
