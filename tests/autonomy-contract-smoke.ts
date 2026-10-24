#!/usr/bin/env node
/**
 * Offline checks for the run contract (packages/autonomy/lib/contract.ts): the hand-written
 * validator, defaults that fail closed, unknown-key policy, credential-shaped values, effort
 * snapshotting, the deprecated v0 mapping, the JSON Schema (validated with ajv here, which is a
 * devDependency; the runtime code has no dependencies) and the shipped examples. Also the
 * address and glob helpers the contract and the egress proxy rely on. No Docker, no network.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { assert, implementRaw, makeChecker, testEffort } from "./autonomy-helpers.ts";
import { contractDigest, formatProblems, legacyToRaw, resolveContract, workerContract, SCHEMA_VERSION, urlProblem } from "../packages/autonomy/lib/contract.ts";
import { classifyAddress, isIpLiteral, normaliseHost, parseLegacyIPv4, isPublicIpLiteral } from "../packages/autonomy/lib/netaddr.ts";
import { globToRegExp, globProblem, pathsOutsideAreas } from "../packages/autonomy/lib/glob.ts";
import { templateIds, describeTemplates } from "../packages/autonomy/lib/templates/index.ts";
import type { RawContract } from "./autonomy-helpers.ts";
import { isRecord } from "../packages/core/lib/guard.ts";

const { check, done } = makeChecker("autonomy-contract-smoke");

/** The provider fixture; the keys a check deletes from its clone are optional. */
interface ProviderFixture extends RawContract {
  model: { provider: string; worker: string; manager: string };
  providerSettings: { upstream?: string; apiKeyEnv?: string; authName?: string; pricing?: Record<string, { inputPerMTok: number; outputPerMTok: number }> };
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "..", "packages", "autonomy");
type ResolveOptions = NonNullable<Parameters<typeof resolveContract>[1]>;
type Resolution = ReturnType<typeof resolveContract>;
type Contract = Extract<Resolution, { ok: true }>["contract"];
/** One validator finding, as `resolveContract` reports it. */
interface Problem { level: "error" | "warning"; path: string; message: string }

const resolve = (raw: object, opts: ResolveOptions = {}): Resolution => resolveContract(raw, { effort: testEffort, ...opts });
const errors = (r: Resolution): Problem[] => r.problems.filter((p: Problem) => p.level === "error");
const warnings = (r: Resolution): Problem[] => r.problems.filter((p: Problem) => p.level === "warning");
const errorPaths = (r: Resolution): string[] => errors(r).map((p) => p.path);
const clone = <T>(v: T): T => structuredClone(v);
/** A template option at a dotted path (templateOptions is checked by its template, not typed by the contract). */
const optionAt = (options: Record<string, unknown>, at: string): unknown => at.split(".").reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined), options);
/** The contract of a resolution the check expects to have succeeded. */
function contractOf(r: Resolution): Contract {
  assert.ok(r.ok, formatProblems(r.problems));
  return r.contract;
}

await check("a minimal finite-task contract resolves with every default filled and closed", () => {
  const r = resolve(implementRaw());
  assert.equal(r.ok, true, formatProblems(r.problems));
  const c = contractOf(r);
  assert.equal(c.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(c.permissions.network.egress, [], "no network egress unless listed");
  assert.deepEqual(c.permissions.network.services, []);
  assert.deepEqual(c.permissions.credentials.names, []);
  assert.deepEqual(c.permissions.writeAreas, ["**"]);
  assert.equal(c.promotion.policy, "none", "nothing is promoted by default");
  assert.equal(c.promotion.requiresOperatorApproval, true);
  assert.deepEqual(c.effort, { tier: "standard", cap: "standard" });
  assert.deepEqual(Object.keys(c.budget).sort(), ["maxMinutes", "maxSteps", "perStepUsd", "totalUsd"]);
  assert.ok(c.budget.totalUsd > 0 && c.budget.maxSteps > 0 && c.budget.maxMinutes > 0, "every run is bounded");
  const closed = contractOf(resolve(implementRaw({ permissions: {} })));
  assert.deepEqual(closed.permissions.unattended, { authorised: false, autoApprove: false }, "unattended is opt-in");
  assert.equal(closed.model.provider, "openrouter");
  assert.equal(closed.model.review, closed.model.manager, "review falls back to the manager, then the worker model");
  assert.equal(c.authorisation, null);
  assert.deepEqual(templateIds().sort(), ["deploy", "implement", "self-improve"]);
  assert.equal(describeTemplates().length, 3);
});

await check("required fields, ids and bounds are enforced", () => {
  assert.ok(errorPaths(resolve({ ...implementRaw(), run: "Bad Run" })).includes("run"));
  assert.ok(errorPaths(resolve({ ...implementRaw(), schemaVersion: 2 })).includes("schemaVersion"));
  assert.ok(errorPaths(resolve({ ...implementRaw(), template: "nope" })).includes("template"));
  assert.ok(errorPaths(resolve(implementRaw({ objective: { spec: "x" } }))).includes("objective.title"));
  assert.ok(errorPaths(resolve(implementRaw({ objective: { title: "t", spec: "x", specFile: "y.md" } }))).includes("objective"));
  assert.ok(errorPaths(resolve(implementRaw({ objective: { title: "t" } }))).includes("objective.spec"), "a finite task needs a specification");
  assert.ok(errorPaths(resolve(implementRaw({ acceptance: { checks: [] } }))).includes("acceptance.checks"), "a finite task needs a check to pass");
  assert.ok(errorPaths(resolve(implementRaw({ acceptance: { checks: [{ id: "a", run: ["x"], required: false }] } }))).includes("acceptance.checks"), "and a required one");
  assert.ok(errorPaths(resolve(implementRaw({ budget: { totalUsd: 1, perStepUsd: 2 } }))).includes("budget.perStepUsd"));
  assert.ok(errorPaths(resolve(implementRaw({ budget: { maxSteps: 0 } }))).includes("budget.maxSteps"));
  assert.ok(errorPaths(resolve(implementRaw({ acceptance: { checks: [{ id: "a", run: ["x"] }, { id: "a", run: ["y"] }] } }))).includes("acceptance.checks[1].id"), "duplicate check ids");
  assert.ok(errorPaths(resolve(implementRaw({ objective: { title: "t", spec: "s", backlog: [{ id: "T1", title: "x", acceptance: ["ghost"] }] } }))).includes("objective.backlog[0].acceptance"), "backlog items may only name declared checks");
  assert.ok(errorPaths(resolve(implementRaw({ objective: { title: "t", spec: "s", backlog: [{ id: "T1", title: "a" }, { id: "T1", title: "b" }] } }))).includes("objective.backlog[1].id"));
  assert.ok(errorPaths(resolve(implementRaw({ acceptance: { checks: [{ id: "a", run: [] }] } }))).includes("acceptance.checks[0].run"));
  assert.ok(errorPaths(resolve(implementRaw({ acceptance: { checks: [{ id: "a", run: ["x"], cwd: "../up" }] } }))).includes("acceptance.checks[0].cwd"));
  assert.ok(errorPaths(resolve(implementRaw({ acceptance: { checks: [{ id: "a", run: ["x"], timeoutMinutes: 9999 }] } }))).includes("acceptance.checks[0].timeoutMinutes"));
  assert.ok(errorPaths(resolve(implementRaw({ acceptance: { checks: [{ id: "a", run: ["x"] }], overlay: [{ source: "a", target: "../b" }] } }))).includes("acceptance.overlay[0].target"));
  assert.ok(errorPaths(resolve(implementRaw({ acceptance: { checks: [{ id: "a", run: ["x"] }], overlay: [{ source: "a", target: ".git/hooks/pre-commit" }] } }))).includes("acceptance.overlay[0].target"));
  // A held-out file is copied in and mounted into containers that run the worker's code: never a credential store or a system path.
  for (const source of ["/home/u/.ssh/id_ed25519", "/home/u/.aws/credentials", "/home/u/.config/gh/hosts.yml", "/home/u/.pi/agent/auth.json", "/etc/shadow", "/home/u/.npmrc", "/var/run/docker.sock"]) {
    assert.ok(errorPaths(resolve(implementRaw({ acceptance: { checks: [{ id: "a", run: ["x"] }], overlay: [{ source, target: "held/out.txt" }] } }))).includes("acceptance.overlay[0].source"), `${source} is refused as an overlay source`);
  }
  assert.ok(errorPaths(resolve(implementRaw({ recovery: { softNudges: -1 } }))).includes("recovery.softNudges"));
  assert.ok(errorPaths(resolve(implementRaw({ runtime: { engine: "lxc" } }))).includes("runtime.engine"));
  assert.ok(errorPaths(resolve(implementRaw({ runtime: { image: "Not An Image!" } }))).includes("runtime.image"));
  // Deliberately not an object: the validator must refuse it.
  assert.ok(errorPaths(resolveContract("nope", { effort: testEffort })).includes(""), "a non-object is refused");
});

await check("unknown keys: top-level and safety-critical sections fail closed; other sections warn", () => {
  const bad = (over: object, expectPath: string) => {
    const r = resolve(over);
    assert.ok(errorPaths(r).includes(expectPath), `${expectPath} should be an error, got ${formatProblems(r.problems)}`);
  };
  bad({ ...implementRaw(), surprise: 1 }, ".surprise");
  bad(implementRaw({ permissions: { root: true } }), "permissions.root");
  // A "__proto__" key (JSON.parse makes it an own key) is an unknown key too, not a way around the check.
  bad({ ...implementRaw(), permissions: JSON.parse('{"__proto__": {"network": {"lan": true}}}') as object }, "permissions.__proto__");
  bad(implementRaw({ permissions: { network: { host: "x" } } }), "permissions.network.host");
  bad(implementRaw({ permissions: { network: { egress: [{ host: "example.org", ports: [443], wildcard: true }] } } }), "permissions.network.egress[0].wildcard");
  bad(implementRaw({ permissions: { unattended: { authorised: true, sudo: true } } }), "permissions.unattended.sudo");
  bad(implementRaw({ permissions: { credentials: { names: [], values: { A: "b" } } } }), "permissions.credentials.values");
  bad(implementRaw({ permissions: { outputs: { destinations: [], forceOverwrite: true } } }), "permissions.outputs.forceOverwrite");
  bad(implementRaw({ promotion: { policy: "none", force: true } }), "promotion.force");
  bad(implementRaw({ authorisation: { boundaryDigest: "a".repeat(64), by: "me", at: "2026-09-30T00:00:00Z", extra: 1 } }), "authorisation.extra");
  // Malformed safety-critical values are errors, never silently corrected.
  bad(implementRaw({ permissions: { network: { egress: "everything" } } }), "permissions.network.egress");
  bad(implementRaw({ permissions: { unattended: { authorised: "yes" } } }), "permissions.unattended.authorised");
  bad(implementRaw({ permissions: { unattended: { authorised: false, autoApprove: true } } }), "permissions.unattended");
  bad(implementRaw({ promotion: { policy: "publish" } }), "promotion.policy");
  bad(implementRaw({ permissions: "open" }), "permissions");
  const warn = resolve(implementRaw({ objective: { title: "t", spec: "s", mood: "x" }, budget: { totalUsd: 5, perStepUsd: 1, maxSteps: 3, maxMinutes: 10, nice: true }, model: { worker: "a/b", fancy: 1 } }));
  assert.equal(warn.ok, true, formatProblems(warn.problems));
  assert.deepEqual(warnings(warn).map((p) => p.path).sort(), ["budget.nice", "model.fancy", "objective.mood"]);
});

await check("credential-shaped values are rejected anywhere in a contract; names are the only way to reference secrets", () => {
  for (const secret of ["sk-or-v1-0123456789abcdef0123456789abcdef", "glpat-abcdefghij0123456789", "ghp_0123456789abcdefghij0123456789abcd", "AKIAABCDEFGHIJKLMNOP", "Bearer abcdefghijklmnopqrstuvwxyz012345", "https://user:hunter2@example.org/x.git", "-----BEGIN OPENSSH PRIVATE KEY-----"]) {
    const r = resolve(implementRaw({ objective: { title: "t", spec: `use ${secret} to log in` } }));
    assert.equal(r.ok, false, secret);
    assert.match(formatProblems(errors(r)), /credential/i);
  }
  assert.equal(resolve(implementRaw({ permissions: { credentials: { names: ["NPM_TOKEN"] } } })).ok, true);
  assert.ok(errorPaths(resolve(implementRaw({ permissions: { credentials: { names: ["npm token"] } } }))).includes("permissions.credentials.names[0]"));
  assert.ok(errorPaths(resolve(implementRaw({ providerSettings: { headers: { Authorization: "x" } } }))).includes("providerSettings.headers.Authorization"), "credential headers come from the relay");
  assert.ok(errorPaths(resolve(implementRaw({ providerSettings: { apiKeyEnv: "sk-or-v1-notanenvname" } }))).length > 0);
});

await check("effort: any tier spelling resolves to a canonical id; snapshotted with its cap; bad or unavailable fails closed", () => {
  const tier = (effort: unknown) => contractOf(resolve(implementRaw({ effort }))).effort;
  assert.deepEqual(tier("E4"), { tier: "thorough", cap: "thorough" });
  assert.deepEqual(tier("min"), { tier: "minimal", cap: "minimal" });
  assert.deepEqual(tier(2), { tier: "focused", cap: "focused" });
  assert.deepEqual(tier({ tier: "focused", cap: "thorough" }), { tier: "focused", cap: "thorough" });
  assert.ok(errorPaths(resolve(implementRaw({ effort: "E9" }))).includes("effort.tier"));
  assert.ok(errorPaths(resolve(implementRaw({ effort: { tier: "thorough", cap: "focused" } }))).includes("effort"), "a tier above its cap");
  assert.ok(errorPaths(resolve(implementRaw({ effort: { tier: "standard", cap: "warp" } }))).includes("effort.cap"));
  // `effort: null` is deliberately outside the declared option type: it exercises the adapter's fallback.
  const missing = resolveContract(implementRaw(), { effort: null });
  // With no injected API the adapter falls back to core's module; when core has none either the contract is refused.
  if (!testEffort.isStub) assert.equal(missing.ok, true);
  else assert.ok(!missing.ok && errors(missing).some((p) => p.path === "effort"), "no effort policy: refuse rather than guess");
});

await check("model and provider: OpenRouter is a preset, not a requirement; a provider that reports no cost needs pricing", () => {
  const compat: ProviderFixture = { model: { provider: "openai-compatible", worker: "local-model", manager: "local-model" }, providerSettings: { upstream: "https://llm.example.org/v1", apiKeyEnv: "LLM_API_KEY", pricing: { "local-model": { inputPerMTok: 0.1, outputPerMTok: 0.2 } } } };
  const ok = resolve(implementRaw(compat));
  assert.equal(ok.ok, true, formatProblems(ok.problems));
  assert.equal(contractOf(ok).providerSettings.upstream, "https://llm.example.org/v1");
  assert.equal(contractOf(ok).model.review, "local-model");
  const noPrice = clone(compat); delete noPrice.providerSettings.pricing;
  assert.ok(errorPaths(resolve(implementRaw(noPrice))).includes("providerSettings.pricing"), "unmetered spend cannot honour a budget");
  for (const bad of [null, "5", true, -1]) {
    const priced = clone(compat);
    priced.providerSettings.pricing = { "local-model": { inputPerMTok: 0.1, outputPerMTok: bad as number } };
    assert.ok(errorPaths(resolve(implementRaw(priced))).includes("providerSettings.pricing.local-model"), `a price of ${JSON.stringify(bad)} is not a number >= 0`);
  }
  const named = clone(compat); delete named.providerSettings.pricing;
  named.model = { provider: "openai-compatible", worker: "constructor", manager: "constructor" };
  assert.ok(errorPaths(resolve(implementRaw(named))).includes("providerSettings.pricing"), "a model id never finds a price on Object.prototype");
  const noUpstream = clone(compat); delete noUpstream.providerSettings.upstream;
  assert.ok(errorPaths(resolve(implementRaw(noUpstream))).includes("providerSettings.upstream"));
  assert.ok(errorPaths(resolve(implementRaw({ providerSettings: { upstream: "http://plain.example.org/v1" } }))).includes("providerSettings.upstream"), "https only");
  // Where a credential may go. The relay sends the key it finds to `upstream`, so a contract someone else wrote must not be able
  // to point the operator's other credentials, or a pi login, at a host of its choosing.
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "DOCKER_PASSWORD", "SSH_AUTH_SOCK", "KUBECONFIG"]) {
    assert.ok(errorPaths(resolve(implementRaw({ ...compat, providerSettings: { ...compat.providerSettings, apiKeyEnv: name } }))).includes("providerSettings.apiKeyEnv"), `${name} is not an inference key`);
  }
  assert.equal(resolve(implementRaw(compat)).ok, true, "a provider's own key variable is fine");
  assert.ok(errorPaths(resolve(implementRaw({ providerSettings: { upstream: "https://llm.example.org/v1", authName: "openrouter" } }))).includes("providerSettings.authName"), "a pi login is never sent to a custom upstream");
  assert.ok(errorPaths(resolve(implementRaw({ providerSettings: { authName: "anthropic" } }))).includes("providerSettings.authName"), "nor is a different provider's login used");
  assert.ok(errorPaths(resolve(implementRaw({ ...compat, providerSettings: { ...compat.providerSettings, authName: "openrouter" } }))).includes("providerSettings.authName"), "openai-compatible has no login to use");
  const custom = resolve(implementRaw({ providerSettings: { upstream: "https://llm.example.org/v1" } }));
  assert.equal(custom.ok, true, JSON.stringify(custom.problems));
  assert.equal(contractOf(custom).providerSettings.authName ?? null, null, "the preset's login default is dropped when the upstream is custom");
  assert.equal(contractOf(resolve(implementRaw({}))).providerSettings.authName, "openrouter", "and kept for the provider's own upstream");
  assert.ok(errorPaths(resolve(implementRaw({ model: { provider: "mystery" } }))).includes("model.provider"));
  assert.ok(errorPaths(resolve(implementRaw({ model: { worker: "a/b:online" } }))).includes("model.worker"), "no web-search model variants");
});

await check("network egress and services: public hosts only, images pinned from an allowlist, services only for deploy", () => {
  const egress = (list: unknown) => resolve(implementRaw({ permissions: { network: { egress: list } } }));
  const good = egress([{ host: "Registry.NPMJS.org.", ports: [443] }]);
  assert.equal(good.ok, true, formatProblems(good.problems));
  assert.deepEqual(contractOf(good).permissions.network.egress, [{ host: "registry.npmjs.org", ports: [443], plainGet: false }], "normalised: lower case, no trailing dot");
  for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.10", "0x7f.1", "[::1]", "svc.internal", "a b.example.org", "https://example.org", "example.org:443", "user@example.org", "*.example.org", "xn--", "example", ""]) {
    assert.equal(egress([{ host, ports: [443] }]).ok, false, `egress host ${JSON.stringify(host)} must be refused`);
  }
  assert.equal(egress([{ host: "8.8.8.8", ports: [53] }]).ok, true, "a public IP literal is allowed when listed explicitly");
  assert.ok(errorPaths(egress([{ host: "example.org", ports: [0] }])).includes("permissions.network.egress[0].ports[0]"));
  assert.ok(errorPaths(egress([{ host: "example.org" }, { host: "EXAMPLE.org" }])).includes("permissions.network.egress[1].host"), "duplicates");

  const service = { name: "web", image: "nginxinc/nginx-unprivileged:1.27-alpine", port: 8080, health: { path: "/" } };
  const deploy = (network: unknown, extra: object = {}) => resolve({ ...implementRaw({ permissions: { network } }), template: "deploy", ...extra });
  const ok = deploy({ serviceImages: [service.image], services: [service] });
  assert.equal(ok.ok, true, formatProblems(ok.problems));
  assert.ok(errorPaths(deploy({ serviceImages: [], services: [service] })).includes("permissions.network.services[0].image"), "not in the allowlist");
  assert.ok(errorPaths(deploy({ serviceImages: ["nginx:latest"], services: [{ ...service, image: "nginx:latest" }] })).includes("permissions.network.services[0].image"), ":latest is not a pin");
  assert.ok(errorPaths(deploy({ serviceImages: ["nginx"], services: [{ ...service, image: "nginx" }] })).includes("permissions.network.services[0].image"), "untagged is not a pin");
  const digest = `nginx@sha256:${"a".repeat(64)}`;
  assert.equal(deploy({ serviceImages: [digest], services: [{ ...service, image: digest }] }).ok, true, "a digest is a pin");
  assert.ok(errorPaths(deploy({ serviceImages: [service.image], services: [{ ...service, name: "inference" }] })).includes("permissions.network.services[0].name"), "reserved names");
  assert.ok(errorPaths(deploy({ serviceImages: [service.image], services: [{ ...service, user: "0:0" }] })).includes("permissions.network.services[0].user"), "never root");
  assert.ok(errorPaths(deploy({ serviceImages: [service.image], services: [{ ...service, privileged: true }] })).includes("permissions.network.services[0].privileged"), "unknown service keys are errors");
  assert.ok(errorPaths(deploy({ serviceImages: [service.image], services: [{ ...service, workspaceMounts: [{ source: "../../etc", target: "/x" }] }] })).includes("permissions.network.services[0].workspaceMounts[0].source"));
  assert.ok(errorPaths(deploy({ serviceImages: [service.image], services: [{ ...service, credentialEnv: { DB_PASS: "UNDECLARED" } }] })).length > 0, "service credentials must be declared by name");
  assert.ok(errorPaths(resolve(implementRaw({ permissions: { network: { serviceImages: [service.image], services: [service] } } }))).includes("permissions.network.services"), "services belong to the deploy template");
  assert.ok(errorPaths(deploy({ serviceImages: [], services: [] })).includes("permissions.network.services"), "deploy needs a service");
  const health = deploy({ serviceImages: [service.image], services: [service] }, { acceptance: { checks: [{ id: "web-up", type: "service-health", service: "ghost", path: "/" }] } });
  assert.ok(errorPaths(health).includes("acceptance.checks[0].service"), "a health check names a declared service");
});

await check("write areas, outputs and promotion: globs stay inside the workspace; protected branches and unlisted remotes are refused", () => {
  const areas = (writeAreas: unknown) => resolve(implementRaw({ permissions: { writeAreas } }));
  assert.equal(areas(["src/**", "tests/**", "README.md"]).ok, true);
  for (const bad of ["/etc/**", "../x", "a/../b", ".git/**", "C:\\x", "", "a\\b"]) assert.equal(areas([bad]).ok, false, `write area ${JSON.stringify(bad)}`);
  assert.ok(errorPaths(areas([])).includes("permissions.writeAreas"));
  const promo = (promotion: unknown, extra: object = {}) => resolve(implementRaw({ promotion, ...extra }));
  assert.ok(errorPaths(promo({ policy: "push" })).includes("promotion.destinations"), "push needs listed destinations");
  assert.equal(promo({ policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi/todo" }] }).ok, true);
  assert.ok(errorPaths(promo({ policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/x.git", branch: "main" }] })).includes("promotion.destinations[0].branch"), "never push to a protected branch");
  assert.ok(errorPaths(promo({ policy: "push", destinations: [{ kind: "git-remote", url: "https://tok:en@git.example.org/x.git", branch: "pi/x" }] })).includes("promotion.destinations[0].url"));
  assert.ok(errorPaths(promo({ policy: "push", destinations: [{ kind: "git-remote", url: "file:///etc", branch: "pi/x" }] })).includes("promotion.destinations[0].url"));
  assert.ok(errorPaths(promo({ policy: "none", destinations: [{ kind: "git-remote", url: "https://git.example.org/x.git", branch: "pi/x" }] })).length > 0, "policy none takes no destinations");
  assert.ok(errorPaths(promo({ policy: "local-branch" })).includes("promotion"), "local-branch needs a local repository");
  const local = promo({ policy: "local-branch" }, { inputs: { repository: { path: "/repo", ref: "main" } } });
  assert.equal(local.ok, true, formatProblems(local.problems));
  assert.equal(contractOf(local).promotion.requiresOperatorApproval, true);
  const noApproval = promo({ policy: "push", requiresOperatorApproval: false, destinations: [{ kind: "git-remote", url: "https://git.example.org/x.git", branch: "pi/x" }] });
  assert.ok(warnings(noApproval).some((p) => p.path === "promotion.requiresOperatorApproval"));
  assert.ok(errorPaths(resolve(implementRaw({ permissions: { outputs: { destinations: [{ kind: "export-dir", path: "relative/dir" }] } } }))).includes("permissions.outputs.destinations[0].path"));
  assert.equal(urlProblem("https://git.example.org/a.git"), null);
  assert.equal(urlProblem("git@git.example.org:team/a.git"), null);
  for (const bad of ["http://git.example.org/a.git", "-oProxyCommand=x", "ext::sh -c id", "https://a b", "ftp://x/y"]) assert.notEqual(urlProblem(bad), null, bad);
});

await check("the legacy v0 shape maps onto self-improve with a deprecation warning, and now needs an explicit remote and promotion policy", () => {
  const v0 = { run: "perpetual-test", cycles: 7, gitRemote: "https://git.example.org/team/repo.git", promotion: "push", integration: { branch: "experimental/main", review: true }, budget: { perCycleUsd: 2, totalUsd: 20 }, limits: { softMinutes: 60, hardMinutes: 90 } };
  const r = resolve(v0);
  assert.equal(r.ok, true, formatProblems(r.problems));
  assert.equal(r.legacy, true);
  const rc = contractOf(r);
  assert.equal(rc.template, "self-improve");
  assert.ok(warnings(r).some((p) => /deprecated/i.test(p.message)), "deprecation warning");
  assert.equal(rc.budget.maxSteps, 7);
  assert.equal(rc.budget.perStepUsd, 2);
  assert.equal(rc.templateOptions.perStepHardUsd, 4, "hard budget defaults to twice the review budget");
  assert.equal(optionAt(rc.templateOptions, "integration.branch"), "experimental/main");
  assert.equal(optionAt(rc.templateOptions, "limits.softMinutes"), 60);
  assert.equal(optionAt(rc.templateOptions, "limits.idleMinutes"), 20, "unspecified limits keep their v0 defaults");
  assert.deepEqual(rc.promotion.destinations, [{ kind: "git-remote", url: v0.gitRemote, branch: "experimental/main", tags: true }]);
  assert.ok(rc.inputs.repository, "the legacy remote becomes the input repository");
  assert.equal(rc.inputs.repository.url, v0.gitRemote);
  assert.equal(rc.permissions.unattended.autoApprove, true, "v0 always ran with every approval granted; the boundary authorisation now records that");
  assert.equal(rc.authorisation, null, "and it still needs the operator's authorisation");
  const noRemote = resolve({ run: "perpetual-test", cycles: 3, promotion: "none" });
  assert.equal(noRemote.ok, false);
  assert.ok(errorPaths(noRemote).includes("gitRemote"), "there is no default remote");
  assert.doesNotMatch(JSON.stringify(noRemote), /gitlab|home\.internal/i);
  const noPromotion = resolve({ run: "perpetual-test", cycles: 3, gitRemote: v0.gitRemote });
  assert.ok(errorPaths(noPromotion).includes("promotion"), "promotion must be explicit");
  const local = resolve({ ...v0, gitRemote: "/srv/git/repo.git", promotion: "local-branch" });
  assert.equal(local.ok, true, formatProblems(local.problems));
  const localRepo = contractOf(local).inputs.repository;
  assert.ok(localRepo, "a local remote becomes the input repository");
  assert.equal(localRepo.path, "/srv/git/repo.git");
  assert.deepEqual(contractOf(local).promotion.destinations, [{ kind: "local-branch", repo: "/srv/git/repo.git", branch: "experimental/main" }]);
  assert.ok(errorPaths(resolve({ ...v0, integration: { branch: "main" } })).includes("templateOptions.integration.branch"), "the integration branch is configurable but never a protected one");
  const custom = resolve({ ...v0, integration: { branch: "bots/integration" }, promotion: "none" });
  assert.equal(custom.ok, true, formatProblems(custom.problems));
  assert.equal(optionAt(contractOf(custom).templateOptions, "integration.branch"), "bots/integration", "not hard-coded to experimental/*");
  assert.ok(legacyToRaw(v0, { err() {}, warn() {} }).schemaVersion === 1);
});

await check("the boundary digest input: contract digest ignores the authorisation; worker copy carries no supervisor-only settings", () => {
  const base = contractOf(resolve(implementRaw({ permissions: { credentials: { names: ["NPM_TOKEN"] }, unattended: { authorised: true, autoApprove: true } }, promotion: { policy: "none" } })));
  const withAuth = { ...base, authorisation: { boundaryDigest: "b".repeat(64), by: "me", at: "2026-09-30T00:00:00.000Z" } };
  assert.equal(contractDigest(base), contractDigest(withAuth));
  assert.notEqual(contractDigest(base), contractDigest({ ...base, budget: { ...base.budget, totalUsd: base.budget.totalUsd + 1 } }));
  const w = workerContract(base);
  assert.equal(w.sanitised, true);
  for (const key of ["authorisation", "providerSettings", "runtime", "promotion", "inputs", "credentials"]) assert.equal(key in w, false, key);
  assert.equal(JSON.stringify(w).includes("NPM_TOKEN"), false, "credential names are not shown to the worker either");
  assert.deepEqual(w.permissions.unattended, { authorised: true, autoApprove: true });
  assert.equal(w.effort.tier, "standard");
});

await check("netaddr: normalisation, legacy IPv4 spellings and address classes", () => {
  assert.equal(normaliseHost("Example.COM."), "example.com");
  assert.equal(normaliseHost("[::FFFF:127.0.0.1]"), "::ffff:127.0.0.1");
  for (const bad of ["example.com..", ".example.com", "exa mple.com", "example.com:443", "user@example.com", "example.com/path", "ex%41mple.com", "exämple.com", "*.example.com", "::1", "", " example.com", "fe80::1%eth0"]) assert.equal(normaliseHost(bad), null, JSON.stringify(bad));
  assert.equal(parseLegacyIPv4("0x7f.1"), "127.0.0.1");
  assert.equal(parseLegacyIPv4("2130706433"), "127.0.0.1");
  assert.equal(parseLegacyIPv4("0177.0.0.1"), "127.0.0.1");
  assert.equal(parseLegacyIPv4("127.1"), "127.0.0.1");
  assert.equal(parseLegacyIPv4("example.com"), null);
  assert.equal(parseLegacyIPv4("256.1.1.1"), null);
  assert.equal(isIpLiteral("0x7f.1"), true);
  assert.equal(isIpLiteral("1.example.com"), false);
  const cls = (ip: string) => classifyAddress(ip);
  const table = { "8.8.8.8": "public", "1.1.1.1": "public", "127.0.0.1": "loopback", "127.9.9.9": "loopback", "10.0.0.1": "private", "172.16.5.5": "private", "172.32.0.1": "public", "192.168.1.1": "private", "169.254.169.254": "metadata", "169.254.1.1": "link-local", "100.64.0.1": "carrier-grade-nat", "0.0.0.0": "unspecified", "224.0.0.1": "multicast", "255.255.255.255": "reserved", "198.18.0.1": "benchmark", "192.0.2.1": "documentation",
    "::1": "loopback", "::": "unspecified", "::ffff:127.0.0.1": "ipv4-mapped-loopback", "::ffff:7f00:1": "ipv4-mapped-loopback", "::ffff:10.0.0.1": "ipv4-mapped-private", "::ffff:169.254.169.254": "ipv4-mapped-metadata", "::ffff:8.8.8.8": "ipv4-mapped-public", "fc00::1": "unique-local", "fd12:3456::1": "unique-local", "fe80::1": "link-local", "ff02::1": "multicast", "2001:db8::1": "documentation", "2002:7f00:1::1": "6to4", "64:ff9b::7f00:1": "nat64", "2606:4700:4700::1111": "public", "2001:4860:4860::8888": "public", "5000::1": "reserved" };
  for (const [ip, want] of Object.entries(table)) assert.equal(cls(ip), want, ip);
  assert.equal(cls("not-an-ip"), "invalid");
  assert.equal(isPublicIpLiteral("8.8.8.8"), true);
  assert.equal(isPublicIpLiteral("0x7f.1"), false);
  assert.equal(isPublicIpLiteral("::ffff:8.8.8.8"), false, "mapped addresses are never treated as plain public ones");
});

await check("glob: the write-area dialect", () => {
  const m = (glob: string, p: string) => globToRegExp(glob).test(p);
  assert.ok(m("src/**", "src/a/b.ts") && m("src/**", "src/x") && !m("src/**", "srcx/a"));
  assert.ok(m("**/*.md", "README.md") && m("**/*.md", "docs/a/b.md") && !m("**/*.md", "a.mdx"));
  assert.ok(m("*.json", "package.json") && !m("*.json", "a/package.json"));
  assert.ok(m("a?c", "abc") && !m("a?c", "a/c"));
  assert.ok(m("**", "anything/at/all") && m("**", ".hidden"));
  assert.ok(m("dist/**", "dist/index.html") && !m("dist/**", "distinct/x"));
  assert.ok(m("a.b", "a.b") && !m("a.b", "aXb"), "regex characters in a glob are literal");
  assert.deepEqual(pathsOutsideAreas(["src/a.ts", "package.json", "./tests/x.ts", ".github/w.yml"], ["src/**", "tests/**"]), ["package.json", ".github/w.yml"]);
  assert.equal(globProblem("src/**"), null);
  assert.match(globProblem("../x") ?? "", /\.\./);
});

// --- JSON Schema and the hand validator must agree ------------------------------------------
const schema: unknown = JSON.parse(fs.readFileSync(path.join(PKG, "schema", "run-contract.schema.json"), "utf8"));
assert.ok(isRecord(schema), "the run-contract schema is a JSON object");
const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);
const svc = { name: "web", image: "nginxinc/nginx-unprivileged:1.27-alpine", port: 8080, health: { path: "/" } };
const deployBase = { ...implementRaw({ permissions: { network: { serviceImages: [svc.image], services: [svc] } } }), template: "deploy" };
const selfBase = { schemaVersion: 1, run: "improve-1", template: "self-improve", objective: { title: "Improve" }, inputs: { repository: { path: "/repo", ref: "main" } }, acceptance: { checks: [{ id: "tests", run: ["npm", "test"] }] } };

/** A named contract document for the validator-agreement check. */
type Fixture = [name: string, document: object];

// [name, document, structural]: `structural` failures are ones JSON Schema can express, so both
// validators must reject them; the rest are semantic (cross-field, catalogue or filesystem
// rules) which only the hand validator applies.
const GOOD: Fixture[] = [["minimal implement", implementRaw()], ["deploy with a service", deployBase], ["self-improve", selfBase], ["everything set", implementRaw({ inputs: { repository: { url: "https://git.example.org/a.git", ref: "main" }, references: { docs: "/refs/docs" } }, permissions: { writeAreas: ["src/**"], network: { egress: [{ host: "registry.npmjs.org", ports: [443], plainGet: false }] }, credentials: { names: ["NPM_TOKEN"] }, outputs: { destinations: [{ kind: "export-dir", path: "/tmp/out" }] }, unattended: { authorised: true, autoApprove: false } }, model: { provider: "openrouter", worker: "a/b", manager: "a/b", review: "a/c", extra: ["a/d"] }, effort: { tier: "E3", cap: "E4" }, budget: { totalUsd: 3, perStepUsd: 1, maxSteps: 5, maxMinutes: 60 }, recovery: { softNudges: 1, hardRestarts: 1, maxAttemptsPerStep: 3 }, generations: { enabled: true, iterationMinutes: 20, iterationUsd: 1, maxGenerations: 3, graceMinutes: 2, resetOnNoProgress: true, notebookMaxChars: 4000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/a.git", branch: "pi/x", tags: true }], requiresOperatorApproval: true }, authorisation: { boundaryDigest: "c".repeat(64), by: "operator", at: "2026-09-30T00:00:00Z" } })]];
const BAD_STRUCTURAL: Fixture[] = [
  ["unknown top-level key", { ...implementRaw(), extra: 1 }], ["schemaVersion 2", { ...implementRaw(), schemaVersion: 2 }], ["missing run", (() => { const d: Partial<ReturnType<typeof implementRaw>> = implementRaw(); delete d.run; return d; })()],
  ["bad run id", { ...implementRaw(), run: "X" }], ["bad template", { ...implementRaw(), template: "x" }], ["objective without title", implementRaw({ objective: { spec: "s" } })],
  ["spec and specFile", implementRaw({ objective: { title: "t", spec: "s", specFile: "f" } })],
  ["unknown key in permissions", implementRaw({ permissions: { admin: true } })], ["unknown key in network", implementRaw({ permissions: { network: { lan: true } } })],
  ["unknown key in unattended", implementRaw({ permissions: { unattended: { yolo: true } } })], ["unattended not boolean", implementRaw({ permissions: { unattended: { authorised: "true" } } })],
  ["egress not an array", implementRaw({ permissions: { network: { egress: {} } } })], ["egress port out of range", implementRaw({ permissions: { network: { egress: [{ host: "a.example.org", ports: [70000] }] } } })],
  ["egress unknown key", implementRaw({ permissions: { network: { egress: [{ host: "a.example.org", wild: 1 }] } } })],
  ["credential name lower case", implementRaw({ permissions: { credentials: { names: ["npm_token"] } } })], ["credentials unknown key", implementRaw({ permissions: { credentials: { values: {} } } })],
  ["service unknown key", { ...deployBase, permissions: { network: { serviceImages: [svc.image], services: [{ ...svc, privileged: true }] } } }],
  ["service without health", { ...deployBase, permissions: { network: { serviceImages: [svc.image], services: [{ name: "web", image: svc.image, port: 80 }] } } }],
  ["promotion unknown key", implementRaw({ promotion: { policy: "none", force: true } })], ["promotion bad policy", implementRaw({ promotion: { policy: "yes" } })],
  ["push destination without branch", implementRaw({ promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/a.git" }] } })],
  ["authorisation unknown key", implementRaw({ authorisation: { boundaryDigest: "a".repeat(64), by: "x", at: "y", z: 1 } })], ["authorisation bad digest", implementRaw({ authorisation: { boundaryDigest: "short", by: "x", at: "y" } })],
  ["budget wrong type", implementRaw({ budget: { totalUsd: "ten" } })], ["maxSteps zero", implementRaw({ budget: { maxSteps: 0 } })], ["recovery negative", implementRaw({ recovery: { softNudges: -1 } })],
  ["generations unknown key", implementRaw({ generations: { enabled: true, relay: true } })], ["maxGenerations above 8", implementRaw({ generations: { enabled: true, maxGenerations: 9 } })],
  ["check without id", implementRaw({ acceptance: { checks: [{ run: ["x"] }] } })], ["check bad type", implementRaw({ acceptance: { checks: [{ id: "a", type: "magic" }] } })], ["check timeout too big", implementRaw({ acceptance: { checks: [{ id: "a", run: ["x"], timeoutMinutes: 9999 }] } })],
  ["backlog item without title", implementRaw({ objective: { title: "t", spec: "s", backlog: [{ id: "T1" }] } })], ["engine unknown", implementRaw({ runtime: { engine: "lxc" } })],
  ["provider unknown", implementRaw({ model: { provider: "mystery" } })], ["repository with neither path nor url", implementRaw({ inputs: { repository: { ref: "main" } } })], ["repository with both", implementRaw({ inputs: { repository: { path: "/a", url: "https://x.example.org/a.git" } } })],
  ["writeAreas empty", implementRaw({ permissions: { writeAreas: [] } })], ["outputs unknown kind", implementRaw({ permissions: { outputs: { destinations: [{ kind: "ftp", path: "/x" }] } } })],
];
const BAD_SEMANTIC: Fixture[] = [
  ["backlog names an undeclared check", implementRaw({ objective: { title: "t", spec: "s", backlog: [{ id: "T1", title: "x", acceptance: ["ghost"] }] } })],
  ["duplicate check ids", implementRaw({ acceptance: { checks: [{ id: "a", run: ["x"] }, { id: "a", run: ["y"] }] } })],
  ["effort tier does not exist", implementRaw({ effort: "E9" })], ["effort above its cap", implementRaw({ effort: { tier: "thorough", cap: "focused" } })],
  ["credential-shaped literal", implementRaw({ objective: { title: "t", spec: "key sk-or-v1-0123456789abcdef0123456789abcdef" } })],
  ["service image not in the allowlist", { ...deployBase, permissions: { network: { serviceImages: [], services: [svc] } } }],
  ["service image not pinned", { ...deployBase, permissions: { network: { serviceImages: ["nginx:latest"], services: [{ ...svc, image: "nginx:latest" }] } } }],
  ["egress to loopback", implementRaw({ permissions: { network: { egress: [{ host: "127.0.0.1", ports: [80] }] } } })], ["egress to a local name", implementRaw({ permissions: { network: { egress: [{ host: "db.internal", ports: [5432] }] } } })],
  ["write area escapes", implementRaw({ permissions: { writeAreas: ["../x"] } })], ["protected branch promotion", implementRaw({ promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/a.git", branch: "main" }] } })],
  ["autoApprove without authorised", implementRaw({ permissions: { unattended: { authorised: false, autoApprove: true } } })], ["finite task without a check", implementRaw({ acceptance: { checks: [] } })],
  ["generations box longer than the run", implementRaw({ budget: { totalUsd: 3, perStepUsd: 1, maxSteps: 5, maxMinutes: 20 }, generations: { enabled: true, iterationMinutes: 30 } })],
  ["self-improve without a repository", { ...selfBase, inputs: { repository: null } }], ["self-improve without a check", { ...selfBase, acceptance: undefined }], ["services outside deploy", implementRaw({ permissions: { network: { serviceImages: [svc.image], services: [svc] } } })],
];

await check("generations: off by default, every key validated, unknown keys refused, and a box can never raise the budget", () => {
  const off = contractOf(resolve(implementRaw()));
  assert.deepEqual(off.generations, { enabled: false, iterationMinutes: 30, iterationUsd: null, maxGenerations: 4, graceMinutes: 3, resetOnNoProgress: false, notebookMaxChars: 6000 }, "generations are off unless enabled");
  const budget = { totalUsd: 5, perStepUsd: 1, maxSteps: 20, maxMinutes: 120 };
  const on = (g: object, over: object = {}) => resolve(implementRaw({ budget, generations: { enabled: true, ...g }, ...over }));
  const g = contractOf(on({ iterationMinutes: 20, iterationUsd: 1.5, maxGenerations: 8, graceMinutes: 2, resetOnNoProgress: true, notebookMaxChars: 4000 })).generations;
  assert.deepEqual(g, { enabled: true, iterationMinutes: 20, iterationUsd: 1.5, maxGenerations: 8, graceMinutes: 2, resetOnNoProgress: true, notebookMaxChars: 4000 });
  const bad: Array<[object, string]> = [
    [{ iterationMinutes: 4 }, "generations.iterationMinutes"], [{ iterationMinutes: 241 }, "generations.iterationMinutes"], [{ iterationMinutes: 7.5 }, "generations.iterationMinutes"],
    [{ maxGenerations: 9 }, "generations.maxGenerations"], [{ maxGenerations: 0 }, "generations.maxGenerations"], [{ iterationUsd: 0 }, "generations.iterationUsd"],
    [{ graceMinutes: 0 }, "generations.graceMinutes"], [{ notebookMaxChars: 6001 }, "generations.notebookMaxChars"], [{ notebookMaxChars: 999 }, "generations.notebookMaxChars"],
    [{ enabled: "yes" }, "generations.enabled"], [{ resetOnNoProgress: 1 }, "generations.resetOnNoProgress"], [{ relay: true }, "generations.relay"],
  ];
  for (const [over, at] of bad) assert.ok(errorPaths(on(over)).includes(at), `${JSON.stringify(over)} is refused at ${at}`);
  // Cannot exceed the budget: no box may be larger than the limit it sits inside.
  const tooLong = on({ iterationMinutes: 121 }, { budget: { ...budget, maxMinutes: 120 } });
  assert.ok(errors(tooLong).some((p) => p.path === "generations.iterationMinutes" && /cannot raise the budget/.test(p.message)), formatProblems(tooLong.problems));
  const tooDear = on({ iterationUsd: 5.01 });
  assert.ok(errors(tooDear).some((p) => p.path === "generations.iterationUsd" && /cannot raise the budget/.test(p.message)), formatProblems(tooDear.problems));
  assert.ok(errorPaths(on({ iterationMinutes: 10, graceMinutes: 10 })).includes("generations.graceMinutes"), "the grace period fits inside the box");
  assert.equal(resolve(implementRaw({ budget: { ...budget, maxMinutes: 10 } })).ok, true, "a disabled block is not held to the budget, so small runs keep resolving");
  assert.ok(errorPaths(resolve({ schemaVersion: 1, run: "improve-1", template: "self-improve", objective: { title: "Improve" }, inputs: { repository: { path: "/repo", ref: "main" } }, acceptance: { checks: [{ id: "tests", run: ["npm", "test"] }] }, generations: { enabled: true } })).includes("generations.enabled"), "self-improve drives its own cycles");
});

await check("resource limits: a zero --memory or --cpus (no limit, to the container engines) is refused when the contract is resolved", () => {
  const ZERO = /above zero.*the container engines read 0 as no limit/;
  const refused = (r: Resolution, at: string) => { assert.equal(r.ok, false, `${at} must be refused`); assert.ok(errors(r).some((p) => p.path === at && ZERO.test(p.message)), `${at}: ${formatProblems(r.problems)}`); };
  for (const memory of ["0", "0g", "000m"]) refused(resolve(implementRaw({ runtime: { memory } })), "runtime.memory");
  for (const cpus of ["0", "0.0", 0]) refused(resolve(implementRaw({ runtime: { cpus } })), "runtime.cpus");
  for (const [memory, cpus] of [["-1g", "4"], ["6g", "-2"], ["lots", "4"]]) assert.equal(resolve(implementRaw({ runtime: { memory, cpus } })).ok, false, `runtime ${memory}/${cpus} is malformed`);
  const ok = resolve(implementRaw({ runtime: { memory: "512m", cpus: "0.5" } }));
  assert.equal(ok.ok, true, formatProblems(ok.problems));
  const service = (extra: object) => resolve({ ...deployBase, permissions: { network: { serviceImages: [svc.image], services: [{ ...svc, ...extra }] } } });
  assert.equal(service({ memory: "256m", cpus: "1" }).ok, true);
  refused(service({ memory: "0" }), "permissions.network.services[0].memory");
  refused(service({ cpus: "0" }), "permissions.network.services[0].cpus");
  const gate = (g: unknown) => resolve({ ...selfBase, promotion: { policy: "none" }, templateOptions: { gate: g } });
  assert.equal(gate({ memory: "6g", cpus: "4" }).ok, true, formatProblems(gate({ memory: "6g", cpus: "4" }).problems));
  refused(gate({ memory: "0", cpus: "4" }), "templateOptions.gate.memory");
  refused(gate({ memory: "6g", cpus: "0" }), "templateOptions.gate.cpus");
  refused(gate({ memory: "6g", cpus: 0 }), "templateOptions.gate.cpus");
  refused(gate({ memory: "-1g" }), "templateOptions.gate.memory");
  assert.ok(errorPaths(gate("big")).includes("templateOptions.gate"), "the gate is an object");
  const legacy = resolve({ run: "perpetual-test", cycles: 3, gitRemote: "https://git.example.org/team/repo.git", promotion: "none", container: { memory: "0" } });
  assert.ok(errorPaths(legacy).includes("templateOptions.gate.memory"), `a v0 container memory of 0 is refused too: ${formatProblems(legacy.problems)}`);
});

await check("JSON Schema (ajv) and the hand validator agree on good and structurally bad documents; semantic rules are the hand validator's", () => {
  for (const [name, doc] of GOOD) {
    const hand = resolve(doc);
    assert.equal(hand.ok, true, `hand validator rejected good fixture "${name}": ${formatProblems(hand.problems)}`);
    assert.equal(validateSchema(doc), true, `schema rejected good fixture "${name}": ${JSON.stringify(validateSchema.errors)}`);
  }
  for (const [name, doc] of BAD_STRUCTURAL) {
    assert.equal(resolve(doc).ok, false, `hand validator accepted bad fixture "${name}"`);
    assert.equal(validateSchema(doc), false, `schema accepted bad fixture "${name}"`);
  }
  for (const [name, doc] of BAD_SEMANTIC) {
    assert.equal(resolve(doc).ok, false, `hand validator accepted semantically bad fixture "${name}"`);
  }
  assert.ok(GOOD.length >= 4 && BAD_STRUCTURAL.length >= 30 && BAD_SEMANTIC.length >= 12);
});

await check("the shipped examples validate (hand validator and schema) and carry no private host or credential", () => {
  const dir = path.join(PKG, "examples");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["deploy.json", "implement.json", "self-improve.json"]);
  const seen = new Set<string>();
  for (const file of [...files.map((f) => path.join(dir, f)), path.join(PKG, "run.example.json")]) {
    const text = fs.readFileSync(file, "utf8");
    const doc: unknown = JSON.parse(text);
    assert.ok(isRecord(doc), `${path.basename(file)} is a JSON object`);
    const r = resolve(doc, { baseDir: path.dirname(file), checkFs: file.includes(`${path.sep}implement.json`) || file.includes(`${path.sep}deploy.json`) });
    assert.equal(r.ok, true, `${path.basename(file)}: ${formatProblems(r.problems)}`);
    assert.equal(r.legacy, false, `${path.basename(file)} must be a schemaVersion 1 contract`);
    assert.equal(validateSchema(doc), true, `${path.basename(file)} vs schema: ${JSON.stringify(validateSchema.errors)}`);
    assert.doesNotMatch(text, /gitlab|home\.internal|\.local\b|openrouter\.ai\/api\/v1/i, "no private hostname");
    seen.add(contractOf(r).template);
  }
  assert.deepEqual([...seen].sort(), ["deploy", "implement", "self-improve"]);
  const implRaw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "implement.json"), "utf8"));
  assert.ok(isRecord(implRaw), "implement.json is a JSON object");
  const impl = resolve(implRaw, { baseDir: dir });
  const implContract = contractOf(impl);
  // The inferred contract type does not know the fields a specFile and an overlay add.
  const objective: { spec: string; specSha256?: string } = implContract.objective;
  const overlay: { source: string; target: string }[] = implContract.acceptance.overlay;
  assert.match(objective.spec, /Todo API/, "specFile is read and inlined");
  assert.ok(objective.specSha256);
  assert.ok(overlay[0], "the example declares an overlay");
  assert.ok(overlay[0].source.startsWith(dir), "overlay sources resolve against the contract's folder");
});

done();
