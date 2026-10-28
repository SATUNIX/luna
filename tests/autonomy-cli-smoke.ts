#!/usr/bin/env node
/**
 * Offline tests of the operator CLI (packages/autonomy/cli.ts), driven in-process with injected
 * dependencies: a temporary state home, captured output, a scripted TTY answer, and the FAKE
 * runtime in place of containers (deterministic; not a real-provider run). What they cover:
 * templates, init (flags and validation), plan and its digest, `plan --authorise`, the start
 * decision (an authorised contract starts without prompts; a digest mismatch, or `--yes` without
 * a terminal, refuses), status/pause/resume/steer/cancel against a live and a crashed
 * supervisor, resume with an answer, reconfigure, promote, export, boundary, and the JSON shapes
 * the pi extension consumes. A last check runs the real script as a subprocess.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, implementRaw, makeChecker, tempDir, rm, testEffort, type RawContract } from "./autonomy-helpers.ts";
import { main, type CliDeps as RealCliDeps, type RuntimeFactoryOptions } from "../packages/autonomy/cli.ts";
import { createRunLock } from "../packages/autonomy/lib/runlock.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import { RunStore } from "../packages/autonomy/lib/store.ts";
import { FakeEngine, FakeRuntime, kill } from "../packages/autonomy/tests/fake-runtime.ts";
import { NODE_EXIT, ANSWER, type BacklogItem, type RunBlocker, type RunContract, type RunOutcome, type ReviewFn, type Script, type ScriptContext } from "./autonomy-harness.ts";

/**
 * The CLI's --json output. One shape across the commands: each command fills the fields it reports
 * (templates, init, plan, start, status, export, reconfigure, promote, boundary, errors).
 */
interface CliJson {
  ok?: boolean;
  code: string;
  error: string;
  refusal: string;
  text?: string;
  templates: Array<{ id: string; title: string; summary: string; requires: string[]; finite: boolean; defaults: { permissions: { unattended: { authorised: boolean } } } }>;
  valid: boolean;
  next: string[];
  problems: Array<{ path: string; message: string }>;
  contract: RunContract;
  legacy: boolean;
  digest: string;
  authorisation: { status: string; via: string; by: string | null };
  boundary: Record<string, unknown>;
  invariants: unknown[];
  started: boolean;
  detached: boolean;
  pid: number;
  status: string;
  outcome: RunOutcome;
  supervisor: { state: string };
  tasks: BacklogItem[];
  usage: { usd: number; minutes: number; steps: number };
  limits: { budget: RunContract["budget"] };
  effort: { tier: string; cap: string };
  recovery: Record<string, unknown>;
  history: unknown[];
  blocker: RunBlocker;
  delivered: string;
  after: { budget: RunContract["budget"]; effort: { tier: string; cap: string } };
  promotion: { status: string };
  missing: string[];
  files: string[];
  manifest: string;
  matchesAuthorisation: boolean;
  authorisedDigest: string;
  runs: Array<{ legacy?: boolean; [key: string]: unknown }>;
}

/** The CLI's --json output text, in the one shape the commands share. */
function cliJson(text: string): CliJson {
  return JSON.parse(text) as CliJson;
}

/** The value at `keys` in a contract read back from disk; each step on the way must be an object. */
function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    assert.ok(isRecord(current), `${keys.join(".")}: an object holds ${key}`);
    current = current[key];
  }
  return current;
}

/** One in-process CLI invocation's result. */
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json(): CliJson;
}

/** A runtime as the blocked-flow test sees it: fake-runtime.ts sets `hooks` via Object.assign, so it is not declared. */
type HookedRuntime = FakeRuntime & { hooks: { onSleep?: () => void }; parked?: boolean };

/** The dependencies the tests inject into the CLI's main(): all but the process's own env and stdin, with the fake runtime. */
type CliDeps = Omit<RealCliDeps, "env" | "stdin" | "runtimeFactory"> & { runtimeFactory: (o: RuntimeFactoryOptions) => FakeRuntime };

interface WorldOptions {
  script?: Script;
  isTTY?: boolean;
  confirm?: (q: string) => Promise<boolean>;
  review?: ReviewFn;
}

/** One CLI "world" (see world()). */
interface World {
  home: string;
  clock: { now: number };
  fakeEngine: FakeEngine;
  out: string[];
  err: string[];
  confirmations: string[];
  spawned: string[];
  script: Script;
  deps: () => CliDeps;
  dead: Set<number>;
  run(...argv: string[]): Promise<CliResult>;
}

const { check, done } = makeChecker("autonomy-cli-smoke");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "packages", "autonomy", "cli.ts");
const dirs: string[] = [];
const scratch = (): string => { const d = tempDir("autonomy-cli-"); dirs.push(d); return d; };

/** One CLI "world": a state home, a virtual clock, captured output and the fake runtime. */
function world({ script = async () => {}, isTTY = false, confirm = async () => true, review }: WorldOptions = {}): World {
  const home = scratch();
  const clock = { now: Date.parse("2026-09-30T00:00:00Z") };
  const fakeEngine = new FakeEngine();
  const out: string[] = []; const err: string[] = [];
  let pid = 7000;
  const w: World = {
    home, clock, fakeEngine, out, err, confirmations: [], spawned: [], script,
    deps: () => ({
      home, effort: testEffort, isTTY, signals: false, pid: ++pid, now: () => new Date(clock.now),
      stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
      lockOptions: { host: "test-host", now: () => clock.now, isAlive: (p) => !w.dead?.has(p), startTimeOf: (p) => `start-${p}`, staleMs: 120_000, heartbeatMs: 3_600_000 },
      confirm: async (q) => { w.confirmations.push(q); return confirm(q); },
      ask: async (_q, d = "") => d,
      spawnSupervisor: (run) => { w.spawned.push(run); return 4242; },
      runtimeFactory: ({ contract, cfg, store }) => new FakeRuntime({ store, cfg, contract, script: w.script, engine: fakeEngine, clock, review }),
    }),
    dead: new Set(),
    run: async (...argv) => { out.length = 0; err.length = 0; const code = await main(argv, w.deps()); return { code, stdout: out.join(""), stderr: err.join(""), json: () => cliJson(out.join("")) }; },
  };
  return w;
}

/** A finite task the fake worker solves in one turn. */
const solveScript = async (t: ScriptContext): Promise<void> => { t.write("answer.txt", "42\n"); t.commit("answer"); };
const taskFile = (dir: string, over: RawContract = {}): string => {
  const file = path.join(dir, "run.json");
  fs.writeFileSync(file, JSON.stringify(implementRaw({
    objective: { title: "Write the answer", spec: "Put 42 in answer.txt.", backlog: [{ id: "T1", title: "answer", acceptance: ["unit"] }] },
    acceptance: { checks: [{ id: "unit", run: NODE_EXIT(`${ANSWER}.trim() === '42'`), timeoutMinutes: 1, required: true }], review: false },
    budget: { totalUsd: 10, perStepUsd: 2, maxSteps: 12, maxMinutes: 600 }, ...over,
  }), null, 2));
  return file;
};
const authorised = async (w: World, file: string): Promise<CliJson> => { const r = await w.run("plan", "--config", file, "--authorise", "--by", "alice", "--yes", "--json"); assert.equal(r.code, 0, r.stdout + r.stderr); return r.json(); };

await check("backlog CLI queues file-based items for self-improve, online or offline, and rejects invalid requests", async () => {
  const w = world();
  const src = scratch();
  assert.equal(spawnSync("git", ["init", "--quiet", src]).status, 0);
  const file = taskFile(scratch(), { template: "self-improve", inputs: { repository: { path: src, ref: "main" } }, acceptance: { checks: [{ id: "unit", run: ["true"] }] } });
  await authorised(w, file);
  const start = await w.run("start", "--config", file, "--detach", "--json");
  assert.equal(start.code, 0, start.stdout + start.stderr);
  const store = new RunStore("todo-api-1", { home: w.home });
  for (const live of [false, true]) {
    const lock = createRunLock({ file: store.p.lock, pid: 42000, host: "test-host", now: () => w.clock.now, isAlive: () => true, startTimeOf: () => "start-42000" });
    if (live) assert.equal(lock.acquire().acquired, true);
    const queued = await w.run("backlog", "--run", "todo-api-1", "--message", "Investigate recovery", "--json");
    assert.equal(queued.code, 0, queued.stdout + queued.stderr);
    assert.equal(queued.json().delivered, "inbox");
    if (live) lock.release();
  }
  assert.equal(store.pending().filter((m) => m.kind === "backlog").length, 2);
  assert.deepEqual(store.pending()[0]?.payload, { message: "Investigate recovery" });
  assert.equal((await w.run("backlog", "--run", "todo-api-1", "--message", "  ", "--json")).code, 2);
  store.transition("cancelled", { reason: "test" });
  assert.equal((await w.run("backlog", "--run", "todo-api-1", "--message", "late", "--json")).code, 3);
});

await check("templates: every template is described, with what it needs and its closed defaults", async () => {
  const w = world();
  const r = await w.run("templates", "--json");
  assert.equal(r.code, 0);
  const j = r.json();
  assert.equal(j.ok, true);
  assert.deepEqual(j.templates.map((t) => t.id).sort(), ["deploy", "implement", "self-improve"]);
  for (const t of j.templates) { assert.ok(t.title && t.summary && t.requires.length && typeof t.finite === "boolean" && t.defaults); }
  const implement = j.templates.find((t) => t.id === "implement");
  assert.ok(implement, "the implement template is listed");
  assert.equal(implement.defaults.permissions.unattended.authorised, false, "defaults are closed");
  const text = await w.run("templates");
  assert.match(text.stdout, /implement\s+finite/);
  assert.match(text.stdout, /pi-autonomy init --template self-improve/);
  assert.equal((await w.run("nope")).code, 2);
  assert.equal((await w.run("nope", "--json")).json().code, "usage");
  for (const inherited of ["toString", "constructor", "__proto__"]) assert.equal((await w.run(inherited, "--json")).json().code, "usage", `${inherited} is not a command (an Object.prototype name is not a command)`);
  assert.equal((await w.run("init", "--template", "toString", "--force", "--out", path.join(scratch(), "x.json"), "--json")).json().code, "usage", "an Object.prototype name is not a template");
  assert.equal((await w.run("plan", "--json")).json().code, "usage", "a missing --config is a usage error, as JSON");
  assert.equal((await w.run("plan", "--config", "x", "--bogus")).code, 2);
});

await check("init: flags produce a valid contract; problems are reported, not written; nothing is overwritten silently", async () => {
  const w = world();
  const dir = scratch();
  const out = path.join(dir, "run.json");
  const r = await w.run("init", "--template", "implement", "--run", "todo-api-1", "--title", "Todo API", "--spec", "Build a todo API.", "--check", "unit=node --test", "--backlog", "T1:Health endpoint", "--unattended", "--egress", "registry.npmjs.org:443", "--budget-usd", "5", "--max-steps", "10", "--effort", "E4", "--out", out, "--json");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const j = r.json();
  assert.equal(j.valid, true);
  assert.deepEqual(j.next, [`pi-autonomy plan --config ${out}`, `pi-autonomy start --config ${out}`]);
  const written = parseJson(fs.readFileSync(out, "utf8"));
  assert.deepEqual([at(written, "schemaVersion"), at(written, "template"), at(written, "run")], [1, "implement", "todo-api-1"]);
  assert.deepEqual(at(written, "permissions", "unattended"), { authorised: true, autoApprove: true }, "unattended is written explicitly, so the boundary shows it");
  assert.deepEqual(at(written, "permissions", "network", "egress"), [{ host: "registry.npmjs.org", ports: [443] }]);
  assert.deepEqual(at(written, "acceptance", "checks"), [{ id: "unit", run: "node --test", timeoutMinutes: 15, required: true }]);
  assert.equal(at(written, "effort"), "E4");
  assert.equal(at(written, "budget", "totalUsd"), 5);
  assert.equal(at(written, "promotion", "policy"), "none");
  assert.equal((await w.run("init", "--template", "implement", "--run", "todo-api-1", "--title", "x", "--spec", "y", "--check", "a=b", "--out", out)).code, 3, "no silent overwrite");
  const bad = await w.run("init", "--template", "implement", "--run", "Bad Id", "--title", "x", "--out", path.join(dir, "bad.json"), "--json");
  assert.equal(bad.code, 2);
  assert.equal(bad.json().code, "invalid");
  assert.ok(bad.json().problems.some((p) => p.path === "run"), "the problems are structured");
  assert.equal(fs.existsSync(path.join(dir, "bad.json")), false, "an invalid contract is not written");
  const forced = await w.run("init", "--template", "implement", "--run", "Bad Id", "--title", "x", "--out", path.join(dir, "bad.json"), "--force");
  assert.equal(forced.code, 0);
  assert.equal((await w.run("init", "--template", "self-improve", "--run", "improve-1", "--repo", "/repo", "--check", "tests=npm test", "--out", path.join(dir, "si.json"), "--json")).json().contract.promotion.policy, "local-branch", "self-improve promotes locally by default");
  const dep = await w.run("init", "--template", "deploy", "--run", "site-1", "--title", "Site", "--spec", "Serve a page.", "--check", "build=node build.mjs", "--out", path.join(dir, "deploy.json"), "--json");
  assert.equal(dep.json().valid, true, JSON.stringify(dep.json().problems));
  assert.ok(dep.json().contract.permissions.network.services.length >= 1, "a deploy skeleton starts from a service");
  assert.equal((await w.run("init", "--template", "nope", "--out", path.join(dir, "n.json"))).code, 2);
});

await check("plan: the resolved boundary and its digest; `plan --authorise` records consent, and any later change to the contract voids it", async () => {
  const w = world();
  const file = taskFile(scratch());
  const p = await w.run("plan", "--config", file, "--json");
  assert.equal(p.code, 0);
  const j = p.json();
  assert.equal(j.ok, true);
  assert.match(j.digest, /^[a-f0-9]{64}$/);
  assert.equal(j.authorisation.status, "missing");
  assert.deepEqual(Object.keys(j.boundary).sort(), ["acceptance", "boundaryVersion", "budget", "credentials", "effort", "filesystem", "inputs", "model", "network", "outputs", "process", "promotion", "recovery", "template", "templateOptions", "unattended"]);
  assert.ok(j.invariants.length >= 5);
  const text = await w.run("plan", "--config", file);
  assert.match(text.stdout, /Boundary for run todo-api-1/);
  assert.match(text.stdout, new RegExp(`digest ${j.digest}`));
  assert.match(text.stdout, /authorisation: missing/);
  // Without a terminal, --authorise needs --yes (a person confirmed elsewhere); the file gains the consent record.
  assert.equal((await w.run("plan", "--config", file, "--authorise", "--json")).code, 3);
  // --digest: only the boundary the caller was shown is authorised. A different digest refuses and writes nothing.
  const before = fs.readFileSync(file, "utf8");
  const stale = await w.run("plan", "--config", file, "--authorise", "--yes", "--by", "alice", "--digest", "0".repeat(64), "--json");
  assert.equal(stale.code, 3);
  assert.match(stale.json().error, /boundary changed since it was shown to you/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "a refused authorisation leaves the contract untouched");
  const bound = await w.run("plan", "--config", file, "--authorise", "--yes", "--by", "alice", "--digest", j.digest, "--json");
  assert.equal(bound.code, 0, bound.stdout + bound.stderr);
  fs.writeFileSync(file, before); // back to unauthorised for the unbound path below
  const a = await authorised(w, file);
  assert.equal(a.authorisation.status, "authorised");
  const written = parseJson(fs.readFileSync(file, "utf8"));
  assert.deepEqual([at(written, "authorisation", "boundaryDigest"), at(written, "authorisation", "by")], [j.digest, "alice"]);
  assert.equal((await w.run("plan", "--config", file, "--json")).json().authorisation.status, "authorised");
  const permissions = at(written, "permissions");
  assert.ok(isRecord(permissions), "the contract has permissions");
  permissions.network = { egress: [{ host: "example.org", ports: [443] }] };
  fs.writeFileSync(file, JSON.stringify(written));
  const after = (await w.run("plan", "--config", file, "--json")).json();
  assert.equal(after.authorisation.status, "mismatch", "widening the contract voids its authorisation");
  assert.notEqual(after.digest, j.digest);
  // A contract with errors is reported with structured problems and cannot be authorised.
  const badFile = path.join(scratch(), "bad.json");
  fs.writeFileSync(badFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), permissions: { root: true } }));
  const bad = await w.run("plan", "--config", badFile, "--json");
  assert.equal(bad.json().ok, false);
  assert.ok(bad.json().problems.some((x) => x.path === "permissions.root"));
  assert.equal((await w.run("plan", "--config", badFile, "--authorise", "--yes", "--json")).code, 2);
});

await check("start: an authorised contract runs without prompts; a mismatch, or --yes without a terminal, refuses; a duplicate is refused; results export", async () => {
  const w = world({ script: solveScript });
  const file = taskFile(scratch());
  // No authorisation, no terminal: --yes alone is not consent. Nothing is created.
  const refused = await w.run("start", "--config", file, "--yes", "--json");
  assert.equal(refused.code, 3);
  assert.equal(refused.json().refusal, "authorisation_required");
  assert.match(refused.json().error, /--yes alone is not consent/);
  assert.equal(fs.readdirSync(w.home).length, 0, "no run directory was created");
  await authorised(w, file);
  // Tamper: the authorisation no longer matches.
  const good = fs.readFileSync(file, "utf8");
  const tampered = parseJson(good); const budget = at(tampered, "budget"); assert.ok(isRecord(budget), "the contract has a budget"); budget.totalUsd = 999;
  fs.writeFileSync(file, JSON.stringify(tampered));
  const mismatch = await w.run("start", "--config", file, "--json");
  assert.equal(mismatch.code, 3);
  assert.equal(mismatch.json().refusal, "digest_mismatch");
  assert.match(mismatch.json().error, /re-authorise with `plan --authorise`/);
  assert.equal(fs.readdirSync(w.home).length, 0);
  fs.writeFileSync(file, good);
  // Authorised: starts and runs to completion with no confirmation asked.
  const started = await w.run("start", "--config", file, "--json");
  assert.equal(started.code, 0, started.stdout + started.stderr);
  const j = started.json();
  assert.deepEqual([j.started, j.status, j.outcome.reason, j.detached], [true, "succeeded", "acceptance_passed", false]);
  assert.equal(w.confirmations.length, 0, "an authorised configuration is not asked again");
  assert.equal(j.authorisation ?? undefined, undefined);
  const st = (await w.run("status", "--run", "todo-api-1", "--json")).json();
  assert.equal(st.authorisation.via, "contract");
  assert.equal(st.authorisation.by, "alice");
  // Starting the same run id again is refused.
  const dup = await w.run("start", "--config", file, "--json");
  assert.equal(dup.code, 3);
  assert.match(dup.json().error, /already exists/);
  // Export: manifest, evidence and the work.
  const out = path.join(scratch(), "results");
  const ex = await w.run("export", "--run", "todo-api-1", "--out", out, "--json");
  assert.equal(ex.code, 0, ex.stdout + ex.stderr);
  const e = ex.json();
  assert.deepEqual([e.status, e.missing], ["succeeded", []]);
  for (const f of ["state.json", "usage.json", "decisions.json", "work/todo-api-1.bundle"]) assert.ok(e.files.includes(f), f);
  assert.ok(fs.existsSync(e.manifest), "the manifest itself is written beside the files it lists");
  const inside = await w.run("export", "--run", "todo-api-1", "--out", path.join(w.home, "todo-api-1", "work", "x"), "--json");
  assert.equal(inside.code, 3, "results are never written where a worker can read or write");
});

await check("start on a terminal: unauthorised asks once (and shows the boundary); declining creates nothing; --yes skips the question", async () => {
  const file = taskFile(scratch());
  const w = world({ script: solveScript, isTTY: true, confirm: async () => false });
  const no = await w.run("start", "--config", file);
  assert.equal(no.code, 3);
  assert.equal(w.confirmations.length, 1);
  assert.match(w.confirmations[0] ?? "", /Authorise this boundary \(digest [a-f0-9]{12}\) and start run todo-api-1/);
  assert.equal(fs.readdirSync(w.home).length, 0);
  assert.match(no.stdout, /Boundary for run todo-api-1/, "the boundary is shown before the question");
  const w2 = world({ script: solveScript, isTTY: true, confirm: async () => true });
  const yes = await w2.run("start", "--config", file);
  assert.equal(yes.code, 0, yes.stderr);
  assert.equal(w2.confirmations.length, 1);
  assert.equal(w2.dead.size, 0);
  assert.equal(new RunStore("todo-api-1", { home: w2.home }).readState()?.authorisation.via, "interactive");
  const w3 = world({ script: solveScript, isTTY: true, confirm: async () => { throw new Error("must not be asked"); } });
  const flag = await w3.run("start", "--config", file, "--yes", "--by", "bob");
  assert.equal(flag.code, 0, flag.stderr);
  assert.equal(new RunStore("todo-api-1", { home: w3.home }).readState()?.authorisation.via, "tty-yes");
  assert.equal(new RunStore("todo-api-1", { home: w3.home }).readState()?.authorisation.by, "bob");
});

await check("--detach starts nothing in the foreground; the supervisor command then runs the same run; a legacy v0 file cannot carry an authorisation", async () => {
  const w = world({ script: solveScript });
  const file = taskFile(scratch());
  await authorised(w, file);
  const det = await w.run("start", "--config", file, "--detach", "--json");
  assert.equal(det.code, 0);
  assert.deepEqual([det.json().detached, det.json().pid, w.spawned], [true, 4242, ["todo-api-1"]]);
  assert.equal(new RunStore("todo-api-1", { home: w.home }).readState()?.status, "setup", "created, not yet run");
  const sup = await w.run("supervise", "--run", "todo-api-1", "--json");
  assert.equal(sup.json().status, "succeeded");
  const v0 = path.join(scratch(), "v0.json");
  fs.writeFileSync(v0, JSON.stringify({ run: "perpetual-x", cycles: 2, gitRemote: "https://git.example.org/team/repo.git", promotion: "none" }));
  const legacy = await w.run("start", "--config", v0, "--json");
  assert.equal(legacy.code, 3, "a v0 file has no place for an authorisation, so a headless start is refused");
  assert.match(legacy.stderr, /deprecated v0 config/);
  const plan = (await w.run("plan", "--config", v0, "--json")).json();
  assert.equal(plan.legacy, true);
  assert.ok(plan.problems.some((p) => /deprecated/.test(p.message)));
  const noRemote = path.join(scratch(), "v0b.json");
  fs.writeFileSync(noRemote, JSON.stringify({ run: "perpetual-x", cycles: 2 }));
  const missing = (await w.run("plan", "--config", noRemote, "--json")).json();
  assert.ok(missing.problems.some((p) => p.path === "gitRemote") || missing.ok === false);
});

/** A run that crashed mid-way: state `running`, a stale lock, an orphaned container. */
async function crashedRun(w: World, file: string): Promise<RunStore> {
  let calls = 0;
  const original = w.script;
  w.script = async (t) => { calls++; if (calls === 1) { t.write("wip.txt", "1"); t.commit("wip"); } else throw kill(); };
  const store = new RunStore("todo-api-1", { home: w.home });
  const deps = w.deps();
  await assert.rejects(main(["start", "--config", file, "--json"], { ...deps, stdout: { write() {} } }), (e: unknown) => typeof e === "object" && e !== null && "simulateKill" in e && e.simulateKill === true);
  w.dead.add(deps.pid); // the supervisor's pid is gone: its lock is stale
  w.script = original; // whoever resumes it gets a worker that works
  return store;
}

await check("pause, steer, cancel, status: to a live supervisor they are commands in its inbox; with none they change the recorded state; resume continues a crashed run", async () => {
  const w = world({ script: solveScript });
  const file = taskFile(scratch());
  await authorised(w, file);
  const store = await crashedRun(w, file);
  assert.equal(store.readState()?.status, "running");
  const st = (await w.run("status", "--run", "todo-api-1", "--json")).json();
  assert.equal(st.supervisor.state, "stale", "the crashed supervisor is recognised as gone");
  assert.equal(st.status, "running");
  assert.equal(st.tasks[0]?.id, "T1");
  assert.ok(st.usage && st.limits.budget && st.effort.tier === "standard" && st.recovery && st.history.length > 0);
  assert.match((await w.run("status", "--run", "todo-api-1")).stdout, /supervisor: stale/);
  // A run id is a name, never a path: `--run ../x` is refused before anything is resolved on disk.
  for (const bad of ["../todo-api-1", "todo-api-1/../..", "/etc", "TODO", "a", "x".repeat(60)]) {
    const r = await w.run("status", "--run", bad, "--json");
    assert.equal(r.code, 2, `--run ${bad}: usage error`);
    assert.match(r.json().error, /is not a run id/);
  }
  assert.match((await w.run("status")).stdout, /todo-api-1\s+implement\s+running/);
  // A LIVE supervisor: hold the lock with a pid that is alive.
  // runlock.ts destructures `file` without a default or JSDoc, so its inferred parameter type omits it;
  // passing the options as a variable (not a fresh literal) avoids a false excess-property error.
  const liveOpts = { file: store.p.lock, pid: 31000, host: "test-host", now: () => w.clock.now, isAlive: () => true, startTimeOf: () => "start-31000" };
  const live = createRunLock(liveOpts);
  fs.rmSync(store.p.lock, { force: true });
  assert.equal(live.acquire().acquired, true);
  for (const [argv, kind] of [[["pause"], "pause"], [["steer", "--message", "use sqlite"], "steer"], [["cancel", "--reason", "no longer needed"], "cancel"]] satisfies Array<[[string, ...string[]], string]>) {
    const r = await w.run(argv[0], "--run", "todo-api-1", ...argv.slice(1), "--json");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json().delivered, "supervisor");
    assert.ok(store.pending().some((m) => m.kind === kind), kind);
  }
  assert.deepEqual(store.pending().find((m) => m.kind === "steer")?.payload, { message: "use sqlite" });
  assert.equal(store.readState()?.status, "running", "the supervisor, not the CLI, acts on them");
  live.release();
  for (const m of store.pending()) store.ack(m.name);
  // No supervisor: steer is recorded, pause parks the run, cancel ends it as cancelled, all without touching a container.
  assert.equal((await w.run("steer", "--run", "todo-api-1", "--message", "prefer small commits", "--json")).json().delivered, "state");
  assert.equal(store.readState()?.steers?.at(-1)?.message, "prefer small commits");
  assert.equal((await w.run("pause", "--run", "todo-api-1", "--json")).json().status, "paused");
  assert.equal(store.readState()?.status, "paused");
  assert.deepEqual([...w.fakeEngine.containers], [], "the orphaned worker was removed when the paused run was parked");
  const resumed = await w.run("resume", "--run", "todo-api-1", "--json");
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.equal(resumed.json().status, "succeeded");
  assert.equal((await w.run("cancel", "--run", "todo-api-1", "--json")).code, 3, "a finished run cannot be cancelled");
  assert.equal((await w.run("resume", "--run", "todo-api-1", "--json")).code, 3, "nor resumed");
  assert.match((await w.run("resume", "--run", "todo-api-1", "--json")).json().error, /already succeeded/);
  // Cancel on a run nobody supervises.
  const w2 = world({ script: solveScript });
  const file2 = taskFile(scratch());
  await authorised(w2, file2);
  const store2 = await crashedRun(w2, file2);
  const c = await w2.run("cancel", "--run", "todo-api-1", "--reason", "changed my mind", "--json");
  assert.equal(c.json().status, "cancelled");
  assert.deepEqual([store2.readState()?.status, store2.readState()?.outcome?.status, store2.readState()?.outcome?.detail], ["cancelled", "cancelled", "changed my mind"]);
  assert.equal(fs.existsSync(store2.p.lock), false, "the CLI released the lock it took");
});

// The blocked flow needs the parked supervisor to see the answer: drive it with a hook instead of a real wait.
await check("blocked: the question is recorded and shown; resume needs --answer; --answer continues the run", async () => {
  const w = world();
  const file = taskFile(scratch());
  await authorised(w, file);
  let turn = 0;
  w.script = async (t) => { turn++; if (turn === 1) t.ask({ method: "input", title: "Which answer do you want: 41 or 42?" }); else await solveScript(t); };
  // Stop the supervisor as soon as it parks blocked (a signal), leaving the run resumable.
  const base = w.deps;
  const store = new RunStore("todo-api-1", { home: w.home });
  w.deps = () => { const d = base(); const f = d.runtimeFactory; d.runtimeFactory = (x) => { const rt = f(x) as HookedRuntime; rt.hooks.onSleep = () => { if (store.exists() && store.readState()?.status === "blocked") { rt.parked = true; process.emit("SIGTERM"); } }; return rt; }; d.signals = true; return d; };
  const first = await w.run("start", "--config", file, "--json");
  assert.equal(first.code, 13, first.stdout + first.stderr);
  assert.equal(first.json().status, "blocked");
  w.deps = base;
  const st = (await w.run("status", "--run", "todo-api-1", "--json")).json();
  assert.equal(st.status, "blocked");
  assert.deepEqual([st.blocker.kind, st.blocker.method], ["question", "input"]);
  assert.match(st.blocker.question, /41 or 42/);
  assert.match((await w.run("status", "--run", "todo-api-1")).stdout, /BLOCKED \(question\): .*41 or 42[\s\S]*pi-autonomy resume --run todo-api-1 --answer/);
  const noAnswer = await w.run("resume", "--run", "todo-api-1", "--json");
  assert.equal(noAnswer.code, 3);
  assert.match(noAnswer.json().error, /--answer/);
  assert.match(noAnswer.json().error, /41 or 42/);
  const answered = await w.run("resume", "--run", "todo-api-1", "--answer", "Use 42.", "--json");
  assert.equal(answered.code, 0, answered.stdout + answered.stderr);
  assert.equal(answered.json().status, "succeeded");
});

await check("reconfigure is the only way effort or budgets change: it shows before/after, needs confirmation, and is logged; exhausted runs are lifted to paused", async () => {
  const w = world({ script: async (t) => { t.spend(1.2); t.write("junk.txt", String(t.turn)); t.commit("junk"); } });
  const file = taskFile(scratch(), { budget: { totalUsd: 2, perStepUsd: 2, maxSteps: 12, maxMinutes: 600 } });
  await authorised(w, file);
  const ended = await w.run("start", "--config", file, "--json");
  assert.equal(ended.json().status, "budget_exhausted");
  assert.equal(ended.code, 12);
  const noYes = await w.run("reconfigure", "--run", "todo-api-1", "--budget-usd", "20", "--json");
  assert.equal(noYes.code, 3);
  assert.match(noYes.json().error, /needs your confirmation/);
  assert.match(noYes.json().error, /"totalUsd": 20/);
  const bad = await w.run("reconfigure", "--run", "todo-api-1", "--effort", "E9", "--yes", "--json");
  assert.equal(bad.code, 2);
  assert.match(bad.json().error, /not an effort tier/);
  const above = await w.run("reconfigure", "--run", "todo-api-1", "--effort", "E5", "--yes", "--json");
  assert.equal(above.code, 2, "a tier above the cap needs the cap raised too");
  const ok = await w.run("reconfigure", "--run", "todo-api-1", "--budget-usd", "20", "--effort", "E4", "--effort-cap", "E4", "--reason", "topped up", "--yes", "--json");
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.deepEqual([ok.json().status, ok.json().after.budget.totalUsd, ok.json().after.effort.tier], ["paused", 20, "thorough"]);
  const s = new RunStore("todo-api-1", { home: w.home }).readState();
  assert.ok(s, "the run has a state.json");
  assert.equal(s.reconfigurations.at(-1)?.reason, "topped up");
  assert.equal(s.history.some((h) => h.from === "budget_exhausted" && h.to === "paused" && h.by === "reconfigure"), true);
  assert.ok(s.usage.usd >= 2.4, "spend is not reset by a top-up");
  const b = (await w.run("boundary", "--run", "todo-api-1", "--json")).json();
  assert.equal(b.matchesAuthorisation, false, "the effective boundary now differs from the authorised one, and says so");
  assert.equal(b.authorisedDigest, s.boundaryDigest);
});

await check("promote: an approval-gated destination waits; --yes (or a terminal) approves; a policy of none has nothing to promote", async () => {
  const src = scratch();
  const g = (cwd: string, ...a: string[]): string => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g(src, "init", "--quiet", "-b", "main"); fs.writeFileSync(path.join(src, "README.md"), "hi\n"); g(src, "add", "."); g(src, "commit", "--quiet", "-m", "base");
  const w = world({ script: solveScript });
  const file = taskFile(scratch(), { inputs: { repository: { path: src, ref: "main" } }, promotion: { policy: "local-branch", destinations: [{ kind: "local-branch", branch: "pi/result" }], requiresOperatorApproval: true } });
  await authorised(w, file);
  const run = await w.run("start", "--config", file, "--json");
  assert.equal(run.json().status, "succeeded");
  const st = (await w.run("status", "--run", "todo-api-1", "--json")).json();
  assert.equal(st.promotion.status, "awaiting_approval");
  assert.match((await w.run("status", "--run", "todo-api-1")).stdout, /approve with: pi-autonomy promote --run todo-api-1/);
  const refused = await w.run("promote", "--run", "todo-api-1", "--json");
  assert.equal(refused.code, 3);
  assert.match(refused.json().error, /needs your approval: fast-forward branch pi\/result in /);
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/pi/result"], { cwd: src }).status, 1);
  const yes = await w.run("promote", "--run", "todo-api-1", "--yes", "--json");
  assert.equal(yes.code, 0, yes.stdout + yes.stderr);
  assert.equal(yes.json().status, "done");
  assert.ok(g(src, "rev-parse", "refs/heads/pi/result"));
  assert.equal(g(src, "rev-parse", "refs/heads/main").length, 40);
  const w2 = world({ script: solveScript });
  const f2 = taskFile(scratch());
  await authorised(w2, f2);
  await w2.run("start", "--config", f2, "--json");
  assert.match((await w2.run("promote", "--run", "todo-api-1", "--json")).json().text ?? (await w2.run("promote", "--run", "todo-api-1")).stdout, /policy is none|nothing to promote/);
});

await check("boundary: the same digest as plan; --json errors are structured with a code and a non-zero exit", async () => {
  const w = world();
  const file = taskFile(scratch());
  const plan = (await w.run("plan", "--config", file, "--json")).json();
  const b = await w.run("boundary", "--config", file, "--json");
  assert.equal(b.json().digest, plan.digest);
  assert.match((await w.run("boundary", "--config", file)).stdout, /Filesystem[\s\S]*Network[\s\S]*Budget and recovery/);
  const missing = await w.run("status", "--run", "no-such-run", "--json");
  assert.equal(missing.code, 3);
  assert.deepEqual([missing.json().ok, missing.json().code], [false, "refused"]);
  const notJson = path.join(scratch(), "x.json");
  fs.writeFileSync(notJson, "{ nope");
  const bad = await w.run("plan", "--config", notJson, "--json");
  assert.equal(bad.code, 2);
  assert.match(bad.json().error, /not valid JSON/);
  assert.equal((await w.run("boundary", "--config", path.join(scratch(), "absent.json"), "--json")).code, 2);
});

await check("legacy entry: supervisor.ts maps the old commands onto the CLI; a v0 run directory is listed but refused with a clear message", async () => {
  const { mapLegacy, legacyMain, runPaths } = await import("../packages/autonomy/supervisor.ts");
  assert.deepEqual(mapLegacy(["stop", "--run", "x"]).argv, ["pause", "--run", "x"]);
  assert.match(mapLegacy(["stop", "--run", "x"]).notes[0] ?? "", /now `pause`/);
  assert.deepEqual(mapLegacy(["boundary", "--config", "r.json"]).argv, ["boundary", "--config", "r.json", "--probe"], "the old boundary command was the live probe");
  assert.deepEqual(mapLegacy(["boundary", "--run", "x"]).argv, ["boundary", "--run", "x"]);
  assert.deepEqual(mapLegacy(["start", "--config", "r.json"]).argv, ["start", "--config", "r.json"]);
  assert.deepEqual(mapLegacy(["plan", "--config", "r.json"]).notes, [], "new commands pass straight through");
  assert.ok(runPaths("x").state.endsWith(path.join("x", "state.json")));
  const w = world();
  const old = path.join(w.home, "old-run");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "state.json"), JSON.stringify({ status: "stopped", cyclesDone: 3, history: [], startedAt: "2026-01-01T00:00:00Z" }));
  fs.writeFileSync(path.join(old, "config.json"), JSON.stringify({ run: "old-run" }));
  const out: string[] = []; const err: string[] = [];
  const io = { ...w.deps(), stdout: { write: (x: string) => out.push(x) }, stderr: { write: (x: string) => err.push(x) } };
  assert.equal(await legacyMain(["status"], io), 0);
  assert.match(out.join(""), /old-run\s+self-improve\s+stopped.*written by the v0 supervisor; read-only/);
  out.length = 0;
  assert.equal(await legacyMain(["status", "--run", "old-run", "--json"], io), 3);
  assert.match(cliJson(out.join("")).error, /previous supervisor \(the v0 format\)/);
  out.length = 0; err.length = 0;
  assert.equal(await legacyMain(["stop", "--run", "old-run"], io), 3);
  assert.match(err.join(""), /note: `stop` is now `pause`/);
  assert.match(err.join(""), /cannot be driven by this one/);
  assert.equal(cliJson((await w.run("status", "--json")).stdout).runs[0]?.legacy, true);
});

await check("the real script works as a subprocess: templates, init, plan (the pi extension calls it this way)", () => {
  const dir = scratch();
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, PI_AUTONOMY_HOME: path.join(dir, "home") } });
  const t = run("templates", "--json");
  assert.equal(t.status, 0, t.stderr);
  assert.equal(cliJson(t.stdout).ok, true);
  const out = path.join(dir, "run.json");
  const init = run("init", "--template", "implement", "--run", "sub-run-1", "--title", "T", "--spec", "S", "--check", "ok=node -e 0", "--attended", "--out", out, "--json");
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const plan = run("plan", "--config", out, "--json");
  assert.equal(plan.status, 0, plan.stderr + plan.stdout);
  const j = cliJson(plan.stdout);
  assert.deepEqual([j.ok, j.authorisation.status], [true, "missing"]);
  const start = run("start", "--config", out, "--yes", "--json");
  assert.equal(start.status, 3, "no terminal and no authorisation: refused");
  assert.equal(cliJson(start.stdout).refusal, "authorisation_required");
  assert.equal(run().status, 2);
  assert.match(run("--help").stdout, /usage: pi-autonomy/);
});

for (const d of dirs) rm(d);
done();
