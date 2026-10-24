#!/usr/bin/env node
// Offline workflow run-control checks (control.ts, wired into the YAML executor and the
// workflow_control tool). The "child" is an in-process fake, as in workflow-telemetry-smoke.ts.
//   1. the control API: unknown actions and runs are refused; pause/resume are idempotent; the
//      gate holds while paused and opens on resume or stop.
//   2. a paused run launches no new agents (the running one finishes); state.json and the run
//      model show `paused`; resume launches the next step and the run passes.
//   3. stop while paused ends the run interrupted without launching the waiting step, which stays
//      pending (so a resume does not treat it as interrupted).
//   4. skip stops the running agent(s), records them skipped (a single step and a whole parallel
//      group) and the run goes on; skip with nothing running is refused.
//   4b. skip never passes a review gate: a skipped gate step, or a skipped member of a gated group,
//      fails the gate (retry loop, or the run ends failed), and so does "Skip" on resume.
//   5. stop while an agent runs aborts it; the run ends interrupted.
//   6. the workflow_control tool drives a live run through the same API; /workflow pause, skip,
//      resume and stop do too. A pause held by the console's safety stop refuses the tool's resume
//      and yields to /workflow resume.
//   7. resuming a run whose writer step was interrupted asks a No-first select (never confirm);
//      headless is refused; "No" and Esc cancel; "Skip" marks it skipped and goes on; "Re-run"
//      keeps it; read-only steps and steps that never launched ask nothing.
//   8. both firewall policy copies allow workflow_control as process_control and stay identical.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fakePi, loadModule, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv, textOf, ROOT, type FakePiApi } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as IndexModule from "../packages/extensions/third_party/subagent/index.ts";
import type * as WorkflowToolsModule from "../packages/extensions/third_party/subagent/workflow-tools.ts";
import type * as ControlModule from "../packages/extensions/third_party/subagent/control.ts";
import type * as RunModelModule from "../packages/extensions/third_party/subagent/run-model.ts";
import type { ExecuteOptions, RunState, WorkflowDef } from "../packages/extensions/third_party/subagent/workflow.ts";
import type { WorkflowEvent } from "../packages/extensions/third_party/subagent/run-model.ts";

const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-workflow-control-");
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

const agents = ["scout", "planner", "implementer", "reviewer"].map((name): AgentConfig => ({ name, description: name, systemPrompt: "", source: "kit", filePath: name, ...(name === "planner" ? { tools: ["read", "grep", "find", "ls"] } : {}) }));

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: () => boolean;
}
type FakeSpawn = (cmd: string, args: string[]) => FakeChild;
// The reply for a task: its final text, or a hang until killed. `delayMs` holds the answer back.
type Behave = (task: string) => { text?: string; hang?: boolean; delayMs?: number };

function fakeSpawner(behave: Behave, onSpawn: (task: string) => void = () => {}): FakeSpawn {
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
      const task = stdin.replace(/^Task: /, "");
      onSpawn(task);
      const reply = behave(task);
      if (reply.hang) return;
      setTimeout(() => {
        const message = { role: "assistant", content: [{ type: "text", text: reply.text ?? "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop" };
        child.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
        child.emit("close", 0);
      }, reply.delayMs ?? 5);
    });
    return child;
  };
}

type IndexView = Omit<typeof IndexModule, "executeWorkflow" | "default"> & {
  default: (api: FakePiApi) => void;
  executeWorkflow(w: WorkflowDef, state: RunState, opts: Omit<ExecuteOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<RunState>;
};

const wf = (yaml: string): string => `---\n${yaml.trim()}\n---\n\nbody\n`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

try {
  // index.ts and the modules it imports share one control registry (runControls).
  const I = await loadModule<IndexView>("vendor/subagent/index.ts");
  const C = await loadModule<typeof ControlModule>("vendor/subagent/control.ts");
  const RM = await loadModule<typeof RunModelModule>("vendor/subagent/run-model.ts");
  const T = await loadModule<typeof WorkflowToolsModule>("vendor/subagent/workflow-tools.ts");
  const keepalive = setInterval(() => {}, 1000);

  const parse = (def: string): WorkflowDef => {
    const { workflow, errors } = I.parseWorkflow(wf(def), path.join(ws, "w.md"), "user");
    assert.ok(workflow, errors.join("; "));
    return workflow;
  };
  const stateFile = (id: string): string => path.join(ws, ".pi", "workflows", "runs", id, "state.json");
  const savedPaused = (id: string): unknown => {
    const raw: unknown = JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
    return typeof raw === "object" && raw !== null ? Reflect.get(raw, "paused") : undefined;
  };

  // Start a run under a control opened in the shared registry; returns the handles a test drives.
  const launch = (def: string, behave: Behave, onSpawn?: (task: string) => void, state?: RunState) => {
    const workflow = parse(def);
    const st = state ?? I.newRunState(workflow, {});
    const registry = new RM.RunRegistry();
    const events: WorkflowEvent[] = [];
    registry.subscribe((e) => events.push(e));
    const { control, close } = I.runControls.open(st.id);
    const done = I.executeWorkflow(workflow, st, { cwd: ws, agents, spawnChild: fakeSpawner(behave, onSpawn), registry, control, launchKind: "user" }).finally(close);
    return { workflow, state: st, control, done, registry, events };
  };

  // 1. The control API on its own.
  {
    const reg = new C.ControlRegistry();
    assert.match(C.controlRun("nope", "pause", reg).message, /No live run "nope"/);
    assert.equal(C.controlRun("nope", "pause", reg).ok, false);
    assert.match(C.controlRun("nope", "resume", reg).message, /workflow_run \{resume/, "a resume of a run that is not live points at workflow_run resume");
    const { control, close } = reg.open("r1");
    assert.equal(C.controlRun("r1", "explode", reg).ok, false, "unknown actions are refused");
    assert.equal(C.controlRun("r1", "resume", reg).message, "Run r1 is not paused.");
    let opened = false;
    assert.equal(C.controlRun("r1", "pause", reg).ok, true);
    assert.equal(C.controlRun("r1", "pause", reg).message, "Run r1 is already paused.");
    void control.gate().then(() => (opened = true));
    await sleep(20);
    assert.equal(opened, false, "the gate holds while paused");
    C.controlRun("r1", "resume", reg);
    await sleep(0);
    assert.equal(opened, true, "resume opens the gate");
    assert.equal(C.controlRun("r1", "skip", reg).ok, false, "skip with nothing running is refused");
    C.controlRun("r1", "pause", reg);
    let opened2 = false;
    void control.gate().then(() => (opened2 = true));
    C.controlRun("r1", "stop", reg);
    await sleep(0);
    assert.equal(opened2, true, "stop opens the gate too");
    assert.equal(control.signal.aborted, true);
    assert.match(C.controlRun("r1", "resume", reg).message, /already stopping/);
    close();
    assert.equal(reg.has("r1"), false);
    const parent = new AbortController();
    const linked = reg.open("r2", parent.signal);
    parent.abort();
    assert.equal(linked.control.stopped, true, "a parent signal stops the run");
    linked.close();
    ok("control API: refusals, idempotent pause/resume, the gate, stop, parent signal");
  }

  // 2. Pause: no new agents while paused; resume continues.
  {
    const spawned: string[] = [];
    const box: { control?: ControlModule.RunControl } = {};
    const h = launch(
      `
name: paused
steps:
  - id: a
    agent: scout
    task: "step a"
  - id: b
    agent: scout
    task: "step b"
`,
      () => ({ text: "done", delayMs: 30 }),
      (task) => {
        spawned.push(task);
        if (task.startsWith("step a")) box.control?.act("pause");
      },
    );
    box.control = h.control;
    await until(() => h.state.steps.a?.status === "passed", "step a to finish");
    await sleep(60);
    assert.deepEqual(spawned.map((t) => t.slice(0, 6)), ["step a"], "a paused run launches no new agent (a, already running, finished)");
    assert.equal(savedPaused(h.state.id), true, "state.json records paused");
    assert.equal(h.registry.get(h.state.id)?.paused, true, "the run model shows paused");
    assert.ok(h.events.some((e) => e.type === "control" && e.paused), "a control event is emitted");
    assert.equal(I.controlRun(h.state.id, "resume").ok, true);
    const final = await h.done;
    assert.equal(final.status, "passed");
    assert.deepEqual(spawned.map((t) => t.slice(0, 6)), ["step a", "step b"]);
    assert.equal(savedPaused(h.state.id), undefined, "paused is cleared");
    assert.equal(h.registry.get(h.state.id)?.paused, false);
    assert.equal(I.runControls.has(h.state.id), false, "the control closes with the run");
    ok("a paused run launches no new agents; resume continues; state.json and the run model follow");
  }

  // 3. Stop while paused.
  {
    const spawned: string[] = [];
    const box: { control?: ControlModule.RunControl } = {};
    const h = launch(
      `
name: stoppaused
steps:
  - id: a
    agent: scout
    task: "step a"
  - id: b
    agent: implementer
    task: "step b"
`,
      () => ({ text: "done", delayMs: 10 }),
      (task) => {
        spawned.push(task);
        box.control?.act("pause");
      },
    );
    box.control = h.control;
    await until(() => h.state.steps.a?.status === "passed", "step a");
    await sleep(20);
    I.controlRun(h.state.id, "stop");
    const final = await h.done;
    assert.equal(final.status, "interrupted");
    assert.equal(spawned.length, 1, "the waiting step never launched");
    assert.equal(final.steps.b, undefined, "and has no state, so a resume does not count it as interrupted");
    assert.equal(savedPaused(final.id), undefined);
    assert.deepEqual(T.interruptedWriterSteps(h.workflow, final, agents), []);
    ok("stop while paused ends the run interrupted without launching the waiting step");
  }

  // 4. Skip: a single step, then a parallel group.
  {
    const spawned: string[] = [];
    const h = launch(
      `
name: skipping
steps:
  - id: a
    agent: scout
    task: "step a"
  - id: fan
    parallel:
      - id: p1
        agent: scout
        task: "p1"
      - id: p2
        agent: scout
        task: "p2"
  - id: c
    agent: scout
    task: "step c {{steps.a.status}}"
`,
      (task) => (task.startsWith("step c") ? { text: "C" } : { hang: true }),
      (task) => spawned.push(task),
    );
    await until(() => spawned.length === 1, "a to launch");
    const r = I.controlRun(h.state.id, "skip");
    assert.equal(r.ok, true);
    assert.match(r.message, /Skipping a/);
    await until(() => spawned.length === 3, "the group to launch");
    await sleep(10);
    const r2 = I.controlRun(h.state.id, "skip");
    assert.match(r2.message, /p1, p2|p2, p1/, "skip covers every running member");
    const final = await h.done;
    assert.equal(final.status, "passed");
    assert.equal(final.steps.a?.status, "skipped");
    assert.equal(final.steps.p1?.status, "skipped");
    assert.equal(final.steps.p2?.status, "skipped");
    assert.equal(final.steps.fan?.status, "passed", "a group of skipped members passes");
    assert.ok(spawned.some((t) => t.startsWith("step c skipped")), "later steps see the skipped status");
    const snap = h.registry.get(h.state.id);
    assert.deepEqual(snap?.agents.map((a) => `${a.id}:${a.status}`), ["a#1:skipped", "p1#1:skipped", "p2#1:skipped", "c#1:passed"]);
    assert.equal(snap?.phases[0]?.status, "skipped");
    ok("skip stops the running agents, records them skipped, and the run goes on");
  }

  // 4b. Skip and review gates: a skipped verdict fails the gate instead of passing it.
  {
    // A live skip of the gate step takes the gate's retry path; the second verdict passes.
    const spawned: string[] = [];
    const h = launch(
      `
name: gated
steps:
  - id: implement
    agent: implementer
    task: "implement"
  - id: review
    agent: reviewer
    task: "review"
    gate: { pass: APPROVED, retry: implement, max_loops: 1 }
`,
      (task) => (task.startsWith("review") && spawned.filter((t) => t.startsWith("review")).length === 1 ? { hang: true } : { text: "APPROVED" }),
      (task) => spawned.push(task),
    );
    await until(() => spawned.length === 2, "review to launch");
    assert.equal(I.controlRun(h.state.id, "skip").ok, true);
    const final = await h.done;
    assert.equal(final.status, "passed");
    assert.deepEqual(spawned, ["implement", "review", "implement", "review"], "the skipped review loops back to implement");
    assert.equal(final.loops.review, 1);

    // With no loops left, a skipped gate step ends the run failed.
    let launchedReview = false;
    const h2 = launch(
      `
name: gatednoretry
steps:
  - id: review
    agent: reviewer
    task: "review"
    gate: { pass: APPROVED }
  - id: after
    agent: scout
    task: "after"
`,
      (task) => (task.startsWith("review") ? { hang: true } : { text: "x" }),
      (task) => (launchedReview ||= task.startsWith("review")),
    );
    await until(() => launchedReview, "review to launch");
    I.controlRun(h2.state.id, "skip");
    const final2 = await h2.done;
    assert.equal(final2.status, "failed");
    assert.match(final2.error ?? "", /gate review was skipped before its verdict/);
    assert.equal(final2.steps.after, undefined, "the step after the gate never runs");

    // A skipped member of a gated group fails the group's gate, even when the others approve.
    const members: string[] = [];
    const h3 = launch(
      `
name: gatedgroup
steps:
  - id: reviews
    parallel:
      - id: r1
        agent: reviewer
        task: "r1"
      - id: r2
        agent: reviewer
        task: "r2"
    gate: { pass: APPROVED }
`,
      (task) => (task.startsWith("r2") ? { hang: true } : { text: "APPROVED" }),
      (task) => members.push(task),
    );
    await until(() => members.length === 2 && h3.state.steps.r1?.status === "passed", "r1 to approve and r2 to run");
    assert.match(I.controlRun(h3.state.id, "skip").message, /Skipping r2/);
    const final3 = await h3.done;
    assert.equal(final3.status, "failed");
    assert.match(final3.error ?? "", /gate reviews was skipped before its verdict/);

    // "Skip" on resume keeps an interrupted gate step at the cursor, and the executor fails its gate.
    const gatedDef = `
name: gatedresume
steps:
  - id: review
    agent: reviewer
    task: "review"
    gate: { pass: APPROVED }
`;
    const gd = parse(gatedDef);
    const gs = I.newRunState(gd, {});
    gs.status = "interrupted";
    gs.steps.review = { status: "aborted", attempts: 1, runIds: [], cost: 0 };
    const selectSkip = { cwd: ws, hasUI: true, ui: { select: () => Promise.resolve("Skip the interrupted step(s)"), setStatus: () => {} } };
    assert.equal(await T.resumeWriterGate(gd, gs, agents, selectSkip), null);
    assert.equal(gs.cursor, 0, "a skipped gate step is not stepped past");
    gs.status = "running";
    let relaunched = false;
    const h4 = launch(gatedDef, () => ({ text: "APPROVED" }), () => (relaunched = true), gs);
    const final4 = await h4.done;
    assert.equal(relaunched, false, "the skipped gate step is not re-run");
    assert.equal(final4.status, "failed");
    assert.match(final4.error ?? "", /gate review was skipped before its verdict/);
    ok("skip never passes a review gate (live, in a gated group, or on resume)");
  }

  // 5. Stop while an agent runs.
  {
    let launched = false;
    const h = launch(
      `
name: stopping
steps:
  - id: a
    agent: implementer
    task: "step a"
`,
      () => ({ hang: true }),
      () => (launched = true),
    );
    await until(() => launched, "a to launch");
    assert.match(I.controlRun(h.state.id, "stop").message, /can be resumed/);
    const final = await h.done;
    assert.equal(final.status, "interrupted");
    assert.equal(final.steps.a?.status, "aborted");
    ok("stop aborts the running agent and the run ends interrupted");
  }

  // 6. The workflow_control tool and the /workflow command drive the same API.
  {
    const pi = fakePi();
    I.default(pi.api);
    const tool = pi.tools.get("workflow_control");
    assert.ok(tool, "workflow_control is registered");
    const unknown = await tool.execute("1", { runId: "missing", action: "pause" }, undefined, undefined, { cwd: ws });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /No live run "missing"/);
    let launched = false;
    const h = launch(
      `
name: viatool
steps:
  - id: a
    agent: scout
    task: "step a"
  - id: b
    agent: scout
    task: "step b"
`,
      (task) => (task.startsWith("step a") ? { hang: true } : { text: "B" }),
      () => (launched = true),
    );
    await until(() => launched, "a to launch");
    const paused = await tool.execute("2", { runId: h.state.id, action: "pause" }, undefined, undefined, { cwd: ws });
    assert.match(textOf(paused), /Paused .*Still running: a/);
    assert.equal(h.control.paused, true);
    const status = await pi.tools.get("workflow_status").execute("s", {}, undefined, undefined, { cwd: ws });
    assert.match(textOf(status), new RegExp(`${h.state.id}: running \\(active, paused\\)`), "workflow_status shows a paused live run");
    const notes: string[] = [];
    const cmdCtx = { cwd: ws, hasUI: true, ui: { notify: (m: string) => notes.push(m), setStatus: () => {} } };
    const command = pi.commands.get("workflow");
    await command.handler(`resume ${h.state.id}`, cmdCtx);
    assert.equal(h.control.paused, false, "/workflow resume unpauses a live run");
    await command.handler(`pause ${h.state.id}`, cmdCtx);
    assert.equal(h.control.paused, true, "/workflow pause");
    // A pause the console's safety stop sets is held for the operator: the agent's tool cannot lift it.
    assert.equal(I.controlRun(h.state.id, "pause", I.runControls, "safety").ok, true);
    assert.equal(h.control.held, true, "the safety stop's pause is held");
    const refused = await tool.execute("2b", { runId: h.state.id, action: "resume" }, undefined, undefined, { cwd: ws });
    assert.equal(refused.isError, true, "workflow_control resume is refused while the pause is held");
    assert.match(textOf(refused), /paused by the operator's safety stop .*only the operator can resume it, with \/workflow resume/);
    assert.equal(h.control.paused, true, "the held run stays paused");
    await command.handler(`resume ${h.state.id}`, cmdCtx);
    assert.equal(h.control.paused, false, "/workflow resume lifts a held pause");
    assert.equal(h.control.held, false);
    await command.handler(`pause ${h.state.id}`, cmdCtx);
    assert.equal(h.control.held, false, "an operator pause is not held");
    await command.handler(`skip ${h.state.id}`, cmdCtx);
    assert.match(notes.at(-1) ?? "", /Skipping a/, "/workflow skip");
    await until(() => h.state.steps.a?.status === "skipped", "a to be skipped");
    await tool.execute("3", { runId: h.state.id, action: "resume" }, undefined, undefined, { cwd: ws });
    const final = await h.done;
    assert.equal(final.status, "passed");
    await command.handler(`stop ${h.state.id}`, cmdCtx);
    assert.match(notes.at(-1) ?? "", /No live run/, "a finished run can no longer be controlled");
    ok("workflow_control and /workflow pause|resume|skip|stop use the same control API; a safety-stop pause yields only to the operator");

    // 7. Resuming an interrupted writer step asks a No-first select.
    const userDir = path.join(ws, "agent", "workflows");
    fs.mkdirSync(userDir, { recursive: true });
    const writerDef = `
name: writer
steps:
  - id: edit
    agent: implementer
    task: "edit it"
`;
    fs.writeFileSync(path.join(userDir, "writer.md"), wf(writerDef));
    const def = parse(writerDef);
    const writeInterrupted = (): RunState => {
      const s = I.newRunState(def, {});
      s.status = "interrupted";
      s.steps.edit = { status: "aborted", attempts: 1, runIds: [], cost: 0, startedAt: new Date().toISOString() };
      fs.mkdirSync(path.dirname(stateFile(s.id)), { recursive: true });
      fs.writeFileSync(stateFile(s.id), JSON.stringify(s));
      return s;
    };
    const run = pi.tools.get("workflow_run");
    const s1 = writeInterrupted();
    const headless = await run.execute("r1", { name: "writer", resume: s1.id }, undefined, undefined, { cwd: ws, hasUI: false });
    assert.equal(headless.isError, true);
    assert.match(textOf(headless), /Blocked: .*writer step\(s\) edit/, "a headless resume of an interrupted writer is refused");
    const prompts: string[][] = [];
    const ui = (answer: string | undefined) => ({
      cwd: ws,
      hasUI: true,
      ui: {
        select: (_title: string, options: string[]) => {
          prompts.push(options);
          return Promise.resolve(answer);
        },
        confirm: () => Promise.reject(new Error("confirm must not be used: it defaults to Yes")),
        setStatus: () => {},
      },
    });
    for (const answer of ["No, leave the run interrupted", undefined]) {
      const r = await run.execute("r2", { name: "writer", resume: s1.id }, undefined, undefined, ui(answer));
      assert.equal(r.isError, true);
      assert.match(textOf(r), /Cancelled: run .* stays interrupted/, `answer ${String(answer)} cancels`);
    }
    assert.deepEqual(prompts[0], ["No, leave the run interrupted", "Re-run the interrupted step(s)", "Skip the interrupted step(s)"], "No is the first (default) option");
    assert.deepEqual([...T.RESUME_WRITER_CHOICES], prompts[0]);
    const skipped = await run.execute("r3", { name: "writer", resume: s1.id }, undefined, undefined, ui("Skip the interrupted step(s)"));
    assert.match(textOf(skipped), /passed/, "Skip marks the step skipped and the run goes on (here: to the end, nothing launched)");
    const after = I.loadState(ws, s1.id);
    assert.equal(after?.steps.edit?.status, "skipped");
    assert.equal(after?.status, "passed");

    // Re-run keeps the step as it was (the executor then re-runs it).
    const s2 = writeInterrupted();
    assert.equal(await T.resumeWriterGate(def, s2, agents, ui("Re-run the interrupted step(s)")), null);
    assert.equal(s2.steps.edit?.status, "aborted");
    assert.equal(s2.cursor, 0);
    // No prompt for read-only roles, read-only tool lists, or a step that never launched.
    const ro = parse(`
name: ro
steps:
  - id: plan
    agent: planner
    task: "p"
  - id: look
    agent: implementer
    tools: [read, ls]
    task: "l"
`);
    const sr = I.newRunState(ro, {});
    sr.steps.plan = { status: "aborted", attempts: 1, runIds: [], cost: 0 };
    assert.deepEqual(T.interruptedWriterSteps(ro, sr, agents), [], "a planner (read-only tools) is not a writer");
    sr.cursor = 1;
    sr.steps.look = { status: "running", attempts: 1, runIds: [], cost: 0 };
    assert.deepEqual(T.interruptedWriterSteps(ro, sr, agents), [], "a step limited to read-only tools is not a writer");
    assert.equal(T.isWriterStep({ id: "x", agent: "scout" }, agents), true, "a role with bash (or no tool list) is a writer");
    const pending = writeInterrupted();
    const pendingStep = pending.steps.edit;
    assert.ok(pendingStep);
    pendingStep.status = "pending";
    assert.deepEqual(T.interruptedWriterSteps(def, pending, agents), [], "a step that never launched is not interrupted");
    ok("resuming an interrupted writer step asks a No-first select; headless is refused");
  }

  // 8. Both firewall policy copies.
  {
    const a = fs.readFileSync(path.join(ROOT, "packages/extensions/src/tool-firewall/default-policy.json"), "utf8");
    const b = fs.readFileSync(path.join(ROOT, "packages/core/policies/default.json"), "utf8");
    assert.equal(a, b, "the two policy copies are byte-identical");
    const policy: unknown = JSON.parse(a);
    const tools: unknown = typeof policy === "object" && policy !== null ? Reflect.get(policy, "tools") : undefined;
    const rule: unknown = typeof tools === "object" && tools !== null ? Reflect.get(tools, "workflow_control") : undefined;
    assert.deepEqual(rule, { decision: "allow", risk_class: "process_control" });
    ok("both firewall policies allow workflow_control as process_control");
  }

  clearInterval(keepalive);
  console.log(`[workflow-control-smoke] ${checks} checks passed`);
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
