#!/usr/bin/env node
/**
 * Offline checks for the kit-update extension (`/update` and the background update check).
 *
 * Everything runs against a scratch agent dir (PI_CODING_AGENT_DIR), a scratch kit root
 * (PI_KIT_ROOT), a fake registry (an injected fetch) and a fake git (injected), so nothing
 * touches the network or the real pi settings. Git delivery (release tags and main of the
 * kit's repository) and npm delivery (dist-tags) are both covered, as is the delivery switch. Covers: channel detection for every install shape, the snapshot
 * ordering `pi update` relies on, what counts as an update (and what is only a notice),
 * the exact commands /update runs, and that a failed step neither continues nor reloads.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { snapshotVersion } from "../packages/core/snapshot-version.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as KitUpdate from "../packages/extensions/src/kit-update/index.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";

// An install marker (.pi-kit.json) as the fixtures write it.
interface Marker {
  profile: string;
  scope?: string;
  channel?: string;
  kitSource?: string;
}

interface WorldOptions {
  kitSource?: string;
  kitVersion?: string;
  /** The pi version the kit's package.json pins as a devDependency (the version it is tested with). */
  piTested?: string;
  packages?: string[];
  installed?: Record<string, string>;
  marker?: Marker;
}

interface GitWorldOptions {
  kitSource?: string;
  kitVersion?: string;
  delivery?: string;
  marker?: Marker;
}

interface World {
  agent: string;
  cwd: string;
  kitRoot: string;
  cleanup(): void;
}

interface FakeGitOptions {
  tags?: string[];
  main?: string;
  head?: string;
  reachable?: boolean;
  branch?: string;
  upstream?: string | null;
  contains?: boolean;
  origin?: string | null;
}

// npm dist-tags per package name, as the fake registry serves them.
type DistTags = Record<string, Record<string, string>>;

interface Note {
  m: string;
  l: string | undefined;
}

// Item `index` of a list; a missing one fails the check just as reading a property of undefined did.
function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  assert.ok(item !== undefined, `no item ${index} in ${JSON.stringify(list)}`);
  return item;
}

// The extension module as this test drives it: registered against the harness's fakePi() api
// (an untyped JS stand-in for the parts of ExtensionAPI the extension uses), and runPlan with a
// pi that only has `exec`, the one method it calls.
type KitUpdateModule = Omit<typeof KitUpdate, "default" | "runPlan"> & {
  default: (pi: ReturnType<typeof fakePi>["api"]) => void;
  runPlan: (pi: Pick<ExtensionAPI, "exec">, cwd: string, steps: Parameters<typeof KitUpdate.runPlan>[2]) => Promise<KitUpdate.StepOutcome>;
};

// The subset of an UpdateReport that planUpdate's reconcile step reads.
type ReconcileReport = Pick<KitUpdate.UpdateReport, "packages" | "cwd"> & {
  kit: Pick<KitUpdate.UpdateReport["kit"], "kind" | "root" | "source" | "scope" | "available" | "target" | "channel">;
  pi: Pick<KitUpdate.UpdateReport["pi"], "available">;
};

const restoreKitEnv = isolateKitEnv();
const mod: KitUpdateModule = await loadModule("extensions/kit-update/index.ts");
const { detectStaleRoleCopies, default: kitUpdate, compareVersions, parseNpmSource, parseGitSource, gitSourceWithRef, releaseTags, latestRelease, detectKitInstall, checkForUpdates, hasUpdates, summaryLine, formatReport, planUpdate, planChannelSwitch, shouldCheckNow, runPlan, successMessage } = mod;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// A kit package root as pi installs it: <agent>/npm/node_modules/@satunix/pi-system.
function makeWorld({ kitSource = "npm:@satunix/pi-system", kitVersion = "0.2.1-beta.0", piTested, packages = [], installed = {}, marker = { profile: "balanced", scope: "global" } }: WorldOptions = {}): World {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-cwd-"));
  const kitName = mod.parseNpmSource(kitSource)?.name ?? "@satunix/pi-system";
  const kitRoot = path.join(agent, "npm", "node_modules", ...kitName.split("/"));
  writeJson(path.join(kitRoot, "package.json"), { name: kitName, version: kitVersion, ...(piTested ? { devDependencies: { "@earendil-works/pi-coding-agent": piTested } } : {}) });
  fs.mkdirSync(path.join(kitRoot, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(kitRoot, "packages", "core", "install.ts"), "// stub\n");
  writeJson(path.join(kitRoot, "packages", "core", "sources.json"), { external: [{ name: "pi-lens", source: "npm:pi-lens@3.9.0" }] });
  const agentsDir = path.join(kitRoot, "packages", "kit", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const SHIPPED_SCOUT = "---\nname: scout\n---\nshipped body\n";
  const SHIPPED_REVIEWER = "---\nname: reviewer\n---\nshipped body\n";
  fs.writeFileSync(path.join(agentsDir, "scout.md"), SHIPPED_SCOUT);
  fs.writeFileSync(path.join(agentsDir, "reviewer.md"), SHIPPED_REVIEWER);
  for (const [name, version] of Object.entries(installed)) writeJson(path.join(agent, "npm", "node_modules", ...name.split("/"), "package.json"), { name, version });
  writeJson(path.join(agent, "settings.json"), { packages: [{ source: kitSource, extensions: ["packages/extensions/third_party/todo/index.ts"] }, ...packages] });
  if (marker) writeJson(path.join(agent, ".pi-kit.json"), marker);
  const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
  const restoreRoot = setEnv("PI_KIT_ROOT", kitRoot);
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

const GIT_SOURCE = "git:github.com/SATUNIX/luna";
const SHA_OLD = "1".repeat(40);
const SHA_MAIN = "2".repeat(40);

// A kit as pi clones a git package: <agent>/git/<host>/<path>, with its distribution.json.
function makeGitWorld({ kitSource = `${GIT_SOURCE}@v0.2.1-beta.0`, kitVersion = "0.2.1-beta.0", delivery = "git", marker = { profile: "balanced", scope: "global" } }: GitWorldOptions = {}): World {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-cwd-"));
  const kitRoot = path.join(agent, "git", "github.com", "SATUNIX", "luna");
  writeJson(path.join(kitRoot, "package.json"), { name: "@satunix/pi-system", version: kitVersion });
  fs.mkdirSync(path.join(kitRoot, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(kitRoot, "packages", "core", "install.ts"), "// stub\n");
  writeJson(path.join(kitRoot, "packages", "core", "sources.json"), { external: [] });
  writeJson(path.join(kitRoot, "packages", "core", "distribution.json"), { delivery, git: { source: GIT_SOURCE, branch: "main", tagPrefix: "v" } });
  writeJson(path.join(agent, "settings.json"), { packages: [{ source: kitSource, extensions: ["packages/extensions/third_party/todo/index.ts"] }] });
  if (marker) writeJson(path.join(agent, ".pi-kit.json"), marker);
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

// Fake git: `ls-remote` answers with the given tags and main commit, `rev-parse HEAD` with head.
function fakeGit({ tags = [], main = SHA_MAIN, head = SHA_OLD, reachable = true, branch = "main", upstream = null, contains = false, origin = null }: FakeGitOptions = {}): { git: KitUpdate.GitLike; calls: string[] } {
  const calls: string[] = [];
  const git: KitUpdate.GitLike = async (args) => {
    calls.push(args.join(" "));
    if (args.includes("get-url")) return origin ? `${origin}\n` : null;
    if (args.includes("ls-remote")) {
      if (!reachable) return null;
      if (args.includes("origin")) return upstream ? `${upstream}\trefs/heads/${branch}\n` : "";
      return [...tags.map((t, i) => `${String(i + 3).repeat(40)}\trefs/tags/v${t}`), `${main}\trefs/heads/main`, `${"9".repeat(40)}\trefs/heads/feature`].join("\n") + "\n";
    }
    if (args.includes("--abbrev-ref")) return `${branch}\n`;
    if (args.includes("rev-parse")) return `${head}\n`;
    if (args.includes("merge-base")) return contains ? "" : null;
    return null;
  };
  return { git, calls };
}

function fakeRegistry(tags: DistTags): { fetchImpl: KitUpdate.FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: KitUpdate.FetchLike = async (url) => {
    calls.push(url);
    const name = decodeURIComponent(nth(url.split("/-/package/"), 1).replace("/dist-tags", ""));
    if (!(name in tags)) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => tags[name] };
  };
  return { fetchImpl, calls };
}

const TAGS = {
  "@earendil-works/pi-coding-agent": { latest: "0.87.1" },
  "@satunix/pi-system": { latest: "0.2.1-beta.1", next: "0.2.1-beta.1.next.20260930010203.gabcdef1" },
  "pi-lens": { latest: "3.9.4" },
  "pi-readseek": { latest: "0.5.0" },
  "some-tool": { latest: "2.0.0" },
} satisfies DistTags;

const tests: Record<string, () => void | Promise<void>> = {
  "Luna roots and both npm identities use their own package lookup and tags": async () => {
    for (const name of ["@satunix/pi-system", "@satunix/luna"]) {
      const w = makeWorld({ kitSource: `npm:${name}`, packages: ["npm:luna", "npm:@satunix/pi-system@next", "npm:@satunix/luna@next"] });
      try {
        const kit = detectKitInstall(w.cwd);
        assert.equal(kit.root, w.kitRoot);
        assert.equal(kit.kind, "npm");
        assert.equal(mod.ownKitRoot(), w.kitRoot);
        const registry = fakeRegistry({ ...TAGS, "@satunix/luna": TAGS["@satunix/pi-system"], luna: { latest: "1.0.0" } });
        const report = await checkForUpdates(w.cwd, registry.fetchImpl, "0.87.1", fakeGit().git);
        assert.deepEqual(report.packages.map((pkg) => pkg.name), ["luna"]);
        assert.ok(registry.calls.some((url) => decodeURIComponent(url).includes(`/-/package/${name}/dist-tags`)));
        assert.equal(report.kit.available, true);
        assert.equal(nth(planChannelSwitch(report, "next").steps, 0).args[1], `npm:${name}@next`);
        writeJson(path.join(w.agent, "settings.json"), { packages: [w.kitRoot] });
        assert.equal(detectKitInstall(w.cwd).kind, "local");
        writeJson(path.join(w.kitRoot, "package.json"), { name: "luna", version: "1.0.0" });
        assert.equal(mod.ownKitRoot(), null, "bare luna is foreign");
        assert.equal(detectKitInstall(w.cwd).kind, "none");
      } finally { w.cleanup(); }
    }
  },

  "canonical Luna git URLs are recognised; unrelated Luna repositories remain foreign": () => {
    for (const source of [
      "git:github.com/SATUNIX/luna@v0.2.4", "git:git@GITHUB.COM:sAtUnIx/luna.git@feature/test",
      "https://github.com/SATUNIX/luna.git@next", "http://github.com/SATUNIX/luna",
      "ssh://git@GITHUB.COM:2222/SATUNIX/luna.git", "git:https://github.com/SATUNIX/luna",
      "git:ssh://git@github.com/SATUNIX/luna", "git:git://github.com/SATUNIX/luna",
    ]) {
      assert.equal(mod.isKitGitSource(source), true, source);
      const w = makeGitWorld({ kitSource: source });
      try {
        const parsed = parseGitSource(source);
        assert.ok(parsed);
        const root = path.join(w.agent, "git", parsed.host, ...parsed.path.split("/"));
        writeJson(path.join(root, "package.json"), { name: "@satunix/luna", version: "0.2.4" });
        writeJson(path.join(root, "packages", "core", "install.ts"), {});
        assert.equal(detectKitInstall(w.cwd).root, root);
        assert.equal(detectKitInstall(w.cwd).kind, "git");
      } finally { w.cleanup(); }
    }
    for (const source of ["git:github.com/alice/luna", "git:gitlab.com/x/luna", "git:github.com.evil.invalid/SATUNIX/luna", "npm:luna"]) {
      assert.equal(mod.isKitGitSource(source), false, source);
      const w = makeGitWorld({ kitSource: source });
      try { assert.equal(detectKitInstall(w.cwd).kind, "none", source); } finally { w.cleanup(); }
    }
  },

  "previous public sources move to the current source in both directions, preserving channel and profile": async () => {
    const previousSource = "git:github.com/SATUNIX/pi-system";
    for (const [previous, current] of [[previousSource, GIT_SOURCE], [GIT_SOURCE, previousSource]]) {
      assert.ok(previous && current);
      for (const channel of ["latest", "next", "0.2.1-beta.0"]) {
        const source = channel === "next" ? previous : `${previous}@v0.2.1-beta.0`;
        const w = makeGitWorld({ kitSource: source, marker: { profile: "lite", channel, kitSource: source } });
        try {
          // Put the fixture at pi's actual installed path for this URL (also tests rollback).
          const parsed = parseGitSource(source);
          assert.ok(parsed);
          const root = path.join(w.agent, "git", parsed.host, ...parsed.path.split("/"));
          writeJson(path.join(root, "package.json"), { name: "@satunix/luna", version: "0.2.4" });
          writeJson(path.join(root, "packages", "core", "install.ts"), {});
          writeJson(path.join(root, "packages", "core", "distribution.json"), { delivery: "git", git: { source: current, previousSources: [previous] } });
          const git = fakeGit();
          const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", git.git);
          assert.equal(report.kit.legacy, false);
          assert.equal(report.kit.channel, channel);
          assert.equal(report.kit.migrateSource, current);
          assert.equal(report.kit.available, true);
          assert.equal(report.kit.migrateTo, null);
          assert.match(report.kit.note ?? "", /previous public source/);
          assert.doesNotMatch(report.kit.note ?? "", /private|retired/);
          const step = nth(planUpdate(report, "kit").steps, 0);
          assert.deepEqual(step.args.slice(1), ["--mode", "git", "--channel", channel, "--profile", "lite", "--yes"]);
          assert.ok(step.verify);
          assert.notEqual(await step.verify(), null, "the move must be verified");
          const target = channel === "next" ? current : `${current}@v0.2.1-beta.0`;
          // Model pi having installed the destination checkout, including its own distribution metadata.
          const destination = parseGitSource(target);
          assert.ok(destination);
          const destinationRoot = path.join(w.agent, "git", destination.host, ...destination.path.split("/"));
          writeJson(path.join(destinationRoot, "package.json"), { name: "@satunix/pi-system", version: "0.2.4" });
          writeJson(path.join(destinationRoot, "packages", "core", "install.ts"), {});
          writeJson(path.join(destinationRoot, "packages", "core", "distribution.json"), { delivery: "git", git: { source: current, previousSources: [previous] } });
          writeJson(path.join(w.agent, "settings.json"), { packages: [target] });
          writeJson(path.join(w.agent, ".pi-kit.json"), { profile: "lite", channel, kitSource: target });
          assert.equal(await step.verify(), null);
          const upToDate = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", git.git);
          assert.equal(upToDate.kit.migrateSource, null, "the current source is not moved again");
          // The project settings entry remains authoritative even without a project marker.
          writeJson(path.join(w.cwd, ".pi", "settings.json"), { packages: [source] });
          const restoreRoot = setEnv("PI_KIT_ROOT", root);
          try {
            const project = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", git.git);
            const move = nth(planUpdate(project, "kit").steps, 0);
            assert.equal(move.cwd, w.cwd);
            assert.deepEqual(move.args.slice(-2), ["--scope", "project"]);
            const switchStep = nth(planChannelSwitch(project, "next").steps, 0);
            assert.equal(switchStep.args.includes("--settings-only"), false);
          } finally { restoreRoot(); }
        } finally { w.cleanup(); }
      }
    }
  },

  "kit-update refuses malformed previousSources metadata": () => {
    const w = makeGitWorld();
    try {
      for (const previousSources of [null, "wrong", [42], [""], ["npm:luna"]]) {
        writeJson(path.join(w.kitRoot, "packages", "core", "distribution.json"), { git: { previousSources } });
        assert.throws(() => mod.readDistribution(w.kitRoot), /git.previousSources/);
      }
    } finally { w.cleanup(); }
  },

  "semver precedence matches what pi update relies on": () => {
    assert.ok(compareVersions("0.2.1-beta.1", "0.2.1-beta.0") > 0);
    assert.ok(compareVersions("0.2.1", "0.2.1-beta.9") > 0);
    assert.ok(compareVersions("0.2.1-beta.10", "0.2.1-beta.9") > 0);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  },

  "next snapshots sort between the release they follow and the next one": () => {
    const when = new Date("2026-09-24T06:15:00Z");
    const beta = snapshotVersion("0.2.1-beta.0", "1a2b3c4d5e", when);
    assert.equal(beta, "0.2.1-beta.0.next.20260924061500.g1a2b3c4");
    assert.ok(compareVersions(beta, "0.2.1-beta.0") > 0);
    assert.ok(compareVersions(beta, "0.2.1-beta.1") < 0);
    const later = snapshotVersion("0.2.1-beta.0", "1a2b3c4d5e", new Date("2026-09-24T06:16:00Z"));
    assert.ok(compareVersions(later, beta) > 0, "later snapshots of one base must sort higher");
    const stable = snapshotVersion("0.2.1", "0000000aaa", when);
    assert.equal(stable, "0.2.2-next.20260924061500.g0000000");
    assert.ok(compareVersions(stable, "0.2.1") > 0 && compareVersions(stable, "0.2.2") < 0);
    assert.throws(() => snapshotVersion(beta, "1a2b3c4", when), /already a snapshot/);
  },

  "parses npm sources with scopes, tags and pins": () => {
    assert.deepEqual(parseNpmSource("npm:@satunix/pi-system"), { name: "@satunix/pi-system", spec: null });
    assert.deepEqual(parseNpmSource("npm:@satunix/pi-system@next"), { name: "@satunix/pi-system", spec: "next" });
    assert.deepEqual(parseNpmSource("npm:pi-lens@3.8.63"), { name: "pi-lens", spec: "3.8.63" });
    assert.equal(parseNpmSource("git:github.com/x/y"), null);
  },

  "detects the channel of an npm install": () => {
    const cases: Array<[source: string, channel: string, pinned: boolean]> = [
      ["npm:@satunix/pi-system", "latest", false],
      ["npm:@satunix/pi-system@next", "next", false],
      ["npm:@satunix/pi-system@0.2.1-beta.0", "0.2.1-beta.0", true],
    ];
    for (const [source, channel, pinned] of cases) {
      const w = makeWorld({ kitSource: source });
      try {
        const kit = detectKitInstall(w.cwd);
        assert.equal(kit.kind, "npm");
        assert.equal(kit.channel, channel);
        assert.equal(kit.pinned, pinned);
        assert.equal(kit.version, "0.2.1-beta.0");
      } finally {
        w.cleanup();
      }
    }
  },

  "reports kit, pi and linked package updates": async () => {
    const w = makeWorld({
      packages: ["npm:pi-lens@3.8.63", "npm:some-tool", "npm:pi-readseek@0.4.26"],
      installed: { "pi-lens": "3.8.63", "some-tool": "1.0.0", "pi-readseek": "0.4.26" },
    });
    try {
      const { fetchImpl } = fakeRegistry(TAGS);
      const report = await checkForUpdates(w.cwd, fetchImpl, "0.85.1");
      assert.equal(report.kit.available, true);
      assert.equal(report.kit.target, "0.2.1-beta.1");
      assert.equal(report.pi.available, true);
      const byName = Object.fromEntries(report.packages.map((p) => [p.name, p.action]));
      assert.deepEqual(byName, { "pi-lens": "reconcile", "some-tool": "update", "pi-readseek": "pinned" });
      assert.ok(hasUpdates(report));
      assert.match(summaryLine(report), /pi-system 0\.2\.1-beta\.0 → 0\.2\.1-beta\.1 \(latest\).*pi 0\.85\.1 → 0\.87\.1.*2 linked packages/);
    } finally {
      w.cleanup();
    }
  },

  "pi moves only within the version the kit release is tested with": async () => {
    const w = makeWorld({ piTested: "0.87.1" });
    try {
      // A pi release past the tested version is reported, not offered: `pi update --self` cannot stop at the tested one.
      const past = { ...TAGS, "@earendil-works/pi-coding-agent": { latest: "0.99.0" } };
      const report = await checkForUpdates(w.cwd, fakeRegistry(past).fetchImpl, "0.85.1");
      assert.deepEqual(report.pi, { current: "0.85.1", latest: "0.99.0", available: false, tested: "0.87.1", beyondTested: true });
      assert.doesNotMatch(summaryLine(report), /pi 0\.85\.1/, "the summary must not advertise a pi update past the tested version");
      assert.match(formatReport(report), /0\.99\.0 is out, past the tested 0\.87\.1: update pi-system first, or run "pi update --self" yourself/);
      for (const what of ["pi", "all"] as const) {
        const plan = planUpdate(report, what);
        assert.equal(plan.steps.some((s) => s.args.includes("--self")), false, `/update ${what} must not update pi past the tested version`);
        assert.match(plan.notes.join("\n"), /0\.99\.0 is newer than 0\.87\.1, the pi this pi-system release is tested with/);
      }

      // Up to the tested version, the update is offered as before.
      const within = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.85.1");
      assert.deepEqual(within.pi, { current: "0.85.1", latest: "0.87.1", available: true, tested: "0.87.1", beyondTested: false });
      assert.ok(planUpdate(within, "pi").steps.some((s) => s.label === "update pi to 0.87.1" && s.args.includes("--self")));

      // A pi already past the tested version is flagged in the status.
      const ahead = await checkForUpdates(w.cwd, fakeRegistry(past).fetchImpl, "0.99.0");
      assert.equal(ahead.pi.available, false);
      assert.match(formatReport(ahead), /pi {9}0\.99\.0 {2}\(up to date\) {2}\[newer than the tested 0\.87\.1\]/);
    } finally {
      w.cleanup();
    }

    // A kit without an exact pin (an unknown tested version) keeps offering the newest pi.
    const loose = makeWorld({ piTested: "^0.87.1" });
    try {
      const report = await checkForUpdates(loose.cwd, fakeRegistry({ ...TAGS, "@earendil-works/pi-coding-agent": { latest: "0.99.0" } }).fetchImpl, "0.85.1");
      assert.deepEqual(report.pi, { current: "0.85.1", latest: "0.99.0", available: true, tested: null, beyondTested: false });
    } finally {
      loose.cleanup();
    }
  },

  "reports stale user role copies that shadow shipped kit roles": async () => {
    const w = makeWorld();
    try {
      // No user agents dir yet: nothing to report, and a missing dir must not throw.
      assert.deepEqual(detectStaleRoleCopies(w.agent, w.kitRoot), []);

      // A differing copy of a shipped role is stale.
      fs.mkdirSync(path.join(w.agent, "agents"), { recursive: true });
      const scoutCopy = path.join(w.agent, "agents", "scout.md");
      fs.writeFileSync(scoutCopy, "---\nname: scout\n---\nmy edited body\n");
      assert.deepEqual(detectStaleRoleCopies(w.agent, w.kitRoot), [{ name: "scout", path: scoutCopy }]);

      // A byte-equal copy of another shipped role is harmless and stays unflagged.
      fs.writeFileSync(
        path.join(w.agent, "agents", "reviewer.md"),
        fs.readFileSync(path.join(w.kitRoot, "packages", "kit", "agents", "reviewer.md"), "utf8"),
      );
      assert.deepEqual(detectStaleRoleCopies(w.agent, w.kitRoot), [{ name: "scout", path: scoutCopy }]);

      // A user role whose name is not a kit role is ignored.
      fs.writeFileSync(path.join(w.agent, "agents", "my-custom.md"), "---\nname: my-custom\n---\nbody\n");
      assert.deepEqual(detectStaleRoleCopies(w.agent, w.kitRoot), [{ name: "scout", path: scoutCopy }]);

      // Detection is report-only: nothing is deleted.
      assert.ok(fs.existsSync(scoutCopy));
      assert.ok(fs.existsSync(path.join(w.agent, "agents", "reviewer.md")));
      assert.ok(fs.existsSync(path.join(w.agent, "agents", "my-custom.md")));

      // The check surfaces the stale copy in its report and formatted output.
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1");
      assert.deepEqual(report.staleRoles, [{ name: "scout", path: scoutCopy }]);
      const text = formatReport(report);
      assert.match(text, /scout/);
      assert.match(text, /agents/);
      assert.match(text, new RegExp(scoutCopy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      w.cleanup();
    }
  },

  "the next channel compares against the next dist-tag": async () => {
    const w = makeWorld({ kitSource: "npm:@satunix/pi-system@next" });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1");
      assert.equal(report.kit.target, TAGS["@satunix/pi-system"].next);
      assert.equal(report.kit.available, true);
      assert.equal(report.pi.available, false);
    } finally {
      w.cleanup();
    }
  },

  "a pinned kit and pinned-only packages are notices, not updates": async () => {
    const w = makeWorld({ kitSource: "npm:@satunix/pi-system@0.2.1-beta.0", packages: ["npm:pi-readseek@0.4.26"], installed: { "pi-readseek": "0.4.26" } });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1");
      assert.equal(report.kit.available, false);
      assert.match(report.kit.note ?? "", /pinned/);
      assert.equal(hasUpdates(report), false);
      assert.equal(summaryLine(report), "Everything is up to date.");
    } finally {
      w.cleanup();
    }
  },

  "an unreachable registry reports nothing available and flags it": async () => {
    const w = makeWorld();
    try {
      const report = await checkForUpdates(w.cwd, async () => { throw new Error("ENOTFOUND"); }, "0.85.1");
      assert.equal(report.offline, true);
      assert.equal(hasUpdates(report), false);
    } finally {
      w.cleanup();
    }
  },

  "update all updates the kit, packages and pi, then re-applies the profile": async () => {
    const w = makeWorld({ packages: ["npm:pi-lens@3.8.63", "npm:some-tool"], installed: { "pi-lens": "3.8.63", "some-tool": "1.0.0" } });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.85.1");
      const { steps } = planUpdate(report, "all");
      const argv = steps.map((s) => s.args.join(" "));
      assert.equal(argv[0], "update npm:@satunix/pi-system");
      assert.equal(argv[1], "update npm:some-tool");
      assert.ok(nth(argv, 2).endsWith("install.ts --profile balanced --yes --settings-only --scope global"), String(argv[2]));
      assert.equal(argv[3], "update --self", "pi updates last (it needs a restart)");
    } finally {
      w.cleanup();
    }
  },

  "a project marker wins over the global marker for update plans": async () => {
    const w = makeWorld({ marker: { profile: "global-prof", scope: "global" } });
    try {
      writeJson(path.join(w.cwd, ".pi", ".pi-kit.json"), { profile: "proj-prof", scope: "project", kitSource: "npm:@satunix/pi-system" });
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.85.1");
      assert.equal(report.cwd, w.cwd, "the report records the cwd the check ran in");
      const { steps, notes } = planUpdate(report, "all");
      const reconcile = steps.find((s) => s.label === "re-apply the proj-prof profile");
      assert.ok(reconcile, "the project marker's profile must be reconciled, not the global one");
      assert.ok(reconcile.args.join(" ").endsWith("install.ts --profile proj-prof --yes --settings-only --scope project"), reconcile.args.join(" "));
      assert.ok(!notes.some((n) => /No recorded profile to re-apply/.test(n)), "the project marker must supply the profile");
    } finally {
      w.cleanup();
    }
  },

  "channel switch rewrites the kit source with pi install and re-applies the profile": async () => {
    const w = makeWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1");
      const next = planChannelSwitch(report, "next").steps.map((s) => s.args.join(" "));
      assert.equal(next[0], "install npm:@satunix/pi-system@next");
      assert.ok(nth(next, 1).includes("--profile balanced"));
      assert.equal(nth(planChannelSwitch(report, "latest").steps, 0).args.join(" "), "install npm:@satunix/pi-system");
      assert.equal(planChannelSwitch(report, "beta; rm -rf /").steps.length, 0, "channel names are validated");
    } finally {
      w.cleanup();
    }
  },

  "an update whose command exits 0 but changed nothing is reported as a failure, never as success": async () => {
    const w = makeWorld();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeRegistry(TAGS).fetchImpl as typeof fetch;
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      const calls: string[] = [];
      pi.api.exec = async (command: string, args: string[]) => {
        calls.push(args.join(" "));
        return { stdout: "Already up to date", stderr: "", code: 0 };
      };
      const notes: Note[] = [];
      let reloaded = 0;
      const ctx = {
        hasUI: true,
        cwd: w.cwd,
        ui: { notify: (m: string, l?: string) => notes.push({ m, l }), setStatus() {}, confirm: async () => true, select: async () => undefined },
        reload: async () => { reloaded++; },
      };
      await pi.commands.get("update").handler("kit", ctx);
      assert.equal(calls.length, 1, "later steps are not run after a failed verification");
      assert.equal(reloaded, 0, "no reload after an update that did not happen");
      const error = notes.find((n) => n.l === "error");
      assert.ok(error && /did not take effect/.test(error.m) && /still 0\.2\.1-beta\.0|is 0\.2\.1-beta\.0/.test(error.m), error?.m ?? "no error notice");
      assert.ok(!notes.some((n) => /Updated/.test(n.m)), "no success message");
    } finally {
      globalThis.fetch = realFetch;
      w.cleanup();
    }
  },

  "a session without a UI still gets the outcome, on stderr": async () => {
    const w = makeWorld();
    const realFetch = globalThis.fetch;
    const realWrite = process.stderr.write.bind(process.stderr);
    globalThis.fetch = fakeRegistry(TAGS).fetchImpl as typeof fetch;
    const written: string[] = [];
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      pi.api.exec = async () => ({ stdout: "", stderr: "npm ERR! network", code: 1 });
      process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
      const ctx = { hasUI: false, cwd: w.cwd, ui: {}, reload: async () => {} };
      await pi.commands.get("update").handler("", ctx);
      await pi.commands.get("update").handler("kit", ctx);
      await pi.commands.get("update").handler("bogus", ctx);
      process.stderr.write = realWrite;
      const text = written.join("");
      assert.match(text, /pi-system update status/, "no argument prints the status instead of doing nothing");
      assert.match(text, /Non-interactive session/);
      assert.match(text, /"update pi-system to [^"]+" failed: exit 1[\s\S]*npm ERR! network/, "a failed step is reported with its output");
      assert.match(text, /unknown option "bogus"/);
    } finally {
      process.stderr.write = realWrite;
      globalThis.fetch = realFetch;
      w.cleanup();
    }
  },

  "an install registered from the retired private source migrates to the public one without contacting it": async () => {
    const legacy = "git:legacy.example.invalid/lab/pi-system";
    const w = makeGitWorld({ kitSource: `${legacy}@v0.2.1-beta.0`, marker: { profile: "balanced", scope: "global", channel: "0.2.1-beta.0", kitSource: `${legacy}@v0.2.1-beta.0` } });
    const restoreEnv = setEnv("PI_SYSTEM_GIT_SOURCE", "git:git@legacy.example.invalid:lab/pi-system");
    try {
      const { git, calls } = fakeGit({ tags: ["0.2.4-beta.0"] });
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", git);
      assert.equal(report.kit.legacy, true);
      assert.equal(report.kit.available, true);
      assert.deepEqual(calls.filter((c) => c.includes("ls-remote")), [], "the retired remote is never contacted");
      assert.match(report.kit.note ?? "", /retired private source/);
      assert.match(report.kit.note ?? "", /PI_SYSTEM_GIT_SOURCE=git:git@legacy.example.invalid:lab\/pi-system names the retired source and is ignored/);
      assert.match(summaryLine(report), /retired private source/);
      assert.match(formatReport(report), /retired private source/);
      const plan = planUpdate(report, "kit");
      assert.equal(plan.steps.length, 1);
      const args = nth(plan.steps, 0).args.join(" ");
      assert.match(args, /install\.ts --mode git --channel latest --profile balanced --yes$/, args);
      assert.ok(!args.includes("legacy.example.invalid"), "the plan never names the retired host");
      // A user following main stays on main.
      writeJson(path.join(w.agent, ".pi-kit.json"), { profile: "balanced", scope: "global", channel: "next", kitSource: legacy });
      writeJson(path.join(w.agent, "settings.json"), { packages: [{ source: legacy, extensions: [] }] });
      const next = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", git);
      assert.match(nth(planUpdate(next, "kit").steps, 0).args.join(" "), /--channel next/);
    } finally {
      restoreEnv();
      w.cleanup();
    }
  },

  "a stale PI_SYSTEM_GIT_SOURCE naming the retired source is ignored, other overrides are kept": () => {
    const restore = setEnv("PI_SYSTEM_GIT_SOURCE", "git:git@legacy.example.invalid:lab/pi-system");
    try {
      const d = mod.readDistribution(null);
      assert.equal(d.gitSource, null, "no source is invented from the retired override");
      assert.equal(d.ignoredEnvSource, "git:git@legacy.example.invalid:lab/pi-system");
      assert.ok(mod.isLegacyGitSource("https://legacy.example.invalid/root/pi-system.git"));
      assert.ok(!mod.isLegacyGitSource("git:github.com/SATUNIX/luna"));
      assert.ok(!mod.isLegacyGitSource("git:github.com/example/pi-system"));
      process.env.PI_SYSTEM_GIT_SOURCE = "git:github.com/example/pi-system";
      const fork = mod.readDistribution(null);
      assert.equal(fork.gitSource, "git:github.com/example/pi-system", "a fork override is the user's choice");
      assert.equal(fork.ignoredEnvSource, null);
    } finally {
      restore();
    }
  },

  "/update runs the confirmed plan, stops on failure and does not reload": async () => {
    const w = makeWorld({ packages: ["npm:some-tool"], installed: { "some-tool": "1.0.0" } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeRegistry(TAGS).fetchImpl as typeof fetch;
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      const calls: string[] = [];
      let failAt = 1;
      pi.api.exec = async (command: string, args: string[]) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: calls.length === failAt ? "boom" : "", code: calls.length === failAt ? 1 : 0 };
      };
      const notes: Note[] = [];
      let reloaded = 0;
      const ctx = {
        hasUI: true,
        cwd: w.cwd,
        ui: { notify: (m: string, l?: string) => notes.push({ m, l }), setStatus() {}, confirm: async () => true, select: async () => undefined },
        reload: async () => { reloaded++; },
      };
      const handler = pi.commands.get("update").handler;
      await handler("all", ctx);
      assert.equal(calls.length, 1, "must stop at the first failing step");
      assert.equal(reloaded, 0, "a failed update must not reload");
      assert.ok(notes.some((n) => n.l === "error" && /failed/.test(n.m)));

      failAt = 0;
      calls.length = 0;
      // A real `pi update` moves the installed package; simulate that effect so the post-update
      // verification (the update must have taken effect, not merely exited 0) can confirm it.
      pi.api.exec = async (command: string, args: string[]) => {
        calls.push(args.join(" "));
        if (args[0] === "update" && args[1] === "npm:@satunix/pi-system") writeJson(path.join(w.kitRoot, "package.json"), { name: "@satunix/pi-system", version: TAGS["@satunix/pi-system"].latest });
        // The installer rewrites the install marker when it re-applies the profile.
        if ((args[0] ?? "").endsWith("install.ts")) writeJson(path.join(w.agent, ".pi-kit.json"), { profile: "balanced", scope: "global", installedAt: new Date().toISOString() });
        return { stdout: "", stderr: "", code: 0 };
      };
      await handler("kit", ctx);
      assert.deepEqual(calls[0], "update npm:@satunix/pi-system");
      assert.equal(reloaded, 1, "a successful kit update reloads");
      assert.ok(notes.some((n) => /Updated \(verified\)/.test(n.m)), "success says the result was verified");

      await handler("status", ctx);
      assert.ok(notes.at(-1)?.m.includes("pi-system update status"));
    } finally {
      globalThis.fetch = realFetch;
      w.cleanup();
    }
  },

  "parses git sources the way pi identifies them": () => {
    assert.deepEqual(parseGitSource("git:github.com/SATUNIX/luna@v0.2.1-beta.0"), { repo: "https://github.com/SATUNIX/luna", host: "github.com", path: "SATUNIX/luna", ref: "v0.2.1-beta.0" });
    assert.deepEqual(parseGitSource("git:git@github.com:SATUNIX/luna"), { repo: "git@github.com:SATUNIX/luna", host: "github.com", path: "SATUNIX/luna", ref: null });
    assert.equal(parseGitSource("npm:x"), null);
    assert.equal(gitSourceWithRef(`${GIT_SOURCE}@v1.0.0`, "v1.1.0"), `${GIT_SOURCE}@v1.1.0`);
    assert.equal(gitSourceWithRef(`${GIT_SOURCE}@v1.0.0`, null), GIT_SOURCE);
    assert.deepEqual(releaseTags("a\trefs/tags/v0.2.1-beta.0\nb\trefs/tags/v0.2.1-beta.0^{}\nc\trefs/tags/junk\nd\trefs/tags/v0.2.0\n"), ["0.2.0", "0.2.1-beta.0"]);
    assert.equal(latestRelease(["0.2.1-beta.0", "0.2.1-beta.1"]), "0.2.1-beta.1", "betas are latest until a stable release exists");
    assert.equal(latestRelease(["0.2.0", "0.2.1-beta.3"]), "0.2.0", "then latest is the newest stable release");
  },

  "detects the channel of a git install": () => {
    const cases: Array<[source: string, marker: Marker, channel: string, pinned: boolean]> = [
      [`${GIT_SOURCE}@v0.2.1-beta.0`, { profile: "balanced" }, "latest", false],
      [GIT_SOURCE, { profile: "balanced" }, "next", false],
      [`${GIT_SOURCE}@v0.2.1-beta.0`, { profile: "balanced", kitSource: `${GIT_SOURCE}@v0.2.1-beta.0`, channel: "0.2.1-beta.0" }, "0.2.1-beta.0", true],
    ];
    for (const [source, marker, channel, pinned] of cases) {
      const w = makeGitWorld({ kitSource: source, marker });
      try {
        const kit = detectKitInstall(w.cwd);
        assert.equal(kit.kind, "git");
        assert.equal(kit.channel, channel);
        assert.equal(kit.pinned, pinned);
        assert.equal(kit.root, w.kitRoot, "the kit root is pi's clone of the git source");
        assert.equal(kit.version, "0.2.1-beta.0");
      } finally {
        w.cleanup();
      }
    }
  },

  "/update that stops after replacing the kit names the mixed state, the version before and both ways out": async () => {
    const w = makeWorld();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeRegistry(TAGS).fetchImpl as typeof fetch;
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      // The kit step takes effect; re-applying the profile with the new kit's installer then fails.
      pi.api.exec = async (_command: string, args: string[]) => {
        if (args[0] === "update" && args[1] === "npm:@satunix/pi-system") writeJson(path.join(w.kitRoot, "package.json"), { name: "@satunix/pi-system", version: TAGS["@satunix/pi-system"].latest });
        const reapply = (args[0] ?? "").endsWith("install.ts");
        return { stdout: "", stderr: reapply ? "profile names a renamed extension" : "", code: reapply ? 1 : 0 };
      };
      const notes: Note[] = [];
      let reloaded = 0;
      const ctx = {
        hasUI: true,
        cwd: w.cwd,
        ui: { notify: (m: string, l?: string) => notes.push({ m, l }), setStatus() {}, confirm: async () => true, select: async () => undefined },
        reload: async () => { reloaded++; },
      };
      await pi.commands.get("update").handler("kit", ctx);
      assert.equal(reloaded, 0);
      const error = notes.find((n) => n.l === "error")?.m ?? "";
      assert.match(error, /"re-apply the balanced profile" failed/);
      assert.match(error, /does not undo "update pi-system to 0\.2\.1-beta\.1": the new kit is installed, but the profile was not re-applied/);
      assert.match(error, /Before the update it was pi-system 0\.2\.1-beta\.0 on latest; \/update channel 0\.2\.1-beta\.0 goes back to it\./);
      assert.match(error, /re-apply the profile with: \(cd "[^"]+" && \S*node\S* \S*install\.ts --profile balanced --yes --settings-only --scope global\)$/);
      assert.doesNotMatch(error, /run \/update again/, "a second /update sees no kit update and would not re-apply the profile");

      // A failure before the kit changed is not a mixed state.
      writeJson(path.join(w.kitRoot, "package.json"), { name: "@satunix/pi-system", version: "0.2.1-beta.0" });
      notes.length = 0;
      pi.api.exec = async () => ({ stdout: "", stderr: "boom", code: 1 });
      await pi.commands.get("update").handler("kit", ctx);
      const first = notes.find((n) => n.l === "error")?.m ?? "";
      assert.match(first, /Fix the cause and run \/update again/);
      assert.doesNotMatch(first, /does not undo/);
    } finally {
      globalThis.fetch = realFetch;
      w.cleanup();
    }
  },

  "git latest: a newer release tag is an update, applied by re-pointing the tag": async () => {
    const w = makeGitWorld();
    try {
      const { git } = fakeGit({ tags: ["0.2.1-beta.0", "0.2.1-beta.1"] });
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", git);
      assert.equal(report.kit.available, true);
      assert.equal(report.kit.target, "0.2.1-beta.1");
      assert.equal(report.kit.tags?.latest, "0.2.1-beta.1");
      assert.match(summaryLine(report), /pi-system 0\.2\.1-beta\.0 → 0\.2\.1-beta\.1 \(latest\)/);
      assert.match(formatReport(report), /\[git, channel latest\]/);
      const argv = planUpdate(report, "kit").steps.map((s) => s.args.join(" "));
      assert.equal(argv[0], `install ${GIT_SOURCE}@v0.2.1-beta.1`);
      assert.ok(nth(argv, 1).endsWith("install.ts --profile balanced --yes --settings-only --scope global"), String(argv[1]));
    } finally {
      w.cleanup();
    }
  },

  "git latest: up to date when the newest tag is installed": async () => {
    const w = makeGitWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0"] }).git);
      assert.equal(report.kit.available, false);
      assert.equal(hasUpdates(report), false);
    } finally {
      w.cleanup();
    }
  },

  "git next: a new commit on main is an update, applied with pi update": async () => {
    const w = makeGitWorld({ kitSource: GIT_SOURCE });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ head: SHA_OLD, main: SHA_MAIN }).git);
      assert.equal(report.kit.available, true);
      assert.equal(report.kit.target, `main@${SHA_MAIN.slice(0, 7)}`);
      assert.equal(nth(planUpdate(report, "kit").steps, 0).args.join(" "), `update ${GIT_SOURCE}`);
      const same = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ head: SHA_MAIN, main: SHA_MAIN }).git);
      assert.equal(same.kit.available, false);
    } finally {
      w.cleanup();
    }
  },

  "git pinned: newer tags are a notice, not an update": async () => {
    const w = makeGitWorld({ marker: { profile: "balanced", kitSource: `${GIT_SOURCE}@v0.2.1-beta.0`, channel: "0.2.1-beta.0" } });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0", "0.2.1-beta.1"] }).git);
      assert.equal(report.kit.available, false);
      assert.match(report.kit.note ?? "", /pinned to 0\.2\.1-beta\.0/);
    } finally {
      w.cleanup();
    }
  },

  "git unreachable: nothing available, flagged, never prompts": async () => {
    const w = makeGitWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ reachable: false }).git);
      assert.equal(report.offline, true);
      assert.equal(report.kit.available, false);
      assert.match(report.kit.note ?? "", /could not reach https:\/\/github\.com\/SATUNIX\/luna/);
    } finally {
      w.cleanup();
    }
  },

  "a project-scoped install runs the installer in the project, not the kit root": async () => {
    const w = makeGitWorld(); // a global marker lives in the agent dir
    try {
      // Project settings entry, but no project marker: the inconsistent state where the
      // settings entry is authoritative for the scope.
      writeJson(path.join(w.cwd, ".pi", "settings.json"), {
        packages: [{ source: GIT_SOURCE, extensions: ["packages/extensions/third_party/todo/index.ts"] }],
      });
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0", "0.2.1-beta.1"] }).git);
      assert.equal(report.kit.scope, "project", "the project settings entry makes the install project-scoped");

      const reconcile = planUpdate(report, "all").steps.find((s) => s.label.startsWith("re-apply"));
      assert.ok(reconcile, "the recorded profile must be re-applied");
      assert.ok(reconcile.args.join(" ").endsWith("--scope project"), reconcile.args.join(" "));
      assert.equal(reconcile.cwd, w.cwd, "reconcile must run install.ts in the project");
      assert.notEqual(reconcile.cwd, w.kitRoot);

      const installer = planChannelSwitch(report, "next").steps.find((s) => s.label.includes("switch pi-system"));
      assert.ok(installer, "the channel switch must go through the kit installer");
      assert.ok(installer.args.join(" ").includes("--scope project"), installer.args.join(" "));
      assert.equal(installer.cwd, w.cwd, "installer must run install.ts in the project");
      assert.notEqual(installer.cwd, w.kitRoot);
    } finally {
      w.cleanup();
    }
  },

  "a global-scope update still runs the installer from the kit root": async () => {
    const w = makeWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.85.1");
      const reconcile = planUpdate(report, "all").steps.find((s) => s.label.startsWith("re-apply"));
      assert.ok(reconcile, "the recorded profile must be re-applied");
      assert.ok(reconcile.args.join(" ").endsWith("--scope global"), reconcile.args.join(" "));
      assert.equal(reconcile.cwd, w.kitRoot, "global scope keeps the kit root as the installer cwd");
    } finally {
      w.cleanup();
    }
  },

  "the real installer writes the project settings and marker under the project, not the kit root": () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-project-install-"));
    const project = path.join(dir, "project");
    const kitRoot = path.join(dir, "kitroot");
    const agent = path.join(dir, "agent");
    const binDir = path.join(dir, "bin");
    try {
      for (const d of [project, kitRoot, agent, binDir]) fs.mkdirSync(d, { recursive: true });
      // A fake `pi` first on PATH only has to answer `--version`: the kit is pre-registered, so
      // the installer takes the settings-only path and never calls `pi install`.
      const fakePi = path.join(binDir, "pi");
      fs.writeFileSync(fakePi, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(fakePi, 0o755);
      // Project settings entry, but only a global marker: the inconsistent state where the
      // settings entry is authoritative for scope.
      writeJson(path.join(project, ".pi", "settings.json"), { packages: [repoRoot] });
      writeJson(path.join(agent, ".pi-kit.json"), { profile: "balanced", scope: "global" });
      const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: agent,
        PI_LEAN_CTX_BIN: path.join(agent, "no-lean-ctx"),
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      // Drive the caller's reconcile step rather than install.ts directly, so the plan's cwd
      // and args are what the real installer actually receives.
      const report: ReconcileReport = {
        kit: { kind: "npm", root: repoRoot, source: "npm:@satunix/pi-system", scope: "project", available: true, target: "0.2.1-beta.1", channel: "latest" },
        packages: [],
        pi: { available: false },
        cwd: project,
      };
      const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
      let step;
      try {
        step = planUpdate(report as KitUpdate.UpdateReport, "kit").steps.find((s) => s.label.startsWith("re-apply"));
      } finally {
        restoreAgent();
      }
      assert.ok(step, "the project settings entry must yield a reconcile step");
      assert.equal(step.args[step.args.indexOf("--scope") + 1], "project", step.args.join(" "));
      assert.equal(step.cwd, project, "the reconcile step must run install.ts in the project");
      assert.notEqual(step.cwd, kitRoot);

      const result = spawnSync(step.command, step.args, { cwd: step.cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const marker = path.join(project, ".pi", ".pi-kit.json");
      assert.ok(fs.existsSync(marker), "the project marker must be written under the project");
      const written = parseJson(fs.readFileSync(marker, "utf8"));
      assert.ok(isRecord(written), "the project marker holds an object");
      assert.equal(written.scope, "project");
      // The profile filter is written to the project settings file too, not just the marker.
      const settings = JSON.parse(fs.readFileSync(path.join(project, ".pi", "settings.json"), "utf8")) as { packages?: Array<string | { source?: string; extensions?: string[] }> };
      const entry = (settings.packages ?? []).find((p) => {
        const source = typeof p === "string" ? p : p?.source;
        return typeof source === "string" && path.resolve(project, ".pi", source) === repoRoot;
      });
      assert.ok(entry, "the project settings entry must be written under the project");
      assert.ok(typeof entry === "object" && Array.isArray(entry.extensions) && entry.extensions.length > 0, "the profile's extension filter must reach the project settings");
      assert.ok(!fs.existsSync(path.join(kitRoot, ".pi")), "the kit root must not gain a .pi/ directory");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "git channel switch goes through the kit installer, then re-applies the profile": async () => {
    const w = makeGitWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0"] }).git);
      for (const channel of ["next", "latest", "0.2.1-beta.0"]) {
        const argv = planChannelSwitch(report, channel).steps.map((s) => s.args.join(" "));
        assert.ok(nth(argv, 0).endsWith(`install.ts --mode git --channel ${channel} --profile balanced --yes --settings-only`), String(argv[0]));
        assert.ok(nth(argv, 1).endsWith("install.ts --profile balanced --yes --settings-only --scope global"), String(argv[1]));
      }
      assert.equal(planChannelSwitch(report, "main; rm -rf /").steps.length, 0);
    } finally {
      w.cleanup();
    }
  },

  "a kit release that changes the delivery moves the install over": async () => {
    const w = makeGitWorld({ delivery: "npm" });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0"] }).git);
      assert.equal(report.kit.migrateTo, "npm");
      assert.ok(hasUpdates(report));
      assert.match(summaryLine(report), /moves to npm delivery/);
      const argv = planUpdate(report, "kit").steps.map((s) => s.args.join(" "));
      assert.equal(argv.length, 1);
      assert.ok(nth(argv, 0).endsWith("install.ts --mode npm --channel latest --profile balanced --yes"), String(argv[0]));
    } finally {
      w.cleanup();
    }
  },

  "a local checkout is behind only when upstream has commits it does not contain": async () => {
    const w = makeWorld({ kitSource: "../kit" });
    try {
      // Register the scratch kit root as a local path.
      writeJson(path.join(w.agent, "settings.json"), { packages: [{ source: w.kitRoot }] });
      const behind = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ head: SHA_OLD, upstream: SHA_MAIN, contains: false }).git);
      assert.equal(behind.kit.kind, "local");
      assert.equal(behind.kit.available, true);
      assert.equal(nth(planUpdate(behind, "all").steps, 0).args.join(" "), `-C ${w.kitRoot} pull --ff-only`);
      const ahead = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ head: SHA_OLD, upstream: SHA_MAIN, contains: true }).git);
      assert.equal(ahead.kit.available, false, "local commits ahead of upstream are not an update");
    } finally {
      w.cleanup();
    }
  },

  "a local checkout whose origin is a retired private source is never contacted, pulled or called up to date": async () => {
    const w = makeWorld({ kitSource: "../kit" });
    try {
      writeJson(path.join(w.agent, "settings.json"), { packages: [{ source: w.kitRoot }] });
      for (const origin of ["https://legacy.example.invalid/lab/pi-system.git", "git@legacy.example.invalid:lab/pi-system.git", "ssh://git@legacy.example.invalid/root/pi-system"]) {
        const g = fakeGit({ head: SHA_OLD, upstream: SHA_MAIN, contains: false, origin });
        const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", g.git);
        assert.equal(report.kit.kind, "local");
        assert.equal(report.kit.legacyOrigin, true, origin);
        assert.equal(g.calls.some((c) => c.includes("ls-remote")), false, `${origin}: the retired remote is never contacted`);
        assert.match(report.kit.note ?? "", /retired private source, so \/update does not contact it/);
        assert.equal(report.kit.available, false);
        assert.equal(report.offline, true, "nothing was looked up, so the report must not read as current");
        assert.doesNotMatch(summaryLine(report), /Everything is up to date/);
        for (const what of ["kit", "all"] as const) {
          const plan = planUpdate(report, what);
          assert.equal(plan.steps.some((s) => s.args.includes("pull")), false, `${what}: no git pull against the retired origin`);
          if (what === "kit") assert.match(plan.notes.join("\n"), /retired private source/);
        }
      }
      // A public origin is looked up as before.
      const pub = fakeGit({ head: SHA_OLD, upstream: SHA_MAIN, contains: false, origin: "https://github.com/SATUNIX/luna.git" });
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", pub.git);
      assert.equal(report.kit.legacyOrigin, undefined);
      assert.equal(pub.calls.some((c) => c.includes("ls-remote")), true);
      assert.equal(report.kit.available, true);
    } finally {
      w.cleanup();
    }
  },

  "a failed lookup is never reported as 'up to date', and only what was confirmed is reported as verified": async () => {
    const w = makeWorld();
    try {
      const offline = await checkForUpdates(w.cwd, async () => { throw new Error("ENOTFOUND"); }, "0.85.1");
      assert.equal(offline.offline, true);
      assert.doesNotMatch(summaryLine(offline), /Everything is up to date/);
      assert.match(summaryLine(offline), /Could not check everything/);
      // Reachable and current: the plain statement still applies.
      const current = await checkForUpdates(w.cwd, fakeRegistry({ ...TAGS, "@satunix/pi-system": { latest: "0.2.1-beta.0" } }).fetchImpl, "0.87.1");
      if (!current.offline && !hasUpdates(current)) assert.equal(summaryLine(current), "Everything is up to date.");
      // Reporting after a run: a step whose check could not run, or that has none, is not "verified".
      const exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
      const steps = [
        { label: "confirmed", command: "x", args: [], verify: async () => null },
        { label: "could not be checked", command: "x", args: [], verify: async () => ({ unverified: "could not run `pi --version`" }) },
        { label: "unchecked", command: "x", args: [] },
      ];
      const outcome = await runPlan({ exec }, w.cwd, steps);
      assert.equal(outcome.ok, true);
      assert.deepEqual(outcome.unverified?.map((u) => u.label), ["could not be checked", "unchecked"]);
      const message = successMessage(outcome);
      assert.match(message, /confirmed \(verified\)/);
      assert.match(message, /could not be checked \(NOT verified: could not run `pi --version`\)/);
      assert.match(message, /unchecked \(NOT verified: the command exited 0; nothing independent confirms it\)/);
      assert.doesNotMatch(message, /^Updated \(verified\)/);
      assert.equal(successMessage(await runPlan({ exec }, w.cwd, [nth(steps, 0)])), "Updated (verified): confirmed.", "everything confirmed keeps the plain wording");
      // A verification that fails still fails the run.
      const failed = await runPlan({ exec }, w.cwd, [{ label: "wrong", command: "x", args: [], verify: async () => "pi is still 0.85.1" }]);
      assert.equal(failed.ok, false);
      assert.match(failed.failed?.reason ?? "", /did not take effect: pi is still 0.85.1/);
    } finally {
      w.cleanup();
    }
  },

  "the background check is throttled": () => {
    const w = makeWorld();
    try {
      assert.equal(shouldCheckNow(), true);
      writeJson(path.join(w.agent, "pi-kit", "update-check.json"), { checkedAt: new Date().toISOString() });
      assert.equal(shouldCheckNow(), false);
      assert.equal(shouldCheckNow(Date.now() + 25 * 60 * 60 * 1000), true);
    } finally {
      w.cleanup();
    }
  },

  "session start does nothing without a UI or when disabled": async () => {
    const w = makeWorld();
    const restore = setEnv("PI_KIT_UPDATE_CHECK", "0");
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      let fetched = 0;
      const realFetch = globalThis.fetch;
      const unreachable: KitUpdate.FetchLike = async () => { fetched++; return { ok: false, json: async () => ({}) }; };
      globalThis.fetch = unreachable as typeof fetch;
      try {
        await pi.handlers.get("session_start")({}, { hasUI: true, cwd: w.cwd, ui: { notify() {}, setStatus() {} } });
        restore();
        await pi.handlers.get("session_start")({}, { hasUI: false, cwd: w.cwd, ui: { notify() {}, setStatus() {} } });
      } finally {
        globalThis.fetch = realFetch;
      }
      assert.equal(fetched, 0);
    } finally {
      restore();
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
  console.error(`\n[kit-update-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[kit-update-smoke] all ${Object.keys(tests).length} checks passed`);
