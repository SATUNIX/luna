#!/usr/bin/env node
// Inert Node fixture only: never starts Pi or evaluates task text as code.
//
// Pins the 2026-09 subagent overhaul contracts:
//   1. Built-in kit roles resolve with no .pi/agents and no ~/.pi/agent/agents (the default
//      "user" scope used to find no roles at all), and project copies are reported as shadows.
//   2. Role frontmatter: model/thinking/skills/extensions/max_runtime are parsed; a role model is
//      honoured unless inheritance is forced; skills are preloaded into the system prompt.
//   3. Run ids are unique even when created in the same millisecond (parallel same-role runs).
//   4. A >200 KiB task reaches the child intact over stdin (argv would hit MAX_ARG_STRLEN).
//   5. A multi-byte UTF-8 character split across two stdout chunks decodes correctly.
//   6. Child isolation: --no-extensions plus only the safety extensions the operator enabled.
//   7. A registry row whose process died is reported "orphaned", not "running" forever, and
//      runs.jsonl is compacted to a bounded number of runs.
//   8. Surface trim: four kit roles, depth 1 by default and still overridable, and no chain mode,
//      confirmProjectAgents or removed commands.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fakePi, loadExtension, loadModule, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type * as DelegationGuard from "../packages/extensions/src/delegation-guard/index.ts";
import type * as Subagent from "../packages/extensions/third_party/subagent/index.ts";
import type * as SubagentAgents from "../packages/extensions/third_party/subagent/agents.ts";
import type * as SubagentLogging from "../packages/extensions/third_party/subagent/logging.ts";
import type * as SubagentStatus from "../packages/extensions/third_party/subagent/status.ts";
import type * as SubagentConfig from "../packages/extensions/third_party/subagent/config.ts";
import type * as SubagentTools from "../packages/extensions/third_party/subagent/tools.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type { RunAgentOptions } from "../packages/extensions/third_party/subagent/runner.ts";
import type { SingleResult } from "../packages/extensions/third_party/subagent/types.ts";
import { object, parseJsonAs, string, unknownValue } from "../packages/core/lib/guard.ts";

/** The subset of a discovered/parsed role this test reads. */
interface AgentRole {
  name: string;
  source: string;
}

interface Launch {
  args: string[];
  prompt: string;
}

/** A registry row from status.collectRuns(). */
interface RunRow {
  id: string;
  status: string;
}

/** A stand-in for the ChildProcess the subagent runner spawns. */
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: () => true,
  });
}

// The subagent entry module as this test drives it: runAgent given a spawn double that returns fakeChild().
type SubagentIndex = Omit<typeof Subagent, "default" | "runAgent"> & {
  default: (api: ReturnType<typeof fakePi>["api"]) => void;
  runAgent: (options: Omit<RunAgentOptions, "spawnChild"> & { spawnChild: (cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => ReturnType<typeof fakeChild> }) => Promise<SingleResult>;
};

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-subagent-roles-");
const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent"));
let checks = 0;
const ok = (label: string) => { checks++; console.log(`  OK: ${label}`); };
try {
  const index = await loadModule<SubagentIndex>("vendor/subagent/index.ts");
  const agentsMod = await loadModule<typeof SubagentAgents>("vendor/subagent/agents.ts");
  const logging = await loadModule<typeof SubagentLogging>("vendor/subagent/logging.ts");
  const status = await loadModule<typeof SubagentStatus>("vendor/subagent/status.ts");

  // 1. Kit roles.
  {
    const { agents, shadowed } = agentsMod.discoverAgents(ws, "user");
    const names = agents.map((a: AgentRole) => a.name).sort();
    assert.deepEqual(names, ["implementer", "planner", "reviewer", "scout"], "the kit roles are exactly the four shipped roles");
    assert.ok(agents.every((a: AgentRole) => a.source === "kit"));
    assert.deepEqual(shadowed, []);
    fs.mkdirSync(path.join(ws, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".pi", "agents", "planner.md"), "---\nname: planner\ndescription: stale copy\n---\nold\n");
    // A byte-identical copy carries no customisation, so it must not be reported as stale.
    const kitDir = agentsMod.kitAgentsDir();
    fs.writeFileSync(path.join(ws, ".pi", "agents", "reviewer.md"), fs.readFileSync(path.join(kitDir, "reviewer.md")));
    assert.deepEqual(agentsMod.staleProjectRoleCopies(ws), ["planner"], "only content-different copies are stale");
    // Drop the identical copy so the rest of section 1 verifies only the deliberately-different one.
    fs.rmSync(path.join(ws, ".pi", "agents", "reviewer.md"));
    const both = agentsMod.discoverAgents(ws, "both");
    assert.deepEqual(both.shadowed, ["planner"]);
    assert.equal(both.agents.find((a: AgentRole) => a.name === "planner")?.source, "project");
    assert.equal(agentsMod.discoverAgents(ws, "user").agents.find((a: AgentRole) => a.name === "planner")?.source, "kit", "default scope ignores project copies");
    ok("kit roles resolve by default; project copies are detected as shadows");
  }

  // 2. Frontmatter + model policy + skill preload.
  {
    const parsed = agentsMod.parseAgentFile("---\nname: r\ndescription: d\ntools: read, grep\nmodel: openrouter/x\nthinking: low\nskills: verification-loop, missing-skill\nextensions: todo\nmax_runtime: 90s\n---\nbody\n", "user", "f");
    assert.ok(parsed, "the role file parses");
    assert.deepEqual(parsed.tools, ["read", "grep"]);
    assert.equal(parsed.model, "openrouter/x");
    assert.equal(parsed.thinking, "low");
    assert.deepEqual(parsed.skills, ["verification-loop", "missing-skill"]);
    assert.deepEqual(parsed.extensions, ["todo"]);
    assert.equal(parsed.maxRuntimeMs, 90_000);

    const launches: Launch[] = [];
    const lastLaunch = (): Launch => {
      const launch = launches.at(-1);
      if (!launch) throw new Error("no child was launched");
      return launch;
    };
    const spawn = (_cmd: string, args: string[]) => {
      const child = fakeChild();
      const launch: Launch = { args, prompt: "" };
      launches.push(launch);
      const promptIndex = args.indexOf("--append-system-prompt");
      if (promptIndex >= 0) {
        const promptFile = args[promptIndex + 1];
        assert.ok(promptFile, "--append-system-prompt names a file");
        launch.prompt = fs.readFileSync(promptFile, "utf8");
      }
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end" } }) + "\n");
        child.emit("close", 0);
      });
      return child;
    };
    const roles = [parsed];
    await index.runAgent({ defaultCwd: ws, agents: roles, agentName: "r", task: "t", parentModel: "parent/p", spawnChild: spawn });
    const a = lastLaunch().args;
    assert.equal(a[a.indexOf("--model") + 1], "openrouter/x", "role model is honoured");
    assert.equal(a[a.indexOf("--thinking") + 1], "low");
    assert.match(lastLaunch().prompt, /<skill name="verification-loop"/, "skills are preloaded");
    await index.runAgent({ defaultCwd: ws, agents: roles, agentName: "r", task: "t", parentModel: "parent/p", inheritParentModel: true, spawnChild: spawn });
    assert.equal(lastLaunch().args[lastLaunch().args.indexOf("--model") + 1], "parent/p", "forced inheritance wins");
    const plain = { ...parsed, model: undefined };
    await index.runAgent({ defaultCwd: ws, agents: [plain], agentName: "r", task: "t", parentModel: "parent/p", spawnChild: spawn });
    assert.equal(lastLaunch().args[lastLaunch().args.indexOf("--model") + 1], "parent/p", "no role model -> parent model");
    await index.runAgent({ defaultCwd: ws, agents: roles, agentName: "r", task: "t", overrides: { model: "step/m", tools: ["read"] }, spawnChild: spawn });
    const o = lastLaunch().args;
    assert.equal(o[o.indexOf("--model") + 1], "step/m");
    assert.equal(o[o.indexOf("--tools") + 1], "read");
    ok("role frontmatter parsed; model policy and skill preload applied");
  }

  // 3. Unique run ids in one millisecond.
  {
    // Freeze the clock so every id shares one timestamp, as parallel launches do.
    // Typed with its receiver: the saved original is only ever called through .call(date).
    const dateProto: { toISOString: (this: Date) => string } = Date.prototype;
    const realToISOString = dateProto.toISOString;
    Date.prototype.toISOString = function () { return realToISOString.call(new Date(1_790_000_000_000)); };
    try {
      const ids = new Set(Array.from({ length: 20 }, () => logging.createRunLog(ws, "scout", "x", 0).id));
      assert.equal(ids.size, 20, "same-millisecond runs of one role must get distinct ids");
    } finally {
      Date.prototype.toISOString = realToISOString;
    }
    ok("run ids are unique within one millisecond");
  }

  // 4 + 5. Large task over stdin; split UTF-8 decoding.
  {
    const roles: AgentConfig[] = [{ name: "scout", description: "d", tools: ["read"], systemPrompt: "", source: "user", filePath: "f" }];
    const big = "x".repeat(210 * 1024);
    let received = "";
    const text = "héllo — 世界 ✓";
    const spawn = (_cmd: string, args: string[]) => {
      const child = fakeChild();
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (d: string) => { received += d; });
      assert.ok(args.every((arg) => arg.length < 128 * 1024), "no argv element approaches MAX_ARG_STRLEN");
      queueMicrotask(() => {
        const line = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } }) + "\n", "utf8");
        const cut = line.indexOf(Buffer.from("世", "utf8")) + 1; // split inside a 3-byte character
        child.stdout.write(line.subarray(0, cut));
        setTimeout(() => { child.stdout.write(line.subarray(cut)); child.emit("close", 0); }, 5);
      });
      return child;
    };
    const keepalive = setInterval(() => {}, 1000);
    try {
      const r = await index.runAgent({ defaultCwd: ws, agents: roles, agentName: "scout", task: big, spawnChild: spawn });
      assert.equal(received, `Task: ${big}`, "the full task arrives over stdin");
      assert.equal(r.finalOutput, text, "a split multi-byte character decodes correctly");
    } finally {
      clearInterval(keepalive);
    }
    ok("210 KiB task travels over stdin; split UTF-8 chunk decodes");
  }

  // 7. Isolation.
  {
    const agentDir = path.join(ws, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "../kit", extensions: ["packages/extensions/src/secret-guard/index.ts", "packages/extensions/src/memory-local/index.ts", "packages/extensions/third_party/todo/index.ts"] }] }));
    // The parent runs the firewall, path protection and (enabled by the operator) secret-guard.
    const protections: unknown = Reflect.get(globalThis, Symbol.for("pi-kit.protections"));
    assert.ok(protections instanceof Set, "the parent's protections registry is installed");
    protections.add("secret-guard");
    const guard = __delegation.guard as typeof DelegationGuard;
    const plan = guard.prepareChild({ cwd: ws, kind: "discretionary", role: "scout" });
    if (!plan.ok) assert.fail(plan.reason);
    assert.equal(plan.args[0], "--no-extensions");
    plan.slot.settle("test");
    assert.deepEqual([...plan.loaded].sort(), ["delegation-guard", "effort", "protected-paths", "secret-guard", "todo", "tool-firewall"], "protections the parent runs, effort and enabled companions load; memory/orchestrator never do");
    const delegating = guard.prepareChild({ cwd: ws, kind: "discretionary", role: "implementer", needsSubagent: true });
    assert.ok(delegating.ok, "a child granted delegation is prepared");
    assert.ok(delegating.loaded.includes("subagent"), "a child granted delegation gets the subagent tool");
    delegating.slot.settle("test");
    const restore = setEnv("PI_KIT_SUBAGENT_ISOLATE", "0");
    try {
      const forced = guard.prepareChild({ cwd: ws, kind: "discretionary", role: "scout" });
      assert.ok(forced.ok, "the child is prepared");
      assert.equal(forced.args[0], "--no-extensions", "isolation can no longer be disabled: a child never inherits an unknown extension set");
      forced.slot.settle("test");
    } finally { restore(); }
    fs.rmSync(path.join(agentDir, "settings.json"));
    ok("children load --no-extensions plus enabled safety extensions only");
  }

  // 7. Orphans + registry compaction.
  {
    const dir = path.join(ws, "reg");
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const lines = [
      { ts: old, id: "dead-pid", event: "start", agent: "scout" },
      { ts: old, id: "dead-pid", event: "spawn", pid: 2 ** 22 + 12345, agent: "scout" },
      { ts: new Date().toISOString(), id: "alive", event: "start", agent: "scout" },
      { ts: new Date().toISOString(), id: "alive", event: "spawn", pid: process.pid, agent: "scout" },
    ];
    fs.writeFileSync(path.join(dir, "runs.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const rows = status.collectRuns(dir);
    assert.equal(rows.find((r: RunRow) => r.id === "dead-pid")?.status, "orphaned");
    assert.equal(rows.find((r: RunRow) => r.id === "alive")?.status, "running");
    const many = [];
    for (let i = 0; i < 30; i++) many.push(JSON.stringify({ id: `r${i}`, event: "start" }), JSON.stringify({ id: `r${i}`, event: "end", status: "end" }));
    fs.writeFileSync(path.join(dir, "runs.jsonl"), many.join("\n") + "\n");
    logging.compactRegistry(dir, 10);
    const kept = fs.readFileSync(path.join(dir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => parseJsonAs(object({ id: string() }), l).id);
    assert.equal(new Set(kept).size, 10);
    assert.ok(kept.includes("r29") && !kept.includes("r0"), "the newest runs are kept");
    ok("dead runs report orphaned; registry compacts to the newest runs");
  }

  // 8. Surface trim: default depth 1 (still overridable), four kit roles, no removed params or commands.
  {
    const config = await loadModule<typeof SubagentConfig>("vendor/subagent/config.ts");
    const toolsMod = await loadModule<typeof SubagentTools>("vendor/subagent/tools.ts");
    assert.equal(config.DEFAULT_MAX_DEPTH, 1, "the default depth is root -> child only");

    // A custom role that delegates still runs at depth 2 when the operator raises the limit: 1 is a
    // default, not a hard cap. The caller is a depth-1 child, so nestingError (the gate the subagent
    // tool runs first) is checked before the launch. The child is a fake, so no pi process starts.
    const agentDir = path.join(ws, "agent", "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "depth-two-role.md"), "---\nname: depth-two-role\ndescription: custom role\ntools: read, subagent\n---\nbody\n");
    const custom = agentsMod.discoverAgents(ws, "user").agents.find((a: AgentRole) => a.name === "depth-two-role");
    assert.ok(custom, "the custom role resolves");
    const restoreDepth = setEnv("PI_KIT_SUBAGENT_DEPTH", "1");
    const restoreMax = setEnv("PI_KIT_SUBAGENT_MAX_DEPTH", undefined);
    let defaultRefusal = "";
    try {
      defaultRefusal = toolsMod.nestingError() ?? "";
    } finally {
      restoreMax();
    }
    assert.match(defaultRefusal, /depth 1\/1/, "at the default a child cannot delegate further");
    const restoreMax2 = setEnv("PI_KIT_SUBAGENT_MAX_DEPTH", "2");
    try {
      assert.equal(toolsMod.nestingError(), null, "PI_KIT_SUBAGENT_MAX_DEPTH=2 lets a child delegate");
      let childDepth: string | undefined;
      const spawn = (_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        childDepth = options.env?.PI_KIT_SUBAGENT_DEPTH;
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end" } }) + "\n");
          child.emit("close", 0);
        });
        return child;
      };
      const launched = await index.runAgent({ defaultCwd: ws, agents: [custom], agentName: "depth-two-role", task: "t", spawnChild: spawn });
      assert.equal(launched.exitCode, 0, launched.errorMessage ?? "depth-two-role runs");
      assert.equal(childDepth, "2", "depth-two-role is launched at depth 2");
    } finally {
      restoreMax2();
      restoreDepth();
    }

    const pi = fakePi();
    index.default(pi.api);
    (await loadExtension("extensions/progress-guard/index.ts"))(pi.api);
    (await loadExtension("extensions/recovery-orchestrator/index.ts"))(pi.api);
    const tool = pi.tools.find("subagent");
    assert.ok(tool, "the subagent tool is registered");
    const schema = parseJsonAs(object({ properties: unknownValue() }), JSON.stringify(tool.parameters), "subagent parameters");
    const props = schema.properties;
    assert.ok(typeof props === "object" && props !== null, "the subagent parameters list their properties");
    assert.equal(Object.hasOwn(props, "chain"), false, "chain is not in the subagent schema");
    assert.equal(Object.hasOwn(props, "confirmProjectAgents"), false, "confirmProjectAgents is not in the subagent schema");
    for (const removed of ["subagents", "subagent-stop", "reflect", "recover"]) assert.equal(pi.commands.find(removed), undefined, `/${removed} is not registered`);
    assert.ok(pi.commands.find("workflows"), "/workflows survives the trim");
    assert.ok(pi.commands.find("boost"), "/boost survives the trim");
    // The delegation tool text, measured as DESIGN measures it, stays inside its budget.
    let toolText = 0;
    for (const name of ["subagent", "workflow_run", "workflow_status", "workflow_control", "workflow"]) {
      const t = pi.tools.find(name);
      assert.ok(t, `${name} is registered`);
      toolText += t.description.length + (t.promptSnippet ?? "").length + JSON.stringify(t.parameters).length;
    }
    assert.ok(toolText <= 4900, `the delegation tool text is ${String(toolText)} chars, over the 4,900 budget`);
    ok("default depth 1 is overridable, the kit has four roles, the removed params and commands are gone, and the tool text fits 4,900");
  }

  console.log(`[subagent-roles-isolation-smoke] all ${checks} checks passed`);
} finally {
  restoreAgentDir();
  rmWorkspace(ws);
}
