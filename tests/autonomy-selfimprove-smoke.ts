#!/usr/bin/env node
/**
 * DETERMINISTIC FAKE-RUNTIME tests of the self-improve template running through the generic
 * engine (packages/autonomy/lib/templates/self-improve.ts): the v0 behaviour, now one optional
 * template. Not a real-provider run: the worker and the manager/review models are scripted, the
 * git work (host mirror, integration branch, merges, tags, local publication) is real.
 *   - charter/backlog/handoff seeded from the CONTRACT on a configurable integration branch
 *   - cycles merged only after passing the acceptance checks and a merge review
 *   - a red cycle is kept as a tag and offered to the next cycle as attempts/<run>/cycle-NN
 *   - nothing-found stop, cycle limit, manager triggers, a blocking question
 *   - promotion defaults to LOCAL only: no remote is contacted unless the contract lists one
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, makeChecker, testEffort, type RawContract } from "./autonomy-helpers.ts";
import { cleanup, fakeAlive, harness, runOnce, scratch, NODE_EXIT, type Harness, type HarnessRuntime, type ManagerFn, type ScriptContext } from "./autonomy-harness.ts";
import { resolveContract } from "../packages/autonomy/lib/contract.ts";
import { exportRun } from "../packages/autonomy/lib/export.ts";
import { runtimeConfig } from "../packages/autonomy/lib/runcfg.ts";

const { check, done } = makeChecker("autonomy-selfimprove-smoke");
/** One host-side model call the scripted manager saw. */
interface ManagerCall {
  system: string;
  user: string;
  model: string;
}

/** What the scripted manager answers: a merge-review verdict and/or a manager decision. */
interface ManagerScript {
  review?: string;
  manager?: Record<string, unknown>;
}

type ResolveResult = ReturnType<typeof resolveContract>;

/** The resolved contract of a successful resolution (narrows away the null of a failed one). */
const contractOf = (r: ResolveResult): Extract<ResolveResult, { ok: true }>["contract"] => {
  assert.ok(r.ok, JSON.stringify(r.problems));
  return r.contract;
};

/** The host mirror's git runner; fake-runtime.ts opens the mirror before any cycle, so it is set by the time a test reads it. */
const mirrorGit = (rt: HarnessRuntime): NonNullable<HarnessRuntime["repo"]["g"]> => {
  const g = rt.repo.g;
  assert.ok(g, "the host mirror is open");
  return g;
};

const gitIn = (cwd: string, args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const sh = (cwd: string, ...args: string[]): string => { const r = gitIn(cwd, args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

function sourceRepo(): string {
  const src = scratch();
  sh(src, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(src, "README.md"), "hello\n");
  sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "base");
  return src;
}

const improveRaw = (src: string, over: RawContract = {}): RawContract => ({
  schemaVersion: 1, run: "improve-test-1", template: "self-improve",
  objective: { title: "Improve", spec: "Fix what is broken, and add the audit marker.", backlog: [{ id: "B-1", title: "Add the audit marker", detail: "A file called AUDIT_OK must exist." }] },
  inputs: { repository: { path: src, ref: "main" } },
  acceptance: { checks: [{ id: "gate", run: NODE_EXIT("require('fs').existsSync('AUDIT_OK')"), timeoutMinutes: 1, required: true }], review: true },
  permissions: { unattended: { authorised: true, autoApprove: true } },
  budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 8, maxMinutes: 5000 },
  promotion: { policy: "local-branch", destinations: [{ kind: "local-branch", repo: src, branch: "pi-autonomy/integration" }] },
  templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, limits: { nothingFoundToStop: 2 } },
  ...over,
});

/** The item at `i`, failing when the test expected more items than there are. */
const nth = <T>(items: readonly T[], i: number): T => {
  const item = items[i];
  assert.ok(item !== undefined, `expected an item at index ${i} of ${items.length}`);
  return item;
};

const cycleDirOf = (message: string): string | undefined => message.match(/`(autonomy\/cycles\/[^`/]+\/\d+)\//)?.[1];
const report = (t: ScriptContext, outcome: string, mode = "fix", extra = ""): void => t.write(`${cycleDirOf(nth(t.prompts, 0))}/report.md`, `Outcome: ${outcome}\nMode: ${mode}\n\n${extra}\n`);
const mergeReview = (verdict = "MERGE"): string => JSON.stringify({ verdict, reason: verdict === "MERGE" ? "evidenced and tested" : "no test for the change", concerns: [] });
const manager = (calls: ManagerCall[], decide?: ManagerScript): ManagerFn => async (system: string, user: string, model: string): Promise<string> => {
  calls.push({ system, user, model });
  if (/You review one cycle/.test(system)) return mergeReview(decide?.review ?? "MERGE");
  return decide?.manager ? JSON.stringify(decide.manager) : JSON.stringify({ decision: "CONTINUE", reason: "fine", extendMinutes: 10 });
};

await check("heartbeat follows engine ticks independently of the lock timer; STOP before setup cancels without starting workers", async () => {
  const h = harness(improveRaw(sourceRepo()));
  const made = h.engine();
  made.engine.state = h.state();
  made.engine.go("ready"); made.engine.go("running");
  made.engine.state.phase = "work";
  made.engine.state.step = 7;
  made.engine.tick();
  const beat = path.join(h.store.p.root, "heartbeat.json");
  const before = fs.readFileSync(beat, "utf8");
  h.clock.now += 30_000;
  made.engine.state.phase = "review";
  made.engine.tick();
  assert.notEqual(fs.readFileSync(beat, "utf8"), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(beat, "utf8")), { at: new Date(h.clock.now).toISOString(), phase: "review", cycle: 7, status: "running" });
  made.lock.release();
  const stopped = harness(improveRaw(sourceRepo()));
  fs.writeFileSync(path.join(stopped.store.p.root, "STOP"), "");
  const r = await runOnce(stopped);
  assert.deepEqual([r.state.status, r.state.outcome?.reason], ["cancelled", "stop_file"]);
  assert.equal(r.rt.calls.prepare, 0);
  assert.equal(r.rt.calls.workers.length, 0);
});

await check("v0 behaviour through the engine: seeded from the contract, cycles merged after gate and review, nothing-found ends the run; the result is a LOCAL branch only", async () => {
  const src = sourceRepo();
  const baseSha = sh(src, "rev-parse", "HEAD");
  const calls: ManagerCall[] = []; const prompts: string[] = [];
  const h = harness(improveRaw(src), {
    manager: manager(calls),
    script: async (t) => {
      prompts.push(t.message);
      t.spend(0.1);
      if (prompts.length === 1) { t.write("AUDIT_OK", "1\n"); report(t, "successful", "fix", "Added the marker."); }
      else report(t, "nothing found", "fix", "Checked every backlog item.");
      t.commit(`cycle ${prompts.length}`);
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.deepEqual([state.outcome?.status, state.outcome?.reason], ["succeeded", "backlog_exhausted"], "several nothing-found cycles in a row end the run");
  const si = state.selfImprove;
  assert.ok(si, "the self-improve record is kept in state");
  assert.deepEqual(si.history.map((c) => [c.n, c.outcome, c.gate, c.merged, c.reportOutcome]), [[1, "completed", "green", true, "successful"], [2, "completed", "green", true, "nothing found"], [3, "completed", "green", true, "nothing found"]]);
  assert.equal(si.merged, 3);
  assert.equal(state.acceptance.latest?.allRequiredPass, true, "the run ends with a green acceptance run on the integration head as evidence");
  // Seeded from the contract: the objective, the acceptance checks and the backlog, on a configurable branch.
  const integration = mirrorGit(rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]);
  const charter = rt.repo.fileAt(integration, "autonomy/CHARTER.md") ?? "";
  assert.match(charter, /Fix what is broken, and add the audit marker\./);
  assert.match(charter, /- gate \(required\)/, "the checks are listed, without their definitions' source");
  assert.doesNotMatch(charter, /pi-system|check:all|mkdocs|gitleaks|home\.internal/i, "the seed is general, not specific to one repository");
  assert.match(rt.repo.fileAt(integration, "autonomy/BACKLOG.md") ?? "", /\| B-1 \| open \| P2 \| \*\*Add the audit marker\.\*\* A file called AUDIT_OK must exist\./);
  assert.match(rt.repo.fileAt(integration, "autonomy/HANDOFF.md") ?? "", /first run: improve-test-1/);
  assert.match(nth(prompts, 0), /You are working on the repository in \/work, on branch `pi\/improve-test-1`/);
  assert.doesNotMatch(nth(prompts, 0), /pi-system repository/);
  assert.match(nth(prompts, 0), /cycle 1 of 8/);
  assert.match(nth(prompts, 1), /Cycle 01 ended completed \(report recorded\); acceptance green; merged into pi-autonomy\/integration/);
  assert.match(nth(prompts, 2), /found nothing to do/);
  // Promotion: a LOCAL branch in the source repository, and nothing else. No tags, no working branch, main untouched.
  assert.equal(sh(src, "rev-parse", "refs/heads/pi-autonomy/integration"), integration);
  assert.equal(sh(src, "rev-parse", "refs/heads/main"), baseSha);
  assert.equal(sh(src, "tag", "--list"), "", "no tags are published by a local-branch promotion");
  assert.deepEqual(sh(src, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort(), ["refs/heads/main", "refs/heads/pi-autonomy/integration"], "the working branch never leaves the run");
  assert.ok(calls.filter((c) => /You review one cycle/.test(c.system)).length === 3, "each merged cycle was reviewed");
  assert.equal(calls.filter((c) => !/You review one cycle/.test(c.system)).length, 0, "the manager was never asked: no trigger fired");
  assert.deepEqual(fakeAlive(h.fakeEngine), []);
  assert.ok(state.usage.usd >= 0.3 && state.usage.steps === 3);
  assert.equal(state.promotion.status, "done");
});

await check("a red cycle is not merged: it keeps its tag, and the next cycle is told where to find it; a cycle limit ends the run as cycles_done", async () => {
  const src = sourceRepo();
  const prompts: string[] = [];
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      prompts.push(t.message);
      if (prompts.length === 1) { t.write("attempt.txt", "no marker yet\n"); report(t, "successful"); }
      else { t.write("AUDIT_OK", "1\n"); report(t, "successful"); }
      t.commit(`cycle ${prompts.length}`);
    },
  });
  const { state, rt } = await runOnce(h);
  const [c1, c2] = state.selfImprove?.history ?? [];
  assert.ok(c1 && c2, "two cycles are recorded");
  assert.deepEqual([c1.gate, c1.merged, c1.mergeReason], ["red", false, "acceptance checks failed"]);
  assert.deepEqual([c1.gateFailing], [["gate"]]);
  assert.ok(mirrorGit(rt)(["rev-parse", "--verify", "refs/tags/pi/improve-test-1/cycle-01"]), "the unmerged cycle is kept under its tag");
  assert.match(nth(prompts, 1), /not merged into pi-autonomy\/integration: acceptance checks failed\..*origin\/attempts\/improve-test-1\/cycle-01/s);
  const remoteBranches = spawnSync("git", ["--git-dir", rt.p.remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).stdout;
  assert.match(remoteBranches, /refs\/heads\/attempts\/improve-test-1\/cycle-01/, "the worker's repository offers the attempt as a branch");
  assert.deepEqual([c2.gate, c2.merged], ["green", true]);
  assert.deepEqual([state.status, state.outcome?.reason], ["succeeded", "cycles_done"], "the planned cycles are done, and the last integration head passes the checks");
  assert.equal(state.usage.steps, 2);
  // A merge review that says REJECT keeps a green cycle out too.
  const src2 = sourceRepo();
  const h2 = harness(improveRaw(src2, { run: "improve-test-2", budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), { manager: manager([], { review: "REJECT" }), script: async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("c"); } });
  const rej = await runOnce(h2);
  assert.deepEqual([rej.state.selfImprove?.history[0]?.merged, rej.state.selfImprove?.history[0]?.review], [false, "REJECT"]);
  assert.match(rej.state.selfImprove?.history[0]?.mergeReason ?? "", /review REJECT: no test for the change/);
  assert.equal(sh(src2, "rev-parse", "refs/heads/pi-autonomy/integration"), rej.state.selfImprove?.seedSha, "only the seed commit is published: the one cycle was rejected");
  assert.equal(rej.state.status, "failed", "the integration head (the seed) does not pass the checks, so the run cannot claim success");
  assert.equal(rej.state.outcome?.reason, "final_gate_red");
});

await check("the manager is asked only on triggers; a NUDGE is steered into the live session and the cycle completes", async () => {
  const src = sourceRepo();
  const calls: ManagerCall[] = []; const prompts: Array<{ kind: string; message: string }> = [];
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager(calls, { manager: { decision: "NUDGE", reason: "silent for 20 minutes", message: "Run the acceptance checks now." } }),
    script: async (t) => {
      prompts.push({ kind: t.kind, message: t.message });
      if (prompts.length === 1) { t.hang(); return; } // the session goes quiet
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("marker");
    },
  });
  const { state } = await runOnce(h);
  const asked = calls.filter((c) => !/You review one cycle/.test(c.system));
  assert.equal(asked.length, 1, asked.map((c) => c.user.split('\n')[0]).join(' | '));
  assert.match(nth(asked, 0).user, /Trigger\(s\): idle:0/);
  assert.equal(nth(prompts, 1).kind, "steer");
  assert.equal(nth(prompts, 1).message, "Run the acceptance checks now.");
  assert.equal(state.selfImprove?.history[0]?.merged, true);
  assert.deepEqual(state.selfImprove?.history[0]?.decisions.map((d) => d.decision), ["NUDGE"]);
  assert.ok(fs.existsSync(path.join(h.store.p.steps, "01", "decisions.jsonl")), "manager decisions are logged per cycle");
});

await check("a question from the worker blocks the run with the question recorded; `answer` resumes the SAME cycle in a briefed session; approvals never reach a person", async () => {
  const src = sourceRepo();
  const prompts: string[] = [];
  const h: Harness = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    hooks: { onSleep: () => { const s = h.state(); if (s.status === "blocked" && !h.answered) { h.answered = true; h.cycleWhenBlocked = s.selfImprove?.current?.n; h.store.enqueue("answer", { text: "Name the marker AUDIT_OK." }); } } },
    script: async (t) => {
      prompts.push(t.message);
      t.ask({ method: "confirm", title: "Run the formatter?" });
      if (prompts.length === 1) { t.ask({ method: "input", title: "What should the marker be called?" }); return; }
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("marker");
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.equal(h.cycleWhenBlocked, 1, "the cycle stays current while blocked");
  assert.equal(state.selfImprove?.history.length, 1, "the answered session finished cycle 1; no new cycle was started");
  assert.match(nth(prompts, 1), /The previous session of this cycle was interrupted/);
  assert.match(nth(prompts, 1), /Operator: Name the marker AUDIT_OK\./);
  assert.equal(state.ui?.blocked, 1);
  assert.ok(state.ui?.autoAnswered >= 2, "the approvals were answered without asking anyone");
  assert.equal(state.pendingQuestions.length, 1);
  assert.match(nth(state.pendingQuestions, 0).question, /What should the marker be called\?/);
});

await check("promotion is local by default and pushes only where the contract lists a destination; an approval-gated push waits for `promote`", async () => {
  const bare = scratch();
  sh(bare, "init", "--quiet", "--bare");
  const pushRaw = (src: string, approval: boolean): RawContract => improveRaw(src, { run: approval ? "improve-test-4" : "improve-test-3", budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 },
    promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: approval } });
  // The contract's URL is a placeholder; the test points the destination at a local bare repository through the runtime config.
  const script = async (t: ScriptContext): Promise<void> => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("marker"); };
  const src = sourceRepo();
  const h = harness(pushRaw(src, false), { manager: manager([]), script, cfgOverride: { integrationRemote: bare, gitRemote: bare } });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  const refs = sh(bare, "for-each-ref", "--format=%(refname)").split("\n").sort();
  assert.deepEqual(refs, ["refs/heads/pi-autonomy/integration", "refs/tags/pi/improve-test-3/cycle-01"], "the integration branch and this run's tags only; not the working branch, not main");
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), mirrorGit(rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]));
  assert.throws(() => rt.repo.promotePush(bare, "pi-autonomy/integration", state.selfImprove?.seedSha ?? ""), /failed/, "a clean scan does not permit rewinding the destination");
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), mirrorGit(rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]));
  // Approval required: nothing leaves the mirror until the operator promotes.
  const bare2 = scratch();
  sh(bare2, "init", "--quiet", "--bare");
  const h2 = harness(pushRaw(sourceRepo(), true), { manager: manager([]), script, cfgOverride: { integrationRemote: bare2, gitRemote: bare2 } });
  const waiting = await runOnce(h2);
  assert.equal(waiting.state.status, "succeeded");
  assert.equal(waiting.state.promotion.status, "awaiting_approval");
  assert.equal(sh(bare2, "for-each-ref"), "", "no push without approval");
  const promoted = await waiting.engine.promote({ sha: mirrorGit(waiting.rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]), approved: true });
  assert.equal(promoted.status, "done");
  assert.equal(sh(bare2, "rev-parse", "refs/heads/pi-autonomy/integration"), mirrorGit(waiting.rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]));
});

await check("dead workers restart on the next tick without spending manager calls, including zero and unknown exits; the restart budget survives resume", async () => {
  for (const code of [0, 137, undefined]) {
    const calls: ManagerCall[] = [];
    const starts: number[] = [];
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
      manager: manager(calls),
      script: async (t) => {
        starts.push(t.runtime.clock.now);
        if (t.attempt <= 3) {
          if (code === undefined) { t.agent.alive = false; t.runtime.engine.containers.delete(t.agent.name); t.agent.resolveExit(undefined); }
          else t.exit(code);
          return;
        }
        assert.match(t.message, /previous worker process exited/);
        t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("recovered");
      },
    });
    const { state, rt } = await runOnce(h);
    assert.equal(state.selfImprove?.history[0]?.attempts, 4);
    assert.equal(state.selfImprove?.history[0]?.merged, true);
    assert.equal(calls.filter((c) => !/You review one cycle/.test(c.system)).length, 0);
    assert.ok(starts.every((at, i) => i === 0 || at - nth(starts, i - 1) === rt.tickMs), "restart happens on the next tick, before idle detection");
  }
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { limits: { autoRestartsPerCycle: 1 } } }), {
    script: async (t) => { if (t.attempt === 2) t.store.enqueue("pause"); t.crash(); },
  });
  // Stop the parked supervisor after it has processed pause; the current cycle survives.
  const first = h.engine();
  first.rt.hooks.onSleep = () => { if (h.state().status === "paused") first.engine.signalled = true; };
  await first.engine.run();
  assert.equal(h.state().selfImprove?.current?.autoRestarts, 1);
  h.store.enqueue("unpause");
  const resumed = await runOnce(h, { rt: h.runtime(async (t) => { t.crash(); }) });
  assert.equal(resumed.rt.calls.workers.length, 1, "resume cannot replenish a cycle's automatic restart allowance");
  assert.equal(resumed.state.selfImprove?.history[0]?.reason, "auto_restarts_exhausted");
});

await check("automatic restart limit is configurable, validated, and independent of generic recovery knobs", async () => {
  for (const limit of [0, 2]) {
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, recovery: { softNudges: 0, hardRestarts: 0, maxAttemptsPerStep: 1 }, templateOptions: { limits: { autoRestartsPerCycle: limit } } }), { script: async (t) => { t.crash(); } });
    const { state, rt } = await runOnce(h);
    assert.equal(rt.calls.workers.length, limit + 1);
    assert.equal(state.selfImprove?.history[0]?.reason, "auto_restarts_exhausted");
    assert.deepEqual(state.selfImprove?.history[0]?.decisions, []);
    assert.deepEqual(state.recovery.totals, { softNudges: 0, hardRestarts: 0 });
  }
  for (const value of [-1, 0.5, "3", null]) {
    const r = resolveContract(improveRaw(sourceRepo(), { templateOptions: { limits: { autoRestartsPerCycle: value } } }), { effort: testEffort });
    assert.equal(r.ok, false, String(value));
    assert.ok(r.problems.some((p) => p.path === "templateOptions.limits.autoRestartsPerCycle"));
  }
});

await check("committed green work after session death gets a host report and independent review; red or empty work is never salvaged", async () => {
  for (const verdict of ["MERGE", "REJECT"]) {
    const calls: ManagerCall[] = [];
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { integration: { review: false } } }), {
      manager: manager(calls, { review: verdict }),
      script: async (t) => { t.write("AUDIT_OK", "1"); t.commit("finished code before compaction death"); t.crash(); },
    });
    const { state, rt } = await runOnce(h);
    const entry = state.selfImprove?.history[0];
    assert.equal(rt.calls.workers.length, 1, "no report-only model session");
    assert.equal(rt.calls.checks.filter((check) => check.sha === entry?.head).length, 1, "reuse the trusted salvage gate at exactly this head");
    assert.equal(entry?.reason, "host close-out after session exit");
    assert.equal(entry?.merged, verdict === "MERGE");
    assert.equal(entry?.reportOutcome, null, "the host never pretends the worker declared success");
    const call = calls.find((c) => /You review one cycle/.test(c.system));
    assert.ok(call, "salvage forces review even when normal cycle review is disabled");
    assert.match(call.user, /Host close-out/);
    assert.match(call.user, /finished code before compaction death/);
    assert.match(call.user, /Outcome: partial/);
    assert.ok(fs.existsSync(path.join(h.store.p.steps, "01", "salvaged-report.json")));
    const exported = exportRun({ store: h.store, repo: rt.repo, contract: h.contract, state, out: scratch() });
    assert.ok(exported.manifest.files.some((file) => file.path === "evidence/steps/01/salvaged-report.json"), "salvage evidence is exported");
  }
  for (const changed of [false, true]) {
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { limits: { autoRestartsPerCycle: 0 } } }), {
      script: async (t) => { if (changed) { t.write("unfinished.txt", "still red"); t.commit("unfinished"); } t.crash(); },
    });
    const { state } = await runOnce(h);
    assert.equal(state.selfImprove?.history[0]?.merged, false);
    assert.equal(fs.existsSync(path.join(h.store.p.steps, "01", "salvaged-report.json")), false);
  }
});

await check("STOP parks an active cycle, keeps committed work and exits cleanly; heartbeat tracks ticks, phase and cycle", async () => {
  const h = harness(improveRaw(sourceRepo()), {
    script: async (t) => {
      t.write("checkpoint.txt", "kept"); t.commit("checkpoint");
      fs.writeFileSync(path.join(t.store.p.root, "STOP"), "");
      t.store.enqueue("unpause");
      t.hang();
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "paused");
  assert.equal(state.history.at(-1)?.reason, "stop_file");
  assert.equal(state.selfImprove?.current?.n, 1);
  assert.equal(state.selfImprove?.history.length, 0, "STOP preserves the current cycle for resume");
  assert.equal(rt.repo.fileAt(rt.repo.head(), "checkpoint.txt"), "kept");
  assert.deepEqual(fakeAlive(h.fakeEngine), []);
  assert.equal(fs.existsSync(h.store.p.lock), false);
  const beat: unknown = JSON.parse(fs.readFileSync(path.join(h.store.p.root, "heartbeat.json"), "utf8"));
  assert.deepEqual(beat, { at: new Date(h.clock.now).toISOString(), phase: "work", cycle: 1, status: "paused" });
  const again = await runOnce(h);
  assert.equal(again.state.status, "paused", "a queued unpause cannot override STOP");
  assert.equal(again.rt.calls.workers.length, 0);
  fs.rmSync(path.join(h.store.p.root, "STOP"));
  const resumed = await runOnce(h, { rt: h.runtime(async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("finish parked cycle"); t.store.enqueue("cancel"); }) });
  assert.notEqual(resumed.state.status, "running");
});

await check("signals and unexpected supervisor errors park active runs instead of leaving running state", async () => {
  for (const which of ["signal", "error"]) {
    const h = harness(improveRaw(sourceRepo()), { script: async (t) => { if (which === "error") throw new Error("synthetic supervisor failure"); t.hang(); } });
    const made = h.engine();
    if (which === "signal") made.rt.hooks.onSleep = () => { made.engine.signalled = true; };
    if (which === "error") await assert.rejects(made.engine.run(), /synthetic supervisor failure/);
    else await made.engine.run();
    assert.equal(h.state().status, "paused");
    assert.equal(h.state().history.at(-1)?.reason, which === "error" ? "supervisor_error" : "signal");
    assert.deepEqual(fakeAlive(h.fakeEngine), []);
    assert.equal(fs.existsSync(h.store.p.lock), false);
  }
});

await check("backlog inbox items reach the next cycle under a clear heading and survive a supervisor restart", async () => {
  const prompts: string[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      prompts.push(t.message);
      if (t.step === 1) t.store.enqueue("backlog", { message: "Check compaction recovery with evidence." });
      else assert.match(t.message, /## Steward backlog for this cycle\n- Check compaction recovery with evidence\./);
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit(`cycle ${t.step}`);
    },
  });
  const { state } = await runOnce(h);
  assert.doesNotMatch(nth(prompts, 0), /Check compaction recovery/);
  assert.equal(state.backlog?.[0]?.deliveredCycle, 2);
  assert.equal(h.store.pending().length, 0);
  const h2 = harness(improveRaw(sourceRepo()), { script: async (t) => { assert.match(t.message, /Persisted stewardship/); fs.writeFileSync(path.join(t.store.p.root, "STOP"), ""); t.hang(); } });
  h2.store.enqueue("backlog", { message: "Persisted stewardship" });
  await runOnce(h2);
  fs.rmSync(path.join(h2.store.p.root, "STOP"));
  h2.store.enqueue("unpause");
  const next = await runOnce(h2);
  assert.equal(next.state.backlog?.[0]?.deliveredCycle, 1, "the interrupted cycle gets the same backlog on resume");
});

await check("host leak scans block automatic publication and approved promotion, including unmerged tags; clean pushes remain fast-forward only", async () => {
  for (const approval of [false, true]) {
    const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
    const calls: ManagerCall[] = [];
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: approval } }), {
      cfgOverride: { integrationRemote: bare, gitRemote: bare },
      manager: manager(calls, { review: "REJECT" }),
      script: async (t) => { t.write("AUDIT_OK", "1"); t.write("internal/private-note.txt", "synthetic private-path fixture"); report(t, "successful"); t.commit("private path fixture"); },
    });
    const { state, rt, engine } = await runOnce(h);
    if (!approval) {
      assert.match(state.selfImprove?.publishBlocker ?? "", /pre-push leak scan.*private path/);
      assert.equal(sh(bare, "tag", "--list"), "", "a rejected cycle tag cannot leak through a clean integration branch");
    }
    const promoted = await engine.promote({ sha: mirrorGit(rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]), approved: true });
    assert.equal(promoted.status, "failed");
    assert.match(promoted.error ?? "", /pre-push leak scan.*private path/);
    assert.equal(sh(bare, "tag", "--list"), "");
    assert.match(h.state().promotion.error ?? "", /publication blocked/);
    assert.equal(rt.repo.fileAt(state.selfImprove?.history[0]?.head ?? "", "internal/private-note.txt"), "synthetic private-path fixture");
  }
});

await check("publish range scanning catches a private path removed before the final head", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: false }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare }, manager: manager([]),
    script: async (t) => {
      t.write("internal/private-note.txt", "synthetic history fixture"); t.commit("private-path history fixture");
      t.remove("internal"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("remove private path before final head");
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.selfImprove?.history[0]?.merged, true, "local reviewed integration may continue");
  assert.equal(rt.repo.fileAt(state.selfImprove?.history[0]?.head ?? "", "internal/private-note.txt"), null);
  assert.match(state.selfImprove?.publishBlocker ?? "", /private path/);
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), state.selfImprove?.seedSha, "no newly exposing commit was pushed");
});

await check("the deprecated v0 shape maps onto this template: same limits and budgets, no default remote, an explicit destination", () => {
  const v0 = { run: "perpetual-x", cycles: 4, gitRemote: "https://git.example.org/team/repo.git", promotion: "push", budget: { perCycleUsd: 2, totalUsd: 20 }, limits: { softMinutes: 60, hardMinutes: 90 }, integration: { branch: "experimental/main" } };
  const r = resolveContract(v0, { effort: testEffort });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const cfg = runtimeConfig(contractOf(r));
  assert.deepEqual([cfg.integrationBranch, cfg.integrationRemote, cfg.baseSource, cfg.baseRef, cfg.publishTags, cfg.cycles], ["experimental/main", v0.gitRemote, v0.gitRemote, "main", true, 4]);
  assert.deepEqual(cfg.budget, { perCycleUsd: 2, perCycleHardUsd: 4, totalUsd: 20 });
  assert.equal(cfg.limits.softMinutes, 60);
  assert.equal(cfg.limits.idleMinutes, 20);
  const none = runtimeConfig(contractOf(resolveContract({ ...v0, promotion: "none" }, { effort: testEffort })));
  assert.equal(none.integrationRemote, null, "promotion none: no destination at all");
  const local = runtimeConfig(contractOf(resolveContract({ ...v0, gitRemote: "/srv/repo.git", promotion: "local-branch" }, { effort: testEffort })));
  assert.deepEqual([local.integrationRemote, local.publishTags], ["/srv/repo.git", false]);
});

cleanup();
done();
