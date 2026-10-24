#!/usr/bin/env node
/**
 * Profile installs fail closed on safety-critical configuration and tolerate stale non-security
 * overrides; a failed --settings-only run rolls every file back.
 *
 *  - overrides.json: names that no longer exist (renamed/removed extensions, skills, prompts) are
 *    skipped with a WARN and the switch succeeds; removing a mandatory protection extension
 *    (tool-firewall, secret-guard, protected-paths) or an unreadable file stops the run; removing
 *    another extension every profile requires (distribution.json requiredProfileExtensions) is
 *    ignored with a WARN, and the core, delegation-guard and session-helpers lists are pinned.
 *  - firewall: a profile or an existing firewall.json naming an unknown policy/mode, or a
 *    firewall.json that does not parse, stops the run instead of silently becoming the default
 *    ("pentset" used to become the looser "coding" policy).
 *  - rollback: an installer that dies after it has rewritten settings.json leaves every switch file
 *    byte-identical to before, and names each `pi install` it had already run (files are restored,
 *    packages are not), instead of claiming nothing was changed.
 *
 * The installer under test is the real packages/core/install.ts with a fake `pi` on PATH.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolateKitEnv } from "../packages/core/eval/harness.ts";
import { array, object, optional, parseJson, parseJsonAs, string, union, unknownValue } from "../packages/core/lib/guard.ts";
import {
  MANDATORY_PROTECTION_EXTENSIONS, checkFirewallConfig, firewallConfigFor, normalizeOverrides, readFirewallConfigChecked, readOverridesChecked, reconcileOverrides, writeFirewallConfig,
} from "../packages/core/lib/profiles.ts";
import { readRequiredProfileExtensions } from "../packages/core/lib/distribution.ts";
import { MANDATORY_PROTECTIONS as DELEGATION_GUARD_PROTECTIONS } from "../packages/extensions/src/delegation-guard/index.ts";
import { MANDATORY_PROTECTION as SESSION_HELPERS_PROTECTION } from "../packages/extensions/src/session-helpers/index.ts";

const restoreEnv = isolateKitEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "packages", "core", "install.ts");
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const kit = { extensionExists: (n: string) => ["alpha", "beta", "tool-firewall", "protected-paths"].includes(n), skills: ["s1", "s2"], prompts: ["p1"], file: "overrides.json" };

// --- unit: reconcileOverrides / readOverridesChecked / firewall strictness ---------------------------
function testReconcile(): void {
  const o = normalizeOverrides({
    extensions: { add: ["alpha", "ghost"], remove: ["beta", "gone"] },
    skills: { exclude: ["s1", "nope"], include: ["also-nope"] },
    prompts: { exclude: ["p1"], include: ["missing"] },
  });
  const r = reconcileOverrides(o, kit);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.overrides.extensions, { add: ["alpha"], remove: ["beta"] });
  assert.deepEqual(r.overrides.skills, { exclude: ["s1"], include: [] });
  assert.deepEqual(r.overrides.prompts, { exclude: ["p1"], include: [] });
  assert.equal(r.warnings.length, 5);
  assert.ok(r.warnings.some((w) => /extensions\.add "ghost" no longer exists/.test(w)));
  assert.ok(r.warnings.some((w) => /skills\.include "also-nope"/.test(w)));
}

function testMandatoryRemovalIsAnError(): void {
  assert.deepEqual(MANDATORY_PROTECTION_EXTENSIONS, ["tool-firewall", "secret-guard", "protected-paths"]);
  for (const name of MANDATORY_PROTECTION_EXTENSIONS) {
    const r = reconcileOverrides(normalizeOverrides({ extensions: { remove: [name] } }), { ...kit, extensionExists: () => true });
    assert.equal(r.errors.length, 1, name);
    const [error] = r.errors;
    assert.ok(error !== undefined, name);
    assert.match(error, new RegExp(`mandatory protection extension "${name}"`));
    assert.match(error, /Delete .* from extensions\.remove/);
  }
  // Even when the extension name is unknown to this kit, a mandatory name is never quietly dropped.
  const r = reconcileOverrides(normalizeOverrides({ extensions: { remove: ["tool-firewall"] } }), { ...kit, extensionExists: () => false });
  assert.equal(r.errors.length, 1);
}

// TOO-5: an overrides.json removal of an extension every profile requires (distribution.json
// requiredProfileExtensions) is dropped with a warning; protections stay a hard error.
function testRequiredRemovalIsIgnored(): void {
  const required = readRequiredProfileExtensions();
  const nonProtection = required.filter((n) => !MANDATORY_PROTECTION_EXTENSIONS.includes(n));
  assert.ok(nonProtection.includes("session-helpers") && nonProtection.includes("delegation-guard"), "the required base has non-protection members");
  const r = reconcileOverrides(normalizeOverrides({ extensions: { remove: [...nonProtection, "beta"] } }), { ...kit, extensionExists: () => true, required });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.overrides.extensions.remove, ["beta"], "only the non-required removal is kept");
  for (const name of nonProtection) assert.ok(r.warnings.some((w) => w.includes(`extensions.remove "${name}" was ignored: every profile requires it`)), name);
  const guarded = reconcileOverrides(normalizeOverrides({ extensions: { remove: ["tool-firewall"] } }), { ...kit, extensionExists: () => true, required });
  assert.equal(guarded.errors.length, 1, "a protection removal is still an error");
}

// TOO-5 parity: extensions may not import core, so delegation-guard and session-helpers keep their
// own copies of the protection lists. Pin them to the core list and distribution.json.
function testMandatoryListsAgree(): void {
  const required = readRequiredProfileExtensions();
  assert.deepEqual([...DELEGATION_GUARD_PROTECTIONS], [...MANDATORY_PROTECTION_EXTENSIONS], "delegation-guard child protections = core MANDATORY_PROTECTION_EXTENSIONS");
  assert.deepEqual([...SESSION_HELPERS_PROTECTION], MANDATORY_PROTECTION_EXTENSIONS.filter((n) => required.includes(n)), "/profile status warns for every required protection");
}

function testReadOverridesChecked(): void {
  const dir = tmp("pi-kit-ovr-");
  try {
    const file = path.join(dir, "overrides.json");
    assert.equal(readOverridesChecked(file).error, null, "absent is fine");
    fs.writeFileSync(file, "{ nope");
    assert.match(readOverridesChecked(file).error ?? "", /is not valid JSON/);
    fs.writeFileSync(file, "[]");
    assert.match(readOverridesChecked(file).error ?? "", /must contain a JSON object/);
    fs.writeFileSync(file, "null");
    assert.match(readOverridesChecked(file).error ?? "", /must contain a JSON object/);
    fs.writeFileSync(file, JSON.stringify({ extensions: { add: ["a"] } }));
    assert.deepEqual(readOverridesChecked(file).overrides.extensions.add, ["a"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function testFirewallStrictness(): void {
  const coding = { name: "x", firewall: { mode: "manual", policy: "coding" } };
  assert.throws(() => firewallConfigFor({ name: "typo", firewall: { policy: "pentset" } }, {}), /unknown firewall policy "pentset"/);
  assert.throws(() => firewallConfigFor({ name: "typo", firewall: { mode: "yolo" } }, {}), /unknown firewall mode "yolo"/);
  assert.throws(() => firewallConfigFor({ name: "typo", firewall: "strict" }, {}), /"firewall" must be an object/);
  assert.throws(() => firewallConfigFor(coding, { policy: "pentest-strict" }), /unknown policy "pentest-strict"/);
  assert.throws(() => firewallConfigFor(coding, { mode: "always" }), /unknown mode "always"/);
  // Unchanged behaviour for valid input.
  assert.deepEqual(firewallConfigFor({ name: "n" }, {}), { mode: "manual", policy: "coding", source: "profile" }, "a profile with no firewall block keeps the safe defaults");
  const dir = tmp("pi-kit-fw-");
  try {
    const file = path.join(dir, "firewall.json");
    assert.deepEqual(readFirewallConfigChecked(file), {}, "absent is fine");
    fs.writeFileSync(file, "{broken");
    assert.throws(() => readFirewallConfigChecked(file), /not valid JSON/);
    assert.throws(() => writeFirewallConfig(coding, file), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken", "an unreadable firewall config is never overwritten");
    fs.writeFileSync(file, "[]");
    assert.throws(() => checkFirewallConfig(coding, file), /must be a JSON object/);
    fs.writeFileSync(file, JSON.stringify({ policy: "loose", mode: "auto", source: "user" }));
    assert.throws(() => checkFirewallConfig(coding, file), /unknown policy "loose"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- e2e with the real installer -----------------------------------------------------------------
/** The agent's settings.json as far as these tests read it: package entries, the kit's with its extensions. */
const AgentSettings = object({
  packages: array(union(string(), object({ source: string(), extensions: optional(array(string())) }))),
});

interface World {
  dir: string;
  agent: string;
  bin: string;
  done: () => void;
}

function world(): World {
  const dir = tmp("pi-kit-safety-");
  const agent = path.join(dir, "agent");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(agent, "pi-kit"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // pi stub: succeeds, except when asked to install pi-lens or pi-readseek (companions) - used to inject a late failure.
  fs.writeFileSync(path.join(bin, "pi"), '#!/bin/sh\ncase "$*" in *pi-lens*) [ -n "$FAIL_COMPANION" ] && exit 1;; *pi-readseek*) [ -n "$FAIL_READSEEK" ] && exit 1;; esac\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ theme: "dark", packages: [ROOT] }, null, 2));
  return { dir, agent, bin, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function install(w: World, profile: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: w.agent, PI_LEAN_CTX_BIN: path.join(w.dir, "no-lean-ctx"), PATH: `${w.bin}${path.delimiter}${process.env.PATH ?? ""}`, ...extraEnv };
  return spawnSync(process.execPath, [INSTALL, "--profile", profile, "--yes", "--settings-only", "--mode", "local", ...extraArgs], { cwd: w.dir, env, encoding: "utf8" });
}

const files = (w: World): string[] => [path.join(w.agent, "settings.json"), path.join(w.agent, ".pi-kit.json"), path.join(w.agent, "pi-kit", "firewall.json"), path.join(w.agent, "pi-kit", "security.json"), path.join(w.agent, "pi-kit", "overrides.json"), path.join(w.agent, ".env")];
const digest = (w: World): Record<string, string | null> => Object.fromEntries(files(w).map((f) => [f, fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null]));
const extensionsOf = (w: World): string[] => {
  const settings = parseJsonAs(AgentSettings, fs.readFileSync(path.join(w.agent, "settings.json"), "utf8"), "settings.json");
  const entry = settings.packages.find((p) => (typeof p === "string" ? p : p.source) === ROOT);
  if (entry === undefined || typeof entry === "string" || entry.extensions === undefined) throw new Error(`settings.json has no package entry with extensions for ${ROOT}`);
  return entry.extensions.map((e) => {
    const name = e.match(/\/([^/]+)\/index\.ts$/)?.[1];
    if (name === undefined) throw new Error(`unexpected extension path: ${e}`);
    return name;
  });
};

function testStaleOverridesWarnAndSkip(): void {
  const w = world();
  try {
    const first = install(w, "quick", ["--no-externals"]);
    assert.equal(first.status, 0, first.stderr);
    const baseline = extensionsOf(w);
    const overrides = { extensions: { add: ["renamed-away-ext", "verify-gate"], remove: ["old-removed-ext"] }, skills: { exclude: ["skill-that-was-deleted"] }, prompts: { include: ["prompt-that-was-deleted"] } };
    fs.writeFileSync(path.join(w.agent, "pi-kit", "overrides.json"), JSON.stringify(overrides));
    const r = install(w, "balanced", ["--no-externals"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /WARN: .*extensions\.add "renamed-away-ext" no longer exists/);
    assert.match(r.stderr, /WARN: .*extensions\.remove "old-removed-ext" no longer exists/);
    assert.match(r.stderr, /WARN: .*skills\.exclude "skill-that-was-deleted"/);
    assert.match(r.stderr, /WARN: .*prompts\.include "prompt-that-was-deleted"/);
    const names = extensionsOf(w);
    assert.ok(!names.includes("renamed-away-ext"));
    assert.ok(names.includes("tool-firewall") && names.includes("protected-paths"), "protections stay");
    assert.ok(names.includes("verify-gate"), "a valid override still applies");
    assert.notDeepEqual(names, baseline, "the switch really happened");
    assert.equal(parseJsonAs(object({ profile: unknownValue() }), fs.readFileSync(path.join(w.agent, ".pi-kit.json"), "utf8")).profile, "balanced");
    assert.deepEqual(parseJson(fs.readFileSync(path.join(w.agent, "pi-kit", "overrides.json"), "utf8")), overrides, "the operator's file is not rewritten");
  } finally { w.done(); }
}

function testRequiredRemovalIgnoredByTheInstaller(): void {
  const w = world();
  try {
    assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
    fs.writeFileSync(path.join(w.agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { remove: ["session-helpers", "delegation-guard", "effort"] } }));
    const r = install(w, "balanced", ["--no-externals"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const names = extensionsOf(w);
    for (const name of ["session-helpers", "delegation-guard", "effort"]) {
      assert.match(r.stderr, new RegExp(`WARN: .*extensions\\.remove "${name}" was ignored`), name);
      assert.ok(names.includes(name), `${name} still loads`);
    }
  } finally { w.done(); }
}

function testMandatoryRemovalStopsTheRun(): void {
  for (const name of ["tool-firewall", "protected-paths", "secret-guard"]) {
    const w = world();
    try {
      assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
      fs.writeFileSync(path.join(w.agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { remove: [name] } }));
      const before = digest(w);
      const r = install(w, "balanced", ["--no-externals"]);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, new RegExp(`FAIL: .*removes the mandatory protection extension "${name}"`));
      assert.match(r.stderr, /Refusing to apply it/);
      assert.deepEqual(digest(w), before, "nothing changed");
    } finally { w.done(); }
  }
}

function testMalformedOverridesStopTheRun(): void {
  const w = world();
  try {
    assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
    fs.writeFileSync(path.join(w.agent, "pi-kit", "overrides.json"), '{"extensions": {"remove": ["tool-firewall"]');
    const before = digest(w);
    const r = install(w, "balanced", ["--no-externals"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAIL: .*overrides\.json is not valid JSON.*Fix or delete it, then retry; nothing was changed/);
    assert.deepEqual(digest(w), before);
  } finally { w.done(); }
}

function testFirewallFailuresStopTheRun(): void {
  const cases: Array<[string, string, RegExp]> = [
    ["unknown policy in the existing file", JSON.stringify({ mode: "manual", policy: "pentest-strict", source: "user" }), /unknown policy "pentest-strict"/],
    ["unknown mode in the existing file", JSON.stringify({ mode: "always", policy: "coding" }), /unknown mode "always"/],
    ["unparseable existing file", "{ not json", /not valid JSON/],
    ["existing file that is not an object", "[]", /must be a JSON object/],
  ];
  for (const [name, content, pattern] of cases) {
    const w = world();
    try {
      assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
      fs.writeFileSync(path.join(w.agent, "pi-kit", "firewall.json"), content);
      const before = digest(w);
      const r = install(w, "balanced", ["--no-externals"]);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, pattern, name);
      assert.deepEqual(digest(w), before, `${name}: nothing changed`);
    } finally { w.done(); }
  }
}

function testInstallerFailureLateInTheRunRollsBack(): void {
  const w = world();
  try {
    assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
    const before = digest(w);
    // balanced pulls the pi-lens companion; the stub fails that install AFTER settings.json was narrowed.
    const r = install(w, "balanced", [], { FAIL_COMPANION: "1" });
    assert.notEqual(r.status, 0, "the companion failure must fail the run");
    assert.match(r.stderr, /Rolled back \d+ configuration file\(s\), but NOT the package operations pi already ran: pi install npm:pi-lens@\S+ \(failed part-way\)\./);
    assert.deepEqual(digest(w), before, "settings.json, marker, firewall.json, overrides.json and .env are back as they were");
    assert.equal(extensionsOf(w).includes("verify-gate"), false, "the narrowed extension list did not survive");
  } finally { w.done(); }
}

function testRollbackNamesPackageChangesItCannotUndo(): void {
  const w = world();
  try {
    assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
    const before = digest(w);
    // long-horizon installs pi-lens (succeeds), then pi-readseek (fails): pi-lens stays installed.
    const r = install(w, "long-horizon", [], { FAIL_READSEEK: "1" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /\[install\] Package change \(a rollback cannot undo it\): pi install npm:pi-lens@\S+$/m, "each package operation is announced for /profile");
    assert.match(r.stderr, /NOT the package operations pi already ran: pi install npm:pi-lens@\S+; pi install npm:pi-readseek@\S+ \(failed part-way\)\./);
    assert.doesNotMatch(r.stderr, /nothing was changed/);
    assert.deepEqual(digest(w), before, "the configuration files are still restored");
  } finally { w.done(); }
}

function testNoPackageChangeStillSaysNothingChanged(): void {
  const w = world();
  try {
    assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
    fs.writeFileSync(path.join(w.agent, "pi-kit", "firewall.json"), "{ not json");
    const r = install(w, "balanced", ["--no-externals"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Rolled back \d+ configuration file\(s\); nothing was changed\./);
  } finally { w.done(); }
}

function testCleanInstallStillWorks(): void {
  const w = world();
  try {
    const r = install(w, "lite", ["--no-externals"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /\[install\] Done\./);
    const fw = parseJsonAs(object({ policy: unknownValue(), mode: unknownValue() }), fs.readFileSync(path.join(w.agent, "pi-kit", "firewall.json"), "utf8"));
    assert.deepEqual({ policy: fw.policy, mode: fw.mode }, { policy: "coding", mode: "manual" });
    for (const name of ["tool-firewall", "protected-paths"]) assert.ok(extensionsOf(w).includes(name), `${name} is in lite`);
  } finally { w.done(); }
}

const tests: Array<[string, () => void]> = [
  ["reconcileOverrides drops stale names with warnings", testReconcile],
  ["removing a mandatory protection extension is an error", testMandatoryRemovalIsAnError],
  ["removing a required-everywhere extension is ignored with a warning", testRequiredRemovalIsIgnored],
  ["the mandatory lists in core, delegation-guard and session-helpers agree", testMandatoryListsAgree],
  ["readOverridesChecked distinguishes absent from unreadable", testReadOverridesChecked],
  ["firewall config: unknown values and unreadable files fail closed", testFirewallStrictness],
  ["installer: stale overrides warn and the switch succeeds", testStaleOverridesWarnAndSkip],
  ["installer: overrides that remove a protection stop the run untouched", testMandatoryRemovalStopsTheRun],
  ["installer: overrides that remove a required extension are ignored", testRequiredRemovalIgnoredByTheInstaller],
  ["installer: a malformed overrides.json stops the run untouched", testMalformedOverridesStopTheRun],
  ["installer: an unsafe firewall.json stops the run untouched", testFirewallFailuresStopTheRun],
  ["installer: a failure late in --settings-only rolls every file back", testInstallerFailureLateInTheRunRollsBack],
  ["installer: a rollback names the package operations it could not undo", testRollbackNamesPackageChangesItCannotUndo],
  ["installer: a rollback with no package operation says nothing was changed", testNoPackageChangeStillSaysNothingChanged],
  ["installer: a clean install still works", testCleanInstallStillWorks],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error: unknown) {
    failed++;
    console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
  }
}
restoreEnv();
if (failed) {
  console.error(`profile-safety-smoke: ${failed}/${tests.length} failed`);
  process.exit(1);
}
console.log(`profile-safety-smoke: ${tests.length}/${tests.length} passed`);
