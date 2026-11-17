#!/usr/bin/env node
/**
 * Pre-flight, the empty queue and the deterministic claim checks of the self-improve template
 * (packages/autonomy/lib/preflight.ts, lib/queue.ts, lib/templates/self-improve.ts). The worker
 * and the review model are scripted and the git work is real, as in the self-improve smoke:
 *   - failures are classified (infra, deterministic, product, known flake) from the gate's own output;
 *   - a red base gets a host-built repair cycle, twice at most, then a person is asked;
 *   - provider trouble backs off with no worker started, then parks with waiting_provider;
 *   - a listed flake gets one confirmation run and keeps its first failure; an unlisted failure is not rerun;
 *   - an empty queue sleeps with no model call; a records-only cycle merges on the checks without a review;
 *   - an over-budget diff skips the gate and the review.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, makeChecker, type RawContract } from "./autonomy-helpers.ts";
import { cleanup, harness, runOnce, scratch, NODE_EXIT, type ManagerFn, type ScriptContext } from "./autonomy-harness.ts";
import { classifyFailure, failingNames, preflight } from "../packages/autonomy/lib/preflight.ts";
import { openBacklogRows, queueWork } from "../packages/autonomy/lib/queue.ts";
import type { AcceptanceEvaluation } from "../packages/autonomy/lib/acceptance.ts";
import { REVIEW_DIFF_BUDGET } from "../packages/autonomy/lib/review.ts";

const { check, done } = makeChecker("autonomy-preflight-smoke");

const git = (cwd: string, args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
function sourceRepo(): string {
  const src = scratch();
  for (const args of [["init", "--quiet", "-b", "main"]]) assert.equal(git(src, args).status, 0);
  fs.writeFileSync(path.join(src, "README.md"), "hello\n");
  assert.equal(git(src, ["add", "."]).status, 0);
  assert.equal(git(src, ["commit", "--quiet", "-m", "base"]).status, 0);
  return src;
}
const raw = (src: string, over: RawContract = {}): RawContract => ({
  schemaVersion: 1, run: "preflight-test", template: "self-improve",
  objective: { title: "Improve", spec: "Fix what is broken.", backlog: [{ id: "B-1", title: "Add the marker", detail: "A file called AUDIT_OK must exist." }] },
  inputs: { repository: { path: src, ref: "main" } },
  acceptance: { checks: [{ id: "gate", run: NODE_EXIT("require('fs').existsSync('AUDIT_OK')"), timeoutMinutes: 1, required: true }], review: true },
  permissions: { unattended: { authorised: true, autoApprove: true } },
  budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 8, maxMinutes: 5000 },
  promotion: { policy: "local-branch", destinations: [{ kind: "local-branch", repo: src, branch: "pi-autonomy/integration" }] },
  templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, limits: { nothingFoundToStop: 2 } },
  ...over,
});
const report = (t: ScriptContext, outcome: string): void => t.note(`Outcome: ${outcome}\nMode: fix\n\nDone.\n`);
const reviews: string[] = [];
const manager: ManagerFn = async (system: string, user: string): Promise<string> => {
  if (/You review one cycle/.test(system)) { reviews.push(user); return JSON.stringify({ verdict: "MERGE", reason: "evidenced and tested", concerns: [] }); }
  return JSON.stringify({ decision: "CONTINUE", reason: "fine", extendMinutes: 10 });
};

const result = (id: string, pass: boolean, tail: string, extra: Partial<AcceptanceEvaluation["results"][number]> = {}): AcceptanceEvaluation["results"][number] =>
  ({ id, type: "command", required: true, sha: "s", step: 1, pass, exitCode: pass ? 0 : 1, timedOut: false, seconds: 1, definitionDigest: "d", tail, at: "t", evidence: `${id}.json`, ...extra });
const evaluation = (...results: AcceptanceEvaluation["results"]): AcceptanceEvaluation => ({ sha: "s", step: 1, at: "t", results, allRequiredPass: results.every((r) => r.pass) });

await check("classification: provider and host trouble, an environment that cannot run the check, a listed flake, and a product failure", () => {
  assert.equal(classifyFailure([result("gate", false, "npm ERR! code ECONNRESET\nnetwork error")]), "infra");
  assert.equal(classifyFailure([result("gate", false, "HTTP 429 too many requests")]), "infra");
  assert.equal(classifyFailure([result("gate", false, "", { timedOut: true })]), "infra", "a timeout is host trouble, not a verdict on the code");
  assert.equal(classifyFailure([result("gate", false, "the check could not run: spawn failed", { exitCode: 125 })]), "infra");
  assert.equal(classifyFailure([result("gate", false, "sh: 1: tsc: not found\ncommand not found", { exitCode: 127 })]), "deterministic");
  assert.equal(classifyFailure([result("gate", false, "1 test failed: expected 2 got 3")]), "product");
  assert.equal(classifyFailure([result("gate", false, "AssertionError ... at (lib/foo.ts:503:11)")]), "product", "a line number is not an HTTP status");
  assert.equal(classifyFailure([result("gate", false, "FAIL rate limiter should reject")]), "product", "a test about rate limits is a product failure");
  assert.equal(classifyFailure([result("gate", false, "FAIL x\nAssertionError: expected 1 got 2", { timedOut: true })]), "product", "a timeout beside a test failure is not infra");
  assert.equal(classifyFailure([result("gate", false, "AssertionError", { steps: [{ name: "smoke:x", code: 1, seconds: 1 }, { name: "lint", code: 0, seconds: 1 }] })], ["gate/smoke:x"]), "flake-candidate");
  assert.equal(classifyFailure([result("gate", false, "AssertionError")], ["other"]), "product", "only listed names are flakes");
  assert.equal(classifyFailure([result("a", false, "x"), result("b", false, "ECONNRESET")], ["a"]), "product", "a mixed failure is not waved through as a flake");
  assert.deepEqual(failingNames([result("gate", false, "", { steps: [{ name: "lint", code: 2, seconds: 1 }, { name: "ok", code: 0, seconds: 1 }] }), result("docs", false, ""), result("fine", true, "")]), ["gate/lint", "docs"]);
});

await check("pre-flight: one gate for a green base; a listed flake gets one confirmation run and keeps its first failure; nothing else is rerun", async () => {
  const runs: string[] = [];
  const script = (...evs: AcceptanceEvaluation[]) => ({ knownFlakes: ["gate"], run: async (label: "first" | "confirm") => { runs.push(label); const ev = evs[runs.length - 1]; assert.ok(ev, "no more runs than scripted"); return ev; } });
  assert.deepEqual(await preflight(script(evaluation(result("gate", true, "")))), { verdict: "green" });
  assert.deepEqual(runs, ["first"]);
  runs.length = 0;
  assert.deepEqual(await preflight(script(evaluation(result("gate", false, "flaky")), evaluation(result("gate", true, "")))), { verdict: "flake", failing: ["gate"] });
  assert.deepEqual(runs, ["first", "confirm"], "the first failure has its own run, kept apart from the confirmation");
  runs.length = 0;
  const again = await preflight(script(evaluation(result("gate", false, "flaky")), evaluation(result("gate", false, "still"))));
  assert.equal(again.verdict, "product", "a flake that fails twice is a real failure");
  runs.length = 0;
  const unlisted = await preflight({ knownFlakes: [], run: async (label) => { runs.push(label); return evaluation(result("gate", false, "assertion")); } });
  assert.deepEqual([unlisted.verdict, runs], ["product", ["first"]], "rerunning an unlisted failure until green is not acceptance");
  runs.length = 0;
  const infra = await preflight({ knownFlakes: ["gate"], run: async (label) => { runs.push(label); return evaluation(result("gate", false, "ECONNRESET")); } });
  assert.deepEqual([infra.verdict, runs], ["infra", ["first"]], "provider trouble backs off instead of rerunning");
});

await check("queue: a board run is empty only with nothing offered; a board-less run needs an open backlog row, a red or partial previous cycle, or its first cycle", () => {
  const facts = { stewarded: true, offered: { items: [] }, backlogText: null, steerMessages: 0, hostWork: false, last: undefined, cycles: 3 };
  assert.equal(queueWork(facts), null);
  assert.match(queueWork({ ...facts, offered: { items: [{ id: "X-1", title: "t", priority: "P1", status: "ready" }] } }) ?? "", /board item/);
  assert.equal(queueWork({ ...facts, offered: { items: [{ id: "X-1", title: "t", priority: "P1", status: "blocked" }] } }), null, "a blocked item is not work");
  assert.match(queueWork({ ...facts, steerMessages: 1 }) ?? "", /steer/);
  assert.match(queueWork({ ...facts, hostWork: true }) ?? "", /host has work/);
  const plain = { ...facts, stewarded: false };
  assert.match(queueWork({ ...plain, cycles: 0 }) ?? "", /first cycle/);
  assert.equal(queueWork(plain), null);
  assert.match(queueWork({ ...plain, backlogText: "| ID | Status |\n|--|--|\n| B-1 | open | P2 | x | y |\n| B-2 | done | P2 | x | y |\n" }) ?? "", /1 open backlog/);
  assert.equal(openBacklogRows("| B-1 | done | P2 | x | y |\n| B-2 | dropped | P2 | x | y |\n| B-3 | proposal | P2 | x | y |"), 0);
  assert.equal(openBacklogRows("| B-1 | in-progress | P2 | x | y |"), 1);
  assert.match(queueWork({ ...plain, last: { merged: false, gate: "red", reportOutcome: "successful" } }) ?? "", /gate is red/);
  assert.match(queueWork({ ...plain, last: { merged: true, gate: "green", reportOutcome: "partial" } }) ?? "", /partial/);
});

await check("a red product base gets a repair cycle with no board work, a second one, and then a person is asked: no third worker", async () => {
  reviews.length = 0;
  const prompts: string[] = [];
  const h = harness(raw(sourceRepo()), {
    manager,
    script: async (t) => { prompts.push(t.message); t.write("attempt.txt", `try ${prompts.length}\n`); report(t, "successful"); t.commit(`try ${prompts.length}`); },
    hooks: { onSleep: () => { if (h.state().status === "blocked") h.store.enqueue("cancel"); } },
  });
  const { state } = await runOnce(h);
  assert.equal(prompts.length, 2, "the ordinary repair and one more, never a third on the same red head");
  assert.match(prompts[0] ?? "", /## P0: the base is red[\s\S]*gate/);
  assert.match(prompts[1] ?? "", /## P0: the base is red/);
  assert.doesNotMatch(prompts[0] ?? "", /Assigned work/, "a repair cycle takes no board work");
  assert.equal(state.selfImprove?.preflight?.verdict, "product");
  assert.equal(Object.values(state.selfImprove?.baseRepairs ?? {})[0], 2);
  const asked = state.pendingQuestions.find((q) => q.id === "base-red");
  assert.ok(asked, "a person is asked");
  assert.match(asked.question, /fails its own checks \(gate\).*2 repair cycle\(s\) did not fix it/);
  assert.ok(fs.existsSync(path.join(h.store.p.steps, "01", "preflight", "first", "gate.json")), "the failing evidence is kept");
});

await check("answering the base question looks again and allows two more repairs; the stop answer ends the run", async () => {
  for (const answer of ["Fixed; look again", "Stop the run"]) {
    const prompts: string[] = [];
    let answered = 0;
    const h = harness(raw(sourceRepo(), { run: answer.startsWith("Stop") ? "base-stop" : "base-again" }), {
      manager,
      script: async (t) => { prompts.push(t.message); t.write("attempt.txt", `try ${prompts.length}\n`); report(t, "successful"); t.commit(`try ${prompts.length}`); },
      hooks: { onSleep: () => {
        if (h.state().status !== "blocked" || h.state().blocker?.id !== "base-red") return;
        if (answered === 0 || (answered === 1 && answer.startsWith("Fixed"))) { if (answered === 1) { h.store.enqueue("cancel"); return; } answered = 1; h.store.enqueue("answer", { text: answer }); return; }
        h.store.enqueue("cancel");
      } },
    });
    const { state } = await runOnce(h);
    if (answer.startsWith("Fixed")) {
      assert.equal(prompts.length, 4, "the answer clears the count: two more repairs, then the person is asked again");
      assert.equal(state.pendingQuestions.filter((q) => q.id === "base-red").length, 2);
    } else {
      assert.equal(prompts.length, 2, "no further work after a stop answer");
      assert.equal(state.outcome?.reason, "final_gate_red", "the run ends through the final gate, which the red base fails");
    }
  }
});

await check("provider trouble on the base: backoff with no worker and no model call, then a waiting_provider question", async () => {
  reviews.length = 0;
  const prompts: string[] = [];
  const bad = ["node", "-e", "console.error('read ECONNRESET'); process.exit(1)"];
  const h = harness(raw(sourceRepo(), { acceptance: { checks: [{ id: "gate", run: bad, timeoutMinutes: 1, required: true }], review: true } }), {
    manager,
    script: async (t) => { prompts.push(t.message); t.hang(); },
    hooks: { onSleep: () => { if (h.state().status === "blocked") h.store.enqueue("cancel"); } },
  });
  const started = h.clock.now;
  const { state } = await runOnce(h);
  assert.equal(prompts.length, 0, "no worker session was started on an unusable base");
  assert.equal(reviews.length, 0);
  const asked = state.pendingQuestions.find((q) => q.id === "base-infra");
  assert.ok(asked, "a person is asked after the backoff");
  assert.equal(asked.waiting, "waiting_provider");
  assert.ok(h.clock.now - started >= (5 + 10 + 20 + 40 + 60) * 60_000, "backoff doubled from five minutes up to an hour before asking");
  assert.equal(state.usage.usd, 0, "nothing was spent");
});

await check("a listed flake is confirmed once and then work starts; an unlisted one is not rerun and goes to repair", async () => {
  for (const listed of [true, false]) {
    const marker = path.join(scratch(), "ran-once");
    const flaky = ["node", "-e", `const fs=require('fs');const f=${JSON.stringify(marker)};if(!fs.existsSync(f)){fs.writeFileSync(f,'1');console.error('flaky assertion');process.exit(1)}process.exit(0)`];
    const prompts: string[] = [];
    const h = harness(raw(sourceRepo(), { run: listed ? "flake-listed" : "flake-unlisted", budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, acceptance: { checks: [{ id: "gate", run: flaky, timeoutMinutes: 1, required: true }], review: true }, templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, ...(listed ? { knownFlakes: ["gate"] } : {}) } }), {
      manager, script: async (t) => { prompts.push(t.message); t.write("x.txt", "1\n"); report(t, "successful"); t.commit("x"); },
    });
    const { state } = await runOnce(h);
    const pre = state.selfImprove?.preflight;
    if (listed) {
      assert.equal(pre?.verdict, "flake");
      assert.doesNotMatch(prompts[0] ?? "", /the base is red/, "work starts after the confirmation run");
      assert.ok(fs.existsSync(path.join(h.store.p.steps, "01", "preflight", "first", "gate.json")) && fs.existsSync(path.join(h.store.p.steps, "01", "preflight", "confirm", "gate.json")), "first failure and confirmation are both kept");
      assert.match(fs.readFileSync(path.join(h.store.p.steps, "01", "preflight", "first", "gate.json"), "utf8"), /"pass": false/);
    } else {
      assert.equal(pre?.verdict, "product");
      assert.match(prompts[0] ?? "", /the base is red/, "no rerun: the failure goes to the repair cycle");
      assert.equal(fs.existsSync(path.join(h.store.p.steps, "01", "preflight", "confirm")), false);
    }
  }
});

await check("an empty queue sleeps with no model call, then a run without a board ends as backlog_exhausted", async () => {
  reviews.length = 0;
  const prompts: string[] = [];
  const src = sourceRepo();
  const h = harness(raw(src), {
    manager,
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1\n");
      t.write("autonomy/BACKLOG.md", "# Backlog\n\n| ID | Status | Priority | Item | Source |\n|----|--------|----------|------|--------|\n| B-1 | done | P2 | Add the marker | brief |\n");
      report(t, "successful");
      t.commit("do B-1");
    },
  });
  const { state } = await runOnce(h);
  assert.equal(prompts.length, 1, "the one backlog item was worked; no worker went looking for more");
  assert.equal(reviews.length, 1, "only that cycle was reviewed");
  assert.equal(state.selfImprove?.history.length, 1, "idle looks are not cycles");
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.equal(state.outcome?.reason, "backlog_exhausted");
  assert.equal(state.selfImprove?.idle?.polls, 2, "it looked twice (nothingFoundToStop) with a sleep between, and no model was called");
});

await check("an idle stewarded run retries a publication that failed after its last merge", async () => {
  reviews.length = 0;
  const src = sourceRepo();
  const bare = scratch();
  assert.equal(git(bare, ["init", "--quiet", "--bare"]).status, 0);
  // The remote takes the run's seed, refuses the next push (the merged cycle), and takes pushes again once
  // the idle run's sleep has dropped an `allow` file: a transient publication failure.
  const hook = path.join(bare, "hooks", "pre-receive");
  fs.writeFileSync(hook, `#!/bin/sh\n[ -e "${bare}/allow" ] && exit 0\n[ -e "${bare}/seeded" ] && { echo "transient refusal" >&2; exit 1; }\ntouch "${bare}/seeded"\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
  const h = harness(raw(src, { promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: false }], requiresOperatorApproval: false } }), {
    manager,
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    // First idle sleep: the remote recovers. Third: the operator stops the run (a stop skips publication, so only
    // an idle-pass retry can have pushed the merged head).
    hooks: { onSleep: (_rt, sleeps) => { fs.writeFileSync(path.join(bare, "allow"), ""); if (sleeps >= 3) fs.writeFileSync(path.join(h.store.p.root, "STOP"), ""); } },
    script: async (t) => {
      t.write("AUDIT_OK", "1\n");
      report(t, "successful");
      t.commit("add the marker");
      // The steward settles the only board item, so the queue is empty after this cycle and the run idles.
      fs.writeFileSync(path.join(t.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "H-01", title: "Add the marker", priority: "P2", status: "blocked", acceptance: "AUDIT_OK exists." }] }));
    },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "H-01", title: "Add the marker", priority: "P2", acceptance: "AUDIT_OK exists." }] }));
  const { state } = await runOnce(h);
  assert.equal(state.selfImprove?.history.length, 1, "one cycle, then idle passes only");
  const merged = state.selfImprove?.history[0];
  assert.equal(merged?.merged, true, JSON.stringify(state.outcome));
  assert.ok(fs.existsSync(path.join(bare, "seeded")), "the seed was pushed and the merged cycle's push was refused once");
  assert.equal(state.selfImprove?.publishError ?? null, null, "the idle pass retried the publication and it recovered");
  assert.equal(git(bare, ["rev-parse", "refs/heads/pi-autonomy/integration"]).stdout.trim(), merged?.head, "the merged head reached the remote while the queue was empty");
});

await check("a cycle whose diff holds only this run's records merges on `nothing found` without a review and is refused for any other claim", async () => {
  for (const outcome of ["nothing found", "successful"]) {
    reviews.length = 0;
    // The base already passes the gate, so the cycle's only change is its own report.
    const src = sourceRepo();
    fs.writeFileSync(path.join(src, "AUDIT_OK"), "1\n");
    assert.equal(git(src, ["add", "."]).status, 0);
    assert.equal(git(src, ["commit", "--quiet", "-m", "base passes"]).status, 0);
    const h = harness(raw(src, { run: `records-${outcome.replace(" ", "-")}`, budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
      manager, script: async (t) => { report(t, outcome); t.write(`autonomy/cycles/records-${outcome.replace(" ", "-")}/01/notes.txt`, "a record the host does not review\n"); t.commit("records only"); },
    });
    const { state } = await runOnce(h);
    const entry = state.selfImprove?.history[0];
    assert.equal(reviews.length, 0, "no model reads a diff with no work in it");
    if (outcome === "nothing found") { assert.equal(entry?.merged, true); assert.match(entry?.mergeReason ?? "", /nothing found: the diff holds only this run's records/); }
    else { assert.equal(entry?.merged, false); assert.match(entry?.mergeReason ?? "", /says successful but the cycle changed nothing outside this run's records/); }
  }
});

await check("an over-budget diff is refused before the acceptance gate and the review; the next cycle is told to carry a subset", async () => {
  reviews.length = 0;
  const gateRuns = path.join(scratch(), "gate-runs");
  const counting = ["node", "-e", `require('fs').appendFileSync(${JSON.stringify(gateRuns)},'x');process.exit(require('fs').existsSync('AUDIT_OK')?0:1)`];
  const prompts: string[] = [];
  const src = sourceRepo();
  fs.writeFileSync(path.join(src, "AUDIT_OK"), "1\n");
  assert.equal(git(src, ["add", "."]).status, 0);
  assert.equal(git(src, ["commit", "--quiet", "-m", "base passes"]).status, 0);
  const h = harness(raw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, acceptance: { checks: [{ id: "gate", run: counting, timeoutMinutes: 1, required: true }], review: true } }), {
    manager,
    script: async (t) => {
      if (t.message.startsWith("The diff this cycle would submit is")) return; // the live budget steer: the worker leaves the head as it is
      prompts.push(t.message);
      if (prompts.length === 1) { t.write("src/bulk.txt", `${"x".repeat(80)}\n`.repeat(Math.ceil(REVIEW_DIFF_BUDGET / 80) + 10)); }
      else t.write("src/small.txt", "ok\n");
      report(t, "successful");
      t.commit(`cycle ${prompts.length}`);
    },
  });
  const { state } = await runOnce(h);
  const [c1, c2] = state.selfImprove?.history ?? [];
  assert.equal(c1?.merged, false);
  assert.match(c1?.mergeReason ?? "", /^the diff without lockfiles and this run's record files \(\d+ characters\) exceeds the merge review's budget/);
  assert.equal(c1?.gate, "skipped", "the gate's minutes were not spent on a diff that can never be reviewed");
  assert.equal(c2?.merged, true);
  assert.equal(reviews.length, 1, "only the reviewable cycle reached a model");
  assert.match(prompts[1] ?? "", /Its commits are on `origin\/attempts\/preflight-test\/cycle-01`: carry over only a reviewable subset/);
  // The pre-flight gate (one) plus the second cycle's acceptance (one): the over-budget cycle ran none.
  assert.equal(fs.readFileSync(gateRuns, "utf8").length, 2, "the over-budget cycle never reached the gate");
});

cleanup();
done();
