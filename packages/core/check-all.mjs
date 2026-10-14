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
 *   node packages/core/check-all.mjs             # run everything
 *   node packages/core/check-all.mjs --list      # print what would run, run nothing
 *   node packages/core/check-all.mjs --skip=eval,smoke:docs
 *   node packages/core/check-all.mjs --check-wiring   # only report unwired / empty tests
 *
 * Exits non-zero if any check fails, printing a summary of all failures (checks are run
 * to completion so one CI run reports every problem, not just the first).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeProblems, findWiringProblems } from "./lib/wiring.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INCLUDE_PREFIX = ["smoke:", "test:"];
const INCLUDE_EXACT = ["verify", "eval", "docs:check", "docs:mermaid", "profile:check"];

/**
 * Resolve the npm executable for the running platform. Windows needs the `.cmd`
 * shim and `shell: true` (Node cannot spawn a `.cmd` directly); other platforms
 * use the bare binary without a shell, mirroring pack-check.mjs.
 */
export function resolveNpmCommand(platform = process.platform) {
  const win = platform === "win32";
  return { command: win ? "npm.cmd" : "npm", shell: win };
}

function parseArgs(argv) {
  const options = { list: false, wiring: false, skip: new Set() };
  for (const arg of argv) {
    if (arg === "--list") options.list = true;
    else if (arg === "--check-wiring") options.wiring = true;
    else if (arg.startsWith("--skip=")) {
      for (const name of arg.slice("--skip=".length).split(",")) {
        if (name.trim()) options.skip.add(name.trim());
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: node packages/core/check-all.mjs [--list] [--check-wiring] [--skip=a,b]");
      process.exit(0);
    } else {
      console.error(`check-all: unknown argument "${arg}" (try --help)`);
      process.exit(2);
    }
  }
  return options;
}

function checkNames() {
  const manifest = path.join(ROOT, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch (error) {
    // A malformed manifest is a repository error, not a check failure — say so plainly
    // instead of surfacing a raw SyntaxError.
    console.error(`check-all: cannot read ${manifest}: ${error.message}`);
    process.exit(2);
  }
  const scripts = pkg.scripts ?? {};
  const names = Object.keys(scripts)
    .filter((name) => INCLUDE_PREFIX.some((prefix) => name.startsWith(prefix)))
    .concat(INCLUDE_EXACT)
    .filter((name) => name in scripts);
  const covered = coveredAggregates(scripts, names);
  for (const [name, via] of covered) console.log(`check-all: skipping ${name}: every file it runs is already its own check (${via.join(", ")})`);
  return names.filter((name) => !covered.has(name)).sort();
}

/**
 * Aggregate scripts whose work check-all already does. `test:security` is a chain of
 * `node tests/x.mjs && node tests/y.mjs ...`; when every file in such a chain is also the whole
 * command of another included script, running the chain repeats those checks (about a quarter of a
 * full run). A chain with even one file no other script runs is kept, so adding a file to it without
 * giving it a script of its own never drops that file from the gate. Returns name -> covering scripts.
 */
export function coveredAggregates(scripts, included) {
  const singles = new Map();
  for (const name of included) {
    const single = /^node (\S+)$/.exec(scripts[name] ?? "");
    if (single && !singles.has(single[1])) singles.set(single[1], name);
  }
  const covered = new Map();
  for (const name of included) {
    const parts = (scripts[name] ?? "").split(" && ");
    const files = parts.map((part) => /^node (\S+)$/.exec(part)?.[1]);
    if (parts.length < 2 || files.some((file) => !file)) continue;
    const via = files.map((file) => singles.get(file));
    if (via.every((owner) => owner && owner !== name)) covered.set(name, via);
  }
  return covered;
}

function listJsonNames(dir) {
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
function argumentSetsFor(name) {
  if (name !== "profile:check") return [[]];
  const targets = listJsonNames(path.join(ROOT, "packages", "kit", "profiles")).map((p) => ["--profile", p]);
  return targets.length > 0 ? targets : [[]];
}

function wiringFailures() {
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts ?? {}; } catch { /* checkNames reports it */ }
  return describeProblems(findWiringProblems({ root: ROOT, scripts }));
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.wiring) {
    const problems = wiringFailures();
    for (const line of problems) console.error(`check-all: ${line}`);
    console.log(problems.length ? `check-all: ${problems.length} wiring problem(s)` : "check-all: every test file is wired into a script and asserts something");
    process.exit(problems.length ? 1 : 0);
  }

  const names = checkNames();

  if (names.length === 0) {
    console.error("check-all: no check scripts found — is package.json correct?");
    process.exit(2);
  }

  // Each run is one `npm run <script> [-- args]` invocation.
  const runs = [];
  for (const name of names) {
    if (options.skip.has(name)) continue;
    for (const args of argumentSetsFor(name)) {
      runs.push({ name, args, label: [name, ...args].join(" ") });
    }
  }

  if (runs.length === 0) {
    console.error("check-all: every check was skipped");
    process.exit(2);
  }

  if (options.list) {
    for (const run of runs) console.log(run.label);
    console.log(`\ncheck-all: ${runs.length} check run(s) would run`);
    return;
  }

  console.log(`check-all: running ${runs.length} check run(s)\n`);
  const failures = [];
  const started = Date.now();

  // A test nobody runs is worse than no test: fail the gate, but still run everything else so
  // one pass reports every problem.
  for (const problem of wiringFailures()) {
    console.error(`check-all: ${problem}`);
    failures.push(`wiring: ${problem}`);
  }

  for (const run of runs) {
    const began = Date.now();
    console.log(`\n=== ${run.label} ${"-".repeat(Math.max(1, 60 - run.label.length))}`);
    const npm = resolveNpmCommand();
    const result = spawnSync(npm.command, ["run", "-s", run.name, ...(run.args.length ? ["--", ...run.args] : [])], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
      shell: npm.shell,
    });
    const seconds = ((Date.now() - began) / 1000).toFixed(1);
    if (result.status === 0) {
      console.log(`--- ${run.label}: OK (${seconds}s)`);
    } else {
      // A missing binary or a killed process has status null; report it rather than
      // treating it as success.
      const detail = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
      console.log(`--- ${run.label}: FAILED (${detail}, ${seconds}s)`);
      failures.push(`${run.label} (${detail})`);
    }
  }

  const total = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length > 0) {
    console.error(`\ncheck-all: ${failures.length}/${runs.length} FAILED in ${total}s`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\ncheck-all: all ${runs.length} check run(s) passed in ${total}s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
