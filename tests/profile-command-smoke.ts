#!/usr/bin/env node
/**
 * Offline checks for session-helpers' `/profile` command.
 *
 * `/profile` is the TUI front-end to the same profile switch the CLI installer
 * performs: it locates the kit checkout, picks a profile, spawns
 * `node <installer> --profile <name> --yes --settings-only` (no verify gate, no
 * re-registration), and reloads. These tests drive the
 * real command handler with a fake pi API and a fake `pi.exec`, so nothing is
 * installed and no real settings are written.
 *
 * Guards the failure modes that matter: an unknown profile must not run the
 * installer, switching to the current profile must be a no-op, an installer
 * non-zero exit must surface the error AND must not reload, and the argv handed
 * to the installer must be exactly the documented one. Both supported kit
 * layouts are covered: the monorepo (packages/core/install.ts +
 * packages/kit/profiles) and a legacy flat kit (kit/install.mjs + profiles/).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv, type FakePiApi } from "../packages/core/eval/harness.ts";
import { array, isRecord, object, optional, parseJson, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import type * as SessionHelpersModule from "../packages/extensions/src/session-helpers/index.ts";

/** session-helpers as these tests load it: its default export is registered on the fake pi API. */
type SessionHelpersView = Omit<typeof SessionHelpersModule, "default"> & { default: (api: FakePiApi) => void };

const restoreKitEnv = isolateKitEnv();
const mod = await loadModule<SessionHelpersView>("extensions/session-helpers/index.ts");
// The npm test below pins the deprecated unfilteredNpmKitEntry alias, which stays exported for older callers.
// eslint-disable-next-line @typescript-eslint/no-deprecated -- the alias is under test on purpose
const { default: sessionHelpers, findKitRoot, listProfiles, resolveKitLayout, loadedKitExtensions, unfilteredNpmKitEntry, unfilteredKitEntry } = mod;

/** A notification raised through ctx.ui.notify. */
interface Note {
  message: string;
  level?: string | undefined;
}

/** A status line set through ctx.ui.setStatus. */
interface Status {
  key: string;
  value: unknown;
}

/** The options /profile passes to pi.exec. */
interface ExecOptions {
  cwd?: string;
}

/** One recorded pi.exec invocation. */
interface ExecCall {
  command: string;
  args: string[];
  options: ExecOptions;
}

type SelectFn = (title: string, options: string[]) => Promise<string | undefined>;
type ConfirmFn = (title: string) => Promise<boolean>;

/** The extension context the command handlers see, plus what the fake records. */
interface FakeCtx {
  hasUI: boolean;
  cwd?: string;
  notes: Note[];
  statuses: Status[];
  reloaded: number;
  ui: {
    notify: (message: string, level?: string) => number;
    select: SelectFn;
    confirm: ConfirmFn;
    setStatus: (key: string, value: unknown) => number;
  };
  reload?: () => Promise<void>;
}

/** fakePi plus the knobs the fake pi.exec reads. */
type CommandPi = ReturnType<typeof fakePi> & { execCode?: number; simulate?: boolean };

/** The settings.json fields the simulated installer reads and writes. */
interface KitSettings {
  packages?: unknown;
  [key: string]: unknown;
}

/** A profile definition, as far as the simulated installer reads it. */
const ProfileDef = object({
  include: optional(array(string())),
  firewall: optional(object({ mode: optional(string()), policy: optional(string()) })),
});

/** A settings.json package entry's source: the entry itself when bare, else its `source` field. */
function sourceOf(entry: unknown): unknown {
  return typeof entry === "string" ? entry : isRecord(entry) ? entry.source : undefined;
}

/** The one installer invocation a test expects; fails when there was none. */
function firstCall(calls: ExecCall[]): ExecCall {
  const [first] = calls;
  assert.ok(first, "expected an installer call");
  return first;
}

function writeProfiles(profilesDir: string): void {
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "autonomous.json"),
    JSON.stringify({ name: "autonomous", description: "set-and-walk-away" }),
  );
  fs.writeFileSync(
    path.join(profilesDir, "balanced.json"),
    JSON.stringify({ name: "balanced", description: "daily driver" }),
  );
  fs.writeFileSync(
    path.join(profilesDir, "self-improving.json"),
    JSON.stringify({ name: "self-improving", description: "full capability" }),
  );
}

// Legacy flat kit checkout: <root>/kit/install.mjs + <root>/profiles/.
function makeKitRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-root-"));
  fs.mkdirSync(path.join(root, "kit"), { recursive: true });
  fs.writeFileSync(path.join(root, "kit", "install.mjs"), "// stub\n");
  writeProfiles(path.join(root, "profiles"));
  return root;
}

// Monorepo checkout: <root>/packages/core/install.ts + <root>/packages/kit/profiles/.
function makeMonorepoRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-mono-"));
  fs.mkdirSync(path.join(root, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "core", "install.ts"), "// stub\n");
  writeProfiles(path.join(root, "packages", "kit", "profiles"));
  return root;
}

function makeAgentDir(currentProfile: string, extra: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-agent-"));
  fs.writeFileSync(
    path.join(dir, ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: currentProfile, ...extra }),
  );
  return dir;
}

// A stand-in for install.ts --settings-only. /profile no longer trusts an exit code (pi.exec
// reports a signal-killed child as code 0) - it verifies the files the installer left behind - so a
// fake installer that "succeeds" must leave a consistent marker, settings entry and firewall
// config, exactly as the real one does. Reads the requested profile from the kit under test.
function simulateInstall(args: string[], options: ExecOptions): string {
  const flag = (name: string, fallback?: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const profile = flag("--profile");
  const scope = flag("--scope", "global");
  const agent = process.env.PI_CODING_AGENT_DIR;
  const root = process.env.PI_KIT_ROOT;
  const project = options.cwd;
  assert.ok(agent !== undefined && root !== undefined, "the simulated install needs PI_CODING_AGENT_DIR and PI_KIT_ROOT");
  const target = scope === "project" ? project : agent;
  // Never let a simulated install write outside a throwaway directory (a test without ctx.cwd would hit the repo).
  assert.ok(target !== undefined && path.resolve(target).startsWith(os.tmpdir()), `simulated install would write outside the temp dir: ${target}`);
  const settingsPath = scope === "project" ? path.join(target, ".pi", "settings.json") : path.join(target, "settings.json");
  const markerPath = scope === "project" ? path.join(target, ".pi", ".pi-kit.json") : path.join(target, ".pi-kit.json");
  const profilesDir = fs.existsSync(path.join(root, "packages", "kit", "profiles")) ? path.join(root, "packages", "kit", "profiles") : path.join(root, "profiles");
  const def = parseJsonAs(ProfileDef, fs.readFileSync(path.join(profilesDir, `${profile}.json`), "utf8"), `${profile}.json`);
  const include = def.include ?? [];
  const patterns: string[] = [];
  for (const name of include) {
    for (const avenue of ["src", "third_party"]) {
      if (fs.existsSync(path.join(root, "packages", "extensions", avenue, name, "index.ts"))) patterns.push(`packages/extensions/${avenue}/${name}/index.ts`);
    }
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  let settings: KitSettings = {};
  try { const parsed = parseJson(fs.readFileSync(settingsPath, "utf8")); if (isRecord(parsed)) settings = parsed; } catch { /* new file */ }
  const packages: unknown[] = Array.isArray(settings.packages) ? settings.packages : [];
  const isKit = (p: unknown): boolean => { const s = sourceOf(p); return typeof s === "string" && (s === root || /pi-system/.test(s)); };
  const at = packages.findIndex(isKit);
  const entry = { source: at >= 0 ? sourceOf(packages[at]) : root, extensions: patterns };
  if (at >= 0) packages[at] = entry; else packages.push(entry);
  settings.packages = packages;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({ kitSource: root, profile, scope, mode: "local", extensions: include, installedAt: new Date().toISOString() }, null, 2));
  const firewallPath = path.join(agent, "pi-kit", "firewall.json");
  fs.mkdirSync(path.dirname(firewallPath), { recursive: true });
  fs.writeFileSync(firewallPath, JSON.stringify({ mode: def.firewall?.mode ?? "manual", policy: def.firewall?.policy ?? "coding", source: "profile" }, null, 2));
  fs.writeFileSync(path.join(agent, "pi-kit", "security.json"), JSON.stringify({ schemaVersion: 1, level: securityOf(path.join(profilesDir, `${profile}.json`), profile), source: "profile", revision: 1, changedAt: new Date().toISOString() }));
  return "[install] Done.\n";
}

// The level the real installer writes: the profile's securityLevel, else the migration default.
function securityOf(file: string, profile: string | undefined): string {
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const level = isRecord(raw) ? raw.securityLevel : undefined;
  return typeof level === "string" ? level : profile === "pentest" ? "guarded" : "balanced";
}

// Wires the real command into a fake pi, and captures every pi.exec invocation.
function loadCommand() {
  const pi: CommandPi = fakePi();
  sessionHelpers(pi.api);
  const calls: ExecCall[] = [];
  pi.api.exec = async (command: string, args: string[], options?: ExecOptions) => {
    assert.ok(options, "/profile always passes exec options");
    calls.push({ command, args, options });
    const code = pi.execCode ?? 0;
    const stdout = code === 0 && pi.simulate !== false ? simulateInstall(args, options) : "";
    return { stdout, stderr: "", code };
  };
  return { pi, calls, handler: pi.commands.get("profile").handler };
}

/**
 * `staleAfterReload` makes the fake behave like pi 1.3: once reload() has replaced the session,
 * reading hasUI or ui on the old ctx throws.
 */
function fakeCtx({ hasUI = false, select, confirm, staleAfterReload = false }: { hasUI?: boolean; select?: SelectFn; confirm?: ConfirmFn; staleAfterReload?: boolean } = {}): FakeCtx {
  const ctx: FakeCtx = {
    hasUI,
    notes: [],
    statuses: [],
    reloaded: 0,
    ui: {
      notify: (message: string, level?: string) => ctx.notes.push({ message, level }),
      select: select ?? (async () => undefined),
      confirm: confirm ?? (async () => true),
      setStatus: (key: string, value: unknown) => ctx.statuses.push({ key, value }),
    },
  };
  ctx.reload = async () => {
    ctx.reloaded += 1;
  };
  if (staleAfterReload) {
    const ui = ctx.ui;
    let stale = false;
    const guard = <T>(value: T): T => {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      return value;
    };
    Object.defineProperty(ctx, "hasUI", { get: () => guard(hasUI) });
    Object.defineProperty(ctx, "ui", { get: () => guard(ui) });
    ctx.reload = async () => {
      ctx.reloaded += 1;
      stale = true;
    };
  }
  return ctx;
}

// The most recent notification; there must be one.
function lastNote(notes: Note[]): Note {
  const last = notes.at(-1);
  assert.ok(last, "expected a notification");
  return last;
}

const tests = {
  "a switch that lowers security asks at the terminal, starts on No, and refuses without a UI": async () => {
    const root = makeMonorepoRoot();
    fs.writeFileSync(path.join(root, "packages", "kit", "profiles", "light.json"), JSON.stringify({ name: "light", description: "lightweight", securityLevel: "relaxed" }));
    const agent = makeAgentDir("balanced");
    const securityFile = path.join(agent, "pi-kit", "security.json");
    const saved = (level: string, source: string) => {
      fs.mkdirSync(path.dirname(securityFile), { recursive: true });
      fs.writeFileSync(securityFile, JSON.stringify({ schemaVersion: 1, level, source, revision: 1, changedAt: new Date().toISOString() }));
    };
    const level = () => (JSON.parse(fs.readFileSync(securityFile, "utf8")) as { level: string }).level;
    const restores = [setEnv("PI_KIT_ROOT", root), setEnv("PI_CODING_AGENT_DIR", agent), setEnv("PI_KIT_SECURITY_CONFIG", undefined)];
    try {
      // Headless: refused, the installer never runs.
      saved("balanced", "profile");
      let run = loadCommand();
      const headless = fakeCtx({ hasUI: false });
      await run.handler("light", headless);
      assert.equal(run.calls.length, 0);
      assert.match(lastNote(headless.notes).message, /lowers security from balanced to relaxed.*refused in headless/s);
      // The terminal choice lists "No" first; choosing it (or dismissing) changes nothing.
      const offered: string[][] = [];
      for (const answer of [(o: string[]) => o[0], () => undefined]) {
        run = loadCommand();
        const ctx = fakeCtx({ hasUI: true, select: async (_title: string, options: string[]) => { offered.push(options); return answer(options); } });
        await run.handler("light", ctx);
        assert.equal(run.calls.length, 0);
        assert.equal(level(), "balanced");
        assert.match(lastNote(ctx.notes).message, /kept security at balanced/);
      }
      assert.match(offered[0]?.[0] ?? "", /^No, keep/);
      // Choosing "Yes" switches and the installer writes the profile's relaxed level.
      run = loadCommand();
      const yes = fakeCtx({ hasUI: true, select: async (_title: string, options: string[]) => options.find((o) => o.startsWith("Yes")) });
      await run.handler("light", yes);
      assert.equal(run.calls.length, 1, yes.notes.map((n) => n.message).join("\n"));
      assert.equal(level(), "relaxed");
      // Raising security never asks.
      run = loadCommand();
      const up = fakeCtx({ hasUI: false });
      await run.handler("balanced", up);
      assert.equal(run.calls.length, 1, up.notes.map((n) => n.message).join("\n"));
      // An operator-chosen level survives profile switches, so nothing is lowered and nothing asks.
      saved("guarded", "operator");
      fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ kitSource: "/nonexistent", profile: "balanced" }));
      run = loadCommand();
      const operator = fakeCtx({ hasUI: false });
      await run.handler("light", operator);
      assert.equal(run.calls.length, 1, operator.notes.map((n) => n.message).join("\n"));
    } finally {
      for (const r of restores.reverse()) r();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "profile recognises both scoped identities and canonical Luna URLs": async () => {
    const root = makeMonorepoRoot();
    const agent = makeAgentDir("autonomous");
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profile-identity-"));
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      for (const name of ["@satunix/pi-system", "@satunix/luna", "pi-system"]) {
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
        for (const source of [
          "npm:@satunix/pi-system", "npm:@satunix/luna@next",
          "git:github.com/SATUNIX/luna@feature/test", "git:git@GITHUB.COM:SATUNIX/luna.git@next",
          "https://github.com/SATUNIX/luna.git", "http://github.com/SATUNIX/luna@feature/test",
          "ssh://git@github.com:2222/SATUNIX/luna.git", "git:ssh://git@github.com/SATUNIX/luna",
          "git:https://github.com/SATUNIX/luna", "git:git://github.com/SATUNIX/luna", "git://github.com/SATUNIX/luna",
        ]) {
          const file = path.join(project, ".pi", "settings.json");
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ packages: [{ source, extensions: ["packages/extensions/src/identity-filter/index.ts"] }] }));
          assert.deepEqual(loadedKitExtensions(file, root), ["identity-filter"], `${name}: ${source}`);
          const { handler, calls } = loadCommand();
          const ctx = fakeCtx({ hasUI: true });
          ctx.cwd = project;
          await handler("self-improving", ctx);
          assert.ok(firstCall(calls).args.includes("project"), `${name}: ${source}`);
        }
      }
      for (const source of ["npm:luna", "git:github.com/alice/luna", "git:gitlab.com/x/luna", "git:github.com.evil.invalid/SATUNIX/luna"]) {
        assert.equal(mod.isKitNpmSource(source) || mod.isKitGitSource(source), false, source);
      }
      // Explicit previous-source metadata can recognise another former public repository.
      const metadata = path.join(root, "packages", "core", "distribution.json");
      const previous = "git:github.com/example/old-kit";
      fs.writeFileSync(metadata, JSON.stringify({ git: { previousSources: [previous] } }));
      const settings = path.join(project, ".pi", "settings.json");
      fs.writeFileSync(settings, JSON.stringify({ packages: [{ source: `${previous}@main`, extensions: ["packages/extensions/src/identity-filter/index.ts"] }] }));
      assert.deepEqual(loadedKitExtensions(settings, root), ["identity-filter"]);
      fs.writeFileSync(settings, JSON.stringify({ packages: [previous] }));
      assert.equal(unfilteredKitEntry(settings), true);
      for (const previousSources of [null, "wrong", [42], ["npm:luna"]]) {
        fs.writeFileSync(metadata, JSON.stringify({ git: { previousSources } }));
        assert.throws(() => loadedKitExtensions(settings, root), /git.previousSources/);
      }
      fs.writeFileSync(metadata, JSON.stringify({ git: { previousSources: [] } }));
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "luna" }));
      const file = path.join(project, ".pi", "settings.json");
      fs.writeFileSync(file, JSON.stringify({ packages: [{ source: "npm:@satunix/luna", extensions: ["foreign"] }] }));
      assert.equal(loadedKitExtensions(file, root), null, "bare luna is not a kit root");
    } finally {
      restoreRoot(); restoreAgent(); rmWorkspace(root); rmWorkspace(agent); rmWorkspace(project);
    }
  },

  "an npm kit entry (any channel) is the kit's own entry for an installed copy": async () => {
    const root = makeMonorepoRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@satunix/pi-system", version: "0.2.1-beta.0" }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-npm-"));
    const settings = path.join(dir, "settings.json");
    try {
      fs.writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-lens@3.8.63", { source: "npm:@satunix/pi-system@next", extensions: ["packages/extensions/third_party/todo/index.ts", "packages/extensions/src/save/index.ts"] }] }));
      assert.deepEqual(loadedKitExtensions(settings, root), ["todo", "save"]);
      assert.equal(unfilteredNpmKitEntry(settings), false);
      fs.writeFileSync(settings, JSON.stringify({ packages: ["npm:@satunix/pi-system"] }));
      assert.equal(loadedKitExtensions(settings, root), null, "a bare npm entry is unfiltered");
      assert.equal(unfilteredNpmKitEntry(settings), true);
    } finally {
      rmWorkspace(root);
      rmWorkspace(dir);
    }
  },

  "a git kit entry (any ref, https or ssh form) is the kit's own entry for pi's clone": async () => {
    const root = makeMonorepoRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@satunix/pi-system", version: "0.2.1-beta.0" }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-git-"));
    const settings = path.join(dir, "settings.json");
    try {
      fs.writeFileSync(settings, JSON.stringify({ packages: [{ source: "git:github.com/SATUNIX/pi-system@v0.2.1-beta.0", extensions: ["packages/extensions/third_party/todo/index.ts"] }] }));
      assert.deepEqual(loadedKitExtensions(settings, root), ["todo"]);
      assert.equal(unfilteredKitEntry(settings), false);
      for (const bare of ["git:github.com/SATUNIX/pi-system", "git:git@github.com:SATUNIX/pi-system@v0.2.1-beta.0"]) {
        fs.writeFileSync(settings, JSON.stringify({ packages: [bare] }));
        assert.equal(unfilteredKitEntry(settings), true, bare);
      }
      fs.writeFileSync(settings, JSON.stringify({ packages: ["git:github.com/example/other-tool"] }));
      assert.equal(unfilteredKitEntry(settings), false, "other git packages are not the kit");
    } finally {
      rmWorkspace(root);
      rmWorkspace(dir);
    }
  },

  "a bare npm install gets the default profile applied on the first interactive session": async () => {
    const root = makeMonorepoRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@satunix/pi-system", version: "0.2.1-beta.0" }));
    const agent = makeAgentDir("balanced");
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:@satunix/pi-system"] }));
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { pi, calls } = loadCommand();
      const start = pi.handlers.get("session_start");
      await start({}, fakeCtx({ hasUI: false }));
      assert.equal(calls.length, 0, "print/JSON sessions never rewrite settings");
      const ctx = fakeCtx({ hasUI: true });
      await start({}, ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(firstCall(calls).args.slice(1), ["--profile", "balanced", "--yes", "--settings-only", "--scope", "global", "--no-migrate"]);
      assert.equal(firstCall(calls).options.cwd, root, "a global auto-profile runs the installer from the kit root");
      assert.ok(ctx.notes.some((n) => /applied the "balanced" profile/.test(n.message)));
      const restoreOff = setEnv("PI_KIT_AUTO_PROFILE", "0");
      try {
        await start({}, fakeCtx({ hasUI: true }));
        assert.equal(calls.length, 1, "PI_KIT_AUTO_PROFILE=0 turns it off");
      } finally {
        restoreOff();
      }
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "a project-scoped auto-profile runs the installer in the project": async () => {
    const root = makeMonorepoRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@satunix/pi-system", version: "0.2.1-beta.0" }));
    const agent = makeAgentDir("balanced");
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-project-auto-"));
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@satunix/pi-system"] }));
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { pi, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = project;
      await pi.handlers.get("session_start")({}, ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(firstCall(calls).args.slice(1), ["--profile", "balanced", "--yes", "--settings-only", "--scope", "project", "--no-migrate"]);
      assert.equal(firstCall(calls).options.cwd, project, "a project auto-profile must run install.ts in the project");
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
      rmWorkspace(project);
    }
  },

  "registers /profile with a description": async () => {
    const pi = fakePi();
    sessionHelpers(pi.api);
    assert.ok(pi.commands.has("profile"), "/profile must be registered");
    assert.ok((pi.commands.get("profile").description ?? "").length > 0);
  },

  "findKitRoot honours PI_KIT_ROOT (legacy layout)": async () => {
    const root = makeKitRoot();
    const restore = setEnv("PI_KIT_ROOT", root);
    try {
      assert.equal(findKitRoot(), root);
    } finally {
      restore();
      rmWorkspace(root);
    }
  },

  "findKitRoot honours PI_KIT_ROOT (monorepo layout)": async () => {
    const root = makeMonorepoRoot();
    const restore = setEnv("PI_KIT_ROOT", root);
    try {
      assert.equal(findKitRoot(), root);
    } finally {
      restore();
      rmWorkspace(root);
    }
  },

  "resolveKitLayout finds the monorepo installer and profiles": async () => {
    const root = makeMonorepoRoot();
    try {
      const layout = resolveKitLayout(root);
      assert.ok(layout, "monorepo layout must resolve");
      assert.equal(layout.installer, path.join(root, "packages", "core", "install.ts"));
      assert.equal(layout.profilesDir, path.join(root, "packages", "kit", "profiles"));
    } finally {
      rmWorkspace(root);
    }
  },

  "resolveKitLayout finds the installer by stem: compiled npm artefact, then a pre-migration kit": async () => {
    const root = makeMonorepoRoot();
    try {
      const core = path.join(root, "packages", "core");
      fs.renameSync(path.join(core, "install.ts"), path.join(core, "install.js"));
      assert.equal(resolveKitLayout(root)?.installer, path.join(core, "install.js"), "the npm artefact ships install.js");
      fs.renameSync(path.join(core, "install.js"), path.join(core, "install.mjs"));
      assert.equal(resolveKitLayout(root)?.installer, path.join(core, "install.mjs"), "a kit from before the migration ships install.mjs");
    } finally {
      rmWorkspace(root);
    }
  },

  "resolveKitLayout rejects a non-kit directory": async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-empty-"));
    try {
      assert.equal(resolveKitLayout(dir), null);
    } finally {
      rmWorkspace(dir);
    }
  },

  // A checkout, git clone and npm install all keep the monorepo layout, so with no override
  // and no usable marker the kit is the package the extension was loaded from (here: this
  // repository). This is what makes /profile work after `pi install npm:@satunix/pi-system`.
  "findKitRoot falls back to the package it was loaded from": async () => {
    const agent = makeAgentDir("balanced", { kitSource: "npm:@satunix/pi-system" });
    const restoreRoot = setEnv("PI_KIT_ROOT", undefined);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
      assert.equal(findKitRoot(), repoRoot);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(agent);
    }
  },

  // F1: a marker file containing the literal JSON `null` must not make readMarker return
  // null and findKitRoot dereference it. The reader must fall back to {} and findKitRoot
  // must fall through to the package it was loaded from, exactly as for a missing marker.
  "findKitRoot survives a null JSON marker": async () => {
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-null-marker-"));
    fs.writeFileSync(path.join(agent, ".pi-kit.json"), "null");
    const restoreRoot = setEnv("PI_KIT_ROOT", undefined);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
      assert.equal(findKitRoot(), repoRoot, "a null marker must be treated like an absent marker");
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(agent);
    }
  },

  "listProfiles reads names + descriptions, sorted": async () => {
    const root = makeKitRoot();
    try {
      assert.deepEqual(
        listProfiles(root).map((p: { name: string }) => p.name),
        ["autonomous", "balanced", "self-improving"],
      );
    } finally {
      rmWorkspace(root);
    }
  },

  "listProfiles works for the monorepo layout": async () => {
    const root = makeMonorepoRoot();
    try {
      assert.deepEqual(
        listProfiles(root).map((p: { name: string }) => p.name),
        ["autonomous", "balanced", "self-improving"],
      );
    } finally {
      rmWorkspace(root);
    }
  },

  "/profile list marks the current profile and lists all": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("balanced");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("list", ctx);
      const text = ctx.notes.map((n) => n.message).join("\n");
      assert.match(text, /autonomous/);
      assert.match(text, /self-improving/);
      assert.match(text, /\*\s+balanced/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "unknown profile is rejected without running the installer": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("balanced");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("does-not-exist", ctx);
      assert.equal(calls.length, 0, "installer must not run for an unknown profile");
      assert.match(lastNote(ctx.notes).message, /unknown profile/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "switching to the current profile is a no-op": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("autonomous", ctx);
      assert.equal(calls.length, 0, "installer must not run when the profile is unchanged");
      assert.equal(ctx.reloaded, 0);
      assert.match(lastNote(ctx.notes).message, /already on/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "direct switch runs the documented install argv and reloads": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.equal(firstCall(calls).command, process.execPath, "installer must run under the node binary");
      assert.deepEqual(firstCall(calls).args, [
        path.join(root, "kit", "install.mjs"),
        "--profile",
        "self-improving",
        "--yes",
        "--settings-only",
        "--no-migrate",
      ]);
      assert.equal(firstCall(calls).options.cwd, root);
      assert.equal(ctx.reloaded, 1, "a successful switch must reload");
      assert.match(lastNote(ctx.notes).message, /switched to "self-improving"/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "a switch never uses the ctx its reload replaced (pi 1.3 throws on a stale ctx)": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler } = loadCommand();
      const ctx = fakeCtx({ hasUI: true, staleAfterReload: true });
      await handler("self-improving", ctx); // used to reject: hasUI was read after the reload
      assert.equal(ctx.reloaded, 1, "a successful switch must reload");
      assert.match(lastNote(ctx.notes).message, /switched to "self-improving"/, "the result is announced before the reload");
      assert.deepEqual(ctx.statuses.at(-1), { key: "profile", value: undefined }, "the switching status is cleared before the reload");
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "monorepo switch drives packages/core/install.ts": async () => {
    const root = makeMonorepoRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(firstCall(calls).args, [
        path.join(root, "packages", "core", "install.ts"),
        "--profile",
        "self-improving",
        "--yes",
        "--settings-only",
        "--no-migrate",
      ]);
      assert.equal(firstCall(calls).options.cwd, root);
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "installer failure surfaces the error and does not reload": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { pi, handler } = loadCommand();
      pi.execCode = 1;
      const ctx = fakeCtx({ hasUI: true });
      await handler("self-improving", ctx);
      assert.equal(ctx.reloaded, 0, "a failed install must not reload");
      const last = lastNote(ctx.notes);
      assert.equal(last.level, "error");
      assert.match(last.message, /FAILED at install: installer exited 1/);
      assert.match(last.message, /Nothing was changed/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "picker selection switches to the chosen profile": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({
        hasUI: true,
        select: async (_title: string, options: string[]) => options.find((o) => o.startsWith("balanced")),
        confirm: async () => true,
      });
      await handler("", ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(firstCall(calls).args.slice(1), ["--profile", "balanced", "--yes", "--settings-only", "--no-migrate"]);
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "cancelling the picker does nothing": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true, select: async () => undefined });
      await handler("", ctx);
      assert.equal(calls.length, 0);
      assert.equal(ctx.reloaded, 0);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "non-UI with no argument prints usage and does not install": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: false });
      await handler("", ctx);
      assert.equal(calls.length, 0);
      assert.equal(ctx.reloaded, 0);
      assert.match(lastNote(ctx.notes).message, /usage: \/profile/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "findKitRoot falls back to the marker kitSource": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("balanced", { kitSource: root });
    const restoreRoot = setEnv("PI_KIT_ROOT", undefined);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      assert.equal(findKitRoot(), root);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "passes the recorded install scope back to the installer": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous", { scope: "project" });
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-scope-cwd-"));
      await handler("self-improving", ctx);
      assert.deepEqual(firstCall(calls).args.slice(1), [
        "--profile",
        "self-improving",
        "--yes",
        "--settings-only",
        "--scope",
        "project",
        "--no-migrate",
      ]);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },
  "a project marker in the cwd forwards --scope project and uses the project settings path": async () => {
    const root = makeKitRoot();
    // A global marker that must be ignored in favour of the project one.
    const agent = makeAgentDir("autonomous", { scope: "global" });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-project-"));
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", ".pi-kit.json"), JSON.stringify({ profile: "autonomous", scope: "project" }));
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = project;
      await handler("status", ctx);
      const settingsPath = path.join(project, ".pi", "settings.json");
      assert.ok(lastNote(ctx.notes).message.includes(`Settings: ${settingsPath}`), "status must read the project settings file");
      assert.match(lastNote(ctx.notes).message, /Current: autonomous/);
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(firstCall(calls).args.slice(1), ["--profile", "self-improving", "--yes", "--settings-only", "--scope", "project", "--no-migrate"]);
      assert.equal(firstCall(calls).options.cwd, project, "a project-scoped switch must run install.ts in the project");
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
      rmWorkspace(project);
    }
  },

  "a project settings entry without a project marker still scopes /profile to the project": async () => {
    // The inconsistent state WU-1 guards: <project>/.pi/settings.json has the kit
    // entry, but <project>/.pi/.pi-kit.json is absent, so readMarker falls back to the
    // global marker. The settings entry is authoritative for scope, so /profile must
    // still pass --scope project and run install.ts in the project.
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous", { scope: "global" });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-project-entry-"));
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: [root] }));
    assert.ok(!fs.existsSync(path.join(project, ".pi", ".pi-kit.json")), "no project marker");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = project;
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.ok(firstCall(calls).args.includes("--scope"), firstCall(calls).args.join(" "));
      assert.equal(firstCall(calls).args[firstCall(calls).args.indexOf("--scope") + 1], "project", "the project settings entry makes /profile project-scoped");
      assert.equal(firstCall(calls).options.cwd, project, "a project-scoped switch must run install.ts in the project");
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
      rmWorkspace(project);
    }
  },

  "a legacy-named kit root still scopes a project settings entry to the project": async () => {
    // F3: an npm kit entry points at a checkout whose package.json still carries the legacy
    // "pi-system" name. kit-update's isKitRoot accepts that name, so /profile must agree:
    // without a project marker the settings entry is still authoritative for scope.
    const root = makeMonorepoRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-system", version: "0.2.1-beta.0" }));
    const agent = makeAgentDir("autonomous", { scope: "global" });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-legacy-"));
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@satunix/pi-system"] }));
    assert.ok(!fs.existsSync(path.join(project, ".pi", ".pi-kit.json")), "no project marker");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = project;
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.ok(firstCall(calls).args.includes("--scope"), firstCall(calls).args.join(" "));
      assert.equal(firstCall(calls).args[firstCall(calls).args.indexOf("--scope") + 1], "project", "a legacy-named kit root must still make /profile project-scoped (fails on pre-fix code)");
      assert.equal(firstCall(calls).options.cwd, project, "a project-scoped switch must run install.ts in the project");
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
      rmWorkspace(project);
    }
  },

  "status detects the actually-loaded set, not the marker": async () => {
    const root = makeMonorepoRoot();
    for (const n of ["alpha", "beta", "gamma"]) {
      fs.mkdirSync(path.join(root, "packages", "extensions", "src", n), { recursive: true });
      fs.writeFileSync(path.join(root, "packages", "extensions", "src", n, "index.ts"), "");
    }
    const profiles = path.join(root, "packages", "kit", "profiles");
    fs.writeFileSync(path.join(profiles, "balanced.json"), JSON.stringify({ name: "balanced", description: "d", include: ["alpha", "beta", "pi-lens"] }));
    fs.writeFileSync(path.join(profiles, "autonomous.json"), JSON.stringify({ name: "autonomous", description: "d", include: ["alpha", "beta", "gamma"] }));
    const agent = makeAgentDir("autonomous", { kitSource: root });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [{ source: root, extensions: ["packages/extensions/src/alpha/index.ts", "packages/extensions/src/beta/index.ts"] }] }));
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("status", ctx);
      assert.match(lastNote(ctx.notes).message, /Current: balanced/, "the loaded set matches balanced even though the marker says autonomous");
      await handler("balanced", ctx);
      assert.equal(calls.length, 0, "re-selecting the profile that is really in effect is a no-op");
      // Drift: drop beta by hand -> custom, and the picker offers to keep the edit.
      fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [{ source: root, extensions: ["packages/extensions/src/alpha/index.ts"] }] }));
      const ctx2 = fakeCtx({ hasUI: true, confirm: async (title: string) => title.startsWith("Keep") });
      await handler("status", ctx2);
      assert.match(lastNote(ctx2.notes).message, /custom \(closest: balanced/);
      assert.match(lastNote(ctx2.notes).message, /missing vs balanced: beta/);
      await handler("autonomous", ctx2);
      assert.ok(calls.at(-1)?.args.includes("--capture-overrides"), "hand edits are captured on the first switch when the operator agrees");
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "/compaction on|off writes pi's setting, preserves the rest, and reloads": async () => {
    const agent = makeAgentDir("balanced");
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ theme: "t", compaction: { enabled: true, reserveTokens: 9000 } }));
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const pi = fakePi();
      sessionHelpers(pi.api);
      const handler = pi.commands.get("compaction").handler;
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = agent;
      await handler("off", ctx);
      const saved = parseJson(fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
      assert.deepEqual(saved, { theme: "t", compaction: { enabled: false, reserveTokens: 9000 } });
      assert.equal(ctx.reloaded, 1, "pi keeps settings in memory, so the change needs a reload");
      await handler("status", ctx);
      assert.match(lastNote(ctx.notes).message, /Auto-compaction \(pi\): OFF/);
      await handler("trigger off", ctx);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, "pi-kit", "trigger-compact.json"), "utf8")), { enabled: false });
      await handler("trigger on", ctx);
      assert.equal(fs.existsSync(path.join(agent, "pi-kit", "trigger-compact.json")), false);
      fs.writeFileSync(path.join(agent, "settings.json"), "{ broken");
      await handler("on", ctx);
      assert.equal(lastNote(ctx.notes).level, "error", "an unparseable settings file is never rewritten");
      assert.equal(fs.readFileSync(path.join(agent, "settings.json"), "utf8"), "{ broken");
    } finally {
      restoreAgent();
      rmWorkspace(agent);
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
  console.error(`profile-command-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`profile-command-smoke: ${total}/${total} passed`);
