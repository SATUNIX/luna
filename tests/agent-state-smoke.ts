#!/usr/bin/env node
/**
 * Agent-state files: the schema every Luna agent writes (packages/core/shared/agent-state.ts) and
 * the run-end report an autonomous run adds (packages/autonomy/lib/agent-report.ts): a state file
 * for every state change, and an outcome.md the moment the run is no longer working. Offline.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_STATES, TAIL_MAX, agentStateDir, buildAgentState, parseAgentState, readAgentStates, writeAgentState } from "../packages/core/shared/agent-state.ts";
import { reportRun } from "../packages/autonomy/lib/agent-report.ts";
import { newState, transition } from "../packages/autonomy/lib/lifecycle.ts";
import { resolveContract } from "../packages/autonomy/lib/contract.ts";
import { implementRaw, testEffort } from "./autonomy-helpers.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-agent-state-"));
try {
  // One shape: every state round-trips, and what is not a state file is not read as one.
  for (const state of AGENT_STATES) {
    const built = buildAgentState({ id: `a-${state}`, state, source: "session", waitingFor: "approve bash", tail: "x".repeat(TAIL_MAX * 3), costUsd: 1.5 });
    assert.deepEqual(parseAgentState(JSON.parse(JSON.stringify(built))), built, `${state} round-trips`);
    assert.equal(built.waitingFor !== undefined, state === "blocked", "waitingFor exists only while blocked");
    assert.equal(built.tail?.length, TAIL_MAX, "the tail is capped");
  }
  assert.equal(parseAgentState({ schema: 1, id: "x", state: "sleeping", source: "session", pid: 1, since: "", updatedAt: "" }), null, "an unknown state is refused");
  assert.equal(parseAgentState({ schema: 2 }), null);
  assert.equal(buildAgentState({ id: "../../etc/passwd", state: "working", source: "session" }).id.includes("/"), false, "an id is a file name, never a path");
  const first = buildAgentState({ id: "s", state: "working", source: "session", now: new Date(1000) });
  assert.equal(buildAgentState({ id: "s", state: "working", source: "session", now: new Date(9000), previous: first }).since, first.since, "since is kept while the state is unchanged");
  assert.notEqual(buildAgentState({ id: "s", state: "done", source: "session", now: new Date(9000), previous: first }).since, first.since, "and moves when it changes");
  assert.equal(agentStateDir({ LUNA_AGENT_STATE_DIR: dir }, "/nonexistent-home"), dir);
  assert.match(agentStateDir({}, "/nonexistent-home"), /\.local[/\\]state[/\\]luna[/\\]agents$/, "default: the state home, never pi's agent directory");

  // A writer that cannot write reports it instead of throwing.
  const file = path.join(dir, "blocker");
  fs.writeFileSync(file, "");
  assert.equal(writeAgentState(path.join(file, "nested"), first), false);
  fs.writeFileSync(path.join(dir, "junk.json"), "{not json");
  assert.equal(readAgentStates(dir).length, 0, "a foreign or half-written file is not an agent");

  // An autonomous run reports each state and leaves outcome.md when it stops working.
  const resolved = resolveContract(implementRaw(), { effort: testEffort });
  assert.ok(resolved.ok);
  const c = resolved.contract;
  const at = "2026-09-30T00:00:00.000Z";
  let run = newState({ contract: c, contractDigest: "c".repeat(64), boundaryDigest: "b".repeat(64), authorisation: { boundaryDigest: "b".repeat(64), by: "test", at, via: "contract" }, effort: c.effort, now: at });
  const home = path.join(dir, "runs");
  const root = path.join(home, run.run);
  fs.mkdirSync(root, { recursive: true });
  const paths = { root, work: path.join(root, "work") };
  const env = { LUNA_AGENT_STATE_DIR: path.join(dir, "agents") };
  const step = (to: Parameters<typeof transition>[1], info: Parameters<typeof transition>[2] = {}) => { run = transition(run, to, { at, by: "test", ...info }); reportRun(run, paths, env); };
  const mine = () => readAgentStates(env.LUNA_AGENT_STATE_DIR).find((a) => a.id === `autonomy-${run.run}`);
  step("ready"); step("running");
  assert.equal(mine()?.state, "working");
  assert.equal(fs.existsSync(path.join(root, "outcome.md")), false, "no outcome while it works");
  step("blocked", { reason: "question", blocker: { kind: "question", id: "q", method: "input", question: "Which database?" } });
  assert.deepEqual([mine()?.state, mine()?.waitingFor], ["blocked", "Which database?"]);
  assert.match(fs.readFileSync(path.join(root, "outcome.md"), "utf8"), /Which database\?/, "a blocked run says what it waits for");
  step("running"); step("budget_exhausted", { reason: "total_usd", detail: "spent $9" });
  assert.equal(mine()?.state, "parked", "an exhausted budget parks the run");
  assert.match(fs.readFileSync(path.join(root, "outcome.md"), "utf8"), /budget_exhausted/);
  step("paused", { reason: "limits raised", by: "reconfigure" }); step("running"); step("failed", { reason: "boundary_violation" });
  assert.equal(mine()?.state, "failed");

  // A run in a home of its own, with no override, never writes into the user's state.
  const before = fs.existsSync(agentStateDir({}, os.homedir())) ? readAgentStates(agentStateDir({}, os.homedir())).length : 0;
  reportRun(run, paths, {});
  assert.ok(fs.existsSync(path.join(home, ".agents")), "it reports beside its home");
  const after = fs.existsSync(agentStateDir({}, os.homedir())) ? readAgentStates(agentStateDir({}, os.homedir())).length : 0;
  assert.equal(after, before, "and the user's state is untouched");
  console.log("agent-state-smoke: OK");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
