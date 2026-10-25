#!/usr/bin/env node
/**
 * Offline checks for kit delivery (packages/core/distribution.json): git sources, channels,
 * release-tag selection, settings identity, and which source the installer registers from a
 * checkout, from pi's own git clone of the kit, and with the npm delivery switch.
 *
 * The installer runs in --dry-run against a scratch agent dir, so nothing touches the real pi
 * settings. `latest` over git needs `git ls-remote` and is covered by the pure functions here
 * and by tests/kit-update-smoke.ts, not by a network call.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDistribution, parseGitSource, gitSourceFor, releaseTags, latestRelease, channelOfGitSource, isChannel, isLegacyGitSource, isPreviousGitSource, readRequiredProfileExtensions } from "../packages/core/lib/distribution.ts";
import { SettingsSchema, findPackageEntry, removeOtherKitEntries } from "../packages/core/lib/settings.ts";
import { isolateKitEnv } from "../packages/core/eval/harness.ts";
import { parseJsonAs } from "../packages/core/lib/guard.ts";

const restoreKitEnv = isolateKitEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GIT = "git:github.com/SATUNIX/pi-system";
const LEGACY = "git:legacy.example.invalid/lab/pi-system";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Dry-run the installer at `installer` with a scratch agent dir; returns the printed mode/source.
interface DryRunOptions {
  agent?: string;
  env?: NodeJS.ProcessEnv;
}

interface DryRunResult {
  status: number | null;
  out: string;
  mode: string | null;
  source: string | null;
}

function dryRun(installer: string, args: string[], { agent, env = {} }: DryRunOptions = {}): DryRunResult {
  const result = spawnSync(process.execPath, [installer, ...args, "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_KIT_DELIVERY: "", PI_SYSTEM_GIT_SOURCE: "", ...env },
  });
  const out = `${result.stdout}\n${result.stderr}`;
  return {
    status: result.status,
    out,
    mode: out.match(/^\s+mode:\s+(\S+.*)$/m)?.[1]?.trim() ?? null,
    source: out.match(/^\s+source:\s+(\S+)$/m)?.[1] ?? null,
  };
}

const tests = {
  "previous public sources are validated and remain separate from retired sources": () => {
    const dir = scratch("pi-kit-previous-");
    try {
      const file = path.join(dir, "distribution.json");
      for (const previousSources of [null, "git:github.com/SATUNIX/pi-system", [42], [""], ["npm:luna"], ["not a source"]]) {
        writeJson(file, { git: { previousSources } });
        assert.throws(() => readDistribution(file, {}), /git.previousSources/);
      }
      writeJson(file, { git: { source: "git:github.com/SATUNIX/luna", previousSources: [GIT] } });
      const d = readDistribution(file, {});
      assert.deepEqual(d.git.previousSources, [GIT]);
      assert.equal(isPreviousGitSource("ssh://git@GITHUB.COM/satunix/pi-system.git@feature/test", d.git.previousSources), true);
      assert.equal(isLegacyGitSource(GIT, d.git.legacySources), false);
      assert.equal(d.git.source, "git:github.com/SATUNIX/luna");
      assert.deepEqual(readDistribution(undefined, {}).git.previousSources, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
  "distribution.json selects git delivery from the public GitHub repository": () => {
    const d = readDistribution(undefined, {});
    assert.equal(d.delivery, "git");
    assert.equal(d.git.source, GIT);
    assert.equal(d.git.tagPrefix, "v");
    assert.ok(d.git.legacySources.every((s: string) => /^sha256:[a-f0-9]{64}$/.test(s)));
    assert.equal(readDistribution(undefined, { PI_KIT_DELIVERY: "npm" }).delivery, "npm");
    // The old SSH instructions told users to export the private source; it must not stick.
    const stale = readDistribution(undefined, { PI_SYSTEM_GIT_SOURCE: "git:git@legacy.example.invalid:lab/pi-system" });
    assert.equal(stale.git.source, GIT, "a retired override falls back to the public source");
    assert.equal(stale.git.ignoredEnvSource, "git:git@legacy.example.invalid:lab/pi-system");
    assert.ok(isLegacyGitSource("https://legacy.example.invalid/root/pi-system.git", d.git.legacySources));
    assert.ok(!isLegacyGitSource(GIT, d.git.legacySources));
    assert.equal(readDistribution(undefined, { PI_SYSTEM_GIT_SOURCE: "git:git@h.x:o/pi-system" }).git.source, "git:git@h.x:o/pi-system");
    assert.throws(() => readDistribution(undefined, { PI_KIT_DELIVERY: "ftp" }), /unknown kit delivery/);
  },

  "readDistribution ignores a non-object distribution.json": () => {
    const dir = scratch("pi-kit-dist-nonobject-");
    try {
      const file = path.join(dir, "distribution.json");
      for (const payload of [null, "[]", '"nope"']) {
        fs.writeFileSync(file, payload ?? "null");
        const d = readDistribution(file, {});
        assert.equal(d.delivery, "git", `delivery for ${payload ?? "null"}`);
        assert.equal(d.git.source, "");
        assert.equal(d.git.branch, "main");
        assert.equal(d.git.tagPrefix, "v");
        assert.equal(d.npm.package, "@satunix/pi-system");
      }
      fs.writeFileSync(file, JSON.stringify({ delivery: "npm" }));
      assert.equal(readDistribution(file, {}).delivery, "npm");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "git sources parse to pi's identity (host/path, ref ignored)": () => {
    assert.deepEqual(parseGitSource(`${GIT}@v0.2.1-beta.0`), { repo: "https://github.com/SATUNIX/pi-system", ref: "v0.2.1-beta.0", key: "github.com/satunix/pi-system" });
    const ssh = parseGitSource("git:git@github.com:SATUNIX/pi-system");
    assert.ok(ssh);
    assert.equal(ssh.key, "github.com/satunix/pi-system");
    const https = parseGitSource("https://github.com/SATUNIX/pi-system.git");
    assert.ok(https);
    assert.equal(https.repo, "https://github.com/SATUNIX/pi-system");
    assert.equal(parseGitSource("npm:@satunix/pi-system"), null);
    assert.equal(parseGitSource("/home/me/pi-system"), null);
    assert.equal(gitSourceFor(`${GIT}@v1.0.0`, "v1.1.0"), `${GIT}@v1.1.0`);
    assert.equal(gitSourceFor(`${GIT}@v1.0.0`, null), GIT);
    assert.equal(channelOfGitSource(GIT), "next");
    assert.equal(channelOfGitSource(`${GIT}@v1.0.0`), "latest");
    assert.equal(channelOfGitSource(`${GIT}@feature-x`), "feature-x");
  },

  "latest is the newest stable tag, or the newest beta before any stable release": () => {
    const lsRemote = ["a\trefs/tags/v0.2.1-beta.0", "a\trefs/tags/v0.2.1-beta.0^{}", "b\trefs/tags/v0.2.1-beta.1", "c\trefs/tags/nightly", "d\trefs/heads/main"].join("\n");
    assert.deepEqual(releaseTags(lsRemote), ["0.2.1-beta.0", "0.2.1-beta.1"]);
    assert.equal(latestRelease(releaseTags(lsRemote)), "0.2.1-beta.1");
    assert.equal(latestRelease(["0.2.0", "0.2.1-beta.4"]), "0.2.0");
    assert.equal(latestRelease([]), null);
    for (const ok of ["latest", "next", "0.2.1-beta.0", "1.0.0"]) assert.ok(isChannel(ok), ok);
    for (const bad of ["main", "v1.0.0", "1.0", "latest; rm -rf /"]) assert.ok(!isChannel(bad), bad);
  },

  "settings: one git registration of the kit, whatever its ref": () => {
    const dir = scratch("pi-kit-dist-settings-");
    try {
      const settingsPath = path.join(dir, "settings.json");
      writeJson(settingsPath, { packages: [`${GIT}@v0.2.1-beta.0`, "git:github.com/example/other-tool", "npm:pi-lens@3.8.63"] });
      const settings = parseJsonAs(SettingsSchema, fs.readFileSync(settingsPath, "utf8"), settingsPath);
      assert.equal(findPackageEntry(settings, GIT, settingsPath), 0, "next and a release tag are the same package");
      assert.equal(findPackageEntry(settings, "git:git@github.com:SATUNIX/pi-system@v9.0.0", settingsPath), 0, "ssh and https forms are the same package");
      writeJson(settingsPath, { packages: [`${GIT}@v0.2.1-beta.0`, "npm:@satunix/pi-system@next", "git:github.com/example/other-tool"] });
      assert.equal(removeOtherKitEntries(settingsPath, `${GIT}@v0.2.1-beta.1`), 1, "the npm copy of the kit is removed");
      assert.deepEqual(parseJsonAs(SettingsSchema, fs.readFileSync(settingsPath, "utf8"), settingsPath).packages, [`${GIT}@v0.2.1-beta.0`, "git:github.com/example/other-tool"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "installer moves previous public sources on explicit channels and preserves profile switches": () => {
    const agent = scratch("pi-kit-dist-previous-");
    const fixture = path.join(agent, "fixture");
    try {
      for (const part of ["core", "extensions", "kit"]) {
        fs.cpSync(path.join(ROOT, "packages", part), path.join(fixture, "packages", part), { recursive: true });
      }
      fs.copyFileSync(path.join(ROOT, "package.json"), path.join(fixture, "package.json"));
      const current = "git:github.com/SATUNIX/luna";
      writeJson(path.join(fixture, "packages", "core", "distribution.json"), { delivery: "git", requiredProfileExtensions: readRequiredProfileExtensions(), git: { source: current, previousSources: [GIT] } });
      const installer = path.join(fixture, "packages", "core", "install.ts");
      for (const channel of ["next", "0.2.1-beta.0"]) {
        const source = channel === "next" ? GIT : `${GIT}@v${channel}`;
        writeJson(path.join(agent, "settings.json"), { packages: [source] });
        writeJson(path.join(agent, ".pi-kit.json"), { kitSource: source, channel, profile: "lite" });
        const keep = dryRun(installer, ["--profile", "lite", "--settings-only", "--mode", "git"], { agent });
        assert.equal(keep.status, 0, keep.out);
        assert.equal(keep.source, source, "profile switches retain the existing registration");
        const move = dryRun(installer, ["--profile", "lite", "--mode", "git", "--channel", channel], { agent });
        assert.equal(move.status, 0, move.out);
        assert.equal(move.source, channel === "next" ? current : `${current}@v${channel}`);
        assert.match(move.out, /previous public source/);
        assert.doesNotMatch(move.out, /retired private/);
      }
    } finally { fs.rmSync(agent, { recursive: true, force: true }); }
  },

  "installer: npm delivery works once distribution.json enables it": () => {
    const agent = scratch("pi-kit-dist-npm-");
    const fixture = path.join(agent, "fixture");
    try {
      for (const part of ["core", "extensions", "kit"]) {
        fs.cpSync(path.join(ROOT, "packages", part), path.join(fixture, "packages", part), { recursive: true });
      }
      fs.copyFileSync(path.join(ROOT, "package.json"), path.join(fixture, "package.json"));
      const installer = path.join(fixture, "packages", "core", "install.ts");
      const config = (enabled: unknown): void => writeJson(path.join(fixture, "packages", "core", "distribution.json"), { delivery: "git", requiredProfileExtensions: readRequiredProfileExtensions(), npm: { package: "@satunix/pi-system", enabled } });
      for (const notTrue of [false, "true", 1]) {
        config(notTrue);
        const refused = dryRun(installer, ["--channel", "next", "--mode", "npm", "--profile", "lite"], { agent });
        assert.notEqual(refused.status, 0, `enabled: ${JSON.stringify(notTrue)} is not true`);
        assert.match(refused.out, /npm delivery is not enabled/);
      }
      config(true);
      const npm = dryRun(installer, ["--channel", "next", "--profile", "lite"], { agent, env: { PI_KIT_DELIVERY: "npm" } });
      assert.equal(npm.status, 0, npm.out);
      assert.equal(npm.mode, "npm (channel next)", npm.out);
      assert.equal(npm.source, "npm:@satunix/pi-system@next");
    } finally { fs.rmSync(agent, { recursive: true, force: true }); }
  },

  "installer from a checkout: local by default, the configured delivery with --channel": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const installer = path.join(ROOT, "packages", "core", "install.ts");
    try {
      const local = dryRun(installer, ["--profile", "lite"], { agent });
      assert.equal(local.status, 0, local.out);
      assert.equal(local.mode, "local");
      assert.equal(local.source, ROOT);
      const next = dryRun(installer, ["--channel", "next", "--profile", "lite"], { agent });
      assert.equal(next.mode, "git (channel next)", next.out);
      assert.equal(next.source, GIT);
      const pinned = dryRun(installer, ["--channel", "0.2.1-beta.0"], { agent });
      assert.equal(pinned.source, `${GIT}@v0.2.1-beta.0`);
      // npm delivery is refused until distribution.json enables it, however it is asked for.
      const npmEnv = dryRun(installer, ["--channel", "next"], { agent, env: { PI_KIT_DELIVERY: "npm" } });
      assert.notEqual(npmEnv.status, 0, npmEnv.out);
      assert.match(npmEnv.out, /npm delivery is not enabled/);
      const npmFlag = dryRun(installer, ["--mode", "npm", "--profile", "lite"], { agent });
      assert.notEqual(npmFlag.status, 0, npmFlag.out);
      assert.match(npmFlag.out, /npm delivery is not enabled/);
      const bad = dryRun(installer, ["--channel", "main"], { agent });
      assert.notEqual(bad.status, 0);
      assert.match(bad.out, /invalid --channel/);
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },

  "installer migrates a retired private registration to the public source and keeps hand edits": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const installer = path.join(ROOT, "packages", "core", "install.ts");
    try {
      // A user of the old private delivery: registered from GitLab, following main, with one
      // extension removed and one added by hand.
      writeJson(path.join(agent, "settings.json"), { packages: [{ source: LEGACY, extensions: ["packages/extensions/src/secret-guard/index.ts", "packages/extensions/third_party/todo/index.ts", "packages/extensions/src/save/index.ts"] }] });
      writeJson(path.join(agent, ".pi-kit.json"), { kitSource: LEGACY, channel: "next", profile: "lite", extensions: ["secret-guard", "todo"], scope: "global" });
      const run = dryRun(installer, ["--profile", "lite", "--yes", "--mode", "git"], { agent, env: { PI_SYSTEM_GIT_SOURCE: "git:git@legacy.example.invalid:lab/pi-system" } });
      // --channel is not given, so `next` (the recorded channel) is kept: no network is needed.
      assert.equal(run.status, 0, run.out);
      assert.match(run.out, /Ignoring PI_SYSTEM_GIT_SOURCE=git:git@legacy.example.invalid:lab\/pi-system/);
      assert.match(run.out, /Migrating the kit from the retired private source git:legacy.example.invalid\/lab\/pi-system/);
      assert.equal(run.mode, "git (channel next)", run.out);
      assert.equal(run.source, GIT, "registers the public source, never the private one");
      assert.match(run.out, /would write overrides/, "hand edits are captured before the old entry goes");
      assert.ok(!/pi install "git:gitlab/.test(run.out), "the private source is never installed");
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },

  "under --settings-only the retired copy is removed only after the run commits (and --no-migrate refuses the move), so a rollback never points at a deleted clone": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const bin = scratch("pi-kit-dist-bin-");
    const log = path.join(bin, "calls.log");
    const installer = path.join(ROOT, "packages", "core", "install.ts");
    // pi stub: logs each call; fails a companion install when FAIL_COMPANION is set; like pi, a
    // `remove` exits 1 ("No matching package found") when settings.json no longer lists the source.
    const settingsFile = path.join(agent, "settings.json");
    fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in *pi-lens*) [ -n "$FAIL_COMPANION" ] && exit 1;; remove*) grep -qF "\\"$2\\"" "${settingsFile}" || exit 1;; esac\nexit 0\n`, { mode: 0o755 });
    const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [installer, "--profile", "balanced", "--yes", "--mode", "git", "--settings-only", ...args], {
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_KIT_DELIVERY: "", PI_SYSTEM_GIT_SOURCE: "", PI_LEAN_CTX_BIN: path.join(bin, "none"), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, ...env },
    });
    const calls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
    try {
      // Migration route 1: the public kit is installed next to the retired registration, then its installer runs.
      const settings = JSON.stringify({ packages: [LEGACY, GIT] });
      fs.writeFileSync(path.join(agent, "settings.json"), settings);
      writeJson(path.join(agent, ".pi-kit.json"), { kitSource: LEGACY, channel: "next", profile: "balanced", scope: "global" });
      const failed = run([], { FAIL_COMPANION: "1" });
      assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
      assert.ok(!calls().some((c) => c.startsWith("remove")), `the retired copy is not removed by a run that rolls back: ${calls().join(" | ")}`);
      assert.equal(fs.readFileSync(path.join(agent, "settings.json"), "utf8"), settings, "settings.json is restored, and the copy it names still exists");
      assert.match(failed.stderr, /NOT the package operations pi already ran: pi install npm:pi-lens@\S+ \(failed part-way\)\./);
      // /profile passes --no-migrate: its rollback restores files only, so the move is refused before any change.
      fs.rmSync(log, { force: true });
      const refused = run(["--no-externals", "--no-migrate"]);
      assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
      assert.match(refused.stderr, /--no-migrate: not moving the kit off .*Nothing was changed\. Move it with \/update kit/);
      assert.deepEqual(calls(), [], "no pi command runs");
      assert.equal(fs.readFileSync(settingsFile, "utf8"), settings);
      fs.rmSync(log, { force: true });
      const ok = run(["--no-externals"]);
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.equal(calls().at(-1), `remove ${LEGACY}`, `the retired copy is removed last, after the commit: ${calls().join(" | ")}`);
      assert.match(ok.stdout, /Removed the retired registration/);
      assert.doesNotMatch(ok.stderr, /Could not run/);
      assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, "utf8"))).includes(`"${LEGACY}"`), "the retired entry is gone");
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  },

  "a fork registration that is not the retired source is left alone": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const installer = path.join(ROOT, "packages", "core", "install.ts");
    try {
      const fork = "git:github.com/example/pi-system@v0.2.4-beta.0";
      writeJson(path.join(agent, "settings.json"), { packages: [fork] });
      writeJson(path.join(agent, ".pi-kit.json"), { kitSource: fork, channel: "latest", profile: "lite" });
      const run = dryRun(installer, ["--profile", "lite", "--yes", "--mode", "git"], { agent });
      assert.equal(run.status, 0, run.out);
      assert.equal(run.source, fork);
      assert.ok(!/Migrating the kit/.test(run.out));
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },

  "installing the latest release with no tags yet fails with an actionable message": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const installer = path.join(ROOT, "packages", "core", "install.ts");
    try {
      // A local bare repository stands in for the public remote (git rewrites the URL, so no
      // network is touched): it has a main branch and no release tags.
      const remote = path.join(agent, "remote.git");
      execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
      const rewrite = (to: string) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${to}.insteadOf`, GIT_CONFIG_VALUE_0: "https://git.example.test/o/pi-system" });
      const source = "git:git.example.test/o/pi-system";
      const run = dryRun(installer, ["--channel", "latest", "--profile", "lite"], { agent, env: { PI_SYSTEM_GIT_SOURCE: source, ...rewrite(`file://${remote.replace(/\\/g, "/")}`) } });
      assert.notEqual(run.status, 0);
      assert.match(run.out, /has no release tags \(vX\.Y\.Z\) yet\. Install --channel next/, run.out);
      const missing = `file://${path.join(agent, "missing.git").replace(/\\/g, "/")}`;
      const unreachable = dryRun(installer, ["--channel", "latest", "--profile", "lite"], { agent, env: { PI_SYSTEM_GIT_SOURCE: source, ...rewrite(missing) } });
      assert.notEqual(unreachable.status, 0);
      assert.match(unreachable.out, /could not list release tags/);
      assert.match(unreachable.out, /Check network access to the repository/);
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },

  "installer from pi's git clone keeps the registered git source and channel": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const clone = path.join(agent, "git", "github.com", "SATUNIX", "pi-system");
    try {
      // A copy of the tracked kit where pi clones git packages (a .git dir, like a real clone).
      fs.mkdirSync(clone, { recursive: true });
      const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "packages/core", "packages/kit/profiles", "packages/extensions", "package.json"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
      for (const f of files) {
        if (!fs.existsSync(path.join(ROOT, f))) continue;
        fs.mkdirSync(path.dirname(path.join(clone, f)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, f), path.join(clone, f));
      }
      fs.mkdirSync(path.join(clone, ".git"));
      const tagged = `${GIT}@v0.2.1-beta.0`;
      writeJson(path.join(agent, "settings.json"), { packages: [tagged] });
      const installer = path.join(clone, "packages", "core", "install.ts");
      const run = dryRun(installer, ["--profile", "lite", "--yes", "--settings-only"], { agent });
      assert.equal(run.status, 0, run.out);
      assert.equal(run.mode, "git (channel latest)", "a clone pi installed is never registered as a local checkout");
      assert.equal(run.source, tagged);
      writeJson(path.join(agent, ".pi-kit.json"), { kitSource: tagged, channel: "0.2.1-beta.0", profile: "lite" });
      assert.equal(dryRun(installer, ["--profile", "lite", "--settings-only"], { agent }).mode, "git (channel 0.2.1-beta.0)", "the recorded channel wins");
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${String((error as { stack?: string } | null | undefined)?.stack || error)}`);
  }
}
restoreKitEnv();
if (failed) {
  console.error(`\n[distribution-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[distribution-smoke] all ${Object.keys(tests).length} checks passed`);
