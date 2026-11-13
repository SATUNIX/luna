// GENERATED from packages/core/shared/ceiling.ts by packages/core/gen-shared.ts. Do not edit this copy:
// change the source and run `npm run gen:shared` (`npm run verify` fails when a copy differs).
/**
 * One ceiling for unattended work: how many turns, how much money and how much wall time a run may
 * use before it parks.
 *
 * A headless `pi -p` run, `/away` and an autonomous run each used to bound themselves in their own
 * way (or not at all). They now share this object and this one check, so a limit means the same
 * thing wherever it is set: the first of the three to be reached ends the run, and the run is
 * parked (stopped with its state kept, never failed), not abandoned.
 *
 * Pure: no clock, no filesystem. The caller measures usage and passes it in.
 *
 * Extensions are self-contained, so each consumer holds a generated copy (`npm run gen:shared`).
 */

/** The limits. A missing field is no limit on that axis. */
export interface Ceiling {
  turns?: number;
  costUsd?: number;
  seconds?: number;
}

export interface CeilingUsage {
  turns: number;
  costUsd: number;
  seconds: number;
}

export type Breach = "turns" | "cost" | "time";

const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** A ceiling from loose input: only positive finite numbers survive, so a typo is no limit rather than a zero limit. */
export function normaliseCeiling(raw: unknown): Ceiling {
  const get = (key: string): unknown => (raw !== null && typeof raw === "object" ? Reflect.get(raw, key) : undefined);
  const turns = positive(get("turns"));
  const costUsd = positive(get("costUsd"));
  const seconds = positive(get("seconds"));
  return { ...(turns !== undefined ? { turns: Math.floor(turns) } : {}), ...(costUsd !== undefined ? { costUsd } : {}), ...(seconds !== undefined ? { seconds } : {}) };
}

export function isEmptyCeiling(c: Ceiling): boolean {
  return c.turns === undefined && c.costUsd === undefined && c.seconds === undefined;
}

/** The ceiling a scripted run asks for: PI_KIT_CEILING_TURNS, PI_KIT_CEILING_USD, PI_KIT_CEILING_SECONDS (a duration such as 90m). */
export function ceilingFromEnv(env: NodeJS.ProcessEnv = process.env): Ceiling {
  return readEnvCeiling(env).ceiling;
}

/**
 * The ceiling variables that are set but do not hold a usable limit ("5usd", "90x", "0"). The loose
 * reading above drops them, which would leave an unattended run unbounded without a word, so the
 * caller must report or refuse each one named here.
 */
export function ceilingEnvProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  return readEnvCeiling(env).problems;
}

function readEnvCeiling(env: NodeJS.ProcessEnv): { ceiling: Ceiling; problems: string[] } {
  const problems: string[] = [];
  const read = (name: string, parse: (text: string) => number | undefined): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = parse(raw);
    if (positive(value) === undefined) problems.push(`${name}=${raw}`);
    return value;
  };
  const number = (text: string): number | undefined => (/^\d+(?:\.\d+)?$/.test(text) ? Number(text) : undefined);
  const ceiling = normaliseCeiling({
    turns: read("PI_KIT_CEILING_TURNS", number),
    costUsd: read("PI_KIT_CEILING_USD", number),
    seconds: read("PI_KIT_CEILING_SECONDS", parseDuration),
  });
  return { ceiling, problems };
}

/** "90m", "2h", "45s", "1h30m" or bare seconds, as seconds; undefined when it is none of those. */
export function parseDuration(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(t)) return positive(Number(t));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || t === "") return undefined;
  return positive(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

/** The first limit reached, or null. Money is checked first, then time, then turns. */
export function ceilingBreach(c: Ceiling, u: CeilingUsage): Breach | null {
  if (c.costUsd !== undefined && u.costUsd >= c.costUsd) return "cost";
  if (c.seconds !== undefined && u.seconds >= c.seconds) return "time";
  if (c.turns !== undefined && u.turns >= c.turns) return "turns";
  return null;
}

export function describeBreach(c: Ceiling, u: CeilingUsage, breach: Breach): string {
  switch (breach) {
    case "cost": return `spent $${u.costUsd.toFixed(2)} of the $${(c.costUsd ?? 0).toFixed(2)} ceiling`;
    case "time": return `ran ${Math.round(u.seconds / 60)} of the ${Math.round((c.seconds ?? 0) / 60)} minutes allowed`;
    case "turns": return `used ${u.turns} of the ${c.turns ?? 0} turns allowed`;
  }
}
