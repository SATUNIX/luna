#!/usr/bin/env node
// One run query: every run format, finished or live, across processes (run-query.ts).
//   1. the stores themselves, written as another process would leave them: a finished script run
//      (run.json), a finished YAML run (state.json), a background subagent (runs.jsonl), and the
//      runs.jsonl rows of children their workflow run recorded.
//   2. workflow_status lists every format (on base a script run is invisible) and shows each one:
//      a YAML run's steps, a script run's counters, a subagent run's log tail; an id that could
//      leave the run root is refused.
//   3. queryRuns merges the same stores plus this process's live registry, labelled by format, and
//      a runs.jsonl row that belongs to a run is not listed twice.
//   4. /workflows lists past runs; /workflow is an alias.
//   5. workflow_control stops a background subagent by id, and `all` stops live children and
//      recorded orphans; /workflows stop does the same.
//   6. both firewall policy copies keep workflow_status read_only and workflow_control
//      process_control, and no longer name the removed tools.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv, textOf, tmpWorkspace, ROOT } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type * as Subagent from "../packages/extensions/third_party/subagent/index.ts";
import type * as RunQueryModule from "../packages/extensions/third_party/subagent/run-query.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type { SingleResult } from "../packages/extensions/third_party/subagent/types.ts";

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: () => boolean;
}

// The subagent module as this test drives it: one background launch with a fake child, so the
// live registry and the runs.jsonl row are the runner's own.
type SubagentModule = Omit<typeof Subagent, "default" | "runAgent"> & {
  default: (pi: ReturnType<typeof fakePi>["api"]) => void;
  runAgent: (options: {
    defaultCwd: string;
    agents: AgentConfig[];
    agentName: string;
    task: string;
    background?: boolean;
    spawnChild?: () => FakeChild;
    onSettled?: (result: SingleResult, detached: boolean) => void;
  }) => Promise<SingleResult>;
};

const ws = tmpWorkspace("pi-kit-run-query-");
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());
const restoreIsolation = [
  isolateKitEnv(),
  setEnv("HOME", path.join(ws, "home")),
  setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
  setEnv("PI_KIT_SUBAGENT_RETRIES", "0"),
];

const runsRoot = path.join(ws, ".pi", "workflows", "runs");
const subagentDir = path.join(ws, ".pi", "subagent");

// --- fixtures, exactly as another process leaves them -----------------------------------------

const SCRIPT_ID = "wf-20260101t000000-aaaa0001";
const YAML_ID = "2026-01-01T00-00-00-000Z-review-ab12";
const SUBAGENT_ID = "2026-01-01T00-05-00-000Z-scout-dead01";
const ORPHAN_ID = "2026-01-01T00-10-00-000Z-scout-0rphan";
// A workflow run's child: the runner gives each child its own runs.jsonl id (logging.ts createRunLog)
// and the run records that id, in state.steps[*].runIds for a YAML step and in the journal's
// subagentRunId for a script call. Neither belongs to a background subagent of its own.
const YAML_CHILD_ID = "2026-01-01T00-00-02-000Z-scout-beef01";
const SCRIPT_CHILD_ID = "2026-01-01T00-00-02-500Z-scout-beef02";
const YAML_CHILD_LOG = path.join(subagentDir, `${YAML_CHILD_ID}.log`);
const SCRIPT_CHILD_LOG = path.join(subagentDir, `${SCRIPT_CHILD_ID}.log`);
const SUBAGENT_LOG = path.join(subagentDir, `${SUBAGENT_ID}.log`);

function writeFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

writeFile(
  path.join(runsRoot, SCRIPT_ID, "run.json"),
  `${JSON.stringify(
    {
      version: 1,
      kind: "script",
      id: SCRIPT_ID,
      name: "sweep",
      scriptPath: path.join(runsRoot, SCRIPT_ID, "script.js"),
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:12.000Z",
      status: "passed",
      redacted: true,
      launched: 3,
      cached: 1,
      outputTokens: 120,
    },
    null,
    2,
  )}\n`,
);
writeFile(path.join(runsRoot, SCRIPT_ID, "script.js"), "// fixture\n");
// A script run's journal: its end row records the runs.jsonl id the child launched under.
writeFile(
  path.join(runsRoot, SCRIPT_ID, "journal.jsonl"),
  `${JSON.stringify({
    v: 2,
    seq: 1,
    key: "a".repeat(64),
    label: "step a",
    role: "scout",
    ok: true,
    value: null,
    writer: false,
    definition: "b".repeat(64),
    outputTokens: 40,
    subagentRunId: SCRIPT_CHILD_ID,
  })}\n`,
);
writeFile(
  path.join(runsRoot, YAML_ID, "state.json"),
  `${JSON.stringify(
    {
      version: 1,
      id: YAML_ID,
      workflow: "review",
      workflowFile: "packages/kit/workflows/review.yaml",
      inputs: {},
      status: "passed",
      cursor: 2,
      loops: {},
      steps: {
        scan: { status: "passed", attempts: 1, cost: 0.01, outputTokens: 900, runIds: [YAML_CHILD_ID] },
        "split.b": { status: "passed", attempts: 1, cost: 0.02, outputTokens: 600, runIds: [] },
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
      executions: 2,
    },
    null,
    2,
  )}\n`,
);
writeFile(
  SUBAGENT_LOG,
  `# subagent run ${SUBAGENT_ID}\n# agent=scout depth=1\n# task=scan the tree\n# end status=end\n`,
);
writeFile(YAML_CHILD_LOG, `# subagent run ${YAML_CHILD_ID}\n# agent=scout depth=1\n# task=step scan\n# end status=end\n`);
writeFile(SCRIPT_CHILD_LOG, `# subagent run ${SCRIPT_CHILD_ID}\n# agent=scout depth=1\n# task=step a\n# end status=end\n`);
const registryRows = [
  { ts: "2026-01-01T00:05:00.000Z", id: SUBAGENT_ID, event: "start", agent: "scout", depth: 1, log: SUBAGENT_LOG, task: "scan the tree" },
  { ts: "2026-01-01T00:05:01.000Z", id: SUBAGENT_ID, event: "spawn", pid: 2147483646, agent: "scout", log: SUBAGENT_LOG },
  { ts: "2026-01-01T00:05:03.000Z", id: SUBAGENT_ID, event: "end", status: "end", agent: "scout", turns: 2, cost: 0.0004 },
  // The children of the two workflow runs above: each has its own id, which its run recorded, so
  // the row belongs to that run and is not a background subagent.
  { ts: "2026-01-01T00:00:02.000Z", id: YAML_CHILD_ID, event: "start", agent: "scout", depth: 1, log: YAML_CHILD_LOG, task: "step scan" },
  { ts: "2026-01-01T00:00:02.500Z", id: YAML_CHILD_ID, event: "end", status: "end", agent: "scout", turns: 1, cost: 0.0002 },
  { ts: "2026-01-01T00:00:02.600Z", id: SCRIPT_CHILD_ID, event: "start", agent: "scout", depth: 1, log: SCRIPT_CHILD_LOG, task: "step a" },
  { ts: "2026-01-01T00:00:11.000Z", id: SCRIPT_CHILD_ID, event: "end", status: "end", agent: "scout", turns: 1, cost: 0.0003 },
];
writeFile(path.join(subagentDir, "runs.jsonl"), registryRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// --- the extension, loaded the way the kit loads it -------------------------------------------

const pi = fakePi();
const I = await loadModule<SubagentModule>("vendor/subagent/index.ts");
I.default(pi.api);
const ctx = { cwd: ws, hasUI: true, ui: { notify: () => {} } };
const status = (params: unknown = {}) => pi.tools.get("workflow_status").execute("s", params, undefined, undefined, ctx);
const control = (params: unknown) => pi.tools.get("workflow_control").execute("c", params, undefined, undefined, ctx);

let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const lines = (text: string): string[] => text.split("\n");

// 1-2. workflow_status lists and shows every format.
{
  const listed = textOf(await status());
  const rows = lines(listed).filter((l) => /^- /.test(l));
  assert.ok(rows.some((l) => l.includes(SCRIPT_ID)), `workflow_status must list a finished script run (run.json):\n${listed}`);
  assert.ok(rows.some((l) => new RegExp(`^- ${SCRIPT_ID}: passed · script · sweep · 3 agents`).test(l)), `a script run is labelled script:\n${listed}`);
  assert.ok(rows.some((l) => new RegExp(`^- ${YAML_ID}: passed · yaml · review · 2 agents`).test(l)), `a YAML run is labelled yaml:\n${listed}`);
  assert.ok(rows.some((l) => new RegExp(`^- ${SUBAGENT_ID}: end · subagent · scout · 1 agent`).test(l)), `a background subagent is labelled subagent:\n${listed}`);
  assert.ok(!listed.includes(YAML_CHILD_ID) && !listed.includes(SCRIPT_CHILD_ID), `a workflow run's children are not listed as subagent runs:\n${listed}`);
  assert.equal(rows.length, 3, `the list holds the three runs and none of their children:\n${listed}`);
  ok("workflow_status lists run.json, state.json and runs.jsonl rows, labelled by format");

  const script = textOf(await status({ id: SCRIPT_ID }));
  assert.match(script, /Format: script/);
  assert.match(script, /sweep/);
  assert.match(script, /3 agents launched/);
  assert.match(script, /Run directory:/);
  const yaml = textOf(await status({ id: YAML_ID }));
  assert.match(yaml, /Format: yaml/);
  assert.match(yaml, /split\.b: passed/);
  const subagent = textOf(await status({ id: SUBAGENT_ID }));
  assert.match(subagent, /Format: subagent/);
  assert.match(subagent, /scout/);
  assert.match(subagent, /# end status=end/, "a subagent run shows its log tail");
  // A workflow step's child is not listed, but its id still reads: this is the only way to its log.
  const yamlChild = textOf(await status({ id: YAML_CHILD_ID }));
  assert.match(yamlChild, /Format: subagent/, `a step's child resolves by id:\n${yamlChild}`);
  assert.match(yamlChild, /# task=step scan/, "a YAML step's child shows its own log tail");
  const scriptChild = textOf(await status({ id: SCRIPT_CHILD_ID }));
  assert.match(scriptChild, /Format: subagent/, `a script call's child resolves by id:\n${scriptChild}`);
  assert.match(scriptChild, /# task=step a/, "a script call's child shows its own log tail");
  const listedAfter = textOf(await status());
  assert.ok(!listedAfter.includes(YAML_CHILD_ID) && !listedAfter.includes(SCRIPT_CHILD_ID), "reading a child by id leaves it out of the list");
  const missing = await status({ id: "2026-01-01T00-00-00-000Z-nope-0000" });
  assert.equal(missing.isError, true, "an unknown run id is an error");
  const traversal = await status({ id: "../../etc/passwd" });
  assert.equal(traversal.isError, true, "path traversal is refused");
  assert.match(textOf(traversal), /Invalid run id/);
  ok("workflow_status shows each format, and refuses an id that could leave the run root");
}

// 3. queryRuns merges the stores and this process's live registry.
{
  const Q = await loadModule<typeof RunQueryModule>("vendor/subagent/run-query.ts");
  const live = I.runRegistry.start("2026-01-01T00-20-00-000Z-live-aaaa0002", "yaml", "live-run");
  live.phase("a");
  live.agentStart({ label: "scout", phase: "a", role: "scout" });
  const found = Q.queryRuns(ws, { registry: I.runRegistry });
  const byId = new Map(found.map((r) => [r.id, r]));
  const script = byId.get(SCRIPT_ID);
  assert.equal(script?.format, "script");
  assert.equal(script?.status, "passed");
  assert.equal(script?.agents, 3);
  assert.equal(script?.outputTokens, 120);
  const yaml = byId.get(YAML_ID);
  assert.equal(yaml?.format, "yaml");
  assert.equal(yaml?.agents, 2);
  assert.equal(yaml?.outputTokens, 1500);
  const subagent = byId.get(SUBAGENT_ID);
  assert.equal(subagent?.format, "subagent");
  assert.equal(subagent?.log, SUBAGENT_LOG);
  const inProcess = byId.get("2026-01-01T00-20-00-000Z-live-aaaa0002");
  assert.equal(inProcess?.format, "yaml", "the live registry is merged in");
  assert.equal(inProcess?.status, "running");
  assert.equal(inProcess?.live, true);
  assert.equal(found.filter((r) => r.id === SCRIPT_ID).length, 1, "the script run is listed once");
  assert.equal(byId.get(YAML_CHILD_ID), undefined, "a YAML step's child row belongs to that run, not to a subagent run");
  assert.equal(byId.get(SCRIPT_CHILD_ID), undefined, "a script call's child row belongs to that run, not to a subagent run");
  assert.equal(found.length, 4, "four runs: the script, the YAML, the background subagent and the live one");
  assert.ok(found.every((r) => r.format === "script" || r.format === "yaml" || r.format === "subagent"));
  const only = Q.findRun(ws, SUBAGENT_ID, { registry: I.runRegistry });
  assert.equal(only?.id, SUBAGENT_ID);
  // The hint must be one workflow_status can honour: its limit stops at 100.
  const row = script ?? found[0];
  assert.ok(row, "a run to repeat");
  const limits = (text: string): number[] => [...text.matchAll(/limit: (\d+)/g)].map((match) => Number(match[1]));
  const over = Q.formatRunList(Array.from({ length: 150 }, () => row));
  assert.ok(limits(over).length > 0 && limits(over).every((n) => n <= 100), `the list never suggests a limit above 100:\n${over.slice(-200)}`);
  assert.match(over, /130 more/);
  assert.match(over, /workflow_status \{id\} shows any run/);
  assert.match(Q.formatRunList(Array.from({ length: 40 }, () => row)), /workflow_status \{limit: 40\} lists them all/);
  ok("queryRuns merges run.json, state.json, the unrelated runs.jsonl rows and the live registry");
  live.finish("passed");
}

// 4. /workflows lists past runs, and /workflow is an alias.
{
  const notes: string[] = [];
  const cmdCtx = { cwd: ws, hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
  const workflows = pi.commands.get("workflows");
  assert.ok(workflows, "/workflows is registered");
  await workflows.handler("", cmdCtx);
  const listed = notes.join("\n");
  assert.ok(listed.includes(SCRIPT_ID), `/workflows must list a finished script run:\n${listed}`);
  assert.ok(listed.includes(YAML_ID), `/workflows must list a finished YAML run:\n${listed}`);
  assert.ok(listed.includes(SUBAGENT_ID), `/workflows must list a background subagent:\n${listed}`);
  assert.ok(!listed.includes(YAML_CHILD_ID) && !listed.includes(SCRIPT_CHILD_ID), `/workflows must not list a run's children:\n${listed}`);
  const alias = pi.commands.get("workflow");
  assert.ok(alias, "/workflow is still registered");
  const seen: string[] = [];
  await alias.handler("", { cwd: ws, hasUI: true, ui: { notify: (m: string) => seen.push(m) } });
  assert.ok(seen.join("\n").includes(SCRIPT_ID), "/workflow is an alias of /workflows and lists the same runs");
  await alias.handler(`status ${SCRIPT_ID}`, { cwd: ws, hasUI: true, ui: { notify: (m: string) => seen.push(m) } });
  assert.match(seen.at(-1) ?? "", /Format: script/);
  // `panel` still reaches the live view, now through the one command.
  await workflows.handler("panel", cmdCtx);
  assert.match(notes.at(-1) ?? "", /^Workflows \(/);
  ok("/workflows lists past runs, /workflow is its alias, status <id> shows a past run, and panel opens the live view");
}

// 5. stop: a background subagent by id, then all live children and recorded orphans.
function fakeChild(): { spawnChild: () => FakeChild; killed: () => boolean } {
  let child: FakeChild | undefined;
  return {
    spawnChild: () => {
      const c = new EventEmitter() as FakeChild;
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.killed = false;
      c.kill = () => {
        c.killed = true;
        queueMicrotask(() => c.emit("close", 0));
        return true;
      };
      child = c;
      return c;
    },
    killed: () => child?.killed === true,
  };
}

const agents: AgentConfig[] = [{ name: "scout", description: "fixture", tools: ["read"], systemPrompt: "", source: "user", filePath: "fixture" }];

{
  const fake = fakeChild();
  const launched = await I.runAgent({ defaultCwd: ws, agents, agentName: "scout", task: "long-running background scan", background: true, spawnChild: fake.spawnChild });
  assert.equal(launched.detached, true, "the fixture child is a background run");
  const runId = launched.runId ?? "";
  assert.ok(runId, "a background run has an id");
  const running = textOf(await status({ id: runId }));
  assert.match(running, /Format: subagent/);
  const list = textOf(await status());
  assert.ok(lines(list).some((l) => l.startsWith(`- ${runId}: running (active) · subagent`)), `a live subagent shows in the list:\n${list}`);
  const stopped = await control({ runId, action: "stop" });
  assert.equal(stopped.isError, undefined, textOf(stopped));
  assert.match(textOf(stopped), /Stop sent to running subagent/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.killed(), true, "stopping a background subagent kills its child");
  ok("workflow_control stops a background subagent by id");
}

{
  // A recorded orphan: a live process whose registry row outlived its parent. `cli.js` in the
  // command line is what stopRecordedRun's PID-reuse guard asks for on Linux.
  const cli = path.join(ws, "orphan", "cli.js");
  writeFile(cli, "setTimeout(() => {}, 60000);\n");
  const orphan = spawn(process.execPath, [cli], { stdio: "ignore" });
  process.once("exit", () => orphan.kill()); // a failing case must not leave the fixture running
  const exited = new Promise<string>((resolve) => orphan.once("exit", (code, signal) => resolve(signal ?? String(code))));
  writeFile(
    path.join(subagentDir, "runs.jsonl"),
    fs.readFileSync(path.join(subagentDir, "runs.jsonl"), "utf8") +
      [
        { ts: "2026-01-01T00:10:00.000Z", id: ORPHAN_ID, event: "start", agent: "scout", depth: 1, log: path.join(subagentDir, `${ORPHAN_ID}.log`), task: "orphan" },
        { ts: "2026-01-01T00:10:01.000Z", id: ORPHAN_ID, event: "spawn", pid: orphan.pid, agent: "scout", log: path.join(subagentDir, `${ORPHAN_ID}.log`) },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const fake = fakeChild();
  const launched = await I.runAgent({ defaultCwd: ws, agents, agentName: "scout", task: "second long-running scan", background: true, spawnChild: fake.spawnChild });
  assert.equal(launched.detached, true);
  const all = await control({ action: "stop", all: true });
  assert.equal(all.isError, undefined, textOf(all));
  assert.match(textOf(all), /Stopped 1 live and 1 orphaned subagent\(s\)/);
  assert.equal(await exited, "SIGTERM", "an orphaned child is killed, not just recorded");
  assert.equal(fake.killed(), true, "a live background child is stopped too");
  const registry = fs.readFileSync(path.join(subagentDir, "runs.jsonl"), "utf8");
  assert.match(registry, new RegExp(`"id":"${ORPHAN_ID}","event":"end","status":"stopped-by-operator"`), "the orphan's stop is recorded");
  const after = textOf(await status({ id: ORPHAN_ID }));
  assert.match(after, /stopped-by-operator/);
  ok("workflow_control all stops live children and recorded orphans, and records the orphan's stop");

  // /workflows stop <id|all> uses the same paths.
  const notes: string[] = [];
  const cmdCtx = { cwd: ws, hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
  const fake2 = fakeChild();
  const next = await I.runAgent({ defaultCwd: ws, agents, agentName: "scout", task: "third scan", background: true, spawnChild: fake2.spawnChild });
  const id = next.runId ?? "";
  await pi.commands.get("workflows")?.handler(`stop ${id}`, cmdCtx);
  assert.match(notes.at(-1) ?? "", /Stop sent to running subagent/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake2.killed(), true);
  const fake3 = fakeChild();
  await I.runAgent({ defaultCwd: ws, agents, agentName: "scout", task: "fourth scan", background: true, spawnChild: fake3.spawnChild });
  await pi.commands.get("workflows")?.handler("stop all", cmdCtx);
  assert.match(notes.at(-1) ?? "", /Stopped 1 live and 0 orphaned subagent\(s\)/);
  assert.equal(fake3.killed(), true, "/workflows stop all stops a live background child");
  ok("/workflows stop <id|all> stops background subagents through the same code");
}

// 6. Firewall classes stay, and the removed tools are gone from both copies.
{
  const policyPaths = [path.join(ROOT, "packages/extensions/src/tool-firewall/default-policy.json"), path.join(ROOT, "packages/core/policies/default.json")];
  const [a, b] = policyPaths.map((p) => fs.readFileSync(p, "utf8"));
  assert.equal(a, b, "the two policy copies are byte-identical");
  const policy: unknown = JSON.parse(a ?? "{}");
  const tools: unknown = typeof policy === "object" && policy !== null ? Reflect.get(policy, "tools") : undefined;
  const rule = (name: string): unknown => (typeof tools === "object" && tools !== null ? Reflect.get(tools, name) : undefined);
  assert.equal(Reflect.get(rule("workflow_status") ?? {}, "risk_class"), "read_only");
  assert.equal(Reflect.get(rule("workflow_control") ?? {}, "risk_class"), "process_control");
  assert.equal(rule("subagent_status"), undefined, "subagent_status is gone from the policy");
  assert.equal(rule("subagent_stop"), undefined, "subagent_stop is gone from the policy");
  assert.equal(pi.tools.find("subagent_status"), undefined, "subagent_status is no longer registered");
  assert.equal(pi.tools.find("subagent_stop"), undefined, "subagent_stop is no longer registered");
  assert.equal(pi.commands.find("subagents"), undefined, "/subagents is removed");
  assert.equal(pi.commands.find("subagent-stop"), undefined, "/subagent-stop is removed");
  const notes: string[] = [];
  await pi.commands.get("workflows").handler("", { cwd: ws, hasUI: false, ui: { notify: (m: string) => notes.push(m) } });
  assert.match(notes.join("\n"), new RegExp(SUBAGENT_ID), "/workflows still lists the background subagent");
  ok("workflow_status is read_only and workflow_control process_control; the removed tools and commands are gone and /workflows still lists runs");
}

console.log(`[run-query-smoke] one query over every run format verified (${checks} groups)`);
restoreIsolation.forEach((restore) => restore());
rmWorkspace(ws);
