// Shared helpers for the tests/autonomy-*.mjs smoke tests.
//
// The effort policy lives in packages/core/lib/effort.ts. Tests use that module when it is
// present and otherwise a small local stub with the same API (canonical tier ids minimal,
// focused, standard, thorough, exhaustive; default standard; aliases E1..E5 and 1..5), so the
// autonomy suite does not depend on which branch of the core package it is checked out with.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coreEffort } from "../packages/autonomy/lib/effort.ts";

/** One tier of an effort policy, as `loadEffortPolicy()` returns it. */
export interface EffortTier {
  id: string;
  level: number;
  code: string;
  label: string;
  aliases?: string[];
}

/** An effort policy: its default tier and the tiers in ascending order. */
export interface EffortPolicy {
  default: string;
  tiers: EffortTier[];
}

/** The per-tier delegation limits. */
export interface TierLimits {
  maxConcurrent: number;
  maxTotal: number;
  maxScouts: number;
}

/** The effort API shape shared by packages/core/lib/effort.ts and the local stub. */
export interface EffortApi {
  /** Present (true) only on the local stub. */
  isStub?: boolean;
  loadEffortPolicy(): EffortPolicy;
  normalizeTier(input: unknown): string | null;
  clampTier(requested: unknown, cap: unknown): string;
  tierLimits(id: string): TierLimits;
  tierLabel(id: string): string;
}

const TIERS: string[] = ["minimal", "focused", "standard", "thorough", "exhaustive"];
const ALIASES: Partial<Record<string, string>> = { min: "minimal", std: "standard", default: "standard", max: "exhaustive" };
/** The stub tier at `index`; the callers only pass indices they derived from TIERS. */
const tierAt = (index: number): string => {
  const tier = TIERS[index];
  assert.ok(tier !== undefined, `stub effort: no tier at index ${index}`);
  return tier;
};

export const stubEffort: EffortApi & { isStub: true } = {
  isStub: true,
  loadEffortPolicy: (): EffortPolicy => ({ default: "standard", tiers: TIERS.map((id, i) => ({ id, level: i + 1, code: `E${i + 1}`, label: id })) }),
  normalizeTier(input: unknown): string | null {
    if (typeof input === "number") input = String(input);
    if (typeof input !== "string") return null;
    const key = input.trim().toLowerCase();
    if (TIERS.includes(key)) return key;
    const alias = ALIASES[key];
    if (alias) return alias;
    const m = key.match(/^e?([1-5])$/);
    return m ? tierAt(Number(m[1]) - 1) : null;
  },
  clampTier(requested: unknown, cap: unknown): string {
    const c = TIERS.indexOf(stubEffort.normalizeTier(cap) ?? "standard");
    const r = TIERS.indexOf(stubEffort.normalizeTier(requested) ?? tierAt(c));
    return tierAt(r > c ? c : r);
  },
  tierLimits: (id: string): TierLimits => ({ maxConcurrent: TIERS.indexOf(id), maxTotal: TIERS.indexOf(id) * 2, maxScouts: TIERS.indexOf(id) }),
  tierLabel: (id: string): string => `E${TIERS.indexOf(id) + 1} ${id}`,
};

/** The effort API the suite runs against: core's when it exists in this checkout, else the stub. */
// packages/autonomy/lib/effort.ts types `coreEffort` as core's effort module or `null` (null when its dynamic import
// failed); annotating the local as the shared EffortApi checks that core's module satisfies the API the stub mirrors.
const loadedCoreEffort: EffortApi | null = coreEffort;
export const testEffort: EffortApi = loadedCoreEffort ?? stubEffort;

/** Runs named checks in order and prints a summary line. */
export interface Checker {
  check: (name: string, fn: () => unknown) => Promise<void>;
  done: () => void;
}

let checks = 0;
export function makeChecker(label: string): Checker {
  return {
    async check(name: string, fn: () => unknown): Promise<void> {
      await fn();
      checks++;
      console.log(`  OK: ${name}`);
    },
    done(): void { console.log(`\n[${label}] all ${checks} checks passed${testEffort.isStub ? " (effort: local stub)" : ""}`); },
  };
}

export function tempDir(prefix = "autonomy-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const rm = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true });

/**
 * The bind-mount sources in a container's argument list that expose the operator's home: the directory itself, a parent of it, or one
 * of the places credentials live under it. A run directory that merely sits beneath the home directory is not exposure (on GitHub's
 * hosted runners the temp directory is `~/work/_temp`, so a substring test for the home path fails there for no reason).
 */
export function homeExposure(args: readonly string[], home: string = os.homedir()): string[] {
  const inside = (parent: string, child: string): boolean => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const secretDirs = [".ssh", ".pi", ".aws", ".gnupg", ".config", ".kube", ".docker"].map((d) => path.join(home, d));
  const sources = args.flatMap((a, i) => (a === "--mount" ? [(args[i + 1] ?? "").split(",").find((kv) => kv.startsWith("source="))?.slice(7)] : [])).filter((src): src is string => Boolean(src));
  const volumeFlags = args.filter((a) => a === "-v" || a === "--volume" || a.startsWith("--volume="));
  return [...volumeFlags, ...sources.filter((src) => inside(src, home) || secretDirs.some((d) => inside(d, src)))];
}

/**
 * A raw (unresolved) contract as a test writes it. Values are deliberately loose: tests override any field,
 * including with malformed values, to exercise the validator.
 */
export interface RawContract {
  [key: string]: unknown;
}

/** A minimal valid finite-task contract; tests override what they exercise. */
export function implementRaw(over: RawContract = {}): RawContract {
  return {
    schemaVersion: 1,
    run: "todo-api-1",
    template: "implement",
    objective: { title: "Todo API", spec: "Build a small todo API with tests.", backlog: [{ id: "T1", title: "Health endpoint", acceptance: ["unit"] }, { id: "T2", title: "Create todo" }] },
    inputs: { repository: null, references: {} },
    acceptance: { checks: [{ id: "unit", run: ["node", "--test"], timeoutMinutes: 5, required: true }], review: true },
    permissions: { unattended: { authorised: true, autoApprove: true } },
    ...over,
  };
}

export { assert };
