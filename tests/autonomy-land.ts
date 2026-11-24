// Land-gate checks (packages/autonomy/lib/land.ts), run by tests/autonomy-smoke.ts. A dispatch
// cycle ends by landing a reviewed commit; these cases drive the real git binary over a local
// fixture repository and inject the check runner, so the merge, the reset and the refusals are
// observable without a container, a provider or the network. Kept as a helper rather than its own
// smoke script: package.json scripts and the wiring allow-list are control paths.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLandLock, DEFAULT_LAND_PROTECTED, landReviewed, type LandCheckResult, type LandGit, type LandVerdict } from "../packages/autonomy/lib/land.ts";

type Check = (name: string, fn: () => unknown) => Promise<void>;

interface GitRun { status: number | null; stdout: string; stderr: string }

/** Real git, argument array only, with a fixed identity so a commit needs no global config. */
function git(cwd: string, args: readonly string[]): GitRun {
  const r = spawnSync("git", ["-c", "user.name=Land Test", "-c", "user.email=land-test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ok(cwd: string, args: readonly string[]): string {
  const r = git(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const asLandGit: LandGit = (args, cwd) => git(cwd, args);

interface Fixture { root: string; repo: string; base: string; reviewed: string }

/** A repository on `main` at `base`, with one commit on `review` that changes `file`. */
function fixture(file = "feature.txt"): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-land-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  ok(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  ok(repo, ["add", "-A"]);
  ok(repo, ["commit", "-m", "base"]);
  const base = ok(repo, ["rev-parse", "HEAD"]);
  ok(repo, ["checkout", "-q", "-b", "review"]);
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "reviewed\n");
  ok(repo, ["add", "-A"]);
  ok(repo, ["commit", "-m", "reviewed change"]);
  const reviewed = ok(repo, ["rev-parse", "HEAD"]);
  ok(repo, ["checkout", "-q", "main"]);
  return { root, repo, base, reviewed };
}

const verdictFor = (f: Fixture, extra: Partial<LandVerdict> = {}): LandVerdict => ({ verdict: "PASS", sha: f.reviewed, reviewer: "reviewer-session", tip: f.base, ...extra });

/** A check runner over a fixed answer list, recording every directory it was asked to check. */
function scripted(results: readonly LandCheckResult[]): { calls: string[]; run: (cwd: string) => LandCheckResult } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    run(cwd: string): LandCheckResult {
      calls.push(cwd);
      const result = results[index] ?? { ok: true };
      index++;
      return result;
    },
  };
}

const head = (repo: string): string => ok(repo, ["rev-parse", "HEAD"]);

export async function runLandChecks(check: Check): Promise<void> {
  await check("land: a PASS from another session with green checks merges the reviewed sha and re-runs the checks on the merge", async () => {
    const f = fixture();
    try {
      const checks = scripted([{ ok: true }, { ok: true }]);
      const result = await landReviewed({ repo: f.repo, clone: path.join(f.root, "clone"), branch: "main", reviewedSha: f.reviewed, author: "worker-session", verdict: verdictFor(f), git: asLandGit, runChecks: checks.run, lock: createLandLock() });
      assert.equal(result.outcome, "landed");
      if (result.outcome !== "landed") return;
      assert.equal(result.from, f.base);
      assert.equal(result.to, head(f.repo), "the branch holds the merge the verdict approved");
      assert.notEqual(result.to, f.base, "the reviewed commit reached the branch");
      assert.equal(git(f.repo, ["merge-base", "--is-ancestor", f.reviewed, "HEAD"]).status, 0, "the reviewed sha is an ancestor of the branch");
      assert.equal(fs.readFileSync(path.join(f.repo, "feature.txt"), "utf8"), "reviewed\n");
      assert.equal(checks.calls.length, 2, "checks ran on the clone and again on the merged branch");
      assert.notEqual(checks.calls[0], f.repo, "the first check ran in the clean clone");
      assert.equal(checks.calls[1], f.repo, "the second check ran on the run's branch");
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  await check("land: a red second run resets the merge and leaves the branch exactly where it was", async () => {
    const f = fixture();
    try {
      const checks = scripted([{ ok: true }, { ok: false, detail: "smoke:autonomy failed" }]);
      const result = await landReviewed({ repo: f.repo, clone: path.join(f.root, "clone"), branch: "main", reviewedSha: f.reviewed, author: "worker-session", verdict: verdictFor(f), git: asLandGit, runChecks: checks.run, lock: createLandLock() });
      assert.equal(result.outcome, "refused");
      if (result.outcome === "refused") assert.equal(result.code, "second_checks_failed");
      assert.equal(head(f.repo), f.base, "the trunk is not left red");
      assert.equal(fs.existsSync(path.join(f.repo, "feature.txt")), false, "the reset removed the merge's tree");
      assert.equal(checks.calls.length, 2);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  await check("land: a commit after the verdict is refused as branch_moved and changes nothing", async () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.repo, "moved.txt"), "moved\n");
      ok(f.repo, ["add", "-A"]);
      ok(f.repo, ["commit", "-m", "a commit after the verdict"]);
      const moved = head(f.repo);
      const checks = scripted([{ ok: true }, { ok: true }]);
      const result = await landReviewed({ repo: f.repo, clone: path.join(f.root, "clone"), branch: "main", reviewedSha: f.reviewed, author: "worker-session", verdict: verdictFor(f), git: asLandGit, runChecks: checks.run, lock: createLandLock() });
      assert.equal(result.outcome, "refused");
      if (result.outcome === "refused") assert.equal(result.code, "branch_moved");
      assert.equal(head(f.repo), moved, "the moved branch is untouched");
      assert.equal(checks.calls.length, 0, "no check ran for a stale verdict");
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  await check("land: a reviewed change to a service unit or the control surface goes to the owner inbox, never the branch", async () => {
    for (const file of ["deploy/app.service", "packages/autonomy/lib/dispatch.ts", "deploy/app.timer"]) {
      const f = fixture(file);
      try {
        const checks = scripted([{ ok: true }, { ok: true }]);
        const result = await landReviewed({ repo: f.repo, clone: path.join(f.root, "clone"), branch: "main", reviewedSha: f.reviewed, author: "worker-session", verdict: verdictFor(f), git: asLandGit, runChecks: checks.run, lock: createLandLock() });
        assert.equal(result.outcome, "owner_inbox", file);
        if (result.outcome === "owner_inbox") {
          assert.equal(result.code, "protected_path");
          assert.ok(result.paths.includes(file), `names ${file}`);
        }
        assert.equal(head(f.repo), f.base, `${file} did not land`);
        assert.equal(checks.calls.length, 0, `${file} was refused before any check`);
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }
    assert.ok(DEFAULT_LAND_PROTECTED.some((re) => re.test("unit.service")) && DEFAULT_LAND_PROTECTED.some((re) => re.test("unit.timer")), "the default list covers units");
  });

  await check("land: a PASS from the author, or one naming another sha, is refused", async () => {
    const f = fixture();
    try {
      const checks = scripted([]);
      const self = await landReviewed({ repo: f.repo, clone: path.join(f.root, "clone"), branch: "main", reviewedSha: f.reviewed, author: "same-session", verdict: verdictFor(f, { reviewer: "same-session" }), git: asLandGit, runChecks: checks.run, lock: createLandLock() });
      assert.equal(self.outcome, "refused");
      if (self.outcome === "refused") assert.equal(self.code, "self_review");
      const wrong = await landReviewed({ repo: f.repo, clone: path.join(f.root, "clone"), branch: "main", reviewedSha: f.reviewed, author: "worker-session", verdict: verdictFor(f, { sha: f.base }), git: asLandGit, runChecks: checks.run, lock: createLandLock() });
      assert.equal(wrong.outcome, "refused");
      if (wrong.outcome === "refused") assert.equal(wrong.code, "verdict_mismatch");
      assert.equal(head(f.repo), f.base);
      assert.equal(checks.calls.length, 0);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  await check("land: a second land that starts while one is running is refused", async () => {
    const f = fixture();
    try {
      let release: (result: LandCheckResult) => void = () => {};
      let entered: () => void = () => {};
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<LandCheckResult>((resolve) => { release = resolve; });
      let calls = 0;
      const runChecks = async (): Promise<LandCheckResult> => {
        calls++;
        if (calls === 1) { entered(); return gate; }
        return { ok: true };
      };
      const lock = createLandLock();
      const first = landReviewed({ repo: f.repo, clone: path.join(f.root, "clone"), branch: "main", reviewedSha: f.reviewed, author: "worker-session", verdict: verdictFor(f), git: asLandGit, runChecks, lock });
      await reached;
      const second = await landReviewed({ repo: f.repo, clone: path.join(f.root, "clone-2"), branch: "main", reviewedSha: f.reviewed, author: "worker-session", verdict: verdictFor(f), git: asLandGit, runChecks, lock });
      assert.equal(second.outcome, "refused");
      if (second.outcome === "refused") assert.equal(second.code, "busy");
      release({ ok: true });
      const landed = await first;
      assert.equal(landed.outcome, "landed", "the first land still finishes");
      assert.equal(lock.tryAcquire(), true, "the lock is released when the land ends");
      lock.release();
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}
