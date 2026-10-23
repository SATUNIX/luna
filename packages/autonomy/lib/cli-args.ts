// A small argument parser for cli.ts: `--flag value`, `--flag=value`, repeated flags, booleans.
// Unknown flags are errors, so a typo never silently changes what a command does.

/** Which flags a command accepts: values take one value, lists may repeat, flags are booleans. */
export interface ArgSpec<V extends string, L extends string, F extends string> {
  values?: readonly V[];
  lists?: readonly L[];
  flags?: readonly F[];
}

/** The parsed options, keyed by the spec's flag names; a flag that was not given is absent. */
export type ParsedOpts<V extends string, L extends string, F extends string> = { [K in V]?: string } & { [K in L]?: string[] } & { [K in F]?: boolean };

/** A usage error (exit code "usage" in cli.ts). */
export type UsageError = Error & { code: "usage" };

const usageError = (message: string): UsageError => Object.assign(new Error(message), { code: "usage" as const });

/**
 * @param argv arguments after the command
 * @param spec values: flags taking one value; lists: flags that may repeat; flags: booleans
 */
export function parseArgs<const V extends string = never, const L extends string = never, const F extends string = never>(
  argv: readonly string[],
  { values = [], lists = [], flags = [] }: ArgSpec<V, L, F>,
): { opts: ParsedOpts<V, L, F>; rest: string[] } {
  const opts: Record<string, string | boolean | string[]> = {};
  const rest: string[] = [];
  const known = new Set<string>([...values, ...lists, ...flags]);
  const isFlag = (name: string): boolean => (flags as readonly string[]).includes(name);
  const isList = (name: string): boolean => (lists as readonly string[]).includes(name);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (!known.has(name)) throw usageError(`unknown option --${name}${suggest(name, known)}`);
    if (isFlag(name)) {
      if (eq > 0) { const v = a.slice(eq + 1); opts[name] = !["false", "0", "no"].includes(v); } else opts[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq > 0) value = a.slice(eq + 1);
    else { value = argv[++i]; if (value === undefined || (value.startsWith("--") && value.length > 2)) throw usageError(`--${name} needs a value`); }
    if (isList(name)) {
      const list = opts[name];
      if (Array.isArray(list)) list.push(value); else opts[name] = [value];
    } else opts[name] = value;
  }
  return { opts: opts as ParsedOpts<V, L, F>, rest };
}

function suggest(name: string, known: ReadonlySet<string>): string {
  const close = [...known].filter((k) => k.startsWith(name.slice(0, 3)) || name.startsWith(k.slice(0, 3)));
  return close.length ? ` (did you mean ${close.slice(0, 3).map((k) => `--${k}`).join(", ")}?)` : "";
}

export const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw usageError(`--${name} must be a number (got ${JSON.stringify(v)})`);
  return n;
};
