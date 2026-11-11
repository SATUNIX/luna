#!/usr/bin/env node
/**
 * Offline checks for the opt-in `trunk` kit channel: the head of the kit's integration branch
 * (`git.trunkBranch` in packages/core/distribution.json, `integration/luna`).
 *
 * Mirrors tests/kit-update-smoke.ts: a scratch PI_CODING_AGENT_DIR and a scratch kit root, an
 * injected fake git and fetch, and the real installer under --dry-run, so nothing touches the
 * network or the operator's settings. Covers: detecting a trunk-pinned git install, planning a
 * trunk update and channel switch against the branch (never a tag or main), and that `latest`
 * stays the default and trunk is only ever selected from an explicit request.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { channelOfGitSource, isChannel, readDistribution } from "../packages/core/lib/distribution.ts";
import type * as KitUpdate from "../packages/extensions/src/kit-update/index.ts";

const GIT_SOURCE = "git:github.com/SATUNIX/luna";
const TRUNK_BRANCH = "integration/luna";
const SHA_OLD = "1".repeat(40);
const SHA_MAIN = "2".repeat(40);
const SHA_TRUNK = "3".repeat(40);

interface World {
  agent: string;
  cwd: string;
  kitRoot: string;
  cleanup(): void;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// A kit as pi clones a git package: <agent>/git/<host>/<path>, with its distribution.json.
function makeGitWorld(): World {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-trunk-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-trunk-cwd-"));
  const kitRoot = path.join(agent, "git", "github.com", "SATUNIX", "luna");
  fs.mkdirSync(kitRoot, { recursive: true });
  writeJson(path.join(kitRoot, "package.json"), { name: "@satunix/pi-system", version: "0.3.0-beta.2" });
  fs.mkdirSync(path.join(kitRoot, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(kitRoot, "packages", "core", "install.ts"), "// stub\n");
  writeJson(path.join(kitRoot, "packages", "core", "sources.json"), { external: [] });
  writeJson(path.join(kitRoot, "packages", "core", "distribution.json"), {
    delivery: "git",
    git: { source: GIT_SOURCE, branch: "main", trunkBranch: TRUNK_BRANCH, tagPrefix: "v" },
  });
  const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
  const restoreRoot = setEnv("PI_KIT_ROOT", undefined);
  return {
    agent,
    cwd,
    kitRoot,
    cleanup() {
      restoreAgent();
      restoreRoot();
      rmWorkspace(agent);
      rmWorkspace(cwd);
    },
  };
}

// Fake git: `ls-remote` answers with the given tags and the main and trunk branch heads.
function fakeGit({ tags = [], main = SHA_MAIN, trunk = SHA_TRUNK, head = SHA_OLD, reachable = true }: {
  tags?: string[];
  main?: string;
  trunk?: string;
  head?: string;
  reachable?: boolean;
} = {}): KitUpdate.GitLike {
  return async (args) => {
    if (args.includes("ls-remote")) {
      if (!reachable) return null;
      return [
        ...tags.map((t, i) => `${String(i + 4).repeat(40)}\trefs/tags/v${t}`),
        `${main}\trefs/heads/main`,
        `${trunk}\trefs/heads/${TRUNK_BRANCH}`,
      ].join("\n") + "\n";
    }
    if (args.includes("rev-parse")) return `${head}\n`;
    return null;
  };
}

// The registry lookups in a git check: only pi (and linked packages, none here) is queried.
const fetchImpl: KitUpdate.FetchLike = async (url) => {
  const tags = url.includes("pi-coding-agent") ? { latest: "0.87.1" } : {};
  return { ok: true, json: async () => tags };
};

const restoreKitEnv = isolateKitEnv();
const mod = await loadModule<typeof KitUpdate>("extensions/kit-update/index.ts");

function settingsFor(world: World, source: string): void {
  writeJson(path.join(world.agent, "settings.json"), { packages: [{ source }] });
}

const tests: Record<string, () => void | Promise<void>> = {
  "a git install pinned to the integration branch is detected as trunk, not pinned": () => {
    const w = makeGitWorld();
    try {
      settingsFor(w, `${GIT_SOURCE}@${TRUNK_BRANCH}`);
      const kit = mod.detectKitInstall(w.cwd);
      assert.equal(kit.kind, "git");
      assert.equal(kit.channel, "trunk");
      assert.equal(kit.pinned, false);
    } finally {
      w.cleanup();
    }
  },

  "latest stays the default: a tag is latest, an unpinned source is next, trunk is never inferred": () => {
    const w = makeGitWorld();
    try {
      settingsFor(w, `${GIT_SOURCE}@v0.3.0-beta.2`);
      const tagged = mod.detectKitInstall(w.cwd);
      assert.equal(tagged.channel, "latest");
      assert.equal(tagged.pinned, false, "a channel tag is a moving channel, not a pin");

      settingsFor(w, GIT_SOURCE);
      const unpinned = mod.detectKitInstall(w.cwd);
      assert.equal(unpinned.channel, "next", "an unpinned source follows main, not trunk");
      assert.equal(unpinned.pinned, false);

      settingsFor(w, `${GIT_SOURCE}@main`);
      assert.equal(mod.detectKitInstall(w.cwd).channel, "main", "main is its own ref, never trunk");
    } finally {
      w.cleanup();
    }
  },

  "a trunk update and channel switch plan the integration branch, not a tag or main": async () => {
    const w = makeGitWorld();
    try {
      settingsFor(w, `${GIT_SOURCE}@${TRUNK_BRANCH}`);
      const report = await mod.checkForUpdates(w.cwd, fetchImpl, "0.87.1", fakeGit());
      assert.equal(report.kit.channel, "trunk");
      assert.equal(report.kit.pinned, false);
      assert.equal(report.kit.available, true);
      assert.equal(report.kit.target, `${TRUNK_BRANCH}@${SHA_TRUNK.slice(0, 7)}`);
      assert.equal(report.kit.tags?.trunk, `${TRUNK_BRANCH}@${SHA_TRUNK.slice(0, 7)}`);

      const update = mod.planUpdate(report, "kit").steps[0];
      assert.ok(update, "a trunk update must be planned");
      assert.equal(update.args[0], "install");
      assert.equal(update.args[1], `${GIT_SOURCE}@${TRUNK_BRANCH}`, "the ref is the trunk branch");
      assert.ok(!update.args[1]?.includes("@v"), "trunk must not be a release tag");
      assert.ok(!update.args[1]?.includes("@main"), "trunk must not be main");

      const switched = mod.planChannelSwitch(report, "trunk").steps[0];
      assert.ok(switched, "a channel switch to trunk must be planned");
      assert.ok(switched.args.join(" ").includes("--channel trunk"), switched.args.join(" "));
    } finally {
      w.cleanup();
    }
  },

  "an unchanged trunk checkout is up to date; a moved branch is an update": async () => {
    const w = makeGitWorld();
    try {
      settingsFor(w, `${GIT_SOURCE}@${TRUNK_BRANCH}`);
      const current = await mod.checkForUpdates(w.cwd, fetchImpl, "0.87.1", fakeGit({ head: SHA_TRUNK, trunk: SHA_TRUNK }));
      assert.equal(current.kit.available, false);
      const behind = await mod.checkForUpdates(w.cwd, fetchImpl, "0.87.1", fakeGit({ head: SHA_OLD, trunk: SHA_TRUNK }));
      assert.equal(behind.kit.available, true);
      assert.equal(behind.kit.target, `${TRUNK_BRANCH}@${SHA_TRUNK.slice(0, 7)}`);
    } finally {
      w.cleanup();
    }
  },

  "the installer resolves --channel trunk to the integration branch offline": () => {
    const w = makeGitWorld();
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, "packages", "core", "install.ts"), "--channel", "trunk", "--profile", "balanced", "--dry-run"],
        { cwd: w.cwd, env: { ...process.env }, encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /source:\s+git:github\.com\/SATUNIX\/luna@integration\/luna/, result.stdout);
      assert.match(result.stdout, /channel trunk/);
    } finally {
      w.cleanup();
    }
  },

  "distribution defaults trunk to integration/luna and accepts it as a channel": () => {
    const w = makeGitWorld();
    try {
      assert.equal(readDistribution().git.trunkBranch, TRUNK_BRANCH, "the shipped distribution sets trunk");
      const scratch = path.join(w.agent, "distribution.json");
      writeJson(scratch, { git: { source: GIT_SOURCE } });
      assert.equal(readDistribution(scratch, {}).git.trunkBranch, TRUNK_BRANCH, "a missing trunkBranch defaults to integration/luna");

      assert.equal(channelOfGitSource(GIT_SOURCE), "next");
      assert.equal(channelOfGitSource(`${GIT_SOURCE}@v1.0.0`), "latest");
      assert.equal(channelOfGitSource(`${GIT_SOURCE}@${TRUNK_BRANCH}`), "trunk");
      assert.equal(channelOfGitSource(`${GIT_SOURCE}@feature-x`), "feature-x");
      assert.ok(isChannel("trunk"));
      assert.ok(isChannel("latest"));
    } finally {
      w.cleanup();
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${String((error instanceof Error && error.stack) || error)}`);
  }
}
restoreKitEnv();
if (failed) {
  console.error(`\n[kit-update-channel-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[kit-update-channel-smoke] all ${Object.keys(tests).length} checks passed`);
