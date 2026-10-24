#!/usr/bin/env node
// Offline checks for the /workflows panel (wf-panel.ts, E5 slice G5).
//   1. formatting: elapsed times and token counts.
//   2. render snapshot: a run view (header with name, description, done/total agents, elapsed;
//      Phases done/total; Agents with label, model, tokens, elapsed, status dot; narrator lines;
//      footer keys) and the run list, line for line, with a fixed clock.
//   3. keys: pi keybindings map to panel keys; ↑↓ move the selection, enter opens a run, esc goes
//      back to the list and then closes the panel.
//   4. x stop is No-first: enter on the first choice, or esc, keeps the run; only the second
//      choice stops it. A finished run has nothing to stop.
//   5. p pauses a live run and resumes a paused one, through the control API.
//   6. s save is No-first: No keeps the project untouched; the second choice copies the
//      definition into .pi/workflows/; a second save asks to overwrite; a project workflow has
//      nothing to save.
//   7. a real YAML run (the executor with a fake child) feeds the panel: description, agents,
//      tokens, models and narration show.
//   8. outside the TUI /workflows prints text (notify in RPC, stderr without UI); in the TUI it
//      opens a custom component (an overlay on pi 1.3.0 or newer) whose esc closes it and stops
//      its timer.
//   9. the copied supportsOverlay agrees with control-center's and is true from 1.3.0 only; the
//      extension registers
//      /workflows, and not in a subagent child.
//  Script runs (E5 slice S10):
//  10. render: a nested workflow() shows as a `▸ <name>` group in Phases (with its phases under it)
//      and in Agents; a journal answer has the ◆ dot and a cached count; badges for
//      `sandbox: reduced`, `approvals: k` and the budget used.
//  11. k skips the selected running agent only (the others go on); a finished agent or a run that
//      is not live has nothing to skip.
//  12. s on a script run is No-first and saves .pi/workflows/<name>.js with its digest trusted;
//      overwrite asks a No-first choice; a script changed since the run is refused.
//  13. the status line: one or many active runs, paused, budget; setStatus only on change; bound by
//      the subagent session_start handler and cleared on session_shutdown.
//  14. real engine runs (fake children) feed all of it: nested groups, ◆ on resume, the reduced
//      sandbox badge, p pause shown in the run, k skip, and s save of the run's script.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fakePi, loadModule, type FakePiApi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as PanelModule from "../packages/extensions/third_party/subagent/wf-panel.ts";
import type * as RunModelModule from "../packages/extensions/third_party/subagent/run-model.ts";
import type * as ControlModule from "../packages/extensions/third_party/subagent/control.ts";
import type * as WorkflowModule from "../packages/extensions/third_party/subagent/workflow.ts";
import type * as HubModule from "../packages/extensions/src/control-center/hub.ts";
import type * as EngineModule from "../packages/extensions/third_party/subagent/wf-engine.ts";
import type * as SandboxModule from "../packages/extensions/third_party/subagent/wf-sandbox.ts";
import type * as WorkflowToolsModule from "../packages/extensions/third_party/subagent/workflow-tools.ts";
import { fakeSpawner as scriptSpawner, type FakeSpawn as ScriptSpawn } from "./workflow-fakes.ts";
import type { ExecuteOptions, RunState, WorkflowDef } from "../packages/extensions/third_party/subagent/workflow.ts";

const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-workflow-panel-");
const restores = [
  isolateKitEnv(),
  setEnv("HOME", path.join(ws, "home")),
  setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
  setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "subagent-state")),
  setEnv("PI_KIT_SUBAGENT_RETRIES", "0"),
  setEnv("PI_KIT_INTERNAL_CHILD", undefined),
];
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: () => boolean;
}
type FakeSpawn = (cmd: string, args: string[]) => FakeChild;
// The panel reads only mode, hasUI, cwd and ui.notify / ui.custom from pi's context, and only
// registerCommand from its API: the view types those entry points with the test's stand-ins.
interface TestCtx {
  mode: string;
  hasUI: boolean;
  cwd: string;
  ui: {
    notify?: (message: string) => void;
    custom?: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: undefined) => void) => { render(w: number): string[]; handleInput(d: string): void; dispose(): void }, opts: unknown) => Promise<undefined>;
  };
}
type PanelView = Omit<typeof PanelModule, "openWorkflowPanel" | "registerWorkflowPanel"> & {
  openWorkflowPanel(ctx: TestCtx, runId?: string, registry?: RunModelModule.RunRegistry, narration?: PanelModule.Narrator): Promise<void>;
  registerWorkflowPanel(api: FakePiApi): void;
};
type EngineOptions = Omit<EngineModule.EngineOptions, "spawnChild"> & { spawnChild: ScriptSpawn };
interface EngineView {
  startScriptRun(spec: EngineModule.ScriptSpec, args: unknown, opts: EngineOptions): EngineModule.StartResult;
}
type WorkflowView = Omit<typeof WorkflowModule, "executeWorkflow"> & {
  executeWorkflow(w: WorkflowDef, state: RunState, opts: Omit<ExecuteOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<RunState>;
};

// A child that answers every task with one assistant message of 1200 input / 300 output tokens.
function fakeSpawner(): FakeSpawn {
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
    child.stdin.resume();
    child.stdin.on("end", () => {
      setTimeout(() => {
        const message = { role: "assistant", model: "test/fast", content: [{ type: "text", text: "done" }], usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop" };
        child.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
        child.emit("close", 0);
      }, 5);
    });
    return child;
  };
}

// pi's keybindings, as the panel matches them: one raw key sequence per binding.
const KEYS = { "tui.select.up": "\u001b[A", "tui.select.down": "\u001b[B", "tui.select.confirm": "\r", "tui.select.cancel": "\u001b" } as const;
const keys = { matches: (data: string, binding: keyof typeof KEYS): boolean => KEYS[binding] === data };

try {
  const P = await loadModule<PanelView>("vendor/subagent/wf-panel.ts");
  const RM = await loadModule<typeof RunModelModule>("vendor/subagent/run-model.ts");
  const C = await loadModule<typeof ControlModule>("vendor/subagent/control.ts");
  const W = await loadModule<WorkflowView>("vendor/subagent/workflow.ts");
  const H = await loadModule<typeof HubModule>("extensions/control-center/hub.ts");
  const keepalive = setInterval(() => {}, 1000);

  // 1. Formatting.
  {
    assert.equal(P.fmtElapsed(0), "0s");
    assert.equal(P.fmtElapsed(59_999), "59s");
    assert.equal(P.fmtElapsed(62_000), "1m 02s");
    assert.equal(P.fmtElapsed(3_723_000), "1h 02m");
    assert.equal(P.fmtTokens(950), "950");
    assert.equal(P.fmtTokens(12_345), "12.3k");
    assert.equal(P.fmtTokens(1_250_000), "1.3M");
    ok("formatting: elapsed and tokens");
  }

  // A fixed clock the test moves by hand.
  let now = 1_000_000;
  const clock = (): number => now;
  const usage = (input: number, output: number) => ({ input, output, cacheRead: 5000, cacheWrite: 0, cost: 0, turns: 1 });

  // A run with three phases and three agents: one passed, one failed, one still running.
  const build = (registry: RunModelModule.RunRegistry, narrator: PanelModule.Narrator, info: RunModelModule.RunInfo, id = "20261023-120000-review") => {
    const off = narrator.attach(registry);
    const run = registry.start(id, "yaml", "review", info);
    for (const p of ["scan", "fan", "report"]) run.phase(p);
    run.setPhaseStatus("scan", "running");
    const scan = run.agentStart({ label: "scan", phase: "scan", role: "scout", model: "test/fast" });
    now += 14_000;
    run.agentEnd(scan, { status: "passed", usage: usage(12_000, 345) });
    run.setPhaseStatus("scan", "passed");
    run.setPhaseStatus("fan", "running");
    const one = run.agentStart({ label: "one", phase: "fan", role: "scout" });
    const two = run.agentStart({ label: "two", phase: "fan", role: "planner", model: "test/big" });
    now += 3_000;
    run.agentEnd(one, { status: "failed", usage: usage(800, 20), model: "test/fast", error: "child exited 1:\n  boom" });
    run.agentUpdate(two, { usage: usage(2_000, 100), activity: "reading src/index.ts" });
    now += 5_000;
    off();
    return run;
  };

  // 2. Render snapshot.
  {
    const registry = new RM.RunRegistry(clock);
    const narrator = new P.Narrator();
    build(registry, narrator, { description: "Review the change in parallel", file: "/kit/review.md", source: "kit" });
    const snap = registry.get("20261023-120000-review");
    assert.ok(snap);
    const lines = P.renderRunLines(snap, { paint: P.plainPaint, narration: narrator.lines(snap.id), selected: 2 });
    assert.deepEqual(lines, [
      "review — Review the change in parallel",
      "● running · 2/3 agents done · 22s · 20261023-120000-review",
      "",
      "Phases (1/3)",
      "  ● scan    passed   1/1",
      "  ● fan     running  1/2",
      "  ● report  pending  0/0",
      "",
      "Agents (2/3)",
      "  ● scan#1  test/fast   12.3k tok      14s  passed",
      "  ● one#1   test/fast     820 tok       3s  failed",
      "› ● two#1   test/big     2.1k tok       8s  running",
      "  two#1: reading src/index.ts",
      "",
      "Narrator",
      "  +14s scan#1 passed, 12.3k tok",
      "  +14s phase scan passed",
      "  +14s phase fan running",
      "  +14s one#1 started (scout)",
      "  +14s two#1 started (planner)",
      "  +17s one#1 failed, 820 tok: child exited 1: boom",
    ]);
    // The narrator kept every line from the start; the panel shows the last NARRATION_SHOWN.
    assert.deepEqual(narrator.lines(snap.id), [
      "+0s started review",
      "+0s phase scan running",
      "+0s scan#1 started (scout)",
      "+14s scan#1 passed, 12.3k tok",
      "+14s phase scan passed",
      "+14s phase fan running",
      "+14s one#1 started (scout)",
      "+14s two#1 started (planner)",
      "+17s one#1 failed, 820 tok: child exited 1: boom",
    ]);
    // The text fallback has no selection and lists each failure under its agent.
    const text = P.renderRunLines(snap, { paint: P.plainPaint, narration: [] });
    assert.ok(text.includes("  ● one#1   test/fast     820 tok       3s  failed"));
    assert.ok(text.includes("      child exited 1: boom"));
    assert.ok(!text.some((l) => l.startsWith("›")));
    // The run list.
    assert.deepEqual(P.renderListLines(registry.list(), P.plainPaint, 0), [
      "Workflows (1 run, 1 active)",
      "› ● review  running      2/3 agents        22s  20261023-120000-review",
    ]);
    assert.deepEqual(P.renderListLines([], P.plainPaint), ["Workflows (0 runs, 0 active)", "No workflow runs in this session. Start one with /workflow run <name>."]);
    // The panel frame: rules, footer keys, every line cut to the width.
    const panel = new P.WorkflowPanel({ registry, narrator, cwd: ws, paint: P.plainPaint, close: () => {} }, snap.id);
    const framed = panel.render(80);
    assert.ok(framed.includes(" ↑↓ select · k skip · x stop · p pause · s save · esc back"));
    assert.equal(framed[0], "─".repeat(80));
    const narrow = panel.render(30);
    // Built from a named control character: stripping colour resets is the point.
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    assert.ok(narrow.every((l) => Array.from(l.replace(ansi, "")).length <= 30), "lines are cut to the width");
    assert.ok(narrow.some((l) => l.includes("…")), "a cut line ends in an ellipsis");
    // A themed render colours the dots through the pi theme.
    const themed = new P.WorkflowPanel({ registry, narrator, cwd: ws, paint: P.themePaint({ fg: (c, t) => `<${c}>${t}</${c}>`, bold: (t) => `<b>${t}</b>` }), close: () => {} }, snap.id).render(200);
    assert.ok(themed.some((l) => l.includes("<success>●</success> scan#1")));
    assert.ok(themed.some((l) => l.includes("<error>●</error> one#1")));
    assert.ok(themed.some((l) => l.includes("<accent>●</accent> two#1")));
    ok("render snapshot: header, phases done/total, agents (label, model, tokens, elapsed, dot), narrator, footer");
  }

  // 3-5. Keys, x stop (No-first), p pause/resume.
  {
    const registry = new RM.RunRegistry(clock);
    const narrator = new P.Narrator();
    registry.start("20261023-110000-older", "yaml", "older").finish("passed");
    now += 1000;
    const run = build(registry, narrator, { description: "d", file: "/kit/review.md", source: "kit" });
    const controls = new C.ControlRegistry();
    const { control, close } = controls.open(run.id);
    control.onChange((paused) => run.setPaused(paused));
    let closed = 0;
    let renders = 0;
    const panel = new P.WorkflowPanel({
      registry,
      narrator,
      cwd: ws,
      paint: P.plainPaint,
      close: () => closed++,
      requestRender: () => renders++,
      control: (id, action) => C.controlRun(id, action, controls),
      isLive: (id) => controls.has(id),
    });
    const press = (data: string): void => {
      const key = P.keyOf(data, keys);
      assert.ok(key, `"${JSON.stringify(data)}" maps to a panel key`);
      panel.press(key);
    };
    assert.equal(P.keyOf("q", keys), undefined);
    assert.equal(panel.view, "list");
    // The newest run is first; the older finished one is second.
    press(KEYS["tui.select.down"]);
    assert.equal(panel.listIndex, 1);
    press(KEYS["tui.select.down"]);
    assert.equal(panel.listIndex, 1, "the selection stops at the last run");
    press(KEYS["tui.select.up"]);
    press(KEYS["tui.select.confirm"]);
    assert.equal(panel.view, "run");
    assert.equal(panel.runId, run.id);
    press(KEYS["tui.select.down"]);
    press(KEYS["tui.select.down"]);
    press(KEYS["tui.select.down"]);
    assert.equal(panel.agentIndex, 2, "the agent selection stops at the last agent");
    assert.ok(panel.render(120).some((l) => l.startsWith(" › ● two#1")));
    press(KEYS["tui.select.up"]);
    assert.equal(panel.agentIndex, 1);
    assert.ok(renders > 0, "each key asks for a render");

    // x: the first choice is No, and enter on it keeps the run.
    press("x");
    assert.equal(panel.confirm?.choices[0], P.STOP_CHOICES[0]);
    assert.equal(panel.confirm?.index, 0, "No is highlighted first");
    assert.ok(panel.render(160).includes(" › No, keep it running"));
    press(KEYS["tui.select.confirm"]);
    assert.equal(control.stopped, false, "No keeps the run");
    assert.equal(panel.note, "Not stopped.");
    press("x");
    press(KEYS["tui.select.cancel"]);
    assert.equal(control.stopped, false, "esc keeps the run");
    assert.equal(panel.view, "run", "esc in the choice does not leave the run view");

    // p: pause, then resume.
    press("p");
    assert.equal(control.paused, true);
    assert.match(panel.note ?? "", /^Paused /);
    assert.ok(panel.render(160).some((l) => l.includes("p resume")), "the footer offers resume while paused");
    assert.ok(registry.get(run.id)?.paused);
    press("p");
    assert.equal(control.paused, false);
    assert.match(panel.note ?? "", /^Resumed /);

    // x then the second choice stops it.
    press("x");
    press(KEYS["tui.select.down"]);
    press(KEYS["tui.select.confirm"]);
    assert.equal(control.stopped, true, "the second choice stops the run");
    assert.match(panel.note ?? "", /^Stopping /);
    close();

    // A run that is not live has nothing to stop or pause.
    press(KEYS["tui.select.cancel"]);
    assert.equal(panel.view, "list");
    press(KEYS["tui.select.down"]);
    press(KEYS["tui.select.confirm"]);
    assert.equal(panel.runId, "20261023-110000-older");
    press("x");
    assert.equal(panel.confirm, undefined);
    assert.match(panel.note ?? "", /not live; there is nothing to stop/);
    press("p");
    assert.match(panel.note ?? "", /not live; it cannot be paused/);
    press(KEYS["tui.select.cancel"]);
    press(KEYS["tui.select.cancel"]);
    assert.equal(closed, 1, "esc on the list closes the panel");
    // Opening on an unknown id shows the list with a note.
    const unknown = new P.WorkflowPanel({ registry, narrator, cwd: ws, paint: P.plainPaint, close: () => {} }, "nope");
    assert.equal(unknown.view, "list");
    assert.match(unknown.note ?? "", /No workflow run "nope"/);
    ok("keys: arrows, enter, esc back/close; x stop No-first; p pause/resume; not-live runs refuse");
  }

  // 6. s save (No-first; overwrite asks; project workflows have nothing to save).
  {
    const registry = new RM.RunRegistry(clock);
    const narrator = new P.Narrator();
    const userDir = path.join(ws, "agent", "workflows");
    fs.mkdirSync(userDir, { recursive: true });
    const def = path.join(userDir, "review.md");
    fs.writeFileSync(def, "---\nname: review\n---\n");
    const run = build(registry, narrator, { description: "d", file: def, source: "user" }, "20261023-130000-review");
    const project = path.join(ws, "proj");
    fs.mkdirSync(project, { recursive: true });
    const target = path.join(project, ".pi", "workflows", "review.md");
    const panel = new P.WorkflowPanel({ registry, narrator, cwd: project, paint: P.plainPaint, close: () => {} }, run.id);
    panel.press("save");
    assert.equal(panel.confirm?.choices[0], P.SAVE_NO);
    assert.equal(panel.confirm?.index, 0);
    assert.equal(panel.confirm?.choices[1], `Save as ${path.join(".pi", "workflows", "review.md")}`);
    panel.press("enter");
    assert.equal(fs.existsSync(target), false, "No saves nothing");
    panel.press("save");
    panel.press("esc");
    assert.equal(fs.existsSync(target), false, "esc saves nothing");
    panel.press("save");
    panel.press("down");
    panel.press("enter");
    assert.equal(fs.readFileSync(target, "utf8"), "---\nname: review\n---\n", "the second choice copies the definition");
    assert.match(panel.note ?? "", /project workflow now: running it asks for trust first/);
    panel.press("save");
    assert.equal(panel.confirm?.choices[1], `Overwrite ${path.join(".pi", "workflows", "review.md")}`);
    assert.match(panel.confirm?.question ?? "", /already exists/);
    panel.press("esc");
    const projectRun = registry.start("20261023-140000-proj", "yaml", "proj", { file: target, source: "project" });
    assert.match(P.planSave(registry.get(projectRun.id) ?? assert.fail("run"), project).message ?? "", /Already a project workflow/);
    const scriptRun = registry.start("20261023-150000-script", "script", "s");
    assert.match(P.planSave(registry.get(scriptRun.id) ?? assert.fail("run"), project).message ?? "", /has no recorded definition file/);
    ok("s save: No-first, copies into .pi/workflows/, overwrite asks, project runs and runs without a file refuse");

    // A planted symlink (the target file, or .pi/workflows itself) must never be written through.
    const outside = path.join(ws, "outside");
    fs.mkdirSync(outside, { recursive: true });
    const victim = path.join(outside, "victim.md");
    fs.writeFileSync(victim, "keep me\n");
    const linkedFile = path.join(ws, "proj-link-file");
    fs.mkdirSync(path.join(linkedFile, ".pi", "workflows"), { recursive: true });
    fs.symlinkSync(victim, path.join(linkedFile, ".pi", "workflows", "review.md"));
    assert.match(P.planSave(registry.get(run.id) ?? assert.fail("run"), linkedFile).message ?? "", /Refusing to save: .*review\.md is a symlink/);
    assert.throws(() => P.saveCopy(def, path.join(linkedFile, ".pi", "workflows", "review.md"), linkedFile), /is a symlink/);
    const linkedDir = path.join(ws, "proj-link-dir");
    fs.mkdirSync(path.join(linkedDir, ".pi"), { recursive: true });
    fs.symlinkSync(outside, path.join(linkedDir, ".pi", "workflows"));
    assert.match(P.planSave(registry.get(run.id) ?? assert.fail("run"), linkedDir).message ?? "", /Refusing to save: .*workflows is a symlink/);
    assert.throws(() => P.saveCopy(def, path.join(linkedDir, ".pi", "workflows", "victim.md"), linkedDir), /is a symlink/);
    const symPanel = new P.WorkflowPanel({ registry, narrator, cwd: linkedFile, paint: P.plainPaint, close: () => {} }, run.id);
    symPanel.press("save");
    assert.equal(symPanel.confirm, undefined, "a symlinked target gets no save prompt");
    assert.match(symPanel.note ?? "", /is a symlink/);
    assert.equal(fs.readFileSync(victim, "utf8"), "keep me\n", "the file outside the project is unchanged");
    assert.equal(fs.readdirSync(outside).join(","), "victim.md", "nothing new is written outside the project");
    ok("s save: a symlinked .pi/workflows or target file is refused and the outside file is unchanged");
  }

  // 7. A real YAML run feeds the panel.
  {
    const registry = new RM.RunRegistry();
    const narrator = new P.Narrator();
    narrator.attach(registry);
    const agents = ["scout", "planner"].map((name): AgentConfig => ({ name, description: name, systemPrompt: "", source: "kit", filePath: name }));
    const { workflow, errors } = W.parseWorkflow(
      `---\nname: tele\ndescription: Scan then plan\nsteps:\n  - id: scan\n    agent: scout\n    task: "scan it"\n  - id: plan\n    agent: planner\n    task: "plan"\n---\n\nbody\n`,
      path.join(ws, "tele.md"),
      "user",
    );
    assert.ok(workflow, errors.join("; "));
    const final = await W.executeWorkflow(workflow, W.newRunState(workflow, {}), { cwd: ws, agents, spawnChild: fakeSpawner(), registry, launchKind: "user" });
    assert.equal(final.status, "passed");
    const snap = registry.get(final.id) ?? assert.fail("the run is in the registry");
    assert.equal(snap.description, "Scan then plan");
    assert.equal(snap.source, "user");
    assert.equal(snap.file, path.join(ws, "tele.md"));
    const text = P.renderText(registry, narrator, final.id);
    assert.match(text, /^tele — Scan then plan\n● passed · 2\/2 agents done · /);
    assert.match(text, /Phases \(2\/2\)/);
    assert.match(text, /● scan#1 +test\/fast +1\.5k tok +\d+s +passed/);
    assert.match(text, /● plan#1 +test\/fast +1\.5k tok +\d+s +passed/);
    assert.match(text, /\+\d+s run passed/);
    ok("a YAML run feeds the panel: description, agents, models, tokens, narration");
  }

  // 8. Text outside the TUI; an overlay in the TUI.
  {
    const registry = new RM.RunRegistry(clock);
    const narrator = new P.Narrator();
    build(registry, narrator, { description: "d", source: "kit" }, "20261023-160000-review");
    const notes: string[] = [];
    const rpcCtx: TestCtx = { mode: "rpc", hasUI: true, cwd: ws, ui: { notify: (m: string) => notes.push(m) } };
    await P.openWorkflowPanel(rpcCtx, undefined, registry, narrator);
    assert.match(notes[0] ?? "", /^Workflows \(1 run, 1 active\)/);
    assert.match(notes[0] ?? "", /Agents \(2\/3\)/);
    await P.openWorkflowPanel(rpcCtx, "20261023-160000-review", registry, narrator);
    assert.match(notes[1] ?? "", /^review — d/);
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      await P.openWorkflowPanel({ mode: "print", hasUI: false, cwd: ws, ui: {} }, "missing", registry, narrator);
    } finally {
      process.stderr.write = realWrite;
    }
    assert.match(written.join(""), /No workflow run "missing"/);

    // TUI: ctx.ui.custom gets an overlay; esc on the list closes it and stops the timer.
    let options: unknown;
    let rendered: string[] = [];
    let requested = 0;
    const tuiCtx: TestCtx = {
      mode: "tui",
      hasUI: true,
      cwd: ws,
      ui: {
        notify: () => {},
        custom: (factory, opts) =>
          new Promise<undefined>((resolve) => {
            options = opts;
            const component = factory({ requestRender: () => requested++ }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, keys, resolve);
            rendered = component.render(100);
            registry.start("20261023-170000-new", "yaml", "new").finish("passed");
            component.handleInput(KEYS["tui.select.cancel"]);
          }),
      },
    };
    await P.openWorkflowPanel(tuiCtx, undefined, registry, narrator);
    // An overlay only on pi 1.3.0 or newer: the compat lanes run this file on older pi too.
    assert.deepEqual(options, P.supportsOverlay() ? { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } } : undefined);
    assert.ok(rendered.some((l) => l.includes("Workflows (1 run, 1 active)")));
    assert.ok(requested > 0, "registry events ask the overlay to render");
    const after = requested;
    registry.start("20261023-180000-later", "yaml", "later").finish("passed");
    assert.equal(requested, after, "a closed panel no longer listens");
    ok("text fallback (notify, stderr) and the TUI overlay (esc closes, listeners stop)");
  }

  // 9. supportsOverlay parity; registration.
  {
    for (const v of ["1.4.0", "1.3.0", "1.2.9", "0.85.1", "2.0.0", "v1.3.1-beta.1"]) assert.equal(P.supportsOverlay(v), H.supportsOverlay(v), `supportsOverlay(${v})`);
    for (const v of ["1.3.0", "1.4.0", "v1.3.1-beta.1"]) assert.equal(P.supportsOverlay(v), true, `supportsOverlay(${v})`);
    for (const v of ["1.2.9", "0.99.2", "0.85.1"]) assert.equal(P.supportsOverlay(v), false, `supportsOverlay(${v})`);
    const I = await loadModule<{ default: (api: unknown) => void }>("vendor/subagent/index.ts");
    const pi = fakePi();
    I.default(pi.api);
    assert.ok(pi.commands.find("workflows"), "/workflows is registered");
    const child = fakePi();
    const restoreChild = setEnv("PI_KIT_INTERNAL_CHILD", "1");
    try {
      P.registerWorkflowPanel(child.api);
    } finally {
      restoreChild();
    }
    assert.equal(child.commands.find("workflows"), undefined, "a subagent child has no panel");
    ok("supportsOverlay matches control-center; /workflows registered, not in a child");
  }


  // 10-12. Script runs: groups, the cached dot, badges, k skip, s save.
  const scriptRunFixture = (registry: RunModelModule.RunRegistry, info: RunModelModule.RunInfo, id = "wf-20261023t120000-aaaa0001") => {
    const run = registry.start(id, "script", "sweep", info);
    run.phase("Scan", "Scan", "running");
    const cachedId = run.agentStart({ label: "scan-a", phase: "Scan", role: "scout", cached: true });
    run.agentEnd(cachedId, { status: "passed" });
    const live = run.agentStart({ label: "scan-b", phase: "Scan", role: "scout", model: "test/fast" });
    run.agentUpdate(live, { usage: usage(1000, 400) });
    run.phase("▸ child", "▸ child", "running");
    run.phase("▸ child · Inner", "Inner", "running", "▸ child");
    const inner = run.agentStart({ label: "inner", phase: "▸ child · Inner", role: "scout", group: "child" });
    now += 2_000;
    run.agentEnd(inner, { status: "passed", usage: usage(200, 100) });
    return { run, live, inner, cachedId };
  };
  {
    const registry = new RM.RunRegistry(clock);
    const narrator = new P.Narrator();
    const off = narrator.attach(registry);
    const { run } = scriptRunFixture(registry, { description: "Sweep the repo", sandbox: "reduced", budgetTotal: 1000 });
    run.noteApproval();
    run.noteApproval();
    off();
    const snap = registry.get(run.id) ?? assert.fail("run");
    assert.equal(snap.approvals, 2);
    assert.deepEqual(P.renderRunLines(snap, { paint: P.plainPaint, narration: narrator.lines(run.id), selected: 1 }), [
      "sweep — Sweep the repo",
      "● running · 2/3 agents done · 1 cached · 2s · wf-20261023t120000-aaaa0001",
      "sandbox: reduced · approvals: 2 · budget: 50% (500/1.0k output tok)",
      "",
      "Phases (0/3)",
      "  ● Scan     running  1/2",
      "  ● ▸ child  running  1/1",
      "    ● Inner  running  1/1",
      "",
      "Agents (2/3)",
      "  ◆ scan-a#1   -               0 tok       0s  passed",
      "› ● scan-b#1   test/fast    1.4k tok       2s  running",
      "    ▸ child",
      "  ●   inner#1  -             300 tok       2s  passed",
      "",
      "Narrator",
      "  +0s phase ▸ child running",
      "  +0s phase ▸ child · Inner running",
      "  +0s ▸ child: inner#1 started (scout)",
      "  +2s ▸ child: inner#1 passed, 300 tok",
      "  +2s approval #1",
      "  +2s approval #2",
    ]);
    assert.ok(narrator.lines(run.id).includes("+0s scan-a#1 reused from the journal"), "a journal answer is narrated as reused, not started");
    assert.ok(!narrator.lines(run.id).some((l) => l.includes("scan-a#1 started")));
    // Badges only when they apply; budget turns warn at 80% and bad at 100%.
    const plain = registry.start("wf-20261023t120000-aaaa0002", "script", "plain", { sandbox: "full", budgetTotal: null });
    assert.equal(P.renderRunLines(registry.get(plain.id) ?? assert.fail("run"), { paint: P.plainPaint, narration: [] })[2], "", "no badge line for a full sandbox, no approvals and no budget");
    const tones = P.themePaint({ fg: (c, t) => `<${c}>${t}</${c}>`, bold: (t) => t });
    const at = (output: number): string => P.badges({ ...snap, sandbox: "full", approvals: 0, usage: { ...snap.usage, output } }, tones).join("");
    assert.match(at(500), /^<dim>budget: 50%/);
    assert.match(at(850), /^<warning>budget: 85%/);
    assert.match(at(1200), /^<error>budget: 120%/);
    assert.ok(P.renderRunLines(snap, { paint: tones, narration: [] }).some((l) => l.includes("<success>◆</success> scan-a#1")), "the ◆ dot takes the status colour");
    ok("script render: ▸ groups in Phases and Agents, ◆ cached dot and count, sandbox/approvals/budget badges");
  }
  {
    const registry = new RM.RunRegistry(clock);
    const narrator = new P.Narrator();
    const { run, live, inner } = scriptRunFixture(registry, {});
    const other = run.agentStart({ label: "scan-c", phase: "Scan", role: "scout" });
    const controls = new C.ControlRegistry();
    const { control, close } = controls.open(run.id);
    const hLive = control.agent("scan-b", live);
    const hOther = control.agent("scan-c", other);
    const panel = new P.WorkflowPanel({ registry, narrator, cwd: ws, paint: P.plainPaint, close: () => {}, isLive: (id) => controls.has(id), skip: (id, agentId) => C.skipRunAgent(id, agentId, controls) }, run.id);
    assert.equal(P.keyOf("k", keys), "skip");
    // Agent order: scan-a#1 (cached), scan-b#1 (running), inner#1 (passed), scan-c#1 (running).
    panel.press("skip");
    assert.match(panel.note ?? "", /scan-a#1 is not running; there is nothing to skip/);
    panel.press("down");
    panel.press("skip");
    assert.match(panel.note ?? "", /^Skipping scan-b#1 in /);
    assert.equal(hLive.signal.aborted, true, "the selected agent is cut off");
    assert.equal(hLive.skipped(), true);
    assert.equal(hOther.signal.aborted, false, "the other running agent goes on");
    assert.equal(control.stopped, false, "skip does not stop the run");
    panel.press("skip");
    assert.match(panel.note ?? "", /scan-b#1 is not running in .*nothing to skip/, "a second k on the same agent has nothing left to skip");
    assert.equal(registry.get(run.id)?.agents.find((a) => a.id === inner)?.status, "passed");
    hLive.done();
    hOther.done();
    close();
    panel.press("skip");
    assert.match(panel.note ?? "", /is not live; there is nothing to skip/);
    ok("k skips the selected running agent only; finished agents and runs that are not live have nothing to skip");
  }
  {
    const T = await loadModule<typeof WorkflowToolsModule>("vendor/subagent/workflow-tools.ts");
    const registry = new RM.RunRegistry(clock);
    const narrator = new P.Narrator();
    const project = path.join(ws, "script-proj");
    const runDir = path.join(project, ".pi", "workflows", "runs", "wf-20261023t130000-bbbb0001");
    fs.mkdirSync(runDir, { recursive: true });
    const scriptFile = path.join(runDir, "script.js");
    const source = 'export const meta = { name: "sweep", description: "Sweep" };\nreturn await agent("x")\n';
    fs.writeFileSync(scriptFile, source);
    const digest = crypto.createHash("sha256").update(source).digest("hex");
    const { run } = scriptRunFixture(registry, { description: "Sweep", file: scriptFile, digest }, "wf-20261023t130000-bbbb0001");
    const target = path.join(project, ".pi", "workflows", "sweep.js");
    const panel = new P.WorkflowPanel({ registry, narrator, cwd: project, paint: P.plainPaint, close: () => {} }, run.id);
    panel.press("save");
    assert.equal(panel.confirm?.choices[0], P.SAVE_NO);
    assert.equal(panel.confirm?.index, 0, "No is highlighted first");
    assert.equal(panel.confirm?.choices[1], `Save and trust ${path.join(".pi", "workflows", "sweep.js")}`);
    assert.ok((panel.confirm?.question ?? "").includes(`trust its digest (sha256 ${digest})`), "the script-save question names the trust grant and its digest");
    panel.press("enter");
    assert.equal(fs.existsSync(target), false, "No saves nothing");
    assert.equal(T.trustedDigests().includes(digest), false, "No trusts nothing");
    panel.press("save");
    panel.press("down");
    panel.press("enter");
    assert.equal(fs.readFileSync(target, "utf8"), source, "the run's script is saved as .pi/workflows/<name>.js");
    assert.ok(T.trustedDigests().includes(digest), "the saved script's digest is trusted");
    assert.match(panel.note ?? "", /Its digest is trusted/);
    // Overwrite: a different file is there now; the choice is No-first and No keeps it.
    fs.writeFileSync(target, "// someone else's\n");
    panel.press("save");
    assert.match(panel.confirm?.question ?? "", /already exists/);
    assert.equal(panel.confirm?.choices[0], P.SAVE_NO);
    assert.equal(panel.confirm?.index, 0);
    assert.equal(panel.confirm?.choices[1], `Overwrite ${path.join(".pi", "workflows", "sweep.js")} and trust it`);
    assert.ok((panel.confirm?.question ?? "").includes(`trust its digest (sha256 ${digest})`), "the overwrite question names the trust grant too");
    panel.press("enter");
    assert.equal(fs.readFileSync(target, "utf8"), "// someone else's\n", "No keeps the existing file");
    panel.press("save");
    panel.press("esc");
    assert.equal(fs.readFileSync(target, "utf8"), "// someone else's\n", "esc keeps the existing file");
    panel.press("save");
    panel.press("down");
    panel.press("enter");
    assert.equal(fs.readFileSync(target, "utf8"), source, "the second choice overwrites");
    // A script edited since the run is not saved (its digest would be trusted).
    fs.appendFileSync(scriptFile, "// edited\n");
    panel.press("save");
    assert.equal(panel.confirm, undefined);
    assert.match(panel.note ?? "", /changed since the run/);
    // Changed between the choice and the write: refused too.
    fs.writeFileSync(scriptFile, source);
    panel.press("save");
    fs.appendFileSync(scriptFile, "// late edit\n");
    panel.press("down");
    panel.press("enter");
    assert.match(panel.note ?? "", /Could not save .*changed since the run/);
    assert.throws(() => P.saveScript(scriptFile, target, project, digest, { name: "sweep", description: "Sweep" }), /changed since the run/);
    // A run whose script is already a project workflow has nothing to save.
    const proj = registry.start("wf-20261023t130000-bbbb0002", "script", "sweep", { file: target, digest });
    assert.match(P.planSave(registry.get(proj.id) ?? assert.fail("run"), project).message ?? "", /Already a project workflow/);
    ok("s on a script run: No-first, saves .pi/workflows/<name>.js with its digest trusted, overwrite is No-first, an edited script is refused");
  }

  // 13. The status line.
  {
    const registry = new RM.RunRegistry(clock);
    assert.equal(P.statusLine(registry.list()), undefined, "no active run, no status");
    const { run } = scriptRunFixture(registry, { budgetTotal: 1000 });
    run.noteApproval();
    assert.equal(P.statusLine(registry.list()), "wf sweep: 2/3 agents · budget 50% · approvals: 1");
    run.setPaused(true);
    assert.equal(P.statusLine(registry.list()), "wf sweep: 2/3 agents · paused · budget 50% · approvals: 1");
    const second = registry.start("wf-20261023t140000-cccc0001", "script", "second");
    second.agentStart({ label: "a", phase: "main" });
    assert.equal(P.statusLine(registry.list()), "wf: 2 running · 2/4 agents · 1 paused");
    const status = new P.WorkflowStatus(registry);
    const off = status.attach();
    const seen: Array<string | undefined> = [];
    status.bind((t) => seen.push(t));
    assert.deepEqual(seen, ["wf: 2 running · 2/4 agents · 1 paused"]);
    second.agentUpdate("a#1", { activity: "reading" });
    assert.equal(seen.length, 1, "an event that leaves the text unchanged does not call setStatus");
    second.finish("passed");
    run.finish("passed");
    assert.equal(seen.at(-1), undefined, "the status clears when no run is active");
    status.bind(() => {
      throw new Error("stale context");
    });
    registry.start("wf-20261023t140000-cccc0002", "script", "third");
    off();
    ok("status line: one or many runs, paused, budget, approvals; setStatus only on change; a throwing sink is ignored");

    // The subagent extension's session_start binds the process-wide status line; session_shutdown clears it.
    // index.ts re-exports the registry its own wf-panel.ts feeds (a fresh loadModule copy would not be it).
    const I = await loadModule<{ default: (api: unknown) => void; runRegistry: RunModelModule.RunRegistry }>("vendor/subagent/index.ts");
    const pi = fakePi();
    I.default(pi.api);
    const statuses: Array<[string, string | undefined]> = [];
    await pi.handlers.get("session_start")({ reason: "startup" }, { hasUI: true, cwd: ws, ui: { notify: () => {}, setStatus: (k: string, t: string | undefined) => statuses.push([k, t]) } });
    assert.deepEqual(statuses.at(-1), [P.STATUS_KEY, undefined], "bound with nothing running");
    const shared = I.runRegistry.start("wf-20261023t150000-dddd0001", "script", "live");
    assert.deepEqual(statuses.at(-1), [P.STATUS_KEY, "wf live: 0/0 agents"], "a run in the process registry shows in the footer");
    shared.finish("passed");
    assert.deepEqual(statuses.at(-1), [P.STATUS_KEY, undefined]);
    const before = statuses.length;
    await pi.handlers.get("session_shutdown")({}, { hasUI: true, cwd: ws, ui: {} });
    assert.equal(statuses.length, before + 1);
    I.runRegistry.start("wf-20261023t150000-dddd0002", "script", "after").finish("passed");
    assert.equal(statuses.length, before + 1, "after session_shutdown nothing reports to the old footer");
    ok("status line: bound by the subagent session_start handler, cleared and unbound on session_shutdown");
  }

  // 14. Real engine runs feed the panel.
  {
    const E = await loadModule<EngineView>("vendor/subagent/wf-engine.ts");
    const S = await loadModule<typeof SandboxModule>("vendor/subagent/wf-sandbox.ts");
    const support = S.detectSupport();
    const project = path.join(ws, "engine-proj");
    fs.mkdirSync(project, { recursive: true });
    const roles = ["scout", "implementer"].map((name): AgentConfig => ({ name, description: name, systemPrompt: "", source: "kit", filePath: name, ...(name === "scout" ? { tools: ["read", "grep", "find", "ls"] } : {}) }));
    const scriptSpec = (name: string, body: string): EngineModule.ScriptSpec => ({ name, description: `${name} test`, source: `export const meta = { name: "${name}", description: "${name} test" };\n${body}`, phases: [] });
    const child = scriptSpec("child", `phase("Inner"); return await agent("inner " + args.n, { agentType: "scout" })`);
    const registry = new RM.RunRegistry();
    const controls = new C.ControlRegistry();
    const fake = scriptSpawner((sp) => ({ text: sp.task, delayMs: sp.task === "slow" ? 1500 : 5 }));
    // The reduced mode is what the badge reports; the engine runs it on any host.
    const base = { cwd: project, agents: roles, sandbox: { mode: "reduced" as const, support }, spawnChild: fake.spawn, registry, controls, resolveWorkflow: async () => child };
    const parent = scriptSpec("sweep", `phase("Scan")\nconst a = await agent("scan", { agentType: "scout" })\nconst v = await workflow("child", { n: 1 })\nreturn { a, v }`);
    const first = E.startScriptRun(parent, undefined, base);
    assert.ok(first.ok, first.ok ? "" : first.error);
    const o1 = await first.done;
    assert.equal(o1.status, "passed", o1.error ?? "");
    const resumed = E.startScriptRun(parent, undefined, { ...base, resumeFrom: first.runId });
    assert.ok(resumed.ok, resumed.ok ? "" : resumed.error);
    const o2 = await resumed.done;
    assert.equal(o2.status, "passed", o2.error ?? "");
    assert.equal(o2.cached, 2);
    const snap = registry.get(resumed.runId) ?? assert.fail("run");
    const text = P.renderRunLines(snap, { paint: P.plainPaint, narration: [] });
    assert.match(text[1] ?? "", / · 2 cached · /);
    assert.equal(text[2], "sandbox: reduced", "the reduced sandbox badge");
    assert.ok(text.includes("  ● ▸ child  passed   1/1"), text.join("\n"));
    assert.ok(text.includes("    ● Inner  passed   1/1"), "the nested phase sits under its group");
    assert.ok(text.includes("    ▸ child"), "the nested agent sits under a ▸ line");
    assert.equal(text.filter((l) => l.startsWith("  ◆ ")).length, 2, "both reused calls have the ◆ dot");
    // p pauses a live script run and the run shows it; k skips its running agent; s saves its script.
    const live = E.startScriptRun(scriptSpec("pauser", `const a = await agent("slow", { agentType: "scout" }); const b = await agent("after", { agentType: "scout" }); return [a, b]`), undefined, base);
    assert.ok(live.ok);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 300 && !registry.get(live.runId)?.agents.some((a) => a.status === "running"); i++) await wait(10);
    const panel = new P.WorkflowPanel({ registry, narrator: new P.Narrator(), cwd: project, paint: P.plainPaint, close: () => {}, control: (id, action) => C.controlRun(id, action, controls), skip: (id, agentId) => C.skipRunAgent(id, agentId, controls), isLive: (id) => controls.has(id) }, live.runId);
    panel.press("pause");
    assert.equal(registry.get(live.runId)?.paused, true, "a paused script run shows paused in the run model");
    assert.ok(panel.render(160).some((l) => l.includes("p resume")));
    panel.press("pause");
    assert.equal(registry.get(live.runId)?.paused, false);
    panel.press("skip");
    assert.match(panel.note ?? "", /^Skipping /);
    const o3 = await live.done;
    assert.deepEqual(o3.value, [null, "after"], "the skipped agent resolves to null and the run goes on");
    assert.equal(registry.get(live.runId)?.agents[0]?.status, "skipped");
    const saver = new P.WorkflowPanel({ registry, narrator: new P.Narrator(), cwd: project, paint: P.plainPaint, close: () => {} }, first.runId);
    saver.press("save");
    saver.press("down");
    saver.press("enter");
    assert.equal(fs.readFileSync(path.join(project, ".pi", "workflows", "sweep.js"), "utf8"), parent.source, "s saves the script the run executed");
    ok("engine runs feed the panel: ▸ groups, ◆ on resume, sandbox badge, p pause shown, k skip, s save");
  }

  clearInterval(keepalive);
  console.log(`workflow-panel-smoke: ${checks} checks passed`);
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
