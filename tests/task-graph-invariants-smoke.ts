#!/usr/bin/env node
/**
 * AG-03 regression coverage: task-graph must actually enforce DAG invariants, not just
 * store notes. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, textOf, type FakeToolResult } from "../packages/core/eval/harness.ts";

type FakePi = ReturnType<typeof fakePi>;

async function loadGraph(): Promise<FakePi> {
  const register = await loadExtension("extensions/task-graph/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

/** A pi tool result: the content blocks the agent sees. */
type ToolResult = FakeToolResult;

async function create(pi: FakePi, cwd: string, title: string, dependsOn?: string[]): Promise<ToolResult> {
  return pi.tools.get("task_create").execute("c", { title, depends_on: dependsOn }, undefined, undefined, { cwd });
}

// Independent-repro shape: two consecutive task_next calls both returned t1.
async function testTaskNextClaimsAtomically() {
  const ws = tmpWorkspace("pi-kit-taskgraph-claim-");
  try {
    const pi = await loadGraph();
    await create(pi, ws, "first task");
    const first = await pi.tools.get("task_next").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.match(textOf(first), /Next: t1/);
    const second = await pi.tools.get("task_next").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.doesNotMatch(textOf(second), /Next: t1/, "a claimed task must not be handed out again");
    assert.match(textOf(second), /No unblocked task|All tasks done/);
  } finally {
    rmWorkspace(ws);
  }
}

// Independent-repro shape: task_complete(t2) succeeded while t2 still depended on
// unfinished t1.
async function testCompleteRejectsUnfinishedDependency() {
  const ws = tmpWorkspace("pi-kit-taskgraph-dep-");
  try {
    const pi = await loadGraph();
    await create(pi, ws, "t1 title");
    await create(pi, ws, "t2 title", ["t1"]);
    const result = await pi.tools.get("task_complete").execute("c", { id: "t2" }, undefined, undefined, { cwd: ws });
    assert.match(textOf(result), /Cannot complete t2.*unfinished dependencies.*t1/s);

    // Completing t1 first must then allow t2.
    await pi.tools.get("task_complete").execute("c", { id: "t1" }, undefined, undefined, { cwd: ws });
    const ok = await pi.tools.get("task_complete").execute("c", { id: "t2" }, undefined, undefined, { cwd: ws });
    assert.match(textOf(ok), /Completed t2/);
  } finally {
    rmWorkspace(ws);
  }
}

// Independent-repro shape: task_update(t1, "teleported") persisted the invalid state.
async function testUpdateRejectsInvalidStatus() {
  const ws = tmpWorkspace("pi-kit-taskgraph-status-");
  try {
    const pi = await loadGraph();
    await create(pi, ws, "t1 title");
    const result = await pi.tools.get("task_update").execute("c", { id: "t1", status: "teleported" }, undefined, undefined, { cwd: ws });
    assert.match(textOf(result), /Invalid status/);
    const list = await pi.tools.get("task_list").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.match(textOf(list), /\[pending\]/, "the task's status must remain unchanged, not \"teleported\"");
  } finally {
    rmWorkspace(ws);
  }
}

// M-05: missing and self-referential dependencies must both be rejected at creation
// (a task cannot be given an id-dependency on itself, and cannot depend on a task that
// does not exist yet).
async function testDependencyValidation() {
  const ws = tmpWorkspace("pi-kit-taskgraph-cycles-");
  try {
    const pi = await loadGraph();
    const missing = await create(pi, ws, "bad task", ["t99"]);
    assert.match(textOf(missing), /unknown task/);

    // The first task created in a fresh graph is always assigned id "t1" (nextId()),
    // so a self-referential depends_on: ["t1"] is deterministically reachable here.
    const selfRef = await create(pi, ws, "self-dep", ["t1"]);
    assert.match(textOf(selfRef), /own id/);

    // Confirm the rejected task was never actually created.
    const list = await pi.tools.get("task_list").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.match(textOf(list), /no tasks/);
  } finally {
    rmWorkspace(ws);
  }
}

// WU-2: a corrupted graph (a non-object task element and a task object missing
// dependsOn) must not crash the read paths. Seeded directly on disk to simulate an
// externally-edited/legacy graph that load() accepted verbatim.
async function testCorruptGraphDoesNotCrashReadPaths() {
  const ws = tmpWorkspace("pi-kit-taskgraph-corrupt-");
  try {
    const pi = await loadGraph();
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "task-graph.json"),
      JSON.stringify({ tasks: [42, { id: "t1", title: "missing dependsOn", status: "pending" }] }),
      "utf8",
    );
    const list = await pi.tools.get("task_list").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.equal(typeof textOf(list), "string");
    const next = await pi.tools.get("task_next").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.equal(typeof textOf(next), "string");
  } finally {
    rmWorkspace(ws);
  }
}

// ORC-10: load() builds each task from checked fields. An unknown status is repaired to
// "blocked" (never claimed, never counted done), non-string dependencies are dropped, and a
// non-string title falls back to the id, so no tool sees a value its type says cannot exist.
async function testMisshapenTaskFieldsAreRepaired() {
  const ws = tmpWorkspace("pi-kit-taskgraph-fields-");
  try {
    const pi = await loadGraph();
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "task-graph.json"),
      JSON.stringify({ tasks: [{ id: "t1", title: 5, status: "teleported", dependsOn: [null, "t0"] }] }),
      "utf8",
    );
    const list = await pi.tools.get("task_list").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.equal(textOf(list), "- t1 [blocked] t1 (deps t0:missing)");
    const next = await pi.tools.get("task_next").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.match(textOf(next), /No unblocked task/);
  } finally {
    rmWorkspace(ws);
  }
}

// ORC-11: an implementer that crashed after task_next held its task in_progress forever, so
// task_next answered "No unblocked task". A claim older than the lease now returns to pending
// and is handed out again; task_update on an in_progress task renews the lease.
async function testExpiredClaimIsReclaimed() {
  const ws = tmpWorkspace("pi-kit-taskgraph-lease-");
  const previous = process.env.PI_KIT_TASK_GRAPH_LEASE_MS;
  try {
    const pi = await loadGraph();
    const next = () => pi.tools.get("task_next").execute("c", {}, undefined, undefined, { cwd: ws });
    await create(pi, ws, "first task");
    assert.match(textOf(await next()), /Next: t1/);
    const file = path.join(ws, ".pi", "task-graph.json");
    const claimed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(typeof claimed === "object" && claimed !== null && "tasks" in claimed && Array.isArray(claimed.tasks));
    const tasks: unknown[] = claimed.tasks;
    const task = tasks[0];
    assert.ok(typeof task === "object" && task !== null && "claimedAt" in task && typeof task.claimedAt === "string", "task_next records when it claimed the task");
    assert.match(textOf(await next()), /No unblocked task/, "a live claim is not handed out again");
    // Age the claim past the lease, as a crashed implementer would leave it.
    fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...task, claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }] }));
    const again = textOf(await next());
    assert.match(again, /Reclaimed expired claim\(s\): t1/);
    assert.match(again, /Next: t1/, "an expired claim is handed out again");
    // A sign of life renews the lease: a two-hour-old claim renewed by task_update stays claimed.
    fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...task, claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }] }));
    await pi.tools.get("task_update").execute("c", { id: "t1", notes: "still working" }, undefined, undefined, { cwd: ws });
    assert.match(textOf(await next()), /No unblocked task/, "task_update renews the claim");
    // PI_KIT_TASK_GRAPH_LEASE_MS=0 disables expiry.
    process.env.PI_KIT_TASK_GRAPH_LEASE_MS = "0";
    fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...task, claimedAt: new Date(0).toISOString() }] }));
    assert.match(textOf(await next()), /No unblocked task/, "a lease of 0 never expires a claim");
  } finally {
    if (previous === undefined) delete process.env.PI_KIT_TASK_GRAPH_LEASE_MS; else process.env.PI_KIT_TASK_GRAPH_LEASE_MS = previous;
    rmWorkspace(ws);
  }
}

// ORC-11: there was no way to clear the graph, so a second mission in the same project saw the
// first mission's tasks. task_clear removes them all.
async function testTaskClearEmptiesTheGraph() {
  const ws = tmpWorkspace("pi-kit-taskgraph-clear-");
  try {
    const pi = await loadGraph();
    await create(pi, ws, "old mission task");
    await create(pi, ws, "another", ["t1"]);
    const clear = pi.tools.get("task_clear");
    assert.ok(clear, "task_clear is registered");
    assert.match(textOf(await clear.execute("c", {}, undefined, undefined, { cwd: ws })), /Cleared 2 task\(s\)/);
    assert.equal(textOf(await pi.tools.get("task_list").execute("c", {}, undefined, undefined, { cwd: ws })), "(no tasks)");
    assert.match(textOf(await create(pi, ws, "new mission task")), /Created t1/, "ids restart for the new plan");
  } finally {
    rmWorkspace(ws);
  }
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [
  ["task_next claims a task atomically, does not hand it out twice", testTaskNextClaimsAtomically],
  ["task_complete rejects completion with unfinished dependencies", testCompleteRejectsUnfinishedDependency],
  ["task_update rejects an invalid status value", testUpdateRejectsInvalidStatus],
  ["task_create rejects missing/self-referential dependencies", testDependencyValidation],
  ["corrupt graph does not crash the task read paths", testCorruptGraphDoesNotCrashReadPaths],
  ["task_next hands out an expired claim again; task_update renews it", testExpiredClaimIsReclaimed],
  ["task_clear empties the graph", testTaskClearEmptiesTheGraph],
  ["misshapen task fields are repaired on load (ORC-10)", testMisshapenTaskFieldsAreRepaired],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\n[task-graph-invariants-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[task-graph-invariants-smoke] all ${tests.length} checks passed`);
