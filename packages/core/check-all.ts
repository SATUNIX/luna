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
 *   node packages/core/check-all.ts             # run everything
 *   node packages/core/check-all.ts --list      # print what would run, run nothing
 *   node packages/core/check-all.ts --skip=eval,smoke:docs   # a name that is not a check exits 2
 *   node packages/core/check-all.ts --check-wiring   # only report unwired / empty tests
 *
 * Exits non-zero if any check fails, printing a summary of all failures (checks are run
 * to completion so one CI run reports every problem, not just the first).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseJson } from "./lib/guard.ts";
import { describeProblems, findWiringProblems } from "./lib/wiring.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INCLUDE_PREFIX = ["smoke:", "test:"];
const INCLUDE_EXACT = ["verify", "eval", "docs:check", "docs:mermaid", "profile:check"];

/**
 * Resolve the npm executable for the running platform. Windows needs the `.cmd`
 * shim and `shell: true` (Node cannot spawn a `.cmd` directly); other platforms
 * use the bare binary without a shell, mirroring pack-check.ts.
 */
export function resolveNpmCommand(platform: NodeJS.Platform = process.platform): { command: string; shell: boolean } {
  const win = platform === "win32";
  return { command: win ? "npm.cmd" : "npm", shell: win };
}

interface CheckAllOptions {
  list: boolean;
  wiring: boolean;
  skip: Set<string>;
}

/** One `npm run <name> [-- args]` invocation. */
interface CheckRun {
  name: string;
  args: string[];
  label: string;
}

/** package.json `scripts`, keeping only string commands (npm runs nothing else). */
function scriptsOf(pkg: unknown): Record<string, string> {
  const scripts = isRecord(pkg) ? pkg.scripts : undefined;
  const out: Record<string, string> = {};
  if (!isRecord(scripts)) return out;
  for (const [name, command] of Object.entries(scripts)) if (typeof command === "string") out[name] = command;
  return out;
}

function parseArgs(argv: readonly string[]): CheckAllOptions {
  const options: CheckAllOptions = { list: false, wiring: false, skip: new Set() };
  for (const arg of argv) {
    if (arg === "--list") options.list = true;
    else if (arg === "--check-wiring") options.wiring = true;
    else if (arg.startsWith("--skip=")) {
      for (const name of arg.slice("--skip=".length).split(",")) {
        if (name.trim()) options.skip.add(name.trim());
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: node packages/core/check-all.ts [--list] [--check-wiring] [--skip=a,b]");
      process.exit(0);
    } else {
      console.error(`check-all: unknown argument "${arg}" (try --help)`);
      process.exit(2);
    }
  }
  return options;
}

/** The checks check-all runs, and every name `--skip` accepts (those plus the aggregates it already drops). */
interface CheckNames {
  run: string[];
  known: Set<string>;
}

function checkNames(): CheckNames {
  const manifest = path.join(ROOT, "package.json");
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
    .filter((name) => INCLUDE_PREFIX.some((prefix) => name.startsWith(prefix)))
    .concat(INCLUDE_EXACT)
    .filter((name) => name in scripts);
  const covered = coveredAggregates(scripts, names);
  for (const [name, via] of covered) console.log(`check-all: skipping ${name}: every file it runs is already its own check (${via.join(", ")})`);
  return { run: names.filter((name) => !covered.has(name)).sort(), known: new Set(names) };
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
function argumentSetsFor(name: string): string[][] {
  if (name !== "profile:check") return [[]];
  const targets = listJsonNames(path.join(ROOT, "packages", "kit", "profiles")).map((p) => ["--profile", p]);
  return targets.length > 0 ? targets : [[]];
}

function wiringFailures(): string[] {
  let scripts: Record<string, string> = {};
  try { scripts = scriptsOf(parseJson(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))); } catch { /* checkNames reports it */ }
  return describeProblems(findWiringProblems({ root: ROOT, scripts }));
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.wiring) {
    const problems = wiringFailures();
    for (const line of problems) console.error(`check-all: ${line}`);
    console.log(problems.length ? `check-all: ${problems.length} wiring problem(s)` : "check-all: every test file is wired into a script and asserts something");
    process.exit(problems.length ? 1 : 0);
  }

  const { run: names, known } = checkNames();

  if (names.length === 0) {
    console.error("check-all: no check scripts found — is package.json correct?");
    process.exit(2);
  }

  const unknown = unknownSkips(options.skip, known);
  if (unknown.length > 0) {
    console.error(`check-all: --skip names no check: ${unknown.join(", ")} (see --list for the check names)`);
    process.exit(2);
  }

  // Each run is one `npm run <script> [-- args]` invocation.
  const runs: CheckRun[] = [];
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
  const failures: string[] = [];
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
      const detail = result.status === null ? `signal ${String(result.signal)}` : `exit ${result.status}`;
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
