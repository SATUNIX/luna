#!/usr/bin/env node
/**
 * Workflow policy. Rules every GitHub workflow keeps:
 *   - gating steps fail closed: no `continue-on-error: true` (one reviewed exception: the
 *     pi-compat matrix's advisory flag, while every lane is non-advisory) and none of the shell
 *     fail-open idioms in tests/ci-fail-open.ts (`|| true`, `|| :`, `|| exit 0`, `|| echo`,
 *     `set +e`), which the GitLab pipeline test shares;
 *   - a top-level `permissions:` block, a `timeout-minutes` on every job that runs steps, and
 *     `persist-credentials: false` on every checkout;
 *   - no trigger that runs untrusted code with the base repository's rights (`pull_request_target`,
 *     `workflow_run`, `issue_comment`);
 *   - every deployment `environment:` is listed in `.github/expected-settings.json`, so the drift
 *     check verifies it exists and is protected, and every listed one is used;
 *   - `ci-complete` (the single required check for ci.yml) needs every other ci.yml job and fails
 *     unless each succeeded;
 *   - every required check in the expected settings names a job that exists;
 *   - each line-pinned zizmor ignore still points at a `uses: ./` call.
 * Each rule is also run against a mutated copy, so the checker is shown to fail.
 *
 * The repository has no YAML dependency: this reads the subset the workflows use (two-space job
 * keys under `jobs:`, four-space job fields). A workflow that stops fitting fails loudly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, number, object, parseJsonAs, record, string, unknownValue } from "../packages/core/lib/guard.ts";
import { FAIL_OPEN_SAMPLES, failOpen } from "./ci-fail-open.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const Settings = object({
  rulesets: array(object({ name: string(), rules: record(record(unknownValue())) })),
  environments: record(unknownValue()),
});
const settings = parseJsonAs(Settings, fs.readFileSync(path.join(ROOT, ".github/expected-settings.json"), "utf8"), "expected-settings");
const RequiredCheck = object({ context: string(), integration_id: number() });

/** Job id -> job text, for the two-space-indented job keys under `jobs:`. */
export function jobsOf(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, "workflow has a top-level `jobs:` block");
  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const name = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)?.[1];
    if (name !== undefined) { current = name; jobs.set(current, []); } else if (current) jobs.get(current)?.push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join("\n")]));
}
const code = (text: string): string[] => text.split(/\r?\n/).filter((l) => !l.trim().startsWith("#"));
function needsOf(body: string): string[] {
  const inline = body.match(/^ {4}needs:\s*\[([^\]]*)\]/m)?.[1];
  if (inline !== undefined) return inline.split(",").map((s) => s.trim()).filter(Boolean);
  const single = body.match(/^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1];
  return single === undefined ? [] : [single];
}

/** Problems in one workflow file's text; [] when it keeps every rule. */
export function fileProblems(file: string, text: string): string[] {
  const out: string[] = [];
  if (!/^permissions:/m.test(text)) out.push(`${file}: no top-level permissions block`);
  for (const trigger of ["pull_request_target", "workflow_run", "issue_comment"]) if (new RegExp(`^ {2}${trigger}:`, "m").test(text)) out.push(`${file}: ${trigger} runs untrusted code with the base repository's rights`);
  for (const [job, body] of jobsOf(text)) {
    for (const line of code(body)) {
      const coe = line.match(/^\s*continue-on-error:\s*(.+?)\s*$/)?.[1];
      if (coe !== undefined && !(file === "ci.yml" && job === "pi-compat" && coe === "${{ matrix.advisory }}")) out.push(`${file} ${job}: continue-on-error (${coe}) lets a failing gate pass`);
      for (const message of failOpen(line)) out.push(`${file} ${job}: ${message}`);
    }
    const isCall = /^ {4}uses:/m.test(body);
    if (!isCall && !/^ {4}timeout-minutes:\s*\d+/m.test(body)) out.push(`${file} ${job}: no timeout-minutes`);
    const checkouts = [...body.matchAll(/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n((?: {8,}.*\n?)*)/g)];
    for (const c of checkouts) if (!/persist-credentials: false/.test(c[1] ?? "")) out.push(`${file} ${job}: a checkout persists credentials`);
    for (const env of body.matchAll(/^ {4}environment:[ \t]*(?:\n {6}name:[ \t]*)?([A-Za-z0-9_-]+)/gm)) {
      if (!Object.hasOwn(settings.environments, env[1] ?? "")) out.push(`${file} ${job}: environment ${env[1] ?? ""} is not in .github/expected-settings.json`);
    }
  }
  if (file === "ci.yml") {
    const jobs = jobsOf(text);
    const complete = jobs.get("ci-complete");
    if (complete === undefined) out.push("ci.yml: no ci-complete job");
    else {
      const needs = new Set(needsOf(complete));
      for (const job of jobs.keys()) if (job !== "ci-complete" && !needs.has(job)) out.push(`ci.yml ci-complete: does not need ${job}`);
      if (!/^ {4}if:\s*always\(\)\s*$/m.test(complete)) out.push("ci.yml ci-complete: must run with if: always()");
      if (!/join\(needs\.\*\.result/.test(complete) || !/!= "success"/.test(complete)) out.push("ci.yml ci-complete: must fail unless every needed job succeeded");
    }
    if (/advisory: true/.test(jobs.get("pi-compat") ?? "")) out.push("ci.yml pi-compat: an advisory lane is not gated; record it before enabling one");
  }
  return out;
}

const files = fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml")).sort();
const texts = new Map(files.map((f) => [f, fs.readFileSync(path.join(WORKFLOWS, f), "utf8")]));
let passed = 0;
const ok = (name: string): void => { passed++; console.log(`  ok  ${name}`); };

for (const [file, text] of texts) assert.deepEqual(fileProblems(file, text), [], file);
ok(`all ${files.length} workflows keep the policy`);

// Environments: every listed one is used by a workflow.
const used = new Set([...texts.values()].flatMap((t) => [...t.matchAll(/^ {4}environment:[ \t]*(?:\n {6}name:[ \t]*)?([A-Za-z0-9_-]+)/gm)].map((m) => m[1] ?? "")));
for (const name of Object.keys(settings.environments)) assert.ok(used.has(name), `environment ${name} is listed in expected-settings but no workflow uses it`);
ok("every deployment environment is listed in expected-settings, and every listed one is used");

// Required checks name real jobs: a job id (or `caller / callee` for a reusable workflow call).
const main = settings.rulesets.find((r) => r.name === "main");
assert.ok(main, "expected-settings has the main ruleset");
const checks = array(RequiredCheck).parse(main.rules.required_status_checks?.required_status_checks ?? [], "required_status_checks");
const jobIds = new Set([...texts.entries()].filter(([f]) => f === "ci.yml" || f === "security.yml").flatMap(([, t]) => [...jobsOf(t).keys()]));
for (const check of checks) {
  if (check.integration_id !== 15368) continue; // other apps (CodeQL's own check) are not workflow jobs
  const caller = check.context.split(" / ")[0] ?? "";
  assert.ok(jobIds.has(caller), `required check "${check.context}" names no job in ci.yml or security.yml`);
}
assert.ok(checks.some((c) => c.context === "ci-complete"), "ci-complete is a required check");
ok(`each of ${checks.length} required checks names an existing job, ci-complete among them`);

// zizmor's line-pinned ignores still point at what they were written for.
const zizmor = fs.readFileSync(path.join(ROOT, ".github/zizmor.yml"), "utf8");
for (const [, file = "", line = ""] of zizmor.matchAll(/^\s*- ([A-Za-z0-9_.-]+\.yml):(\d+)\s*$/gm)) {
  const target = (texts.get(file) ?? "").split(/\r?\n/)[Number(line) - 1] ?? "";
  assert.match(target, /^\s*uses: \.\//, `.github/zizmor.yml ignores ${file}:${line}, which is no longer a uses: ./ line ("${target.trim()}")`);
}
ok("each line-pinned zizmor ignore points at a uses: ./ call");

// The checker fails on each kind of violation.
const ci = texts.get("ci.yml") ?? "";
const security = texts.get("security.yml") ?? "";
const mutations: Array<[string, string, string, RegExp]> = [
  ["continue-on-error on a gate", "security.yml", security.replace(/(\n {2}semgrep:\n)/, "$1    continue-on-error: true\n"), /semgrep: continue-on-error/],
  ["|| true on a scan", "security.yml", security.replace("./gitleaks git --redact --verbose --exit-code 1 .", "./gitleaks git --redact --verbose --exit-code 1 . || true"), /gitleaks: "\|\| true"/],
  ...FAIL_OPEN_SAMPLES.map((sample): [string, string, string, RegExp] => [`a fail-open "${sample}"`, "security.yml", security.replace("./gitleaks git --redact --verbose --exit-code 1 .", `./gitleaks git --redact --verbose --exit-code 1 .\n      - run: ${sample}`), /gitleaks: "(?:\|\| true|\|\| exit 0|\|\| echo|set \+e)"/]),
  ["an unlisted environment", "ci.yml", ci.replace(/(\n {2}verify:\n)/, "$1    environment: staging\n"), /environment staging is not in/],
  ["ci-complete missing a job", "ci.yml", ci.replace("needs: [verify, docs-build, profile-regression, pi-compat, android]", "needs: [verify, docs-build, profile-regression, pi-compat]"), /ci-complete: does not need android/],
  ["a checkout that keeps credentials", "ci.yml", ci.replace("persist-credentials: false", "persist-credentials: true"), /persists credentials/],
  ["pull_request_target", "ci.yml", ci.replace("  pull_request:\n", "  pull_request_target:\n"), /pull_request_target/],
  ["a job without a timeout", "ci.yml", ci.replace(/(\n {2}docs-build:\n {4}runs-on: ubuntu-latest\n) {4}timeout-minutes: \d+\n/, "$1"), /docs-build: no timeout-minutes/],
  ["an advisory lane", "ci.yml", ci.replace("advisory: false", "advisory: true"), /advisory lane is not gated/],
];
for (const [label, file, text, expected] of mutations) {
  assert.notEqual(text, texts.get(file), `mutation "${label}" changed the text`);
  const found = fileProblems(file, text);
  assert.ok(found.some((p) => expected.test(p)), `mutation "${label}" is caught (got: ${found.join("; ")})`);
}
ok(`each of ${mutations.length} mutations is caught`);

console.log(`workflow-policy smoke: ${passed} checks passed`);
