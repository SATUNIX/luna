#!/usr/bin/env node
/**
 * Offline checks for the resolved boundary and the containment of every container the
 * supervisor starts: the boundary digest and its rendering, the start/authorisation decision,
 * the worker environment contract, and table-driven positive AND negative tests over the
 * container argument builders (lib/docker.ts) and the containment validator
 * (lib/containment.ts): non-root, read-only rootfs, all capabilities dropped, no-new-privileges,
 * resource limits, internal network only, no privileged mode, no host namespaces, no engine
 * socket, no home or credential store, no credentials in argv or environment. No Docker needed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, homeExposure, implementRaw, makeChecker, testEffort, type RawContract } from "./autonomy-helpers.ts";
import type { RunContract } from "./autonomy-harness.ts";
import type * as UnattendedModule from "../packages/extensions/src/tool-firewall/unattended.ts";
import { loadModule } from "../packages/core/eval/harness.ts";
import { resolveContract, workerContract } from "../packages/autonomy/lib/contract.ts";
import { authorisationStatus, boundaryDigest, boundaryFields, decideStart, renderBoundary } from "../packages/autonomy/lib/boundary.ts";
import { WORKER_CONTRACT_PATH, workerEnv } from "../packages/autonomy/lib/worker-env.ts";
import { runtimeConfig } from "../packages/autonomy/lib/runcfg.ts";
import { runPaths } from "../packages/autonomy/lib/paths.ts";
import * as dk from "../packages/autonomy/lib/docker.ts";
import { assertRunArgs, inspectRunArgs } from "../packages/autonomy/lib/containment.ts";
import { DockerRuntime, limitProblems } from "../packages/autonomy/lib/runtime.ts";
import { RunStore } from "../packages/autonomy/lib/store.ts";

const { check, done } = makeChecker("autonomy-boundary-smoke");
const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "autonomy");
/** One container builder under test: its arguments and what the validator is told about it. */
interface Builder {
  args: string[];
  networks: string[];
  role: string;
  secretEnvNames?: string[];
}

type ContractChange = (c: RunContract) => void;

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object";
/** The element of `xs` at `i`, asserting it exists. */
const at = <T>(xs: readonly T[], i: number, what: string): T => { const x = xs[i]; assert.ok(x !== undefined, what); return x; };

// contract.ts's inferred contract type is incomplete (see RunContract) and not comparable to the documented
// shape, so the resolved contract is widened to `object` and typed at this boundary.
const resolve = (raw: RawContract): RunContract => {
  const r = resolveContract(raw, { effort: testEffort });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(r.contract, "resolved"); // narrows; never fails after the check above
  const contract: object = r.contract;
  return contract as RunContract;
};

// worker-env.ts adds the egress, unattended and rootless keys conditionally, so its inferred return type lacks them.
const workerEnvOf: (contract: RunContract, o: { branch: string; reset?: boolean; effort?: { tier: string; cap: string } }) => Record<string, string> = workerEnv;

/** The message of a refused start decision. */
const refusalMessage = (d: ReturnType<typeof decideStart>): string => { assert.ok(typeof d.message === "string", "the decision carries a message"); return d.message; };
const NET = { egress: [{ host: "registry.npmjs.org", ports: [443] }] };
const svc = { name: "web", image: "nginxinc/nginx-unprivileged:1.27-alpine", port: 8080, workspaceMounts: [{ source: "dist", target: "/usr/share/nginx/html" }], tmpfs: ["/tmp"], credentialEnv: { API_SECRET: "WEB_SECRET" }, env: { MODE: "test" }, health: { path: "/" } };
// An explicit non-root uid:gid, so the suite behaves the same whichever user runs it (with user "host" a root-run supervisor is refused, correctly).
const RUNTIME = { user: "10001:10001" };
const base = resolve(implementRaw({ permissions: { network: NET, credentials: { names: [] }, unattended: { authorised: true, autoApprove: true } }, effort: "E3", runtime: RUNTIME }));
const deployContract = resolve({ ...implementRaw({ permissions: { network: { ...NET, serviceImages: [svc.image], services: [svc] }, credentials: { names: ["WEB_SECRET"] }, unattended: { authorised: true, autoApprove: true } }, runtime: RUNTIME }), template: "deploy" });

await check("digest: covers the security-relevant fields only, is stable, and changes with every one of them", () => {
  const d = boundaryDigest(base);
  assert.match(d, /^[a-f0-9]{64}$/);
  assert.equal(boundaryDigest(structuredClone(base)), d, "stable");
  const reverseKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(reverseKeys) : isRecord(v) ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])])) : v);
  const reordered = reverseKeys(base);
  assert.equal(boundaryDigest(reordered as RunContract), d, "independent of key order");
  const same = (mut: ContractChange): string => { const c = structuredClone(base); mut(c); return boundaryDigest(c); };
  // Not part of the boundary: what the task is called and described, and which run this is.
  for (const mut of [(c: RunContract) => { c.run = "another-run-9"; }, (c: RunContract) => { c.objective.title = "Other"; }, (c: RunContract) => { c.objective.spec = "Different spec."; }, (c: RunContract) => { c.objective.backlog.push({ id: "T9", title: "x" }); }, (c: RunContract) => { c.authorisation = { boundaryDigest: "a".repeat(64), by: "x", at: "y" }; }, (c: RunContract) => { c.runtime.mirrorSeconds = 5; }]) assert.equal(same(mut), d);
  // Part of it: anything that changes what the run may touch, spend, run or promote.
  const changes: ContractChange[] = [
    (c) => { c.permissions.network.egress.push({ host: "example.org", ports: [443], plainGet: false }); },
    (c) => { at(c.permissions.network.egress, 0, "an egress rule").ports = [443, 80]; },
    (c) => { c.permissions.writeAreas = ["src/**"]; },
    (c) => { c.permissions.credentials.names = ["X_TOKEN"]; },
    (c) => { c.permissions.unattended.autoApprove = false; },
    (c) => { c.permissions.unattended.authorised = false; c.permissions.unattended.autoApprove = false; },
    (c) => { c.permissions.outputs.destinations = [{ kind: "export-dir", path: "/tmp/out" }]; },
    (c) => { c.promotion = { policy: "push", requiresOperatorApproval: false, destinations: [{ kind: "git-remote", url: "https://git.example.org/a.git", branch: "pi/x", tags: false }] }; },
    (c) => { c.promotion.requiresOperatorApproval = false; },
    (c) => { c.model.worker = "other/model"; },
    (c) => { c.model.provider = "openai-compatible"; },
    (c) => { c.providerSettings.upstream = "https://llm.example.org/v1"; },
    (c) => { c.providerSettings.apiKeyEnv = "OTHER_API_KEY"; },
    (c) => { c.providerSettings.authName = "another-login"; }, // which pi login the relay may send, and
    (c) => { c.providerSettings.headers = { "X-Team": "a" }; }, // which extra headers it adds, are part of where a credential goes
    (c) => { c.effort = { tier: "thorough", cap: "thorough" }; },
    (c) => { c.effort.cap = "exhaustive"; },
    (c) => { c.budget.totalUsd += 1; },
    (c) => { c.budget.maxMinutes += 1; },
    (c) => { c.recovery.hardRestarts += 1; },
    (c) => { c.runtime.image = "pi-autonomy:other"; },
    (c) => { c.runtime.memory = "12g"; },
    (c) => { c.runtime.user = "0:0"; },
    (c) => { at(c.acceptance.checks, 0, "an acceptance check").run = ["true"]; },
    (c) => { c.acceptance.review = false; },
    (c) => { c.inputs.references = { docs: "/refs/docs" }; },
    (c) => { c.inputs.repository = { path: "/repo", ref: "main" }; },
    (c) => { c.templateOptions = { anything: 1 }; },
  ];
  const seen = new Set([d]);
  for (const [i, mut] of changes.entries()) { const x = same(mut); assert.ok(!seen.has(x), `change #${i} must change the digest`); seen.add(x); }
  assert.deepEqual(Object.keys(boundaryFields(base)).sort(), ["acceptance", "boundaryVersion", "budget", "credentials", "effort", "filesystem", "inputs", "model", "network", "outputs", "process", "promotion", "recovery", "template", "templateOptions", "unattended"]);
  assert.equal(JSON.stringify(boundaryFields(base)).includes(base.objective.spec), false, "the specification is not part of the boundary");
});

await check("render: the effective boundary as readable text and JSON, with the digest, listing every dimension", () => {
  const r = renderBoundary(base, { effort: testEffort });
  const json = r.json;
  assert.equal(r.digest, boundaryDigest(base));
  assert.equal(json.digest, r.digest);
  assert.ok(json.boundary.network.egress.length === 1 && json.invariants.length >= 5);
  for (const word of ["Filesystem", "Network", "Credentials", "Processes and resources", "Unattended operation", "Outputs and promotion", "Model and effort", "Budget and recovery", "Completion", "registry.npmjs.org:443", "digest " + r.digest, "read-only", "no route off the host", "is never privileged"]) assert.ok(r.text.includes(word), `boundary text mentions ${word}`);
  assert.match(r.text, /promotion: none\. Nothing is pushed/);
  assert.match(r.text, /E3/);
  assert.match(r.text, /fixed when the run starts/);
  const none = renderBoundary(resolve(implementRaw({ permissions: {} })), { effort: testEffort }).text;
  assert.match(none, /egress: none/);
  assert.match(none, /run services: none/);
  assert.match(none, /not authorised: the worker's normal approval prompts apply/);
  const push = renderBoundary(resolve(implementRaw({ promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/a.git", branch: "pi/x" }] } })), { effort: testEffort }).text;
  assert.match(push, /PUSH to https:\/\/git\.example\.org\/a\.git \(pi\/x\); each push needs your approval/);
  const dep = renderBoundary(deployContract, { effort: testEffort }).text;
  assert.match(dep, /run services, started by the supervisor: web \(nginxinc\/nginx-unprivileged:1\.27-alpine, port 8080/);
  assert.match(dep, /WEB_SECRET.*given only to web/);
  assert.doesNotMatch(dep, /hunter2|sk-or/);
  // Which secret goes where, in words: the variable (or pi login) and the host the relay sends it to.
  assert.match(r.text, /inference key: the value of OPENROUTER_API_KEY in your environment, else your pi login "openrouter" is sent to openrouter\.ai by the relay/);
  const custom = renderBoundary(resolve(implementRaw({ model: { provider: "openai-compatible", worker: "org/model-a" }, providerSettings: { upstream: "https://llm.example.org/v1", apiKeyEnv: "LLM_EXAMPLE_KEY", headers: { "X-Team": "a" }, pricing: { "org/model-a": { inputPerMTok: 1, outputPerMTok: 2 } } } })), { effort: testEffort }).text;
  assert.match(custom, /inference key: the value of LLM_EXAMPLE_KEY in your environment is sent to llm\.example\.org by the relay/);
  assert.match(custom, /extra request headers to the provider: X-Team/);
  assert.doesNotMatch(custom, /pi login/, "a custom upstream never carries a pi login");
  // The user the containers run as is stated, and root is explained.
  assert.match(r.text, /user: 10001:10001/);
  assert.match(renderBoundary(resolve(implementRaw({ runtime: { user: "0:0", engine: "podman" } })), { effort: testEffort }).text, /user: 0:0, root INSIDE a rootless engine's user namespace only/);
  assert.match(renderBoundary(resolve(implementRaw({ runtime: { user: "host" } })), { effort: testEffort }).text, /user: your own uid:gid/);
});

await check("root inside a container is accepted only under an engine that reports itself rootless", async () => {
  const { engineIsRootless } = await import("../packages/autonomy/lib/docker.ts");
  assert.equal(engineIsRootless({ host: { security: { rootless: true } } }), true, "podman info");
  assert.equal(engineIsRootless({ host: { security: { rootless: false } } }), false);
  assert.equal(engineIsRootless({ SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"] }), true, "docker info");
  assert.equal(engineIsRootless({ SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"] }), false, "a rootful docker");
  for (const nothing of [null, undefined, "rootless", 7, {}, { SecurityOptions: "name=rootless" }, { host: {} }, { SecurityOptions: ["name=rootlesskit-not"] }]) assert.equal(engineIsRootless(nothing), false, `${JSON.stringify(nothing)} proves nothing`);
});

await check("start authorisation: an authorised contract starts unprompted; a mismatch is refused; without consent a flag alone is not enough", () => {
  const digest = boundaryDigest(base);
  const authorised = { ...base, authorisation: { boundaryDigest: digest, by: "alice", at: "2026-09-30T00:00:00Z" } };
  assert.deepEqual(authorisationStatus(base, digest), { status: "missing" });
  assert.equal(authorisationStatus(authorised, digest).status, "authorised");
  const cases: Array<[string, { contract: RunContract; isTTY: boolean; yes?: boolean }, string, string | undefined]> = [
    ["authorised, no TTY, no --yes", { contract: authorised, isTTY: false, yes: false }, "start", "contract"],
    ["authorised, no TTY, --yes", { contract: authorised, isTTY: false, yes: true }, "start", "contract"],
    ["authorised, TTY", { contract: authorised, isTTY: true }, "start", "contract"],
    ["unauthorised, TTY", { contract: base, isTTY: true, yes: false }, "confirm", undefined],
    ["unauthorised, TTY, --yes (a person is present)", { contract: base, isTTY: true, yes: true }, "start", "tty-yes"],
    ["unauthorised, no TTY, --yes", { contract: base, isTTY: false, yes: true }, "refuse", "authorisation_required"],
    ["unauthorised, no TTY", { contract: base, isTTY: false, yes: false }, "refuse", "authorisation_required"],
  ];
  for (const [name, input, action, extra] of cases) {
    const d = decideStart({ digest, ...input });
    assert.equal(d.action, action, name);
    if (action === "start") assert.equal(d.via, extra, name);
    if (action === "refuse") assert.equal(d.code, extra, name);
  }
  const stale = { ...base, authorisation: { boundaryDigest: "0".repeat(64), by: "alice", at: "2026-09-30T00:00:00Z" } };
  for (const input of [{ isTTY: false, yes: true }, { isTTY: true, yes: true }, { isTTY: true, yes: false }]) {
    const d = decideStart({ contract: stale, digest, ...input });
    assert.equal(d.action, "refuse");
    assert.equal(d.code, "digest_mismatch", "a mismatch is refused even on a terminal, even with --yes");
    assert.match(d.message, /re-authorise with `plan --authorise`/);
    assert.match(d.message, /000000000000/);
  }
  assert.match(refusalMessage(decideStart({ contract: base, digest, isTTY: false, yes: true })), /--yes alone is not consent/);
  const widened = structuredClone(authorised);
  widened.permissions.network.egress.push({ host: "example.org", ports: [443], plainGet: false });
  assert.equal(decideStart({ contract: widened, digest: boundaryDigest(widened), isTTY: false, yes: true }).code, "digest_mismatch", "widening an authorised contract invalidates its authorisation");
});

await check("worker environment: ONE function, exact names, unattended only when authorised, effort from the snapshot, no credentials", () => {
  const env = workerEnv(base, { branch: "pi/todo-api-1", reset: true });
  assert.deepEqual(env, {
    RUN_ID: "todo-api-1", RUN_BRANCH: "pi/todo-api-1", PI_MODEL: "deepseek/deepseek-v4.1-flash", PI_PROVIDER: "openrouter", CYCLE_RESET: "1", GIT_NAME: "pi autonomy", GIT_EMAIL: "pi-autonomy@localhost",
    PI_KIT_EFFORT: "standard", PI_KIT_EFFORT_CAP: "standard",
    PI_KIT_UNATTENDED: "1", PI_KIT_UNATTENDED_BOUNDARY: "container", PI_KIT_UNATTENDED_CONTRACT: "/run/contract.json",
    AUTONOMY_EGRESS: "1", HTTPS_PROXY: "http://egress-proxy:3128", HTTP_PROXY: "http://egress-proxy:3128", https_proxy: "http://egress-proxy:3128", http_proxy: "http://egress-proxy:3128",
    NO_PROXY: "inference,egress-proxy,localhost,127.0.0.1", no_proxy: "inference,egress-proxy,localhost,127.0.0.1",
  });
  assert.equal(WORKER_CONTRACT_PATH, "/run/contract.json");
  assert.deepEqual(Object.keys(workerEnv(base, { branch: "b" })), Object.keys(env), "a stable key order");
  const attended = workerEnv(resolve(implementRaw({ permissions: {} })), { branch: "b" });
  for (const k of ["PI_KIT_UNATTENDED", "PI_KIT_UNATTENDED_BOUNDARY", "PI_KIT_UNATTENDED_CONTRACT", "HTTPS_PROXY", "AUTONOMY_EGRESS"]) assert.equal(k in attended, false, `${k} is absent when not authorised / no egress`);
  assert.equal(attended.PI_KIT_EFFORT, "standard", "effort is always set");
  assert.deepEqual([workerEnv(base, { branch: "b", effort: { tier: "focused", cap: "thorough" } }).PI_KIT_EFFORT, workerEnv(base, { branch: "b", effort: { tier: "focused", cap: "thorough" } }).PI_KIT_EFFORT_CAP], ["focused", "thorough"], "the run's snapshot wins over the contract");
  assert.equal(workerEnvOf(deployContract, { branch: "b" }).NO_PROXY, "inference,egress-proxy,localhost,127.0.0.1,web", "services are reached directly, by name");
  assert.equal(workerEnvOf({ ...base, runtime: { ...base.runtime, user: "0:0" } }, { branch: "b" }).AUTONOMY_ROOTLESS, "1");
  const all = JSON.stringify(workerEnv(deployContract, { branch: "b" }));
  assert.doesNotMatch(all, /(_KEY|TOKEN|SECRET|PASSW|sk-or|glpat)/i);
});

// The supervisor writes the worker's contract and environment; the worker's tool firewall reads them to enter
// unattended mode. Each side has its own suite, so this one feeds the REAL output of the one to the REAL reader of
// the other: a run whose contract the firewall rejects would silently run with the normal (prompting) rules.
await check("the worker's contract and environment, as the supervisor writes them, put the real firewall into unattended mode", async () => {
  const { evaluateUnattended } = await loadModule<typeof UnattendedModule>("extensions/tool-firewall/unattended.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-worker-contract-"));
  const digest = boundaryDigest(deployContract);
  try {
    const file = path.join(dir, "contract.json");
    fs.writeFileSync(file, `${JSON.stringify(workerContract(deployContract, { boundaryDigest: digest }))}\n`, { mode: 0o444 });
    // The supervisor mounts /run read-only: present the file that way (the OS's mount table is the reader's real input).
    // ...and the worker runs in the container's own user and mount namespaces, those of its PID 1.
    const ns = { user: "user:[4026531837]", mnt: "mnt:[4026531841]" };
    const io = { mountinfo: () => `1 0 0:1 / ${fs.realpathSync(dir)} ro,relatime - tmpfs tmpfs ro`, namespaces: () => ({ self: ns, init: ns, uidMap: "0 0 4294967295" }) };
    const env = { ...workerEnv(deployContract, { branch: "pi/x" }), PI_KIT_UNATTENDED_CONTRACT: file };
    const evaluate = (over = {}) => evaluateUnattended({ env: { ...env, ...over }, workspace: "/work", cwd: "/work", agentDir: "/state/agent", policy: "coding", io });
    const st = evaluate();
    assert.equal(st.active, true, `the firewall accepts the supervisor's contract: ${st.warnings.join("; ")}`);
    assert.equal(st.autoApprove, true, "autoApprove follows permissions.unattended");
    assert.equal(st.boundary, "container");
    assert.equal(st.boundaryDigest, digest, "the authorised boundary digest reaches the worker");
    assert.deepEqual(st.egress, ["registry.npmjs.org", "web"], "the allowed egress hosts and the run's services by name");
    assert.deepEqual(st.remotes, ["origin"], "the worker pushes to its own bare repository only");
    assert.deepEqual(st.warnings, [], "nothing was ignored");
    // Without the supervisor's authorisation the environment is absent and so is the mode.
    const unauthorised = resolve(implementRaw({ permissions: { network: NET, unattended: { authorised: false, autoApprove: false } }, runtime: RUNTIME }));
    assert.equal("PI_KIT_UNATTENDED" in workerEnv(unauthorised, { branch: "b" }), false);
    const off = path.join(dir, "off.json");
    fs.writeFileSync(off, JSON.stringify(workerContract(unauthorised, { boundaryDigest: digest })), { mode: 0o444 });
    assert.equal(evaluate({ PI_KIT_UNATTENDED_CONTRACT: off }).active, false, "a contract that does not authorise it never enters the mode");
    assert.match(at(evaluate({ PI_KIT_UNATTENDED_CONTRACT: off }).warnings, 0, "a warning"), /does not authorise unattended operation/);
    // A worker contract written without the digest (an old supervisor) is refused, not half-accepted.
    const nodigest = path.join(dir, "nodigest.json");
    fs.writeFileSync(nodigest, JSON.stringify(workerContract(deployContract)), { mode: 0o444 });
    assert.match(at(evaluate({ PI_KIT_UNATTENDED_CONTRACT: nodigest }).warnings, 0, "a warning"), /no boundaryDigest/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- container arguments ------------------------------------------------------------------------
const home = path.join(os.tmpdir(), "autonomy-boundary-home");
const cfg = runtimeConfig(deployContract, { namePrefix: "pi-autonomy-test-unit" });
const cfgDocker = runtimeConfig({ ...deployContract, runtime: { ...deployContract.runtime, engine: "docker" } }, { namePrefix: "pi-autonomy-test-unit" });
const p = runPaths(cfg.run, home);
const N = dk.names(cfg);
const flag = (args: readonly string[], f: string): string[] => args.flatMap((a, i) => (a === f ? [at(args, i + 1, `${f} has a value`)] : []));
const web = dk.serviceRunArgs(cfg, p, at(deployContract.permissions.network.services, 0, "the deploy contract has a service"));
const builders = {
  worker: { args: dk.agentRunArgs(cfg, p, { n: 3, attempt: 1, reset: true, effort: undefined }), networks: [N.net], role: "worker" },
  relay: { args: dk.relayRunArgs(cfg, p, path.join(PKG, "relay.ts")), networks: [N.egress], role: "relay" },
  proxy: { args: dk.proxyRunArgs(cfg, p, { script: path.join(PKG, "lib", "egress-proxy.ts"), netaddr: path.join(PKG, "lib", "netaddr.ts") }), networks: [N.egress], role: "proxy" },
  service: { args: web.args, networks: [N.net], role: "service", secretEnvNames: ["API_SECRET"] },
  bundle: { args: dk.bundleRunArgs(cfg, p), networks: [], role: "bundle" },
  snapshot: { args: dk.snapshotRunArgs(cfg, p, { message: "checkpoint" }), networks: [], role: "snapshot" },
  setref: { args: dk.setAgentRefRunArgs(cfg, p, { bundleFile: path.join(p.bundles, "b.bundle"), sha: "a".repeat(40) }), networks: [], role: "setref" },
  check: { args: dk.checkRunArgs(cfg, p, { bundleFile: path.join(p.bundles, "c.bundle"), sha: "a".repeat(40), checkId: "unit", runnerScript: path.join(PKG, "lib", "check-runner.ts"), hasOverlay: true }), networks: [], role: "check" },
  probe: { args: dk.healthProbeRunArgs(cfg, p, { url: "http://web:8080/", expectStatus: 200 }), networks: [N.net], role: "probe" },
  deploySync: { args: dk.deploySyncRunArgs(cfg, p, { service: "web", index: 0, source: "dist" }), networks: [], role: "deploy-sync" },
  workerDocker: { args: dk.agentRunArgs(cfgDocker, p, { n: 1, attempt: 1, reset: false, effort: undefined }), networks: [N.net], role: "worker" },
} satisfies Record<string, Builder>;
const roots = [p.root, PKG];
// docker.ts destructures agentRunArgs' options without defaults, so inference makes reset/effort required; they are passed as undefined.
const inspectOpts = (b: Builder) => ({ roots, networks: b.networks, role: b.role, secretEnvNames: b.secretEnvNames ?? [] });

await check("every container the supervisor starts is hardened, on the right network, and passes the containment validator", () => {
  for (const [name, b] of Object.entries<Builder>(builders)) {
    // containment.ts initialises facts.user to null, so inference types it as just `null`.
    const { problems, facts }: { problems: string[]; facts: { user: string | null } } = inspectRunArgs(b.args, inspectOpts(b));
    assert.deepEqual(problems, [], `${name}: ${problems.join("; ")}`);
    for (const f of ["--read-only", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--user"]) assert.ok(b.args.includes(f), `${name} has ${f}`);
    assert.deepEqual(flag(b.args, "--cap-drop"), ["ALL"], name);
    assert.deepEqual(flag(b.args, "--security-opt"), ["no-new-privileges:true"], name);
    assert.ok(facts.user !== null, `${name} has a user`); // narrows; a missing --user is already a problem above
    assert.notEqual(facts.user.split(":")[0], "0", `${name} does not run as root`);
    assert.ok(!b.args.includes("--privileged") && !b.args.some((a) => a.startsWith("--cap-add") || a.startsWith("--network=host") || a === "--pid" || a === "--ipc" || a === "--device"), name);
    assert.ok(!b.args.join(" ").includes("docker.sock") && !b.args.join(" ").includes("/.ssh"), name);
    assert.deepEqual(homeExposure(b.args), [], `${name} must not mount the operator's home or its credential directories`);
    assert.deepEqual(flag(b.args, "--label").filter((l) => l.startsWith("pi-autonomy.run=")), [`pi-autonomy.run=${cfg.run}`], `${name} is labelled with its run for orphan cleanup`);
    assert.ok(b.args.includes(`pi-autonomy.role=${b.role === "deploy-sync" ? "helper" : b.role}`) || b.role === "deploy-sync" || b.role === "bundle" || b.role === "snapshot" || b.role === "setref", `${name} role label`);
  }
  assert.ok(builders.worker.args.includes("--userns=keep-id") && !builders.workerDocker.args.includes("--userns=keep-id"), "keep-id is podman's");
  assert.equal(assertRunArgs(builders.worker.args, inspectOpts(builders.worker)).image, cfg.image);
});

await check("the home-exposure check detects the operator's home, its parents and its credential directories, and ignores a run directory beneath it", () => {
  const home = "/home/operator";
  const mount = (source: string): string[] => ["--mount", `type=bind,source=${source},target=/x`];
  for (const source of [home, "/home", "/", `${home}/.ssh`, `${home}/.pi/agent`, `${home}/.aws/credentials`]) assert.equal(homeExposure(mount(source), home).length, 1, source);
  for (const source of [`${home}/work/_temp/autonomy-run`, "/var/lib/pi-autonomy/run-1", `${home}-other/run`]) assert.deepEqual(homeExposure(mount(source), home), [], source);
  assert.equal(homeExposure(["-v", "/a:/b"], home).length, 1, "the short volume flag is refused outright");
});

await check("network placement: workers, services and probes on the internal network only; relay and proxy on the egress network; helpers on none", () => {
  assert.deepEqual(flag(builders.worker.args, "--network"), [N.net]);
  assert.deepEqual(flag(builders.service.args, "--network"), [N.net]);
  assert.deepEqual(flag(builders.probe.args, "--network"), [N.net]);
  assert.deepEqual(flag(builders.relay.args, "--network"), [N.egress], "the relay joins the run network only by alias, after start");
  assert.deepEqual(flag(builders.proxy.args, "--network"), [N.egress]);
  for (const k of ["bundle", "snapshot", "setref", "check", "deploySync"] as const) assert.deepEqual(flag(builders[k].args, "--network"), ["none"], k);
  const [internal, egress] = dk.networkCreateArgs(cfg);
  assert.ok(internal && egress, "podman: an internal and an outward network");
  assert.deepEqual(internal, ["network", "create", "--internal", N.net], "podman: nothing extra (its internal network is checked by the probe's canary)");
  // Docker's internal network stops forwarding, but the host still answers on the bridge's own address; without an address on the bridge there is no host to reach.
  const dockerNets = dk.networkCreateArgs(cfgDocker);
  assert.deepEqual(dockerNets[0], ["network", "create", "--internal", "--opt", "com.docker.network.bridge.inhibit_ipv4=true", N.net]);
  assert.equal(dk.HOSTLESS_OPTION, "com.docker.network.bridge.inhibit_ipv4");
  const dockerEgress = at(dockerNets, 1, "docker: an outward network");
  assert.ok(!dockerEgress.includes("--internal") && !dockerEgress.includes("--opt"), "the outward network is an ordinary bridge");
  assert.equal(egress.at(-1), N.egress);
  assert.ok(!egress.includes("--internal"));
  assert.deepEqual(flag(builders.service.args, "--network-alias"), ["web"], "workers reach services by name");
  assert.deepEqual(dk.relayExecArgs(cfg), ["exec", "-i", N.relay, "node", "/relay.ts"]);
  assert.deepEqual(dk.proxyExecArgs(cfg), ["exec", "-i", N.proxy, "node", "/proxy/egress-proxy.ts"]);
  assert.ok(N.net.startsWith("pi-autonomy-test-unit") && N.relay.startsWith("pi-autonomy-test-unit") && N.service("web").startsWith("pi-autonomy-test-unit"), "test runs never share names with real runs");
  assert.equal(dk.names(runtimeConfig(deployContract)).net, "pi-exp-todo-api-1");
});

await check("mounts: the worker gets its bare repo, workspace, state and the sanitised contract (read-only); nothing else; helpers read what they must read-only", () => {
  // A bare option ("readonly") has no value; only its presence is tested.
  const mounts = (args: string[]): Array<Record<string, string | undefined>> => flag(args, "--mount").map((m) => Object.fromEntries(m.split(",").map((kv): [string, string | undefined] => { const [k = "", v] = kv.split("="); return [k, v]; })));
  const w = mounts(builders.worker.args);
  assert.deepEqual(w.map((m) => m.target), ["/git/remote.git", "/work", "/state", "/run"]);
  assert.deepEqual(w.filter((m) => "readonly" in m).map((m) => m.target), ["/run"]);
  assert.equal(at(w, 3, "the worker has a /run mount").source, p.public);
  assert.equal(flag(builders.worker.args, "--env").some((e) => /^(OPENROUTER|API|.*KEY|.*TOKEN|.*SECRET)/.test(e) && !e.startsWith("PI_KIT")), false);
  const refCfg = runtimeConfig(resolve({ ...implementRaw({ inputs: { references: { docs: "/src/docs" } } }) }), { namePrefix: "pi-autonomy-test-unit" });
  const refArgs = dk.agentRunArgs(refCfg, { ...p, references: path.join(p.root, "references") }, { n: 1, attempt: 1, reset: undefined, effort: undefined });
  assert.ok(refArgs.includes(`type=bind,source=${path.join(p.root, "references")}/docs,target=/reference/docs,readonly`), "references are snapshots, mounted read-only");
  assert.ok(!refArgs.join(" ").includes("/src/docs"), "the live reference repository is never mounted");
  const b = mounts(builders.bundle.args);
  assert.deepEqual(b.map((m) => [m.target, "readonly" in m]), [["/git/remote.git", true], ["/out", false]], "bundling reads the worker's repo read-only");
  const c = mounts(builders.check.args);
  assert.deepEqual(c.map((m) => [m.target, "readonly" in m]), [["/in/branch.bundle", true], ["/run/checks.json", true], ["/gate", false], ["/check-runner.ts", true], ["/overlay", true]], "a check sees a bundle, its definitions and the held-out overlay read-only, and a scratch directory; not the worker's workspace");
  assert.equal(c.some((m) => m.source === p.work || m.source === p.remote || m.source === p.agentState), false);
  assert.equal(mounts(dk.checkRunArgs(cfg, p, { bundleFile: "/x/b", sha: "a".repeat(40), checkId: "u", runnerScript: "/x/r.mjs", hasOverlay: false })).some((m) => m.target === "/overlay"), false);
  assert.deepEqual(flag(builders.check.args, "--env").sort(), [`CHECK_BRANCH=${cfg.branch}`, "CHECK_ID=unit", `CHECK_SHA=${"a".repeat(40)}`, "CI=1"], "a clean environment: nothing from the operator's shell");
  const d = mounts(builders.deploySync.args);
  assert.deepEqual(d.map((m) => [m.target, "readonly" in m]), [["/work", true], ["/out", false]], "deploy-sync reads the workspace read-only and writes a host-owned staging directory");
  assert.equal(at(d, 1, "deploy-sync has an /out mount").source, dk.deployDir(p, "web", 0));
  const s = mounts(builders.service.args);
  assert.deepEqual(s.map((m) => [m.target, "readonly" in m, m.source]), [["/usr/share/nginx/html", true, dk.deployDir(p, "web", 0)]], "a service serves a read-only, host-owned copy, never the worker's own directory");
  const proxyM = mounts(builders.proxy.args).map((m) => m.target);
  assert.deepEqual(proxyM, ["/proxy/egress-proxy.ts", "/proxy/netaddr.ts", "/audit"]);
  assert.deepEqual(mounts(builders.relay.args).map((m) => m.target), ["/relay.ts", "/meter"]);
});

await check("service credentials travel by NAME only: never in the argument list, the environment flag carries no value", () => {
  assert.deepEqual(web.secretEnv, { API_SECRET: "WEB_SECRET" });
  const env = flag(web.args, "--env");
  assert.ok(env.includes("API_SECRET") && env.includes("MODE=test"));
  assert.ok(!env.some((e) => e.startsWith("API_SECRET=")));
  assert.ok(!web.args.join(" ").includes("WEB_SECRET"), "not even the credential's name in the arguments");
  assert.equal(assertRunArgs(web.args, inspectOpts({ ...builders.service })).role, "service");
  assert.throws(() => assertRunArgs(web.args, { roots, networks: [N.net], role: "service" }), /inherited from the supervisor without being declared/, "an undeclared inherited variable is refused");
});

/** A negative case: the builder's arguments weakened one way, and the problem the validator must report. */
interface NegativeCase {
  name: string;
  args: string[];
  expectRe: RegExp;
  b: Builder;
}

const mutate = (name: string, fn: (args: string[]) => string[], expectRe: RegExp, b: Builder = builders.worker): NegativeCase => ({ name, args: fn([...b.args]), expectRe, b });
const insertBeforeImage = (extra: string[]) => (args: string[]): string[] => { const i = args.lastIndexOf(cfg.image); return [...args.slice(0, i), ...extra, ...args.slice(i)]; };
const replaceFlag = (f: string, value: string) => (args: string[]): string[] => { const i = args.indexOf(f); args[i + 1] = value; return args; };
const dropFlag = (f: string, hasValue = true) => (args: string[]): string[] => { const i = args.indexOf(f); args.splice(i, hasValue ? 2 : 1); return args; };
const NEGATIVE = [
  mutate("privileged mode", insertBeforeImage(["--privileged"]), /--privileged/),
  mutate("added capability", insertBeforeImage(["--cap-add", "SYS_ADMIN"]), /--cap-add SYS_ADMIN/),
  mutate("host network", replaceFlag("--network", "host"), /--network host/),
  mutate("default bridge", replaceFlag("--network", "bridge"), /--network bridge/),
  mutate("another network", replaceFlag("--network", "some-lan"), /not one of this container's networks/),
  mutate("container network", replaceFlag("--network", "container:other"), /--network container:other/),
  mutate("second network at start", insertBeforeImage(["--network", N.egress]), /more than one --network/),
  mutate("host pid namespace", insertBeforeImage(["--pid", "host"]), /--pid host/),
  mutate("host ipc namespace", insertBeforeImage(["--ipc=host"]), /--ipc host/),
  mutate("host uts namespace", insertBeforeImage(["--uts", "host"]), /--uts host/),
  mutate("device passthrough", insertBeforeImage(["--device", "/dev/kvm"]), /--device/),
  mutate("extra groups (keep-groups)", insertBeforeImage(["--group-add", "keep-groups"]), /--group-add/),
  mutate("published port", insertBeforeImage(["-p", "8080:80"]), /published to the host|nothing is published/),
  mutate("volumes-from", insertBeforeImage(["--volumes-from", "other"]), /--volumes-from/),
  mutate("dns override", insertBeforeImage(["--dns", "8.8.8.8"]), /--dns/),
  mutate("add-host", insertBeforeImage(["--add-host", "evil:1.2.3.4"]), /--add-host/),
  mutate("sysctl", insertBeforeImage(["--sysctl", "net.ipv4.ip_forward=1"]), /--sysctl/),
  mutate("env file", insertBeforeImage(["--env-file", "/etc/secrets"]), /--env-file/),
  mutate("seccomp unconfined", insertBeforeImage(["--security-opt", "seccomp=unconfined"]), /--security-opt seccomp=unconfined/),
  mutate("apparmor unconfined", insertBeforeImage(["--security-opt", "apparmor=unconfined"]), /--security-opt apparmor=unconfined/),
  mutate("selinux label disabled", insertBeforeImage(["--security-opt", "label=disable"]), /--security-opt label=disable/),
  mutate("userns host", insertBeforeImage(["--userns", "host"]), /--userns host/),
  mutate("writable root filesystem", dropFlag("--read-only", false), /missing --read-only/),
  mutate("capabilities kept", dropFlag("--cap-drop"), /missing --cap-drop ALL/),
  mutate("only some capabilities dropped", replaceFlag("--cap-drop", "NET_RAW"), /missing --cap-drop ALL/),
  mutate("no-new-privileges removed", dropFlag("--security-opt"), /missing --security-opt no-new-privileges/),
  mutate("no pids limit", dropFlag("--pids-limit"), /missing --pids-limit/),
  mutate("no memory limit", dropFlag("--memory"), /missing --memory/),
  mutate("no cpu limit", dropFlag("--cpus"), /missing --cpus/),
  mutate("root user", replaceFlag("--user", "0:0"), /never runs as root/),
  mutate("named root user", replaceFlag("--user", "root"), /never runs as root or a named user/),
  mutate("no explicit user", dropFlag("--user"), /missing --user/),
  mutate("engine socket", insertBeforeImage(["--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock"]), /must never see|not allowed/),
  mutate("podman socket", insertBeforeImage(["--mount", `type=bind,source=/run/user/1000/podman/podman.sock,target=/run/podman.sock`]), /must never see|outside the run/),
  mutate("operator's home", insertBeforeImage(["--mount", `type=bind,source=${os.homedir()},target=/home/op`]), /outside the run's directories|must never see/),
  mutate("ssh keys", insertBeforeImage(["--mount", `type=bind,source=${os.homedir()}/.ssh,target=/root/.ssh`]), /must never see|outside/),
  mutate("host root", insertBeforeImage(["--mount", "type=bind,source=/,target=/host"]), /must never see|outside/),
  mutate("host /etc", insertBeforeImage(["--mount", "type=bind,source=/etc,target=/hostetc"]), /must never see|outside/),
  mutate("pi agent dir", insertBeforeImage(["--mount", `type=bind,source=${os.homedir()}/.pi/agent,target=/pi`]), /must never see|outside/),
  mutate("a path outside the run directory", insertBeforeImage(["--mount", "type=bind,source=/opt/data,target=/data"]), /outside the run's directories/),
  mutate("dot-dot escape", insertBeforeImage(["--mount", `type=bind,source=${p.root}/work/../../elsewhere,target=/data`]), /\.\.|outside/),
  mutate("relative source", insertBeforeImage(["--mount", "type=bind,source=work,target=/data"]), /not an absolute path/),
  mutate("named volume", insertBeforeImage(["--mount", "type=volume,source=v,target=/data"]), /only bind mounts/),
  mutate("short -v form", insertBeforeImage(["-v", `${p.work}:/data`]), /use --mount/),
  // The engines take the last of source/src (and of target/destination/dst): the validator must not check the first.
  mutate("source smuggled as a later src", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/data,src=/opt/data`]), /source is given more than once/),
  mutate("target smuggled as a later dst", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/data,dst=/etc`]), /target is given more than once/),
  mutate("repeated type", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/data,type=volume`]), /type is given more than once/),
  mutate("prototype key in a mount", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/data,__proto__=x`]), /mount option __proto__ is not allowed/),
  mutate("mount over /proc", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/proc`]), /mount target \/proc is not allowed/),
  mutate("mount over /var/run", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/var/run`]), /not allowed/),
  mutate("mount option smuggling", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/data,bind-propagation=rshared`]), /mount option bind-propagation/),
  mutate("credential in the environment (value)", insertBeforeImage(["--env", "SOMETHING=sk-or-v1-0123456789abcdef0123456789abcdef"]), /credential-shaped value/),
  mutate("credential-looking name", insertBeforeImage(["--env", "OPENROUTER_API_KEY=x"]), /looks like a credential/),
  mutate("token variable", insertBeforeImage(["--env", "GITHUB_TOKEN=abc"]), /looks like a credential/),
  mutate("inherited variable", insertBeforeImage(["--env", "HOME_SECRET"]), /inherited from the supervisor/),
  mutate("unknown flag", insertBeforeImage(["--experimental-thing"]), /unrecognised flag/),
  mutate("no network flag", dropFlag("--network"), /no --network/),
  mutate("relay on the run network directly", replaceFlag("--network", N.net), /not one of this container's networks/, builders.relay),
  mutate("proxy on the internal network directly", replaceFlag("--network", N.net), /not one of this container's networks/, builders.proxy),
  mutate("a check with network", replaceFlag("--network", N.net), /not one of this container's networks/, builders.check),
];

await check("negative table: every way of weakening a container is refused by the containment validator", () => {
  let n = 0;
  for (const neg of NEGATIVE) {
    const { problems } = inspectRunArgs(neg.args, inspectOpts(neg.b));
    assert.ok(problems.length > 0, `${neg.name}: expected a problem`);
    assert.ok(problems.some((m) => neg.expectRe.test(m)), `${neg.name}: expected ${neg.expectRe}, got ${problems.join(" | ")}`);
    assert.throws(() => assertRunArgs(neg.args, inspectOpts(neg.b)), /refusing to start/);
    n++;
  }
  assert.ok(n >= 55, `${n} negative cases`);
  assert.ok(inspectRunArgs(["ps"], {}).problems.length > 0, "not a run command");
  assert.ok(inspectRunArgs(["run", "-d", "img"], { roots }).problems.length >= 6, "a bare run has many problems");
});

await check("the builders themselves cannot be talked into weaker containers by configuration", () => {
  // A hostile or mistaken config value must be caught by the validator, not silently emitted.
  const bad = (mut: ContractChange) => { const c = structuredClone(deployContract); mut(c); return runtimeConfig(c, { namePrefix: "pi-autonomy-test-unit" }); };
  const rootCfg = bad((c) => { c.runtime.user = "0:0"; });
  const asRoot = dk.agentRunArgs(rootCfg, p, { n: 1, attempt: 1, reset: undefined, effort: undefined });
  assert.ok(inspectRunArgs(asRoot, { roots, networks: [N.net], role: "worker" }).problems.some((m) => /never runs as root/.test(m)), "rootless docker's 0:0 must be an explicit opt-in (allowRoot), not a default");
  assert.deepEqual(inspectRunArgs(asRoot, { roots, networks: [N.net], role: "worker", allowRoot: true }).problems, [], "and it is otherwise as hardened");
  const badMount = structuredClone(at(deployContract.permissions.network.services, 0, "the deploy contract has a service"));
  badMount.workspaceMounts = [{ source: "../../home", target: "/x" }];
  const svcArgs = dk.serviceRunArgs(cfg, p, badMount).args;
  assert.ok(svcArgs.some((a) => a.includes("/x,readonly")));
  assert.deepEqual(inspectRunArgs(svcArgs, { roots, networks: [N.net], role: "service", secretEnvNames: ["API_SECRET"] }).problems, [], "service mounts are host-owned staging directories, whatever the contract's source says (the source is only the copy's origin, inside a network-less container)");
  assert.match(dk.deploySyncRunArgs(cfg, p, { service: "web", index: 0, source: "../../home" }).join(" "), /DEPLOY_SRC=\.\.\/\.\.\/home/);
});

await check("resource limits: a --memory or --cpus of 0 (no limit, to the engine) is refused before any container starts", () => {
  assert.deepEqual(limitProblems({ memory: "6g", cpus: "4" }), []);
  assert.deepEqual(limitProblems({ memory: "512m", cpus: "0.5" }), []);
  for (const memory of ["0", "0g", "0.0m", "-1g", "lots", null]) assert.equal(limitProblems({ memory, cpus: "4" }).length, 1, `memory ${String(memory)}`);
  for (const cpus of ["0", "0.0", "-2", "x", null]) assert.equal(limitProblems({ memory: "6g", cpus }).length, 1, `cpus ${String(cpus)}`);
  // The contract refuses a zero limit when it is resolved...
  const r = resolveContract(implementRaw({ runtime: { ...RUNTIME, memory: "0", cpus: "0" } }), { effort: testEffort });
  assert.deepEqual(r.problems.filter((p) => p.level === "error").map((p) => p.path).sort(), ["runtime.cpus", "runtime.memory"]);
  const good = resolveContract(implementRaw({ runtime: RUNTIME }), { effort: testEffort });
  assert.ok(good.ok, JSON.stringify(good.problems));
  const contract = good.contract;
  // ...runcfg refuses one that reaches it another way (an edited contract.json) when the config is read...
  const edited = (mut: (c: RunContract) => void) => { const c = structuredClone(contract); mut(c); return () => runtimeConfig(c, { namePrefix: "pi-autonomy-test-limits" }); };
  assert.throws(edited((c) => { c.runtime.memory = "0"; c.runtime.cpus = "0"; }), /runtime limits refused: --memory 0 is not a positive size.*--cpus 0 is not a positive number/);
  assert.throws(edited((c) => { c.templateOptions.gate = { memory: "0g", cpus: "4" }; }), /templateOptions\.gate limits refused: --memory 0g is not a positive size/);
  assert.throws(edited((c) => { c.templateOptions.gate = { memory: "6g", cpus: "-1" }; }), /templateOptions\.gate limits refused: --cpus -1 is not a positive number/);
  // ...and the runtime refuses run arguments that carry one, which containment.ts alone lets through.
  const cfg = runtimeConfig(contract, { namePrefix: "pi-autonomy-test-limits" });
  cfg.container.memory = "0"; cfg.container.cpus = "0";
  const rt = new DockerRuntime({ contract, cfg, store: new RunStore(contract.run, { home: os.tmpdir() }), env: {} });
  const args = dk.agentRunArgs(cfg, rt.p, { n: 1, attempt: 1 });
  assert.doesNotThrow(() => assertRunArgs(args, { roots: rt.roots, networks: [rt.names.net], role: "worker" }), "containment alone lets it through");
  assert.throws(() => rt.checked(args, { networks: [rt.names.net], role: "worker" }), /refusing to start worker: --memory 0 is not a positive size.*--cpus 0 is not a positive number/);
});

await check("image allowlist: the last-line check refuses an image that is neither the worker image nor a contract service image", () => {
  const good = resolveContract(implementRaw({ runtime: RUNTIME }), { effort: testEffort });
  assert.ok(good.ok, JSON.stringify(good.problems));
  const contract = good.contract;
  const cfg = runtimeConfig(contract, { namePrefix: "pi-autonomy-test-images" });
  const rt = new DockerRuntime({ contract, cfg, store: new RunStore(contract.run, { home: os.tmpdir() }), env: {} });
  const args = dk.agentRunArgs(cfg, rt.p, { n: 1, attempt: 1 });
  assert.equal(rt.checked(args, { networks: [rt.names.net], role: "worker" }).image, cfg.image, "the worker image is allowed");
  const swapped = [...args];
  const at = swapped.lastIndexOf(cfg.image);
  assert.ok(at > 0, "the worker args name the image");
  swapped[at] = "example.invalid/unlisted:1";
  assert.doesNotThrow(() => assertRunArgs(swapped, { roots: rt.roots, networks: [rt.names.net], role: "worker" }), "without an allowlist containment.ts alone lets it through");
  assert.throws(() => rt.checked(swapped, { networks: [rt.names.net], role: "worker" }), /image example\.invalid\/unlisted:1 is not one this run may start/);
  const listed = inspectRunArgs(swapped, { roots: rt.roots, networks: [rt.names.net], role: "worker", allowedImages: [cfg.image, "example.invalid/unlisted:1"] });
  assert.deepEqual(listed.problems, [], "a listed service image is allowed");
});

done();
