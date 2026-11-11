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
import { cleanup, fakeAlive, harness, runOnce, scratch, NODE_EXIT, type Harness, type HarnessRuntime, type MadeEngine, type ManagerFn, type ScriptContext } from "./autonomy-harness.ts";
import { main } from "../packages/autonomy/cli.ts";
import { resolveContract } from "../packages/autonomy/lib/contract.ts";
import { exportRun } from "../packages/autonomy/lib/export.ts";
import { parseBoardReport, WORK_PRECEDENCE } from "../packages/autonomy/lib/board.ts";
import { runtimeConfig } from "../packages/autonomy/lib/runcfg.ts";
import { bookkeepingPaths } from "../packages/autonomy/lib/bookkeeping.ts";
import { compilePlan } from "../packages/extensions/third_party/subagent/plan.ts";
import { discoverAgents } from "../packages/extensions/third_party/subagent/agents.ts";

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

/** Run `pi-autonomy <argv>` in-process against a harness home and return its code and captured output. */
const cliRun = async (h: Harness, argv: readonly string[]): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = []; const err: string[] = [];
  const code = await main(argv, {
    home: h.home,
    now: () => new Date(h.clock.now),
    stdout: { write: (s: string): number => out.push(s) },
    stderr: { write: (s: string): number => err.push(s) },
  });
  return { code, out: out.join(""), err: err.join("") };
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

await check("upstream validates branch syntax and must differ from the integration branch", () => {
  for (const upstream of ["../bad", "bad.lock", "bad/", "pi-autonomy/integration", 2, "-option"]) {
    const resolved = resolveContract(improveRaw(sourceRepo(), { templateOptions: { integration: { upstream } } }), { effort: testEffort });
    assert.equal(resolved.ok, false, String(upstream));
    assert.ok(resolved.problems.some((p) => p.path === "templateOptions.integration.upstream"));
  }
  const none = resolveContract(improveRaw(sourceRepo(), { promotion: { policy: "none", destinations: [] }, templateOptions: { integration: { upstream: "integration/trunk" } } }), { effort: testEffort });
  assert.equal(none.ok, false, "an upstream with no promotion remote could never be fetched");
  assert.ok(none.problems.some((p) => p.path === "templateOptions.integration.upstream" && /policy "none"/.test(p.message)));
});

await check("Board: parsing accepts only exact bounded lines and one entry per id", () => {
  assert.deepEqual(parseBoardReport([
    "Board: V-01 done - Finished with tests.", "Board: V-02 progress - One part remains.", "Board: V-03 blocked - Needs a decision.",
    " Board: V-04 done - indented", "Board: bad done - invalid", "Board: V-05 complete - invalid", "Board: V-06 done", "Board: V-07 done - ",
    "Board: V-08 done - " + "x".repeat(501), "Board: V-01 blocked - duplicate", "prose Board: V-09 done - ignored",
  ].join("\r\n")), [
    { id: "V-01", status: "done", note: "Finished with tests." }, { id: "V-02", status: "progress", note: "One part remains." }, { id: "V-03", status: "blocked", note: "Needs a decision." },
  ]);
  assert.deepEqual(parseBoardReport(null), []);
});

await check("stream bookkeeping seeds per-run files, preserves the charter, and follows resume, restart, manager and merge review; legacy paths stay shared", async () => {
  for (const stream of [false, true]) {
    const src = sourceRepo();
    const charter = "# Existing operator charter\nKeep this exact charter.\n";
    fs.mkdirSync(path.join(src, "autonomy"));
    fs.writeFileSync(path.join(src, "autonomy", "CHARTER.md"), charter);
    fs.writeFileSync(path.join(src, "autonomy", "BACKLOG.md"), "Shared backlog\n");
    fs.writeFileSync(path.join(src, "autonomy", "HANDOFF.md"), "Another run's shared handoff\n");
    sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "existing shared records");
    sh(src, "branch", "integration/trunk");
    const paths = bookkeepingPaths({ run: "improve-test-1", integrationUpstream: stream ? "integration/trunk" : null }, 1);
    let phase = 0;
    const calls: ManagerCall[] = [];
    const script = async (t: ScriptContext): Promise<void> => {
      phase++;
      assert.ok(t.message.includes(paths.handoff), t.message);
      assert.ok(t.message.includes(paths.proposals), t.message);
      assert.doesNotMatch(t.message, /\{\{[A-Z_]+\}\}/);
      if (phase === 1) {
        assert.match(t.read(paths.handoff) ?? "", /first run: improve-test-1/);
        if (stream) {
          assert.equal(t.read("autonomy/CHARTER.md"), charter);
          assert.equal(t.read("autonomy/BACKLOG.md"), "Shared backlog\n");
          assert.equal(t.read("autonomy/HANDOFF.md"), "Another run's shared handoff\n");
          assert.match(t.read("autonomy/proposals/improve-test-1-00-1-b-1-add-the-audit-marker.md") ?? "", /Status: proposal[\s\S]*A file called AUDIT_OK/);
          assert.match(t.message, /never edit the shared autonomy\/BACKLOG.md/);
        } else {
          assert.match(t.read("autonomy/BACKLOG.md") ?? "", /\| B-1 \| open/);
          assert.equal(t.read("autonomy/runs/improve-test-1/HANDOFF.md"), null);
        }
        t.write(paths.handoff, "Run-specific carry-over evidence\n");
        t.write(paths.proposals.replace("<slug>", "follow-up"), "New proposal with evidence\n");
        t.commit("checkpoint bookkeeping");
        fs.writeFileSync(path.join(t.store.p.root, "STOP"), ""); t.hang();
      } else if (phase === 2) {
        assert.match(t.message, /previous session of this cycle was interrupted/);
        t.crash();
      } else if (phase === 3) {
        assert.match(t.message, /previous worker process exited/);
        t.elapse(181); t.hang();
      } else {
        assert.match(t.message, /Manager restart with carry-over/);
        t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("finish bookkeeping cycle");
      }
    };
    const h = harness(improveRaw(src, {
      budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 },
      templateOptions: { integration: { ...(stream ? { upstream: "integration/trunk" } : {}) } },
    }), {
      script,
      manager: async (system, user, model) => {
        calls.push({ system, user, model });
        if (/You review one cycle/.test(system)) return mergeReview();
        assert.ok(user.includes(`## Handoff (${paths.handoff})`));
        assert.match(user, /Run-specific carry-over evidence/);
        assert.doesNotMatch(user, /Another run's shared handoff/);
        return JSON.stringify({ decision: "RESTART_SESSION", reason: "test restart", message: "Manager restart with carry-over" });
      },
    });
    await runOnce(h);
    assert.equal(h.state().status, "paused");
    fs.rmSync(path.join(h.store.p.root, "STOP")); h.store.enqueue("unpause");
    const resumed = await runOnce(h, { rt: h.runtime(script) });
    assert.equal(phase, 4);
    assert.equal(resumed.state.selfImprove?.history[0]?.merged, true);
    const review = nth(calls.filter((c) => /You review one cycle/.test(c.system)), 0);
    assert.ok(review.system.includes(paths.proposals));
    assert.ok(review.user.includes(`## Handoff (${paths.handoff})`));
    assert.match(review.user, /Run-specific carry-over evidence/);
    if (stream) assert.equal(resumed.rt.repo.fileAt(resumed.rt.repo.head(), "autonomy/CHARTER.md"), charter.trim());
    // A stream is judged against the current stream charter (the seed rendered by the host), not an older trunk copy.
    if (stream) { assert.match(review.user, /# Improvement charter[\s\S]*The steward board items in order/); assert.doesNotMatch(review.user, /Keep this exact charter/); }
  }
});

await check("an adopted stream branch gets its own handoff even with an existing charter; a missing charter uses stream proposal paths", async () => {
  for (const existing of [false, true]) {
    const src = sourceRepo();
    if (existing) {
      fs.mkdirSync(path.join(src, "autonomy"));
      fs.writeFileSync(path.join(src, "autonomy", "CHARTER.md"), "# Preserve adopted charter\n");
      sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "charter");
    }
    sh(src, "branch", "pi-autonomy/integration"); sh(src, "branch", "integration/trunk");
    const h = harness(improveRaw(src, {
      budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 },
      templateOptions: { integration: { upstream: "integration/trunk" } },
    }), { manager: manager([]), script: async (t) => {
      assert.match(t.read("autonomy/runs/improve-test-1/HANDOFF.md") ?? "", /first run: improve-test-1/);
      assert.equal(t.read("autonomy/HANDOFF.md"), null);
      assert.equal(t.read("autonomy/BACKLOG.md"), null);
      if (existing) assert.equal(t.read("autonomy/CHARTER.md"), "# Preserve adopted charter\n");
      else {
        assert.match(t.read("autonomy/CHARTER.md") ?? "", /autonomy\/proposals\/<run>-<NN>-<slug>\.md/);
        assert.doesNotMatch(t.read("autonomy/CHARTER.md") ?? "", /autonomy\/BACKLOG.md/);
      }
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream ready");
    } });
    const { state } = await runOnce(h);
    assert.equal(state.selfImprove?.merged, 1);
  }
});

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
  assert.doesNotMatch(charter, /pi-system|mkdocs|gitleaks|home\.internal/i, "the seed is general, not specific to one repository");
  assert.match(charter, /Never run `npm test` or `npm run check:all`\s+yourself: the host gate runs the full suite/, "the host owns the full gate");
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

await check("PG-55: a leak-scan-refused merge is counted, surfaced by status, and names the location in the next cycle prompt", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1");
      t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`);
      report(t, "successful");
      t.commit(`cycle ${t.step}`);
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.match(state.selfImprove?.publishBlocker ?? "", /pre-push leak scan/);
  assert.ok((state.selfImprove?.publishBlockedCycles ?? 0) >= 1, "the merged-but-unpublished cycle is counted");
  // (c) the NEXT cycle's prompt carries the blocker, locations only, and the fix instruction.
  assert.match(nth(prompts, 1), /## Publication blocked \(pre-push leak scan\)/);
  assert.ok(nth(prompts, 1).includes(state.selfImprove?.publishBlocker ?? "\u0000"), "the next cycle prompt quotes the blocker verbatim");
  assert.match(nth(prompts, 1), /Your first job this cycle is to stop adding that identifier: remove it, or if it is legitimate propose an exception; the run cannot publish until it is gone\./);
  // (b) status carries the blocker and the unpublished count, in JSON and in text.
  const status = await cliRun(h, ["status", "--run", "improve-test-1", "--json"]);
  assert.equal(status.code, 0, status.err);
  const json = JSON.parse(status.out) as { selfImprove?: { publishBlocker?: string | null; unpublished?: number } };
  assert.match(json.selfImprove?.publishBlocker ?? "", /pre-push leak scan/);
  assert.ok((json.selfImprove?.unpublished ?? 0) >= 1);
  const text = await cliRun(h, ["status", "--run", "improve-test-1"]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /publication BLOCKED: publication blocked by pre-push leak scan: .*merged cycle\(s\) not published; the leak scan refuses the commit above/);
});

await check("PG-55: two consecutive leak-scan-refused merges stop the run with an operator question", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const slot: { engine?: MadeEngine } = {};
  let stopped = false;
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    hooks: { onSleep: () => { if (slot.engine && !stopped && h.state().status === "blocked") { stopped = true; slot.engine.engine.signalled = true; } } },
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1");
      t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`);
      report(t, "successful");
      t.commit(`cycle ${t.step}`);
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  const state = h.state();
  assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
  assert.equal(state.blocker?.id, "publish-blocked");
  assert.equal(state.blocker?.kind, "external");
  assert.equal(state.selfImprove?.publishBlockedCycles, 2, "two merged cycles are stacked unpublished");
  assert.equal(state.pendingQuestions.filter((q) => q.id === "publish-blocked").length, 1);
  assert.match(state.blocker?.question ?? "", /Publication of 2 merged cycle\(s\) is blocked by the pre-push leak scan/);
  assert.match(state.blocker?.question ?? "", /remove the identifier or stop the run/);
  assert.deepEqual(state.blocker?.options, ["Remove the identifier and resume", "Stop the run"]);
  assert.equal(prompts.length, 2, "the run waits for the operator instead of starting a third cycle");
});

await check("PG-55: answering the publish-blocked question runs exactly one cycle, then parks again", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const slot: { engine?: MadeEngine } = {};
  let answered = 0;
  let stopped = false;
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    hooks: { onSleep: () => {
      if (!slot.engine) return;
      const s = h.state();
      if (s.status !== "blocked" || s.blocker?.id !== "publish-blocked") return;
      if (answered === 0) { answered += 1; h.store.enqueue("answer", { text: "Remove the identifier and resume" }); return; }
      if (!stopped) { stopped = true; slot.engine.engine.signalled = true; }
    } },
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1");
      t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`);
      report(t, "successful");
      t.commit(`cycle ${t.step}`);
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  const state = h.state();
  assert.equal(answered, 1, "the operator answered the publish-blocked question once");
  assert.equal(prompts.length, 3, "exactly one cycle ran after the answer, not zero and not more");
  assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
  assert.equal(state.blocker?.id, "publish-blocked", "the still-refused publication parks the run again");
  assert.equal(state.pendingAnswer ?? null, null, "the answer was consumed");
});

await check("PG-55: answering the publish-blocked question with a leak-free cycle publishes and the run continues", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const slot: { engine?: MadeEngine } = {};
  let answered = 0;
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    hooks: { onSleep: () => {
      if (!slot.engine) return;
      const s = h.state();
      if (s.status === "blocked" && s.blocker?.id === "publish-blocked" && answered === 0) {
        answered = 1;
        h.store.enqueue("answer", { text: "Remove the identifier and resume" });
      }
    } },
    script: async (t) => {
      prompts.push(t.message);
      if (t.step <= 2) { t.write("AUDIT_OK", "1"); t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}`); report(t, "successful"); t.commit(`leak cycle ${t.step}`); return; }
      if (t.step === 3) { t.remove("internal"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("remove the identifier before publishing"); return; }
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit(`cycle ${t.step}`);
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  const state = h.state();
  assert.equal(answered, 1, "the operator answered the publish-blocked question once");
  assert.equal(prompts.length, 4, "the answer ran a cycle and a later cycle started, proving the run continued");
  assert.equal(state.selfImprove?.history[2]?.merged, true, "the leak-free answer cycle merged");
  assert.equal(state.selfImprove?.publishBlocker ?? null, null, "the leak-free publication cleared the blocker");
  assert.equal(state.selfImprove?.publishBlockedCycles ?? 0, 0, "and the unpublished-cycle streak");
  assert.notEqual(state.blocker?.id, "publish-blocked", "the run is not parked on the publish-blocked question");
  const pushed = sh(bare, "ls-tree", "-r", "--name-only", "refs/heads/pi-autonomy/integration");
  assert.doesNotMatch(pushed, /internal\/private-note\.txt/, "the pushed integration branch carries no leaked path");
});

await check("PG-55: a non-merged cycle between refused merges does not reset the blocked-cycle count", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const slot: { engine?: MadeEngine } = {};
  let stopped = false;
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    hooks: { onSleep: () => { if (slot.engine && !stopped && h.state().status === "blocked") { stopped = true; slot.engine.engine.signalled = true; } } },
    script: async (t) => {
      prompts.push(t.message);
      if (t.step === 2) { t.remove("AUDIT_OK"); report(t, "successful"); t.commit("red gate cycle"); return; }
      t.write("AUDIT_OK", "1");
      t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`);
      report(t, "successful");
      t.commit(`cycle ${t.step}`);
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  const state = h.state();
  assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
  assert.equal(state.blocker?.id, "publish-blocked");
  assert.equal(state.selfImprove?.publishBlockedCycles, 2, "the intervening non-merged cycle did not clear the count");
  assert.equal(state.selfImprove?.history.filter((c) => c.merged).length, 2, "only the two leak-bearing cycles merged");
  assert.equal(prompts.length, 3, "the run stops before a fourth cycle");
});

await check("PG-55: a clean publish clears the blocker, the unpublished count and the status line", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const slot: { engine?: MadeEngine } = {};
  let injected = false;
  let blockedText = "";
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    hooks: { onSleep: async () => {
      const si = slot.engine?.engine.state.selfImprove;
      if (si && !injected) {
        injected = true;
        si.publishBlocker = "publication blocked by pre-push leak scan: 012345678901 internal/private-note.txt: a private path";
        si.publishBlockedCycles = 1;
        slot.engine?.engine.save();
        blockedText = (await cliRun(h, ["status", "--run", "improve-test-1"])).out;
      }
    } },
    script: async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit(`cycle ${t.step}`); },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  assert.match(blockedText, /publication BLOCKED: publication blocked by pre-push leak scan/, "the status line is visible while the block stands");
  const state = h.state();
  assert.equal(state.selfImprove?.publishBlocker ?? null, null, "a clean publish clears the blocker");
  assert.equal(state.selfImprove?.publishBlockedCycles ?? 0, 0, "and the unpublished count");
  assert.equal(state.selfImprove?.merged, 1);
  const text = await cliRun(h, ["status", "--run", "improve-test-1"]);
  assert.doesNotMatch(text.out, /publication BLOCKED/);
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

await check("upstream is merged at every cycle start, published, then recorded up to date", async () => {
  const src = sourceRepo();
  sh(src, "checkout", "--quiet", "-b", "integration/trunk");
  fs.writeFileSync(path.join(src, "shared.txt"), "first\n");
  sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "trunk first");
  let upstream = sh(src, "rev-parse", "HEAD");
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 3, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "integration/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      assert.equal(t.git(["merge-base", "--is-ancestor", upstream, "HEAD"]).status, 0);
      assert.equal(t.read("shared.txt"), t.step === 1 ? "first\n" : "second\n");
      const parents = t.git(["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(" ");
      if (t.step <= 2) assert.equal(parents.length, 3, "host creates a two-parent merge");
      assert.equal(sh(src, "rev-parse", "pi-autonomy/integration"), t.git(["rev-parse", "HEAD"]).stdout.trim(), "cycle-start merge is published as usual");
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit(`stream cycle ${t.step}`);
      if (t.step === 1) {
        fs.writeFileSync(path.join(src, "shared.txt"), "second\n");
        sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "trunk second");
        upstream = sh(src, "rev-parse", "HEAD");
      }
    },
  });
  const { state } = await runOnce(h);
  assert.deepEqual(state.selfImprove?.history.map((c) => c.upstream?.outcome), ["merged", "merged", "up_to_date"]);
  assert.match(fs.readFileSync(h.store.p.log, "utf8"), /upstream integration\/trunk: merged [a-f0-9]{40}/);
});

await check("upstream conflict leaves integration unchanged and travels by bundle as refs/upstream/trunk with a P0 instruction", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "integration/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) {
        t.write("README.md", "stream intent\n"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream edit");
        sh(src, "checkout", "--quiet", "integration/trunk");
        fs.writeFileSync(path.join(src, "README.md"), "trunk intent\n");
        sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "trunk conflict");
      } else {
        const prev = t.store.readState()?.selfImprove?.history[0];
        assert.equal(t.git(["rev-parse", "HEAD"]).stdout.trim(), prev?.head, "host did not merge the conflict");
        assert.equal(t.git(["rev-parse", "refs/upstream/trunk"]).stdout.trim(), sh(src, "rev-parse", "integration/trunk"));
        assert.match(t.message, /## P0: upstream merge conflict/);
        assert.match(t.message, /git merge refs\/upstream\/trunk/);
        assert.match(t.message, /preserving both sides' intent, and re-verify/);
        assert.equal(t.git(["merge", "refs/upstream/trunk"]).status, 1);
        t.write("README.md", "stream intent\ntrunk intent\n"); report(t, "successful"); t.commit("resolve both intents");
      }
    },
  });
  const { state } = await runOnce(h);
  assert.deepEqual(state.selfImprove?.history.map((c) => c.upstream?.outcome), ["up_to_date", "conflict"]);
  assert.equal(state.selfImprove?.history[1]?.merged, true);
});

/** A trunk that conflicts on README.md and also brings a charter, package.json scripts, 70K characters of code and another run's records. */
function heavyTrunk(src: string): void {
  sh(src, "checkout", "--quiet", "integration/trunk");
  fs.writeFileSync(path.join(src, "README.md"), "trunk intent\n");
  fs.mkdirSync(path.join(src, "autonomy", "cycles", "other-run", "01"), { recursive: true });
  fs.mkdirSync(path.join(src, "lib"), { recursive: true });
  fs.writeFileSync(path.join(src, "autonomy", "CHARTER.md"), "# Trunk charter\n\nShared policy from the trunk.\n");
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node lib/big.ts" } }));
  fs.writeFileSync(path.join(src, "lib", "big.ts"), "export const TRUNK_BULK = 1;\n".repeat(2500));
  fs.writeFileSync(path.join(src, "autonomy", "cycles", "other-run", "01", "review.md"), "other run records\n".repeat(4000));
  sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "trunk work from other streams");
  sh(src, "checkout", "--quiet", "main");
}

await check("a conflict-resolving cycle is judged on what it adds over both parents: trunk's charter, scripts, bulk, records and paths outside writeAreas do not count", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(src, {
    budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 },
    permissions: { unattended: { authorised: true, autoApprove: true }, writeAreas: ["README.md", "AUDIT_OK", "autonomy/cycles/**", "autonomy/runs/**", "autonomy/proposals/**"] },
    templateOptions: { integration: { upstream: "integration/trunk" } },
  }), {
    manager: manager(calls),
    script: async (t) => {
      assert.match(nth(t.prompts, 0), /\*\*Improve mode\*\* is for assigned improvements/, "streams take improvements from the steward");
      if (t.step === 1) {
        t.write("README.md", "stream intent\n"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream edit");
        heavyTrunk(src);
      } else if (t.prompts.length > 1) {
        t.elapse(301); t.hang(); // a refused push brings a continuation turn: let the cycle end
      } else {
        assert.match(t.message, /## P0: upstream merge conflict/);
        assert.equal(t.git(["merge", "refs/upstream/trunk"]).status, 1);
        assert.equal(t.git(["checkout", "--theirs", "--", "autonomy/CHARTER.md"]).status, 0);
        t.write("README.md", "stream intent\ntrunk intent\n"); report(t, "successful"); t.commit("resolve both intents");
      }
    },
  });
  const { state } = await runOnce(h);
  const entry = state.selfImprove?.history[1];
  assert.equal(entry?.upstream?.outcome, "conflict");
  assert.equal(entry?.merged, true, entry?.mergeReason ?? "");
  const review = nth(calls.filter((c) => /You review one cycle/.test(c.system)), 1).user;
  const diff = review.split("## Diff\n")[1] ?? "";
  assert.match(diff, /\+stream intent/, "the resolution is judged against the upstream head");
  assert.doesNotMatch(diff, /TRUNK_BULK|other run records|Trunk charter/, "trunk's own changes are not the cycle's diff");
  assert.doesNotMatch(review.split("## Commits (git log --stat)")[1]?.split("## Own run records")[0] ?? "", /trunk work from other streams/, "trunk's commits are not listed as the cycle's");
});

await check("a conflict-resolving cycle's own control-path change is still refused", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "integration/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) {
        t.write("README.md", "stream intent\n"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream edit");
        heavyTrunk(src);
      } else {
        assert.equal(t.git(["merge", "refs/upstream/trunk"]).status, 1);
        t.write("autonomy/CHARTER.md", "# A charter neither side wrote\n");
        t.write("README.md", "stream intent\ntrunk intent\n"); report(t, "successful"); t.commit("resolve and rewrite the charter");
      }
    },
  });
  const { state } = await runOnce(h);
  const entry = state.selfImprove?.history[1];
  assert.equal(entry?.merged, false);
  assert.match(entry?.mergeReason ?? "", /control path .*autonomy\/CHARTER\.md/);
  assert.doesNotMatch(entry?.mergeReason ?? "", /package\.json/, "trunk's scripts are upstream's, not the cycle's");
});

await check("a conflict resolution that keeps the integration side of an upstream change (merge -s ours) is refused", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "integration/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) {
        t.write("README.md", "stream intent\n"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream edit");
        heavyTrunk(src);
      } else {
        assert.equal(t.git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "merge", "--quiet", "-s", "ours", "-m", "keep ours", "refs/upstream/trunk"]).status, 0);
        report(t, "successful"); t.commit("record");
      }
    },
  });
  const { state } = await runOnce(h);
  const entry = state.selfImprove?.history[1];
  assert.equal(entry?.merged, false);
  assert.match(entry?.mergeReason ?? "", /drops upstream changes .*README\.md/);
});

await check("the cycle prompt sends items through workflow_run {steps}, its example compiles at worst case 4, and it names the subagent fallback", async () => {
  let message = "";
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => { message = t.message; t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("prompt seen"); },
  });
  await runOnce(h);
  assert.match(message, /`workflow_run \{steps\}`/, "the prompt directs items through an inline plan");
  assert.match(message, /"parallel"/, "phase 1 may send scouts as a parallel plan");
  assert.match(message, /"max_loops":1/, "the item plan sets max_loops 1");
  assert.match(message, /worst case of 4/);
  assert.match(message, /`standard`.*8 agents/s, "the prompt states the request allowance");
  assert.match(message, /two items, or one scouts plan and one item/);
  assert.match(message, /fall back to the `subagent` tool/, "a refusal names the fallback");
  assert.match(message, /`Workflow: refused <reason>`/, "and the report line it adds");
  assert.match(message, /`subagent` for one-off tasks/, "the subagent rule stays for one-off tasks");
  assert.doesNotMatch(message, /\{\{[A-Z_]+\}\}/, "every placeholder is filled");
  // The item plan the prompt shows compiles through the same compiler workflow_run uses, against the kit's roles.
  const example = /^\s*\{"steps".*"max_loops".*$/m.exec(message)?.[0];
  assert.ok(example, "the prompt shows the item plan on one line");
  const parsed: unknown = JSON.parse(example);
  const steps: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "steps") : undefined;
  const compiled = compilePlan(steps, discoverAgents(scratch(), "project").agents);
  assert.ok(compiled.ok, `the example compiles: ${compiled.ok ? "" : JSON.stringify(compiled.errors)}`);
  assert.equal(compiled.worstCaseAgents, 4, "an item costs 4 of the 8 a standard request gets");
  const scouts = /^\s*\{"steps":\[\{"parallel".*$/m.exec(message)?.[0];
  assert.ok(scouts, "the prompt shows the scouts plan on one line");
  const scoutsParsed: unknown = JSON.parse(scouts);
  const scoutSteps: unknown = typeof scoutsParsed === "object" && scoutsParsed !== null ? Reflect.get(scoutsParsed, "steps") : undefined;
  const scoutPlan = compilePlan(scoutSteps, discoverAgents(scratch(), "project").agents);
  assert.ok(scoutPlan.ok, `the scouts example compiles: ${scoutPlan.ok ? "" : JSON.stringify(scoutPlan.errors)}`);
  assert.ok(scoutPlan.worstCaseAgents + compiled.worstCaseAgents <= 8, "scouts plus one item fit the standard allowance");
});

await check("an upstream fetch failure is logged and the cycle still runs and merges", async () => {
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "missing/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      assert.doesNotMatch(t.message, /## P0: upstream merge conflict/);
      assert.notEqual(t.git(["rev-parse", "--verify", "refs/upstream/trunk"]).status, 0);
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("green without upstream");
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.selfImprove?.history[0]?.upstream?.outcome, "fetch_failed");
  assert.equal(state.selfImprove?.history[0]?.merged, true);
  assert.match(fs.readFileSync(h.store.p.log, "utf8"), /upstream missing\/trunk: fetch_failed/);
});


await check("board prompt ranks two nonblocked items, refreshes each cycle, and review uses claimed acceptance from the prompt snapshot", async () => {
  const calls: ManagerCall[] = [];
  const board = { items: [
    { id: "V-01", title: "cleanup", priority: "P3" },
    { id: "V-02", title: "first assigned", priority: "P1", acceptance: "First acceptance" },
    { id: "V-03", title: "urgent blocked", priority: "P0", status: "blocked" },
    { id: "V-04", title: "second assigned", priority: "P1", acceptance: "Second acceptance" },
  ] };
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      assert.match(t.message, /## Assigned work \(steward board\)/);
      assert.ok(t.message.includes(WORK_PRECEDENCE));
      if (t.step === 1) {
        assert.ok(t.message.indexOf("V-02 [P1]") < t.message.indexOf("V-04 [P1]"));
        assert.doesNotMatch(t.message, /V-01|V-03/);
        assert.match(t.message, /First acceptance/);
        assert.match(t.message, /Never run `npm test` or `npm run check:all`/);
        assert.match(t.message, /Put this rule in every subagent task you send/);
        assert.match(t.message, /Own new ideas go into `autonomy\/BACKLOG.md` as proposals/);
        // One copy each of the precedence and the own-ideas rule, and the items before the ground rules.
        assert.equal(t.message.split(WORK_PRECEDENCE).length, 2, "the precedence is stated once");
        assert.equal(t.message.split("Own new ideas go into").length, 2, "the own-ideas rule is stated once");
        assert.ok(t.message.indexOf("## Assigned work") < t.message.indexOf("Ground rules"), "assigned items come right after the budget");
        assert.doesNotMatch(t.message, /Read the steward board/);
        fs.writeFileSync(path.join(t.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "V-05", title: "next cycle assignment", priority: "P0", acceptance: "Next acceptance" }] }));
      } else {
        assert.match(t.message, /V-05 \[P0\]/);
        assert.doesNotMatch(t.message, /V-02|V-04/);
      }
      t.write("AUDIT_OK", "1"); report(t, "successful", "fix", t.step === 1 ? "Board: V-04 progress - Added the tested first part." : "No explicit claim; review assigned item."); t.commit("board progress");
    },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify(board));
  const { state } = await runOnce(h);
  assert.deepEqual(state.selfImprove?.history[0]?.board, [{ id: "V-04", status: "progress", note: "Added the tested first part." }]);
  const reviews = calls.filter((c) => /You review one cycle/.test(c.system));
  assert.match(nth(reviews, 0).user, /"id": "V-04"/);
  assert.match(nth(reviews, 0).user, /Second acceptance/);
  const claimed = nth(reviews, 0).user.split("## Claimed steward board items")[1]?.split("## Charter")[0] ?? "";
  assert.doesNotMatch(claimed, /First acceptance|Next acceptance/);
  assert.match(nth(reviews, 0).user, /## Assigned steward board items/);
  assert.match(nth(reviews, 0).user, /First acceptance/);
  assert.match(nth(reviews, 0).system, /lower-priority detour/);
  assert.match(nth(reviews, 1).user, /Next acceptance/);
  assert.equal(state.selfImprove?.merged, 2);
});


await check("partial green committed work goes through independent review; red and empty partial cycles never do", async () => {
  for (const kind of ["green", "red", "empty"] as const) {
    for (const verdict of kind === "green" ? ["MERGE", "REJECT"] : ["MERGE"]) {
      const calls: ManagerCall[] = [];
      const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { integration: { review: false } } }), {
        manager: manager(calls, { review: verdict }),
        script: async (t) => {
          if (kind !== "empty") { t.write(kind === "green" ? "AUDIT_OK" : "unfinished.txt", "1"); report(t, "partial"); t.commit("checkpoint"); }
          t.elapse(301); t.hang();
        },
      });
      const { state } = await runOnce(h);
      const entry = state.selfImprove?.history[0];
      assert.equal(entry?.outcome, "partial");
      assert.equal(entry?.reason, "hard_limit");
      assert.equal(entry?.merged, kind === "green" && verdict === "MERGE");
      const reviews = calls.filter((c) => /You review one cycle/.test(c.system));
      assert.equal(reviews.length, kind === "green" ? 1 : 0);
      if (kind === "green") assert.match(nth(reviews, 0).user, /cycle 1: partial/);
      else assert.equal(entry?.gate, kind === "red" ? "red" : "skipped");
    }
  }
});

await check("a resumed cycle keeps its board snapshot: claims against the board it started with still reach review", async () => {
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => { t.write("partial.txt", "1"); t.commit("checkpoint"); fs.writeFileSync(path.join(t.store.p.root, "STOP"), ""); t.hang(); },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "V-02", title: "started item", priority: "P1", acceptance: "Started acceptance" }] }));
  await runOnce(h);
  assert.equal(h.state().status, "paused");
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "V-05", title: "steward's next item", priority: "P0" }] }));
  fs.rmSync(path.join(h.store.p.root, "STOP")); h.store.enqueue("unpause");
  const resumed = await runOnce(h, { rt: h.runtime(async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful", "fix", "Board: V-02 done - Finished the started item with tests."); t.commit("finish started item"); }) });
  const entry = resumed.state.selfImprove?.history[0];
  assert.equal(entry?.merged, true, entry?.mergeReason ?? "");
  assert.match(nth(calls.filter((c) => /You review one cycle/.test(c.system)), 0).user, /Started acceptance/);
});

await check("without a board, Board: lines are recorded but never refuse the merge, and legacy prompts keep choosing their own improvements", async () => {
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      assert.match(t.message, /\*\*Improve mode\*\* is for when the review finds nothing worth fixing\. Make an existing system/);
      assert.doesNotMatch(t.message, /Board: <ID>|## Assigned work|steward to assign|Own new ideas go into/);
      t.write("AUDIT_OK", "1"); report(t, "successful", "fix", "Board: B-003 done - Worked a backlog item."); t.commit("backlog work");
    },
  });
  const { state } = await runOnce(h);
  const entry = state.selfImprove?.history[0];
  assert.equal(entry?.merged, true, entry?.mergeReason ?? "");
  assert.deepEqual(entry?.board, [{ id: "B-003", status: "done", note: "Worked a backlog item." }]);
  assert.equal(calls.filter((c) => /You review one cycle/.test(c.system)).length, 1);
});

await check("an existing paused cycle with no board or upstream fields loads and resumes", async () => {
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("first cycle"); }
      else { fs.writeFileSync(path.join(t.store.p.root, "STOP"), ""); t.hang(); }
    },
  });
  await runOnce(h);
  const old = h.state();
  assert.ok(old.selfImprove?.current);
  delete old.selfImprove.current.board;
  delete old.selfImprove.current.upstream;
  for (const c of old.selfImprove.history) { delete c.board; delete c.upstream; }
  h.store.writeState(old);
  assert.equal(h.store.readState()?.selfImprove?.history.length, 1);
  fs.rmSync(path.join(h.store.p.root, "STOP")); h.store.enqueue("unpause");
  const resumed = await runOnce(h, { rt: h.runtime(async (t) => { report(t, "successful"); t.commit("finish old cycle"); }) });
  assert.equal(resumed.state.selfImprove?.history[1]?.merged, true);
});

await check("the cycle prompt names the start sha, the review budget with its measure command, the stream focus and the targeted-test rule", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const h = harness(improveRaw(src, {
    objective: { title: "UX stream", spec: "TUI overlays and the launch screen; owns packages/web-ui.", backlog: [] },
    budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 },
    templateOptions: { integration: { upstream: "integration/trunk" } },
  }), {
    manager: manager([]),
    script: async (t) => {
      const start = t.git(["rev-parse", "HEAD"]).stdout.trim().slice(0, 12);
      assert.ok(t.message.includes(`\`${start}\`, the cycle start`), "the start sha is given");
      assert.ok(t.message.includes(`git diff --no-renames ${start}..HEAD -- . ":(exclude)package-lock.json" ":(exclude)autonomy/cycles/improve-test-1/" ":(exclude)autonomy/runs/improve-test-1/" | wc -c`), t.message);
      assert.match(t.message, /at most 60000 characters/);
      assert.match(t.message, /stop taking new items once it passes 30000/);
      assert.ok(t.message.includes(`git log --oneline ${start}..HEAD`));
      assert.doesNotMatch(t.message, /<cycle start>|main\.\.HEAD/);
      assert.match(t.message, /Your stream: UX stream: TUI overlays and the launch screen; owns packages\/web-ui\.\. Work only inside this stream's area/);
      assert.match(t.message, /there is no board file to read/);
      assert.match(t.message, /this prompt wins: the merge review judges streams against the current stream charter/);
      assert.match(t.message, /\(a\) run the targeted smokes[\s\S]*\(d\) write `verify\.md`[\s\S]*Then go to step 5/);
      assert.match(t.message, /Item: <title> - <commit shas> - <test that proves it>/);
      assert.match(t.message, /under 5000 characters each/);
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("focus");
    },
  });
  assert.equal((await runOnce(h)).state.selfImprove?.merged, 1);
});

await check("a report that leaves a code commit out of its Item lines gets one follow-up in the live session; the review leads with the host ledger", async () => {
  const calls: ManagerCall[] = [];
  const shas: string[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      if (t.turn === 1) {
        t.write("feature.txt", "1"); t.commit("feat: first item");
        shas.push(t.git(["rev-parse", "HEAD"]).stdout.trim());
        t.write("AUDIT_OK", "1"); report(t, "successful", "fix", "Item: marker - (this commit) - smoke:x"); t.commit("record");
        return;
      }
      assert.equal(t.kind, "prompt", "the follow-up reaches the settled session as its next prompt");
      assert.match(t.message, /^Commits [0-9a-f]{12} are not in any `Item:` line of autonomy\/cycles\/improve-test-1\/01\/report\.md/);
      assert.ok(t.message.includes(nth(shas, 0).slice(0, 12)));
      report(t, "successful", "fix", `Item: feature - ${nth(shas, 0).slice(0, 9)} - smoke:x\nItem: marker - (this commit) - smoke:x`); t.commit("record the feature");
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.selfImprove?.history[0]?.merged, true, state.selfImprove?.history[0]?.mergeReason ?? "");
  assert.equal(rt.turnCount, 2, "exactly one follow-up");
  const review = nth(calls.filter((c) => /You review one cycle/.test(c.system)), 0);
  assert.ok(review.user.indexOf("## Host ledger (authoritative)") < review.user.indexOf("## Cycle report"), "the ledger comes first");
  assert.match(review.user, /[0-9a-f]{7,} feat: first item/);
  assert.match(review.user, /Diff without lockfiles and this run's records: +2 files changed/);
  assert.doesNotMatch(review.user, /no `Item:` line of the report names/, "the follow-up fixed the gap");
  assert.match(review.system, /The host ledger and diff are authoritative for what changed\. Ignore counts or stats in the worker's prose/);
  assert.match(review.system, /a non-record change in the diff is covered by no report item/);
  assert.match(review.user, /## Cycle context \(host\)\n- This is the run's first cycle\./);
});

await check("an unknown Board: claim never discards green work: it is judged on the known claims, flagged to the reviewer and to the next cycle", async () => {
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      if (t.step === 2) assert.match(t.message, /claimed board items that were not assigned to it \(V-09\)/);
      t.write("AUDIT_OK", String(t.step)); report(t, "successful", "fix", t.step === 1 ? "Board: V-09 done - A renumbered item.\nBoard: V-02 progress - Started." : ""); t.commit(`cycle ${t.step}`);
    },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "V-02", title: "assigned", priority: "P1", acceptance: "Assigned acceptance" }] }));
  const { state } = await runOnce(h);
  const first = state.selfImprove?.history[0];
  assert.equal(first?.merged, true, first?.mergeReason ?? "");
  assert.deepEqual(first?.unknownClaims, ["V-09"]);
  const reviews = calls.filter((c) => /You review one cycle/.test(c.system));
  assert.match(nth(reviews, 0).user, /not on this cycle's board: V-09/);
  assert.match(nth(reviews, 0).user, /## Claimed steward board items[\s\S]*Assigned acceptance/);
  assert.match(nth(reviews, 1).user, /## Board items for reference \(the report makes no Board: claim/);
  assert.match(nth(reviews, 1).user, /Previous cycle 01: completed, gate green, merged\./);
});

await check("operator steers reach a live cycle session; one queued during an earlier cycle is marked as such", async () => {
  const seen: Array<{ kind: string; message: string }> = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      seen.push({ kind: t.kind, message: t.message });
      if (seen.length === 1) { t.store.enqueue("steer", { message: "focus on the marker" }); t.hang(); return; }
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("steered");
    },
  });
  const made = h.engine();
  made.engine.pendingFeedback.push({ text: "Operator steering (authoritative): revert the old file", step: 0, inStep: true });
  made.engine.pendingFeedback.push({ text: "Operator steering (authoritative): queued between cycles", step: 0, inStep: false });
  await made.engine.run();
  const first = nth(seen, 0).message;
  assert.match(first, /- Sent during cycle 00, which has ended; apply only if it is still relevant: Operator steering: revert the old file/);
  assert.match(first, /- Operator steering \(authoritative\): queued between cycles/);
  assert.deepEqual([nth(seen, 1).kind, nth(seen, 1).message], ["steer", "Operator steering (authoritative): focus on the marker"], "delivered to the running session, not queued for the next cycle");
  assert.equal(h.state().selfImprove?.history[0]?.merged, true);
});

await check("a session that dies before its first frame is relaunched with the workspace reset still owed", async () => {
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("after a failed start"); },
  });
  const rt = h.runtime();
  rt.dieOnStart = 1;
  const { state } = await runOnce(h, { rt });
  assert.deepEqual(rt.calls.workers.map((w) => w.resetWorkspace), [true, true], "the reset is repeated for the relaunch");
  assert.equal(state.selfImprove?.history[0]?.merged, true);
  // Once a session has started (emitted a frame), a restart keeps its workspace.
  const h2 = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => { if (t.attempt === 1) { t.crash(); return; } t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("after a crash"); },
  });
  const rt2 = h2.runtime();
  await runOnce(h2, { rt: rt2 });
  assert.deepEqual(rt2.calls.workers.map((w) => w.resetWorkspace), [true, false]);
});

await check("an over-budget refusal tells the next cycle to carry a reviewable subset, not to re-carry everything", async () => {
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) { t.write("AUDIT_OK", "1"); t.write("bulk.txt", "x".repeat(70_000)); report(t, "successful"); t.commit("too big"); return; }
      assert.match(t.message, /carry over only a reviewable subset/);
      assert.doesNotMatch(t.message, /bring over what is sound/);
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("small");
    },
  });
  const { state } = await runOnce(h);
  assert.match(state.selfImprove?.history[0]?.mergeReason ?? "", /^the diff without lockfiles/);
  assert.equal(state.selfImprove?.history[1]?.merged, true);
});

cleanup();
done();
