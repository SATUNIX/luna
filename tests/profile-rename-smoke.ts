/**
 * Renamed profiles: a typed old name fails with an actionable message (no aliases), and a name the
 * kit stored earlier in the install marker is migrated one way when read.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RENAMED_PROFILES, migrateStoredProfile, renamedProfile } from "../packages/core/shared/profile-names.ts";
import { loadProfileDef, normalizeOverrides } from "../packages/core/lib/profiles.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { readKitMarker } from "../packages/core/lib/settings.ts";

const restoreEnv = isolateKitEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The table: every old name points at a shipped profile, and no shipped profile still has an old name.
for (const [from, to] of Object.entries(RENAMED_PROFILES)) {
  assert.ok(fs.existsSync(path.join(ROOT, "packages", "kit", "profiles", `${to}.json`)), `${from} -> ${to}: the replacement ships`);
  assert.ok(!fs.existsSync(path.join(ROOT, "packages", "kit", "profiles", `${from}.json`)), `${from} must not ship beside its replacement`);
}
assert.equal(renamedProfile("quick"), "lite");
assert.equal(renamedProfile("autonomous"), "long-horizon");
assert.equal(renamedProfile("pentest"), "engagement");
assert.equal(renamedProfile("constructor"), undefined, "only own keys are renames");
assert.equal(migrateStoredProfile("balanced"), "balanced");

// A typed old name is an error that names the replacement, not a silent alias.
assert.throws(() => loadProfileDef("quick"), /profile "quick" was renamed to "lite"/);
const installer = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "install.ts"), "--profile", "autonomous", "--dry-run"], { encoding: "utf8" });
assert.equal(installer.status, 1);
assert.match(installer.stderr, /profile "autonomous" was renamed to "long-horizon"/);

// The first /update from 0.3.0-beta.3 runs that release's kit-update from memory, which re-applies the
// stored profile with the raw marker name: `install.ts --profile <stored> --yes --settings-only`. That call
// must succeed (with a notice) when the name is the installed profile, and keep failing when it is not.
for (const [stored, now] of [["quick", "lite"], ["autonomous", "long-horizon"], ["pentest", "engagement"]] as const) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "luna-rename-update-"));
  try {
    const agent = path.join(home, "agent");
    const bin = path.join(home, "bin");
    fs.mkdirSync(agent, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [ROOT] }));
    fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ profile: stored, scope: "global" }));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent, HOME: home, PI_LEAN_CTX_BIN: path.join(home, "none"), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    const call = (name: string) => spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "install.ts"), "--profile", name, "--yes", "--settings-only", "--mode", "local", "--no-externals"], { cwd: home, env, encoding: "utf8" });
    const update = call(stored);
    assert.equal(update.status, 0, `0.3.0-beta.3 update call with stored ${stored}: ${update.stdout}\n${update.stderr}`);
    assert.match(update.stdout, new RegExp(`profile "${stored}" was renamed to "${now}"`));
    assert.equal(readKitMarker(path.join(agent, ".pi-kit.json"))?.profile, now);
    assert.match(fs.readFileSync(path.join(agent, ".pi-kit.json"), "utf8"), new RegExp(`"profile": ?"${now}"`), "the marker is rewritten under the new name");
    // A different retired name, or no --yes, is still a typed old name and fails.
    const other = stored === "quick" ? "autonomous" : "quick";
    assert.equal(call(other).status, 1, `${other} does not match the stored ${now}`);
    const noYes = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "install.ts"), "--profile", stored, "--settings-only", "--dry-run"], { cwd: home, env, encoding: "utf8" });
    assert.equal(noYes.status, 1, "without --yes a retired name is refused");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// A stored marker is migrated on read; the installer rewrites it on its next write.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-rename-"));
try {
  const marker = path.join(dir, ".pi-kit.json");
  fs.writeFileSync(marker, JSON.stringify({ profile: "autonomous", scope: "global" }));
  assert.equal(readKitMarker(marker)?.profile, "long-horizon");
  assert.match(fs.readFileSync(marker, "utf8"), /"profile":"autonomous"/, "reading never rewrites the file");
  // A renamed extension in the marker and in overrides.json is read as its replacement.
  fs.writeFileSync(marker, JSON.stringify({ extensions: ["tool-firewall", "pentest-governance-domain"] }));
  assert.deepEqual(readKitMarker(marker)?.extensions, ["tool-firewall", "engagement-governance"]);
  assert.deepEqual(normalizeOverrides({ extensions: { add: ["pentest-governance-domain"], remove: ["x"] } }).extensions, { add: ["engagement-governance"], remove: ["x"] });
  // A settings filter that still names the old path is reported by session-helpers.
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ packages: [{ source: "npm:x", extensions: ["packages/extensions/src/pentest-governance-domain/index.ts", "packages/extensions/src/tool-firewall/index.ts"] }] }));
  const helpers = await loadModule<{ staleExtensionFilters: (file: string) => string[] }>("extensions/session-helpers/index.ts");
  assert.deepEqual(helpers.staleExtensionFilters(settings), ["pentest-governance-domain"]);
  fs.writeFileSync(settings, JSON.stringify({ packages: [{ source: "npm:x", extensions: ["packages/extensions/src/engagement-governance/index.ts"] }] }));
  assert.deepEqual(helpers.staleExtensionFilters(settings), []);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// The extension-side readers migrate a stored name too: each is generated from the one table, and
// dropping the call in any of them would strand an old install (wrong Memento allowance, wrong level).
const effort = await loadModule<{ installedProfile: (cwd: string) => string | null }>("extensions/effort/memento.ts");
const firewall = await loadModule<{ profileDefault: (cwd: string, policy: string) => string }>("extensions/tool-firewall/security-level.ts");
const center = await loadModule<{ readMarker: (cwd: string) => { profile?: string | undefined } }>("extensions/control-center/values.ts");
const agent = fs.mkdtempSync(path.join(os.tmpdir(), "luna-rename-agent-"));
const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
try {
  const cwd = path.join(agent, "work");
  fs.mkdirSync(cwd);
  for (const [stored, now] of [["autonomous", "long-horizon"], ["quick", "lite"], ["pentest", "engagement"]] as const) {
    fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ profile: stored }));
    assert.equal(effort.installedProfile(cwd), now, `effort reads stored ${stored} as ${now}`);
    assert.equal(center.readMarker(cwd).profile, now, `control-center reads stored ${stored} as ${now}`);
    const def = parseJson(fs.readFileSync(path.join(ROOT, "packages", "kit", "profiles", `${now}.json`), "utf8"));
    const level = isRecord(def) ? def.securityLevel : undefined;
    assert.equal(firewall.profileDefault(cwd, "coding"), level, `tool-firewall resolves stored ${stored} to ${now}'s level, not the fallback`);
  }

  // Firewall policy reader: a stored `pentest` is migrated; an unknown policy (stored or typed) selects the
  // strict policy with a loud error and never the weaker `coding`; a typed old name is not an alias.
  const fw = await loadModule<{
    readConfig: () => { policy: string; invalid?: string };
    resolvePolicy: (cfg?: { policy: string; invalid?: string; source: string }) => { policy: string; error?: string };
    writeConfig: (patch: { mode: "manual" }) => { policy: string };
  }>("extensions/tool-firewall/config.ts");
  const config = path.join(agent, "firewall.json");
  const restoreConfig = setEnv("PI_KIT_FIREWALL_CONFIG", config);
  const restoreProfile = setEnv("PI_KIT_FIREWALL_PROFILE", undefined);
  try {
    fs.writeFileSync(config, JSON.stringify({ mode: "manual", policy: "pentest", source: "profile" }));
    assert.equal(fw.readConfig().policy, "engagement", "stored pentest reads as engagement");
    assert.equal(fw.readConfig().invalid, undefined);
    assert.match(fs.readFileSync(config, "utf8"), /"policy":"pentest"/, "reading never rewrites the file");
    fw.writeConfig({ mode: "manual" });
    assert.match(fs.readFileSync(config, "utf8"), /"policy": "engagement"/, "the next write stores the new name");
    fs.writeFileSync(config, JSON.stringify({ policy: "pentset" }));
    assert.equal(fw.readConfig().policy, "engagement", "an unknown stored policy is strict, not coding");
    assert.match(fw.resolvePolicy().error ?? "", /unknown policy "pentset"/);
    fs.writeFileSync(config, JSON.stringify({ mode: "manual" }));
    assert.equal(fw.readConfig().policy, "coding", "no policy key is the coding default");
    // A file that exists but is truncated or not an object is strict with an error, in both readers;
    // only an absent file is the coding default.
    const pp = await loadModule<{ firewallPolicy: () => string }>("vendor/protected-paths/index.ts");
    for (const bad of ['{"policy":"engagement","mode":"ma', "[]", "null", "42"]) {
      fs.writeFileSync(config, bad);
      assert.equal(fw.readConfig().policy, "engagement", `unusable firewall.json ${bad} is strict`);
      assert.match(fw.resolvePolicy().error ?? "", /strict "engagement" policy/, `${bad} is reported`);
      assert.equal(pp.firewallPolicy(), "engagement", `protected-paths mirrors the strict reading of ${bad}`);
    }
    fs.rmSync(config);
    assert.equal(fw.readConfig().policy, "coding", "an absent firewall.json is the coding default");
    assert.equal(fw.resolvePolicy().error, undefined);
    assert.equal(pp.firewallPolicy(), "coding");
    // The typed env value is read the same way by both: no case folding.
    restoreProfile();
    setEnv("PI_KIT_FIREWALL_PROFILE", "Coding");
    assert.equal(fw.resolvePolicy().policy, "engagement");
    assert.equal(pp.firewallPolicy(), "engagement", "protected-paths does not lowercase the env value");
    restoreProfile();
    setEnv("PI_KIT_FIREWALL_PROFILE", "pentest");
    const typed = fw.resolvePolicy();
    assert.equal(typed.policy, "engagement", "a typed old name is strict, not an alias and not coding");
    assert.match(typed.error ?? "", /unknown policy "pentest"/);
  } finally {
    restoreProfile();
    setEnv("PI_KIT_FIREWALL_PROFILE", undefined);
    restoreConfig();
  }
} finally {
  restoreAgent();
  rmWorkspace(agent);
  restoreEnv();
}
console.log("profile-rename-smoke: ok");
