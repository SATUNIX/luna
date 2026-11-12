#!/usr/bin/env node
/**
 * Run every check the repository defines, in one place.
 *
 * Why this exists: the check suite is defined in `package.json` and only a subset of it
 * was wired into each CI surface, so a green pipeline could sit on top of unrun checks.
 * Enumerating the scripts from the manifest means a new `smoke:*` or `test:*` script is
 * picked up automatically instead of being forgotten.
 *
 * Included: every `smoke:*` and `test:*` script, plus `verify`, `eval`, `docs:check`,
 * `docs:mermaid` and `profile:check` (the last one runs once per shipped profile, because it takes one
 * target per invocation).
 *
 * Excluded on purpose: `docs:serve` / `docs:build` (long-running server / site build),
 * `dream`, `install*` and
 * `release*` (mutating or interactive). Everything excluded is out of scope by prefix,
 * so this list cannot silently drop a real check.
 *
 * Usage:
 *   node packages/core/check-all.ts             # run everything, one check at a time
 *   node packages/core/check-all.ts --list      # print what would run, run nothing
 *   node packages/core/check-all.ts --skip=eval,smoke:docs   # a name that is not a check exits 2
 *   node packages/core/check-all.ts --check-wiring   # only report unwired / empty tests
 *   node packages/core/check-all.ts --shard=1/4 # run one deterministic quarter of the checks
 *   node packages/core/check-all.ts --jobs=4    # run up to four checks at once
 *   node packages/core/check-all.ts --check-timeout=600   # fail a check still running after 600s
 *   node packages/core/check-all.ts --for-changed=docs/guide.md,packages/core/lib/x.ts   # print the plan, run nothing
 *
 * `--for-changed=<a,b>` maps the named changed paths to the checks they imply (lib/check-map.ts)
 * and prints the plan as `check-all: run: <name>` / `check-all: skipped: <name>` lines, then exits
 * 0 without running any check. A cycle derives the paths from its own diff so every check the host
 * gate would run is either run or explicitly skipped.
 *
 * `--shard=<i>/<n>` splits the selected runs by round-robin over their sorted order, so
 * every run lands in exactly one shard and the shards stay balanced; a CI matrix can run
 * them in parallel. `--jobs=<n>` runs up to n checks at once, buffering each check's output
 * and printing it whole when it finishes; the exit status and summary are the same as a
 * sequential run. Checks that cannot share a machine with another check are listed in
 * `SERIAL` and always run alone after the parallel batch. Because a buffered check prints nothing
 * until it ends, `--jobs` above 1 also prints a `... <label> started` line as each check starts,
 * so a log cut short by a job timeout still names the checks that were running.
 * `--check-timeout=<s>` stops a check still running after s seconds, with every process its
 * script started (its process group on POSIX: SIGTERM, then SIGKILL), and reports it as
 * `FAILED (timed out after <s>s)` with whatever it printed so far.
 *
 * Exits non-zero if any check fails, printing a summary of all failures (checks are run
 * to completion so one CI run reports every problem, not just the first).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_NAME_EXACT, CHECK_NAME_PREFIXES, verifyPlan } from "./lib/check-map.ts";
import { isRecord, parseJson } from "./lib/guard.ts";
import { describeProblems, findWiringProblems } from "./lib/wiring.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Checks that must not run beside another check on the same machine, even under `--jobs`.
 * They run alone, after the parallel batch. Each entry states the shared resource that makes
 * concurrency unsafe (read from the script, not assumed):
 *
 *   - smoke:web-console writes `packages/web-ui/.runtime/{server.pid,console.token,server.log}`
 *     (repo-relative) and starts a detached server whose token file is created with `flag: "wx"`,
 *     so a second concurrent instance fails and the working tree is mutated
 *     (tests/web-console-smoke.ts).
 *   - smoke:clean-install runs `buildNpm`, `npm pack`, `npm ci` and the real `pi` CLI; it is a
 *     heavyweight npm/user-cache consumer that must not race another pack or install
 *     (tests/clean-install-smoke.ts).
 *   - smoke:package also runs `buildNpm` + `npm pack`; serialise it with clean-install so the two
 *     never contend for the npm cache (packages/core/pack-check.ts).
 *   - smoke:autonomy-container talks to the Docker/Podman daemon and builds and runs images when
 *     an engine is present (tests/autonomy-container-smoke.ts). It skips cleanly with no engine.
 */
export const SERIAL: ReadonlyMap<string, string> = new Map([
  ["smoke:web-console", "writes the repo-relative packages/web-ui/.runtime and starts a server whose token file is exclusive-create"],
  ["smoke:clean-install", "builds the npm artefact and runs npm pack, npm ci and the real pi CLI"],
  ["smoke:package", "builds the npm artefact and runs npm pack (shares the npm cache with clean-install)"],
  ["smoke:autonomy-container", "builds and runs images through the Docker/Podman daemon when an engine is present"],
]);

/**
 * Resolve the npm executable for the running platform. Windows needs the `.cmd`
 * shim and `shell: true` (Node cannot spawn a `.cmd` directly); other platforms
 * use the bare binary without a shell, mirroring pack-check.ts.
 */
export function resolveNpmCommand(platform: NodeJS.Platform = process.platform): { command: string; shell: boolean } {
  const win = platform === "win32";
  return { command: win ? "npm.cmd" : "npm", shell: win };
}

/** One deterministic slice of the run list: `index` is 1-based, `count` is the shard total. */
export interface Shard {
  index: number;
  count: number;
}

interface CheckAllOptions {
  list: boolean;
  wiring: boolean;
  skip: Set<string>;
  shard: Shard | null;
  jobs: number;
  /** Seconds a single check may run before it is stopped and failed; null means no limit. */
  checkTimeout: number | null;
  /** Changed paths to map to checks and print, instead of running anything; null when not asked. */
  forChanged: string[] | null;
}

/** One `npm run <name> [-- args]` invocation. */
interface CheckRun {
  name: string;
  args: string[];
  label: string;
}

/** One finished buffered check: what to print and whether it passed. */
interface RunResult {
  ok: boolean;
  detail: string;
  seconds: string;
  output: string;
}

/** package.json `scripts`, keeping only string commands (npm runs nothing else). */
function scriptsOf(pkg: unknown): Record<string, string> {
  const scripts = isRecord(pkg) ? pkg.scripts : undefined;
  const out: Record<string, string> = {};
  if (!isRecord(scripts)) return out;
  for (const [name, command] of Object.entries(scripts)) if (typeof command === "string") out[name] = command;
  return out;
}

/** A positive integer argument, or null when the text is not one. */
function positiveInteger(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function parseArgs(argv: readonly string[]): CheckAllOptions {
  const options: CheckAllOptions = { list: false, wiring: false, skip: new Set(), shard: null, jobs: 1, checkTimeout: null, forChanged: null };
  for (const arg of argv) {
    if (arg === "--list") options.list = true;
    else if (arg === "--check-wiring") options.wiring = true;
    else if (arg.startsWith("--skip=")) {
      for (const name of arg.slice("--skip=".length).split(",")) {
        if (name.trim()) options.skip.add(name.trim());
      }
    } else if (arg.startsWith("--shard=")) {
      const value = arg.slice("--shard=".length);
      const match = /^(\d+)\/(\d+)$/.exec(value);
      const index = match ? positiveInteger(match[1] ?? "") : null;
      const count = match ? positiveInteger(match[2] ?? "") : null;
      if (index === null || count === null || index > count) {
        console.error(`check-all: --shard must be <i>/<n> with 1 <= i <= n, not "${value}"`);
        process.exit(2);
      }
      options.shard = { index, count };
    } else if (arg.startsWith("--jobs=")) {
      const value = arg.slice("--jobs=".length);
      const jobs = positiveInteger(value);
      if (jobs === null) {
        console.error(`check-all: --jobs must be a positive integer, not "${value}"`);
        process.exit(2);
      }
      options.jobs = jobs;
    } else if (arg.startsWith("--for-changed=")) {
      options.forChanged = arg
        .slice("--for-changed=".length)
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
    } else if (arg.startsWith("--check-timeout=")) {
      const value = arg.slice("--check-timeout=".length);
      const seconds = positiveInteger(value);
      if (seconds === null) {
        console.error(`check-all: --check-timeout must be a positive integer of seconds, not "${value}"`);
        process.exit(2);
      }
      options.checkTimeout = seconds;
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: node packages/core/check-all.ts [--list] [--check-wiring] [--skip=a,b] [--shard=<i>/<n>] [--jobs=<n>] [--check-timeout=<s>] [--for-changed=a,b]");
      process.exit(0);
    } else {
      console.error(`check-all: unknown argument "${arg}" (try --help)`);
      process.exit(2);
    }
  }
  return options;
}

/**
 * The runs in one shard, by round-robin over the input's sorted order: index `i` (0-based)
 * belongs to shard `i % count + 1`. Every run lands in exactly one shard, and the shards stay
 * balanced when the input grows by one.
 */
export function shardRuns<T>(runs: readonly T[], shard: Shard): T[] {
  return runs.filter((_, index) => index % shard.count === shard.index - 1);
}

/** The checks check-all runs, and every name `--skip` accepts (those plus the aggregates it already drops). */
interface CheckNames {
  run: string[];
  known: Set<string>;
  scripts: Record<string, string>;
}

/**
 * The selected checks read from `root`'s package.json. `announce` prints the covered-aggregate
 * skip line; callers that only need the names (or are planning) pass false so it is printed once
 * per real run and never in `--for-changed` mode.
 */
function checkNames(root: string, announce = true): CheckNames {
  const manifest = path.join(root, "package.json");
  let pkg: unknown;
  try {
    pkg = parseJson(fs.readFileSync(manifest, "utf8"));
  } catch (error) {
    // A malformed manifest is a repository error, not a check failure — say so plainly
    // instead of surfacing a raw SyntaxError.
    console.error(`check-all: cannot read ${manifest}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const scripts = scriptsOf(pkg);
  const names = Object.keys(scripts)
    .filter((name) => CHECK_NAME_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .concat(CHECK_NAME_EXACT)
    .filter((name) => name in scripts);
  const covered = coveredAggregates(scripts, names);
  if (announce) for (const [name, via] of covered) console.log(`check-all: skipping ${name}: every file it runs is already its own check (${via.join(", ")})`);
  return { run: names.filter((name) => !covered.has(name)).sort(), known: new Set(names), scripts };
}

/** `--skip` names that are not a check, so a typo is an error rather than a silent full run. */
export function unknownSkips(skip: ReadonlySet<string>, known: ReadonlySet<string>): string[] {
  return [...skip].filter((name) => !known.has(name)).sort();
}

/**
 * Aggregate scripts whose work check-all already does. `test:security` is a chain of
 * `node tests/x.mjs && node tests/y.mjs ...`; when every file in such a chain is also the whole
 * command of another included script, running the chain repeats those checks (about a quarter of a
 * full run). A chain with even one file no other script runs is kept, so adding a file to it without
 * giving it a script of its own never drops that file from the gate. Returns name -> covering scripts.
 */
export function coveredAggregates(scripts: Readonly<Record<string, string>>, included: readonly string[]): Map<string, string[]> {
  const singles = new Map<string, string>();
  for (const name of included) {
    const file = /^node (\S+)$/.exec(scripts[name] ?? "")?.[1];
    if (file !== undefined && !singles.has(file)) singles.set(file, name);
  }
  const covered = new Map<string, string[]>();
  for (const name of included) {
    const parts = (scripts[name] ?? "").split(" && ");
    if (parts.length < 2) continue;
    const via: string[] = [];
    for (const part of parts) {
      const file = /^node (\S+)$/.exec(part)?.[1];
      const owner = file ? singles.get(file) : undefined;
      if (!owner || owner === name) break;
      via.push(owner);
    }
    if (via.length === parts.length) covered.set(name, via);
  }
  return covered;
}

function listJsonNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Most checks take no arguments. `profile:check` takes exactly one target per invocation
 * (see its header), so cover every shipped profile rather than failing on a missing
 * argument — which is what a bare run does.
 */
function argumentSetsFor(name: string, root: string): string[][] {
  if (name !== "profile:check") return [[]];
  const targets = listJsonNames(path.join(root, "packages", "kit", "profiles")).map((p) => ["--profile", p]);
  return targets.length > 0 ? targets : [[]];
}

function wiringFailures(root: string): string[] {
  let scripts: Record<string, string> = {};
  try { scripts = scriptsOf(parseJson(fs.readFileSync(path.join(root, "package.json"), "utf8"))); } catch { /* checkNames reports it */ }
  return describeProblems(findWiringProblems({ root, scripts }));
}

/** The selected runs, one entry per `npm run` invocation (profile:check expands per profile). */
function buildRuns(options: CheckAllOptions, root: string): CheckRun[] {
  const { run: names } = checkNames(root, false);
  const runs: CheckRun[] = [];
  for (const name of names) {
    if (options.skip.has(name)) continue;
    for (const args of argumentSetsFor(name, root)) {
      runs.push({ name, args, label: [name, ...args].join(" ") });
    }
  }
  return runs;
}

/** How long a timed-out check gets to exit after SIGTERM before it is sent SIGKILL. */
const KILL_GRACE_MS = 5000;

/** The block header printed before a check's output. */
function header(label: string): string {
  return `\n=== ${label} ${"-".repeat(Math.max(1, 60 - label.length))}`;
}

/**
 * Process groups of the checks running under `--check-timeout`. Each such check runs as the
 * leader of its own group (POSIX `detached`), so a timeout can stop the shell and every
 * process the script started, not only npm: `/bin/sh -c` (dash, on Ubuntu runners) does not
 * exec the script's last command, so killing npm alone left the script running and holding the
 * inherited stdout pipe open. A group of its own no longer receives the terminal's Ctrl-C, so
 * the signals below are forwarded to every live group before check-all exits.
 */
const liveGroups = new Set<number>();
let forwardingSignals = false;

function forwardStopSignals(): void {
  if (forwardingSignals) return;
  forwardingSignals = true;
  const codes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  for (const [signal, code] of Object.entries(codes)) {
    process.on(signal, () => {
      reapGroups();
      process.exit(code);
    });
  }
}

/** SIGKILL every group still listed, so nothing a stopped check started outlives the run. */
function reapGroups(): void {
  for (const pid of liveGroups) signalGroup(pid, "SIGKILL");
  liveGroups.clear();
}

/** Send `signal` to the process group led by `pid`; a group that has already gone is fine. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * Start one `npm run` for `run`. With `timeoutSeconds`, the check is stopped once it has run that
 * long: on POSIX its whole process group gets SIGTERM, then SIGKILL after a grace period; on
 * Windows `taskkill /T /F` ends the process tree. `onTimeout` is called once, at the deadline.
 */
function startCheck(
  run: CheckRun,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdio: "inherit" | "pipe",
  timeoutSeconds: number | null,
  onTimeout: () => void,
): { child: ChildProcess; settle: () => void } {
  const npm = resolveNpmCommand();
  const group = timeoutSeconds !== null && process.platform !== "win32";
  if (group) forwardStopSignals();
  const child = spawn(npm.command, ["run", "-s", run.name, ...(run.args.length ? ["--", ...run.args] : [])], {
    cwd,
    env,
    shell: npm.shell,
    stdio: ["ignore", stdio, stdio],
    detached: group,
  });
  const pid = child.pid;
  if (group && pid !== undefined) liveGroups.add(pid);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  if (timeoutSeconds !== null && pid !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      if (group) {
        signalGroup(pid, "SIGTERM");
        // The group is killed even after its leader exits: a script that ignores SIGTERM must
        // not outlive the run.
        setTimeout(() => { signalGroup(pid, "SIGKILL"); liveGroups.delete(pid); }, KILL_GRACE_MS).unref();
      } else {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      }
      onTimeout();
    }, timeoutSeconds * 1000);
  }
  const settle = (): void => {
    clearTimeout(timer);
    // A timed-out group stays listed until it is sent SIGKILL (by the grace timer or by
    // `reapGroups` when the run ends), even though its leader has exited.
    if (pid !== undefined && !timedOut) liveGroups.delete(pid);
  };
  return { child, settle };
}

/**
 * Start one `npm run` and resolve with its buffered output and status once it exits. A start line
 * is printed at once, so a log cut short (a CI job timeout) still names every check that was
 * running. With `timeoutSeconds`, a check still running then is stopped with every process it
 * started (`startCheck`) and resolves at once as failed with its partial output, without waiting
 * for a process that escaped its group and still holds the pipes open.
 */
function runBuffered(run: CheckRun, cwd: string, env: NodeJS.ProcessEnv, timeoutSeconds: number | null): Promise<RunResult> {
  console.log(`... ${run.label} started`);
  return new Promise((resolve) => {
    const began = Date.now();
    const elapsed = (): string => ((Date.now() - began) / 1000).toFixed(1);
    let stdout = "";
    let stderr = "";
    const { child, settle } = startCheck(run, cwd, env, "pipe", timeoutSeconds, () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ ok: false, detail: `timed out after ${String(timeoutSeconds)}s`, seconds: elapsed(), output: stdout + stderr });
    });
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      settle();
      resolve({ ok: false, detail: `spawn error: ${error.message}`, seconds: elapsed(), output: stdout + stderr });
    });
    child.on("close", (code, signal) => {
      settle();
      // A missing binary or a killed process has status null; report it rather than
      // treating it as success.
      const detail = code === null ? `signal ${String(signal)}` : `exit ${code}`;
      resolve({ ok: code === 0, detail, seconds: elapsed(), output: stdout + stderr });
    });
  });
}

/**
 * Run one check with its output streamed straight to this process (the sequential path) under a
 * timeout, and resolve with its status. The output is already printed, so `output` is empty.
 */
function runInherited(run: CheckRun, cwd: string, timeoutSeconds: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const began = Date.now();
    const elapsed = (): string => ((Date.now() - began) / 1000).toFixed(1);
    const { child, settle } = startCheck(run, cwd, process.env, "inherit", timeoutSeconds, () => {
      resolve({ ok: false, detail: `timed out after ${String(timeoutSeconds)}s`, seconds: elapsed(), output: "" });
    });
    child.on("error", (error) => {
      settle();
      resolve({ ok: false, detail: `spawn error: ${error.message}`, seconds: elapsed(), output: "" });
    });
    child.on("exit", (code, signal) => {
      settle();
      resolve({ ok: code === 0, detail: code === null ? `signal ${String(signal)}` : `exit ${code}`, seconds: elapsed(), output: "" });
    });
  });
}

/**
 * Print one buffered check's block, then return its failure line when it failed. Printing at
 * completion (not at start) keeps each check's output whole and readable even when several run
 * at once.
 */
function report(run: CheckRun, result: RunResult): string | null {
  console.log(header(run.label));
  process.stdout.write(result.output);
  if (result.output !== "" && !result.output.endsWith("\n")) process.stdout.write("\n");
  if (result.ok) {
    console.log(`--- ${run.label}: OK (${result.seconds}s)`);
    return null;
  }
  console.log(`--- ${run.label}: FAILED (${result.detail}, ${result.seconds}s)`);
  return `${run.label} (${result.detail})`;
}

/**
 * Run every selected check and return the process exit code. `root` is the package.json the
 * checks are read from; it defaults to this checkout, and the smoke test points it at a
 * scratch manifest to exercise `--jobs` over fake checks.
 */
export async function runAll(options: CheckAllOptions, root: string = ROOT): Promise<number> {
  // Plan mode runs nothing, so the covered-aggregate skip line would contradict the plan; it is
  // printed once here for a real run and not at all while planning.
  const { run: names, known, scripts } = checkNames(root, options.forChanged === null);

  if (names.length === 0) {
    console.error("check-all: no check scripts found — is package.json correct?");
    return 2;
  }

  // A plan request never runs anything: it maps the changed paths to checks and prints the split,
  // so a cycle can list every check as RAN or SKIPPED before it commits.
  if (Array.isArray(options.forChanged)) {
    // `names` is the runnable gate list (covered aggregates already removed), so the plan lists
    // exactly the checks the gate runs; the aggregate is not a gate check and is not skipped here.
    const plan = verifyPlan(options.forChanged, names, scripts);
    console.log(`check-all: plan for ${options.forChanged.length} changed path(s)`);
    for (const name of plan.run) console.log(`check-all: run: ${name}`);
    for (const name of plan.skipped) console.log(`check-all: skipped: ${name}`);
    return 0;
  }

  const unknown = unknownSkips(options.skip, known);
  if (unknown.length > 0) {
    console.error(`check-all: --skip names no check: ${unknown.join(", ")} (see --list for the check names)`);
    return 2;
  }

  const runs = buildRuns(options, root);
  if (runs.length === 0) {
    console.error("check-all: every check was skipped");
    return 2;
  }

  const selected = options.shard ? shardRuns(runs, options.shard) : runs;

  if (options.list) {
    for (const run of selected) console.log(run.label);
    console.log(`\ncheck-all: ${selected.length} check run(s) would run`);
    return 0;
  }

  const scope = options.shard ? ` (shard ${options.shard.index}/${options.shard.count})` : "";
  console.log(`check-all: running ${selected.length} check run(s)${scope}\n`);
  const failures: string[] = [];
  const started = Date.now();

  // A test nobody runs is worse than no test: fail the gate, but still run everything else so
  // one pass reports every problem.
  for (const problem of wiringFailures(root)) {
    console.error(`check-all: ${problem}`);
    failures.push(`wiring: ${problem}`);
  }

  if (options.jobs > 1) {
    // The eval harness writes its transpile cache under this directory; give each concurrent
    // worker its own copy so two checks never rewrite (or import) the same cached module.
    // Keep the per-worker caches under the checkout's node_modules so a compiled module still
    // resolves the repository's bare imports (`@earendil-works/pi-*`, `typebox`).
    fs.mkdirSync(path.join(ROOT, "node_modules", ".cache"), { recursive: true });
    const cacheRoot = fs.mkdtempSync(path.join(ROOT, "node_modules", ".cache", "pi-kit-check-all-"));
    const workerEnv = (slot: number): NodeJS.ProcessEnv => ({ ...process.env, PI_EVAL_CACHE_DIR: path.join(cacheRoot, `w${slot}`) });
    try {
      const parallel = selected.filter((run) => !SERIAL.has(run.name));
      const serial = selected.filter((run) => SERIAL.has(run.name));
      // Failures are keyed by run and reported in list order below, so the summary does not
      // depend on which concurrent check happened to finish first.
      const failed = new Map<CheckRun, string>();
      await runPool(parallel, options.jobs, root, workerEnv, options.checkTimeout, failed);
      // Serial checks run alone: the parallel batch has finished, so they use the shared cache
      // exactly as a sequential run would.
      for (const run of serial) {
        const failure = report(run, await runBuffered(run, root, process.env, options.checkTimeout));
        if (failure !== null) failed.set(run, failure);
      }
      for (const run of selected) {
        const failure = failed.get(run);
        if (failure !== undefined) failures.push(failure);
      }
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  } else {
    for (const run of selected) {
      const began = Date.now();
      console.log(header(run.label));
      if (options.checkTimeout !== null) {
        // A Promise resolves once, so a timeout reports before any late exit of the stopped check.
        const result = await runInherited(run, root, options.checkTimeout);
        if (result.ok) {
          console.log(`--- ${run.label}: OK (${result.seconds}s)`);
        } else {
          console.log(`--- ${run.label}: FAILED (${result.detail}, ${result.seconds}s)`);
          failures.push(`${run.label} (${result.detail})`);
        }
        continue;
      }
      const npm = resolveNpmCommand();
      const result = spawnSync(npm.command, ["run", "-s", run.name, ...(run.args.length ? ["--", ...run.args] : [])], {
        cwd: root,
        stdio: "inherit",
        env: process.env,
        shell: npm.shell,
      });
      const seconds = ((Date.now() - began) / 1000).toFixed(1);
      if (result.status === 0) {
        console.log(`--- ${run.label}: OK (${seconds}s)`);
      } else {
        const detail = result.status === null ? `signal ${String(result.signal)}` : `exit ${result.status}`;
        console.log(`--- ${run.label}: FAILED (${detail}, ${seconds}s)`);
        failures.push(`${run.label} (${detail})`);
      }
    }
  }

  reapGroups();
  const total = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length > 0) {
    console.error(`\ncheck-all: ${failures.length}/${selected.length} FAILED in ${total}s`);
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log(`\ncheck-all: all ${selected.length} check run(s) passed in ${total}s`);
  return 0;
}

/**
 * Run `runs` with at most `jobs` at once. Each run gets its own eval cache slot (its position in
 * `runs`), so no two concurrent checks share a transpile cache directory.
 */
async function runPool(
  runs: readonly CheckRun[],
  jobs: number,
  cwd: string,
  envFor: (slot: number) => NodeJS.ProcessEnv,
  timeoutSeconds: number | null,
  failed: Map<CheckRun, string>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const slot = next++;
      const run = runs[slot];
      if (run === undefined) return;
      const failure = report(run, await runBuffered(run, cwd, envFor(slot), timeoutSeconds));
      if (failure !== null) failed.set(run, failure);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, runs.length) }, worker));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.wiring) {
    const problems = wiringFailures(ROOT);
    for (const line of problems) console.error(`check-all: ${line}`);
    console.log(problems.length ? `check-all: ${problems.length} wiring problem(s)` : "check-all: every test file is wired into a script and asserts something");
    process.exit(problems.length ? 1 : 0);
  }

  process.exitCode = await runAll(options, ROOT);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
