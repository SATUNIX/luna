#!/usr/bin/env node
/**
 * F-01 regression coverage: --profile/--only must produce a genuinely narrowed
 * runtime resource set, not just resolve names for display.
 *
 * Fully offline - no `pi` CLI invocation, no network. Simulates only the on-disk
 * settings.json state that `pi install <local-path>` leaves behind (a plain-string
 * package entry, with the local source normalized to a path relative to the
 * settings file's directory - see node_modules/@earendil-works/pi-coding-agent/dist/
 * core/package-manager.js normalizePackageSourceForSettings) and then exercises the
 * real packages/core/lib/resolve.ts + packages/core/lib/settings.ts functions packages/core/install.ts now calls.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfile, type ResolvedExtension } from "../packages/core/lib/resolve.ts";
import { type PackageEntry, type PackageObject, mergePackageBlock, removeOtherKitEntries, findPackageEntry, leanCtxBinaryAvailable, readSettings, globalAgentDir, globalSettingsPath, updateSettings } from "../packages/core/lib/settings.ts";
import { object, optional, parseJson, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import { applyExtensionOverrides, captureDrift, excludedPrompts, excludedSkills, kitSkills, normalizeOverrides, parseProfile, skillFilterPatterns, canonicalProfileName, loadProfileDef, firewallConfigFor, writeFirewallConfig } from "../packages/core/lib/profiles.ts";

import { isolateKitEnv } from "../packages/core/eval/harness.ts";

const restoreKitEnv = isolateKitEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The kit's package entry in its filtered object form (fails the test otherwise).
function objectEntry(entry: PackageEntry | undefined): PackageObject {
  assert.ok(entry !== undefined && typeof entry === "object", "kit entry must be the filtered object form");
  return entry;
}

// The parts of a packages/kit/profiles/*.json file this test reads.
interface ProfileFile {
  include: string[];
}

function withTempSettings<T>(fn: (settingsPath: string, dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-install-filter-"));
  const settingsPath = path.join(dir, "settings.json");
  try {
    return fn(settingsPath, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 1. quick.json must resolve every included name (no dangling references) and must
//    resolve to a strict subset of the full extension/vendor set - proving the
//    profile is actually narrower than "everything", not just a differently-named
//    alias for it.
function testQuickProfileResolvesToSubset() {
  const quick = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "kit", "profiles", "quick.json"), "utf8")) as ProfileFile;
  const resolved: ResolvedExtension[] = resolveProfile(quick.include);
  assert.equal(resolved.length, quick.include.length);

  const allInRepoCount =
    fs.readdirSync(path.join(ROOT, "packages", "extensions", "src")).filter(n => !n.startsWith("_")).length +
    fs.readdirSync(path.join(ROOT, "packages", "extensions", "third_party")).length;
  const inRepoSelected = resolved.filter(r => r.avenue !== "external").length;
  assert.ok(
    inRepoSelected < allInRepoCount,
    `quick profile should select fewer in-repo extensions (${inRepoSelected}) than the full set (${allInRepoCount})`,
  );

  // A quarantined/experimental extension must not appear in the safe-baseline profile.
  assert.ok(!quick.include.includes("mcp-router"), "mcp-router (status: stub) must not be in quick.json");
}

// 2. mergePackageBlock must rewrite a plain-string local-path entry (what `pi install`
//    actually writes, normalized relative to the settings file's directory) into the
//    filtered object form - proving the installer's fix reaches settings.json, not
//    just an in-memory computation.
function testMergePackageBlockNarrowsLocalEntry() {
  withTempSettings((settingsPath) => {
    const baseDir = path.dirname(settingsPath);
    const normalizedSource = path.relative(baseDir, ROOT) || ".";
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ defaultModel: "keep-me", packages: ["some-other-pkg", normalizedSource] }, null, 2),
    );

    const resolved = resolveProfile(["tool-firewall", "secret-guard", "git-checkpoint"]);
    mergePackageBlock(settingsPath, ROOT, resolved);

    const after = readSettings(settingsPath);
    assert.equal(after.defaultModel, "keep-me", "unrelated settings must be preserved");
    assert.equal(after.packages?.length, 2, "must not duplicate-register the package");
    assert.equal(after.packages[0], "some-other-pkg", "unrelated package entries must be untouched");

    const kitEntry = objectEntry(after.packages[1]);
    assert.equal(kitEntry.source, normalizedSource, "must preserve pi's already-normalized source string");
    assert.deepEqual(
      [...(kitEntry.extensions ?? [])].sort(),
      ["packages/extensions/src/tool-firewall/index.ts", "packages/extensions/src/secret-guard/index.ts", "packages/extensions/third_party/git-checkpoint/index.ts"].sort(),
    );
  });
}

// 3. Same, but for a git-mode source (not path-normalized by pi - compared verbatim).
function testMergePackageBlockNarrowsGitEntry() {
  withTempSettings((settingsPath) => {
    const gitSource = "git:git@github.com/satunix/pi-system@main";
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: [gitSource] }, null, 2));

    const resolved = resolveProfile(["todo"]);
    mergePackageBlock(settingsPath, gitSource, resolved);

    const after = readSettings(settingsPath);
    assert.equal(after.packages?.length, 1);
    assert.equal(objectEntry(after.packages[0]).source, gitSource);
    assert.deepEqual(objectEntry(after.packages[0]).extensions, ["packages/extensions/third_party/todo/index.ts"]);
  });
}

// 4. External-only names (companions from packages/core/sources.json, e.g. pi-lean-ctx) must be
//    excluded from the package's own extensions filter - they are installed as their
//    own separate package entries by packages/core/install.ts step 3, not bundled into this
//    package's glob.
function testExternalNamesExcludedFromFilter() {
  withTempSettings((settingsPath) => {
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: [ROOT] }, null, 2));
    const resolved: ResolvedExtension[] = resolveProfile(["todo", "pi-lean-ctx"]);
    assert.equal(resolved.find(r => r.name === "pi-lean-ctx")?.avenue, "external");
    mergePackageBlock(settingsPath, ROOT, resolved);
    const after = readSettings(settingsPath);
    assert.deepEqual(objectEntry(after.packages?.[0]).extensions, ["packages/extensions/third_party/todo/index.ts"]);
  });
}

// 5. mergePackageBlock must fail loud (not silently double-register) when `pi install`
//    was never actually run for this source - the exact bug shape F-01 warned about.
function testMergePackageBlockThrowsWithoutExistingEntry() {
  withTempSettings((settingsPath) => {
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: [] }, null, 2));
    const resolved = resolveProfile(["todo"]);
    assert.throws(() => mergePackageBlock(settingsPath, ROOT, resolved), /No registered package entry found/);
  });
}

// 6. Every registered copy of the kit ships the same tool names, so an install must leave
// exactly one: installing the checkout evicts the npm package and a retired dist/pi-kit-*
// export; installing the npm package evicts the checkout. Unrelated packages survive.
function testRemoveOtherKitEntriesForCheckout() {
  withTempSettings((settingsPath) => {
    const baseDir = path.dirname(settingsPath);
    const staleSurface = path.relative(baseDir, path.join(ROOT, "dist", "pi-kit-lite"));
    const root = path.relative(baseDir, ROOT);
    fs.writeFileSync(settingsPath, JSON.stringify({
      packages: ["npm:pi-lens@3.8.63", staleSurface, "npm:@satunix/pi-system@next", { source: root, extensions: ["packages/extensions/third_party/todo/index.ts"] }, "npm:other-package"],
    }, null, 2));

    assert.equal(removeOtherKitEntries(settingsPath, ROOT), 2);
    assert.deepEqual(readSettings(settingsPath).packages, [
      "npm:pi-lens@3.8.63",
      { source: root, extensions: ["packages/extensions/third_party/todo/index.ts"] },
      "npm:other-package",
    ]);
    assert.equal(removeOtherKitEntries(settingsPath, ROOT), 0, "cleanup must be idempotent");
  });
}

function testRemoveOtherKitEntriesForNpm() {
  withTempSettings((settingsPath) => {
    const baseDir = path.dirname(settingsPath);
    const root = path.relative(baseDir, ROOT);
    const kit = { source: "npm:@satunix/pi-system@next", extensions: ["packages/extensions/third_party/todo/index.ts"] };
    fs.writeFileSync(settingsPath, JSON.stringify({
      packages: [{ source: root, extensions: [] }, "git:github.com/satunix/pi-system@v0.2.0", kit, "npm:@satunix/pi-balanced", "npm:pi-lens@3.8.63"],
    }, null, 2));

    // The npm entry on another channel is the same package, not a duplicate.
    assert.equal(removeOtherKitEntries(settingsPath, "npm:@satunix/pi-system"), 3);
    assert.deepEqual(readSettings(settingsPath).packages, [kit, "npm:pi-lens@3.8.63"]);
  });
}

// 6b. npm entries match by package name across channels and pins, like pi's own package
// identity, so a profile switch finds (and narrows) the entry whatever channel it tracks.
function testNpmEntryMatchesAcrossChannels() {
  withTempSettings((settingsPath) => {
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-lens@3.8.63", "npm:@satunix/pi-system@next"] }, null, 2));
    const settings = readSettings(settingsPath);
    assert.equal(findPackageEntry(settings, "npm:@satunix/pi-system", settingsPath), 1);
    assert.equal(findPackageEntry(settings, "npm:@satunix/pi-system@0.2.1-beta.0", settingsPath), 1);
    assert.equal(findPackageEntry(settings, "npm:pi-lens@3.9.0", settingsPath), 0);
    assert.equal(findPackageEntry(settings, "npm:@satunix/pi-system-lite", settingsPath), -1);

    mergePackageBlock(settingsPath, "npm:@satunix/pi-system", resolveProfile(["todo"]), { skills: ["!packages/kit/skills/memory/SKILL.md"] });
    const entry = objectEntry(readSettings(settingsPath).packages?.[1]);
    assert.equal(entry.source, "npm:@satunix/pi-system@next", "the registered channel must be kept");
    assert.deepEqual(entry.extensions, ["packages/extensions/third_party/todo/index.ts"]);
  });
}

// 6c. The lite profile's skill/prompt allowlists hide everything not listed.
function testLiteProfileAllowlists() {
  const lite = loadProfileDef("lite");
  const none = normalizeOverrides({});
  const hidden = excludedSkills(lite, none);
  const only = lite.skills?.only ?? [];
  for (const name of only) assert.ok(!hidden.includes(name), `lite must keep ${name}`);
  assert.equal(hidden.length, kitSkills().length - only.length, "every other skill is hidden");
  assert.ok(!excludedPrompts(lite, none).includes("code-plan"));
  assert.ok(excludedPrompts(lite, none).includes("pentest-plan"));
  const withOverride = excludedSkills(lite, normalizeOverrides({ skills: { include: ["finding-writing"] } }));
  assert.ok(!withOverride.includes("finding-writing"), "overrides.skills.include beats the allowlist");
}

function testLeanCtxPrerequisiteDetection() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-lean-ctx-"));
  try {
    const executable = path.join(dir, process.platform === "win32" ? "lean-ctx.cmd" : "lean-ctx");
    assert.equal(leanCtxBinaryAvailable({ pathEnv: dir, platform: process.platform }), false, "absent binary must disable the companion");
    fs.writeFileSync(executable, "placeholder");
    assert.equal(leanCtxBinaryAvailable({ pathEnv: dir, platform: process.platform }), true, "PATH binary must enable the companion");
    assert.equal(
      leanCtxBinaryAvailable({ env: { PI_LEAN_CTX_BIN: path.join(dir, "missing") }, pathEnv: dir, platform: process.platform }),
      false,
      "an explicit missing binary must fail closed instead of falling back to PATH",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testUnresolvedNameThrows() {
  assert.throws(() => resolveProfile(["definitely-not-a-real-extension"]), /Unresolved extension/);
}

// 7. Live-testing finding (pi-system container, 2026-08-06): pi itself
//    resolves its config dir from PI_CODING_AGENT_DIR when set (falling back to
//    ~/.pi/agent). Before this fix, globalSettingsPath()/globalAgentDir() ignored that
//    env var, so in any environment that sets it (e.g. that container, which points it
//    at a durable data-root distinct from $HOME) `pi install` registers the package into
//    pi's real config dir while this kit's own install/uninstall scripts read and write
//    settings.json/.pi-kit.json/.env in $HOME/.pi/agent instead - two different files.
//    The profile-narrowing step then never finds the entry `pi install` just wrote and
//    fails closed with a misleading "No registered package entry found" error, silently
//    breaking --profile/--only in exactly the deployment this kit ships a container for.
function testGlobalAgentDirRespectsPiCodingAgentDirEnvVar() {
  const original = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_CODING_AGENT_DIR;
    const fallback = globalAgentDir();
    assert.ok(fallback.endsWith(path.join(".pi", "agent")), "must fall back to ~/.pi/agent when unset");

    process.env.PI_CODING_AGENT_DIR = "/srv/data/pi-system/pi-agent";
    assert.equal(globalAgentDir(), "/srv/data/pi-system/pi-agent");
    assert.equal(
      globalSettingsPath(),
      path.join("/srv/data/pi-system/pi-agent", "settings.json"),
    );
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  }
}

// Profiles v2: the package entry keeps keys it does not own, profile filters replace
// skills/prompts only when given, and a hand-made exclusion survives a narrowing without
// filters (it used to be wiped on every profile switch).
function testMergePackageBlockPreservesAndSetsFilters() {
  withTempSettings((settingsPath) => {
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "x", packages: [{ source: ROOT, skills: ["!packages/kit/skills/a/SKILL.md"], themes: ["t"] }] }));
    const resolved = resolveProfile(["todo"]);
    mergePackageBlock(settingsPath, ROOT, resolved);
    let entry = objectEntry(readSettings(settingsPath).packages?.[0]);
    assert.deepEqual(entry.skills, ["!packages/kit/skills/a/SKILL.md"], "existing skill filters survive a filterless merge");
    assert.deepEqual(entry.themes, ["t"], "unowned keys survive");
    mergePackageBlock(settingsPath, ROOT, resolved, { skills: ["!packages/kit/skills/b/SKILL.md"], prompts: [] });
    entry = objectEntry(readSettings(settingsPath).packages?.[0]);
    assert.deepEqual(entry.skills, ["!packages/kit/skills/b/SKILL.md"]);
    assert.equal(entry.prompts, undefined, "an empty filter list removes the key");
    assert.equal(readSettings(settingsPath).theme, "x");
  });
}

function testUpdateSettingsRefusesInvalidJson() {
  withTempSettings((settingsPath) => {
    fs.writeFileSync(settingsPath, "{ not json");
    assert.throws(() => updateSettings(settingsPath, (s: Record<string, unknown>) => { s.x = 1; }), /not valid JSON/);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), "{ not json", "the operator's file is untouched");
  });
}

function testProfileSkillAndOverrideResolution() {
  const balanced = parseProfile(parseJson(fs.readFileSync(path.join(ROOT, "packages", "kit", "profiles", "balanced.json"), "utf8")), "balanced.json");
  const pentest = parseProfile(parseJson(fs.readFileSync(path.join(ROOT, "packages", "kit", "profiles", "pentest.json"), "utf8")), "pentest.json");
  const none = normalizeOverrides({});
  const hidden = excludedSkills(balanced, none);
  const categoryOf = Object.fromEntries(kitSkills().map((s) => [s.name, s.category]));
  assert.ok(hidden.length > 0 && hidden.every((n) => ["pentest", "mcp-governance", "evidence-reporting", "maintainer"].includes(categoryOf[n] ?? "") || ["engagement-conductor", "dynamic-agent-synthesis"].includes(n)));
  assert.ok(!hidden.includes("verification-loop"), "coding skills stay visible");
  assert.deepEqual(excludedSkills(pentest, none), [], "the pentest profile shows every skill");
  assert.ok(excludedPrompts(balanced, none).includes("pentest-plan"));
  const o = normalizeOverrides({ skills: { include: ["api-testing"], exclude: ["patch-hygiene"] }, extensions: { add: ["task-graph"], remove: ["notify"] } });
  const withO = excludedSkills(balanced, o);
  assert.ok(!withO.includes("api-testing") && withO.includes("patch-hygiene"));
  assert.deepEqual(skillFilterPatterns(["x"]), ["!packages/kit/skills/x/SKILL.md"]);
  const ext = applyExtensionOverrides(["todo", "notify"], o);
  assert.deepEqual(ext, ["todo", "task-graph"]);
}

function testCaptureDrift() {
  const profile = { include: ["todo", "notify", "pi-lens"], skills: { excludeCategories: ["pentest"] } };
  const entry = {
    extensions: ["packages/extensions/third_party/todo/index.ts", "packages/extensions/src/task-graph/index.ts"],
    skills: ["!packages/kit/skills/api-testing/SKILL.md", "!packages/kit/skills/patch-hygiene/SKILL.md"],
  };
  const drift = captureDrift(entry, profile, (n: string) => n !== "pi-lens");
  assert.deepEqual(drift.extensions, { add: ["task-graph"], remove: ["notify"] }, "externals are never reported as removed");
  assert.deepEqual(drift.skills.exclude, ["patch-hygiene"], "exclusions the profile already applies are not captured");
}

// The installer writes <agent dir>/pi-kit/firewall.json from the profile's `firewall` field.
function testFirewallConfigFromProfile() {
  assert.equal(canonicalProfileName("engagement"), "pentest", "the old profile name is an alias");
  assert.equal(loadProfileDef("engagement").name, "pentest");
  const lh = loadProfileDef("long-horizon");
  const bal = loadProfileDef("balanced");
  const pt = loadProfileDef("pentest");
  assert.deepEqual(firewallConfigFor(lh, {}), { mode: "auto", policy: "coding", source: "profile" });
  // A mode the operator chose with /auto survives a switch within the same policy, with their other settings.
  assert.deepEqual(firewallConfigFor(bal, { mode: "auto", policy: "coding", source: "user", judgeModel: "x/y", knownHosts: ["a"] }), { mode: "auto", policy: "coding", source: "user", judgeModel: "x/y", knownHosts: ["a"] });
  // The policy always follows the profile, and a policy change resets the mode to the profile's.
  assert.deepEqual(firewallConfigFor(pt, { mode: "auto", policy: "coding", source: "user" }), { mode: "manual", policy: "pentest", source: "profile" });
  assert.deepEqual(firewallConfigFor(lh, { mode: "manual", policy: "pentest", source: "user" }), { mode: "auto", policy: "coding", source: "profile" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-fwcfg-"));
  try {
    const file = path.join(dir, "pi-kit", "firewall.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "{broken");
    // An unreadable firewall config used to be replaced silently with the profile's; it holds the
    // operator's firewall choices, so it now stops the run (see profile-safety-smoke.ts).
    assert.throws(() => writeFirewallConfig(pt, file), /not valid JSON/, "an unreadable config is not overwritten");
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
    fs.rmSync(file);
    assert.deepEqual(writeFirewallConfig(pt, file), { mode: "manual", policy: "pentest", source: "profile" }, "an absent config is created from the profile");
    assert.equal(parseJsonAs(object({ policy: optional(string()) }), fs.readFileSync(file, "utf8")).policy, "pentest");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testIdentityBridgeCleanup() {
  withTempSettings((settingsPath, dir) => {
    const forms = (repo: string): string[] => [
      `git:github.com/SATUNIX/${repo}`,
      `git:github.com/SATUNIX/${repo}.git@v0.2.4`,
      `git:git@GITHUB.COM:sAtUnIx/${repo}.git@feature/bridge`,
      `https://GITHUB.COM/SATUNIX/${repo}.git@next`,
      `http://github.com/SATUNIX/${repo}@v0.2.4`,
      `ssh://git@GITHUB.COM:2222/SATUNIX/${repo}.git@feature/bridge`,
      `git:https://github.com/SATUNIX/${repo}@main`,
      `git:ssh://git@github.com/SATUNIX/${repo}.git`,
      `git:git://github.com/SATUNIX/${repo}@next`,
    ];
    const foreign = [
      "git:github.com/alice/luna", "git:gitlab.com/x/luna", "npm:luna", "npm:luna@next",
      "git:github.com.evil.invalid/SATUNIX/luna", "git:github.com/SATUNIX/luna-extra",
      "git:github.com/SATUNIX/sub/luna", "npm:@alice/luna", "npm:@satunix/luna-extra",
    ];
    const localNames = ["@satunix/pi-system", "@satunix/luna", "pi-system", "luna"];
    const locals = localNames.map((name, i) => {
      const root = path.join(dir, `local-${i}`);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
      return root;
    });
    const recognised = [...forms("pi-system"), ...forms("luna"),
      "git:gitlab.com/other/pi-system@feature/bridge",
      ...["@satunix/pi-system", "@satunix/luna"].flatMap((name) => ["", "@next", "@0.2.4"].map((ref) => `npm:${name}${ref}`)),
      ...locals.slice(0, 3),
    ];
    const survivors = [...foreign, locals[3]];
    const selected = { source: ROOT, extensions: ["keep-filter"], themes: ["keep-theme"] };
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: [selected, ...recognised, ...survivors] }));
    assert.equal(removeOtherKitEntries(settingsPath, ROOT), recognised.length);
    assert.deepEqual(readSettings(settingsPath).packages, [selected, ...survivors]);
    assert.equal(removeOtherKitEntries(settingsPath, ROOT), 0);
    // Installing the new identity also removes the old one, preserving its own filters.
    const luna = { source: "npm:@satunix/luna@next", extensions: ["keep-filter"] };
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:@satunix/pi-system", luna, ...foreign] }));
    assert.equal(removeOtherKitEntries(settingsPath, "npm:@satunix/luna"), 1);
    assert.deepEqual(readSettings(settingsPath).packages, [luna, ...foreign]);
  });
}

const tests: Array<[name: string, fn: () => void]> = [
  ["installer derives firewall.json from the profile", testFirewallConfigFromProfile],
  ["quick profile resolves to a proper subset, no stubs", testQuickProfileResolvesToSubset],
  ["mergePackageBlock narrows a local-mode entry in place", testMergePackageBlockNarrowsLocalEntry],
  ["mergePackageBlock narrows a git-mode entry in place", testMergePackageBlockNarrowsGitEntry],
  ["external companion names excluded from the package filter", testExternalNamesExcludedFromFilter],
  ["mergePackageBlock throws instead of double-registering", testMergePackageBlockThrowsWithoutExistingEntry],
  ["checkout install removes every other copy of the kit", testRemoveOtherKitEntriesForCheckout],
  ["npm install removes every other copy of the kit", testRemoveOtherKitEntriesForNpm],
  ["identity bridge cleanup preserves unrelated Luna packages", testIdentityBridgeCleanup],
  ["npm entries match across channels and keep their channel", testNpmEntryMatchesAcrossChannels],
  ["lite profile allowlists hide every other skill and prompt", testLiteProfileAllowlists],
  ["pi-lean-ctx is installed only when its binary prerequisite exists", testLeanCtxPrerequisiteDetection],
  ["resolveProfile throws on unresolved names", testUnresolvedNameThrows],
  ["globalAgentDir respects PI_CODING_AGENT_DIR", testGlobalAgentDirRespectsPiCodingAgentDirEnvVar],
  ["mergePackageBlock preserves unowned keys and applies profile filters", testMergePackageBlockPreservesAndSetsFilters],
  ["updateSettings refuses to rewrite an unparseable settings file", testUpdateSettingsRefusesInvalidJson],
  ["profile skill/prompt filters and overrides resolve as documented", testProfileSkillAndOverrideResolution],
  ["captureDrift records only hand-made changes", testCaptureDrift],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

restoreKitEnv();
if (failed > 0) {
  console.error(`\n[install-profile-filter-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[install-profile-filter-smoke] all ${tests.length} checks passed`);
