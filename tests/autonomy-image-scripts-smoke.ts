// The autonomy image's shell scripts, run on the host against stubs (no container, no network):
//   - image/gate.sh: check-all runs with --jobs/--check-timeout only when the checked-out tree's
//     check-all supports them, with the job count clamped; a red check-all names the checks that
//     failed as result.json steps and repeats its summary at the end of gate.log; test:security
//     runs separately only when check-all does not already cover it;
//   - image/entrypoint.sh's cycle reset block: a dirty tracked file and unpushed commits never stop
//     the reset (the plain checkout used to abort under set -e before reset --hard ran).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, makeChecker, rm, tempDir } from "./autonomy-helpers.ts";

const { check, done } = makeChecker("autonomy-image-scripts-smoke");
const IMAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "autonomy", "image");
const roots: string[] = [];
const scratch = (): string => { const d = tempDir("autonomy-image-"); roots.push(d); return d; };

/** A gate result.json step. */
interface GateStep { name: string; code: number; seconds: number }

const STUB_NPM = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in
  "ci "*) exit 0 ;;
  "run -s check:all -- --list") printf '%s\\n' "$STUB_LIST"; exit 0 ;;
  "run check:all"*)
    if [ "\${STUB_FAIL:-0}" = 1 ]; then
      echo "--- smoke:a: FAILED (exit 1, 1.0s)"
      printf '\\ncheck-all: 2/5 FAILED in 3.0s\\n  - smoke:a (exit 1)\\n  - smoke:b (timed out after 600s)\\n' >&2
      exit 1
    fi
    echo "check-all: all 5 check run(s) passed"; exit 0 ;;
  "run test:security") exit 0 ;;
esac
echo "unexpected npm call: $*" >&2; exit 9
`;

interface GateRun { code: number | null; npm: string[]; steps: GateStep[]; green: boolean; log: string }

function runGate({ checkAll, jobs, fail = false, list = "smoke:a\nsmoke:b" }: { checkAll: string; jobs?: string; fail?: boolean; list?: string }): GateRun {
  const root = scratch();
  const tree = path.join(root, "tree");
  const bin = path.join(root, "bin");
  const gateDir = path.join(root, "gate");
  fs.mkdirSync(path.join(tree, "packages", "core"), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(gateDir);
  fs.writeFileSync(path.join(tree, "packages", "core", "check-all.ts"), checkAll);
  fs.writeFileSync(path.join(bin, "npm"), STUB_NPM, { mode: 0o755 });
  for (const tool of ["python3", "gitleaks"]) fs.writeFileSync(path.join(bin, tool), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const log = path.join(root, "npm.log");
  const env: Record<string, string> = { PATH: `${bin}:${process.env["PATH"] ?? ""}`, GATE_DIR: gateDir, STUB_LOG: log, STUB_LIST: list, STUB_FAIL: fail ? "1" : "0" };
  if (jobs !== undefined) env["GATE_JOBS"] = jobs;
  const r = spawnSync("bash", [path.join(IMAGE, "gate.sh")], { cwd: tree, env, encoding: "utf8", timeout: 60_000 });
  const result = JSON.parse(fs.readFileSync(path.join(gateDir, "result.json"), "utf8")) as { steps: GateStep[]; green: boolean };
  return { code: r.status, npm: fs.readFileSync(log, "utf8").trim().split("\n"), steps: result.steps, green: result.green, log: fs.readFileSync(path.join(gateDir, "gate.log"), "utf8") };
}

const NEW_TREE = "// usage: check-all.ts [--jobs=<n>] [--check-timeout=<s>]\n";
const OLD_TREE = "// usage: check-all.ts [--list] [--skip=a,b]\n";
const COVERED = "check-all: skipping test:security: every file it runs is already its own check (smoke:a, smoke:b)\nsmoke:a\nsmoke:b";

await check("gate.sh: check-all gets --jobs and --check-timeout only from a tree that supports them; the job count is clamped", () => {
  const modern = runGate({ checkAll: NEW_TREE, jobs: "3" });
  assert.equal(modern.code, 0, modern.log);
  assert.ok(modern.npm.includes("run check:all -- --jobs=3 --check-timeout=600"), modern.npm.join(" | "));
  assert.equal(modern.green, true);
  assert.deepEqual(modern.steps.map((s) => s.name), ["install", "check-all", "security", "docs", "secrets"]);
  const old = runGate({ checkAll: OLD_TREE, jobs: "3" });
  assert.equal(old.code, 0, old.log);
  assert.ok(old.npm.includes("run check:all"), "an older tree runs check-all one check at a time");
  assert.ok(!old.npm.some((c) => c.includes("--jobs")));
  assert.ok(runGate({ checkAll: NEW_TREE, jobs: "99" }).npm.includes("run check:all -- --jobs=16 --check-timeout=600"));
  assert.ok(runGate({ checkAll: NEW_TREE, jobs: "0" }).npm.includes("run check:all -- --jobs=1 --check-timeout=600"));
  assert.ok(runGate({ checkAll: NEW_TREE, jobs: "x" }).npm.includes("run check:all -- --jobs=1 --check-timeout=600"));
});

await check("gate.sh: a red check-all names each failed check as a step and repeats the summary at the end of gate.log", () => {
  const red = runGate({ checkAll: NEW_TREE, jobs: "2", fail: true });
  assert.equal(red.code, 1);
  assert.equal(red.green, false);
  const names = red.steps.map((s) => s.name);
  assert.deepEqual(names, ["install", "check-all", "check-all:smoke:a (exit 1)", "check-all:smoke:b (timed out after 600s)", "security", "docs", "secrets"]);
  assert.deepEqual(red.steps.filter((s) => s.code !== 0).map((s) => s.name), ["check-all", "check-all:smoke:a (exit 1)", "check-all:smoke:b (timed out after 600s)"]);
  const tail = red.log.slice(-400);
  assert.match(tail, /check-all failures \(repeated from above\)\ncheck-all: 2\/5 FAILED in 3\.0s\n {2}- smoke:a \(exit 1\)\n {2}- smoke:b \(timed out after 600s\)\n$/);
});

await check("gate.sh: test:security runs on its own only when check-all does not already run its files", () => {
  const covered = runGate({ checkAll: NEW_TREE, jobs: "2", list: COVERED });
  assert.ok(!covered.npm.includes("run test:security"), covered.npm.join(" | "));
  assert.deepEqual(covered.steps.find((s) => s.name === "security"), { name: "security", code: 0, seconds: 0 });
  assert.match(covered.log, /security: covered by check-all/);
  const listed = runGate({ checkAll: NEW_TREE, jobs: "2", list: "smoke:a\ntest:security" });
  assert.ok(!listed.npm.includes("run test:security"), "a check-all that lists test:security as one of its runs covers it");
  const uncovered = runGate({ checkAll: NEW_TREE, jobs: "2" });
  assert.ok(uncovered.npm.includes("run test:security"), "otherwise it runs");
});

await check("entrypoint.sh: the cycle reset survives dirty tracked files and unpushed commits", () => {
  const text = fs.readFileSync(path.join(IMAGE, "entrypoint.sh"), "utf8");
  const begin = text.indexOf("# --- cycle reset");
  const end = text.indexOf("# --- end cycle reset ---");
  assert.ok(begin > 0 && end > begin, "the reset block is marked");
  const block = text.slice(begin, end);
  const root = scratch();
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  git(root, "init", "--quiet", "--bare", remote);
  fs.mkdirSync(seed);
  git(seed, "init", "--quiet");
  fs.writeFileSync(path.join(seed, "BACKLOG.md"), "pushed\n");
  git(seed, "add", "."); git(seed, "commit", "--quiet", "-m", "pushed");
  git(seed, "push", "--quiet", remote, "HEAD:refs/heads/pi/run");
  git(root, "clone", "--quiet", "--branch", "pi/run", remote, work);
  // The rejected previous cycle's leftovers: an unpushed commit, then dirty tracked and untracked files.
  fs.writeFileSync(path.join(work, "BACKLOG.md"), "unpushed\n");
  git(work, "commit", "--quiet", "-am", "unpushed");
  fs.writeFileSync(path.join(work, "BACKLOG.md"), "dirty\n");
  fs.writeFileSync(path.join(work, "stray.md"), "untracked\n");
  git(work, "checkout", "--quiet", "-b", "elsewhere");
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n${block}`], { cwd: work, env: { PATH: process.env["PATH"] ?? "", HOME: root, CYCLE_RESET: "1", RUN_BRANCH: "pi/run" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "pi/run");
  assert.equal(git(work, "rev-parse", "HEAD"), git(work, "rev-parse", "origin/pi/run"));
  assert.equal(git(work, "status", "--porcelain"), "", "a clean tree");
  assert.equal(fs.readFileSync(path.join(work, "BACKLOG.md"), "utf8"), "pushed\n");
});

for (const d of roots) rm(d);
done();
