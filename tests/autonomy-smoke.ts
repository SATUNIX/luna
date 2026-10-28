#!/usr/bin/env node
/**
 * Offline checks for the autonomy runner (packages/autonomy): run config, manager triggers and
 * decision validation, the RPC auto-operator, mirror refspec limits, relay routing and usage
 * metering, the host git mirror and the integration branch (real git against local bare
 * repositories), the merge review's verdict parsing, the container
 * boundary arguments (the full containment table is tests/autonomy-boundary-smoke.ts), and the cycle control loop driven by a fake runtime with a virtual clock.
 * Docker and the network are not touched; the live boundary test is packages/autonomy/tests/boundary.sh.
 */
import assert from "node:assert/strict";
import { resolveConfig } from "../packages/autonomy/lib/config.ts";
import { evaluate, runStop, reportOutcome, nothingFoundInARow } from "../packages/autonomy/lib/triggers.ts";
import { type ManagerBundle, type ManagerDecision, parseDecision, buildBundle, DECISIONS } from "../packages/autonomy/lib/manager.ts";
import { uiResponse, lineParser, isGuardEscalation, OPERATOR_ANSWER, missingHarness, HARNESS_COMMANDS } from "../packages/autonomy/lib/rpc.ts";
import { publishRefspecs } from "../packages/autonomy/lib/mirror.ts";
import { exportRun } from "../packages/autonomy/lib/export.ts";
import { parseReview, reviewCycle, buildReviewBundle } from "../packages/autonomy/lib/review.ts";
import { route, withUsage, screen, usageFrom, meteredUsd } from "../packages/autonomy/relay.ts";
import { runCycle } from "../packages/autonomy/lib/cycle.ts";
import { HostRepo } from "../packages/autonomy/lib/hostrepo.ts";
import * as gm from "../packages/autonomy/lib/gitmirror.ts";
import * as dk from "../packages/autonomy/lib/docker.ts";
import { modelEntries, agentModelsJson } from "../packages/autonomy/lib/models.ts";
import { resolveContract } from "../packages/autonomy/lib/contract.ts";
import { runtimeConfig } from "../packages/autonomy/lib/runcfg.ts";
import { testEffort } from "./autonomy-helpers.ts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- types for the JS boundary -------------------------------------------------------------------
// Several lib functions destructure optional options without defaults (runStop's stopFile, agentRunArgs'
// effort, seedBranch's parent, runCycle's restartBriefing/cycleDir), so their inferred parameter types make
// those keys required; the calls below pass them explicitly as undefined, which destructures identically.

/** A manager decision as parseDecision returns it (manager.ts infers only decision and reason). */
interface ParsedDecision {
  decision: string;
  reason: string;
  message?: string;
  extendMinutes?: number;
}

/** What the cycle loop hands the manager (cycle.ts). */
type ManagerRequest = ManagerBundle;

/** An RPC message the fake agent was sent. */
interface SentMessage {
  attempt: number;
  type: string;
  message?: string;
  id?: string;
  confirmed?: boolean;
  [key: string]: unknown;
}

/** The world a fake-runtime script can change on each tick. */
interface TickTools {
  minute: number;
  attempt: number;
  emit: (ev: { type: string; [key: string]: unknown }) => void;
  commit: () => void;
  report: () => void;
  spend: (usd: number) => void;
  exit: (code: number) => void;
}

interface FakeAgent {
  send(m: { type: string; [key: string]: unknown }): void;
  stop(): Promise<void>;
  exited: Promise<{ code: number }>;
}

/** The runtime interface runCycle drives (cycle.ts header), plus what the tests record. */
interface CycleRuntime {
  tickMs: number;
  now(): number;
  sleep: (ms: number) => Promise<void>;
  headSha(): Promise<string>;
  reportExists(): Promise<boolean>;
  meterUsd(): Promise<number>;
  totalUsd(): Promise<number>;
  stopRequested(): boolean;
  gates(): Promise<string[]>;
  extras(): Promise<{ gitLog: string; plan: string; handoff: string }>;
  publish(): Promise<void>;
  log(l: string): void;
  resets: string[];
  resetToLastGood(sha: string): Promise<void>;
  managerCalls: ManagerRequest[];
  manager(b: ManagerRequest): Promise<ManagerDecision>;
  starts: number;
  startAgent(o: { attempt: number; onEvent: TickTools["emit"] }): FakeAgent;
}

interface FakeRuntimeOptions {
  script: (tools: TickTools) => void;
  manager: Error | ManagerDecision | ((b: ManagerRequest) => ManagerDecision);
  gates?: string[];
  tickMin?: number;
}

let checks = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  await fn();
  checks++;
  console.log(`  OK: ${name}`);
}

const cfg = resolveConfig({ run: "perpetual-test" });
const MIN = 60_000;

await check("config: defaults, derived branch/tags, and unsafe values rejected", () => {
  assert.equal(cfg.branch, "experimental/perpetual-test");
  assert.equal(cfg.tagPrefix, "exp/perpetual-test/");
  assert.equal(cfg.integrationBranch, "experimental/main");
  assert.equal(cfg.integration.review, true);
  assert.equal(cfg.reviewModel, cfg.managerModel, "the review model defaults to the manager's");
  assert.throws(() => resolveConfig({ run: "ok-run", integration: { branch: "main" } }), /integration\.branch/);
  assert.equal(resolveConfig({ run: "ok-run", integration: { branch: "bots/integration" } }).integrationBranch, "bots/integration", "the integration branch is configurable, not hard-coded to experimental/*");
  assert.equal(cfg.gitRemote, null, "there is no default remote");
  assert.throws(() => resolveConfig({ run: "ok-run", integration: { branch: "experimental/../main" } }), /integration\.branch/);
  assert.equal(cfg.cycles, 50);
  assert.equal(cfg.limits.softMinutes, 180);
  assert.equal(cfg.limits.hardMinutes, 300);
  assert.throws(() => resolveConfig({ run: "Main" }), /run:/);
  assert.throws(() => resolveConfig({ run: "ok-run", budget: { perCycleUsd: 5, totalUsd: 1 } }), /budget/);
  assert.deepEqual(cfg.budget, { perCycleUsd: 5, perCycleHardUsd: 10, totalUsd: 100 });
  assert.equal(resolveConfig({ run: "ok-run", budget: { perCycleUsd: 0.5, perCycleHardUsd: null, totalUsd: 5 } }).budget.perCycleHardUsd, 1, "hard defaults to twice the review budget");
  assert.throws(() => resolveConfig({ run: "ok-run", budget: { perCycleUsd: 2, perCycleHardUsd: 1 } }), /budget/);
  assert.throws(() => resolveConfig({ run: "ok-run", limits: { softMinutes: 300, hardMinutes: 200 } }), /hardMinutes/);
  assert.throws(() => resolveConfig({ run: "ok-run", upstream: "http://openrouter.ai" }), /upstream/);
});

await check("triggers: idle, no-commit, soft limit, budget, crash; hard stops skip the manager", () => {
  const base = { startedAt: 0, lastEventAt: 0, handled: new Set<string>() };
  assert.deepEqual(evaluate(base, 5 * MIN, cfg), { stop: null, triggers: [] });
  assert.deepEqual(evaluate(base, 21 * MIN, cfg).triggers, ["idle:0"]);
  assert.deepEqual(evaluate({ ...base, lastEventAt: 89 * MIN }, 91 * MIN, cfg).triggers, ["no_commit:0"]);
  assert.ok(evaluate({ ...base, lastEventAt: 180 * MIN, lastCommitAt: 179 * MIN }, 181 * MIN, cfg).triggers.includes("soft_limit"));
  assert.ok(evaluate({ ...base, costUsd: 5.1 }, MIN, cfg).triggers.includes("cycle_budget"));
  assert.ok(evaluate({ ...base, exited: { code: 137 } }, MIN, cfg).triggers.includes("crash:137"));
  // Handled keys do not fire again; an extension moves the idle key.
  assert.deepEqual(evaluate({ ...base, handled: new Set(["idle:0"]) }, 21 * MIN, cfg).triggers, []);
  assert.deepEqual(evaluate({ ...base, extendedMinutes: 15, handled: new Set(["idle:0"]) }, 36 * MIN, cfg).triggers, ["idle:15"]);
  assert.equal(evaluate(base, 300 * MIN, cfg).stop, "hard_limit");
  assert.equal(evaluate({ ...base, costUsd: 10 }, MIN, cfg).stop, "cycle_budget_hard");
  assert.equal(evaluate({ ...base, managerCalls: 3 }, 21 * MIN, cfg).stop, "manager_calls_exhausted");
  assert.equal(runStop({ totalCostUsd: 100, cyclesDone: 3, stopFile: undefined }, cfg), "total_budget");
  assert.equal(runStop({ totalCostUsd: 1, cyclesDone: 50, stopFile: undefined }, cfg), "cycles_done");
  assert.equal(runStop({ totalCostUsd: 1, cyclesDone: 3, stopFile: true }, cfg), "stop_file");
  assert.equal(cfg.limits.nothingFoundToStop, 3);
  assert.equal(runStop({ totalCostUsd: 1, cyclesDone: 3, stopFile: undefined, nothingFoundInARow: 2 }, cfg), null);
  assert.equal(runStop({ totalCostUsd: 1, cyclesDone: 3, stopFile: undefined, nothingFoundInARow: 3 }, cfg), "backlog_exhausted");
  assert.throws(() => resolveConfig({ run: "ok-run", limits: { nothingFoundToStop: 0 } }), /nothingFoundToStop/);
});

await check("cycle reports: declared outcome and mode are read; nothing-found streaks counted", () => {
  // The format cycle 01 of the live run actually used, and the one the prompt now asks for.
  assert.deepEqual(reportOutcome("# Cycle 01 — Report\n\n**Outcome: successful.** Both items done."), { outcome: "successful", mode: null });
  assert.deepEqual(reportOutcome("# Report\nOutcome: nothing found\nMode: fix\n"), { outcome: "nothing found", mode: "fix" });
  assert.deepEqual(reportOutcome("Outcome: `partial`\n**Mode:** Improve"), { outcome: "partial", mode: "improve" });
  assert.deepEqual(reportOutcome("Outcome: nothing-found"), { outcome: "nothing found", mode: null });
  assert.deepEqual(reportOutcome("no header here\n".repeat(30) + "Outcome: failed"), { outcome: null, mode: null }, "only the top of the report counts");
  assert.deepEqual(reportOutcome(null), { outcome: null, mode: null });
  const h = (o: string) => ({ reportOutcome: o });
  assert.equal(nothingFoundInARow([h("successful"), h("nothing found"), h("nothing found")]), 2);
  assert.equal(nothingFoundInARow([h("nothing found"), h("successful")]), 0);
  assert.equal(nothingFoundInARow([]), 0);
});

await check("manager: only the fixed decisions, with required fields, clamped", () => {
  assert.deepEqual(Object.keys(DECISIONS), ["CONTINUE", "NUDGE", "RESTART_SESSION", "NEW_CYCLE", "RESET_TO_LAST_GOOD", "ABORT_RUN"]);
  assert.deepEqual(parseDecision('```json\n{"decision":"CONTINUE","reason":"commits landing","extendMinutes":500}\n```'), { decision: "CONTINUE", reason: "commits landing", extendMinutes: 120 });
  assert.equal((parseDecision('Sure: {"decision":"NUDGE","reason":"r","message":"run the tests"}') as ParsedDecision).message, "run the tests");
  assert.throws(() => parseDecision('{"decision":"DELETE_REPO","reason":"x"}'), /unknown decision/);
  assert.throws(() => parseDecision('{"decision":"NUDGE","reason":"x"}'), /needs message/);
  assert.throws(() => parseDecision('{"decision":"ABORT_RUN"}'), /reason/);
  assert.throws(() => parseDecision("no json here"), /no JSON/);
  const bundle = buildBundle({ run: "r", cycle: 2, cycles: 50, triggers: ["idle:0"], limits: cfg.limits, budget: cfg.budget, elapsedMinutes: 30, activity: "x".repeat(50_000) });
  assert.ok(bundle.length < 30_000, "bundle is bounded");
});

await check("rpc: dialogs are approved like an attentive operator; notices get no reply", () => {
  /** The reply to a dialog that gets one (uiResponse is null only for fire-and-forget methods). */
  const reply = (req: Record<string, unknown>) => { const r = uiResponse(req); assert.ok(r && "value" in r, "the dialog gets a reply with a value"); return r; };
  assert.deepEqual(uiResponse({ id: "1", method: "confirm", title: "Run?" }), { type: "extension_ui_response", id: "1", confirmed: true });
  assert.equal(reply({ id: "2", method: "select", options: ["Allow once", "Allow for this session (exact repeats only)", "Deny"] }).value, "Allow for this session (exact repeats only)");
  assert.equal(reply({ id: "3", method: "select", options: ["Block", "Allow"] }).value, "Allow");
  assert.equal(reply({ id: "4", method: "select", options: ["Deny", "Option B"] }).value, "Option B");
  assert.equal(reply({ id: "5", method: "input", title: "Which approach?" }).value, OPERATOR_ANSWER);
  assert.equal(reply({ id: "6", method: "editor", prefill: "draft" }).value, "draft");
  assert.equal(uiResponse({ id: "7", method: "notify", message: "hi" }), null);
  // rpc.ts defaults onBad to `() => {}`, so inference gives it no parameter; it is called with the malformed line.
  const parseLines = lineParser as (onMessage: (msg: { type: string }) => void, onBad?: (line: string) => void) => (chunk: string) => void;
  const got: Array<{ type: string }> = []; const bad: string[] = [];
  const feed = parseLines((m) => got.push(m), (l) => bad.push(l));
  feed('{"type":"a"}\n{"type":'); feed('"b"}\nnot json\n');
  assert.deepEqual(got.map((m) => m.type), ["a", "b"]);
  assert.deepEqual(bad, ["not json"]);
  assert.ok(isGuardEscalation({ type: "extension_ui_request", method: "notify", message: "progress-guard: loop detected" }));
});

await check("mirror: only the integration branch and the run's exp/<run>/ tags leave the host", () => {
  const refs = [
    "a refs/heads/experimental/perpetual-test",
    "g refs/heads/experimental/main",
    "b refs/heads/main",
    "c refs/heads/experimental/other-run",
    "d refs/tags/exp/perpetual-test/cycle-01",
    "e refs/tags/v9.9.9",
    "f refs/tags/exp/perpetual-test/../../heads/main",
  ].join("\n");
  assert.deepEqual(publishRefspecs(refs, cfg), [
    "refs/heads/experimental/main:refs/heads/experimental/main",
    "refs/tags/exp/perpetual-test/cycle-01:refs/tags/exp/perpetual-test/cycle-01",
  ]);
  assert.ok(publishRefspecs(refs, cfg).every((s) => !s.startsWith("+")), "never a forced refspec");
});

await check("relay: inference paths only; usage requested and metered from SSE and JSON", () => {
  assert.equal(route("POST", "/v1/chat/completions"), "/chat/completions");
  assert.equal(route("GET", "/v1/models?x=1"), "/models");
  for (const [m, u] of [["GET", "/v1/chat/completions"], ["POST", "/v1/../../etc"], ["POST", "/api/v1/keys"], ["POST", "http://evil/v1/chat/completions"]]) assert.equal(route(m, u), null, `${m} ${u}`);
  assert.deepEqual(withUsage({ model: "m", usage: { foo: 1 } }).usage, { foo: 1, include: true });
  const sse = 'data: {"choices":[]}\n\ndata: {"model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.0012}}\n\ndata: [DONE]\n';
  assert.deepEqual(usageFrom(sse), [{ model: "m", promptTokens: 10, completionTokens: 5, costUsd: 0.0012 }]);
  assert.equal(usageFrom('{"model":"m","usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.5}}')[0]?.costUsd, 0.5);
  // A model name that is an inherited property of the price table is unpriced, never NaN (NaN would disable the relay's budget stop).
  // A negative reported cost or token count is not usage: the reported cost falls back to the
  // price table, and negative tokens leave the record unmetered, so spend can never go down.
  assert.equal(usageFrom('{"model":"m","usage":{"prompt_tokens":1000000,"completion_tokens":0,"cost":-5}}', { m: { inputPerMTok: 2, outputPerMTok: 4 } })[0]?.costUsd, 2);
  assert.deepEqual(usageFrom('{"model":"m","usage":{"prompt_tokens":-1000000,"completion_tokens":0,"cost":-5}}', { m: { inputPerMTok: 2, outputPerMTok: 4 } }), [{ model: "m", promptTokens: null, completionTokens: 0, costUsd: null, unmetered: true }]);
  assert.deepEqual(usageFrom('{"model":"constructor","usage":{"prompt_tokens":1,"completion_tokens":1}}', {}), [{ model: "constructor", promptTokens: 1, completionTokens: 1, costUsd: null, unmetered: true }]);
  assert.equal(meteredUsd('{"costUsd":0.5}\n{"costUsd":0.25}\nbroken\n{"costUsd":null}\n'), 0.75);
});

await check("relay: only the run's models; OpenRouter web search refused or stripped", () => {
  const models = ["deepseek/deepseek-v4.1-flash"];
  const ok = screen({ model: models[0], messages: [], plugins: [{ id: "web" }, { id: "file-parser" }], web_search_options: {} }, models);
  assert.equal(ok.error, undefined);
  assert.ok(ok.body, "the request is served");
  assert.deepEqual(ok.body.plugins, [{ id: "file-parser" }]);
  assert.equal("web_search_options" in ok.body, false);
  assert.deepEqual(ok.body.usage, { include: true });
  const stripped = screen({ model: models[0], plugins: [{ id: "web" }] }, models).body;
  assert.ok(stripped, "the request is served");
  assert.equal("plugins" in stripped, false);
  /** The refusal text of a screened request. */
  const refusal = (r: ReturnType<typeof screen>): string => { assert.ok(typeof r.error === "string", "the request is refused"); return r.error; };
  assert.match(refusal(screen({ model: "openai/gpt-5" }, models)), /not allowed/);
  assert.match(refusal(screen({ model: `${models[0]}:online` }, models)), /Online/);
  assert.match(refusal(screen({ model: "x:online" })), /Online/, "refused even without an allowlist");
  assert.match(refusal(screen([1])), /JSON object/);
});

await check("docker: agent on the internal network only, no credentials or host home, hardened", () => {
  const p = { remote: "/r/remote.git", work: "/r/work", agentState: "/r/agent-state", meter: "/r/meter", bundles: "/r/bundles", gateWork: "/r/gate", public: "/r/public", checks: "/r/checks.json", overlay: "/r/overlay", egress: "/r/egress", deploy: "/r/deploy", references: "/r/references", root: "/r" };
  // A run's flat configuration is derived from its contract (lib/runcfg.ts); v0's resolveConfig no longer feeds the builders.
  const contractCfg = (over: Record<string, unknown> = {}) => {
    const r = resolveContract({ schemaVersion: 1, run: "perpetual-test", template: "implement", objective: { title: "t", spec: "s" }, acceptance: { checks: [{ id: "gate", run: ["true"] }] }, permissions: { unattended: { authorised: true, autoApprove: true } }, ...over }, { effort: testEffort });
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.ok(r.contract, "resolved"); // narrows; never fails after the check above
    return runtimeConfig(r.contract);
  };
  const dcfg = contractCfg();
  const agent = dk.agentRunArgs(dcfg, p, { n: 3, attempt: 1, reset: true, effort: undefined });
  const flag = (args: readonly string[], f: string): string[] => args.flatMap((a, i) => {
    if (a !== f) return [];
    const value = args[i + 1];
    assert.ok(value !== undefined, `${f} is followed by a value`);
    return [value];
  });
  assert.deepEqual(flag(agent, "--network"), ["pi-exp-perpetual-test"]);
  for (const f of ["--read-only", "--cap-drop", "--security-opt", "--pids-limit", "--memory"]) assert.ok(agent.includes(f), f);
  assert.deepEqual(flag(agent, "--mount").map((m) => m.split(",")[1]), ["source=/r/remote.git", "source=/r/work", "source=/r/agent-state", "source=/r/public"]);
  const env = flag(agent, "--env").join("\n");
  assert.doesNotMatch(env, /KEY|TOKEN|SECRET|PASSWORD/i);
  assert.match(env, /^CYCLE_RESET=1$/m);
  assert.ok(!agent.join(" ").includes("docker.sock") && !agent.join(" ").includes(os.homedir()));
  assert.ok(!agent.includes("--privileged") && !agent.some((a) => a.startsWith("--cap-add")));
  const [internal, egress] = dk.networkCreateArgs(dcfg);
  assert.ok(egress, "an egress network is created");
  assert.deepEqual(internal, ["network", "create", "--internal", "pi-exp-perpetual-test"]);
  assert.equal(egress.at(-1), "pi-exp-perpetual-test-egress");
  assert.deepEqual(flag(dk.relayRunArgs(dcfg, p, "/k/relay.ts"), "--network"), ["pi-exp-perpetual-test-egress"], "relay joins the run network only by alias, after start");
  const checkArgs = dk.checkRunArgs(dcfg, p, { bundleFile: "/b", sha: "a".repeat(40), checkId: "gate", runnerScript: "/k/check-runner.ts", hasOverlay: false });
  for (const helper of [dk.bundleRunArgs(dcfg, p), checkArgs, dk.setAgentRefRunArgs(dcfg, p, { bundleFile: "/b", sha: "a".repeat(40) }), dk.snapshotRunArgs(dcfg, p, { message: "m" })]) {
    assert.deepEqual(flag(helper, "--network"), ["none"]);
  }
  assert.ok(dk.bundleRunArgs(dcfg, p).some((a) => a.includes("target=/git/remote.git,readonly")), "bundling reads the agent repo read-only");
  const withRef = dk.agentRunArgs(contractCfg({ inputs: { references: { "agentic-repo-kit": "/src/ark" } } }), { ...p, references: "/r/references" }, { n: 1, attempt: 1, reset: false, effort: undefined });
  assert.ok(withRef.includes("type=bind,source=/r/references/agentic-repo-kit,target=/reference/agentic-repo-kit,readonly"), "references are snapshots, mounted read-only");
  assert.ok(!withRef.join(" ").includes("/src/ark"), "the live reference repo is never mounted");
  assert.throws(() => resolveConfig({ run: "ok-run", references: { "../x": "/y" } }), /references/);
  assert.equal(dk.userSpec({ container: { user: "host" } }, 1234, 99), "1234:99");
  assert.equal(dcfg.engine, "podman");
  assert.ok(agent.includes("--userns=keep-id"), "podman maps the operator's uid to itself");
  assert.ok(!dk.agentRunArgs(contractCfg({ runtime: { engine: "docker" } }), p, { n: 1, attempt: 1, reset: undefined, effort: undefined }).includes("--userns=keep-id"));
  assert.throws(() => resolveConfig({ run: "ok-run", engine: "lxc" }), /engine/);
  assert.equal(dk.userSpec({ container: { user: "0:0" } }), "0:0");
});

await check("cycle: mechanical exit recovery is immediate, bounded and does not consume judgement calls", async () => {
  for (const code of [0, 137]) {
    const { rt } = fakeRuntime({ manager: new Error("must not be called"), script: ({ exit }) => exit(code) });
    const r = await runCycle({ n: 1, cfg: { ...cfg, limits: { ...cfg.limits, autoRestartsPerCycle: 3 } }, rt, prompt: "continue" });
    assert.equal(r.reason, "auto_restarts_exhausted");
    assert.equal(r.attempts, 4);
    assert.equal(rt.now(), 4 * rt.tickMs);
    assert.equal(rt.managerCalls.length, 0);
  }
  const { rt } = fakeRuntime({ manager: new Error("must not be called"), script: ({ exit }) => exit(1) });
  const r = await runCycle({ n: 1, cfg, rt, prompt: "resume", autoRestartsUsed: 3 });
  assert.equal(r.attempts, 1, "a persisted allowance is not replenished");
});

await check("cycle: hard budgets and STOP take priority over recovery; a dead process with a recorded report completes", async () => {
  for (const which of ["budget", "stop", "report"]) {
    const { rt } = fakeRuntime({ manager: new Error("must not be called"), script: ({ exit, spend, report }) => { if (which === "budget") spend(100); if (which === "report") report(); exit(137); } });
    if (which === "stop") rt.stopRequested = () => true;
    const r = await runCycle({ n: 1, cfg, rt, prompt: "p" });
    assert.equal(r.attempts, 1);
    assert.equal(r.outcome, which === "report" ? "completed" : "aborted");
  }
  const { rt } = fakeRuntime({ manager: new Error("must not be called"), script: ({ exit, spend }) => { spend(cfg.budget.perCycleHardUsd); exit(137); } });
  const r = await runCycle({ n: 1, cfg, rt, prompt: "p" });
  assert.equal(r.reason, "cycle_budget_hard");
});

await check("publication and promotion refuse a push when the host leak scan cannot complete", () => {
  const calls: string[] = [];
  const sha = "a".repeat(40);
  const g: gm.HostGit = Object.assign((args: readonly string[]): string => {
    calls.push(args[0] ?? "");
    if (args[0] === "for-each-ref") return `${sha} refs/heads/${cfg.integrationBranch}`;
    if (args[0] === "ls-remote") throw new Error("synthetic remote lookup failure");
    return "";
  }, { gitDir: "unused-host-mirror" });
  assert.throws(() => gm.publish(g, { ...cfg, gitRemote: "https://git.example.org/team/repo.git" }, null), gm.PublishBlocked);
  const repo = new HostRepo({ gitDir: g.gitDir, cfg }); repo.g = g;
  assert.throws(() => repo.promotePush("https://git.example.org/team/repo.git", cfg.integrationBranch, sha), gm.PublishBlocked);
  assert.equal(calls.includes("push"), false, "no push after a failed scan, even on promotion");
});

await check("git mirror: integration branch seeded and continued, fast-forward only, tags never move, nothing forced", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-git-"));
  try {
    const sh = (cwd: string, ...args: string[]): string => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    // "GitLab": a bare repo with main and an unrelated branch the run must never push.
    const origin = path.join(tmp, "origin.git");
    const dev = path.join(tmp, "dev");
    sh(tmp, "init", "--quiet", "--bare", origin);
    sh(tmp, "init", "--quiet", dev);
    fs.writeFileSync(path.join(dev, "README.md"), "hi\n");
    sh(dev, "add", "."); sh(dev, "commit", "--quiet", "-m", "base");
    sh(dev, "push", "--quiet", origin, "HEAD:refs/heads/main", "HEAD:refs/heads/other");
    const remoteRef = (ref: string): string | null => spawnSync("git", ["--git-dir", origin, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" }).stdout.trim() || null;
    const c = resolveConfig({ run: "git-test", gitRemote: origin });
    const seedDir = path.join(tmp, "seed"); fs.mkdirSync(seedDir);
    fs.writeFileSync(path.join(seedDir, "CHARTER.md"), "{{BRANCH}} from {{BASE_REF}} {{UNKNOWN}}\n");

    // First run: the integration branch does not exist yet and is seeded from main.
    const g = gm.initMirror(path.join(tmp, "mirror.git"));
    const base = gm.fetchBase(g, c);
    assert.equal(gm.remoteHasRunTags(g, c), false);
    assert.equal(gm.syncIntegration(g, c).state, "absent");
    const seed = gm.seedBranch(g, c, { seedDir, tmpDir: tmp, vars: { BRANCH: c.integrationBranch, BASE_REF: "main" }, parent: undefined });
    assert.equal(gm.fileAt(g, seed, "autonomy/CHARTER.md"), "experimental/main from main {{UNKNOWN}}");
    assert.equal(g(["rev-parse", `${seed}^`]), base);
    assert.equal(g(["log", "-1", "--format=%an", seed]), "pi autonomy");
    assert.equal(gm.startCycleBranch(g, c), seed);
    assert.equal(g(["rev-parse", `refs/heads/${c.branch}`]), seed);
    let pub = gm.publish(g, c, null);
    assert.equal(remoteRef("refs/heads/experimental/main"), seed);
    assert.equal(remoteRef("refs/heads/experimental/git-test"), null, "the working branch is never published");
    assert.equal(gm.publish(g, c, pub.state).pushed, false, "nothing new, no push");

    // The agent's side: a clone that commits and is bundled.
    const agentRepo = path.join(tmp, "agent.git");
    sh(tmp, "clone", "--quiet", "--bare", path.join(tmp, "mirror.git"), agentRepo);
    const work = path.join(tmp, "work");
    sh(tmp, "clone", "--quiet", "--branch", c.branch, agentRepo, work);
    const commit = (msg: string): string => { fs.appendFileSync(path.join(work, "README.md"), msg + "\n"); sh(work, "commit", "--quiet", "-am", msg); return sh(work, "rev-parse", "HEAD"); };
    const bundle = (name: string): string => { const f = path.join(tmp, name); sh(work, "bundle", "create", "--quiet", f, `refs/heads/${c.branch}`); return f; };
    const c1 = commit("one");
    let r = gm.ingestBundle(g, c, bundle("b1"));
    assert.deepEqual([r.moved, r.diverged, r.head], [true, false, c1]);
    // Rewritten history is recorded but not accepted.
    sh(work, "reset", "--quiet", "--hard", seed);
    const rogue = commit("rewrite");
    r = gm.ingestBundle(g, c, bundle("b2"));
    assert.deepEqual([r.moved, r.diverged, r.head, r.agent], [false, true, c1, rogue]);
    sh(work, "reset", "--quiet", "--hard", c1);
    const c2 = commit("two");
    assert.equal(gm.ingestBundle(g, c, bundle("b3")).head, c2);
    assert.equal(remoteRef("refs/heads/experimental/main"), seed, "cycle work is not published before it is merged");

    // Tags: created once, never moved. Merging is a fast-forward of the integration branch only.
    assert.equal(gm.tag(g, c, "cycle-01", c2), true);
    assert.equal(gm.tag(g, c, "cycle-01", c1), false);
    assert.deepEqual(gm.integrate(g, c, c2), { merged: true, from: seed });
    assert.deepEqual(gm.integrate(g, c, rogue), { merged: false, reason: "not a fast-forward of experimental/main" });
    assert.deepEqual(gm.integrate(g, c, c2), { merged: false, reason: "nothing new" });
    g(["update-ref", "refs/tags/v9.9.9", c2]);
    g(["update-ref", "refs/heads/main", c2]);
    pub = gm.publish(g, c, pub.state);
    assert.equal(pub.pushed, true);
    assert.equal(remoteRef("refs/heads/experimental/main"), c2);
    assert.equal(remoteRef("refs/tags/exp/git-test/cycle-01"), c2);
    assert.equal(remoteRef("refs/heads/main"), base, "main untouched");
    assert.equal(remoteRef("refs/tags/v9.9.9"), null);
    assert.equal(gm.remoteHasRunTags(g, c), true, "a run id is used once");

    // Reset: the abandoned head is tagged and the working branch goes back to the integration
    // head, locally; the published branch is never rewound.
    const c3 = commit("three");
    gm.ingestBundle(g, c, bundle("b4"));
    assert.deepEqual(gm.resetBranch(g, c, { abandonedTag: "abandoned-02" }), { from: c3, to: c2 });
    assert.equal(g(["rev-parse", `refs/heads/${c.branch}`]), c2);
    gm.publish(g, c, null);
    assert.equal(remoteRef("refs/tags/exp/git-test/abandoned-02"), c3);
    assert.equal(remoteRef("refs/heads/experimental/main"), c2);
    assert.match(gm.logSince(g, seed, c2), /one/);

    // The operator pushes a fix to experimental/main: the next cycle adopts it.
    sh(dev, "fetch", "--quiet", origin, "experimental/main");
    sh(dev, "checkout", "--quiet", "-B", "exp", "FETCH_HEAD");
    fs.writeFileSync(path.join(dev, "FIX.md"), "fix\n");
    sh(dev, "add", "."); sh(dev, "commit", "--quiet", "-m", "operator fix");
    const fix = sh(dev, "rev-parse", "HEAD");
    sh(dev, "push", "--quiet", origin, "HEAD:refs/heads/experimental/main");
    assert.deepEqual(gm.syncIntegration(g, c), { state: "adopted", head: fix });
    assert.equal(gm.startCycleBranch(g, c), fix);

    // A second run continues experimental/main and merges main's new commits in.
    sh(dev, "checkout", "--quiet", "main");
    fs.writeFileSync(path.join(dev, "MAIN.md"), "main moved\n");
    sh(dev, "add", "."); sh(dev, "commit", "--quiet", "-m", "main moves");
    const main2 = sh(dev, "rev-parse", "HEAD");
    sh(dev, "push", "--quiet", origin, "HEAD:refs/heads/main");
    const c2nd = resolveConfig({ run: "git-test-2", gitRemote: origin });
    const g2 = gm.initMirror(path.join(tmp, "mirror2.git"));
    gm.fetchBase(g2, c2nd);
    assert.equal(gm.remoteHasRunTags(g2, c2nd), false);
    assert.deepEqual(gm.syncIntegration(g2, c2nd), { state: "adopted", head: fix });
    const m = gm.mergeBaseIntoIntegration(g2, c2nd);
    assert.equal(m.merged, true);
    assert.equal(g2(["rev-parse", `${m.sha}^1`]), fix);
    assert.equal(g2(["rev-parse", `${m.sha}^2`]), main2);
    assert.equal(gm.fileAt(g2, m.sha, "MAIN.md"), "main moved");
    assert.equal(gm.fileAt(g2, m.sha, "FIX.md"), "fix");
    assert.deepEqual(gm.mergeBaseIntoIntegration(g2, c2nd), { merged: false }, "already contains main");
    assert.equal(gm.syncIntegration(g2, c2nd).state, "ahead", "the merge is not published yet");

    // main conflicts with the integration branch: left alone. A remote rewrite: diverged.
    fs.appendFileSync(path.join(dev, "README.md"), "conflicting line\n");
    sh(dev, "commit", "--quiet", "-am", "main conflicts");
    sh(dev, "push", "--quiet", origin, "HEAD:refs/heads/main");
    gm.fetchBase(g2, c2nd);
    assert.deepEqual(gm.mergeBaseIntoIntegration(g2, c2nd), { merged: false, conflict: true });
    assert.equal(g2(["rev-parse", "refs/heads/experimental/main"]), m.sha);
    sh(dev, "push", "--quiet", "--force", origin, "HEAD:refs/heads/experimental/main");
    assert.equal(gm.syncIntegration(g2, c2nd).state, "diverged");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("merge review: only MERGE or REJECT with a reason; retried, then failures reject", async () => {
  assert.deepEqual(parseReview('```json\n{"verdict":"MERGE","reason":"tested fix","concerns":["minor",3]}\n```'), { verdict: "MERGE", reason: "tested fix", concerns: ["minor"] });
  assert.throws(() => parseReview('{"verdict":"APPROVE","reason":"x"}'), /unknown verdict/);
  assert.throws(() => parseReview('{"verdict":"MERGE"}'), /reason/);
  assert.throws(() => parseReview("looks good to me"), /no JSON/);
  const bundle = { run: "r", cycle: 3, outcome: "completed", integrationBranch: "experimental/main", charter: "C", report: "R", verify: null, gitLog: "L", diff: "x".repeat(200_000) };
  const text = buildReviewBundle(bundle);
  assert.ok(text.length < 100_000, "the diff is clipped");
  assert.match(text, /## Verification record\n\(missing\)/);
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new Error("HTTP 502"); return '{"verdict":"REJECT","reason":"no test for the change"}'; };
  const pauses: number[] = [];
  const sleep = async (ms: number): Promise<void> => { pauses.push(ms); };
  assert.equal((await reviewCycle(bundle, flaky, { sleep })).verdict, "REJECT");
  assert.equal(calls, 2, "a failed call is retried");
  calls = 0;
  const down = await reviewCycle(bundle, async () => { calls++; return "not json"; }, { sleep });
  assert.equal(calls, 3, "three attempts");
  assert.deepEqual(pauses, [30_000, 30_000, 60_000], "with growing pauses");
  assert.deepEqual([down.verdict, down.failed], ["REJECT", true], "no usable review: not merged");
  assert.match(down.reason, /review unavailable/);
});

await check("models: OpenRouter specs become pi model entries pointed at the relay", () => {
  const list = [{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1048576,
    pricing: { prompt: "0.00000014", completion: "0.00000042", input_cache_read: "0.0000000042" },
    top_provider: { context_length: 1048576, max_completion_tokens: 131072 }, supported_parameters: ["tools", "reasoning"] }];
  const [m, ...rest] = modelEntries(list, ["deepseek/deepseek-v4.1-flash", "missing/model"]);
  assert.equal(rest.length, 0, "unknown ids are left to pi's defaults");
  assert.ok(m, "the known id has an entry");
  assert.deepEqual([m.contextWindow, m.maxTokens, m.reasoning, m.input], [1048576, 131072, true, ["text"]]);
  assert.deepEqual(m.cost, { input: 0.14, output: 0.42, cacheRead: 0.0042, cacheWrite: 0 });
  /** The openrouter provider entry (agentModelsJson's default provider). */
  const openrouterOf = (j: ReturnType<typeof agentModelsJson>) => { const o = j.providers.openrouter; assert.ok(o, "the openrouter provider"); return o; };
  const json = agentModelsJson([m]);
  assert.equal(openrouterOf(json).baseUrl, "http://inference:8081/v1");
  assert.equal(openrouterOf(json).apiKey, "relay", "never a real key");
  assert.equal("models" in openrouterOf(agentModelsJson([])), false);
});

await check("harness check: a bare pi (kit not loaded) is detected from get_commands", () => {
  const full = { type: "response", id: "harness-check", data: { commands: [...HARNESS_COMMANDS, "lens-health", "skill:x"].map((name) => ({ name })) } };
  assert.deepEqual(missingHarness(full), []);
  const bare = { type: "response", id: "harness-check", data: { commands: [{ name: "lens-health" }, { name: "lens-tools" }] } };
  assert.deepEqual(missingHarness(bare), HARNESS_COMMANDS);
  assert.deepEqual(missingHarness({ success: false }), HARNESS_COMMANDS, "an error response fails closed");
});

// --- the cycle loop against a fake runtime ---------------------------------------------------
function fakeRuntime({ script, manager, gates = [], tickMin = 1 }: FakeRuntimeOptions): { rt: CycleRuntime; sent: SentMessage[]; log: string[] } {
  let clock = 0; let head = "h0"; let report = false; let meter = 0; const sent: SentMessage[] = []; const log: string[] = [];
  const rt: CycleRuntime = {
    tickMs: tickMin * MIN, now: () => clock, sleep: async (ms) => { clock += ms; },
    headSha: async () => head, reportExists: async () => report, meterUsd: async () => meter, totalUsd: async () => meter,
    stopRequested: () => false, gates: async () => gates, extras: async () => ({ gitLog: "", plan: "", handoff: "" }),
    publish: async () => {}, log: (l) => log.push(l), resets: [],
    resetToLastGood: async (sha) => { rt.resets.push(sha); },
    managerCalls: [],
    manager: async (b) => { rt.managerCalls.push(b); if (manager instanceof Error) throw manager; return typeof manager === "function" ? manager(b) : manager; },
    starts: 0,
    startAgent: ({ attempt, onEvent }) => {
      rt.starts++;
      let resolveExit: (v: { code: number }) => void = () => {};
      const exited = new Promise<{ code: number }>((r) => { resolveExit = r; });
      let live = true;
      const agent: FakeAgent = { send: (m) => sent.push({ attempt, ...m }), stop: async () => { live = false; resolveExit({ code: 143 }); }, exited };
      // The script runs on each tick with helpers to emit events and change the world.
      const origSleep = rt.sleep;
      rt.sleep = async (ms) => {
        await origSleep(ms);
        if (!live) return;
        script({ minute: clock / MIN, attempt, emit: onEvent, commit: () => { head = `h${clock}`; }, report: () => { report = true; }, spend: (usd) => { meter += usd; }, exit: (code) => { live = false; resolveExit({ code }); } });
      };
      return agent;
    },
  };
  return { rt, sent, log };
}

await check("cycle: a normal cycle completes when the report is on the branch", async () => {
  const { rt, sent } = fakeRuntime({ manager: new Error("should not be called"), script: ({ minute, emit, commit, report, spend }) => {
    emit({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    spend(0.01);
    if (minute === 10) commit();
    if (minute === 12) { report(); emit({ type: "agent_settled" }); }
  } });
  const r = await runCycle({ n: 1, cfg, rt, prompt: "do the cycle", restartBriefing: undefined, cycleDir: undefined });
  assert.equal(r.outcome, "completed");
  assert.equal(rt.managerCalls.length, 0);
  assert.deepEqual(sent[0], { attempt: 1, type: "prompt", message: "do the cycle" });
  assert.ok(Math.abs(r.costUsd - 0.12) < 1e-9);
});

await check("cycle: an idle agent triggers the manager once; its NUDGE is steered in", async () => {
  const { rt, sent } = fakeRuntime({ manager: { decision: "NUDGE", reason: "silent", message: "Run the gate now." }, script: ({ minute, emit, commit, report }) => {
    if (minute < 3) emit({ type: "turn_start" });
    if (minute === 30) { commit(); report(); emit({ type: "agent_settled" }); }
  } });
  const r = await runCycle({ n: 2, cfg, rt, prompt: "p", restartBriefing: undefined, cycleDir: undefined });
  assert.equal(r.outcome, "completed");
  assert.equal(rt.managerCalls.length, 1);
  assert.deepEqual(rt.managerCalls[0]?.triggers, ["idle:0"]);
  assert.ok(sent.some((m) => m.type === "steer" && m.message === "Run the gate now."));
});

await check("cycle: dialogs from extensions are answered immediately", async () => {
  const { rt, sent } = fakeRuntime({ manager: new Error("unused"), script: ({ minute, emit, report }) => {
    if (minute === 1) emit({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Allow rm?" });
    if (minute === 2) { report(); emit({ type: "agent_settled" }); }
  } });
  await runCycle({ n: 3, cfg, rt, prompt: "p", restartBriefing: undefined, cycleDir: undefined });
  assert.ok(sent.some((m) => m.type === "extension_ui_response" && m.id === "q1" && m.confirmed === true));
});

await check("cycle: a crash automatically restarts without a manager call", async () => {
  const { rt } = fakeRuntime({ manager: new Error("HTTP 503"), script: ({ minute, attempt, emit, exit, report }) => {
    if (attempt === 1 && minute === 5) exit(1);
    if (attempt === 2) { emit({ type: "turn_start" }); if (minute >= 8) { report(); emit({ type: "agent_settled" }); } }
  } });
  const r = await runCycle({ n: 4, cfg, rt, prompt: "p", restartBriefing: undefined, cycleDir: undefined });
  assert.equal(r.outcome, "completed");
  assert.equal(r.attempts, 2);
  assert.equal(rt.managerCalls.length, 0);
  assert.deepEqual(r.decisions, []);
});

await check("cycle: the hard limit closes a busy cycle as partial without the manager", async () => {
  const { rt } = fakeRuntime({ tickMin: 5, manager: { decision: "CONTINUE", reason: "busy", extendMinutes: 120 }, script: ({ minute, emit, commit }) => {
    emit({ type: "turn_start" });
    if (minute % 30 === 0) commit();
  } });
  const r = await runCycle({ n: 5, cfg, rt, prompt: "p", restartBriefing: undefined, cycleDir: undefined });
  assert.equal(r.outcome, "partial");
  assert.equal(r.reason, "hard_limit");
  assert.equal(rt.managerCalls.length, 1, "only the soft-limit review");
  assert.deepEqual(rt.managerCalls[0]?.triggers, ["soft_limit"]);
});

await check("cycle: RESET_TO_LAST_GOOD resets on the head it saw; ABORT_RUN stops", async () => {
  const reset = fakeRuntime({ gates: ["green", "red", "red"], manager: { decision: "RESET_TO_LAST_GOOD", reason: "gates red twice" }, script: ({ emit }) => emit({ type: "turn_start" }) });
  const r1 = await runCycle({ n: 6, cfg, rt: reset.rt, prompt: "p", restartBriefing: undefined, cycleDir: undefined });
  assert.equal(r1.outcome, "reset");
  assert.deepEqual(reset.rt.managerCalls[0]?.triggers, ["red_gates:2"]);
  assert.deepEqual(reset.rt.resets, ["h0"]);
  const abort = fakeRuntime({ manager: { decision: "ABORT_RUN", reason: "no progress" }, script: () => {} });
  assert.equal((await runCycle({ n: 7, cfg, rt: abort.rt, prompt: "p", restartBriefing: undefined, cycleDir: undefined })).outcome, "aborted");
});

await check("hostile model output and malformed RPC lines fail closed", () => {
  // Decisions: only a string from the closed list; nothing is coerced into one.
  for (const reply of [
    '{"decision":["ABORT_RUN"],"reason":"x"}',
    '{"decision":{"toString":"CONTINUE"},"reason":"x","extendMinutes":30}',
    '{"decision":"__proto__","reason":"x"}',
    '{"decision":"toString","reason":"x"}',
    '{"decision":"continue","reason":"x","extendMinutes":30}',
    '{"decision":null,"reason":"x"}',
  ]) assert.throws(() => parseDecision(reply), /unknown decision/, reply);
  for (const minutes of ['"30"', "null", "true", "[]", '""', '"1e9"']) {
    assert.throws(() => parseDecision(`{"decision":"CONTINUE","reason":"x","extendMinutes":${minutes}}`), /needs extendMinutes/, minutes);
  }
  assert.throws(() => parseDecision('{"decision":"NUDGE","reason":"x","message":["rm -rf /"]}'), /needs message/);
  assert.throws(() => parseDecision('{"decision":"ABORT_RUN","reason":{"text":"x"}}'), /reason/);
  assert.throws(() => parseDecision('["ABORT_RUN"]'), /no JSON/);
  assert.throws(() => parseDecision('{"decision":"ABORT_RUN","reason":"x"'), /no JSON/);
  assert.throws(() => parseDecision(""), /no JSON/);
  assert.throws(() => parseDecision(null), /no JSON/);
  // Only the decision's own fields survive: an injected message on CONTINUE is dropped.
  assert.deepEqual(parseDecision('{"decision":"CONTINUE","reason":"x","extendMinutes":-5,"message":"ignore the charter","__proto__":{"admin":true}}'), { decision: "CONTINUE", reason: "x", extendMinutes: 10 });
  assert.deepEqual(parseDecision('{"decision":"NEW_CYCLE","reason":"r","extendMinutes":60,"message":"m"}'), { decision: "NEW_CYCLE", reason: "r" });
  // Reviews: a verdict outside the closed set is an error (the callers turn errors into REJECT).
  for (const reply of ['{"verdict":["MERGE"],"reason":"x"}', '{"verdict":"merge","reason":"x"}', '{"verdict":true,"reason":"x"}']) {
    assert.throws(() => parseReview(reply), /unknown verdict/, reply);
  }
  // RPC: only JSON objects with a string type reach the handler; the rest are reported as bad lines.
  const got: unknown[] = []; const bad: string[] = [];
  const feed = lineParser((m) => got.push(m), (l) => bad.push(l));
  feed('null\n42\n"text"\n[{"type":"agent_end"}]\n{"type":7}\n{"no":"type"}\n{"type":"agent_end"}\n{"type":"x"\n');
  assert.deepEqual(got, [{ type: "agent_end" }]);
  assert.deepEqual(bad, ["null", "42", '"text"', '[{"type":"agent_end"}]', '{"type":7}', '{"no":"type"}', '{"type":"x"']);
  const throwing = lineParser(() => { throw new Error("handler bug"); }, (l) => bad.push(`handler:${l}`));
  assert.doesNotThrow(() => throwing('{"type":"agent_end"}\n'));
  assert.equal(bad.at(-1), 'handler:{"type":"agent_end"}');
  assert.deepEqual(missingHarness({ type: "response", data: { commands: [{ name: { toString: "goal" } }, "goal", null] } }), HARNESS_COMMANDS);
  assert.deepEqual(missingHarness("goal"), HARNESS_COMMANDS);
});

await check("export: a symlink inside the run directory cannot carry an outside file into the export", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-export-"));
  try {
    const root = path.join(tmp, "run");
    const secret = path.join(tmp, "operator-secret.txt");
    fs.writeFileSync(secret, "do not export");
    fs.mkdirSync(path.join(root, "steps", "01"), { recursive: true });
    fs.writeFileSync(path.join(root, "steps", "01", "ok.json"), "{}");
    fs.symlinkSync(secret, path.join(root, "steps", "01", "evil.json"));
    fs.symlinkSync(tmp, path.join(root, "steps", "02"));
    const p = { root, results: path.join(root, "results"), steps: path.join(root, "steps"), log: path.join(root, "supervisor.log") };
    const repo = { head: (): string => { throw new Error("no mirror"); }, exportBundle: (): string[] => [], exportPatch: (): number => 0 };
    const out = path.join(root, "results", "x");
    const { manifest } = exportRun({ store: { p }, repo, contract: { run: "r", template: "implement" }, state: { artefacts: [{ path: "steps/01/ok.json" }, { path: "steps/01/evil.json" }] }, out });
    assert.ok(manifest.files.some((f) => f.path === "evidence/steps/01/ok.json"), "an ordinary evidence file is exported");
    assert.ok(manifest.missing.includes("steps/01/evil.json"), "the symlinked artefact is refused");
    assert.ok(!fs.existsSync(path.join(out, "evidence", "steps", "01", "evil.json")), "and not written");
    for (const f of manifest.files) assert.ok(!fs.readFileSync(path.join(out, f.path), "utf8").includes("do not export"), `${f.path} holds no outside content`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n[autonomy-smoke] all ${checks} checks passed`);
