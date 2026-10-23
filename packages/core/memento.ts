/**
 * The Memento allowance for toolchain code (the autonomy runner): how many generations a task by a
 * model at an effort tier may use. docs/effort.md, "Memento mode".
 *
 * There is one opt-in reader: packages/extensions/src/effort/memento.ts, which `/effort memento`
 * uses. It is self-contained (node:* builtins only) because extensions may not import toolchain
 * code, so the toolchain imports it in place, the way packages/core/lib/effort.ts reads the
 * extension's effort.json in place. The file it reads, <agent dir>/pi-kit/autonomy.json, does not
 * move, so protected-paths keeps covering it (tests/protected-paths-smoke.ts).
 *
 * The tier's allowance comes from this package's effort policy loader (mementoGenerations), which
 * tests/effort-smoke.ts keeps in step with the extension's.
 */
import { MEMENTO_PROFILES, installedProfile, mementoAllowance, modelKey, optInPath, readOptIn } from "../extensions/src/effort/memento.ts";
import { type EffortPolicy, loadEffortPolicy, mementoGenerations } from "./lib/effort.ts";

export { MEMENTO_PROFILES, installedProfile, mementoAllowance, modelKey, optInPath, readOptIn };

/** A task's allowance, with what it was worked out from. */
export interface TaskAllowance {
  /** Generations the task may use (0: Memento mode is off for it). */
  maxGenerations: number;
  /** Why the number is what it is. */
  reason: string;
  /** The opt-in key, or null when the provider and model id cannot form one. */
  model: string | null;
  profile: string | null;
  /** The tier's own allowance, before the opt-in. */
  tierMax: number;
  /** Malformed opt-in entries that were ignored. */
  warnings: string[];
}

export interface TaskAllowanceInput {
  provider: string;
  model: string;
  tier: string;
  /** Where the installed profile is looked up (a project .pi/.pi-kit.json wins). */
  cwd: string;
  /** The opt-in file; <agent dir>/pi-kit/autonomy.json when absent. */
  file?: string | undefined;
  policy?: EffortPolicy | undefined;
}

/** The Memento allowance for a task: the same opt-in, profile rule and tier allowance `/effort memento` shows. */
export function taskMementoAllowance(input: TaskAllowanceInput): TaskAllowance {
  const model = modelKey(input.provider, input.model);
  const profile = installedProfile(input.cwd);
  const tierMax = mementoGenerations(input.tier, input.policy ?? loadEffortPolicy());
  const optIn = readOptIn(input.file ?? optInPath());
  const { maxGenerations, reason } = mementoAllowance({ tierMax, profile, model, optIn });
  return { maxGenerations, reason, model, profile, tierMax, warnings: optIn.warnings };
}
