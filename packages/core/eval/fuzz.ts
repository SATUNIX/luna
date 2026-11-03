/**
 * A small property-based fuzzing harness for the smoke suite (no dependency).
 *
 * A property is a generator of random inputs and a check that must hold for every one of them.
 * Each case gets its own pseudo-random generator, seeded from the run seed plus the case number,
 * so a failure names the one seed that reproduces it:
 *
 *   FUZZ_SEED=<seed> FUZZ_RUNS=1 npm run smoke:fuzz-<name>
 *
 * Defaults keep `check:all` fast and deterministic: a fixed seed and the run count the test asks
 * for. The weekly security workflow sets `FUZZ_SEED=random` and a larger `FUZZ_RUNS`, so each
 * scheduled run explores new inputs (docs/ci-security.md, "Property-based fuzzing").
 *
 * The variables are read when this module loads, before a test calls isolateKitEnv() (which
 * clears only PI_KIT_* names, so these survive it anyway).
 */
import { randomInt } from "node:crypto";

/** The fixed seed `check:all` uses, so a run in CI is reproducible. */
export const DEFAULT_SEED = 20261026;

/** A seeded generator of pseudo-random values (mulberry32): fast, and enough for test inputs. */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, n). */
  int(n: number): number;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** True with probability p (default one half). */
  chance(p?: number): boolean;
  /** A string of `length` characters drawn from `alphabet`. */
  string(alphabet: string, length: number): string;
}

export function rng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("rng.pick: empty list");
      const item = items[int(items.length)];
      if (item === undefined) throw new Error("rng.pick: index out of range");
      return item;
    },
    chance: (p = 0.5) => next() < p,
    string(alphabet: string, length: number): string {
      let out = "";
      for (let i = 0; i < length; i++) out += alphabet.charAt(int(alphabet.length));
      return out;
    },
  };
}

export interface FuzzSettings {
  seed: number;
  /** Runs per property; undefined means the test's own default. */
  runs: number | undefined;
}

/** Reads FUZZ_SEED (an integer, or "random") and FUZZ_RUNS (a positive integer). A malformed value is an error, not a silent default. */
export function fuzzSettings(env: NodeJS.ProcessEnv = process.env): FuzzSettings {
  const seedText = env.FUZZ_SEED;
  const runsText = env.FUZZ_RUNS;
  let seed = DEFAULT_SEED;
  if (seedText === "random") seed = randomInt(0, 2 ** 32 - 1);
  else if (seedText !== undefined && seedText !== "") {
    if (!/^\d{1,10}$/.test(seedText)) throw new Error(`FUZZ_SEED must be an integer or "random", got ${JSON.stringify(seedText)}`);
    seed = Number(seedText) >>> 0;
  }
  let runs: number | undefined;
  if (runsText !== undefined && runsText !== "") {
    if (!/^[1-9]\d{0,6}$/.test(runsText)) throw new Error(`FUZZ_RUNS must be a positive integer, got ${JSON.stringify(runsText)}`);
    runs = Number(runsText);
  }
  return { seed, runs };
}

const SETTINGS = fuzzSettings();

/** Thrown when a property fails: carries the case, so the report shows exactly what broke it. */
export class PropertyFailure extends Error {
  constructor(name: string, seed: number, input: unknown, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`property "${name}" failed for seed ${seed}\n  input: ${JSON.stringify(input)}\n  ${why}\n  reproduce: FUZZ_SEED=${seed} FUZZ_RUNS=1`, { cause });
    this.name = "PropertyFailure";
  }
}

/**
 * Checks `check` against `defaultRuns` generated inputs (FUZZ_RUNS overrides the count). `check`
 * throws (an assertion) when the property does not hold. Returns the number of cases run.
 */
export function property<T>(name: string, defaultRuns: number, generate: (r: Rng) => T, check: (input: T) => void): number {
  const runs = SETTINGS.runs ?? defaultRuns;
  for (let i = 0; i < runs; i++) {
    const seed = (SETTINGS.seed + i) >>> 0;
    const input = generate(rng(seed));
    try {
      check(input);
    } catch (error) {
      throw new PropertyFailure(name, seed, input, error);
    }
  }
  return runs;
}

/** Async form of property(), for checks that touch the file system or an extension. */
export async function propertyAsync<T>(name: string, defaultRuns: number, generate: (r: Rng) => T, check: (input: T) => Promise<void>): Promise<number> {
  const runs = SETTINGS.runs ?? defaultRuns;
  for (let i = 0; i < runs; i++) {
    const seed = (SETTINGS.seed + i) >>> 0;
    const input = generate(rng(seed));
    try {
      await check(input);
    } catch (error) {
      throw new PropertyFailure(name, seed, input, error);
    }
  }
  return runs;
}

/** The seed this process runs with (printed by each fuzz test, so a randomised run can be replayed). */
export function fuzzSeed(): number {
  return SETTINGS.seed;
}
