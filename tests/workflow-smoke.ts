#!/usr/bin/env node
// Offline workflow executor checks. The "child" is an in-process fake: it reads its task from
// stdin, finds the run directory in the appended system prompt, and answers deterministically.
//   1. validation rejects bad definitions; the shipped kit workflows parse.
//   2. sequential order + templating ({{inputs.*}}, {{steps.x.output}}, optional "?").
//   3. parallel groups run every member and combine their outputs.
//   4. review gates loop back and stop at max_loops; the shipped gates need a final "VERDICT: PASS".
//   5. declared outputs are enforced (a step must write the files it promises).
//   6. `when` skips a step whose condition is unmet.
//   7. an interrupted run resumes without redoing finished steps.
//   8. templates cannot read outside the run directory; a missing required value fails the step.
//   9. project workflows need approval: a No-first select ("No, don't run it" / "Run once" /
//      "Trust this digest"); headless runs are refused without a digest grant.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv, textOf, type FakePiApi } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as WorkflowModule from "../packages/extensions/third_party/subagent/workflow.ts";
import type { ExecuteOptions, RunState, WorkflowDef } from "../packages/extensions/third_party/subagent/workflow.ts";

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-workflow-");
const restores = [isolateKitEnv(), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "subagent-state"))];
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const agents = ["scout", "planner", "implementer", "reviewer"].map((name): AgentConfig => ({ name, description: name, systemPrompt: "", source: "kit", filePath: name }));

// Fake child. `behave(task, runDir)` returns the reply text (may write files, may return
// { hang: true } to never finish).
type Reply = string | { hang: true };
type Behave = (task: string, runDir: string) => Reply;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: () => boolean;
}

interface RunExtra {
  state?: RunState | null;
  signal?: AbortSignal;
}

// A spawner that hands the executor a FakeChild instead of a real ChildProcess.
type FakeSpawn = (cmd: string, args: string[]) => FakeChild;

/** The workflow module as these tests drive it: the executor's spawner is a FakeSpawn. */
type WorkflowView = Omit<typeof WorkflowModule, "executeWorkflow"> & {
  executeWorkflow(w: WorkflowDef, state: RunState, opts: Omit<ExecuteOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<RunState>;
};

function fakeSpawner(behave: Behave, calls: string[]): FakeSpawn {
  return (_cmd, args) => {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: (): boolean => {
        queueMicrotask(() => child.emit("close", null));
        return true;
      },
    });
    const promptFile = args[args.indexOf("--append-system-prompt") + 1];
    assert.ok(promptFile !== undefined, "the child is started with --append-system-prompt <file>");
    const runDir = fs.readFileSync(promptFile, "utf8").match(/shared directory is: (.+)/)?.[1]?.trim();
    let stdin = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (d: string) => (stdin += d));
    child.stdin.on("end", () => {
      const task = stdin.replace(/^Task: /, "");
      calls.push(task);
      // The executor always names the run directory in the appended system prompt.
      if (runDir === undefined) throw new Error("the appended system prompt names no shared run directory");
      const reply = behave(task, runDir);
      if (reply && typeof reply !== "string" && reply.hang) return;
      child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" } }) + "\n");
      child.emit("close", 0);
    });
    return child;
  };
}

function wf(yaml: string): string {
  return `---\n${yaml.trim()}\n---\n\nbody\n`;
}

try {
  const W = await loadModule<WorkflowView>("vendor/subagent/workflow.ts");
  const keepalive = setInterval(() => {}, 1000);
  const run = async (def: string, inputs: Record<string, string>, behave: Behave, extra: RunExtra = {}) => {
    const calls: string[] = [];
    const { workflow, errors } = W.parseWorkflow(wf(def), path.join(ws, "w.md"), "user");
    assert.deepEqual(errors, []);
    assert.ok(workflow, "the definition parses");
    const state = extra.state ?? W.newRunState(workflow, W.resolveInputs(workflow, inputs).inputs);
    const final = await W.executeWorkflow(workflow, state, { cwd: ws, agents, spawnChild: fakeSpawner(behave, calls), signal: extra.signal });
    return { final, calls, workflow, dir: path.join(W.runsRoot(ws), final.id) };
  };

  // 1. Validation + shipped workflows.
  {
    const bad = W.parseWorkflow(wf(`
name: bad
steps:
  - id: a
    agent: scout
    task: x
  - id: a
    agent: scout
  - id: c
    agent: reviewer
    task: y
    when: { step: zzz }
    gate: { pass: PASS, retry: later }
  - id: later
    agent: scout
    task: z
`), "bad.md", "user");
    const text = bad.errors.join("\n");
    assert.match(text, /needs a task/);
    assert.match(text, /duplicate step ids: a/);
    assert.match(text, /when\.step "zzz"/);
    assert.match(text, /gate\.retry/);
    const { workflows, errors } = W.discoverWorkflows(ws);
    assert.deepEqual(errors, [], "shipped workflows must parse");
    assert.deepEqual(workflows.map((w: { name: string }) => w.name).sort(), ["bugfix", "feature", "research"]);
    ok("validation rejects bad definitions; shipped workflows parse");
  }

  // 2. Order + templating.
  {
    const { final, calls, dir } = await run(`
name: seq
inputs:
  goal: { required: true }
  extra: { default: "none" }
steps:
  - id: first
    agent: scout
    task: "look at {{inputs.goal}} ({{inputs.extra}})"
  - id: second
    agent: planner
    task: "plan from: {{steps.first.output}} / prior {{steps.nope.output?}}!"
`, { goal: "auth" }, (task) => (task.startsWith("look") ? "SCOUT-FINDINGS $& $1" : "PLAN"));
    assert.equal(final.status, "passed");
    assert.deepEqual(calls, ["look at auth (none)", "plan from: SCOUT-FINDINGS $& $1 / prior !"]);
    assert.equal(fs.readFileSync(path.join(dir, "steps", "second.md"), "utf8"), "PLAN");
    ok("steps run in order; outputs, defaults and optional refs template verbatim");
  }

  // 3. Parallel.
  {
    const { final, calls, dir } = await run(`
name: par
steps:
  - id: fan
    parallel:
      - { id: one, agent: scout, task: "angle one" }
      - { id: two, agent: scout, task: "angle two" }
  - id: merge
    agent: planner
    task: "merge {{steps.fan.output}}"
`, {}, (task) => (task.startsWith("angle") ? `R:${task}` : "MERGED"));
    assert.equal(final.status, "passed");
    assert.equal(calls.filter((c) => c.startsWith("angle")).length, 2);
    const merged = calls.find((c) => c.startsWith("merge"));
    assert.ok(merged, "the merge step ran");
    assert.match(merged, /## one\n\nR:angle one/);
    assert.match(merged, /## two\n\nR:angle two/);
    assert.ok(fs.existsSync(path.join(dir, "steps", "fan.md")));
    ok("parallel members all run and their outputs combine for later steps");
  }

  // 4. Gates.
  {
    let reviews = 0;
    const gate = `
name: gated
steps:
  - id: implement
    agent: implementer
    task: "implement. feedback: {{steps.review.output?}}"
  - id: review
    agent: reviewer
    task: "review {{steps.implement.output}}"
    gate: { pass: "/##\\\\s*Verdict\\\\s*\\\\n+\\\\s*PASS/", retry: implement, max_loops: 2 }
`;
    const { final, calls } = await run(gate, {}, (task) => {
      if (task.startsWith("implement")) return "DONE";
      reviews++;
      return reviews < 2 ? "## Verdict\nFAIL\n\n## Summary\nfix the null check" : "## Verdict\nPASS";
    });
    assert.equal(final.status, "passed");
    assert.equal(calls.filter((c) => c.startsWith("implement")).length, 2, "one loop back to implement");
    assert.match(calls[2] ?? "", /feedback: ## Verdict\nFAIL/, "the retried step sees the failing review");
    assert.equal(final.loops.review, 1);
    const never = await run(gate, {}, (task) => (task.startsWith("implement") ? "DONE" : "## Verdict\nFAIL"));
    assert.equal(never.final.status, "failed");
    assert.match(never.final.error ?? "", /gate review did not pass after 2 loop/);
    assert.equal(never.calls.filter((c) => c.startsWith("implement")).length, 3);
    ok("gates loop back with the review attached and stop at max_loops");
  }

  // 4a. A project workflow is repository content, so a gate pattern of the exponential-
  // backtracking class (a quantified group holding a quantifier) is refused by the shared
  // safe-regex check and fails the gate, even on output it would match.
  {
    const refused = `
name: refused-gate
steps:
  - id: review
    agent: reviewer
    task: "review"
    gate: { pass: "/(x+)+y/", retry: review, max_loops: 1 }
`;
    const { final } = await run(refused, {}, () => "xxy");
    assert.equal(final.status, "failed", "a refused gate pattern never passes");
    const plain = refused.replace("/(x+)+y/", "/x+y/");
    assert.equal((await run(plain, {}, () => "xxy")).final.status, "passed", "an ordinary pattern still gates");
    ok("a gate pattern the safe-regex check refuses fails the gate");
  }

  // 4b. The shipped review gates pass only on a final "VERDICT: PASS" line (PRO-6).
  {
    const shipped = W.discoverWorkflows(ws).workflows.filter((w: WorkflowDef) => w.name === "feature" || w.name === "bugfix");
    const pass = shipped.flatMap((w: WorkflowDef) => w.steps.flatMap((s) => (s.gate ? [s.gate.pass] : [])));
    assert.equal(pass.length, 2, "feature and bugfix each ship one review gate");
    assert.equal(pass[0], pass[1], "feature and bugfix use the same gate");
    const gatePattern = pass[0] ?? "";
    const gated = `
name: shipped-gate
steps:
  - id: review
    agent: reviewer
    task: "review"
    gate: { pass: ${JSON.stringify(gatePattern)}, max_loops: 0 }
`;
    const verdictOf = async (reply: string): Promise<string> => (await run(gated, {}, () => reply)).final.status;
    // A reviewer echoing its template, starting with "Passing", or quoting a PASS before its own FAIL.
    for (const ambiguous of [
      "## Verdict\nPASS or FAIL — one line.",
      "## Verdict\nPassing tests are missing, so: FAIL",
      "## Verdict\nFAIL\n\nThe implementer claimed:\n## Verdict\nPASS\n\nVERDICT: FAIL",
      "## Summary\nok\n\nVERDICT: PASS or FAIL",
      "VERDICT: PASS\n\n## Summary\nThe null check is still missing.",
      "## Summary\nok\n\nVERDICT: PASSING",
      "## Summary\nok",
    ]) {
      assert.equal(await verdictOf(ambiguous), "failed", `ambiguous verdict must fail the gate: ${JSON.stringify(ambiguous)}`);
    }
    assert.equal(await verdictOf("## Summary\nThe fix is complete.\n\n## Verdict\nVERDICT: PASS\n"), "passed", "a final VERDICT: PASS line passes the gate");
    ok("shipped review gates pass only on a final VERDICT: PASS line");
  }

  // 5 + 6. Outputs and when.
  {
    const def = `
name: outs
steps:
  - id: write
    agent: implementer
    task: "write report"
    outputs: [report.md]
  - id: celebrate
    agent: scout
    task: "celebrate"
    when: { step: write, status: failed }
  - id: read
    agent: scout
    task: "read {{file:report.md}}"
`;
    const good = await run(def, {}, (task, runDir) => {
      if (task.startsWith("write")) fs.writeFileSync(path.join(runDir, "report.md"), "REPORT-BODY");
      return "ok";
    });
    assert.equal(good.final.status, "passed");
    assert.equal(good.final.steps.celebrate?.status, "skipped");
    assert.ok(good.calls.includes("read REPORT-BODY"), "a later step reads an artefact from the blackboard");
    const bad = await run(def, {}, () => "ok");
    assert.equal(bad.final.status, "failed");
    assert.match(bad.final.error ?? "", /declared output\(s\) not written: report\.md/);
    ok("declared outputs are enforced; artefacts flow through {{file:}}; when skips");
  }

  // 7. Resume after interruption.
  {
    const def = `
name: resumable
steps:
  - id: a
    agent: scout
    task: "step a"
  - id: b
    agent: implementer
    task: "step b after {{steps.a.output}}"
`;
    const ac = new AbortController();
    const first = await run(def, {}, (task) => {
      if (task.startsWith("step b")) {
        setTimeout(() => ac.abort(), 5);
        return { hang: true };
      }
      return "A-OUT";
    }, { signal: ac.signal });
    assert.equal(first.final.status, "interrupted");
    assert.equal(first.final.steps.a?.status, "passed");
    const state = W.loadState(ws, first.final.id);
    const resumed = await run(def, {}, (task) => (task.startsWith("step a") ? "SHOULD-NOT-RUN" : "B-OUT"), { state });
    assert.equal(resumed.final.status, "passed");
    assert.deepEqual(resumed.calls, ["step b after A-OUT"], "only the interrupted step re-runs");
    ok("an interrupted run resumes from the interrupted step");
  }

  // 8. Template safety.
  {
    const esc = await run(`
name: escape
steps:
  - id: a
    agent: scout
    task: "{{file:../../../../etc/passwd}}"
`, {}, () => "x");
    assert.equal(esc.final.status, "failed");
    assert.match(esc.final.error ?? "", /escapes the run directory/);
    const miss = await run(`
name: missing
inputs:
  goal: { description: optional here }
steps:
  - id: a
    agent: scout
    task: "{{inputs.goal}}"
`, {}, () => "x");
    assert.equal(miss.final.status, "failed");
    assert.match(miss.final.error ?? "", /input not provided/);
    ok("templates cannot escape the run directory; missing required values fail the step");
  }

  // 9. Trust gating through the tool.
  {
    fs.mkdirSync(path.join(ws, ".pi", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".pi", "workflows", "local.md"), wf(`
name: local
steps:
  - id: a
    agent: scout
    task: hi
`));
    const subagent = await loadExtension<(api: FakePiApi) => void>("vendor/subagent/index.ts");
    const pi = fakePi();
    subagent(pi.api);
    const tool = pi.tools.get("workflow_run");
    assert.ok(tool, "workflow_run is registered");
    const listed = await tool.execute("1", { name: "list" }, undefined, undefined, { cwd: ws, hasUI: false });
    assert.match(textOf(listed), /local \(project\)/);
    const blocked = await tool.execute("2", { name: "local" }, undefined, undefined, { cwd: ws, hasUI: false });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /needs interactive approval or a digest grant/);
    ok("project workflows are blocked headless without a digest grant");

    // The prompt is a No-first select. `local` needs an input, so a run that passes the trust
    // gate stops at "Missing required input" before any child is spawned.
    fs.writeFileSync(path.join(ws, ".pi", "workflows", "local.md"), wf(`
name: local
inputs:
  goal: { required: true }
steps:
  - id: a
    agent: scout
    task: "{{inputs.goal}}"
`));
    const store = path.join(ws, "agent", "pi-kit", "trusted-workflows.json");
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
      },
    });
    const passedTrust = /Missing required input\(s\) for local/;
    for (const answer of ["No, don't run it", undefined]) {
      const r = await tool.execute("3", { name: "local" }, undefined, undefined, ui(answer));
      assert.equal(r.isError, true);
      assert.match(textOf(r), /Cancelled: project workflow not approved/, `answer ${String(answer)} cancels`);
    }
    assert.deepEqual(prompts[0], ["No, don't run it", "Run once", "Trust this digest"], "No is the first (default) option");
    const once = await tool.execute("4", { name: "local" }, undefined, undefined, ui("Run once"));
    assert.match(textOf(once), passedTrust, "Run once passes the gate");
    assert.equal(fs.existsSync(store), false, "Run once stores no grant");
    const asked = prompts.length;
    await tool.execute("5", { name: "local" }, undefined, undefined, ui("Run once"));
    assert.equal(prompts.length, asked + 1, "Run once asks again next time");
    const stillBlocked = await tool.execute("6", { name: "local" }, undefined, undefined, { cwd: ws, hasUI: false });
    assert.match(textOf(stillBlocked), /needs interactive approval/, "Run once grants nothing headless");
    ok("the trust prompt is a No-first select; No and Esc cancel; Run once is not remembered");

    const trusted = await tool.execute("7", { name: "local" }, undefined, undefined, ui("Trust this digest"));
    assert.match(textOf(trusted), passedTrust, "Trust this digest passes the gate");
    assert.equal(fs.statSync(store).mode & 0o777, 0o600, "the grant store is 0600");
    const saved: unknown = JSON.parse(fs.readFileSync(store, "utf8"));
    assert.ok(typeof saved === "object" && saved !== null && "digests" in saved && Array.isArray(saved.digests) && saved.digests.length === 1);
    const headless = await tool.execute("8", { name: "local" }, undefined, undefined, { cwd: ws, hasUI: false });
    assert.match(textOf(headless), passedTrust, "a trusted digest runs headless");
    const before = prompts.length;
    await tool.execute("9", { name: "local" }, undefined, undefined, ui("Trust this digest"));
    assert.equal(prompts.length, before, "a trusted digest is not asked again");
    const again: unknown = JSON.parse(fs.readFileSync(store, "utf8"));
    assert.ok(typeof again === "object" && again !== null && "digests" in again && Array.isArray(again.digests) && again.digests.length === 1, "the digest is stored once");
    // An edited file has a new digest, so the grant no longer applies.
    fs.appendFileSync(path.join(ws, ".pi", "workflows", "local.md"), "\nedited\n");
    const edited = await tool.execute("10", { name: "local" }, undefined, undefined, { cwd: ws, hasUI: false });
    assert.match(textOf(edited), /needs interactive approval/, "an edited workflow needs a new grant");
    // A malformed store grants nothing; the env grant still works.
    fs.writeFileSync(store, "{not json");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(ws, ".pi", "workflows", "local.md"))).digest("hex");
    const restoreEnv = setEnv("PI_KIT_TRUSTED_WORKFLOWS", `other;${digest}`);
    try {
      const viaEnv = await tool.execute("11", { name: "local" }, undefined, undefined, { cwd: ws, hasUI: false });
      assert.match(textOf(viaEnv), passedTrust, "a PI_KIT_TRUSTED_WORKFLOWS digest runs headless");
    } finally {
      restoreEnv();
    }
    const malformed = await tool.execute("12", { name: "local" }, undefined, undefined, { cwd: ws, hasUI: false });
    assert.match(textOf(malformed), /needs interactive approval/, "a malformed store grants nothing");
    ok("Trust this digest stores a 0600 grant that runs headless until the file changes; env grants still apply");
  }

  // 10. Corrupt/wrong-shape run state must not crash status listing or summarising.
  {
    const roots = W.runsRoot(ws);
    fs.mkdirSync(roots, { recursive: true });
    const fullShape = (overrides: Record<string, unknown> = {}): string =>
      JSON.stringify({
        version: 1,
        id: "x",
        workflow: "w",
        workflowFile: "/tmp/w.md",
        inputs: {},
        status: "running",
        cursor: 0,
        loops: {},
        steps: {},
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        executions: 0,
        ...overrides,
      });
    const bad = {
      "bad-empty": "{}",
      "bad-array": "[]",
      "bad-nulls": '{"id":"x","status":"running","startedAt":null}',
      "bad-minimal": '{"id":"x","steps":{}}',
      "bad-no-started": fullShape({ startedAt: undefined }),
      "bad-status": fullShape({ status: "bogus" }),
      "bad-loops-array": fullShape({ loops: [] }),
      "bad-cursor-negative": fullShape({ cursor: -1 }),
      "bad-cursor-float": fullShape({ cursor: 0.5 }),
      "bad-no-executions": fullShape({ executions: undefined }),
      "bad-step-null": fullShape({ steps: { a: null } }),
      "bad-step-nonobject": fullShape({ steps: { a: "passed" } }),
      "bad-loops-nonnumber": fullShape({ loops: { a: "2" } }),
    };
    const goodStep = fullShape({ steps: { a: { status: "passed", attempts: 1, runIds: ["r1"], cost: 0.01 } }, loops: { a: 1 } });
    for (const [id, body] of Object.entries(bad)) {
      fs.mkdirSync(path.join(roots, id), { recursive: true });
      fs.writeFileSync(path.join(roots, id, "state.json"), body);
    }
    for (const id of Object.keys(bad)) assert.equal(W.loadState(ws, id), null, `${id} rejected by loadState`);
    fs.mkdirSync(path.join(roots, "good-step"), { recursive: true });
    fs.writeFileSync(path.join(roots, "good-step", "state.json"), goodStep);
    assert.notEqual(W.loadState(ws, "good-step"), null, "a well-formed step state is accepted");
    let runs: Array<{ id: string; startedAt: unknown }> = [];
    assert.doesNotThrow(() => {
      runs = W.listRuns(ws, 50);
    }, "listRuns tolerates a corrupt run-state file");
    for (const id of Object.keys(bad)) assert.ok(!runs.some((r) => r.id === id), `${id} skipped by listRuns`);
    assert.ok(runs.length > 0, "well-formed runs are still listed");
    assert.ok(runs.every((r) => typeof r.startedAt === "string"), "listed runs sort on a real startedAt");
    const partial = { id: "partial", workflow: "w", status: "running" };
    // Deliberately not a RunState / WorkflowDef: summarizeRun must survive state read back half-written.
    // @ts-expect-error -- a partial run state on purpose
    assert.doesNotThrow(() => W.summarizeRun(partial), "summarizeRun tolerates missing fields");
    // @ts-expect-error -- a partial run state and workflow on purpose
    assert.match(W.summarizeRun(partial, { steps: [{ id: "a" }] }), /pending/, "a missing step state is reported as pending");
    ok("corrupt run state is skipped/reported instead of crashing status");
  }

  clearInterval(keepalive);
  console.log(`[workflow-smoke] all ${checks} checks passed`);
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
