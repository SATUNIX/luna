// Small, dependency-free helpers shared by the run engine: atomic JSON files, canonical JSON
// (stable key order, so digests do not depend on how a file was written) and hashing.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseJson } from "../../core/lib/guard.ts";

/** A short unpredictable suffix for temp files, container names and default run ids (crypto, not Math.random: a name that is guessable can be pre-created). */
export const randomSuffix = (chars = 6): string => randomBytes(Math.ceil(chars / 2)).toString("hex").slice(0, chars);

/** Atomic JSON write (temp file + rename), so a crash never leaves half a state file. */
export function writeJsonAtomic(file: string, value: unknown, { mode }: { mode?: number } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomSuffix(6)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** The parsed JSON of `file`, or `fallback` when it is missing or unparseable. The content is unknown: the caller validates it. */
export function readJson(file: string, fallback: unknown = null): unknown {
  try { return parseJson(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** JSON with object keys sorted recursively; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return (v as unknown[]).map(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, walk(o[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export const sha256 = (data: string | NodeJS.ArrayBufferView): string => createHash("sha256").update(data).digest("hex");

export const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Deep merge for configuration: objects merge, arrays and scalars are replaced by `over`. Every key
 * becomes an own property, "__proto__" included (JSON.parse makes it one), so it stays visible to
 * unknown-key checks instead of silently replacing the result's prototype.
 */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const inner = Object.hasOwn(base, k) ? base[k] : undefined;
    Object.defineProperty(out, k, { value: isPlainObject(v) && isPlainObject(inner) ? deepMerge(inner, v) : v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** A deep copy of a JSON value (a state or contract record): what JSON.stringify drops, the copy lacks. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
