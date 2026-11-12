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
 *   - `ci-complete` (the single required check for ci.yml) needs every other ci.yml job, except the
 *     measure-only jobs named in MEASURE_ONLY_JOBS (which it must not need, and which must really run
 *     what the list says, so a job cannot borrow the exemption by name), and fails unless each needed
 *     job succeeded; the measure-only `coverage` job keeps a timeout of at least
 *     COVERAGE_MIN_TIMEOUT_MINUTES, and `coverage` and `coverage-merge` are both measure-only; 
 *   - every required check in the expected settings names a job that exists;
 *   - every ci.yml job that directly runs `check:all` does so as a shard matrix whose shard count
 *     matches the `--shard=${{ matrix.shard }}/<n>` it passes (so the shards cover every check),
 *     with `--jobs` and a `--check-timeout`; the measure-only `coverage` job also runs a four-way
 *     shard matrix of `npm run coverage`, passing `--coverage-out`, and `coverage-merge` downloads
 *     the raw and eval-cache artifacts before running a report-only `coverage --report`; every
 *     check:all run in ci.yml (including `coverage`) passes `--check-timeout`, except a report-only
 *     coverage command containing `--report` (it runs no checks), so a hung check fails named
 *     instead of as a silent job timeout; and ci.yml and security.yml gate pull requests to `main`
 *     and `integration/**`;
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
    const name = line.match(/^ {2}([A-Za-z0-9_-]+):[ \t]*(?:#.*)?$/)?.[1];
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

/**
 * One job's shard matrix and its check:all command agree: shards are 1..n with no gap and the
 * command passes `--shard=${{ matrix.shard }}/n`, so the shards together run every check. Used for
 * every ci.yml job that runs check:all, so `verify` and `pi-compat` cannot drift apart.
 */
export function shardProblems(job: string, body: string): string[] {
  if (body === "") return [`ci.yml: no ${job} job`];
  const out: string[] = [];
  const shards = body.match(/^ {8}shard:\s*\[([^\]]*)\]\s*$/m)?.[1]?.split(",").map((s) => Number(s.trim()));
  if (shards === undefined) return [`ci.yml ${job}: no matrix.shard list`];
  if (shards.length < 2 || shards.some((n, i) => n !== i + 1)) out.push(`ci.yml ${job}: matrix.shard must be 1..n, not [${shards.join(", ")}]`);
  const command = code(body).map((l) => l.match(/^ {6}- run: (npm run -s check:all\b.*)$/)?.[1]).find((c) => c !== undefined);
  if (command === undefined) return [...out, `ci.yml ${job}: does not run npm run -s check:all`];
  const count = command.match(/ --shard=\$\{\{ matrix\.shard \}\}\/(\d+)(?:\s|$)/)?.[1];
  if (count === undefined) out.push(`ci.yml ${job}: check:all is not given --shard=\${{ matrix.shard }}/<n>, so every shard runs the whole suite`);
  else if (Number(count) !== shards.length) out.push(`ci.yml ${job}: --shard=.../${count} does not match the ${shards.length} matrix shards, so some checks run in no shard`);
  if (!/ --jobs=\d+(?:\s|$)/.test(command)) out.push(`ci.yml ${job}: check:all has no --jobs`);
  if (!/ --check-timeout=\d+(?:\s|$)/.test(command)) out.push(`ci.yml ${job}: check:all has no --check-timeout, so a hung check is never named`);
  return out;
}

/** The verify job's shard matrix, kept as a named entry point. */
export function verifyShardProblems(body: string): string[] {
  return shardProblems("verify", body);
}

/**
 * The measure-only coverage matrix and its merge job keep the contract that makes the shards
 * mergeable: four numbered shards whose command matches the count, `--coverage-out` for the raw V8
 * data, and a merge job that needs them, downloads both raw and eval-cache artifacts, and reports.
 */
export function coverageProblems(jobs: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const body = jobs.get("coverage");
  if (body === undefined) out.push("ci.yml: no coverage job");
  else {
    const shards = body.match(/^ {8}shard:\s*\[([^\]]*)\]\s*$/m)?.[1]?.split(",").map((s) => Number(s.trim()));
    if (shards === undefined) out.push("ci.yml coverage: no matrix.shard list");
    else if (shards.length !== 4 || shards.some((n, i) => n !== i + 1)) out.push(`ci.yml coverage: matrix.shard must be 1..4, not [${shards.join(", ")}]`);
    if (!/^ {4}strategy:\n {6}fail-fast: false\s*$/m.test(body)) out.push("ci.yml coverage: strategy.fail-fast must be false, or one failing shard cancels the rest and their raw data is lost");
    const command = code(body).map((l) => l.match(/^ {6}- run: (npm run -s coverage\b.*)$/)?.[1]).find((c) => c !== undefined);
    if (command === undefined) out.push("ci.yml coverage: does not run npm run -s coverage");
    else {
      const count = command.match(/ --shard=\$\{\{ matrix\.shard \}\}\/(\d+)(?:\s|$)/)?.[1];
      if (count === undefined) out.push("ci.yml coverage: coverage is not given --shard=${{ matrix.shard }}/<n>, so every shard runs the whole suite");
      else if (Number(count) !== 4) out.push(`ci.yml coverage: --shard=.../${count} does not match the 4 coverage shards, so some checks run in no shard`);
      if (!/ --coverage-out=\S+/.test(command)) out.push("ci.yml coverage: coverage is not given --coverage-out, so its raw V8 data cannot be merged");
    }
    const uploads = [...body.matchAll(/uses: actions\/upload-artifact@[0-9a-f]{40}[^\n]*\n((?: {8,}.*\n?)*)/g)].map((m) => m[1] ?? "");
    const upload = (pattern: RegExp): string | undefined => uploads.find((u) => pattern.test(u));
    const rawUpload = upload(/name:\s*coverage-raw-\$\{\{ matrix\.shard \}\}/);
    if (rawUpload === undefined) out.push("ci.yml coverage: does not upload the coverage-raw-* artifact");
    else {
      if (!/path:\s*coverage-raw\s*$/m.test(rawUpload)) out.push("ci.yml coverage: the raw coverage artifact does not upload the coverage-raw directory");
      if (!/if:\s*always\(\)\s*$/m.test(rawUpload)) out.push("ci.yml coverage: the raw coverage artifact must upload with if: always()");
    }
    const cacheUpload = upload(/name:\s*coverage-cache-\$\{\{ matrix\.shard \}\}/);
    if (cacheUpload === undefined) out.push("ci.yml coverage: does not upload the coverage-cache-* artifact");
    else {
      if (!/path:\s*node_modules\/\.cache\/pi-kit-eval\s*$/m.test(cacheUpload)) out.push("ci.yml coverage: the cache artifact does not upload node_modules/.cache/pi-kit-eval");
      if (!/if:\s*always\(\)\s*$/m.test(cacheUpload)) out.push("ci.yml coverage: the cache artifact must upload with if: always()");
      if (!/include-hidden-files:\s*true\s*$/m.test(cacheUpload)) out.push("ci.yml coverage: the cache artifact must set include-hidden-files: true, or the .cache path uploads nothing");
    }
  }
  const merge = jobs.get("coverage-merge");
  if (merge === undefined) out.push("ci.yml: no coverage-merge job");
  else {
    if (!needsOf(merge).includes("coverage")) out.push("ci.yml coverage-merge: does not need coverage");
    if (!/^ {4}if:\s*always\(\)\s*$/m.test(merge)) out.push("ci.yml coverage-merge: must run with if: always(), or a failed shard skips the merge");
    const downloads = [...merge.matchAll(/uses: actions\/download-artifact@[0-9a-f]{40}[^\n]*\n((?: {8,}.*\n?)*)/g)].map((m) => m[1] ?? "");
    const download = (pattern: RegExp): string | undefined => downloads.find((d) => pattern.test(d));
    const rawDownload = download(/pattern:\s*coverage-raw-\*/);
    if (rawDownload === undefined) out.push("ci.yml coverage-merge: does not download the coverage-raw-* artifacts");
    else {
      if (!/path:\s*coverage-raw\s*$/m.test(rawDownload)) out.push("ci.yml coverage-merge: does not download the raw artifacts into coverage-raw");
      if (!/merge-multiple:\s*true\s*$/m.test(rawDownload)) out.push("ci.yml coverage-merge: the raw artifacts are not merged with merge-multiple: true");
    }
    const cacheDownload = download(/pattern:\s*coverage-cache-\*/);
    if (cacheDownload === undefined) out.push("ci.yml coverage-merge: does not download the coverage-cache-* artifacts");
    else {
      if (!/path:\s*node_modules\/\.cache\/pi-kit-eval\s*$/m.test(cacheDownload)) out.push("ci.yml coverage-merge: does not download the cache artifacts into node_modules/.cache/pi-kit-eval");
      if (!/merge-multiple:\s*true\s*$/m.test(cacheDownload)) out.push("ci.yml coverage-merge: the cache artifacts are not merged with merge-multiple: true");
    }
    if (!code(merge).some((l) => /^ {6}- run: npm run -s coverage -- --report\b/.test(l))) out.push("ci.yml coverage-merge: does not run npm run -s coverage -- --report");
  }
  return out;
}

/** A job body runs check:all, so it must be sharded. */
function runsCheckAll(body: string): boolean {
  return code(body).some((line) => /^ {6}- run: npm run -s check:all\b/.test(line));
}

/**
 * Every step that runs check:all (directly, or through `coverage`, which passes its arguments to
 * check:all), on a `run:` line or inside a multi-line script, carries `--check-timeout`. Without it
 * a hung check runs until the job's timeout-minutes cancels the job, and the log names only the
 * last check that printed a header.
 */
export function checkTimeoutProblems(text: string): string[] {
  const out: string[] = [];
  for (const [job, body] of jobsOf(text)) {
    for (const line of code(body)) {
      const command = line.match(/\b(npm run(?: -s)? (?:check:all|coverage)\b.*)$/)?.[1];
      // A report-only coverage command merges existing raw data; it runs no check, so it needs no
      // check timeout. A coverage run that executes checks still must pass one.
      const reportOnly = command !== undefined && /\bnpm run(?: -s)? coverage\b/.test(command) && / --report(?:=|\s)/.test(command);
      if (command !== undefined && !reportOnly && !/ --check-timeout=\d+(?:\s|$)/.test(command)) out.push(`ci.yml ${job}: "${command}" has no --check-timeout, so a hung check is never named`);
    }
  }
  return out;
}

/** The pull_request trigger gates PRs to main and to integration/** branches. */
export function pullRequestBranchProblems(file: string, text: string): string[] {
  const branches = text.match(/^ {2}pull_request:\s*\n {4}branches:\s*\[([^\]]*)\]\s*$/m)?.[1];
  if (branches === undefined) return [`${file}: no pull_request trigger with a branches list`];
  const names = new Set(branches.split(",").map((b) => b.trim().replace(/^"(.*)"$/, "$1")));
  return ["main", "integration/**"].filter((b) => !names.has(b)).map((b) => `${file}: pull_request does not run on ${b}`);
}

/**
 * Jobs that report a measurement and never gate: `ci-complete` deliberately does not need them. A job
 * joins this list only by an edit here, a reviewed change to what the required check stands for.
 * `coverage` measures the suite and "does not gate on a threshold" (ci.yml), and `coverage-merge`
 * only reports the shards' merged measurement. Both measure and never gate, so a runner-speed
 * timeout must not block a promotion. Each entry maps the job to the command it must run, so the
 * exemption cannot be borrowed by a job that merely has the same name.
 */
export const MEASURE_ONLY_JOBS: Readonly<Record<string, RegExp>> = {
  coverage: /\bnpm run(?: -s)? coverage\b/,
  "coverage-merge": /\bnpm run(?: -s)? coverage\b[^\n]* --report(?:=|\s)/,
};

/** The coverage lane took 18 to 27 minutes against a 30 limit and was cancelled once; it must keep headroom. */
export const COVERAGE_MIN_TIMEOUT_MINUTES = 40;

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
      for (const job of jobs.keys()) if (job !== "ci-complete" && !Object.hasOwn(MEASURE_ONLY_JOBS, job) && !needs.has(job)) out.push(`ci.yml ci-complete: does not need ${job}`);
      for (const [job, runs] of Object.entries(MEASURE_ONLY_JOBS)) {
        const body = jobs.get(job);
        if (body === undefined) out.push(`ci.yml: the measure-only job ${job} no longer exists; remove it from MEASURE_ONLY_JOBS`);
        else if (!runs.test(code(body).join("\n"))) out.push(`ci.yml ${job}: the measure-only job does not run ${runs.source}, so it cannot keep the exemption`);
        if (needs.has(job)) out.push(`ci.yml ci-complete: needs the measure-only job ${job}; it must not gate`);
      }
      const coverageMinutes = Number(jobs.get("coverage")?.match(/^ {4}timeout-minutes:\s*(\d+)/m)?.[1] ?? 0);
      if (Object.hasOwn(MEASURE_ONLY_JOBS, "coverage") && jobs.has("coverage") && coverageMinutes < COVERAGE_MIN_TIMEOUT_MINUTES) out.push(`ci.yml coverage: timeout-minutes ${coverageMinutes} is below ${COVERAGE_MIN_TIMEOUT_MINUTES}; the lane was cancelled at 30 on a slow runner`);
      if (!/^ {4}if:\s*always\(\)\s*$/m.test(complete)) out.push("ci.yml ci-complete: must run with if: always()");
      if (!/join\(needs\.\*\.result/.test(complete) || !/!= "success"/.test(complete)) out.push("ci.yml ci-complete: must fail unless every needed job succeeded");
    }
    if (/advisory: true/.test(jobs.get("pi-compat") ?? "")) out.push("ci.yml pi-compat: an advisory lane is not gated; record it before enabling one");
    if (!jobs.has("verify")) out.push(...verifyShardProblems(""));
    for (const [job, body] of jobs) {
      if (job === "verify" || runsCheckAll(body)) out.push(...shardProblems(job, body));
    }
    out.push(...coverageProblems(jobs));
    out.push(...checkTimeoutProblems(text));
  }
  if (file === "ci.yml" || file === "security.yml") out.push(...pullRequestBranchProblems(file, text));
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
  ["ci-complete gating on the measure-only coverage job again", "ci.yml", ci.replace("needs: [verify, docs-build, profile-regression, pi-compat, android]", "needs: [verify, coverage, docs-build, profile-regression, pi-compat, android]"), /needs the measure-only job coverage/],
  ["the coverage timeout lowered back to 30", "ci.yml", ci.replace(/(\n {2}coverage:\n {4}runs-on: ubuntu-latest\n {4}timeout-minutes: )45/, "$130"), /coverage: timeout-minutes 30 is below 40/],
  ["a coverage matrix that is not four shards", "ci.yml", ci.replace(/(\n {2}coverage:\n[\s\S]*? {8}shard: )\[1, 2, 3, 4\]/, "$1[1, 2, 3]"), /coverage: matrix.shard must be 1\.\.4/],
  ["coverage shards that cancel each other", "ci.yml", ci.replace(/(\n {2}coverage:\n[\s\S]*? {6}fail-fast: )false/, "$1true"), /coverage: strategy.fail-fast must be false/],
  ["a coverage shard count that disagrees with the matrix", "ci.yml", ci.replace("--shard=${{ matrix.shard }}/4 --coverage-out=coverage-raw", "--shard=${{ matrix.shard }}/3 --coverage-out=coverage-raw"), /coverage: --shard=\.\.\.\/3 does not match the 4/],
  ["coverage without --coverage-out", "ci.yml", ci.replace(" --coverage-out=coverage-raw", ""), /coverage: coverage is not given --coverage-out/],
  ["a coverage raw artifact that uploads the wrong directory", "ci.yml", ci.replace("name: coverage-raw-${{ matrix.shard }}\n          path: coverage-raw", "name: coverage-raw-${{ matrix.shard }}\n          path: raw-elsewhere"), /raw coverage artifact does not upload the coverage-raw directory/],
  ["a raw coverage upload that is skipped when a check fails", "ci.yml", ci.replace("if: always()\n        with:\n          name: coverage-raw-${{ matrix.shard }}", "with:\n          name: coverage-raw-${{ matrix.shard }}"), /raw coverage artifact must upload with if: always\(\)/],
  ["a coverage cache artifact that uploads the wrong directory", "ci.yml", ci.replace("name: coverage-cache-${{ matrix.shard }}\n          path: node_modules/.cache/pi-kit-eval", "name: coverage-cache-${{ matrix.shard }}\n          path: cache-elsewhere"), /cache artifact does not upload node_modules\/\.cache\/pi-kit-eval/],
  ["a cache upload that drops hidden files", "ci.yml", ci.replace("          include-hidden-files: true\n", ""), /cache artifact must set include-hidden-files: true/],
  ["a job named coverage that does not run coverage", "ci.yml", ci.replace("npm run -s coverage -- --shard=${{ matrix.shard }}/4 --coverage-out=coverage-raw --check-timeout=600", "echo coverage skipped"), /the measure-only job does not run/],
  ["coverage-merge removed", "ci.yml", ci.replace(/\n {2}coverage-merge:\n[\s\S]*?(?=\n {2}docs-build:)/, ""), /no coverage-merge job/],
  ["coverage-merge that does not need coverage", "ci.yml", ci.replace("    needs: coverage\n    if: always()\n    steps:", "    needs: docs-build\n    if: always()\n    steps:"), /coverage-merge: does not need coverage/],
  ["coverage-merge without if: always()", "ci.yml", ci.replace("    needs: coverage\n    if: always()\n    steps:", "    needs: coverage\n    steps:"), /coverage-merge: must run with if: always\(\)/],
  ["coverage-merge not downloading the raw artifacts", "ci.yml", ci.replace("pattern: coverage-raw-*", "pattern: coverage-other-*"), /coverage-merge: does not download the coverage-raw-\* artifacts/],
  ["coverage-merge not merging the raw artifacts", "ci.yml", ci.replace("pattern: coverage-raw-*\n          path: coverage-raw\n          merge-multiple: true", "pattern: coverage-raw-*\n          path: coverage-raw"), /raw artifacts are not merged with merge-multiple: true/],
  ["coverage-merge not downloading the cache artifacts", "ci.yml", ci.replace("pattern: coverage-cache-*", "pattern: coverage-other-*"), /coverage-merge: does not download the coverage-cache-\* artifacts/],
  ["coverage-merge not running --report", "ci.yml", ci.replace("npm run -s coverage -- --report coverage-raw", "npm run -s coverage -- --check-timeout=600"), /coverage-merge: does not run npm run -s coverage -- --report/],
  ["ci-complete gating on the measure-only coverage-merge job again", "ci.yml", ci.replace("needs: [verify, docs-build, profile-regression, pi-compat, android]", "needs: [verify, coverage-merge, docs-build, profile-regression, pi-compat, android]"), /needs the measure-only job coverage-merge/],
  ["a job header with a trailing comment escapes needs", "ci.yml", ci.replace(/\n {2}docs-build:\n/, "\n  extra-job: # a comment after the key\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo hi\n\n  docs-build:\n"), /does not need extra-job/],
  ["the measure-only coverage job removed", "ci.yml", ci.replace(/\n {2}coverage:\n[\s\S]*?(?=\n {2}docs-build:)/, ""), /the measure-only job coverage no longer exists/],
  ["a checkout that keeps credentials", "ci.yml", ci.replace("persist-credentials: false", "persist-credentials: true"), /persists credentials/],
  ["pull_request_target", "ci.yml", ci.replace("  pull_request:\n", "  pull_request_target:\n"), /pull_request_target/],
  ["a job without a timeout", "ci.yml", ci.replace(/(\n {2}docs-build:\n {4}runs-on: ubuntu-latest\n) {4}timeout-minutes: \d+\n/, "$1"), /docs-build: no timeout-minutes/],
  ["an advisory lane", "ci.yml", ci.replace("advisory: false", "advisory: true"), /advisory lane is not gated/],
  ["verify without --shard", "ci.yml", ci.replace(" --shard=${{ matrix.shard }}/4", ""), /verify: check:all is not given --shard/],
  ["a shard count that disagrees with the matrix", "ci.yml", ci.replace("shard: [1, 2, 3, 4]", "shard: [1, 2, 3]"), /does not match the 3 matrix shards/],
  ["a gap in the shard matrix", "ci.yml", ci.replace("shard: [1, 2, 3, 4]", "shard: [1, 2, 4, 5]"), /matrix.shard must be 1..n/],
  ["verify without --jobs", "ci.yml", ci.replace(" --jobs=2", ""), /verify: check:all has no --jobs/],
  ["verify without --check-timeout", "ci.yml", ci.replace(/ --check-timeout=\d+/, ""), /verify: check:all has no --check-timeout/],
  ["pi-compat without --check-timeout", "ci.yml", ci.replace("--skip=smoke:package,test:typecheck,test:lint --check-timeout=600", "--skip=smoke:package,test:typecheck,test:lint"), /ci.yml pi-compat: .* has no --check-timeout/],
  ["pi-compat without --shard", "ci.yml", ci.replace("--shard=${{ matrix.shard }}/4 --jobs=2 --skip=smoke:package", "--jobs=2 --skip=smoke:package"), /pi-compat: check:all is not given --shard/],
  ["pi-compat shard count disagrees", "ci.yml", ci.replace('pi: ["0.85.1", "0.99.2"]\n        shard: [1, 2, 3, 4]', 'pi: ["0.85.1", "0.99.2"]\n        shard: [1, 2, 3]'), /pi-compat: --shard=\.\.\.\/4 does not match the 3 matrix shards/],
  ["pi-compat without a shard axis", "ci.yml", ci.replace('pi: ["0.85.1", "0.99.2"]\n        shard: [1, 2, 3, 4]', 'pi: ["0.85.1", "0.99.2"]'), /pi-compat: no matrix\.shard list/],
  ["coverage without --check-timeout", "ci.yml", ci.replace("npm run -s coverage -- --shard=${{ matrix.shard }}/4 --coverage-out=coverage-raw --check-timeout=600", "npm run -s coverage -- --shard=${{ matrix.shard }}/4 --coverage-out=coverage-raw"), /ci.yml coverage: .* has no --check-timeout/],
  ["a bare --report is not treated as report-only", "ci.yml", ci.replace("npm run -s coverage -- --report coverage-raw", "npm run -s coverage -- --report"), /coverage-merge: .* has no --check-timeout/],
  ["verify not running check:all", "ci.yml", ci.replace("- run: npm run -s check:all -- --shard", "- run: npm run -s verify -- --shard"), /verify: does not run npm run -s check:all/],
  ["ci.yml PRs without integration/**", "ci.yml", ci.replace('branches: [main, "integration/**"]', "branches: [main]"), /ci.yml: pull_request does not run on integration\/\*\*/],
  ["security.yml PRs without integration/**", "security.yml", security.replace('branches: [main, "integration/**"]', "branches: [main]"), /security.yml: pull_request does not run on integration\/\*\*/],
  ["ci.yml PRs without main", "ci.yml", ci.replace('branches: [main, "integration/**"]', 'branches: ["integration/**"]'), /ci.yml: pull_request does not run on main/],
];
for (const [label, file, text, expected] of mutations) {
  assert.notEqual(text, texts.get(file), `mutation "${label}" changed the text`);
  const found = fileProblems(file, text);
  assert.ok(found.some((p) => expected.test(p)), `mutation "${label}" is caught (got: ${found.join("; ")})`);
}
ok(`each of ${mutations.length} mutations is caught`);

console.log(`workflow-policy smoke: ${passed} checks passed`);
