/**
 * Runtime validation that also produces the static type.
 *
 * Values from outside the process (JSON files, environment variables, RPC lines, HTTP bodies, model
 * output) arrive as `unknown`. A Schema checks one and hands it back typed, so the runtime check and
 * the static type cannot drift apart: the type is inferred from the schema (`Infer<typeof S>`).
 *
 * Dependency-free on purpose: the installer runs from a bare clone and git delivery installs with
 * `--omit=dev`, so nothing here may import a package (internal/docs/adr/0001-typescript-runtime-and-npm-artefact.md).
 *
 * Objects are parsed into fresh values holding only the schema's keys; keys that could reach a
 * prototype (`__proto__`, `constructor`, `prototype`) are rejected wherever input chooses the keys.
 */

/** The first value that failed a schema, named by its path (`config.models[2].id`). */
export class ValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ValidationError";
    this.path = path;
  }
}

export interface Schema<T> {
  /** What the schema accepts, for error messages ("string", "array of string"). */
  readonly expected: string;
  /** The value typed as `T`, or a ValidationError naming the first offending path. */
  parse(value: unknown, path?: string): T;
}

/** A property that may be absent. In an `object()` shape it becomes an optional key. */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Readonly<Record<string, Schema<unknown>>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOf<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> }
>;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function make<T>(expected: string, check: (value: unknown, path: string) => T): Schema<T> {
  return { expected, parse: (value, path = "value") => check(value, path) };
}

function fail(path: string, expected: string, value: unknown): never {
  throw new ValidationError(path, `expected ${expected}, got ${describe(value)}`);
}

/** A plain (non-null, non-array) object, as JSON produces. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `JSON.parse`, typed honestly: the result is unknown until a schema says otherwise. */
export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** Parse JSON text and validate it in one step. Syntax errors surface as ValidationError too. */
export function parseJsonAs<T>(schema: Schema<T>, text: string, path = "value"): T {
  let value: unknown;
  try {
    value = parseJson(text);
  } catch (error) {
    throw new ValidationError(path, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return schema.parse(value, path);
}

/** Type-guard form of `schema.parse`. Only ValidationError means "no"; anything else is a bug and propagates. */
export function matches<T>(schema: Schema<T>, value: unknown): value is T {
  try {
    schema.parse(value);
    return true;
  } catch (error) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
}

export type SafeResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

/** `parse` without throwing, for callers that report rather than abort. */
export function safeParse<T>(schema: Schema<T>, value: unknown, path = "value"): SafeResult<T> {
  try {
    return { ok: true, value: schema.parse(value, path) };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error };
    throw error;
  }
}

export interface StringOptions {
  readonly pattern?: RegExp;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export function string(options: StringOptions = {}): Schema<string> {
  const { pattern, minLength, maxLength } = options;
  const expected = pattern ? `string matching ${String(pattern)}` : "string";
  return make(expected, (value, path) => {
    if (typeof value !== "string") return fail(path, expected, value);
    if (minLength !== undefined && value.length < minLength) throw new ValidationError(path, `expected at least ${minLength} characters`);
    if (maxLength !== undefined && value.length > maxLength) throw new ValidationError(path, `expected at most ${maxLength} characters`);
    // A fresh test each time: a /g or /y pattern's lastIndex must not leak between calls.
    if (pattern && !new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(value)) {
      throw new ValidationError(path, `expected ${expected}`);
    }
    return value;
  });
}

export interface NumberOptions {
  readonly integer?: boolean;
  readonly min?: number;
  readonly max?: number;
}

/** A finite number (NaN and the infinities are rejected). */
export function number(options: NumberOptions = {}): Schema<number> {
  const { integer = false, min, max } = options;
  const expected = integer ? "integer" : "number";
  return make(expected, (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fail(path, `finite ${expected}`, value);
    if (integer && !Number.isInteger(value)) throw new ValidationError(path, "expected an integer");
    if (min !== undefined && value < min) throw new ValidationError(path, `expected >= ${min}`);
    if (max !== undefined && value > max) throw new ValidationError(path, `expected <= ${max}`);
    return value;
  });
}

export function boolean(): Schema<boolean> {
  return make("boolean", (value, path) => (typeof value === "boolean" ? value : fail(path, "boolean", value)));
}

type Literal = string | number | boolean | null;

/** One of a closed set of values: `literal("allow", "ask", "deny")`. */
export function literal<const L extends readonly Literal[]>(...values: L): Schema<L[number]> {
  const expected = `one of ${values.map((v) => JSON.stringify(v)).join(", ")}`;
  return make(expected, (value, path) => {
    // undefined is never a literal, so "not found" and "found" cannot be confused.
    const found = values.find((candidate) => candidate === value);
    return found === undefined ? fail(path, expected, value) : found;
  });
}

/** Accept anything; for fields a caller validates itself later. */
export function unknownValue(): Schema<unknown> {
  return make("any value", (value) => value);
}

export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    optional: true,
    expected: `${inner.expected} (optional)`,
    parse: (value, path = "value") => (value === undefined ? undefined : inner.parse(value, path)),
  };
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return make(`${inner.expected} or null`, (value, path) => (value === null ? null : inner.parse(value, path)));
}

/** `inner`, falling back to `fallback` when the value is absent (undefined). */
export function withDefault<T>(inner: Schema<T>, fallback: T): Schema<T> {
  return make(inner.expected, (value, path) => (value === undefined ? fallback : inner.parse(value, path)));
}

export function array<T>(item: Schema<T>, options: { readonly maxItems?: number } = {}): Schema<T[]> {
  const expected = `array of ${item.expected}`;
  return make(expected, (value, path) => {
    if (!Array.isArray(value)) return fail(path, expected, value);
    if (options.maxItems !== undefined && value.length > options.maxItems) {
      throw new ValidationError(path, `expected at most ${options.maxItems} items`);
    }
    return value.map((element: unknown, index) => item.parse(element, `${path}[${index}]`));
  });
}

export interface RecordOptions {
  /** Keys must match this pattern. */
  readonly key?: RegExp;
  readonly maxKeys?: number;
}

/** A dictionary chosen by the input. Returned with a null prototype; unsafe keys are rejected. */
export function record<T>(value: Schema<T>, options: RecordOptions = {}): Schema<Record<string, T>> {
  const expected = `object of ${value.expected}`;
  return make(expected, (input, path) => {
    if (!isRecord(input)) return fail(path, expected, input);
    const keys = Object.keys(input);
    if (options.maxKeys !== undefined && keys.length > options.maxKeys) {
      throw new ValidationError(path, `expected at most ${options.maxKeys} keys`);
    }
    const out = Object.create(null) as Record<string, T>;
    for (const key of keys) {
      if (UNSAFE_KEYS.has(key)) throw new ValidationError(`${path}.${key}`, "reserved key");
      if (options.key && !new RegExp(options.key.source, options.key.flags.replace(/[gy]/g, "")).test(key)) {
        throw new ValidationError(`${path}.${key}`, `key does not match ${String(options.key)}`);
      }
      out[key] = value.parse(input[key], `${path}.${key}`);
    }
    return out;
  });
}

export interface ObjectOptions {
  /**
   * What to do with keys the shape does not name: "strip" drops them (the default: tolerant of
   * newer writers), "reject" fails (for messages from an untrusted peer).
   */
  readonly unknownKeys?: "strip" | "reject";
}

/** A fixed-shape object. The result holds exactly the shape's keys; absent optional keys stay absent. */
export function object<S extends Shape>(shape: S, options: ObjectOptions = {}): Schema<ObjectOf<S>> {
  const keys = Object.keys(shape);
  const expected = `object with ${keys.length ? keys.join(", ") : "no keys"}`;
  return make(expected, (input, path) => {
    if (!isRecord(input)) return fail(path, "object", input);
    if (options.unknownKeys === "reject") {
      const extra = Object.keys(input).filter((key) => !Object.hasOwn(shape, key));
      if (extra.length) throw new ValidationError(path, `unexpected key ${JSON.stringify(extra[0])}`);
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const field = shape[key];
      if (field === undefined) continue;
      const raw = Object.hasOwn(input, key) ? input[key] : undefined;
      const parsed = field.parse(raw, `${path}.${key}`);
      if (parsed !== undefined) out[key] = parsed;
    }
    return out as ObjectOf<S>;
  });
}

/** The first member that accepts the value. Put the most specific members first. */
export function union<const M extends readonly Schema<unknown>[]>(...members: M): Schema<Infer<M[number]>> {
  const expected = members.map((member) => member.expected).join(" | ");
  return make(expected, (value, path) => {
    for (const member of members) {
      const result = safeParse(member, value, path);
      if (result.ok) return result.value as Infer<M[number]>;
    }
    throw new ValidationError(path, `expected ${expected}, got ${describe(value)}`);
  });
}

/** `inner`, then a check of your own (`message` explains what failed). */
export function refine<T>(inner: Schema<T>, check: (value: T) => boolean, message: string): Schema<T> {
  return make(`${inner.expected} (${message})`, (value, path) => {
    const parsed = inner.parse(value, path);
    if (!check(parsed)) throw new ValidationError(path, message);
    return parsed;
  });
}
