// Test helper: a real delegation registry (the effort and delegation-guard extensions) for code
// that launches children through subagent's runAgent. Launches are refused without it, so tests
// that fake the child process still need the guard in place, exactly as a real profile has it.
//
//   const d = await installDelegation({ tier: "exhaustive", limits: { maxConcurrent: 8, maxTotal: 64 } });
//   ... runAgent(...) ...
//   d.cleanup();
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, loadModule, rmWorkspace } from "./harness.ts";
import { call, callMethod } from "./dynamic.ts";

/** Per-tier delegation limits, as written to the effort config. */
export interface DelegationLimits {
  readonly maxConcurrent?: number;
  readonly maxTotal?: number;
  readonly maxScouts?: number;
}

export interface DelegationOptions {
  /** The effort tier to select (PI_KIT_EFFORT). */
  readonly tier?: string;
  readonly limits?: DelegationLimits;
  /** The protections the delegation guard sees as installed. */
  readonly protections?: readonly string[];
}

/** A module as the harness loads it (extension exports are whatever harness.ts says they are). */
type LoadedModule = Awaited<ReturnType<typeof loadModule>>;

export interface InstalledDelegation {
  /** The loaded delegation-guard and effort modules. */
  readonly guard: LoadedModule;
  readonly effort: LoadedModule;
  /** The effort extension's live delegation registry (its global slot). */
  registry(): unknown;
  /** Begin a new user turn (a fresh delegation scope). */
  newTurn(): unknown;
  cleanup(): void;
}

const EFFORT_KEY = Symbol.for("pi-kit.effort");
const DELEGATION_KEY = Symbol.for("pi-kit.delegation");
const PROTECTIONS_KEY = Symbol.for("pi-kit.protections");

export async function installDelegation({ tier = "exhaustive", limits = { maxConcurrent: 8, maxTotal: 64, maxScouts: 8 }, protections = ["tool-firewall", "protected-paths"] }: DelegationOptions = {}): Promise<InstalledDelegation> {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-delegation-"));
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, effort: process.env.PI_KIT_EFFORT, config: process.env.PI_KIT_EFFORT_CONFIG };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_KIT_EFFORT = tier;
  fs.mkdirSync(path.join(agentDir, "pi-kit"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "pi-kit", "effort.json"), JSON.stringify({ schemaVersion: 1, limits: { [tier]: limits } }));
  const guard = await loadModule("extensions/delegation-guard/index.ts");
  const effort = await loadModule("extensions/effort/index.ts");
  Reflect.deleteProperty(globalThis, EFFORT_KEY);
  Reflect.set(globalThis, PROTECTIONS_KEY, new Set(protections));
  // One fake pi per extension: the fake keeps a single handler per event name.
  const effortPi = fakePi();
  const guardPi = fakePi();
  callMethod(effort, "default", effortPi.api);
  callMethod(guard, "default", guardPi.api);
  const ctx = { hasUI: false, cwd: process.cwd(), ui: {}, sessionManager: { getSessionId: () => "test" } };
  const beforeAgentStart = (): unknown => call(effortPi.handlers.get("before_agent_start"), "effort before_agent_start handler", { systemPrompt: "" }, ctx);
  await call(effortPi.handlers.get("session_start"), "effort session_start handler", { reason: "startup" }, ctx);
  await call(guardPi.handlers.get("session_start"), "delegation-guard session_start handler", { reason: "startup" }, ctx);
  await beforeAgentStart();
  return {
    guard,
    effort,
    registry: (): unknown => Reflect.get(globalThis, EFFORT_KEY),
    newTurn: beforeAgentStart,
    cleanup() {
      for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agent], ["PI_KIT_EFFORT", saved.effort]] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      Reflect.deleteProperty(globalThis, EFFORT_KEY);
      Reflect.deleteProperty(globalThis, DELEGATION_KEY);
      Reflect.deleteProperty(globalThis, PROTECTIONS_KEY);
      rmWorkspace(agentDir);
    },
  };
}
