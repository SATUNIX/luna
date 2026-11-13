#!/usr/bin/env node
/**
 * The lean worker pieces of packages/autonomy that need no engine run:
 *   - the host classifies risk (R0-R3) from changed paths; unknown or unclassifiable never relaxes;
 *   - R0 sampling is deterministic and off by default;
 *   - one review call carries the R2 specialist question and fails closed without its answer;
 *   - one ordinary attempt plus one repair per board item (lib/attempts.ts);
 *   - the host's manager and review calls carry an output cap and a low thinking request;
 *   - the worker session and the children it starts begin at low thinking.
 * The end-to-end behaviour (a cycle merged or refused by tier) is in tests/autonomy-selfimprove-smoke.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, makeChecker } from "./autonomy-helpers.ts";
import { isRecord } from "../packages/core/lib/guard.ts";
import { classifyRisk, r0Reviewed, specialistQuestion } from "../packages/autonomy/lib/risk.ts";
import { ATTEMPTS_PER_ITEM, recordAttempts, withoutWithheld, type ItemAttempts } from "../packages/autonomy/lib/attempts.ts";
import { MANAGER_MAX_OUTPUT_TOKENS, REVIEW_MAX_OUTPUT_TOKENS, openRouterComplete } from "../packages/autonomy/lib/manager.ts";
import { parseReview, reviewCycle } from "../packages/autonomy/lib/review.ts";
import { WORKER_THINKING, workerEnv } from "../packages/autonomy/lib/worker-env.ts";

const { check, done } = makeChecker("autonomy-lean-smoke");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tier = (...files: string[]): string => classifyRisk({ files, isRecord: (f) => f.startsWith("autonomy/cycles/run/") }).tier;

await check("risk: prose and static files are R0, records included; the charter and agent instructions are not prose", () => {
  assert.equal(tier("docs/guide.md", "docs/img/logo.svg", "README.md", "CHANGELOG.md"), "R0");
  assert.equal(tier("autonomy/cycles/run/01/report.md"), "R0", "this run's own records are prose");
  assert.notEqual(tier("AGENTS.md"), "R0", "instructions an agent obeys are behaviour");
  assert.notEqual(tier("packages/kit/skills/x/SKILL.md"), "R0");
  assert.notEqual(tier("packages/autonomy/prompts/cycle.md"), "R0");
  assert.equal(tier("autonomy/CHARTER.md"), "R3");
});

await check("risk: unknown and unclassifiable changes escalate, they never become R0", () => {
  assert.equal(tier("docs/guide.md", "src/new-thing.xyz"), "R1", "one unknown path takes the cycle out of R0");
  assert.equal(tier("src/app.ts"), "R1");
  assert.equal(tier(), "R1", "no paths to classify is not prose");
  for (const bad of ["../outside.md", "/etc/passwd.md", "docs/a\nb.md", ""]) assert.equal(tier("docs/ok.md", bad), "R3", JSON.stringify(bad));
  assert.equal(tier("Autonomy/Charter.MD"), "R3", "matching is case-insensitive, so a case trick cannot dodge a rule");
});

await check("risk: R2 for recovery, concurrency, persistence, shared-interface and authorisation paths, with the topics named", () => {
  const r = classifyRisk({ files: ["packages/autonomy/lib/recovery.ts", "packages/core/lib/settings.ts", "src/session-store.js", "tests/recovery-smoke.ts", "docs/a.md"] });
  assert.equal(r.tier, "R2");
  assert.deepEqual([...r.topics].sort(), ["interface", "persistence", "recovery"]);
  assert.ok(!r.r2.some((x) => x.startsWith("tests/")), "a test of the machinery is ordinary code, not the machinery");
  const question = specialistQuestion(r.topics);
  for (const part of [/crash or restart/, /stored state/, /shared interface/]) assert.match(question, part);
  assert.doesNotMatch(question, /interleave/, "only the topics the paths touch are asked about");
  assert.equal(classifyRisk({ files: ["src/tool-firewall.ts"] }).topics.join(), "authorisation");
});

await check("risk: R3 for permissions, budgets, credentials, gate policy and release; the highest tier wins", () => {
  for (const f of [".github/workflows/ci.yml", "packages/autonomy/relay.ts", "packages/autonomy/lib/boundary.ts", "packages/core/check-all.ts", "packages/core/distribution.json", "docs/releasing.md", "src/credentials.ts", ".npmrc", "tsconfig.json"]) assert.equal(tier(f), "R3", f);
  assert.equal(tier("docs/a.md", "src/recovery.ts", ".github/x.yml"), "R3");
  // The host's own merge gate, risk machinery, run wiring and the charter seed are R3: an unattended cycle cannot lower the bar for later ones.
  for (const f of ["risk", "review", "acceptance", "attempts", "triggers", "manager", "runtime", "rpc", "engine", "board", "hostrepo", "templates/self-improve", "contract", "worker-env"]) assert.equal(tier(`packages/autonomy/lib/${f}.ts`), "R3", f);
  for (const f of ["packages/autonomy/cli.ts", "packages/autonomy/supervisor.ts", "packages/autonomy/seed/CHARTER.md", "packages/autonomy/prompts/cycle.md", "packages/autonomy/image/entrypoint.sh"]) assert.equal(tier(f), "R3", f);
  assert.equal(tier("docs/prompts/x.md"), "R1", "a docs page named prompts is ordinary, not the autonomy prompts");
  assert.equal(classifyRisk({ files: ["lib/custom/policy.txt"], controlPaths: [/^lib\/custom\//] }).tier, "R3", "an operator control path is R3");
});

await check("R0 sampling: every R0 cycle is reviewed by default; the switch is deterministic per head", () => {
  assert.equal(r0Reviewed(1, "a".repeat(40)), true);
  assert.equal(r0Reviewed(0, "a".repeat(40)), false);
  const heads = Array.from({ length: 400 }, (_, i) => i.toString(16).padStart(40, "0"));
  const sampled = heads.filter((h) => r0Reviewed(0.25, h)).length;
  assert.ok(sampled > 60 && sampled < 140, `about a quarter are sampled (${sampled} of 400)`);
  assert.equal(r0Reviewed(0.25, heads[7] ?? ""), r0Reviewed(0.25, heads[7] ?? ""), "the same head always gets the same answer");
});

await check("review: the specialist answer is required when asked; CONCERN rejects; one call is one review", async () => {
  assert.equal(parseReview('{"verdict":"MERGE","reason":"ok","concerns":[]}').specialist, undefined, "not asked, not required");
  assert.throws(() => parseReview('{"verdict":"MERGE","reason":"ok"}', { specialist: true }), /specialist question was not answered/);
  assert.equal(parseReview('{"verdict":"MERGE","specialist":"OK","reason":"ok"}', { specialist: true }).verdict, "MERGE");
  const concern = parseReview('{"verdict":"MERGE","specialist":"CONCERN","reason":"restart loses the lease"}', { specialist: true });
  assert.deepEqual([concern.verdict, concern.specialist], ["REJECT", "CONCERN"]);
  let calls = 0;
  const review = await reviewCycle({ run: "r", cycle: 1, outcome: "completed", integrationBranch: "integ", specialist: specialistQuestion(["recovery"]), risk: { tier: "R2", reasons: ["x.ts (recovery)"] }, diff: "d" }, async (system, user) => {
    calls++;
    assert.match(system, /Specialist question/);
    assert.match(user, /Risk tier \(host-classified from the changed paths\): R2/);
    return '{"verdict":"MERGE","specialist":"OK","reason":"fine","concerns":[]}';
  });
  assert.equal(calls, 1);
  assert.equal(review.verdict, "MERGE");
});

await check("attempts: only claimed items are charged; with no claim only a merge-level REJECT charges the assigned ones (pinned end to end in tests/autonomy-selfimprove-smoke.ts)", () => {
  const src = fs.readFileSync(path.join(ROOT, "packages/autonomy/lib/templates/self-improve.ts"), "utf8");
  assert.match(src, /claimed\.length \? claimed : current\.board && entry\.review === "REJECT"/);
  assert.match(src, /withheldItems/);
});

await check("attempts: the ordinary attempt plus one repair, then the item is withheld with its reason; a merge clears it", () => {
  const board = { items: [{ id: "A-1", title: "a", priority: "P1" as const }, { id: "A-2", title: "b", priority: "P2" as const }] };
  assert.equal(ATTEMPTS_PER_ITEM, 2);
  const state: ItemAttempts = {};
  assert.deepEqual(recordAttempts(state, ["A-1"], { merged: false, reason: "review REJECT: no test", at: "t1" }), []);
  assert.equal(withoutWithheld(board, state).items.length, 2, "one failure: still offered, as the repair");
  assert.deepEqual(recordAttempts(state, ["A-1", "A-2"], { merged: false, reason: "gate red", at: "t2" }), ["A-1"]);
  assert.deepEqual(withoutWithheld(board, state).items.map((i) => i.id), ["A-2"]);
  assert.match(state["A-1"]?.lastReason ?? "", /gate red/);
  assert.equal(state["A-1"]?.withheldAt, "t2");
  assert.deepEqual(recordAttempts(state, ["A-1"], { merged: false, reason: "again", at: "t3" }), [], "a withheld item is not counted again");
  recordAttempts(state, ["A-2"], { merged: true, reason: "merged", at: "t4" });
  assert.equal(state["A-2"], undefined, "a merge clears the count");
  assert.equal(withoutWithheld(board, undefined), board);
});

await check("host calls: manager and review replies are capped, and OpenRouter is asked for low reasoning", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    bodies.push(isRecord(parsed) ? parsed : {});
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  };
  await openRouterComplete({ apiKey: "k", model: "m", upstream: "https://example.invalid/v1", fetchImpl })("s", "u");
  await openRouterComplete({ apiKey: "k", model: "m", upstream: "https://example.invalid/v1", fetchImpl, maxTokens: REVIEW_MAX_OUTPUT_TOKENS })("s", "u");
  await openRouterComplete({ apiKey: "k", model: "m", upstream: "https://example.invalid/v1", fetchImpl, usageInclude: false })("s", "u");
  assert.equal(bodies[0]?.["max_tokens"], MANAGER_MAX_OUTPUT_TOKENS);
  assert.equal(bodies[1]?.["max_tokens"], REVIEW_MAX_OUTPUT_TOKENS);
  assert.deepEqual(bodies[0]?.["reasoning"], { effort: "low" });
  assert.equal(bodies[2]?.["reasoning"], undefined, "a plain OpenAI-compatible provider gets no OpenRouter-only field");
  assert.ok(MANAGER_MAX_OUTPUT_TOKENS < REVIEW_MAX_OUTPUT_TOKENS && REVIEW_MAX_OUTPUT_TOKENS <= 8192);
});

await check("thinking: the worker session and its children start low", () => {
  assert.equal(WORKER_THINKING, "low");
  const env = workerEnv({ run: "r", model: { worker: "m", provider: "openrouter" }, effort: { tier: "standard", cap: "standard" }, runtime: { gitIdentity: { name: "n", email: "e" }, user: "1000:1000" }, permissions: { unattended: {}, network: { services: [], egress: [] } } }, { branch: "b" });
  assert.equal(env.PI_THINKING, "low");
  assert.match(fs.readFileSync(path.join(ROOT, "packages/autonomy/image/entrypoint.sh"), "utf8"), /--thinking "\$\{PI_THINKING:-low\}"/, "the entrypoint passes it to pi");
  assert.match(fs.readFileSync(path.join(ROOT, "packages/autonomy/image/entrypoint.sh"), "utf8"), /s\.defaultThinkingLevel = process\.env\.PI_THINKING \|\| "low"/, "children read pi's settings, so they start low as well");
});

done();
