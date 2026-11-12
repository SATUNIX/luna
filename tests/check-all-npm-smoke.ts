#!/usr/bin/env node
/**
 * B-097 regression coverage: the check-suite runner must resolve an npm command
 * that works on Windows (`npm.cmd` + shell), matching pack-check.ts. Also asserts
 * that importing the module no longer runs the suite (is-main guard), so `--list`
 * can be exercised.
 *
 * Deterministic and offline - no pi/docker/network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SERIAL, coveredAggregates, resolveNpmCommand, shardRuns, unknownSkips } from "../packages/core/check-all.ts";
import { splitCoverageArgs } from "../packages/core/coverage.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(
  resolveNpmCommand("win32"),
  // eslint-disable-next-line no-restricted-syntax -- the expected value: this test pins the win32 npm.cmd shim that needs a shell
  { command: "npm.cmd", shell: true },
  "win32 must use the npm.cmd shim with shell:true",
);
assert.deepEqual(resolveNpmCommand("linux"), { command: "npm", shell: false });
assert.deepEqual(resolveNpmCommand("darwin"), { command: "npm", shell: false });

// Importing the module must not have started the suite; --list runs and exits 0.
const cli = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), "--list"], {
  encoding: "utf8",
});
assert.equal(cli.status, 0, `check-all --list must exit 0 (stderr: ${cli.stderr.trim()})`);
assert.match(cli.stdout, /check-all: \d+ check run\(s\) would run/);

// An aggregate is skipped only when every file it runs is the whole command of another check.
const scripts = {
  "smoke:a": "node tests/a-smoke.mjs",
  "smoke:b": "node tests/b-smoke.mjs",
  "smoke:c": "node tests/c-smoke.mjs --flag",
  "test:agg": "node tests/a-smoke.mjs && node tests/b-smoke.mjs",
  "test:partial": "node tests/a-smoke.mjs && node tests/new-smoke.mjs",
  "test:flagged": "node tests/a-smoke.mjs && node tests/c-smoke.mjs",
  "test:single": "node tests/z-smoke.mjs",
  "test:shell": "node tests/a-smoke.mjs && echo done",
};
const included = Object.keys(scripts);
const covered = coveredAggregates(scripts, included);
assert.deepEqual([...covered.keys()], ["test:agg"], "only a chain fully covered by other checks is skipped");
assert.deepEqual(covered.get("test:agg"), ["smoke:a", "smoke:b"]);
assert.ok(!covered.has("test:partial"), "a chain with a file no other check runs must keep running");
assert.ok(!covered.has("test:flagged"), "a file another check runs with different arguments is not covered");
assert.ok(!covered.has("test:single") && !covered.has("test:shell"), "a single command or a non-node step is never an aggregate");
const twins = coveredAggregates({ "test:x": "node tests/a.mjs && node tests/b.mjs", "test:y": "node tests/a.mjs && node tests/b.mjs" }, ["test:x", "test:y"]);
assert.equal(twins.size, 0, "two chains covering only each other would drop the files entirely, so neither is skipped");

// In this repository the security chain is covered, so check-all lists each of its files once.
const list = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), "--list"], { encoding: "utf8" });
assert.match(list.stdout, /skipping test:security/, "test:security repeats checks that run on their own");
assert.equal((list.stdout.match(/skipping test:security/g) ?? []).length, 1, "the covered-aggregate line prints exactly once per run");
assert.doesNotMatch(list.stdout, /^test:security$/m, "test:security is not run twice");
assert.match(list.stdout, /^smoke:tool-firewall$/m, "its one uncovered file has its own check");

// A --skip name that is not a check is an error (exit 2), not a silent full run.
assert.deepEqual(unknownSkips(new Set(["evl", "eval", "smoke:doc"]), new Set(["eval", "smoke:docs"])), ["evl", "smoke:doc"]);
assert.deepEqual(unknownSkips(new Set(), new Set(["eval"])), []);
const typo = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), "--list", "--skip=evl,smoke:doc"], { encoding: "utf8" });
assert.equal(typo.status, 2, "a misspelt --skip name exits 2");
assert.match(typo.stderr, /--skip names no check: evl, smoke:doc/);
assert.doesNotMatch(typo.stdout, /would run/, "nothing is listed when a skip name is unknown");
const skipped = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), "--list", "--skip=eval,test:security"], { encoding: "utf8" });
assert.equal(skipped.status, 0, `real check names, including an aggregate check-all drops itself, are accepted (stderr: ${skipped.stderr.trim()})`);
assert.doesNotMatch(skipped.stdout, /^eval$/m, "a skipped check is not listed");


// Sharding: exactly one shard per run, disjoint and balanced, and stable for the same input.
const items = Array.from({ length: 10 }, (_, i) => `check-${i}`);
const shards = [1, 2, 3, 4].map((index) => shardRuns(items, { index, count: 4 }));
const union = shards.flat();
assert.equal(union.length, items.length, "every run lands in exactly one shard");
assert.deepEqual([...union].sort(), [...items].sort(), "the shards together cover every run");
assert.equal(new Set(union).size, items.length, "the shards are disjoint");
for (const shard of shards) assert.ok(Math.abs(shard.length - items.length / 4) <= 1, `shard sizes stay balanced: ${shard.length}`);
assert.deepEqual(shardRuns(items, { index: 2, count: 4 }), shards[1], "the same input partitions the same way (stable)");
assert.deepEqual(shardRuns(["only"], { index: 2, count: 4 }), [], "a shard with no run of its own is empty, not duplicated");

// The real check list shards the same way: the four --list outputs are disjoint and cover all.
const checkAll = path.join(ROOT, "packages", "core", "check-all.ts");

// The plan lists exactly the gate's checks: a changed copy-pair source or test file plans the
// check that asserts or runs it, and plan mode never prints the covered-aggregate skip line.
const planFor = (p: string): string => {
  const out = spawnSync(process.execPath, [checkAll, `--for-changed=${p}`], { encoding: "utf8" });
  assert.equal(out.status, 0, `check-all --for-changed=${p} exits 0 (stderr: ${out.stderr.trim()})`);
  return out.stdout;
};
const guardPlan = planFor("packages/extensions/src/secret-guard/index.ts");
assert.match(guardPlan, /^check-all: run: smoke:workflow-notify$/m, "a copy-pair source plans smoke:workflow-notify");
assert.doesNotMatch(guardPlan, /skipping test:security/, "plan mode prints no covered-aggregate skip line");
const testPlan = planFor("tests/autonomy-selfimprove-smoke.ts");
assert.match(testPlan, /^check-all: run: smoke:autonomy-selfimprove$/m, "a changed test file plans its own check");

const listLabels = (args: string[]): string[] => {
  const out = spawnSync(process.execPath, [checkAll, "--list", ...args], { encoding: "utf8" });
  assert.equal(out.status, 0, `check-all --list ${args.join(" ")} exits 0 (stderr: ${out.stderr.trim()})`);
  return out.stdout.split("\n").filter((line) => line !== "" && !line.startsWith("check-all:"));
};
const fullList = listLabels([]);
const realShards = [1, 2, 3, 4].flatMap((index) => listLabels([`--shard=${index}/4`]));
assert.deepEqual([...realShards].sort(), [...fullList].sort(), "the four real shards cover the full check list");
assert.equal(new Set(realShards).size, fullList.length, "the real shards are disjoint");
assert.ok(realShards.every((label) => fullList.includes(label)), "a shard never invents a check");

// Bad shard and job arguments exit 2, like every other bad argument.
for (const bad of ["--shard=0/4", "--shard=5/4", "--shard=1/0", "--shard=abc", "--shard=1", "--shard=1/4/2", "--jobs=0", "--jobs=abc", "--jobs=-1", "--jobs=1.5", "--check-timeout=0", "--check-timeout=abc", "--check-timeout=1.5"]) {
  const result = spawnSync(process.execPath, [checkAll, "--list", bad], { encoding: "utf8" });
  assert.equal(result.status, 2, `check-all --list ${bad} exits 2, got ${result.status}`);
  assert.match(result.stderr, /check-all: --(?:shard|jobs|check-timeout)/, `${bad} is reported`);
  assert.doesNotMatch(result.stdout, /would run/, `${bad} lists nothing`);
}
for (const ok of ["--shard=1/4", "--shard=4/4", "--jobs=1", "--jobs=8", "--check-timeout=600"]) {
  assert.equal(spawnSync(process.execPath, [checkAll, "--list", ok], { encoding: "utf8" }).status, 0, `check-all --list ${ok} exits 0`);
}

// Every serial entry names a real check and gives its reason: a renamed script must not silently
// drop out of the serial list and start running beside other checks.
for (const [name, reason] of SERIAL) {
  assert.ok(fullList.some((label) => label === name || label.startsWith(`${name} `)), `serial check ${name} is a real check`);
  assert.ok(reason.length > 20, `serial check ${name} states why it runs alone`);
}

// coverage attributes transpiled modules by the shared cache path, so it refuses --jobs.
const coverageJobs = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "coverage.ts"), "--jobs=2"], { encoding: "utf8" });
assert.equal(coverageJobs.status, 2, `coverage --jobs=2 exits 2 (stderr: ${coverageJobs.stderr.trim()})`);
assert.match(coverageJobs.stderr, /coverage: --jobs=2 is not supported/);

// Coverage's own options are split out before check-all sees the arguments, so --coverage-out can
// preserve a CI shard's raw V8 data and --report can merge it without running checks again.
assert.deepEqual(splitCoverageArgs([]), { report: null, coverageOut: null, checkAllArgs: [] });
assert.deepEqual(splitCoverageArgs(["--report", "coverage-raw"]), { report: "coverage-raw", coverageOut: null, checkAllArgs: [] });
assert.deepEqual(splitCoverageArgs(["--report=coverage-raw"]), { report: "coverage-raw", coverageOut: null, checkAllArgs: [] });
assert.deepEqual(splitCoverageArgs(["--shard=1/4", "--coverage-out=coverage-raw", "--check-timeout=600"]), { report: null, coverageOut: "coverage-raw", checkAllArgs: ["--shard=1/4", "--check-timeout=600"] });
assert.deepEqual(splitCoverageArgs(["--report"]), { report: null, coverageOut: null, checkAllArgs: [] }, "a bare --report has no directory and is rejected by the CLI");
const coverageReport = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "coverage.ts"), "--report"], { encoding: "utf8" });
assert.equal(coverageReport.status, 2, "coverage --report without a directory exits 2");
assert.match(coverageReport.stderr, /coverage: --report needs a directory/);

// --jobs runs the same checks with the same status and summary as --jobs=1, including failures,
// and a serial check runs alone. Each fake check logs when it starts and ends.
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-check-all-fake-"));
try {
  const logged = (name: string, ms: number, code: number): string =>
    `node -e "const f=require('fs'),l=process.env.CHECK_LOG;f.appendFileSync(l,'start ${name} '+Date.now()+'\\n');setTimeout(()=>{f.appendFileSync(l,'end ${name} '+Date.now()+'\\n');process.exit(${code})},${ms})"`;
  const serialName = [...SERIAL.keys()][0] ?? "";
  assert.ok(serialName !== "", "the serial list is not empty");
  fs.writeFileSync(path.join(fakeRoot, "package.json"), `${JSON.stringify({
    name: "fake-checks",
    private: true,
    scripts: {
      "smoke:a-fail-slow": logged("a-fail-slow", 400, 4),
      "smoke:ok": logged("ok", 0, 0),
      "smoke:slow": logged("slow", 200, 0),
      "smoke:z-fail-fast": logged("z-fail-fast", 0, 3),
      [serialName]: logged("serial", 50, 0),
      // Prints, records its pid, ignores SIGTERM and never exits: only --check-timeout ends it.
      // The trailing `; true` keeps the shell from exec'ing node (as dash, Ubuntu's /bin/sh,
      // does not), so the hung process is npm's grandchild, holding the inherited stdout pipe.
      // Skipped unless a run asks for it.
      "smoke:m-hang": `node -e "require('fs').writeFileSync(process.env.HANG_PID,String(process.pid));process.on('SIGTERM',()=>{});console.log('hang-partial-output');setInterval(()=>{},1000)"; true`,
    },
  }, null, 2)}\n`);
  const wrapper = path.join(fakeRoot, "run.mjs");
  fs.writeFileSync(wrapper, `import { runAll } from ${JSON.stringify(pathToFileURL(checkAll).href)};\nprocess.exitCode = await runAll({ list: false, wiring: false, skip: new Set((process.env.SKIP ?? "").split(",").filter(Boolean)), shard: null, jobs: Number(process.env.JOBS), checkTimeout: process.env.TIMEOUT ? Number(process.env.TIMEOUT) : null }, process.env.FAKE_ROOT);\n`);
  const runFake = (jobs: number, skip = "", { hang = false, timeout = "" } = {}) => {
    const skips = [skip, hang ? "" : "smoke:m-hang"].filter(Boolean).join(",");
    const log = path.join(fakeRoot, `log-${jobs}-${skips}-${String(hang)}.txt`);
    fs.writeFileSync(log, "");
    // The outer timeout only stops a regression from hanging this smoke; the runs below finish in seconds.
    const result = spawnSync(process.execPath, [wrapper], { encoding: "utf8", timeout: 60_000, env: { ...process.env, JOBS: String(jobs), SKIP: skips, TIMEOUT: timeout, FAKE_ROOT: fakeRoot, CHECK_LOG: log, HANG_PID: path.join(fakeRoot, "hang.pid") } });
    return { ...result, log: fs.readFileSync(log, "utf8") };
  };
  // The failure summary without its timing: the count line and the failed checks, in order.
  const summaryOf = (err: string): string[] =>
    err.split("\n").filter((line) => /^check-all: \d+\/\d+ FAILED|^ {2}- /.test(line)).map((line) => line.replace(/ in [\d.]+s$/, ""));
  const one = runFake(1);
  const three = runFake(3);
  assert.equal(one.status, 1, `--jobs=1 reports the failing checks (stdout: ${one.stdout})`);
  assert.equal(three.status, 1, `--jobs=3 reports the failing checks (stdout: ${three.stdout})`);
  assert.deepEqual(summaryOf(one.stderr), ["check-all: 2/5 FAILED", "  - smoke:a-fail-slow (exit 4)", "  - smoke:z-fail-fast (exit 3)"], one.stderr);
  assert.deepEqual(summaryOf(three.stderr), summaryOf(one.stderr), "--jobs=3 prints the same failure summary, in list order, as --jobs=1");
  for (const out of [one.stdout, three.stdout]) {
    assert.match(out, /--- smoke:a-fail-slow: FAILED \(exit 4/);
    assert.match(out, /--- smoke:z-fail-fast: FAILED \(exit 3/);
    assert.match(out, /--- smoke:ok: OK/);
    assert.match(out, /--- smoke:slow: OK/);
    assert.match(out, new RegExp(`--- ${serialName}: OK`));
  }
  // Under --jobs=3 the parallel checks overlapped, and the serial check started after all of them ended.
  const times = (log: string, kind: "start" | "end"): Map<string, number> =>
    new Map(log.split("\n").filter((line) => line.startsWith(`${kind} `)).map((line) => {
      const [, name = "", at = "0"] = line.split(" ");
      return [name, Number(at)];
    }));
  const starts = times(three.log, "start");
  const ends = times(three.log, "end");
  assert.equal(starts.size, 5, three.log);
  assert.ok((starts.get("ok") ?? Infinity) < (ends.get("a-fail-slow") ?? 0), `--jobs=3 runs checks at once (log: ${three.log})`);
  const lastParallelEnd = Math.max(...["a-fail-slow", "ok", "slow", "z-fail-fast"].map((name) => ends.get(name) ?? Infinity));
  assert.ok((starts.get("serial") ?? 0) >= lastParallelEnd, `the serial check runs alone, after the parallel batch (log: ${three.log})`);
  // Output stays whole per check: each block header is followed by its own result line.
  const blocks = three.stdout.split("\n=== ").slice(1);
  assert.equal(blocks.length, 5, three.stdout);
  for (const block of blocks) {
    const label = block.split(" ")[0] ?? "";
    assert.match(block, new RegExp(`--- ${label}: (?:OK|FAILED)`), `the ${label} block is whole`);
  }
  const passOne = runFake(1, "smoke:a-fail-slow,smoke:z-fail-fast");
  const passThree = runFake(3, "smoke:a-fail-slow,smoke:z-fail-fast");
  assert.equal(passOne.status, 0, `--jobs=1 passes when the failures are skipped (stderr: ${passOne.stderr})`);
  assert.equal(passThree.status, 0, `--jobs=3 passes when the failures are skipped (stderr: ${passThree.stderr})`);
  assert.match(passOne.stdout, /check-all: all 3 check run\(s\) passed/);
  assert.match(passThree.stdout, /check-all: all 3 check run\(s\) passed/);

  // Under --jobs every check announces itself when it starts, before its block, so a log cut
  // short by a CI job timeout still names what was running.
  for (const name of ["smoke:a-fail-slow", "smoke:ok", "smoke:slow", "smoke:z-fail-fast", serialName]) {
    const startAt = three.stdout.indexOf(`... ${name} started`);
    assert.ok(startAt >= 0, `--jobs=3 prints a start line for ${name} (stdout: ${three.stdout})`);
    assert.ok(startAt < three.stdout.indexOf(`\n=== ${name} `), `${name} is announced before its block`);
  }
  assert.ok(three.stdout.indexOf("... smoke:ok started") < three.stdout.indexOf("\n=== smoke:a-fail-slow "), "a check is announced while another is still running");

  // --check-timeout stops a hung check, prints what it wrote so far and fails it by name, in the
  // buffered and the sequential path alike; the other checks still run and report.
  for (const jobs of [1, 2]) {
    const hung = runFake(jobs, "smoke:a-fail-slow,smoke:z-fail-fast", { hang: true, timeout: "2" });
    assert.equal(hung.error, undefined, `--jobs=${jobs} with a hung check finishes (it did not: ${String(hung.error)})`);
    assert.equal(hung.status, 1, `--jobs=${jobs} fails the hung check (stdout: ${hung.stdout})`);
    assert.match(hung.stdout, /hang-partial-output/, `--jobs=${jobs} keeps the hung check's partial output`);
    assert.match(hung.stdout, /--- smoke:m-hang: FAILED \(timed out after 2s/, `--jobs=${jobs} names the timeout`);
    assert.deepEqual(summaryOf(hung.stderr), ["check-all: 1/4 FAILED", "  - smoke:m-hang (timed out after 2s)"], hung.stderr);
    for (const name of ["ok", "slow", serialName]) assert.match(hung.stdout, new RegExp(`--- ${name.startsWith("smoke:") ? name : `smoke:${name}`}: OK`));
    if (jobs > 1) assert.match(hung.stdout, /\.\.\. smoke:m-hang started/, "the hung check was announced when it started");
    // The hung grandchild (which ignored SIGTERM) did not outlive the run: its group was killed.
    if (process.platform !== "win32") {
      const pid = Number(fs.readFileSync(path.join(fakeRoot, "hang.pid"), "utf8"));
      // A killed orphan is reaped by init a moment later, and answers signal 0 until then.
      const isAlive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 3000;
      while (isAlive() && Date.now() < deadline) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},100)"]);
      const alive = isAlive();
      if (alive) process.kill(pid, "SIGKILL");
      assert.equal(alive, false, `--jobs=${jobs} leaves no process of the hung check running (pid ${pid})`);
    }
  }
} finally {
  fs.rmSync(fakeRoot, { recursive: true, force: true });
}

console.log("check-all npm smoke: OK");
