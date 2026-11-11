#!/usr/bin/env node
/**
 * Offline checks for the kit-update trunk-ahead notice (board item PG-12).
 *
 * Everything runs against a scratch agent dir (PI_CODING_AGENT_DIR) and a scratch kit clone,
 * with a fake registry (injected fetch) and either an injected fake git or a `git` shim on
 * PATH, so nothing touches the network or the real pi settings. Covers: the pure notice
 * wording, the commit gap computed for a git install (present, in sync, unreachable), and that
 * the session-start check surfaces the notice without ever blocking start-up.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import type * as KitUpdate from "../packages/extensions/src/kit-update/index.ts";

interface GitWorldOptions {
  kitSource?: string;
  kitVersion?: string;
  delivery?: string;
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
  count?: number;
}

interface Note {
  m: string;
  l: string | undefined;
}

// npm dist-tags per package name, as the fake registry serves them.
type DistTags = Record<string, Record<string, string>>;

const GIT_SOURCE = "git:github.com/SATUNIX/luna";
const SHA_OLD = "1".repeat(40);
const SHA_MAIN = "2".repeat(40);
const PI_TAGS: DistTags = { "@earendil-works/pi-coding-agent": { latest: "1.4.0" } };

// The extension module as this test drives it: registered against the harness's fakePi() api.
type KitUpdateModule = Omit<typeof KitUpdate, "default"> & {
  default: (pi: ReturnType<typeof fakePi>["api"]) => void;
};

const restoreKitEnv = isolateKitEnv();
const mod: KitUpdateModule = await loadModule("extensions/kit-update/index.ts");
const { default: kitUpdate, trunkNotice, checkForUpdates } = mod;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// A kit as pi clones a git package: <agent>/git/<host>/<path>, with its distribution.json.
function makeGitWorld({ kitSource = `${GIT_SOURCE}@v0.2.1-beta.0`, kitVersion = "0.2.1-beta.0", delivery = "git" }: GitWorldOptions = {}): World {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-update-notice-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-update-notice-cwd-"));
  const kitRoot = path.join(agent, "git", "github.com", "SATUNIX", "luna");
  writeJson(path.join(kitRoot, "package.json"), { name: "@satunix/pi-system", version: kitVersion });
  fs.mkdirSync(path.join(kitRoot, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(kitRoot, "packages", "core", "install.ts"), "// stub\n");
  writeJson(path.join(kitRoot, "packages", "core", "sources.json"), { external: [] });
  writeJson(path.join(kitRoot, "packages", "core", "distribution.json"), { delivery, git: { source: GIT_SOURCE, branch: "main", tagPrefix: "v" } });
  writeJson(path.join(agent, "settings.json"), { packages: [{ source: kitSource, extensions: ["packages/extensions/third_party/todo/index.ts"] }] });
  writeJson(path.join(agent, ".pi-kit.json"), { profile: "balanced", scope: "global" });
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

// Fake git: `ls-remote` answers tags and main, `rev-parse HEAD` with head, `rev-list --count` with count.
function fakeGit({ tags = [], main = SHA_MAIN, head = SHA_OLD, reachable = true, count = 0 }: FakeGitOptions = {}): { git: KitUpdate.GitLike; calls: string[] } {
  const calls: string[] = [];
  const git: KitUpdate.GitLike = async (args) => {
    calls.push(args.join(" "));
    if (args.includes("ls-remote")) {
      if (!reachable) return null;
      return [...tags.map((t, i) => `${String(i + 3).repeat(40)}\trefs/tags/v${t}`), `${main}\trefs/heads/main`].join("\n") + "\n";
    }
    if (args.includes("rev-list")) return `${count}\n`;
    if (args.includes("rev-parse")) return `${head}\n`;
    return null;
  };
  return { git, calls };
}

function fakeRegistry(tags: DistTags): KitUpdate.FetchLike {
  return async () => ({ ok: true, json: async () => tags["@earendil-works/pi-coding-agent"] ?? {} });
}

// A `git` shim on PATH, so the extension's own runGit (not an injected GitLike) is exercised.
// In "hang" mode every invocation blocks, modelling a promise that never resolves.
function makeGitShim(): { dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-update-notice-bin-"));
  const script = `#!/bin/sh
if [ "$FAKE_GIT_MODE" = "hang" ]; then
  printf '%s\\n' "$$" >> "$FAKE_GIT_PIDS"
  sleep 60
  exit 0
fi
args="$*"
case "$args" in
  *ls-remote*)
    printf '%s\\trefs/tags/v0.2.1-beta.0\\n%s\\trefs/heads/main\\n' "${"a".repeat(40)}" "${"b".repeat(40)}"
    ;;
  *rev-list*) printf '3\\n' ;;
  *rev-parse*) printf '%s\\n' "${"c".repeat(40)}" ;;
  *) exit 0 ;;
esac
`;
  const file = path.join(dir, "git");
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return { dir, cleanup: () => rmWorkspace(dir) };
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the background check");
}

const tests: Record<string, () => void | Promise<void>> = {
  "the trunk-ahead notice is one exact line, or null when there is no gap": () => {
    assert.equal(trunkNotice({ channel: "trunk", ahead: 19 }), "trunk is 19 commits ahead — /update channel trunk");
    assert.equal(trunkNotice({ channel: "next", ahead: 1 }), "trunk is 1 commit ahead — /update channel next");
    assert.equal(trunkNotice({ channel: "latest", ahead: 0 }), null);
    assert.equal(trunkNotice({ channel: "", ahead: 5 }), null);
    assert.equal(trunkNotice({ channel: "next", ahead: -1 }), null);
  },

  "a latest-channel git install reports the commit gap and a notice": async () => {
    const w = makeGitWorld();
    try {
      const { git } = fakeGit({ tags: ["0.2.1-beta.0"], count: 7 });
      const report = await checkForUpdates(w.cwd, fakeRegistry(PI_TAGS), "1.4.0", git);
      assert.equal(report.kit.kind, "git");
      assert.equal(report.kit.channel, "latest");
      assert.equal(report.kit.trunkAhead, 7);
      assert.equal(report.kit.available, false, "the release channel is current; only the trunk has moved");
      const notice = trunkNotice({ channel: report.kit.channel ?? "next", ahead: report.kit.trunkAhead ?? 0 });
      assert.equal(notice, "trunk is 7 commits ahead — /update channel latest");
    } finally {
      w.cleanup();
    }
  },

  "an in-sync git install has no gap and a null notice": async () => {
    const w = makeGitWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(PI_TAGS), "1.4.0", fakeGit({ tags: ["0.2.1-beta.0"], count: 0 }).git);
      assert.equal(report.kit.trunkAhead, 0);
      assert.equal(trunkNotice({ channel: report.kit.channel ?? "next", ahead: report.kit.trunkAhead ?? 0 }), null);
    } finally {
      w.cleanup();
    }
  },

  "an unreachable remote leaves the gap absent and the check offline": async () => {
    const w = makeGitWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(PI_TAGS), "1.4.0", fakeGit({ reachable: false }).git);
      assert.equal(report.offline, true);
      assert.equal(report.kit.trunkAhead, undefined);
      assert.equal(trunkNotice({ channel: report.kit.channel ?? "next", ahead: report.kit.trunkAhead ?? 0 }), null);
    } finally {
      w.cleanup();
    }
  },

  "session start never waits for a check whose git call never resolves": async () => {
    const w = makeGitWorld();
    const shim = makeGitShim();
    const pidFile = path.join(shim.dir, "pids");
    const restorePath = setEnv("PATH", `${shim.dir}${path.delimiter}${process.env.PATH ?? ""}`);
    const restoreMode = setEnv("FAKE_GIT_MODE", "hang");
    const restorePids = setEnv("FAKE_GIT_PIDS", pidFile);
    const restoreOffline = setEnv("PI_OFFLINE", undefined);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeRegistry(PI_TAGS) as typeof fetch;
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      const notes: Note[] = [];
      const ctx = { hasUI: true, cwd: w.cwd, ui: { notify: (m: string, l?: string) => notes.push({ m, l }), setStatus() {} } };
      const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("session_start blocked on the update check")), 1000));
      await Promise.race([Promise.resolve(pi.handlers.get("session_start")({}, ctx)), timeout]);
      assert.deepEqual(notes, [], "nothing can be notified before the check resolves");
      // Release the blocked git processes so the test process can exit. Both ls-remote and
      // rev-parse block; wait until both have recorded their pid, then kill them.
      const readPids = (): number[] =>
        (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean) : []).map((pid) => Number.parseInt(pid, 10));
      try {
        await waitFor(() => readPids().length >= 2, 1000);
      } catch {
        /* best effort: kill whatever was recorded */
      }
      for (const pid of readPids()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } finally {
      globalThis.fetch = realFetch;
      restoreOffline();
      restorePids();
      restoreMode();
      restorePath();
      shim.cleanup();
      w.cleanup();
    }
  },

  "session start notifies exactly the trunk notice for a gap report": async () => {
    const w = makeGitWorld();
    const shim = makeGitShim();
    const restorePath = setEnv("PATH", `${shim.dir}${path.delimiter}${process.env.PATH ?? ""}`);
    const restoreMode = setEnv("FAKE_GIT_MODE", "normal");
    const restorePids = setEnv("FAKE_GIT_PIDS", path.join(shim.dir, "pids"));
    const restoreOffline = setEnv("PI_OFFLINE", undefined);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeRegistry(PI_TAGS) as typeof fetch;
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      const notes: Note[] = [];
      const ctx = { hasUI: true, cwd: w.cwd, ui: { notify: (m: string, l?: string) => notes.push({ m, l }), setStatus() {} } };
      await pi.handlers.get("session_start")({}, ctx);
      await waitFor(() => notes.length > 0);
      assert.deepEqual(notes, [{ m: "trunk is 3 commits ahead — /update channel latest", l: "info" }]);
    } finally {
      globalThis.fetch = realFetch;
      restoreOffline();
      restorePids();
      restoreMode();
      restorePath();
      shim.cleanup();
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
  console.error(`\n[update-notice-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[update-notice-smoke] all ${Object.keys(tests).length} checks passed`);
