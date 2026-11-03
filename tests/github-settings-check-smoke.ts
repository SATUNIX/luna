#!/usr/bin/env node
// GitHub settings drift check (packages/core/github-settings-check.ts). Offline: a fixture
// getter stands in for `gh api`, built from .github/expected-settings.json, and a fake `gh` on
// PATH shows that the real request helper only ever issues GET requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectLive, drift, ghGet, readExpected, type Expected, type Get, type Response } from "../packages/core/github-settings-check.ts";

const expected = readExpected();
const repo = `repos/${expected.repository}`;
let passed = 0;
const ok = (name: string): void => { passed++; console.log(`  ok  ${name}`); };

/** Routes -> responses for a repository whose settings are exactly `want`. */
function fixture(want: Expected): Map<string, Response> {
  const routes = new Map<string, Response>();
  const r = (route: string, data: unknown, status: Response["status"] = 200): void => { routes.set(route, { status, data }); };
  r(`${repo}/rulesets`, want.rulesets.map((rs, i) => ({ id: i + 1, name: rs.name })));
  want.rulesets.forEach((rs, i) => r(`${repo}/rulesets/${i + 1}`, {
    name: rs.name, target: rs.target, enforcement: rs.enforcement,
    conditions: { ref_name: { include: rs.include, exclude: [] } },
    bypass_actors: rs.bypass_actors,
    rules: Object.entries(rs.rules).map(([type, parameters]) => (Object.keys(parameters).length ? { type, parameters } : { type })),
  }));
  r(`${repo}/actions/permissions`, { enabled: want.actions.enabled, allowed_actions: want.actions.allowed_actions, sha_pinning_required: want.actions.sha_pinning_required });
  r(`${repo}/actions/permissions/selected-actions`, { github_owned_allowed: want.actions.github_owned_allowed, verified_allowed: want.actions.verified_allowed, patterns_allowed: [...want.actions.patterns_allowed].reverse() });
  r(`${repo}/actions/permissions/workflow`, want.workflow_permissions);
  r(`${repo}/actions/permissions/fork-pr-contributor-approval`, { approval_policy: want.fork_pr_approval_policy });
  r(repo, { security_and_analysis: Object.fromEntries(Object.entries(want.security_and_analysis).map(([k, v]) => [k, { status: v }])) });
  r(`${repo}/vulnerability-alerts`, null, want.vulnerability_alerts ? 204 : 404);
  for (const [name, env] of Object.entries(want.environments)) {
    r(`${repo}/environments/${name}`, { protection_rules: [{ type: "required_reviewers", reviewers: env.required_reviewers.map((login) => ({ type: "User", reviewer: { login } })) }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    r(`${repo}/environments/${name}/deployment-branch-policies`, { branch_policies: env.tag_policies.map((name) => ({ name, type: "tag" })) });
  }
  return routes;
}
const getter = (routes: Map<string, Response>, seen: string[] = []): Get => (route) => {
  seen.push(route);
  return routes.get(route) ?? { status: 404, data: null };
};
const clone = (): Expected => structuredClone(expected);

// 1. A repository that matches the expected file shows no drift, and the check reads only repository routes.
const seen: string[] = [];
assert.deepEqual(drift(expected, collectLive(getter(fixture(expected), seen), expected)), []);
assert.ok(seen.every((route) => route === repo || route.startsWith(`${repo}/`)), "only this repository's routes are read");
ok("matching settings report no drift; only repository GET routes are read");

// 2. Each class of drift a settings review found is reported: review rules, required checks, code scanning, action pins and security features.
const cases: Array<[string, (live: Expected) => void, RegExp]> = [
  ["0 approvals", (s) => { const pr = s.rulesets[0]?.rules.pull_request; if (pr) pr.required_approving_review_count = 0; }, /pull_request\.required_approving_review_count: expected 1, live 0/],
  ["no code-owner review", (s) => { const pr = s.rulesets[0]?.rules.pull_request; if (pr) pr.require_code_owner_review = false; }, /require_code_owner_review/],
  ["no code-scanning rule", (s) => { if (s.rulesets[0]) Reflect.deleteProperty(s.rulesets[0].rules, "code_scanning"); }, /rule code_scanning missing/],
  ["a required check dropped", (s) => { const rsc = s.rulesets[0]?.rules.required_status_checks; if (rsc) rsc.required_status_checks = []; }, /required_status_checks\.required_status_checks/],
  ["a stale allowed-actions pin", (s) => { s.actions.patterns_allowed = ["ossf/scorecard-action@" + "0".repeat(40)]; }, /patterns_allowed: missing[\s\S]*patterns_allowed: extra ossf\/scorecard-action@0{40}/],
  ["Dependabot alerts off", (s) => { s.vulnerability_alerts = false; }, /vulnerability_alerts: expected true, live false/],
  ["security updates off", (s) => { s.security_and_analysis.dependabot_security_updates = "disabled"; }, /dependabot_security_updates/],
  ["the npm environment missing", (s) => { s.environments = {}; }, /environment npm: missing/],
  ["first-time-only fork approval", (s) => { s.fork_pr_approval_policy = "first_time_contributors"; }, /fork_pr_approval_policy/],
  ["a bypass actor added", (s) => { s.rulesets[0]?.bypass_actors.push({ actor_type: "Integration", actor_id: 1, bypass_mode: "always" }); }, /ruleset main: bypass_actors/],
];
for (const [label, mutate, pattern] of cases) {
  const live = clone();
  mutate(live);
  const found = drift(expected, collectLive(getter(fixture(live)), expected));
  assert.ok(found.some((line) => pattern.test(line)) || pattern.test(found.join("\n")), `${label} is reported (got: ${found.join("; ")})`);
}
const extraRule = fixture(expected);
const mainRuleset = extraRule.get(`${repo}/rulesets/1`);
assert.ok(mainRuleset);
extraRule.set(`${repo}/rulesets/1`, { status: 200, data: { ...(mainRuleset.data as object), rules: [{ type: "deletion" }] } });
assert.ok(drift(expected, collectLive(getter(extraRule), expected)).some((l) => /rule pull_request missing/.test(l)), "a missing rule is reported");
ok(`each of ${cases.length + 1} drift classes is reported`);

// 3. The real request helper: GET only, through `gh api --method GET`, and a flag-shaped route is refused.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-"));
const savedPath = process.env.PATH;
try {
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  const log = path.join(temp, "gh.log");
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$*" in *missing*) echo 'gh: Not Found (HTTP 404)' >&2; exit 1;; *alerts*) exit 0;; esac\necho '{"ok":true}'\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
  assert.deepEqual(ghGet(`${repo}/actions/permissions`), { status: 200, data: { ok: true } });
  assert.deepEqual(ghGet(`${repo}/vulnerability-alerts`), { status: 204, data: null });
  assert.deepEqual(ghGet(`${repo}/missing`), { status: 404, data: null });
  for (const bad of ["-X", "repos/a/b --method=PATCH", "graphql", "repos/a/b -f x=1", "--method PUT repos/a/b"]) assert.throws(() => ghGet(bad), /refusing/, `refused: ${bad}`);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls.length, 3, "refused routes never ran gh");
  for (const call of calls) assert.match(call, /^api --method GET repos\/[^ ]+$/, call);
  ok("the request helper issues GET only and refuses flag-shaped routes before running gh");
} finally {
  process.env.PATH = savedPath;
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`github-settings-check smoke: ${passed} checks passed`);
