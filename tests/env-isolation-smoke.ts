#!/usr/bin/env node
// Regression for kit env isolation. The autonomy runtime and a developer's shell export
// PI_KIT_* / PI_CODING_AGENT_DIR, which change firewall decisions and state paths. Smoke tests
// must clear them with isolateKitEnv() (packages/core/eval/harness.ts) before loading the
// extension under test; eval fixtures must relocate their own state. This test proves both:
//   1. isolateKitEnv() clears kit-owned variables and its closure restores them exactly;
//   2. the four smoke tests that inherited the ambient env pass under a polluted environment, and
//      leave the whole pi-kit/ state subtree unchanged under an isolated fallback HOME;
//   3. `npm run eval` leaves the whole pi-kit/ state subtree unchanged under the ambient
//      PI_CODING_AGENT_DIR;
//   4. tests/epic1-smoke.ts leaves the whole pi-kit/ state subtree unchanged under an isolated HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, isolateKitEnv, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";

// Recursively read a directory into a plain object of relativePath -> file contents, plus a
// "<dir>" sentinel for every directory (including the root as "." when it exists). A missing
// directory yields {}; symlinks are recorded as "<link>-><target>" and other non-file,
// non-directory entries (fifo, socket, device) as "<special>", so state leaked through a
// symlinked pi-kit/ path cannot evade the guard. Unreadable regular files (permissions, races)
// are still treated as absent, so a probe can assert the whole pi-kit/ state dir is byte-identical
// before and after a spawned child. This widens the guard beyond the single firewall-sessions path
// to every file tool-firewall writes: firewall.json, firewall-feedback.jsonl,
// firewall-judgements.jsonl, firewall-profile.json, firewall-rules.json and firewall-sessions/*.
// The directory sentinels keep the old existsSync-level guard: a child that only mkdirs an empty
// pi-kit/firewall-sessions with no files still changes the snapshot instead of yielding the same {}
// before and after.
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel === "") out["."] = "<dir>";
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[childRel] = "<dir>";
        walk(childAbs, childRel);
      } else if (entry.isFile()) {
        try {
          out[childRel] = fs.readFileSync(childAbs, "utf8");
        } catch {
          // Unreadable regular file: treat as absent.
        }
      } else if (entry.isSymbolicLink()) {
        let target = "?";
        try {
          target = fs.readlinkSync(childAbs);
        } catch {
          // Unreadable link target: keep the "?" placeholder.
        }
        out[childRel] = `<link>->${target}`;
      } else {
        // fifo, socket, device, or any other special entry.
        out[childRel] = "<special>";
      }
    }
  };
  walk(dir, "");
  return out;
}

// 1. Unit: isolateKitEnv clears kit-owned variables, and the closure restores exactly.
{
  const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", "sentinel-policy");
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", "sentinel-agent-dir");
  const restoreUpdate = setEnv("PI_KIT_UPDATE_CHECK", "sentinel-update");
  const restoreSubagentChild = setEnv("PI_SUBAGENT_CHILD", "1");
  const restoreSubagentRepo = setEnv("PI_SUBAGENTS_WORKTREE_DIR", "sentinel-subagent-worktree");
  try {
    const restore = isolateKitEnv();
    assert.equal(process.env.PI_KIT_FIREWALL_POLICY, undefined, "PI_KIT_FIREWALL_POLICY must be cleared");
    assert.equal(process.env.PI_CODING_AGENT_DIR, undefined, "PI_CODING_AGENT_DIR must be cleared");
    assert.equal(process.env.PI_KIT_UPDATE_CHECK, undefined, "PI_KIT_UPDATE_CHECK must be cleared");
    assert.equal(process.env.PI_SUBAGENT_CHILD, undefined, "PI_SUBAGENT_CHILD must be cleared (kit extensions skip in provider children)");
    assert.equal(process.env.PI_SUBAGENTS_WORKTREE_DIR, undefined, "PI_SUBAGENTS_* must be cleared");
    restore();
    assert.equal(process.env.PI_KIT_FIREWALL_POLICY, "sentinel-policy", "the closure must restore PI_KIT_FIREWALL_POLICY exactly");
    assert.equal(process.env.PI_CODING_AGENT_DIR, "sentinel-agent-dir", "the closure must restore PI_CODING_AGENT_DIR exactly");
    assert.equal(process.env.PI_KIT_UPDATE_CHECK, "sentinel-update", "the closure must restore PI_KIT_UPDATE_CHECK exactly");
    assert.equal(process.env.PI_SUBAGENT_CHILD, "1", "the closure must restore PI_SUBAGENT_CHILD exactly");
    assert.equal(process.env.PI_SUBAGENTS_WORKTREE_DIR, "sentinel-subagent-worktree", "the closure must restore PI_SUBAGENTS_* exactly");
  } finally {
    restoreUpdate();
    restoreAgentDir();
    restorePolicy();
    restoreSubagentChild();
    restoreSubagentRepo();
  }
}

// 1b. Unit: the step-2b fallback probe predicate must be falsifiable. A real spawned child
// changes fallback pi-kit/ state under its own HOME, and the parent must observe the exact
// widened predicate the step-2b loop asserts on (snapshotDir of path.join(home, ".pi", "agent",
// "pi-kit")) transition true -> false. Three writers are exercised: one that writes firewall.json,
// one that only mkdirs an empty pi-kit/firewall-sessions with no files, and one that creates a
// symlink. The second writer is the regression the file-only snapshot missed, so it must be
// caught by the "<dir>" sentinel; the third is the regression the file/dir-only snapshot missed,
// so it must be caught by the "<link>-><target>" record. If the widened predicate were
// tautological, the assertions below would fail, so this self-test cannot silently pass.
{
  const fakeHome = tmpWorkspace("pi-kit-env-isolation-selftest-");
  const piKitDir = path.join(fakeHome, ".pi", "agent", "pi-kit");
  try {
    const writerEnv: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
    delete writerEnv.PI_CODING_AGENT_DIR;
    delete writerEnv.PI_KIT_FIREWALL_SESSIONS_DIR;
    const before = snapshotDir(piKitDir);
    assert.deepEqual(before, {}, `self-test: the fallback pi-kit dir must start absent (${piKitDir})`);
    const fileWriter = spawnSync(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"),p=require("node:path"),d=p.join(process.env.HOME,".pi","agent","pi-kit");fs.mkdirSync(p.join(d,"firewall-sessions"),{recursive:true});fs.writeFileSync(p.join(d,"firewall.json"),"x");',
      ],
      { env: writerEnv, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(fileWriter.status, 0, `self-test file writer must exit 0: status=${fileWriter.status}\n${fileWriter.stderr ?? ""}`);
    const afterFile = snapshotDir(piKitDir);
    assert.notDeepEqual(
      afterFile,
      before,
      `self-test: the widened pi-kit snapshot predicate must observe the spawned file writer's firewall state (${piKitDir})`,
    );
    assert.equal(
      afterFile["firewall.json"],
      "x",
      `self-test: the snapshot must capture the spawned writer's firewall.json (${piKitDir})`,
    );
    rmWorkspace(piKitDir);
    assert.deepEqual(
      snapshotDir(piKitDir),
      before,
      `self-test: the widened pi-kit snapshot predicate must clear once the pi-kit dir is removed (${piKitDir})`,
    );

    // Directory-only writer: mkdirs an empty firewall-sessions dir and writes no files. The old
    // file-only snapshot returned the same {} before and after, so the sentinel must carry it.
    const dirWriter = spawnSync(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"),p=require("node:path"),d=p.join(process.env.HOME,".pi","agent","pi-kit");fs.mkdirSync(p.join(d,"firewall-sessions"),{recursive:true});',
      ],
      { env: writerEnv, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(dirWriter.status, 0, `self-test dir writer must exit 0: status=${dirWriter.status}\n${dirWriter.stderr ?? ""}`);
    const afterDir = snapshotDir(piKitDir);
    assert.notDeepEqual(
      afterDir,
      before,
      `self-test: the "<dir>" sentinel must observe an empty pi-kit/firewall-sessions dir (${piKitDir})`,
    );
    assert.equal(
      afterDir["firewall-sessions"],
      "<dir>",
      `self-test: the snapshot must record the empty firewall-sessions dir as a "<dir>" sentinel (${piKitDir})`,
    );
    rmWorkspace(piKitDir);
    assert.deepEqual(
      snapshotDir(piKitDir),
      before,
      `self-test: the widened pi-kit snapshot predicate must clear once the mkdir-only pi-kit dir is removed (${piKitDir})`,
    );

    // Symlink writer: mkdirs firewall-sessions and drops a symlink under pi-kit/. The file/dir-only
    // snapshot returned the same representation as the dir writer, so the "<link>-><target>" record
    // must carry it.
    const linkWriter = spawnSync(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"),p=require("node:path"),d=p.join(process.env.HOME,".pi","agent","pi-kit");fs.mkdirSync(p.join(d,"firewall-sessions"),{recursive:true});fs.symlinkSync("target-elsewhere",p.join(d,"leak-link"));',
      ],
      { env: writerEnv, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(linkWriter.status, 0, `self-test symlink writer must exit 0: status=${linkWriter.status}\n${linkWriter.stderr ?? ""}`);
    const afterLink = snapshotDir(piKitDir);
    assert.notDeepEqual(
      afterLink,
      before,
      `self-test: the widened pi-kit snapshot predicate must observe the spawned symlink writer's state (${piKitDir})`,
    );
    assert.match(
      afterLink["leak-link"] ?? "",
      /^<link>->/,
      `self-test: the snapshot must record the symlink as "<link>-><target>" (${piKitDir})`,
    );
    assert.equal(
      afterLink["leak-link"],
      "<link>->target-elsewhere",
      `self-test: the snapshot must capture the symlink's exact target (${piKitDir})`,
    );
    rmWorkspace(piKitDir);
    assert.deepEqual(
      snapshotDir(piKitDir),
      before,
      `self-test: the widened pi-kit snapshot predicate must clear once the symlink pi-kit dir is removed (${piKitDir})`,
    );

    // Special-entry writer (optional): mkfifo availability is platform-dependent, so skip silently
    // when it is missing or fails. When available, a fifo must be recorded as "<special>".
    const fifoWriter = spawnSync(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"),p=require("node:path"),cp=require("node:child_process"),d=p.join(process.env.HOME,".pi","agent","pi-kit");fs.mkdirSync(p.join(d,"firewall-sessions"),{recursive:true});const r=cp.spawnSync("mkfifo",[p.join(d,"leak-fifo")]);process.exit(r.status===0?0:3);',
      ],
      { env: writerEnv, encoding: "utf8", timeout: 60000 },
    );
    if (fifoWriter.status === 0) {
      const afterFifo = snapshotDir(piKitDir);
      assert.notDeepEqual(
        afterFifo,
        before,
        `self-test: the widened pi-kit snapshot predicate must observe a spawned fifo (${piKitDir})`,
      );
      assert.equal(
        afterFifo["leak-fifo"],
        "<special>",
        `self-test: the snapshot must record the fifo as a "<special>" entry (${piKitDir})`,
      );
      rmWorkspace(piKitDir);
      assert.deepEqual(
        snapshotDir(piKitDir),
        before,
        `self-test: the widened pi-kit snapshot predicate must clear once the fifo pi-kit dir is removed (${piKitDir})`,
      );
    }
  } finally {
    rmWorkspace(fakeHome);
  }
}

const ws = tmpWorkspace("pi-kit-env-isolation-");
const homeProbe = tmpWorkspace("pi-kit-env-isolation-home-");
const permissivePolicyPath = path.join(ws, "firewall.json");
const probe = tmpWorkspace("pi-kit-env-isolation-probe-");
const fallbackHomes: string[] = [];
try {
  fs.writeFileSync(
    permissivePolicyPath,
    JSON.stringify({ defaults: { unknown: "allow" }, tools: {}, command_rules: { deny: [], ask: [] } }),
  );

  // 2. Integration: the previously-failing smoke tests must pass with a polluted ambient env.
  const pollutedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PI_KIT_FIREWALL_POLICY: permissivePolicyPath,
    PI_KIT_AUTO_MODE: "0",
    PI_CODING_AGENT_DIR: path.join(ws, "agent"),
    PI_KIT_FIREWALL_ROOT_SESSION: "polluted-session",
    PI_KIT_INTERNAL_CHILD: "1",
    PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS: "120000",
  };
  for (const file of [
    "tests/auto-mode-smoke.ts",
    "tests/firewall-gate-smoke.ts",
    "tests/human-console-broker-smoke.ts",
    "tests/shutdown-hook-gating-smoke.ts",
  ]) {
    const result = spawnSync(process.execPath, [file], { cwd: ROOT, env: pollutedEnv, encoding: "utf8", timeout: 180000 });
    assert.equal(result.status, 0, `${file} must pass with ambient kit env: status=${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  console.log("[env-isolation-smoke] polluted smoke runs pass");

  // 2b. Fallback probe: with PI_CODING_AGENT_DIR unset, each smoke falls back to HOME; it must still
  // leave the whole pi-kit/ state subtree unchanged under the real agent dir. Fresh HOME per file so a
  // write (or a bare mkdir) is visible.
  for (const file of [
    "tests/auto-mode-smoke.ts",
    "tests/firewall-gate-smoke.ts",
    "tests/human-console-broker-smoke.ts",
    "tests/shutdown-hook-gating-smoke.ts",
  ]) {
    const freshHome = tmpWorkspace("pi-kit-env-isolation-fallback-");
    fallbackHomes.push(freshHome);
    const fallbackEnv: NodeJS.ProcessEnv = { ...pollutedEnv, HOME: freshHome };
    delete fallbackEnv.PI_CODING_AGENT_DIR;
    delete fallbackEnv.PI_KIT_FIREWALL_SESSIONS_DIR;
    const piKitDir = path.join(freshHome, ".pi", "agent", "pi-kit");
    const before = snapshotDir(piKitDir);
    const result = spawnSync(process.execPath, [file], { cwd: ROOT, env: fallbackEnv, encoding: "utf8", timeout: 180000 });
    assert.equal(result.status, 0, `${file} must pass with isolated fallback HOME: status=${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    const after = snapshotDir(piKitDir);
    assert.deepEqual(after, before, `${file} must not change the fallback pi-kit/ state dir (${piKitDir})`);
  }
  console.log("[env-isolation-smoke] fallback agent-dir probe passed");

  // 3. Eval isolation: the firewall fixture must not change the pi-kit/ state subtree under the
  // ambient agent dir.
  const evalPiKitDir = path.join(probe, "pi-kit");
  const evalBefore = snapshotDir(evalPiKitDir);
  const evalResult = spawnSync(process.execPath, ["packages/core/eval/run.ts"], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: probe, PI_KIT_FIREWALL_POLICY: permissivePolicyPath },
    encoding: "utf8",
    timeout: 300000,
  });
  assert.equal(evalResult.status, 0, `npm run eval must pass with ambient kit env: status=${evalResult.status}\n${evalResult.stdout ?? ""}\n${evalResult.stderr ?? ""}`);
  assert.deepEqual(
    snapshotDir(evalPiKitDir),
    evalBefore,
    `eval must not change the pi-kit/ state dir under PI_CODING_AGENT_DIR (${evalPiKitDir})`,
  );

  // 4. Smoke isolation: epic1-smoke.ts must not change the pi-kit/ state subtree under HOME.
  const homeEnv: NodeJS.ProcessEnv = { ...process.env, HOME: homeProbe };
  delete homeEnv.PI_CODING_AGENT_DIR;
  delete homeEnv.PI_KIT_FIREWALL_SESSIONS_DIR;
  const homePiKitDir = path.join(homeProbe, ".pi", "agent", "pi-kit");
  const homeBefore = snapshotDir(homePiKitDir);
  const smokeResult = spawnSync(process.execPath, ["tests/epic1-smoke.ts"], {
    cwd: ROOT,
    env: homeEnv,
    encoding: "utf8",
    timeout: 180000,
  });
  assert.equal(smokeResult.status, 0, `epic1-smoke.ts must pass with ambient HOME: status=${smokeResult.status}\n${smokeResult.stdout ?? ""}\n${smokeResult.stderr ?? ""}`);
  assert.deepEqual(
    snapshotDir(homePiKitDir),
    homeBefore,
    `epic1-smoke.ts must not change the pi-kit/ state dir under HOME (${homePiKitDir})`,
  );

  console.log("[env-isolation-smoke] OK");
} finally {
  rmWorkspace(ws);
  rmWorkspace(probe);
  rmWorkspace(homeProbe);
  for (const dir of fallbackHomes) rmWorkspace(dir);
}
