#!/usr/bin/env node
/**
 * `/update` on a local checkout that a fast-forward pull cannot update: a detached HEAD, or a
 * branch with no upstream branch of that name at origin (an installed copy kept as its own git
 * worktree on its own branch).
 *
 * The fixture is real git, with no network: a temporary repository acting as origin, with release
 * tags `<tagPrefix>X.Y.Z` on main and the trunk branch named in packages/core/distribution.json,
 * and a worktree of a clone of it, on a branch of its own, registered in pi settings as the
 * installed local kit. HOME, PI_CODING_AGENT_DIR and the git identity are scratch values. npm and
 * the kit installer are not run: the plan's exec stand-in records them and writes what they would
 * (node_modules/.package-lock.json, a rewritten install marker); every git step runs for real.
 *
 * Covers: the refs the check reports (newest release tag, main and trunk heads); the ordered plan
 * (fetch, detached checkout, npm ci, reinstall in local mode for the recorded profile) and that it
 * carries no destructive git; running it under one confirmation, moving a second time to trunk and
 * undoing back to the branch; and each refusal (uncommitted tracked changes, a retired private
 * origin, no origin, an unreachable origin, nothing newer) with the commands left to the operator.
 * A checkout whose branch tracks an upstream branch of the same name keeps the fast-forward pull.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { readDistribution } from "../packages/core/lib/distribution.ts";
import type * as KitUpdate from "../packages/extensions/src/kit-update/index.ts";
import type * as Journal from "../packages/extensions/src/kit-update/journal.ts";

type KitUpdateModule = Omit<typeof KitUpdate, "default" | "runPlan"> & {
  default: (pi: ReturnType<typeof fakePi>["api"]) => void;
  runPlan: (pi: Pick<ExtensionAPI, "exec">, cwd: string, steps: Parameters<typeof KitUpdate.runPlan>[2]) => Promise<KitUpdate.StepOutcome>;
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = readDistribution(path.join(REPO, "packages", "core", "distribution.json"));
const TAG_PREFIX = dist.git.tagPrefix;
const TRUNK = dist.git.trunkBranch;
const MAIN = dist.git.branch;
const LEGACY_ORIGIN = "https://legacy.example.invalid/lab/pi-system.git";

const restoreKitEnv = isolateKitEnv();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-local-"));
const restoreEnv = [
  setEnv("HOME", path.join(scratch, "home")),
  setEnv("PI_CODING_AGENT_DIR", path.join(scratch, "agent")),
  setEnv("PI_KIT_ROOT", undefined),
  setEnv("GIT_CONFIG_NOSYSTEM", "1"),
  setEnv("GIT_CONFIG_GLOBAL", path.join(scratch, "home", ".gitconfig")),
  setEnv("GIT_AUTHOR_NAME", "Luna Test"),
  setEnv("GIT_AUTHOR_EMAIL", "test@example.invalid"),
  setEnv("GIT_COMMITTER_NAME", "Luna Test"),
  setEnv("GIT_COMMITTER_EMAIL", "test@example.invalid"),
];
fs.mkdirSync(path.join(scratch, "home"), { recursive: true });
const mod = await loadModule<KitUpdateModule>("extensions/kit-update/index.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function writeKit(dir: string, version: string): void {
  writeJson(path.join(dir, "package.json"), { name: "@satunix/luna", version });
  writeJson(path.join(dir, "package-lock.json"), { name: "@satunix/luna", version, lockfileVersion: 3, packages: {} });
  fs.mkdirSync(path.join(dir, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages", "core", "install.ts"), "// stub installer\n");
  writeJson(path.join(dir, "packages", "core", "sources.json"), { external: [] });
  writeJson(path.join(dir, "packages", "core", "distribution.json"), {
    delivery: "git",
    git: { source: "git:github.com/SATUNIX/luna", branch: MAIN, trunkBranch: TRUNK, tagPrefix: TAG_PREFIX },
  });
  // local.cfg is ignored everywhere but tracked on trunk: moving onto trunk must not overwrite an operator's ignored copy.
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nlocal.cfg\n");
}

function commit(dir: string, version: string, extra: Record<string, string> = {}): string {
  writeKit(dir, version);
  for (const [file, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), content);
  git(dir, "add", "-A");
  for (const file of Object.keys(extra)) git(dir, "add", "-f", file);
  git(dir, "commit", "-q", "-m", `kit ${version}`);
  return git(dir, "rev-parse", "HEAD");
}

// origin: v0.4.0 and v0.5.0 on main (annotated tags, so the check must peel them), and the trunk
// branch one commit past v0.5.0.
const origin = path.join(scratch, "origin");
fs.mkdirSync(origin);
git(origin, "init", "-q", "-b", MAIN);
const c040 = commit(origin, "0.4.0");
git(origin, "tag", "-a", `${TAG_PREFIX}0.4.0`, "-m", "0.4.0");
// A clone taken now, on main tracking origin/main: the fast-forward path's fixture.
const tracking = path.join(scratch, "tracking");
execFileSync("git", ["clone", "-q", origin, tracking]);
const clone = path.join(scratch, "clone");
execFileSync("git", ["clone", "-q", origin, clone]);
const c050 = commit(origin, "0.5.0");
git(origin, "tag", "-a", `${TAG_PREFIX}0.5.0`, "-m", "0.5.0");
git(origin, "checkout", "-q", "-b", TRUNK);
const cTrunk = commit(origin, "0.6.0-dev", { "local.cfg": "shipped\n" });
git(origin, "checkout", "-q", MAIN);

// The installed copy: a worktree of the clone on a branch origin does not have.
const installed = path.join(scratch, "installed");
git(clone, "worktree", "add", "-q", "-b", "luna-installed", installed, c040);

const agent = path.join(scratch, "agent");
const cwd = path.join(scratch, "project");
fs.mkdirSync(cwd);
const markerFile = path.join(agent, ".pi-kit.json");
function register(root: string): void {
  writeJson(path.join(agent, "settings.json"), { packages: [{ source: root }] });
  writeJson(markerFile, { profile: "balanced", scope: "global", installedAt: "2026-01-01T00:00:00.000Z" });
}

// The registry answers for pi only, so `offline` in a report reflects the git lookups.
const offlineRegistry: KitUpdate.FetchLike = async (url) => (url.includes("pi-coding-agent") ? { ok: true, json: async () => ({ latest: "0.87.1" }) } : { ok: false, json: async () => ({}) });
function recordingGit(): { git: KitUpdate.GitLike; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, git: async (args) => { calls.push(args); return mod.runGit(args); } };
}
const check = async (g: KitUpdate.GitLike = mod.runGit): Promise<KitUpdate.UpdateReport> => mod.checkForUpdates(cwd, offlineRegistry, "0.87.1", g);

// pi.exec as the plan sees it: git for real, npm and the installer recorded and simulated.
const ran: string[] = [];
const exec: ExtensionAPI["exec"] = async (command, args, options) => {
  ran.push([path.basename(command), ...args].join(" "));
  if (command === "git") {
    try {
      const stdout = execFileSync("git", args, { cwd: options?.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { stdout, stderr: "", code: 0, killed: false };
    } catch (error) {
      return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1, killed: false };
    }
  }
  if (args[0] === "ci") writeJson(path.join(options?.cwd ?? "", "node_modules", ".package-lock.json"), {});
  if ((args[0] ?? "").endsWith("install.ts")) writeJson(markerFile, { profile: "balanced", scope: "global", installedAt: new Date().toISOString() });
  return { stdout: "", stderr: "", code: 0, killed: false };
};

const DESTRUCTIVE = [/\breset --hard\b/, /\bcheckout (-f|--force)\b/, /\bclean\b/, /--force\b/, /\bstash\b/];
function argv(steps: Array<{ command: string; args: string[] }>): string[] {
  return steps.map((s) => [path.basename(s.command), ...s.args].join(" "));
}
function assertSafe(lines: string[]): void {
  for (const line of lines) for (const bad of DESTRUCTIVE) assert.doesNotMatch(line, bad, line);
}

const tests: Record<string, () => Promise<void>> = {
  "a detached or untracked checkout reports the newest release and the trunk head": async () => {
    register(installed);
    const report = await check();
    assert.equal(report.kit.kind, "local");
    assert.equal(report.kit.branch, "luna-installed");
    const move = report.kit.localMove;
    assert.ok(move, "the checkout has no upstream branch of its name, so the move path applies");
    assert.equal(move.refusal, null);
    assert.equal(move.refs.latest?.name, `${TAG_PREFIX}0.5.0`);
    assert.equal(move.refs.latest?.commit, c050, "the annotated tag is peeled to its commit");
    assert.equal(move.refs.latest?.newer, true);
    assert.equal(move.refs.trunk?.name, TRUNK);
    assert.equal(move.refs.trunk?.commit, cTrunk);
    assert.equal(move.refs.next?.commit, c050);
    assert.equal(report.kit.available, true);
    assert.equal(report.kit.target, `${TAG_PREFIX}0.5.0@${c050.slice(0, 7)}`);
    assert.deepEqual(report.kit.tags, { latest: "0.5.0", next: `${MAIN}@${c050.slice(0, 7)}`, trunk: `${TRUNK}@${cTrunk.slice(0, 7)}` });
    assert.match(mod.formatReport(report), new RegExp(`available: latest 0\\.5\\.0, next ${MAIN}@${c050.slice(0, 7)}, trunk ${TRUNK.replace(/[/.]/g, "\\$&")}@${cTrunk.slice(0, 7)}`));
    assert.match(mod.summaryLine(report), /Updates available: Luna 0\.4\.0/);
  },

  "the plan is fetch, detached checkout, npm ci, reinstall in local mode, with no destructive git": async () => {
    register(installed);
    const report = await check();
    for (const what of ["kit", "all"] as const) {
      const plan = mod.planUpdate(report, what);
      const lines = argv(plan.steps);
      assert.deepEqual(lines.slice(0, 4), [
        `git -C ${installed} fetch --no-tags origin refs/tags/${TAG_PREFIX}0.5.0:refs/tags/${TAG_PREFIX}0.5.0`,
        `git -C ${installed} checkout --no-overwrite-ignore --detach ${c050}`,
        `${path.basename(nth(plan.steps, 2).command)} ci`,
        `${path.basename(nth(plan.steps, 3).command)} ${path.join(installed, "packages", "core", "install.ts")} --profile balanced --yes --mode local --scope global`,
      ], what);
      assert.equal(plan.steps.length, 4, `${what}: one reinstall, no second settings-only re-apply`);
      assert.equal(nth(plan.steps, 2).cwd, installed, "npm ci runs in the checkout");
      assert.equal(nth(plan.steps, 3).reapplies, true);
      assert.match(nth(plan.steps, 1).changesKit ?? "", new RegExp(`switch --no-overwrite-ignore --no-guess luna-installed`), "the way back names the branch the checkout was on");
      assertSafe(lines);
    }
    const trunk = mod.planUpdate(report, "kit", null, mod.runGit, "trunk");
    assert.deepEqual(argv(trunk.steps).slice(0, 2), [`git -C ${installed} fetch --no-tags origin +refs/heads/${TRUNK}:refs/remotes/origin/${TRUNK}`, `git -C ${installed} checkout --no-overwrite-ignore --detach ${cTrunk}`]);
  },

  "/update kit runs the plan under one confirmation, /update kit trunk moves on, /update undo goes back": async () => {
    register(installed);
    const pi = fakePi();
    pi.api.exec = exec;
    mod.default(pi.api);
    const handler = pi.commands.get("update").handler;
    const confirms: string[] = [];
    const selects: string[][] = [];
    const notes: string[] = [];
    let reloaded = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = offlineRegistry as typeof fetch;
    const ctx = {
      hasUI: true,
      cwd,
      ui: { notify: (m: string) => notes.push(m), setStatus() {}, confirm: async (_title: string, body: string) => { confirms.push(body); return true; }, select: async (_t: string, options: string[]) => { selects.push(options); return undefined; } },
      reload: async () => { reloaded++; },
    };
    try {
      await handler("", ctx);
      const options = nth(selects, 0).join("\n");
      assert.match(options, new RegExp(`Move the local Luna checkout to release ${TAG_PREFIX}0\\.5\\.0`));
      assert.match(options, new RegExp(`Move the local Luna checkout to ${TRUNK.replace(/[/.]/g, "\\$&")}`));
      assert.doesNotMatch(options, /Pull the local Luna checkout/);

      ran.length = 0;
      await handler("kit", ctx);
      assert.equal(confirms.length, 1, "one confirmation for the whole plan");
      assert.match(nth(confirms, 0), /fetch .*\n.*move the local checkout.*\n.*npm ci.*\n.*reinstall/);
      assert.equal(git(installed, "rev-parse", "HEAD"), c050);
      assert.equal(git(installed, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "the checkout is detached");
      assert.equal(git(installed, "rev-parse", "luna-installed"), c040, "the branch itself is not moved");
      assert.match(notes.join("\n"), /Updated \(verified\)/);
      assert.equal(reloaded, 1);

      // At the release: latest has nothing newer, trunk does.
      const atRelease = await check();
      assert.equal(atRelease.kit.available, false);
      assert.equal(atRelease.kit.branch, null);
      const nothing = mod.planUpdate(atRelease, "kit");
      assert.equal(nothing.steps.length, 0);
      assert.match(nothing.notes.join("\n"), new RegExp(`already contains ${TAG_PREFIX}0\\.5\\.0.*/update kit trunk`));

      // Finding 6: a commit made on the detached HEAD blocks both a move and an undo, naming the rescue command.
      fs.writeFileSync(path.join(installed, "operator.txt"), "work\n");
      git(installed, "add", "operator.txt");
      git(installed, "commit", "-q", "-m", "operator work on the detached HEAD");
      const loose = git(installed, "rev-parse", "HEAD");
      const orphaning = await check();
      assert.match(orphaning.kit.localMove?.refusal ?? "", new RegExp(`branch luna-rescue ${loose}`));
      notes.length = 0;
      await handler("undo", ctx);
      assert.match(notes.join("\n"), new RegExp(`undo does not move the checkout.*branch luna-rescue ${loose}`, "s"));
      assert.equal(git(installed, "rev-parse", "HEAD"), loose, "undo refused: HEAD stays on the operator's commit");
      git(installed, "branch", "operator-work", loose);
      git(installed, "checkout", "-q", "--detach", c050);

      // Finding 5: an ignored local.cfg that trunk tracks is not overwritten; the move stops at the checkout.
      fs.writeFileSync(path.join(installed, "local.cfg"), "operator\n");
      notes.length = 0;
      await handler("kit trunk", ctx);
      assert.match(notes.join("\n"), /move the local checkout.*failed/);
      assert.equal(fs.readFileSync(path.join(installed, "local.cfg"), "utf8"), "operator\n", "the ignored file is kept");
      assert.equal(git(installed, "rev-parse", "HEAD"), c050);
      fs.rmSync(path.join(installed, "local.cfg"));

      await handler("kit trunk", ctx);
      assert.equal(confirms.length, 3);
      assert.equal(git(installed, "rev-parse", "HEAD"), cTrunk);

      // Undo returns to the journal's state: the commit the trunk move started from (detached).
      ran.length = 0;
      await handler("undo", ctx);
      assert.equal(git(installed, "rev-parse", "HEAD"), c050);
      assertSafe(ran);
    } finally {
      globalThis.fetch = realFetch;
    }

    // Undo of the first move (journalled on branch luna-installed) returns to that branch, without discarding anything.
    const journal = { version: 1, createdAt: "", steps: [], pi: "0.87.1", profile: "balanced", files: [], complete: true, kit: { kind: "local" as const, source: installed, version: "0.4.0", commit: c040, channel: null, root: installed, scope: "user" as const, branch: "luna-installed" } };
    const undo = mod.planUndo(journal, cwd);
    assert.deepEqual(argv(undo.steps), [`git -C ${installed} switch --no-overwrite-ignore --no-guess luna-installed`, `git -C ${installed} reset --keep ${c040}`]);
    assert.match(undo.notes.join("\n"), /npm ci/);
    const outcome = await mod.runPlan({ exec }, cwd, undo.steps);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.failed));
    assert.equal(git(installed, "rev-parse", "--abbrev-ref", "HEAD"), "luna-installed");
    assert.equal(git(installed, "rev-parse", "HEAD"), c040);
  },

  "nothing newer on any ref is a plain refusal": async () => {
    register(installed);
    git(installed, "fetch", "-q", "origin", TRUNK);
    git(installed, "checkout", "-q", "--detach", cTrunk);
    try {
      const report = await check();
      assert.equal(report.kit.available, false);
      assert.equal(report.offline, false);
      for (const ref of [undefined, "trunk", "next"] as const) {
        const plan = mod.planUpdate(report, "kit", null, mod.runGit, ref);
        assert.equal(plan.steps.length, 0, String(ref));
        assert.match(plan.notes.join("\n"), /already contains .*nothing newer.*nothing remains to run/, String(ref));
      }
    } finally {
      git(installed, "checkout", "-q", "luna-installed");
    }
  },

  "uncommitted changes to tracked files refuse the move and name the commands left": async () => {
    register(installed);
    const pkg = path.join(installed, "package.json");
    const before = fs.readFileSync(pkg, "utf8");
    fs.writeFileSync(path.join(installed, "scratch.txt"), "untracked files do not block\n");
    try {
      const clean = await check();
      assert.equal(clean.kit.localMove?.refusal, null, "an untracked file is not a dirty tree");
      fs.writeFileSync(pkg, before.replace("0.4.0", "0.4.0-local"));
      const report = await check();
      const refusal = report.kit.localMove?.refusal ?? "";
      assert.match(refusal, /uncommitted changes to tracked files/);
      assert.ok(refusal.includes(`git -C "${installed}" status`), refusal);
      assert.ok(refusal.includes(`git -C "${installed}" checkout --no-overwrite-ignore --detach ${c050}`), refusal);
      assert.ok(refusal.includes("npm ci"), refusal);
      assert.ok(refusal.includes("--mode local"), refusal);
      // Second-round finding 4: a newer release whose move is refused is still an update, with the reason, never "up to date".
      assert.equal(report.kit.available, true);
      assert.match(mod.summaryLine(report), /Updates available: Luna 0\.4\.0\S* → .*cannot be applied yet: .*uncommitted changes/);
      assert.doesNotMatch(mod.summaryLine(report), /up to date/);
      assert.match(mod.formatReport(report), /uncommitted changes to tracked files/);
      assert.equal(mod.sessionStartNotice(report).setStatus, true);
      for (const what of ["kit", "all"] as const) {
        const plan = mod.planUpdate(report, what);
        assert.equal(plan.steps.length, 0, what);
        assert.match(plan.notes.join("\n"), /uncommitted changes/, what);
      }
      assert.equal(fs.readFileSync(pkg, "utf8"), before.replace("0.4.0", "0.4.0-local"), "the change is left alone");
    } finally {
      fs.writeFileSync(pkg, before);
      fs.rmSync(path.join(installed, "scratch.txt"), { force: true });
    }
  },

  "a retired private origin is never contacted; no origin and an unreachable origin are refused": async () => {
    register(installed);
    const url = git(installed, "remote", "get-url", "origin");
    try {
      // Finding 2: every scp form (any user, or none) and ssh:// with a port is recognised as the retired host.
      for (const retired of [LEGACY_ORIGIN, "deploy@legacy.example.invalid:lab/pi-system.git", "legacy.example.invalid:lab/pi-system.git", "ssh://git@legacy.example.invalid:2222/lab/pi-system.git"]) {
        git(installed, "remote", "set-url", "origin", retired);
        const g = recordingGit();
        const legacy = await check(g.git);
        assert.equal(legacy.kit.legacyOrigin, true, retired);
        assert.equal(g.calls.some((c) => c.includes("ls-remote") || c.includes("fetch")), false, `${retired}: the retired remote is never contacted`);
        assert.equal(mod.planUpdate(legacy, "kit").steps.length, 0);
        assert.match(mod.planUpdate(legacy, "kit").notes.join("\n"), /retired private source/);
      }
      // An origin that is neither a parseable address nor a local path is not contacted either (fail closed).
      git(installed, "remote", "set-url", "origin", "https://bad host/luna.git");
      const g = recordingGit();
      const unknown = await check(g.git);
      assert.equal(unknown.kit.originBlocked, true);
      assert.equal(g.calls.some((c) => c.includes("ls-remote") || c.includes("fetch")), false, "an unrecognised origin is never contacted");
      assert.equal(mod.planUpdate(unknown, "kit").steps.length, 0);
      assert.match(mod.planUpdate(unknown, "kit").notes.join("\n"), /not contacted/);
      for (const local of ["/srv/luna.git", "../luna", "luna", "C:\\src\\luna", "file:///srv/luna.git"]) assert.equal(mod.classifyRemote(local), "ok", local);
      // Second-round finding 3: well-formed URLs and scp addresses with one path segment (or many) are ordinary remotes.
      for (const good of ["https://git.example.org/luna.git", "http://host.example/luna.git", "ssh://git@host.example/luna.git", "git+ssh://git@host.example/luna.git", "ssh://git@host.example:2222/luna.git", "git://host.example/luna", "https://host.example", "git@host.example:luna.git", "host.example:luna.git", "example.invalid:onlyone", "https://github.com/SATUNIX/luna.git"]) assert.equal(mod.classifyRemote(good), "ok", good);
      for (const retired of [LEGACY_ORIGIN, "git@legacy.example.invalid:lab/pi-system.git", "deploy@legacy.example.invalid:lab/pi-system", "legacy.example.invalid:lab/pi-system.git", "ssh://git@legacy.example.invalid:2222/lab/pi-system.git", "git+ssh://deploy@LEGACY.example.invalid/lab/pi-system.git", "ssh://git@legacy.example.invalid/root/pi-system"]) assert.equal(mod.classifyRemote(retired), "legacy", retired);
      for (const bad of ["https://bad host/luna.git", "ssh://", "https://:443/luna.git"]) assert.equal(mod.classifyRemote(bad), "unknown", bad);
      // Third-round findings 2 and 3: a transport::address form and a malformed escape fail closed; a trailing dot or
      // upper case does not hide the retired host.
      for (const bad of ["https::https://legacy.example.invalid/lab/pi-system.git", "ext::ssh legacy.example.invalid %S", "https://legacy.example.invalid/lab/%E0%A4%A", "https://host.example/%zz"]) assert.equal(mod.classifyRemote(bad), "unknown", bad);
      for (const retired of ["https://legacy.example.invalid./lab/pi-system.git", "git@legacy.example.invalid.:lab/pi-system.git", "legacy.example.invalid.:lab/pi-system", "https://LEGACY.Example.Invalid./lab/pi-system.git"]) assert.equal(mod.classifyRemote(retired), "legacy", retired);
      for (const transport of ["https::https://legacy.example.invalid/lab/pi-system.git", "https://legacy.example.invalid./lab/pi-system.git", "https://host.example/%zz"]) {
        git(installed, "remote", "set-url", "origin", transport);
        const tg = recordingGit();
        const report = await check(tg.git);
        assert.ok(report.kit.legacyOrigin === true || report.kit.originBlocked === true, transport);
        assert.equal(tg.calls.some((c) => c.includes("ls-remote") || c.includes("fetch")), false, `${transport}: not contacted`);
        assert.equal(mod.planUpdate(report, "kit").steps.length, 0, transport);
      }

      git(installed, "remote", "set-url", "origin", path.join(scratch, "missing.git"));
      const unreachable = await check();
      assert.equal(unreachable.offline, true);
      assert.match(unreachable.kit.localMove?.refusal ?? "", /could not reach origin/);
      assert.ok((unreachable.kit.localMove?.refusal ?? "").includes(`git -C "${installed}" ls-remote origin`));
      assert.doesNotMatch(mod.summaryLine(unreachable), /Everything is up to date/);
      assert.equal(mod.planUpdate(unreachable, "kit").steps.length, 0);

      git(installed, "remote", "remove", "origin");
      const none = await check();
      assert.equal(none.offline, true);
      assert.match(none.kit.localMove?.refusal ?? "", /no origin remote/);
      assert.ok((none.kit.localMove?.refusal ?? "").includes(`git -C "${installed}" remote add origin`));
      assert.match(mod.planUpdate(none, "all").notes.join("\n"), /no origin remote/);
      assert.equal(mod.planUpdate(none, "all").steps.length, 0);
    } finally {
      try { git(installed, "remote", "remove", "origin"); } catch { /* already removed */ }
      git(installed, "remote", "add", "origin", url);
    }
  },

  "a branch with a configured upstream keeps the fast-forward pull, whatever the upstream is called": async () => {
    register(tracking);
    const report = await check();
    assert.equal(report.kit.localMove, undefined);
    assert.equal(report.kit.available, true);
    const lines = argv(mod.planUpdate(report, "kit").steps);
    assert.equal(nth(lines, 0), `git -C ${tracking} pull --ff-only`);
    // Third-round finding 5: the note says when a ref applies.
    const refNote = mod.planUpdate(report, "kit", null, mod.runGit, "trunk").notes.join("\n");
    assert.match(refNote, /is on a branch with a configured upstream, so \/update kit pulls it \(fast-forward only\)\. A ref \(latest, next, trunk\) applies only to a detached checkout or a branch with no upstream\./);
    assert.doesNotMatch(refNote, /of its name/);
    // Finding 4: `work` tracking origin/main is still pulled, and checked against origin's main.
    git(tracking, "checkout", "-q", "-b", "work", "--track", `origin/${MAIN}`);
    try {
      const work = await check();
      assert.equal(work.kit.localMove, undefined, "a differently named upstream keeps the pull path");
      assert.equal(work.kit.available, true);
      assert.equal(work.kit.target, `${MAIN}@${c050.slice(0, 7)}`);
      assert.equal(nth(argv(mod.planUpdate(work, "kit").steps), 0), `git -C ${tracking} pull --ff-only`);
    } finally {
      git(tracking, "checkout", "-q", MAIN);
      git(tracking, "branch", "-q", "-D", "work");
    }
    // A branch with no upstream configured is moved instead, even when origin has a branch of its name.
    git(tracking, "branch", "-q", "--unset-upstream");
    try {
      const untracked = await check();
      assert.ok(untracked.kit.localMove, "no upstream: the move path");
    } finally {
      git(tracking, "branch", "-q", `--set-upstream-to=origin/${MAIN}`);
    }
  },

  "an operation in progress refuses the move, naming it": async () => {
    register(installed);
    git(installed, "checkout", "-q", "-b", "rb", c040);
    try {
      for (const name of ["a", "b"]) {
        fs.writeFileSync(path.join(installed, `${name}.txt`), `${name}\n`);
        git(installed, "add", `${name}.txt`);
        git(installed, "commit", "-q", "-m", name);
      }
      // Finding 1: an interactive rebase stopped at an edit leaves a clean index, so the dirty check alone passes.
      const restoreEditor = setEnv("GIT_SEQUENCE_EDITOR", "sed -i -e s/^pick/edit/");
      try { git(installed, "rebase", "-q", "-i", c040); } finally { restoreEditor(); }
      assert.equal(git(installed, "status", "--porcelain", "--untracked-files=no"), "");
      const rebasing = await check();
      assert.match(rebasing.kit.localMove?.refusal ?? "", /a rebase is in progress.*rebase --abort/);
      assert.equal(rebasing.kit.available, true);
      assert.match(mod.summaryLine(rebasing), /cannot be applied yet: a rebase is in progress/);
      assert.equal(mod.planUpdate(rebasing, "kit").steps.length, 0);
      git(installed, "rebase", "--abort");
      git(installed, "bisect", "start");
      const bisecting = await check();
      assert.match(bisecting.kit.localMove?.refusal ?? "", /a bisect is in progress.*bisect reset/);
      git(installed, "bisect", "reset");
      // A multi-commit cherry-pick or revert keeps its remaining commits in the sequencer state between picks.
      const sequencer = path.resolve(installed, git(installed, "rev-parse", "--git-path", "sequencer"));
      fs.mkdirSync(sequencer, { recursive: true });
      try {
        assert.match((await check()).kit.localMove?.refusal ?? "", /a multi-commit cherry-pick or revert is in progress/);
      } finally {
        fs.rmSync(sequencer, { recursive: true, force: true });
      }
      assert.equal((await check()).kit.localMove?.refusal, null);
      // A branch that shares its name with a tag is recorded by its name, not as heads/<name>.
      git(installed, "checkout", "-q", "-b", "v0.4.0", c040);
      try {
        assert.equal((await check()).kit.branch, "v0.4.0");
      } finally {
        git(installed, "checkout", "-q", "rb");
        git(installed, "branch", "-q", "-D", "v0.4.0");
      }
    } finally {
      try { git(installed, "rebase", "--abort"); } catch { /* none in progress */ }
      git(installed, "checkout", "-q", "luna-installed");
      git(installed, "branch", "-q", "-D", "rb");
    }
  },

  "a release at or below the installed version is not an update, and a branch head off the checkout's line is never moved to silently": async () => {
    // Finding 3: a clone of main only (trunk's commit absent), and a branch at 0.7.0 that v0.5.0 is not an ancestor of.
    const sideClone = path.join(scratch, "side-clone");
    execFileSync("git", ["clone", "-q", "--no-local", "--single-branch", "--branch", MAIN, origin, sideClone]);
    const side = path.join(scratch, "side");
    git(sideClone, "worktree", "add", "-q", "-b", "side", side, c040);
    commit(side, "0.7.0");
    register(side);
    const report = await check();
    const move = report.kit.localMove;
    assert.ok(move);
    assert.equal(move.refs.latest?.newer, false, "v0.5.0 is below the installed 0.7.0: a downgrade");
    assert.match(move.refs.latest?.behind ?? "", /not above the installed version 0\.7\.0/);
    assert.equal(report.kit.available, false, "no start-up notice for a downgrade");
    assert.equal(mod.planUpdate(report, "kit").steps.length, 0);
    assert.match(mod.planUpdate(report, "kit").notes.join("\n"), /not above the installed version/);
    // trunk's commit is not here, so it is offered; the fetch step finds it is off this line and stops before the checkout.
    assert.equal(move.refs.trunk?.newer, true);
    const head = git(side, "rev-parse", "HEAD");
    const outcome = await mod.runPlan({ exec }, cwd, mod.planUpdate(report, "kit", null, mod.runGit, "trunk").steps);
    assert.equal(outcome.ok, false);
    assert.match(outcome.failed?.reason ?? "", /does not descend from the checkout's commit.*backwards or sideways/);
    assert.equal(git(side, "rev-parse", "HEAD"), head, "the checkout was not moved");
    // Now the commit is here: trunk is reported as off this line and not offered.
    const known = await check();
    assert.equal(known.kit.localMove?.refs.trunk?.newer, false);
    assert.match(mod.planUpdate(known, "kit", null, mod.runGit, "trunk").notes.join("\n"), /does not descend from the checkout's commit/);
  },

  "/update undo never rewinds a branch the update did not move, and never drops commits only that branch holds": async () => {
    const journalMod = await loadModule<typeof Journal>("extensions/kit-update/journal.ts");
    const pi = fakePi();
    pi.api.exec = exec;
    mod.default(pi.api);
    const handler = pi.commands.get("update").handler;
    const notes: string[] = [];
    const ctx = { hasUI: false, cwd, ui: { notify: (m: string) => notes.push(m), setStatus() {}, confirm: async () => true, select: async () => undefined }, reload: async () => {} };
    const writeUndoJournal = (root: string, commitId: string, branch: string | null, localUpdate: "pull" | "move"): void =>
      writeJson(journalMod.journalPath(), { version: 1, createdAt: "", steps: [], pi: "0.87.1", profile: "balanced", files: [], complete: true, kit: { kind: "local", source: root, version: "0.4.0", commit: commitId, channel: null, root, scope: "user", branch, localUpdate } });
    const stderr = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = (chunk: string | Uint8Array): boolean => { captured.push(String(chunk)); return true; };
    register(installed);
    git(installed, "fetch", "-q", "origin", `refs/tags/${TAG_PREFIX}0.5.0:refs/tags/${TAG_PREFIX}0.5.0`);
    try {
      // Finding 1: a detached move from branch luna-installed; the operator then commits on that branch. Undo only checks it out.
      git(installed, "checkout", "-q", "luna-installed");
      fs.writeFileSync(path.join(installed, "mine.txt"), "mine\n");
      git(installed, "add", "mine.txt");
      git(installed, "commit", "-q", "-m", "operator work on the branch");
      const mine = git(installed, "rev-parse", "HEAD");
      git(installed, "checkout", "-q", "--detach", c050);
      writeUndoJournal(installed, c040, "luna-installed", "move");
      git(installed, "checkout", "-q", "luna-installed");
      await handler("undo", ctx);
      assert.equal(git(installed, "rev-parse", "--abbrev-ref", "HEAD"), "luna-installed");
      assert.equal(git(installed, "rev-parse", "luna-installed"), mine, "the branch keeps the operator's commit");

      // The same state journalled as a pull: resetting the branch would drop a commit only it holds, so undo refuses.
      writeUndoJournal(installed, c040, "luna-installed", "pull");
      captured.length = 0;
      await handler("undo", ctx);
      assert.match(captured.join(""), /only it holds.*branch luna-rescue luna-installed/s);
      assert.equal(git(installed, "rev-parse", "luna-installed"), mine);

      // Finding 2: a move that started detached at c050 goes back by detaching there; the branch now checked out is not reset.
      writeUndoJournal(installed, c050, null, "move");
      await handler("undo", ctx);
      assert.equal(git(installed, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
      assert.equal(git(installed, "rev-parse", "HEAD"), c050);
      assert.equal(git(installed, "rev-parse", "luna-installed"), mine, "the unrelated branch is untouched");
    } finally {
      process.stderr.write = stderr;
      fs.rmSync(journalMod.journalPath(), { force: true });
      git(installed, "checkout", "-q", "--detach", c040);
      git(installed, "branch", "-q", "-f", "luna-installed", c040);
      git(installed, "checkout", "-q", "luna-installed");
    }

    // A pull forward is still undone: its commits came from the remote, so the reset drops nothing of the operator's.
    register(tracking);
    const before = git(tracking, "rev-parse", "HEAD");
    await handler("kit", ctx);
    assert.notEqual(git(tracking, "rev-parse", "HEAD"), before, "the pull moved main forward");
    await handler("undo", ctx);
    assert.equal(git(tracking, "rev-parse", "HEAD"), before, "undo returned main to where the pull started");
    assert.equal(git(tracking, "rev-parse", "--abbrev-ref", "HEAD"), MAIN);
  },

  "a journal from before the branch was recorded is undone as before (reset --keep)": async () => {
    // Third-round finding 4: no branch key and no localUpdate means the old undo, not a detach.
    const journalMod = await loadModule<typeof Journal>("extensions/kit-update/journal.ts");
    const file = journalMod.journalPath();
    const old = { version: 1, createdAt: "", steps: [], pi: "0.87.1", profile: "balanced", files: [], complete: true, kit: { kind: "local", source: installed, version: "0.4.0", commit: c040, channel: null, root: installed, scope: "user" } };
    writeJson(file, old);
    try {
      const journal = journalMod.readJournal();
      assert.ok(journal);
      assert.equal("branch" in journal.kit, false, "absent stays absent");
      assert.deepEqual(argv(mod.planUndo(journal, cwd).steps), [`git -C ${installed} reset --keep ${c040}`]);
      writeJson(file, { ...old, kit: { ...old.kit, branch: null } });
      assert.equal(journalMod.readJournal()?.kit.branch, null, "a recorded null stays null");
      writeJson(file, { ...old, kit: { ...old.kit, branch: "-f" } });
      assert.equal(journalMod.readJournal()?.kit.branch, null, "an invalid recorded branch becomes null");
    } finally {
      fs.rmSync(file, { force: true });
    }
  },

  "a kit copy inside another repository is never fetched, checked out or pulled": async () => {
    // Third-round finding 1: proj/vendor/luna has no .git of its own; proj is on a branch with no upstream and an origin with a newer release.
    const proj = path.join(scratch, "proj");
    fs.mkdirSync(proj);
    git(proj, "init", "-q", "-b", "work");
    fs.writeFileSync(path.join(proj, "app.txt"), "app\n");
    writeKit(path.join(proj, "vendor", "luna"), "0.4.0");
    git(proj, "add", "-A");
    git(proj, "commit", "-q", "-m", "project with a vendored Luna");
    git(proj, "remote", "add", "origin", origin);
    const projHead = git(proj, "rev-parse", "HEAD");
    const vendored = path.join(proj, "vendor", "luna");
    register(vendored);
    const g = recordingGit();
    const report = await check(g.git);
    assert.equal(report.kit.kind, "local");
    assert.equal(report.kit.notOwnCheckout, true);
    assert.equal(report.kit.localMove, undefined);
    assert.equal(report.kit.available, false);
    assert.equal(report.kit.commit, null);
    assert.equal(report.offline, true);
    assert.match(report.kit.note ?? "", /not the top level of its own git checkout \(it lies inside .*proj\)/);
    assert.equal(g.calls.some((c) => c.includes("ls-remote") || c.includes("fetch")), false, "the enclosing repository's origin is not contacted");
    for (const what of ["kit", "all"] as const) {
      const plan = mod.planUpdate(report, what);
      assert.equal(plan.steps.some((s) => s.command === "git"), false, `${what}: no git step`);
      await mod.runPlan({ exec }, cwd, plan.steps);
    }
    assert.equal(mod.planUpdate(report, "kit").steps.length, 0);
    assert.equal(git(proj, "rev-parse", "HEAD"), projHead);
    assert.equal(git(proj, "rev-parse", "--abbrev-ref", "HEAD"), "work");
    assert.equal(git(proj, "status", "--porcelain"), "");
    assert.equal(git(proj, "tag", "--list"), "", "no tag was fetched into the enclosing repository");
  },

  "journal fields that reach git arguments are validated": async () => {
    // Finding 7: a branch such as -f must never reach git checkout as an option; a commit must be a commit id.
    const journalMod = await loadModule<typeof Journal>("extensions/kit-update/journal.ts");
    for (const bad of ["-f", "--force", "a..b", "x.lock", "a/.b", "@{u}", "@", "a b", "a~1", "a:b", "/a", "a/", "a//b", "a."]) assert.equal(journalMod.branchName(bad), null, bad);
    for (const good of ["luna-installed", "feature/x", "v1.2"]) assert.equal(journalMod.branchName(good), good, good);
    const file = journalMod.journalPath();
    writeJson(file, { version: 1, createdAt: "", steps: [], pi: "0.87.1", profile: null, files: [], complete: true, kit: { kind: "local", source: installed, version: "0.4.0", commit: "--hard", channel: null, root: installed, scope: "user", branch: "-f" } });
    try {
      const journal = journalMod.readJournal();
      assert.ok(journal);
      assert.equal(journal.kit.branch, null);
      assert.equal(journal.kit.commit, null);
      const undo = mod.planUndo(journal, cwd);
      assert.equal(undo.steps.length, 0, "no git step from an untrusted journal");
      writeJson(file, { version: 1, createdAt: "", steps: [], pi: "0.87.1", profile: null, files: [], complete: true, kit: { kind: "local", source: installed, version: "0.4.0", commit: c040, channel: null, root: installed, scope: "user", branch: "luna-installed" } });
      const valid = journalMod.readJournal();
      assert.equal(valid?.kit.branch, "luna-installed");
      assert.equal(valid?.kit.commit, c040);
    } finally {
      fs.rmSync(file, { force: true });
    }
  },
};

function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  assert.ok(item !== undefined, `no item ${index} in ${JSON.stringify(list)}`);
  return item;
}

let failed = 0;
try {
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  OK: ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL: ${name}\n    ${String((error instanceof Error && error.stack) || error)}`);
    }
  }
} finally {
  for (const restore of restoreEnv.reverse()) restore();
  restoreKitEnv();
  rmWorkspace(scratch);
}
if (failed) {
  console.error(`\n[kit-update-local-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[kit-update-local-smoke] all ${Object.keys(tests).length} checks passed`);
