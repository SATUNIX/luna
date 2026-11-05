#!/usr/bin/env node
/**
 * GitHub settings drift check.
 *
 * Reads the live repository settings and reports every difference from
 * `.github/expected-settings.json`: the rulesets (review rules, required checks, code-scanning
 * merge protection, bypass actors), the allowed actions, the default workflow token, the fork
 * pull-request approval policy, security and analysis features, Dependabot alerts and the
 * deployment environments. It only READS: every request is a GET through `gh api`, and the
 * request helper refuses anything that could be a flag. It never changes a setting; an
 * administrator applies a fix by hand, then updates the expected file in a reviewed change.
 *
 * Several of these settings are visible to repository administrators only, so run it with an
 * administrator's `gh` login (an agent's token sees less and reports that as drift).
 *
 *   node packages/core/github-settings-check.ts            # human-readable drift report
 *   node packages/core/github-settings-check.ts --json     # the live view plus drift, as evidence
 *
 * Exit status: 0 no drift, 1 drift, 2 a request or parse error. Pinned by
 * tests/github-settings-check-smoke.ts (fixtures; no network).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, boolean, isRecord, literal, number, object, optional, parseJsonAs, record, string, unknownValue, type Infer } from "./lib/guard.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const EXPECTED_FILE = path.join(ROOT, ".github/expected-settings.json");

const BypassActor = object({ actor_type: string(), actor_id: number(), bypass_mode: string() });
const ExpectedRuleset = object({
  name: string(),
  target: string(),
  enforcement: string(),
  include: array(string()),
  bypass_actors: array(BypassActor),
  rules: record(record(unknownValue())),
});
export const ExpectedSchema = object({
  schemaVersion: literal(1),
  repository: string(),
  rulesets: array(ExpectedRuleset),
  actions: object({
    enabled: boolean(),
    allowed_actions: string(),
    sha_pinning_required: boolean(),
    github_owned_allowed: boolean(),
    verified_allowed: boolean(),
    patterns_allowed: array(string()),
    indirect: optional(record(string())),
  }),
  workflow_permissions: object({ default_workflow_permissions: string(), can_approve_pull_request_reviews: boolean() }),
  fork_pr_approval_policy: string(),
  security_and_analysis: record(string()),
  vulnerability_alerts: boolean(),
  // Deployment rules: reviewers, and the tags and branches an environment deploys from (a
  // `branch_policies` list for an environment that deploys from a branch, such as github-pages).
  environments: record(object({ required_reviewers: array(string()), tag_policies: array(string()), branch_policies: optional(array(string())) })),
});
export type Expected = Infer<typeof ExpectedSchema>;

/** One GET: the HTTP status class this script needs (200/204 or 404) and the parsed body. */
export interface Response { status: 200 | 204 | 404; data: unknown }
export type Get = (route: string) => Response;

/** `gh api <route>`: GET only. A route that is not a plain repository path is refused before anything runs. */
export function ghGet(route: string): Response {
  if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.~%-]+)*$/.test(route)) throw new Error(`refusing a non-GET-shaped route: ${route}`);
  const result = spawnSync("gh", ["api", "--method", "GET", route], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status === 0) return result.stdout.trim() ? { status: 200, data: parseJsonAs(unknownValue(), result.stdout, route) } : { status: 204, data: null };
  if (/HTTP 404/.test(result.stderr)) return { status: 404, data: null };
  throw new Error(`gh api ${route} failed: ${result.stderr.trim().split("\n")[0] ?? `exit ${String(result.status)}`}`);
}

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "undefined");
const stable = (value: unknown): string => JSON.stringify(sortKeys(value));
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

/** The live settings, in the expected file's shape. */
export interface Live {
  rulesets: Array<{ name: string; target: string; enforcement: string; include: string[]; bypass_actors: unknown[]; rules: Record<string, Record<string, unknown>> }>;
  actions: Record<string, unknown>;
  workflow_permissions: Record<string, unknown>;
  fork_pr_approval_policy: unknown;
  security_and_analysis: Record<string, unknown>;
  vulnerability_alerts: boolean;
  environments: Record<string, { required_reviewers: string[]; tag_policies: string[]; branch_policies: string[]; custom_branch_policies: unknown } | null>;
}

/** Read every setting the expected file names. GET requests only. */
export function collectLive(get: Get, expected: Expected): Live {
  const repo = `repos/${expected.repository}`;
  const ok = (route: string): unknown => {
    const response = get(route);
    if (response.status === 404) throw new Error(`${route}: not found (an administrator's login is needed to read it)`);
    return response.data;
  };
  const rulesets = list(ok(`${repo}/rulesets`)).map((summary) => {
    const id = field(summary, "id");
    const full = ok(`${repo}/rulesets/${text(id)}`);
    const rules: Record<string, Record<string, unknown>> = {};
    for (const rule of list(field(full, "rules"))) {
      const parameters = field(rule, "parameters");
      rules[text(field(rule, "type"))] = isRecord(parameters) ? parameters : {};
    }
    return {
      name: text(field(full, "name")),
      target: text(field(full, "target")),
      enforcement: text(field(full, "enforcement")),
      include: list(field(field(field(full, "conditions"), "ref_name"), "include")).map(text),
      bypass_actors: list(field(full, "bypass_actors")).map((a) => ({ actor_type: field(a, "actor_type"), actor_id: field(a, "actor_id"), bypass_mode: field(a, "bypass_mode") })),
      rules,
    };
  });
  const permissions = ok(`${repo}/actions/permissions`);
  const selected = ok(`${repo}/actions/permissions/selected-actions`);
  const actions: Record<string, unknown> = {
    enabled: field(permissions, "enabled"),
    allowed_actions: field(permissions, "allowed_actions"),
    sha_pinning_required: field(permissions, "sha_pinning_required"),
    github_owned_allowed: field(selected, "github_owned_allowed"),
    verified_allowed: field(selected, "verified_allowed"),
    patterns_allowed: list(field(selected, "patterns_allowed")).map(text),
  };
  const workflow = ok(`${repo}/actions/permissions/workflow`);
  const fork = ok(`${repo}/actions/permissions/fork-pr-contributor-approval`);
  const analysis = field(ok(repo), "security_and_analysis");
  const security_and_analysis: Record<string, unknown> = {};
  for (const key of Object.keys(expected.security_and_analysis)) security_and_analysis[key] = field(field(analysis, key), "status") ?? "(not visible)";
  const alerts = get(`${repo}/vulnerability-alerts`);
  const environments: Live["environments"] = {};
  for (const name of Object.keys(expected.environments)) {
    const env = get(`${repo}/environments/${encodeURIComponent(name)}`);
    if (env.status === 404) { environments[name] = null; continue; }
    const reviewers = list(field(env.data, "protection_rules"))
      .filter((r) => field(r, "type") === "required_reviewers")
      .flatMap((r) => list(field(r, "reviewers")).map((x) => text(field(field(x, "reviewer"), "login") ?? field(field(x, "reviewer"), "name"))));
    const policy = field(env.data, "deployment_branch_policy");
    const custom = field(policy, "custom_branch_policies");
    const policies = custom === true ? list(field(ok(`${repo}/environments/${encodeURIComponent(name)}/deployment-branch-policies`), "branch_policies")) : [];
    const named = (type: string): string[] => policies.filter((p) => (field(p, "type") ?? "branch") === type).map((p) => text(field(p, "name"))).sort();
    environments[name] = { required_reviewers: reviewers.sort(), tag_policies: named("tag"), branch_policies: named("branch"), custom_branch_policies: custom };
  }
  return {
    rulesets,
    actions,
    workflow_permissions: { default_workflow_permissions: field(workflow, "default_workflow_permissions"), can_approve_pull_request_reviews: field(workflow, "can_approve_pull_request_reviews") },
    fork_pr_approval_policy: field(fork, "approval_policy"),
    security_and_analysis,
    vulnerability_alerts: alerts.status === 204 || alerts.status === 200,
    environments,
  };
}

/** Lists compared as sets: required checks by context and app, code-scanning tools by tool name. */
function keyed(rule: string, key: string, value: unknown): unknown {
  if (rule === "required_status_checks" && key === "required_status_checks") return list(value).map((c) => `${text(field(c, "context"))}@${text(field(c, "integration_id"))}`).sort();
  if (rule === "code_scanning" && key === "code_scanning_tools") return list(value).map(stable).sort();
  return value;
}

/** Every difference between the expected and the live settings, one line each. */
export function drift(expected: Expected, live: Live): string[] {
  const out: string[] = [];
  const differ = (where: string, want: unknown, got: unknown): void => {
    if (stable(want) !== stable(got)) out.push(`${where}: expected ${stable(want)}, live ${stable(got)}`);
  };
  for (const want of expected.rulesets) {
    const got = live.rulesets.find((r) => r.name === want.name && r.target === want.target);
    if (!got) { out.push(`ruleset ${want.name}: missing`); continue; }
    differ(`ruleset ${want.name}: enforcement`, want.enforcement, got.enforcement);
    differ(`ruleset ${want.name}: include`, [...want.include].sort(), [...got.include].sort());
    differ(`ruleset ${want.name}: bypass_actors`, want.bypass_actors.map(stable).sort(), got.bypass_actors.map(stable).sort());
    for (const [type, params] of Object.entries(want.rules)) {
      const live = got.rules[type];
      if (live === undefined) { out.push(`ruleset ${want.name}: rule ${type} missing`); continue; }
      for (const [key, value] of Object.entries(params)) differ(`ruleset ${want.name}: ${type}.${key}`, keyed(type, key, value), keyed(type, key, live[key]));
    }
    for (const type of Object.keys(got.rules)) if (!(type in want.rules)) out.push(`ruleset ${want.name}: rule ${type} is live but not expected`);
  }
  for (const got of live.rulesets) if (!expected.rulesets.some((r) => r.name === got.name && r.target === got.target)) out.push(`ruleset ${got.name}: live but not expected`);
  const { patterns_allowed } = expected.actions;
  for (const key of ["enabled", "allowed_actions", "sha_pinning_required", "github_owned_allowed", "verified_allowed"] as const) differ(`actions.${key}`, expected.actions[key], live.actions[key]);
  const livePatterns = list(live.actions.patterns_allowed).map(text);
  for (const p of patterns_allowed) if (!livePatterns.includes(p)) out.push(`actions.patterns_allowed: missing ${p}`);
  for (const p of livePatterns) if (!patterns_allowed.includes(p)) out.push(`actions.patterns_allowed: extra ${p} (not used by any workflow)`);
  for (const [key, value] of Object.entries(expected.workflow_permissions)) differ(`workflow_permissions.${key}`, value, live.workflow_permissions[key]);
  differ("fork_pr_approval_policy", expected.fork_pr_approval_policy, live.fork_pr_approval_policy);
  for (const [key, value] of Object.entries(expected.security_and_analysis)) differ(`security_and_analysis.${key}`, value, live.security_and_analysis[key]);
  differ("vulnerability_alerts", expected.vulnerability_alerts, live.vulnerability_alerts);
  for (const [name, want] of Object.entries(expected.environments)) {
    const got = live.environments[name];
    if (!got) { out.push(`environment ${name}: missing`); continue; }
    differ(`environment ${name}: required_reviewers`, [...want.required_reviewers].sort(), got.required_reviewers);
    differ(`environment ${name}: tag_policies`, [...want.tag_policies].sort(), got.tag_policies);
    differ(`environment ${name}: branch_policies`, [...(want.branch_policies ?? [])].sort(), got.branch_policies);
    if (got.custom_branch_policies !== true) out.push(`environment ${name}: deployment is not limited to its tag and branch policies`);
  }
  return out;
}

export function readExpected(file = EXPECTED_FILE): Expected {
  return parseJsonAs(ExpectedSchema, fs.readFileSync(file, "utf8"), "expected-settings");
}

function main(argv: string[]): number {
  const expected = readExpected();
  const live = collectLive(ghGet, expected);
  const found = drift(expected, live);
  if (argv.includes("--json")) console.log(JSON.stringify({ repository: expected.repository, live, drift: found }, null, 2));
  else {
    for (const line of found) console.log(`drift: ${line}`);
    console.log(found.length ? `${found.length} setting(s) differ from .github/expected-settings.json` : "no drift from .github/expected-settings.json");
  }
  return found.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) {
    console.error(`github-settings-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
