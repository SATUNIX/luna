import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv, textOf, type FakeToolResult, type Steer } from "../packages/core/eval/harness.ts";
import { array, boolean, object, optional, parseJsonAs, record, string } from "../packages/core/lib/guard.ts";

interface TestCtx {
  cwd: string;
  ui: { notify(): void; setStatus(): void };
}
type Handler = (event: unknown, ctx: TestCtx) => unknown;
/** .pi/verdicts.json. */
const VerdictBoard = object({ verdicts: record(object({ pass: boolean(), summary: string(), at: string() })) });
/** .pi/task-graph.json. */
const TaskBoard = object({ tasks: array(object({ id: string(), status: string(), notes: optional(string()) })) });
type ToolResult = FakeToolResult;
/** A custom message the extensions send with sendMessage (text content). */
const CustomSteer = object({ customType: string(), content: string() });

/** The only steer sent so far, as a custom text message. */
function onlySteer(steers: Steer[]) {
  const [steer] = steers;
  assert.ok(steer, "a steer was sent");
  return CustomSteer.parse(steer.message);
}

const restoreIsolation = isolateKitEnv();
const restore = setEnv("PI_KIT_VERIFY_ON_TURN", "1");
const restoreDisable = setEnv("PI_KIT_ORCH_DISABLE", undefined);
const restoreCommand = setEnv("PI_KIT_VERIFY_CMD", undefined);
const final = { message: { role: "assistant", stopReason: "stop" } };
try {
  for (const order of [["orchestrator", "verify-gate"], ["verify-gate", "orchestrator"]]) {
    for (const exitCode of [0, 1]) {
      const ws = tmpWorkspace("pi-lifecycle-order-");
      try {
        const pi = fakePi();
        const handlers = new Map<string, Handler[]>();
        pi.api.on = (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        const emit = async (name: string, event: unknown) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
        const ctx: TestCtx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
        for (const name of order) (await loadExtension(`extensions/${name}/index.ts`))(pi.api);
        await emit("session_start", {});
        fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { verify: `node -e "process.exit(${exitCode})"` } }));
        // .pi used to exist as a side effect of the orchestrator copying roles into .pi/agents.
        fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), JSON.stringify({ verdicts: { verify: { pass: false, summary: "OLD FAILURE", at: new Date().toISOString() } } }));
        await emit("input", { source: "interactive", text: "Fix the typo." });
        await emit("tool_result", { toolName: "edit", isError: false });
        await emit("turn_end", final);
        const board = parseJsonAs(VerdictBoard, fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"));
        assert.ok(board.verdicts.verify, "the board has a verify verdict");
        assert.equal(board.verdicts.verify.pass, exitCode === 0);
        assert.equal(pi.steers.length, exitCode === 0 ? 0 : 1, `${order.join(",")}: correction reflects current verification only`);
        if (exitCode) assert.equal(onlySteer(pi.steers).customType, "verify-gate-result");
        await emit("turn_end", final);
        assert.equal(pi.steers.length, exitCode === 0 ? 0 : 1, "no duplicate board diagnostic on follow-up");
      } finally { rmWorkspace(ws); }
    }

    // Deferring verify-owned results must not hide a non-verify failure (reviewer verdict).
    const ws = tmpWorkspace("pi-lifecycle-review-");
    try {
      const pi = fakePi();
      const handlers = new Map<string, Handler[]>();
      pi.api.on = (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      const emit = async (name: string, event: unknown) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
      const ctx: TestCtx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
      for (const name of order) (await loadExtension(`extensions/${name}/index.ts`))(pi.api);
      await emit("session_start", {});
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { verify: `node -e "process.exit(0)"` } }));
      fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), JSON.stringify({ verdicts: {
        verify: { pass: false, summary: "OLD FAILURE", at: new Date().toISOString() },
        review: { pass: false, summary: "REVIEW REJECTED", at: new Date().toISOString() },
      } }));
      await emit("input", { source: "interactive", text: "Review the entire system then implement the fix across a.ts and b.ts." });
      await emit("tool_result", { toolName: "edit", isError: false });
      await emit("turn_end", final);
      assert.equal(pi.steers.length, 1, `${order.join(",")}: reviewer failure still produces one diagnostic`);
      const steer = onlySteer(pi.steers);
      assert.equal(steer.customType, "orchestrator-verification");
      assert.match(steer.content, /REVIEW REJECTED/);
      assert.doesNotMatch(steer.content, /OLD FAILURE/, `${order.join(",")}: stale verify result is never reported`);
    } finally { rmWorkspace(ws); }
  }

  const ws = tmpWorkspace("pi-readonly-intent-");
  try {
    const pi = fakePi();
    (await loadExtension("extensions/orchestrator/index.ts"))(pi.api);
    const ctx: TestCtx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    for (const text of [
      "Produce a comprehensive plan for the entire system architecture.",
      "Review the entire system and carefully assess a.ts and b.ts.",
      "Can you investigate the entire pipeline and produce a thorough implementation plan?",
      "Build a detailed plan without making any changes across the entire system.",
    ]) {
      await pi.handlers.get("input")({ source: "interactive", text }, ctx);
      await pi.handlers.get("turn_end")(final, ctx);
      assert.equal(pi.steers.length, 0, "read-only intent does not require a board");
      assert.ok(!fs.existsSync(path.join(ws, ".pi", "ctx-contributions", "orchestrator.json")), "read-only intent never receives implementer flow");
    }
    await pi.handlers.get("input")({ source: "interactive", text: "Review the entire system then implement the fix across a.ts and b.ts." }, ctx);
    await pi.handlers.get("turn_end")(final, ctx);
    assert.equal(pi.steers.length, 1, "explicit implementation still activates workflow");
  } finally { rmWorkspace(ws); }

  const graphWs = tmpWorkspace("pi-task-update-deps-");
  try {
    const pi = fakePi();
    (await loadExtension("extensions/task-graph/index.ts"))(pi.api);
    const call = (name: string, params: Record<string, unknown>): Promise<ToolResult> => pi.tools.get(name).execute("case", params, undefined, undefined, { cwd: graphWs });
    await call("task_create", { title: "prerequisite" });
    await call("task_create", { title: "dependent", depends_on: ["t1"] });
    assert.match(textOf(await call("task_update", { id: "t2", status: "done", notes: "must not persist" })), /Cannot complete.*unfinished dependencies/);
    const board = parseJsonAs(TaskBoard, fs.readFileSync(path.join(graphWs, ".pi", "task-graph.json"), "utf8"));
    const dependent = board.tasks[1];
    assert.ok(dependent, "the dependent task is on the board");
    assert.equal(dependent.status, "pending");
    assert.equal(dependent.notes, undefined);
    await call("task_update", { id: "t1", status: "done" });
    assert.match(textOf(await call("task_update", { id: "t2", status: "done" })), /Updated t2: done/);
  } finally { rmWorkspace(graphWs); }
  console.log("PASS lifecycle containment: both verifier orders, actual results, readonly intent, dependency update");
} finally { restore(); restoreDisable(); restoreCommand(); restoreIsolation(); }
