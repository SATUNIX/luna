/**
 * The kit's footprint, measured (V-81): the text a profile spends on its tools, and the part of the
 * system prompt two consecutive turns keep.
 *
 * A small model pays for every character of tool description and parameter schema before it reads
 * the task, so the kit's floor is a measured number, not a claim. `footprint-baseline.json` beside
 * this module is the reviewed record of that floor: a deliberate kit-text change updates it in the
 * same commit, an accidental one fails `smoke:eval-footprint`. The ceiling itself (9,500 characters
 * for `balanced`, 4,900 for its delegation tools) lives in the baseline.
 *
 * The prompt meter exists because a prefix that changes between turns throws away the
 * provider-side cache and re-reads the whole system prompt: two consecutive turns must agree up to
 * the effort block, which is the one part effort is allowed to rewrite.
 *
 * Deterministic and offline, like the rest of the eval harness: fake pi, a temp HOME and
 * PI_CODING_AGENT_DIR, a temp cwd, and no model. `measureFootprint` and `measurePromptPrefix` are
 * the only functions here that touch the filesystem or the environment; `planValidRate` and
 * `footprintProblems` are pure so the live-only fixture and the smoke test can reuse them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakePi, isolateKitEnv, loadExtension, rmWorkspace, setEnv, tmpWorkspace, type FakeHandler, type FakePiApi, type FakeTool } from "./harness.ts";
import { extensionRelPath } from "../lib/paths.ts";
import { loadProfileDef } from "../lib/profiles.ts";
import { resolveProfile } from "../lib/resolve.ts";
import { array, isRecord, literal, number, object, optional, parseJsonAs, record, string, type Infer } from "../lib/guard.ts";

/** One tool a profile registers, with the characters it costs: name, description, parameter schema. */
export interface FootprintTool {
  name: string;
  chars: number;
}

/** What one profile's tool surface costs, and the delegation part of it. */
export interface Footprint {
  profile: string;
  tools: readonly FootprintTool[];
  toolText: number;
  /** The delegation tools the profile registers (null when it registers none), alphabetically. */
  delegation: { tools: readonly string[]; toolText: number } | null;
}

/** Every tool that starts an agent, wherever it lives (DESIGN §5 measures these together). */
export const DELEGATION_TOOLS: readonly string[] = ["subagent", "workflow", "workflow_run", "workflow_status", "workflow_control"];

/**
 * The effort block's start marker. extensions/effort/policy.ts exports PROMPT_START with this exact
 * text; it is repeated here because an extension may not be imported by core code
 * (CONTRIBUTING "self-containment"), and the smoke test holds the two together.
 */
const EFFORT_START = "<!-- pi-kit:effort -->";

/** A stand-in for pi's own system prompt: any stable text shows whether the prefix survives a turn. */
const BASE_PROMPT = "You are a coding agent. This base prompt stands in for pi's own, which the effort block must extend in place.";

/** What one tool costs: its name, its description and its parameter schema, as JSON. */
function toolChars(tool: FakeTool): number {
  return tool.name.length + (tool.description ?? "").length + JSON.stringify(tool.parameters ?? "").length;
}

/** pi's headless extension context: no UI, a given cwd, and the session manager call sites read. */
function headlessContext(cwd: string): unknown {
  return {
    cwd,
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getEntries: () => [], getSessionId: () => "footprint" },
  };
}

/** Run `fn` with the kit's environment isolated and a temp agent dir, then put everything back. */
async function hermetically<T>(prefix: string, fn: (workspace: string) => Promise<T>): Promise<T> {
  const restoreIsolation = isolateKitEnv();
  const workspace = tmpWorkspace(prefix);
  const restoreHome = setEnv("HOME", path.join(workspace, "home"));
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent"));
  const previousCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(workspace, "home"), { recursive: true });
    // Several extensions resolve state against the process cwd; the measurement must not read or
    // write the caller's checkout.
    process.chdir(workspace);
    return await fn(workspace);
  } finally {
    process.chdir(previousCwd);
    restoreAgentDir();
    restoreHome();
    restoreIsolation();
    rmWorkspace(workspace);
  }
}

/**
 * Measure what `profile` costs: the profile's extensions are loaded and registered against a fake
 * pi, its session_start handler fires once, and every tool registered by then is counted. External
 * companions are left out: their text is not the kit's to review. A tool registered twice counts
 * once, as pi would show it.
 */
export async function measureFootprint(profile: string): Promise<Footprint> {
  return hermetically("pi-kit-footprint-", async (workspace) => {
    const definition = loadProfileDef(profile);
    const tools = new Map<string, number>();
    for (const resolved of resolveProfile(definition.include ?? [])) {
      if (resolved.avenue === "external") continue;
      const register = await loadExtension(extensionRelPath(resolved.name, resolved.avenue));
      const pi = fakePi();
      register(pi.api);
      const onSessionStart = pi.handlers.find("session_start");
      if (onSessionStart) await onSessionStart({}, headlessContext(workspace));
      for (const [name, tool] of pi.tools) tools.set(name, toolChars(tool));
    }
    const measured = [...tools]
      .map(([name, chars]) => ({ name, chars }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const delegation = measured.filter((tool) => DELEGATION_TOOLS.includes(tool.name));
    return {
      profile,
      tools: measured,
      toolText: measured.reduce((sum, tool) => sum + tool.chars, 0),
      delegation:
        delegation.length === 0
          ? null
          : { tools: delegation.map((tool) => tool.name), toolText: delegation.reduce((sum, tool) => sum + tool.chars, 0) },
    };
  });
}

/** The two consecutive turns' prompts and what they say about the effort block. */
export interface PromptPrefix {
  /** The system prompt of each measured turn, in order. */
  turns: readonly string[];
  /** How many leading characters every turn has in common. */
  sharedPrefix: number;
  /** Where the effort block starts in the first turn (-1 when it does not appear). */
  effortStart: number;
  /** How many effort blocks each turn carries. */
  blocksPerTurn: readonly number[];
  /** True when the prefix survives to the effort block and each turn has exactly one block. */
  stable: boolean;
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charAt(i) === b.charAt(i)) i++;
  return i;
}

/** Options for `measurePromptPrefix`. */
export interface PromptPrefixOptions {
  /**
   * Extensions registered ahead of the profile's own, in order: the smoke test uses one to show
   * that per-turn text placed before the effort block is caught.
   */
  leading?: readonly ((pi: FakePiApi) => void)[];
}

/**
 * Measure the system prompt `profile` builds across two consecutive user turns, the way pi builds
 * it: every turn starts again from pi's base prompt (BASE_PROMPT here) and passes through each
 * loaded extension's before_agent_start handler in load order, each one receiving the prompt the
 * previous one returned. The profile's in-repo extensions are loaded as measureFootprint loads
 * them (external companions left out), each on its own fake pi, and each session_start fires
 * once first. Stable means the two final prompts agree up to the effort block, the block is the
 * only thing that moved, and each turn carries exactly one.
 */
export async function measurePromptPrefix(profile = "balanced", options: PromptPrefixOptions = {}): Promise<PromptPrefix> {
  return hermetically("pi-kit-prompt-", async (workspace) => {
    const context = headlessContext(workspace);
    const registrations: Array<(pi: FakePiApi) => void> = [...(options.leading ?? [])];
    for (const resolved of resolveProfile(loadProfileDef(profile).include ?? [])) {
      if (resolved.avenue === "external") continue;
      const register = await loadExtension(extensionRelPath(resolved.name, resolved.avenue));
      registrations.push((pi) => {
        register(pi);
      });
    }
    const chain: Array<FakeHandler<"before_agent_start">> = [];
    for (const register of registrations) {
      const pi = fakePi();
      register(pi.api);
      const onSessionStart = pi.handlers.find("session_start");
      if (onSessionStart) await onSessionStart({ reason: "startup" }, context);
      const beforeAgentStart = pi.handlers.find("before_agent_start");
      if (beforeAgentStart) chain.push(beforeAgentStart);
    }
    const runTurn = async (prompt: string): Promise<string> => {
      let systemPrompt = BASE_PROMPT;
      for (const handler of chain) {
        const result = await handler({ systemPrompt, messageType: "user", prompt }, context);
        if (typeof result?.systemPrompt === "string") systemPrompt = result.systemPrompt;
      }
      return systemPrompt;
    };
    const first = await runTurn("one");
    const second = await runTurn("two");
    const turns: readonly string[] = [first, second];
    const base = turns[0];
    if (base === undefined) throw new Error("measurePromptPrefix: no turn was measured");
    const starts = turns.map((turn) => turn.indexOf(EFFORT_START));
    const blocksPerTurn = turns.map((turn) => turn.split(EFFORT_START).length - 1);
    const sharedPrefix = turns.slice(1).reduce((shared, turn) => Math.min(shared, commonPrefix(base, turn)), base.length);
    // Identical text before the marker, in every turn: the block may be rewritten, nothing else.
    const beforeIdentical = turns.every((turn) => {
      const at = turn.indexOf(EFFORT_START);
      return at >= 0 && turn.slice(0, at) === base.slice(0, at);
    });
    return {
      turns,
      sharedPrefix,
      effortStart: starts[0] ?? -1,
      blocksPerTurn,
      stable: beforeIdentical && starts.every((at) => at >= 0 && sharedPrefix >= at) && blocksPerTurn.every((count) => count === 1),
    };
  });
}

// --- the reviewed baseline --------------------------------------------------------------------

const DelegationBaselineSchema = object({
  tools: array(string()),
  toolText: number(),
  ceiling: optional(number()),
});

const ProfileBaselineSchema = object({
  toolText: number(),
  /** The most this profile's tool text may cost; absent for a profile with no agreed ceiling. */
  ceiling: optional(number()),
  delegation: optional(DelegationBaselineSchema),
  /** Every tool the profile registers and its measured characters. */
  tools: record(number()),
});

const FootprintBaselineSchema = object({
  schemaVersion: literal(1),
  profiles: record(ProfileBaselineSchema),
});

/** The reviewed record of the kit's floor (footprint-baseline.json beside this module). */
export type FootprintBaseline = Infer<typeof FootprintBaselineSchema>;

/** Read and validate the baseline. A malformed record is an error: a silent default hides a drift. */
export function readBaseline(): FootprintBaseline {
  const file = fileURLToPath(new URL("./footprint-baseline.json", import.meta.url));
  return parseJsonAs(FootprintBaselineSchema, fs.readFileSync(file, "utf8"), file);
}

/**
 * Every way `f` differs from the reviewed baseline: over a ceiling, off the recorded total, a tool
 * whose text changed or that appeared or disappeared, and the delegation total. Empty when the
 * profile is within its ceiling and matches the baseline exactly.
 */
export function footprintProblems(f: Footprint, baseline: FootprintBaseline): string[] {
  const entry = baseline.profiles[f.profile];
  if (entry === undefined) return [`${f.profile}: no baseline entry in footprint-baseline.json; add its measured numbers`];
  const problems: string[] = [];
  const signed = (n: number): string => (n > 0 ? `+${String(n)}` : String(n));
  const counts = new Map(f.tools.map((tool) => [tool.name, tool.chars]));
  if (entry.ceiling !== undefined && f.toolText > entry.ceiling) {
    problems.push(
      `${f.profile}: tool text ${String(f.toolText)} chars is over the ${String(entry.ceiling)}-char ceiling ` +
        `(baseline ${String(entry.toolText)}, delta ${signed(f.toolText - entry.toolText)})`,
    );
  }
  if (f.toolText !== entry.toolText) {
    problems.push(
      `${f.profile}: tool text is ${String(f.toolText)} chars, the baseline records ${String(entry.toolText)} ` +
        `(delta ${signed(f.toolText - entry.toolText)}); update footprint-baseline.json if the change is deliberate`,
    );
  }
  for (const [name, chars] of counts) {
    const recorded = entry.tools[name];
    if (recorded === undefined) problems.push(`${f.profile}: tool "${name}" (${String(chars)} chars) is not in the baseline`);
    else if (recorded !== chars) {
      problems.push(`${f.profile}: tool "${name}" is ${String(chars)} chars, the baseline records ${String(recorded)} (delta ${signed(chars - recorded)})`);
    }
  }
  for (const name of Object.keys(entry.tools)) {
    if (!counts.has(name)) problems.push(`${f.profile}: the baseline records tool "${name}", which the profile no longer registers`);
  }
  const wanted = entry.delegation;
  if (wanted !== undefined) {
    if (f.delegation === null) {
      problems.push(`${f.profile}: the baseline records delegation tools (${wanted.tools.join(", ")}); the profile registers none`);
    } else {
      const measured = f.delegation;
      const missing = wanted.tools.filter((name) => !measured.tools.includes(name));
      const added = measured.tools.filter((name) => !wanted.tools.includes(name));
      if (missing.length > 0 || added.length > 0) {
        problems.push(
          `${f.profile}: delegation tools differ from the baseline (missing: ${missing.join(", ") || "none"}; extra: ${added.join(", ") || "none"})`,
        );
      }
      if (wanted.ceiling !== undefined && measured.toolText > wanted.ceiling) {
        problems.push(
          `${f.profile}: delegation tool text ${String(measured.toolText)} chars is over the ${String(wanted.ceiling)}-char ceiling ` +
            `(baseline ${String(wanted.toolText)}, delta ${signed(measured.toolText - wanted.toolText)})`,
        );
      }
      if (measured.toolText !== wanted.toolText) {
        problems.push(
          `${f.profile}: delegation tool text is ${String(measured.toolText)} chars, the baseline records ${String(wanted.toolText)} ` +
            `(delta ${signed(measured.toolText - wanted.toolText)})`,
        );
      }
    }
  }
  return problems;
}

// --- plan-valid rate --------------------------------------------------------------------------

/** One model's plan-valid count. `rate` is valid/total, rounded to three decimals. */
export interface PlanValidCount {
  total: number;
  valid: number;
  rate: number;
}

/** Plan-valid counts overall and per model, as the live-only fixture records them. */
export interface PlanValidRate {
  total: number;
  perModel: Readonly<Record<string, PlanValidCount>>;
}

/**
 * Count how often each model's plan validates. Each record is untrusted: `model` must be a
 * non-empty string or the record is ignored (not counted), and the value handed to `isValid` is
 * the record's `steps` when it has one, otherwise the record itself. Pure, so the offline smoke
 * test and the live-only fixture score the same way.
 */
export function planValidRate(records: readonly unknown[], isValid: (steps: unknown) => boolean): PlanValidRate {
  const counts = new Map<string, { total: number; valid: number }>();
  for (const record of records) {
    if (!isRecord(record)) continue;
    const model = Object.hasOwn(record, "model") ? record.model : undefined;
    if (typeof model !== "string" || model.trim() === "") continue;
    const count = counts.get(model) ?? { total: 0, valid: 0 };
    count.total += 1;
    if (isValid(Object.hasOwn(record, "steps") ? record.steps : record)) count.valid += 1;
    counts.set(model, count);
  }
  // Object.fromEntries defines own properties (safe for a model named "__proto__") and keeps the
  // output stable: models sorted, so two runs of the same file produce the same record.
  const perModel = Object.fromEntries(
    [...counts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([model, count]) => [model, { ...count, rate: Math.round((count.valid / count.total) * 1000) / 1000 }] as const),
  );
  return { total: [...counts.values()].reduce((sum, count) => sum + count.total, 0), perModel };
}
