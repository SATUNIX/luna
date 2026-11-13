#!/usr/bin/env node
// A run its process left "running" is marked interrupted at session start (and resumable), a run
// that is still being written is left alone, and a failed gate says what it read.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type * as Recovery from "../packages/extensions/third_party/subagent/run-recovery.ts";

const ws = tmpWorkspace("pi-kit-wf-recovery-");
const restore = [isolateKitEnv(), setEnv("HOME", path.join(ws, "home")), setEnv("PI_AUTONOMY_HOME", path.join(ws, "autonomy"))];
const runs = path.join(ws, ".pi", "workflows", "runs");

function write(id: string, file: string, body: unknown, ageMs: number): void {
  const target = path.join(runs, id, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(body));
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(target, when, when);
}

const yaml = (id: string, status: string) => ({
  version: 1, id, workflow: "review", workflowFile: "review.yaml", inputs: {}, status, cursor: 1, loops: {},
  steps: { scan: { status: "running", attempts: 1, cost: 0, runIds: [] } },
  startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", executions: 1,
});
const script = (id: string, status: string) => ({ version: 1, kind: "script", id, name: "sweep", scriptPath: "x.js", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status });

try {
  const recovery = await loadModule<typeof Recovery>("vendor/subagent/run-recovery.ts");
  const hour = 3_600_000;
  write("2026-01-01T00-00-00-000Z-review-dead", "state.json", yaml("2026-01-01T00-00-00-000Z-review-dead", "running"), hour);
  write("wf-20260101t000000-dead0001", "run.json", script("wf-20260101t000000-dead0001", "running"), hour);
  write("2026-01-01T00-00-00-000Z-review-busy", "state.json", yaml("2026-01-01T00-00-00-000Z-review-busy", "running"), 1000);
  write("2026-01-01T00-00-00-000Z-review-done", "state.json", yaml("2026-01-01T00-00-00-000Z-review-done", "passed"), hour);

  const marked = recovery.interruptOrphanedRuns(ws).sort();
  assert.deepEqual(marked, ["2026-01-01T00-00-00-000Z-review-dead", "wf-20260101t000000-dead0001"]);
  const status = (id: string, file: string): unknown => (JSON.parse(fs.readFileSync(path.join(runs, id, file), "utf8")) as { status: unknown }).status;
  assert.equal(status("2026-01-01T00-00-00-000Z-review-dead", "state.json"), "interrupted");
  assert.equal(status("wf-20260101t000000-dead0001", "run.json"), "interrupted");
  assert.equal(status("2026-01-01T00-00-00-000Z-review-busy", "state.json"), "running", "a run still being written is not taken");
  assert.equal(status("2026-01-01T00-00-00-000Z-review-done", "state.json"), "passed");
  assert.deepEqual(recovery.interruptOrphanedRuns(ws), [], "announced once: the second scan finds nothing");
  // A quiet run whose recorded owner process is alive (here, another live pid) is never touched.
  const quiet = "2026-01-01T00-00-00-000Z-review-quiet";
  write(quiet, "state.json", yaml(quiet, "running"), 10 * hour);
  write(quiet, "owner.json", { pid: process.ppid }, 10 * hour);
  assert.deepEqual(recovery.interruptOrphanedRuns(ws), [], "a quiet run with a live owner is left alone");
  assert.equal(status(quiet, "state.json"), "running");
  // The same run once its owner is gone (a pid that cannot exist) is marked, even if recently written.
  write(quiet, "owner.json", { pid: 2 ** 22 + 12345 }, 0);
  assert.deepEqual(recovery.interruptOrphanedRuns(ws), [quiet]);
  console.log("  OK: owner-less running runs are marked interrupted once; live and finished runs are left alone");
} finally {
  for (const undo of restore) undo();
  rmWorkspace(ws);
}
console.log("\n[workflow-recovery-smoke] all checks passed");
