#!/usr/bin/env node
// Offline workflow telemetry checks (run-model.ts fed by the YAML executor). The "child" is an
// in-process fake that answers from its task and reports usage and a model like a real pi child.
//   1. phases are listed up front in definition order; each step execution is one agent with its
//      label, phase, role, model, usage tokens, elapsed time and status; run totals add up.
//   2. a running agent's usage and activity update live, before it finishes.
//   3. a `when` skip is recorded as a skipped agent; parallel members share their group's phase.
//   4. a review gate's loop records a second agent per re-run step (label#2) and the phase status.
//   5. a failed step records the error; the run ends failed.
//   6. an aborted run marks the running agent aborted and the run interrupted; the subagents
//      status snapshot counts the live workflow run while it runs.
//   7. a throwing listener cannot break a run; unsubscribe stops delivery.
//   8. a resumed run reuses its id and seeds phases with their saved status.
//   9. the model is engine-neutral: a "script" run creates phases on demand; finished runs are pruned.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadModule, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as WorkflowModule from "../packages/extensions/third_party/subagent/workflow.ts";
import type * as RunModelModule from "../packages/extensions/third_party/subagent/run-model.ts";
import type { ExecuteOptions, RunState, WorkflowDef } from "../packages/extensions/third_party/subagent/workflow.ts";
import type { RunRegistry, WorkflowEvent } from "../packages/extensions/third_party/subagent/run-model.ts";

const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-workflow-telemetry-");
const restores = [
  isolateKitEnv(),
  setEnv("HOME", path.join(ws, "home")),
  setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
  setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "subagent-state")),
  setEnv("PI_KIT_SUBAGENT_RETRIES", "0"),
];
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const agents = ["scout", "planner", "implementer", "reviewer"].map((name): AgentConfig => ({ name, description: name, systemPrompt: "", source: "kit", filePath: name }));

// A reply: final text, optional per-message token counts (one assistant message each), a model
// name, a failing exit, or a hang (never finishes until killed).
interface Reply {
  text?: string;
  messages?: Array<{ input: number; output: number }>;
  model?: string;
  fail?: boolean;
  hang?: boolean;
}
type Behave = (task: string) => Reply;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: () => boolean;
}
type FakeSpawn = (cmd: string, args: string[]) => FakeChild;
type WorkflowView = Omit<typeof WorkflowModule, "executeWorkflow"> & {
  executeWorkflow(w: WorkflowDef, state: RunState, opts: Omit<ExecuteOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<RunState>;
};

function fakeSpawner(behave: Behave, onSpawn?: () => void): FakeSpawn {
  return () => {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: (): boolean => {
        queueMicrotask(() => child.emit("close", null));
        return true;
      },
    });
    let stdin = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (d: string) => (stdin += d));
    child.stdin.on("end", () => {
      onSpawn?.();
      const reply = behave(stdin.replace(/^Task: /, ""));
      if (reply.hang) return;
      const msgs = reply.messages ?? [{ input: 0, output: 0 }];
      // Each message is written on its own tick so the parent sees them one at a time.
      void (async () => {
        for (const [i, u] of msgs.entries()) {
          const last = i === msgs.length - 1;
          const message = { role: "assistant", model: reply.model, content: [{ type: "text", text: last ? (reply.text ?? "ok") : "working" }], usage: { input: u.input, output: u.output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: last ? (reply.fail ? "error" : "stop") : "toolUse", errorMessage: last && reply.fail ? "boom" : undefined };
          child.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
          await new Promise((r) => setTimeout(r, 5));
        }
        child.emit("close", reply.fail ? 1 : 0);
      })();
    });
    return child;
  };
}

const wf = (yaml: string): string => `---\n${yaml.trim()}\n---\n\nbody\n`;

try {
  const W = await loadModule<WorkflowView>("vendor/subagent/workflow.ts");
  const RM = await loadModule<typeof RunModelModule>("vendor/subagent/run-model.ts");
  const keepalive = setInterval(() => {}, 1000);
  // A clock that moves 10 ms per reading keeps elapsed times positive and deterministic in sign.
  let tick = 1_000_000;
  const clock = (): number => (tick += 10);

  const run = async (def: string, behave: Behave, extra: { registry?: RunRegistry; state?: RunState; signal?: AbortSignal; onSpawn?: () => void } = {}) => {
    const registry = extra.registry ?? new RM.RunRegistry(clock);
    const events: WorkflowEvent[] = [];
    const off = registry.subscribe((e) => events.push(e));
    const { workflow } = W.parseWorkflow(wf(def), path.join(ws, "w.md"), "user");
    assert.ok(workflow, "the definition parses");
    const state = extra.state ?? W.newRunState(workflow, {});
    // "user" launches (a typed /workflow) are bounded by platform ceilings, not the effort tier's
    // per-request scout count, so the many fake runs here are not refused.
    const final = await W.executeWorkflow(workflow, state, { cwd: ws, agents, spawnChild: fakeSpawner(behave, extra.onSpawn), signal: extra.signal, registry, launchKind: "user" });
    off();
    const snap = registry.get(final.id);
    assert.ok(snap, "the run is in the registry");
    return { final, events, snap, registry, workflow };
  };

  // 1-3. Sequential, parallel and skipped steps.
  {
    const { final, events, snap } = await run(
      `
name: tele
steps:
  - id: scan
    agent: scout
    model: test/fast
    task: "scan it"
  - id: fan
    parallel:
      - { id: one, agent: scout, task: "angle one" }
      - { id: two, agent: planner, task: "angle two" }
  - id: maybe
    agent: reviewer
    task: "only on failure"
    when: { step: scan, status: failed }
  - id: plan
    agent: planner
    task: "plan"
`,
      (task) => (task === "scan it" ? { text: "found", model: "test/fast", messages: [{ input: 100, output: 20 }, { input: 150, output: 30 }] } : { text: "done", model: "test/default", messages: [{ input: 10, output: 5 }] }),
    );
    assert.equal(final.status, "passed");
    assert.equal(snap.kind, "yaml");
    assert.equal(snap.name, "tele");
    assert.equal(snap.status, "passed");
    assert.deepEqual(snap.phases.map((p) => [p.id, p.status]), [["scan", "passed"], ["fan", "passed"], ["maybe", "skipped"], ["plan", "passed"]]);
    // The first events list every phase as pending, in order, before any agent starts.
    assert.equal(events[0]?.type, "run_start");
    const firstAgent = events.findIndex((e) => e.type === "agent");
    const early = events.slice(0, firstAgent).flatMap((e) => (e.type === "phase" ? [`${e.phase.id}:${e.phase.status}`] : []));
    assert.deepEqual(early.slice(0, 4), ["scan:pending", "fan:pending", "maybe:pending", "plan:pending"]);
    const byId = new Map(snap.agents.map((a) => [a.id, a]));
    const scan = byId.get("scan#1");
    assert.ok(scan, "scan ran as one agent");
    assert.equal(scan.phase, "scan");
    assert.equal(scan.role, "scout");
    assert.equal(scan.model, "test/fast");
    assert.equal(scan.status, "passed");
    assert.equal(scan.usage.input, 250);
    assert.equal(scan.usage.output, 50);
    assert.equal(scan.usage.turns, 2);
    assert.ok(scan.elapsedMs > 0, "elapsed is recorded");
    assert.ok(scan.subagentRunId, "the subagent run id links the agent to its log");
    ok("each step execution is an agent with label, phase, role, model, usage, elapsed and status");
    const live = events.filter((e): e is Extract<WorkflowEvent, { type: "agent" }> => e.type === "agent" && e.agent.id === "scan#1" && e.agent.status === "running");
    assert.ok(live.some((e) => e.agent.usage.output === 20), "usage after the first message is reported while the agent runs");
    assert.ok(live.some((e) => typeof e.agent.activity === "string" && e.agent.activity.length > 0), "activity lines arrive while it runs");
    ok("a running agent's usage and activity update live");
    assert.equal(byId.get("one#1")?.phase, "fan");
    assert.equal(byId.get("two#1")?.phase, "fan");
    assert.equal(byId.get("two#1")?.role, "planner");
    assert.deepEqual(snap.phases.find((p) => p.id === "fan")?.agentIds.sort(), ["one#1", "two#1"]);
    const maybe = byId.get("maybe#1");
    assert.equal(maybe?.status, "skipped");
    assert.equal(maybe?.usage.output, 0);
    assert.equal(snap.usage.output, 50 + 5 * 3, "run usage is the sum over its agents");
    assert.equal(snap.usage.input, 250 + 10 * 3);
    assert.equal(events.at(-1)?.type, "run_end");
    ok("parallel members share their group's phase; a `when` skip is a skipped agent; totals add up");
  }

  // 4. Gate loop.
  {
    let reviews = 0;
    const { final, snap } = await run(
      `
name: gated
steps:
  - id: implement
    agent: implementer
    task: "implement"
  - id: review
    agent: reviewer
    task: "review"
    gate: { pass: "VERDICT: PASS", retry: implement, max_loops: 2 }
`,
      (task) => (task === "review" ? { text: ++reviews >= 2 ? "VERDICT: PASS" : "VERDICT: FAIL" } : { text: "built" }),
    );
    assert.equal(final.status, "passed");
    assert.deepEqual(snap.agents.map((a) => `${a.id}:${a.status}`), ["implement#1:passed", "review#1:passed", "implement#2:passed", "review#2:passed"]);
    assert.deepEqual(snap.phases.find((p) => p.id === "review")?.agentIds, ["review#1", "review#2"]);
    assert.equal(snap.phases.find((p) => p.id === "review")?.status, "passed");
    ok("a gate loop records one agent per re-run (label#n) under the same phase");
  }

  // 5. Failure.
  {
    const { final, snap } = await run(
      `
name: failing
steps:
  - id: a
    agent: scout
    task: "a"
  - id: b
    agent: scout
    task: "b"
`,
      () => ({ fail: true }),
    );
    assert.equal(final.status, "failed");
    assert.equal(snap.status, "failed");
    assert.match(snap.error ?? "", /step a failed/);
    assert.equal(snap.agents.length, 1, "nothing runs after the failure");
    assert.equal(snap.agents[0]?.status, "failed");
    assert.ok(snap.agents[0]?.error, "the agent carries the error");
    assert.deepEqual(snap.phases.map((p) => p.status), ["failed", "pending"]);
    ok("a failed step records its error and the run ends failed");
  }

  // 6. Abort: first with a test registry (statuses), then with the process-wide registry that the
  // subagents status snapshot (live.ts) reports from.
  {
    const def = `
name: aborted
steps:
  - id: slow
    agent: scout
    task: "slow"
`;
    const ac = new AbortController();
    const { final, snap } = await run(def, () => ({ hang: true }), { signal: ac.signal, onSpawn: () => setTimeout(() => ac.abort(), 5) });
    assert.equal(final.status, "interrupted");
    assert.equal(snap.status, "interrupted");
    assert.equal(snap.agents[0]?.status, "aborted");
    assert.equal(snap.phases[0]?.status, "aborted");
    ok("an abort marks the running agent aborted and the run interrupted");

    const reg: unknown = Reflect.get(globalThis, Symbol.for("pi-kit.subagents"));
    const workflowsNow = (): unknown => {
      if (typeof reg !== "object" || reg === null) return undefined;
      const fn: unknown = Reflect.get(reg, "snapshot");
      const s: unknown = typeof fn === "function" ? Reflect.apply(fn, reg, []) : undefined;
      return typeof s === "object" && s !== null ? Reflect.get(s, "workflows") : undefined;
    };
    assert.equal(workflowsNow(), 0, "no workflow run is active before the run");
    const ac2 = new AbortController();
    let during: unknown;
    const { workflow } = W.parseWorkflow(wf(def), path.join(ws, "w.md"), "user");
    assert.ok(workflow);
    const spawn = fakeSpawner(() => ({ hang: true }), () => {
      during = workflowsNow();
      setTimeout(() => ac2.abort(), 5);
    });
    const final2 = await W.executeWorkflow(workflow, W.newRunState(workflow, {}), { cwd: ws, agents, spawnChild: spawn, signal: ac2.signal, launchKind: "user" });
    assert.equal(final2.status, "interrupted");
    assert.equal(during, 1, "the status snapshot counts the live workflow run");
    assert.equal(workflowsNow(), 0, "and drops it when the run ends");
    ok("the subagents status snapshot counts active workflow runs");
  }

  // 7. Listener isolation.
  {
    const registry = new RM.RunRegistry(clock);
    registry.subscribe(() => {
      throw new Error("bad listener");
    });
    let seen = 0;
    const off = registry.subscribe(() => seen++);
    const { final } = await run(
      `
name: listeners
steps:
  - id: a
    agent: scout
    task: "a"
`,
      () => ({ text: "fine" }),
      { registry },
    );
    assert.equal(final.status, "passed");
    assert.ok(seen > 0);
    off();
    const before = seen;
    registry.start("other", "script", "x").finish("passed");
    assert.equal(seen, before, "unsubscribed listeners get nothing");
    ok("a throwing listener cannot break a run; unsubscribe stops delivery");
  }

  // 8. Resume.
  {
    const registry = new RM.RunRegistry(clock);
    const def = `
name: resumable
steps:
  - id: a
    agent: scout
    task: "a"
  - id: b
    agent: scout
    task: "b"
`;
    const first = await run(def, (task) => (task === "b" ? { fail: true } : { text: "A" }), { registry });
    assert.equal(first.final.status, "failed");
    const state = W.loadState(ws, first.final.id);
    assert.ok(state, "the failed run's state was saved");
    state.cursor = 1;
    const second = await run(def, () => ({ text: "B" }), { registry, state });
    assert.equal(second.final.id, first.final.id);
    assert.equal(second.snap.status, "passed");
    assert.deepEqual(second.snap.agents.map((a) => a.id), ["b#1"], "the resumed model holds only this execution's agents");
    const phaseEvents = second.events.flatMap((e) => (e.type === "phase" ? [`${e.phase.id}:${e.phase.status}`] : []));
    assert.equal(phaseEvents[0], "a:passed", "a finished phase is seeded with its saved status");
    assert.equal(registry.list().filter((r) => r.id === first.final.id).length, 1);
    ok("a resumed run reuses its id and seeds phases from the saved state");
  }

  // 9. Engine-neutral model and retention.
  {
    let t = 0;
    const registry = new RM.RunRegistry(() => (t += 1));
    const r = registry.start("script-1", "script", "sweep");
    const a = r.agentStart({ label: "explore", phase: "Discovery", model: "test/m" });
    r.agentUpdate(a, { usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 1 } });
    r.agentEnd(a, { status: "passed" });
    const b = r.agentStart({ label: "explore", phase: "Discovery" });
    assert.equal(b, "explore#2");
    assert.equal(registry.activeCount(), 1);
    r.finish("failed", "budget");
    const s = registry.get("script-1");
    assert.ok(s);
    assert.deepEqual(s.phases.map((p) => p.title), ["Discovery"]);
    assert.equal(s.agents[0]?.usage.cost, 0.5, "usage kept when the end carries none");
    assert.equal(s.agents[1]?.status, "aborted", "an agent still running when the run ends is aborted");
    assert.equal(registry.activeCount(), 0);
    for (let i = 0; i < RM.MAX_FINISHED_RUNS + 5; i++) registry.start(`old-${i}`, "script", "x").finish("passed");
    const live = registry.start("live", "yaml", "y");
    assert.equal(registry.list().length, RM.MAX_FINISHED_RUNS + 1, "finished runs are capped; active runs are kept");
    assert.ok(registry.get("live"));
    live.finish("passed");
    ok("a script-kind run creates phases on demand; finished runs are pruned to the cap");
  }

  clearInterval(keepalive);
  // Telemetry never touches disk beyond the executor's own files.
  assert.ok(!fs.existsSync(path.join(ws, "home", ".pi")), "nothing was written under the temp HOME's .pi");
  console.log(`[workflow-telemetry-smoke] all ${checks} checks passed`);
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
