#!/usr/bin/env node
/**
 * User profiles (packages/core/shared/user-profile.ts, AUTHORITY): an operator's own
 * <agent dir>/pi-kit/profiles/<name>.json extends a shipped profile or blank.
 *   - parsing: unknown keys, a name that is not the file's, a shipped name, an unknown base and a
 *     removal of a mandatory protection or a required extension are refused whole;
 *   - resolution: the base's gate (firewall, security level, settings) is inherited unchanged, lite's
 *     `only` lists lose excluded names, blank loads exactly the required extensions and protections;
 *   - creation never overwrites and writes 0600 in a 0700 directory;
 *   - the real installer: a profile created from each base and from blank switches, a failure late
 *     in a switch rolls every file back, and a profile that removes the firewall is refused before
 *     anything is written; profile-check --user refuses it too;
 *   - the /profile command lists user profiles and resolves them with the same code.
 * Hermetic: temporary agent directories and a stub `pi`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakePi, isolateKitEnv, loadModule } from "../packages/core/eval/harness.ts";
import { array, object, optional, parseJsonAs, string, union, unknownValue } from "../packages/core/lib/guard.ts";
import { readRequiredProfileExtensions } from "../packages/core/lib/distribution.ts";
import { listAllProfiles, listProfiles, loadAnyProfile, MANDATORY_PROTECTION_EXTENSIONS } from "../packages/core/lib/profiles.ts";
import { userProfileCoverageProblems } from "../packages/core/lib/protection-coverage.ts";
import { goalCoreProblem } from "../packages/core/lib/headless.ts";
import { BLANK_INCLUDE, createUserProfile, loadUserProfile, MANDATORY_PROTECTIONS, parseUserProfile, resolveUserProfile, type UserProfile } from "../packages/core/shared/user-profile.ts";
import { listProfiles as commandProfiles, profileDefinition } from "../packages/extensions/src/session-helpers/index.ts";
import type * as SessionHelpers from "../packages/extensions/src/session-helpers/index.ts";

/** session-helpers as the harness loads it: registered on a fake pi. */
type SessionHelpersView = Omit<typeof SessionHelpers, "default"> & { default: (api: ReturnType<typeof fakePi>["api"]) => void };

const restoreEnv = isolateKitEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "packages", "core", "install.ts");
const PROFILES = path.join(ROOT, "packages", "kit", "profiles");
const BASES = listProfiles(PROFILES);
const REQUIRED = readRequiredProfileExtensions();
const readBase = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(PROFILES, `${name}.json`), "utf8"));
const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const problemsOf = (value: unknown, stem = "mine"): string[] => {
  const r = parseUserProfile(value, stem, BASES, REQUIRED);
  return r.ok ? [] : r.problems;
};
const profile = (over: Partial<UserProfile> = {}): UserProfile => ({ name: "mine", description: "", extends: "balanced", extensions: { add: [], remove: [] }, skills: { exclude: [] }, prompts: { exclude: [] }, ...over });

try {
  // --- parsing -------------------------------------------------------------------------------------
  assert.deepEqual([...MANDATORY_PROTECTIONS], [...MANDATORY_PROTECTION_EXTENSIONS], "one list of mandatory protections");
  assert.deepEqual([...BLANK_INCLUDE].sort(), [...new Set([...REQUIRED, ...MANDATORY_PROTECTIONS])].sort(), "blank loads exactly the required extensions and the protections");
  assert.deepEqual(problemsOf({ name: "mine", extends: "balanced", extensions: { add: ["todo"], remove: ["notify"] } }), []);
  assert.deepEqual(problemsOf({ name: "mine", extends: "blank" }), []);
  for (const protection of MANDATORY_PROTECTIONS) {
    assert.match(problemsOf({ name: "mine", extends: "balanced", extensions: { remove: [protection] } }).join("\n"), new RegExp(`mandatory protection "${protection}"`), `removing ${protection} is refused`);
  }
  assert.match(problemsOf({ name: "mine", extends: "balanced", extensions: { remove: ["delegation-guard"] } }).join("\n"), /"delegation-guard", which every install loads/);
  assert.match(problemsOf({ name: "mine", extends: "balanced", firewall: { policy: "coding" } }).join("\n"), /"firewall" is not a known field/, "a user profile cannot set the gate");
  assert.match(problemsOf({ name: "mine", extends: "balanced", securityLevel: "balanced" }).join("\n"), /"securityLevel" is not a known field/);
  assert.match(problemsOf({ name: "mine", extends: "balanced", extensions: { delete: [] } }).join("\n"), /extensions\.delete is not a known field/);
  assert.match(problemsOf({ name: "other", extends: "balanced" }).join("\n"), /"name" must be "mine"/);
  assert.match(problemsOf({ name: "balanced", extends: "lite" }, "balanced").join("\n"), /is a shipped profile/);
  assert.match(problemsOf({ name: "blank", extends: "lite" }, "blank").join("\n"), /is not a profile name/);
  assert.match(problemsOf({ name: "Mine", extends: "lite" }, "Mine").join("\n"), /is not a profile name/);
  assert.match(problemsOf({ name: "mine", extends: "quick" }).join("\n"), /"extends" must name a shipped profile/);
  assert.match(problemsOf({ name: "mine", extends: "balanced", extensions: { add: "todo" } }).join("\n"), /extensions\.add must be a list of names/);
  assert.match(problemsOf({ name: "mine", extends: "balanced", extensions: { add: ["todo", 3] } }).join("\n"), /extensions\.add must be a list of names/);
  assert.match(problemsOf({ name: "mine", extends: "balanced", skills: { exclude: [" "] } }).join("\n"), /skills\.exclude must be a list of names/);
  assert.match(problemsOf([]).join("\n"), /must be a JSON object/);
  for (const bad of ["../third_party/x", "src/goal-core", "..", "Tool-Firewall"]) {
    assert.match(problemsOf({ name: "mine", extends: "balanced", extensions: { add: [bad] } }).join("\n"), /extensions\.add names .*never a path/, `an added name is a name, not a path: ${bad}`);
  }
  assert.match(problemsOf({ name: "mine", extends: "balanced", skills: { exclude: ["../x"] } }).join("\n"), /skills\.exclude names/);
  console.log("  OK: parsing refuses unknown keys, a gate field, a wrong or shipped name, an unknown base and protection removals");

  // --- resolution ----------------------------------------------------------------------------------
  const engagement = resolveUserProfile(profile({ extends: "engagement" }), readBase("engagement"));
  const engagementBase = readBase("engagement");
  assert.ok(engagementBase !== null && typeof engagementBase === "object" && "firewall" in engagementBase);
  assert.deepEqual(engagement.firewall, engagementBase.firewall, "the base's firewall is inherited");
  assert.equal(engagement.securityLevel, "guarded");
  const engagementNoLevel = Object.fromEntries(Object.entries(engagementBase).filter(([key]) => key !== "securityLevel"));
  assert.equal(resolveUserProfile(profile({ extends: "engagement" }), engagementNoLevel).securityLevel, "guarded", "engagement's by-name security default is written out, not lost with the name");
  assert.equal(resolveUserProfile(profile({ extends: "balanced" }), { include: [] }).securityLevel, "balanced");
  const lite = resolveUserProfile(profile({ extends: "lite", skills: { exclude: ["patch-hygiene"] }, prompts: { exclude: ["code-plan"] } }), readBase("lite"));
  assert.ok(lite.settings !== undefined, "lite's settings block is inherited");
  assert.deepEqual(lite.skills, { only: ["coding-agent-workflow", "codebase-navigation", "task-decomposition", "verification-loop", "recovery-debugging", "mcp-tool-use", "small-model-execution", "self-reflection-and-recovery", "context-management"] }, "an excluded skill leaves lite's only list");
  assert.deepEqual(lite.prompts, { only: ["code-orient", "code-verify", "code-compact"] });
  const balanced = resolveUserProfile(profile({ skills: { exclude: ["patch-hygiene"] }, extensions: { add: ["todo", "todo"], remove: ["notify"] } }), readBase("balanced"));
  assert.ok(Array.isArray(balanced.include) && !balanced.include.includes("notify") && balanced.include.filter((n) => n === "todo").length === 1);
  assert.ok(typeof balanced.skills === "object" && balanced.skills !== null && "exclude" in balanced.skills && Array.isArray(balanced.skills.exclude) && balanced.skills.exclude.includes("patch-hygiene"));
  const blank = resolveUserProfile(profile({ extends: "blank", extensions: { add: ["todo"], remove: [] } }), readBase("balanced"));
  assert.deepEqual(blank.include, [...BLANK_INCLUDE, "todo"], "blank ignores any base definition");
  assert.equal(blank.firewall, undefined, "blank takes the default gate");
  assert.equal(blank.securityLevel, "balanced");
  assert.deepEqual(userProfileCoverageProblems("lite", ["tool-firewall", "protected-paths"]), [], "lite's recorded secret-guard exemption carries over");
  assert.deepEqual(userProfileCoverageProblems("lite", ["tool-firewall", "protected-paths", "secret-guard"]), [], "adding it back is not a stale exemption");
  assert.match(userProfileCoverageProblems("balanced", ["tool-firewall", "protected-paths"]).join("\n"), /'secret-guard' is missing/, "balanced has no exemption to inherit");
  assert.match(userProfileCoverageProblems("blank", ["tool-firewall", "protected-paths"]).join("\n"), /'secret-guard' is missing/);
  console.log("  OK: resolution inherits the base's gate; lite's only lists, blank and coverage exemptions");

  // --- creation ------------------------------------------------------------------------------------
  {
    const dir = path.join(tmp("pi-kit-uprof-"), "pi-kit", "profiles");
    const mask = process.umask(0o022); // so the modes below are the library's, not a strict umask's
    const made = createUserProfile(dir, "mine", "lite", BASES);
    process.umask(mask);
    assert.ok(made.ok);
    assert.equal(fs.statSync(made.file).mode & 0o777, 0o600, "a created profile is 0600");
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "in a 0700 directory");
    const again = createUserProfile(dir, "mine", "balanced", BASES);
    assert.ok(!again.ok && /already exists/.test(again.problem), "creation never overwrites");
    assert.ok(!createUserProfile(dir, "lite", "balanced", BASES).ok, "a shipped name is refused");
    assert.ok(!createUserProfile(dir, "x", "nope", BASES).ok, "an unknown base is refused");
    fs.symlinkSync(path.join(dir, "mine.json"), path.join(dir, "linked.json"));
    assert.ok(!createUserProfile(dir, "linked", "balanced", BASES).ok, "a planted link is not followed");
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  }
  console.log("  OK: creation never overwrites, refuses shipped names and links, 0600 in 0700");

  // --- the real installer --------------------------------------------------------------------------
  const AgentSettings = object({ packages: array(union(string(), object({ source: string(), extensions: optional(array(string())) }))) });
  const Marker = object({ profile: unknownValue() });
  const Firewall = object({ policy: unknownValue(), mode: unknownValue() });
  interface World { dir: string; agent: string; bin: string; profiles: string }
  const world = (): World => {
    const dir = tmp("pi-kit-uprof-");
    const agent = path.join(dir, "agent");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(path.join(agent, "pi-kit"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "pi"), '#!/bin/sh\ncase "$*" in *pi-readseek*) [ -n "$FAIL_READSEEK" ] && exit 1;; esac\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [ROOT] }, null, 2));
    return { dir, agent, bin, profiles: path.join(agent, "pi-kit", "profiles") };
  };
  const install = (w: World, name: string, extra: string[] = [], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [INSTALL, "--profile", name, "--yes", "--settings-only", "--mode", "local", ...extra], {
      cwd: w.dir, encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: w.agent, PI_LEAN_CTX_BIN: path.join(w.dir, "no-lean-ctx"), PATH: `${w.bin}${path.delimiter}${process.env.PATH ?? ""}`, ...env },
    });
  const watched = (w: World): string[] => ["settings.json", ".pi-kit.json", "pi-kit/firewall.json", "pi-kit/security.json", "pi-kit/overrides.json", "pi-kit/profile-settings.json", ".env"].map((f) => path.join(w.agent, f));
  const digest = (w: World) => Object.fromEntries(watched(w).map((f) => [f, fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null]));
  const inKit = (n: string): boolean => fs.existsSync(path.join(ROOT, "packages", "extensions", "src", n, "index.ts")) || fs.existsSync(path.join(ROOT, "packages", "extensions", "third_party", n, "index.ts"));
  const loaded = (w: World): string[] => {
    const settings = parseJsonAs(AgentSettings, fs.readFileSync(path.join(w.agent, "settings.json"), "utf8"), "settings.json");
    const entry = settings.packages.find((p) => (typeof p === "string" ? p : p.source) === ROOT);
    assert.ok(entry !== undefined && typeof entry !== "string" && entry.extensions !== undefined, "the kit entry lists its extensions");
    return entry.extensions.map((e) => e.match(/\/([^/]+)\/index\.ts$/)?.[1] ?? e).sort();
  };
  const write = (w: World, name: string, value: object): void => {
    fs.mkdirSync(w.profiles, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(w.profiles, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
  };

  {
    const w = world();
    try {
      for (const base of [...BASES, "blank"]) {
        const name = `my-${base}`;
        const made = createUserProfile(w.profiles, name, base, BASES);
        assert.ok(made.ok, made.ok ? "" : made.problem);
        // Each one really differs from its base: drop one optional kit extension, or add one to blank.
        const baseInclude = base === "blank" ? [...BLANK_INCLUDE] : (loadAnyProfile(base, userProfileCoverageProblems, REQUIRED, PROFILES, w.profiles).include ?? []);
        const optional = baseInclude.find((n) => inKit(n) && !REQUIRED.includes(n) && !MANDATORY_PROTECTIONS.includes(n));
        const change: { add: string[]; remove: string[] } = base === "blank" ? { add: ["todo"], remove: [] } : { add: [], remove: optional ? [optional] : [] };
        write(w, name, { name, extends: base, extensions: change });
        const r = install(w, name, ["--no-externals"]);
        assert.equal(r.status, 0, `${name}: ${r.stdout}\n${r.stderr}`);
        const want = [...baseInclude.filter((n) => !change.remove.includes(n)), ...change.add].filter(inKit).sort();
        assert.deepEqual(loaded(w), [...new Set(want)], `${name} loads its base's extensions with its own change`);
        assert.equal(parseJsonAs(Marker, fs.readFileSync(path.join(w.agent, ".pi-kit.json"), "utf8")).profile, name, `the marker records ${name}`);
        const fw = parseJsonAs(Firewall, fs.readFileSync(path.join(w.agent, "pi-kit", "firewall.json"), "utf8"));
        const baseFw = base === "blank" ? {} : (loadAnyProfile(base, userProfileCoverageProblems, REQUIRED, PROFILES, w.profiles).firewall ?? {});
        assert.equal(fw.policy, baseFw.policy ?? "coding", `${name} keeps its base's firewall policy`);
      }
      // The last switch was to my-blank, which has no goal-core: `luna exec` refuses its limits.
      assert.match(goalCoreProblem(w.dir, w.agent) ?? "", /does not load goal-core/, "a blank profile does not silently void luna exec's limits");
      assert.equal(install(w, "my-balanced", ["--no-externals"]).status, 0);
      assert.equal(goalCoreProblem(w.dir, w.agent), null, "a profile that loads goal-core enforces them");
      assert.deepEqual(listAllProfiles(PROFILES, w.profiles), [...BASES, ...[...BASES, "blank"].map((b) => `my-${b}`).sort()], "shipped profiles first, then the operator's");
      console.log(`  OK: a profile created from each of ${BASES.join(", ")} and blank switches through the real installer`);

      // A failure late in a switch rolls every configuration file back.
      write(w, "my-long", { name: "my-long", extends: "long-horizon" });
      const before = digest(w);
      const failed = install(w, "my-long", [], { FAIL_READSEEK: "1" });
      assert.notEqual(failed.status, 0, "the injected companion failure fails the switch");
      assert.match(failed.stderr, /Rolled back/);
      assert.deepEqual(digest(w), before, "and every file is as it was");
      console.log("  OK: a failed switch to a user profile rolls back byte for byte");

      // A profile that removes any mandatory protection is refused before anything is written.
      for (const protection of MANDATORY_PROTECTIONS) {
        write(w, "no-guard", { name: "no-guard", extends: "balanced", extensions: { remove: [protection] } });
        const refusedGuard = install(w, "no-guard", ["--no-externals"]);
        assert.equal(refusedGuard.status, 1, refusedGuard.stderr);
        assert.match(refusedGuard.stderr, new RegExp(`FAIL: user profile "no-guard" is refused: .*mandatory protection "${protection}"`), `the installer refuses removing ${protection}`);
        assert.deepEqual(digest(w), before, "nothing was changed");
      }
      fs.rmSync(path.join(w.profiles, "no-guard.json"));
      write(w, "no-fw", { name: "no-fw", extends: "balanced", extensions: { remove: ["tool-firewall"] } });

      // --profile is a name, never a path: a JSON file elsewhere is not loaded as a shipped profile.
      const elsewhere = path.join(w.dir, "evil.json");
      fs.writeFileSync(elsewhere, JSON.stringify({ name: "evil", include: ["todo"] }));
      const traversal = install(w, path.relative(PROFILES, elsewhere).replace(/\.json$/, ""), ["--no-externals"]);
      assert.equal(traversal.status, 2, traversal.stderr);
      assert.match(traversal.stderr, /is not a profile name/);
      assert.deepEqual(digest(w), before, "nothing was changed");
      assert.throws(() => loadAnyProfile("../x", userProfileCoverageProblems, REQUIRED, PROFILES, w.profiles), /is not a profile name/);

      // An experimental extension needs an experimental base, at switch time too.
      write(w, "trial", { name: "trial", extends: "balanced", extensions: { add: ["mcp-router"] } });
      const trial = install(w, "trial", ["--no-externals"]);
      assert.equal(trial.status, 1, trial.stderr);
      assert.match(trial.stderr, /FAIL: user profile "trial" is refused: extensions\.add names the stub extension "mcp-router"/);
      assert.deepEqual(digest(w), before, "nothing was changed");
      fs.rmSync(path.join(w.profiles, "trial.json"));
      const check = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "profile-check.ts"), "--user", path.join(w.profiles, "no-fw.json")], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: w.agent } });
      assert.equal(check.status, 1, check.stdout);
      assert.match(check.stderr, /mandatory protection "tool-firewall"/, "profile-check --user refuses it too");
      const good = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "profile-check.ts"), "--user", path.join(w.profiles, "my-lite.json")], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: w.agent } });
      assert.equal(good.status, 0, `${good.stdout}\n${good.stderr}`);
      assert.match(good.stdout, /user profile: .*my-lite\.json[\s\S]*load: (\d+)\/\1 in-repo extensions registered cleanly[\s\S]*\[profile-check\] OK/, "a valid user profile passes profile-check, lite's exemption included");
      // Defence in depth, through the real coverage check: a base without a protection and without a
      // recorded exemption is refused, not only a `remove` of one.
      const shipped = path.join(w.dir, "shipped");
      fs.mkdirSync(shipped);
      const balancedDef = readBase("balanced");
      assert.ok(balancedDef !== null && typeof balancedDef === "object" && "include" in balancedDef && Array.isArray(balancedDef.include));
      fs.writeFileSync(path.join(shipped, "plain.json"), JSON.stringify({ ...balancedDef, name: "plain", include: balancedDef.include.filter((n) => n !== "secret-guard") }));
      write(w, "on-plain", { name: "on-plain", extends: "plain" });
      assert.throws(() => loadAnyProfile("on-plain", userProfileCoverageProblems, REQUIRED, shipped, w.profiles), /user profile "on-plain" is refused: mandatory protection 'secret-guard' is missing/);
      fs.rmSync(path.join(w.profiles, "on-plain.json"));

      // The reader: no links (file or directory), no file or directory others can write, a size cap.
      const reads = (name: string) => { const r = profileDefinitionCore(w, name); return r; };
      fs.symlinkSync(path.join(w.profiles, "my-lite.json"), path.join(w.profiles, "linked.json"));
      assert.match(reads("linked"), /linked\.json is a symbolic link/);
      fs.rmSync(path.join(w.profiles, "linked.json"));
      fs.linkSync(path.join(w.profiles, "my-lite.json"), path.join(w.profiles, "hard.json"));
      assert.match(reads("hard"), /hard\.json has more than one link/);
      fs.rmSync(path.join(w.profiles, "hard.json"));
      write(w, "loose", { name: "loose", extends: "balanced" });
      fs.chmodSync(path.join(w.profiles, "loose.json"), 0o620);
      assert.match(reads("loose"), /loose\.json is writable by its group or by everyone/);
      fs.rmSync(path.join(w.profiles, "loose.json"));
      fs.writeFileSync(path.join(w.profiles, "huge.json"), JSON.stringify({ name: "huge", extends: "balanced", description: "x".repeat(70 * 1024) }), { mode: 0o600 });
      assert.match(reads("huge"), /huge\.json is \d+ bytes; the limit is 65536/);
      fs.rmSync(path.join(w.profiles, "huge.json"));
      // A FIFO is refused without blocking (O_NONBLOCK, and it is never opened).
      assert.equal(spawnSync("mkfifo", [path.join(w.profiles, "pipe.json")]).status, 0);
      assert.match(reads("pipe"), /pipe\.json is not a regular file/);
      const fifoInstall = install(w, "pipe", ["--no-externals"]);
      assert.equal(fifoInstall.status, 1, fifoInstall.stderr);
      fs.rmSync(path.join(w.profiles, "pipe.json"));
      // The parent pi-kit/ directory is checked too.
      const piKit = path.dirname(w.profiles);
      fs.chmodSync(piKit, 0o770);
      assert.match(reads("my-lite"), /pi-kit is writable by its group or by everyone/, "a group-writable pi-kit/ is refused");
      fs.chmodSync(piKit, 0o700);
      fs.chmodSync(w.profiles, 0o770);
      assert.match(reads("my-lite"), /profiles is writable by its group or by everyone/);
      fs.chmodSync(w.profiles, 0o700);
      const real = path.join(w.dir, "real-profiles");
      fs.renameSync(w.profiles, real);
      fs.symlinkSync(real, w.profiles);
      assert.match(reads("my-lite"), /profiles is a symbolic link; user profiles are not read through one/);
      const viaLink = install(w, "my-lite", ["--no-externals"]);
      assert.equal(viaLink.status, 1, "the installer refuses a profile read through a linked directory");
      assert.deepEqual(digest(w), before);
      fs.rmSync(w.profiles);
      fs.renameSync(real, w.profiles);
      assert.equal(reads("my-lite"), "ok");
      console.log("  OK: removing any protection, a path as --profile, an experimental add, a base without coverage and unsafe reads are refused");

      // The /profile command reads the same files with the same code.
      process.env.PI_CODING_AGENT_DIR = w.agent;
      const names = commandProfiles(ROOT).map((p) => p.name);
      assert.ok(names.includes("my-blank") && names.includes("no-fw") && names.includes("balanced"));
      assert.match(commandProfiles(ROOT).find((p) => p.name === "my-lite")?.description ?? "", /^\(yours\)/);
      const def = profileDefinition(ROOT, "my-engagement");
      assert.ok(def !== null && "def" in def && def.user);
      assert.deepEqual(def.def, loadAnyProfileRaw(w, "my-engagement"), "the command and the installer resolve a user profile alike");
      const bad = profileDefinition(ROOT, "no-fw");
      assert.ok(bad !== null && "problems" in bad && /mandatory protection "tool-firewall"/.test(bad.problems.join("\n")), "the command refuses it before running the installer");
      assert.equal(profileDefinition(ROOT, "absent"), null);
      // The command itself: create writes a profile; a refused profile never reaches the installer.
      process.env.PI_KIT_ROOT = ROOT;
      const helpers = await loadModule<SessionHelpersView>("extensions/session-helpers/index.ts");
      const pi = fakePi();
      helpers.default(pi.api);
      const execs: string[][] = [];
      pi.api.exec = (_command: string, args: string[]) => { execs.push(args); return Promise.resolve({ stdout: "", stderr: "not run", code: 1, killed: false }); };
      const notes: Array<{ message: string; level: string }> = [];
      const ctx = { cwd: w.dir, hasUI: false, ui: { notify: (message: string, level: string) => notes.push({ message, level }), select: async () => undefined, confirm: async () => false, setStatus() {} }, reload: async () => {}, waitForIdle: async () => {} };
      const run = async (args: string) => { await pi.commands.get("profile").handler(args, ctx); return notes.at(-1) ?? { message: "", level: "" }; };
      assert.match((await run("create from-cmd blank")).message, /created .*from-cmd\.json from blank/);
      assert.ok(fs.existsSync(path.join(w.profiles, "from-cmd.json")));
      assert.match((await run("create from-cmd lite")).message, /already exists/, "the command never overwrites a profile");
      assert.match((await run("create x")).message, /usage: \/profile create <name> </);
      const refusedSwitch = await run("no-fw");
      assert.equal(refusedSwitch.level, "error");
      assert.match(refusedSwitch.message, /refusing to switch to "no-fw": .*mandatory protection "tool-firewall".*Nothing was changed/);
      assert.deepEqual(execs, [], "the installer never ran");
      Reflect.deleteProperty(process.env, "PI_KIT_ROOT");
      Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
      console.log("  OK: /profile lists user profiles and resolves them with the installer's code");
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  }
} finally {
  restoreEnv();
}

/** "ok", or the problems loadUserProfile reports for `name` in the world's profiles directory. */
function profileDefinitionCore(w: { profiles: string }, name: string): string {
  const r = loadUserProfile(w.profiles, name, BASES, readBase, REQUIRED);
  if (r === null) return "absent";
  return r.ok ? "ok" : r.problems.join("\n");
}

/** A user profile resolved exactly as shared/user-profile.ts does for the installer. */
function loadAnyProfileRaw(w: { profiles: string }, name: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(w.profiles, `${name}.json`), "utf8"));
  const parsed = parseUserProfile(raw, name, BASES, REQUIRED);
  assert.ok(parsed.ok);
  return resolveUserProfile(parsed.profile, readBase(parsed.profile.extends));
}

console.log("[user-profiles-smoke] OK");
