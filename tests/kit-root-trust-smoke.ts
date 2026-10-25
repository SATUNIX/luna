#!/usr/bin/env node
/**
 * An opened repository never chooses the installer /profile and the first-run auto-profile run.
 *
 * Both run `node <kit root>/packages/core/install.ts`, and the kit root used to come from the
 * install marker's `kitSource`, so a repository that committed `.pi/.pi-kit.json` with a relative
 * `kitSource` (plus an unfiltered kit entry in `.pi/settings.json`) had its own install.ts run when
 * a session started. findKitRoot now takes a marker's `kitSource` only when it is absolute,
 * resolves outside the workspace through any links, and is a kit by package name; otherwise it
 * warns once and uses the kit this extension was loaded from.
 *
 * web-console's /console and remote-control's host start make the same choice for the web UI they
 * spawn (`<kit>/packages/web-ui/server/server.ts`, `.../remote-host.ts`) when the copy beside the
 * extension is missing, and use the same check (packages/core/shared/kit-source.ts). Their cases
 * load a copy of each module from a scratch directory with no web UI beside it, so the marker
 * fallback is what decides; the copy from this checkout must still resolve its own web UI.
 *
 * The fixture repository carries a complete in-repo kit whose installer and web UI entry points
 * would only write "x" to a marker file; nothing here runs them, and the test checks that they
 * were never even selected.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv, type FakePiApi } from "../packages/core/eval/harness.ts";
import type * as RemoteHostModule from "../packages/extensions/src/remote-control/host.ts";
import type * as SessionHelpersModule from "../packages/extensions/src/session-helpers/index.ts";
import type * as WebConsoleModule from "../packages/extensions/src/web-console/index.ts";

type SessionHelpersView = Omit<typeof SessionHelpersModule, "default"> & { default: (api: FakePiApi) => void };

const restoreKitEnv = isolateKitEnv();
const mod = await loadModule<SessionHelpersView>("extensions/session-helpers/index.ts");
const { default: sessionHelpers, findKitRoot, resolveKitLayout } = mod;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_INSTALLER = resolveKitLayout(REPO_ROOT)?.installer;
assert.ok(REAL_INSTALLER, "this checkout is a kit");

interface Note {
  message: string;
  level?: string | undefined;
}

interface ExecCall {
  command: string;
  args: string[];
  cwd: string | undefined;
}

/** A kit at `root` whose installer and web UI servers would write "x" to <root>/ran.txt if ever run. */
function writeKit(root: string, name = "@satunix/pi-system"): void {
  fs.mkdirSync(path.join(root, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "core", "install.ts"), 'import fs from "node:fs";\nfs.writeFileSync(new URL("../../ran.txt", import.meta.url), "x");\n');
  fs.mkdirSync(path.join(root, "packages", "web-ui", "server"), { recursive: true });
  for (const entry of ["server.ts", "remote-host.ts"]) {
    fs.writeFileSync(path.join(root, "packages", "web-ui", "server", entry), 'import fs from "node:fs";\nfs.writeFileSync(new URL("../../../ran.txt", import.meta.url), "x");\n');
  }
  fs.mkdirSync(path.join(root, "packages", "kit", "profiles"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "kit", "profiles", "balanced.json"), JSON.stringify({ name: "balanced", description: "fixture" }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
}

/** A cloned-looking repository with a committed marker and an unfiltered kit entry. */
function makeRepo(kitSource: (repo: string, cwd: string) => string, sub = ""): { base: string; repo: string; cwd: string; repoKit: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-root-trust-")));
  const repo = path.join(base, "repo");
  const repoKit = path.join(repo, "vendor", "kit");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeKit(repoKit);
  const cwd = path.join(repo, sub);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", ".pi-kit.json"), JSON.stringify({ kitSource: kitSource(repo, cwd), profile: "balanced", scope: "project" }));
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@satunix/pi-system"] }));
  return { base, repo, cwd, repoKit };
}

function fakeCtx(cwd: string, hasUI: boolean) {
  const notes: Note[] = [];
  return {
    notes,
    ctx: {
      hasUI,
      cwd,
      ui: {
        notify: (message: string, level?: string) => notes.push({ message, level }),
        select: async () => undefined,
        confirm: async () => false,
        setStatus: () => {},
      },
      reload: async () => {},
    },
  };
}

/** Session start (auto-profile) and `/profile balanced` against the repo; returns every exec. */
async function driveSession(cwd: string): Promise<{ calls: ExecCall[]; notes: Note[] }> {
  const pi = fakePi();
  sessionHelpers(pi.api);
  const calls: ExecCall[] = [];
  // Fail every exec: the switch rolls back and nothing is installed.
  pi.api.exec = async (command: string, args: string[], options?: { cwd?: string }) => {
    calls.push({ command, args, cwd: options?.cwd });
    return { stdout: "", stderr: "refused by the test", code: 1 };
  };
  // pi runs in the repository it opened, so the process directory is the repository too.
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const start = fakeCtx(cwd, true);
    await pi.handlers.get("session_start")({}, start.ctx);
    const command = fakeCtx(cwd, false);
    await pi.commands.get("profile").handler("self-improving", command.ctx);
    return { calls, notes: [...start.notes, ...command.notes] };
  } finally {
    process.chdir(previous);
  }
}

/** No exec names a file in the repository, and the repo installer's marker was never written. */
function assertRepoNeverSelected(repo: string, calls: ExecCall[], label: string): void {
  for (const call of calls) {
    // Through links too: a path outside the repository that resolves into it counts as inside.
    const real = (p: string): string => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
    for (const arg of [call.command, ...call.args]) {
      assert.ok(!real(arg).startsWith(`${repo}${path.sep}`), `${label}: exec argument ${arg} is inside the repository`);
    }
    // A project-scoped switch runs in the project, but never from the in-repo kit.
    const kit = path.join(repo, "vendor", "kit");
    assert.ok(call.cwd === undefined || !`${real(call.cwd)}${path.sep}`.startsWith(`${kit}${path.sep}`), `${label}: exec runs in the repository's kit`);
  }
  assert.equal(fs.existsSync(path.join(repo, "vendor", "kit", "ran.txt")), false, `${label}: the repository's installer must never run`);
}

type FindWebUiRoot = (cwd?: string, warn?: (message: string) => void) => string | null;

/**
 * A copy of an extension module (and its ./shared helpers) in a scratch directory laid out like a
 * kit with no packages/web-ui, so its findWebUiRoot falls through to the install marker. The
 * modules import only node builtins (and pi types, which type stripping drops).
 */
async function detachedModule(extension: string, file: string, scratch: string): Promise<unknown> {
  const from = path.join(REPO_ROOT, "packages", "extensions", "src", extension);
  const to = path.join(scratch, "packages", "extensions", "src", extension);
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(from, file), path.join(to, file));
  fs.cpSync(path.join(from, "shared"), path.join(to, "shared"), { recursive: true });
  return import(pathToFileURL(path.join(to, file)).href);
}

const WEB_UI_FINDERS: ReadonlyArray<{ label: string; load: (scratch: string) => Promise<FindWebUiRoot>; installed: () => Promise<FindWebUiRoot> }> = [
  {
    label: "web-console",
    // The module's shape is stated here, as packages/core/eval/harness.ts loadModule does.
    load: async (scratch) => ((await detachedModule("web-console", "index.ts", scratch)) as typeof WebConsoleModule).findWebUiRoot,
    installed: async () => (await loadModule<typeof WebConsoleModule>("extensions/web-console/index.ts")).findWebUiRoot,
  },
  {
    label: "remote-control",
    load: async (scratch) => ((await detachedModule("remote-control", "host.ts", scratch)) as typeof RemoteHostModule).findWebUiRoot,
    installed: async () => (await loadModule<typeof RemoteHostModule>("extensions/remote-control/host.ts")).findWebUiRoot,
  },
];

/** Every web UI finder, detached from this checkout, against a repository whose marker is hostile. */
async function assertWebUiRefused(kitSource: (repo: string, cwd: string) => string, reason: RegExp, setup?: (f: ReturnType<typeof makeRepo>) => void): Promise<void> {
  for (const sub of ["", "packages/app"]) {
    const f = makeRepo(kitSource, sub);
    setup?.(f);
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-root-trust-agent-"));
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-root-trust-ext-")));
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      for (const finder of WEB_UI_FINDERS) {
        const find = await finder.load(path.join(scratch, finder.label));
        const warnings: string[] = [];
        assert.equal(find(f.cwd, (m) => warnings.push(m)), null, `${finder.label} (cwd ${sub || "."}): the repository's web UI is never chosen`);
        assert.match(warnings.join("\n"), reason, `${finder.label} (cwd ${sub || "."}): the refusal is reported`);
        const installed = await finder.installed();
        assert.equal(installed(f.cwd, (m) => warnings.push(m)), path.join(REPO_ROOT, "packages", "web-ui"), `${finder.label}: the installed kit's web UI still resolves`);
      }
      assert.equal(fs.existsSync(path.join(f.repoKit, "ran.txt")), false, "nothing in the repository ran");
    } finally {
      restoreAgent();
      rmWorkspace(f.base);
      rmWorkspace(agent);
      rmWorkspace(scratch);
    }
  }
}

const tests: Record<string, () => Promise<void>> = {
  "a relative kitSource in a committed project marker is ignored with a warning": async () => {
    const f = makeRepo(() => "vendor/kit");
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-root-trust-agent-"));
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const warnings: string[] = [];
      assert.equal(findKitRoot(f.cwd, (m) => warnings.push(m)), REPO_ROOT, "the installed kit is used");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /is relative/);
      findKitRoot(f.cwd, (m) => warnings.push(m));
      assert.equal(warnings.length, 1, "the same warning is shown once");
      const { calls, notes } = await driveSession(f.cwd);
      assertRepoNeverSelected(f.repo, calls, "relative");
      assert.ok(calls.some((c) => c.args[0] === REAL_INSTALLER), "the installed kit's installer is the one the session drives");
      assert.ok(notes.length > 0, "the session reported what happened");
    } finally {
      restoreAgent();
      rmWorkspace(f.base);
      rmWorkspace(agent);
    }
  },

  "an absolute kitSource inside the workspace is ignored, also from a subdirectory of the work tree": async () => {
    for (const sub of ["", "packages/app"]) {
      const f = makeRepo((repo) => path.join(repo, "vendor", "kit"), sub);
      const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-root-trust-agent-"));
      const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
      try {
        const warnings: string[] = [];
        assert.equal(findKitRoot(f.cwd, (m) => warnings.push(m)), REPO_ROOT, `cwd ${sub || "."}`);
        assert.match(warnings.join("\n"), /inside the workspace/);
        const { calls } = await driveSession(f.cwd);
        assertRepoNeverSelected(f.repo, calls, `absolute (${sub || "."})`);
      } finally {
        restoreAgent();
        rmWorkspace(f.base);
        rmWorkspace(agent);
      }
    }
  },

  "a kitSource outside the workspace that links into it is ignored": async () => {
    const f = makeRepo((repo) => path.join(path.dirname(repo), "outside-link"));
    fs.symlinkSync(f.repoKit, path.join(f.base, "outside-link"), "dir");
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-root-trust-agent-"));
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const warnings: string[] = [];
      assert.equal(findKitRoot(f.cwd, (m) => warnings.push(m)), REPO_ROOT);
      assert.match(warnings.join("\n"), /inside the workspace/);
      const { calls } = await driveSession(f.cwd);
      assertRepoNeverSelected(f.repo, calls, "symlink");
    } finally {
      restoreAgent();
      rmWorkspace(f.base);
      rmWorkspace(agent);
    }
  },

  "a kitSource outside the workspace that is not a kit by package name is ignored": async () => {
    const f = makeRepo((repo) => path.join(path.dirname(repo), "other"));
    writeKit(path.join(f.base, "other"), "some-other-package");
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-root-trust-agent-"));
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const warnings: string[] = [];
      assert.equal(findKitRoot(f.cwd, (m) => warnings.push(m)), REPO_ROOT);
      assert.match(warnings.join("\n"), /not a pi-system kit/);
    } finally {
      restoreAgent();
      rmWorkspace(f.base);
      rmWorkspace(agent);
    }
  },

  "positive control: the installed kit resolves, and an absolute kit checkout outside the workspace is still used": async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-root-trust-ok-")));
    const agent = path.join(base, "agent");
    const project = path.join(base, "project");
    const checkout = path.join(base, "checkout");
    fs.mkdirSync(agent);
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const warnings: string[] = [];
      assert.equal(findKitRoot(project, (m) => warnings.push(m)), REPO_ROOT, "no marker: the kit this extension was loaded from");
      assert.equal(resolveKitLayout(REPO_ROOT)?.installer, path.join(REPO_ROOT, "packages", "core", "install.ts"));
      writeKit(checkout);
      fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ kitSource: checkout, profile: "balanced" }));
      assert.equal(findKitRoot(project, (m) => warnings.push(m)), checkout, "an absolute kit checkout outside the workspace is honoured");
      fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ kitSource: "npm:@satunix/pi-system", profile: "balanced" }));
      assert.equal(findKitRoot(project, (m) => warnings.push(m)), REPO_ROOT, "an npm source falls through silently");
      assert.deepEqual(warnings, []);
      assert.equal(fs.existsSync(path.join(checkout, "ran.txt")), false);
    } finally {
      restoreAgent();
      rmWorkspace(base);
    }
  },

  "web UI fallbacks: a relative kitSource in a committed project marker is ignored": async () => {
    await assertWebUiRefused((repo, cwd) => path.relative(cwd, path.join(repo, "vendor", "kit")), /is relative/);
  },

  "web UI fallbacks: an absolute kitSource inside the workspace is ignored": async () => {
    await assertWebUiRefused((repo) => path.join(repo, "vendor", "kit"), /inside the workspace/);
  },

  "web UI fallbacks: a kitSource outside the workspace that links into it is ignored": async () => {
    await assertWebUiRefused(
      (repo) => path.join(path.dirname(repo), "outside-link"),
      /inside the workspace/,
      (f) => fs.symlinkSync(f.repoKit, path.join(f.base, "outside-link"), "dir"),
    );
  },

  "web UI fallbacks: a kitSource outside the workspace that is not a kit by package name is ignored": async () => {
    await assertWebUiRefused(
      (repo) => path.join(path.dirname(repo), "other"),
      /not a pi-system kit/,
      (f) => writeKit(path.join(f.base, "other"), "some-other-package"),
    );
  },

  "web UI fallbacks, positive control: an absolute kit checkout outside the workspace is used": async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-root-trust-ok-")));
    const agent = path.join(base, "agent");
    const project = path.join(base, "project");
    const checkout = path.join(base, "checkout");
    fs.mkdirSync(agent);
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    writeKit(checkout);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      for (const finder of WEB_UI_FINDERS) {
        const find = await finder.load(path.join(base, "ext", finder.label));
        const warnings: string[] = [];
        fs.rmSync(path.join(agent, ".pi-kit.json"), { force: true });
        assert.equal(find(project, (m) => warnings.push(m)), null, `${finder.label}: no marker and no web UI beside the module`);
        fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ kitSource: checkout, profile: "balanced" }));
        assert.equal(find(project, (m) => warnings.push(m)), path.join(checkout, "packages", "web-ui"), `${finder.label}: an absolute kit checkout outside the workspace is honoured`);
        fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ kitSource: "npm:@satunix/pi-system", profile: "balanced" }));
        assert.equal(find(project, (m) => warnings.push(m)), null, `${finder.label}: an npm source falls through silently`);
        assert.deepEqual(warnings, [], `${finder.label}: nothing was refused`);
      }
      assert.equal(fs.existsSync(path.join(checkout, "ran.txt")), false);
    } finally {
      restoreAgent();
      rmWorkspace(base);
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err instanceof Error ? err.stack : String(err)}`);
  }
}
restoreKitEnv();
const total = Object.keys(tests).length;
if (failed) {
  console.error(`kit-root-trust-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`kit-root-trust-smoke: ${total}/${total} passed`);
