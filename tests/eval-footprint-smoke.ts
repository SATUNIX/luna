#!/usr/bin/env node
/**
 * Small-model floor (V-81). The footprint meter itself (`packages/core/eval/footprint.ts`) is a
 * development tool and its measurements are not pinned here: they would change with every kit-text edit.
 *
 * Pinned: `lite` carries compaction settings sized for a small window, those settings reach
 * pi's settings.json through the profile's `settings` block (the consumer in lib/profiles.ts)
 * without touching any other key, plan-valid rate is counted per model, and the live-only
 * plan-valid fixture stays offline unless its operator-run gate is set.
 *
 * Deterministic and offline: fake pi, temp HOME and PI_CODING_AGENT_DIR, no model.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, rmWorkspace, ROOT, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import {
  applyProfileSettings,
  loadProfileDef,
  ownedSettingKeys,
  parseProfile,
  profileSettingsKeys,
  readProfileSettingsRecord,
  removeProfileSettings,
  writeProfileSettingsRecord,
  type Profile,
} from "../packages/core/lib/profiles.ts";
import { planValidRate } from "../packages/core/eval/footprint.ts";
import { fixtures } from "../packages/core/eval/fixtures.ts";

// ---- helpers ---------------------------------------------------------------------------------

// The written settings.json of a scratch install, read as the untrusted JSON it is.
function readSettingsFile(file: string): Record<string, unknown> {
  const parsed: unknown = parseJson(fs.readFileSync(file, "utf8"));
  assert.ok(isRecord(parsed), `${file} must hold a JSON object`);
  return parsed;
}

function settingsBlock(settings: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = settings[key];
  assert.ok(isRecord(value), `settings.${key} must be an object, got ${JSON.stringify(value)}`);
  return value;
}

// ---- e. lite compaction settings, and the profile settings consumer -------------------------

const OWNED_COMPACTION_KEYS = ["compaction.enabled", "compaction.reserveTokens", "compaction.keepRecentTokens"] as const;

function assertLiteCompactionSettings(def: Profile): void {
  const compaction = def.settings?.compaction;
  assert.ok(compaction, "the lite profile carries a settings.compaction block");
  assert.equal(compaction.enabled, true, "lite turns pi auto-compaction on");
  const reserve = compaction.reserveTokens;
  const keep = compaction.keepRecentTokens;
  assert.ok(typeof reserve === "number" && reserve > 0, "lite sets a positive reserveTokens");
  assert.ok(reserve < 16384, `reserveTokens ${String(reserve)} is below pi's 16,384 default reserve`);
  assert.ok(typeof keep === "number" && keep > 0, "lite sets a positive keepRecentTokens");
  assert.ok(
    reserve + keep + 4096 <= 28672,
    `reserve ${String(reserve)} + keep ${String(keep)} + the 4,096 safety margin must leave a 32k window a real trigger (got ${String(reserve + keep + 4096)})`,
  );
}

function testLiteCompactionAndConsumer(): void {
  const lite = loadProfileDef("lite");
  assertLiteCompactionSettings(lite);

  // The field is validated, not carried: a bad block stops the profile with the field named.
  assert.throws(
    () => parseProfile({ name: "bad", include: [], settings: { compaction: { enabled: "yes" } } }, "bad.json"),
    /settings\.compaction\.enabled/,
    "a non-boolean enabled is refused",
  );
  assert.throws(
    () => parseProfile({ name: "bad", include: [], settings: { compaction: { reserveTokens: -1 } } }, "bad.json"),
    /settings\.compaction\.reserveTokens/,
    "a non-positive token count is refused",
  );
  assert.throws(
    () => parseProfile({ name: "bad", include: [], settings: { compaction: { keepRecentTokens: Number.NaN } } }, "bad.json"),
    /settings\.compaction\.keepRecentTokens/,
    "a non-finite token count is refused",
  );
  assert.throws(
    () => parseProfile({ name: "bad", include: [], settings: { compaction: { reserve: 4096 } } }, "bad.json"),
    /settings\.compaction\.reserve/,
    "an unknown compaction key is refused",
  );
  // pi's SettingsManager.getCompactionTokenSetting throws on anything but a safe integer, so a
  // fraction (or 1e300, which is finite but not a safe integer) must never reach settings.json.
  assert.throws(
    () => parseProfile({ name: "bad", include: [], settings: { compaction: { reserveTokens: 4096.5 } } }, "bad.json"),
    /settings\.compaction\.reserveTokens/,
    "a fractional token count is refused",
  );
  assert.throws(
    () => parseProfile({ name: "bad", include: [], settings: { compaction: { keepRecentTokens: 1e300 } } }, "bad.json"),
    /settings\.compaction\.keepRecentTokens/,
    "a token count that is not a safe integer is refused",
  );

  const ws = tmpWorkspace("pi-footprint-settings-");
  try {
    const settingsPath = path.join(ws, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "t", compaction: { enabled: false } }));

    const applied = applyProfileSettings(lite, settingsPath, readProfileSettingsRecord(path.join(ws, "absent.json")));
    assert.deepEqual(applied.warnings, [], "lite applies without warnings");
    const written = readSettingsFile(settingsPath);
    assert.equal(written.theme, "t", "an unrelated pi setting survives");
    const compaction = settingsBlock(written, "compaction");
    assert.equal(compaction.enabled, true, "compaction.enabled is written");
    assert.equal(compaction.reserveTokens, lite.settings?.compaction?.reserveTokens, "reserveTokens is written");
    assert.equal(compaction.keepRecentTokens, lite.settings?.compaction?.keepRecentTokens, "keepRecentTokens is written");

    // What a profile install records as its own, so a later switch puts the operator's values back.
    assert.deepEqual(profileSettingsKeys(lite), [...OWNED_COMPACTION_KEYS].sort(), "lite sets the three compaction keys");
    assert.deepEqual(profileSettingsKeys(loadProfileDef("balanced")), [], "a profile with no settings block sets no key");
    assert.deepEqual(ownedSettingKeys(applied.record), [...OWNED_COMPACTION_KEYS].sort(), "lite owns the three compaction keys");
    assert.deepEqual(ownedSettingKeys({ previous: {} }), [], "a profile with no settings block owns nothing");
    const record = path.join(ws, "pi-kit", "profile-settings.json");
    writeProfileSettingsRecord(applied.record, record);
    assert.deepEqual(readProfileSettingsRecord(record), applied.record, "the ownership record round-trips");
    assert.deepEqual(readProfileSettingsRecord(path.join(ws, "absent.json")), { previous: {} }, "an absent record owns nothing");

    // A key next to the owned ones that the profile does not set must survive the removal.
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "t", compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 6000, keepTokens: "operators-own" } }));
    assert.deepEqual(removeProfileSettings(settingsPath, applied.record), [], "removal reports no warnings");
    const removed = readSettingsFile(settingsPath);
    assert.equal(removed.theme, "t", "the unrelated top-level setting survives removal");
    const rest = settingsBlock(removed, "compaction");
    assert.deepEqual(Object.keys(rest).sort(), ["enabled", "keepTokens"], "only the kit-owned compaction keys are restored or removed");
    assert.equal(rest.enabled, false, "the operator's own enabled comes back, not the value the profile wrote");
    assert.equal(rest.keepTokens, "operators-own", "the operator's own compaction key keeps its value");

    // A profile with no settings block changes nothing, and the mechanism owns nothing afterwards.
    const before = fs.readFileSync(settingsPath, "utf8");
    const none = applyProfileSettings(loadProfileDef("balanced"), settingsPath, { previous: {} });
    assert.deepEqual(none.warnings, [], "a profile without a settings block writes nothing");
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before, "settings.json is untouched by a profile without a settings block");

  } finally {
    rmWorkspace(ws);
  }
}
// ---- f. the operator's own settings survive a profile switch and an uninstall ------------------
/** `settings.compaction` of a settings.json, or undefined when the key is gone. */
function compactionOf(file: string): Record<string, unknown> | undefined {
  const block = readSettingsFile(file).compaction;
  return isRecord(block) ? block : undefined;
}
// The finding this pins: applyProfileSettings wrote lite's numbers over the operator's chosen
// values and recorded only the key names, so switching away deleted them. The operator's
// compaction.enabled:false and reserveTokens:20000 must come back when the profile releases them.
function testProfileSettingsRestore(): void {
  const lite = loadProfileDef("lite");
  const balanced = loadProfileDef("balanced");
  const ws = tmpWorkspace("pi-footprint-restore-");
  try {
    const settingsPath = path.join(ws, "settings.json");
    const recordPath = path.join(ws, "pi-kit", "profile-settings.json");
    const operator = { enabled: false, reserveTokens: 20000 };
    fs.writeFileSync(settingsPath, JSON.stringify({ compaction: operator }));
    // What install.ts does: apply the profile, then record the keys it now owns.
    const install = (def: Profile): void => {
      const result = applyProfileSettings(def, settingsPath, readProfileSettingsRecord(recordPath));
      assert.deepEqual(result.warnings, [], `profile "${String(def.name)}" applies without warnings`);
      if (ownedSettingKeys(result.record).length > 0) writeProfileSettingsRecord(result.record, recordPath);
      else fs.rmSync(recordPath, { force: true });
    };
    install(lite);
    const first = compactionOf(settingsPath);
    assert.ok(first, "lite writes a compaction block");
    assert.equal(first.enabled, true, "lite turns auto-compaction on");
    assert.equal(first.reserveTokens, 4096, "lite's reserveTokens reaches settings.json");
    assert.equal(first.keepRecentTokens, 6000, "lite's keepRecentTokens reaches settings.json");

    // A lite reinstall must not record lite's own numbers as the operator's.
    install(lite);
    const recorded = readProfileSettingsRecord(recordPath).previous["compaction.reserveTokens"];
    assert.deepEqual(recorded, { present: true, value: 20000, wrote: 4096 }, "a reinstall keeps the operator's own value on record");
    // Switching to a profile with no settings block puts the operator's values back.
    install(balanced);
    assert.deepEqual(compactionOf(settingsPath), operator, "the operator's own compaction values come back");
    assert.ok(!fs.existsSync(recordPath), "a profile with no settings block leaves no ownership record");
    // A value the operator changed while lite was installed is theirs, not the record's.
    install(lite);
    const edited = readSettingsFile(settingsPath);
    settingsBlock(edited, "compaction").reserveTokens = 8192;
    fs.writeFileSync(settingsPath, JSON.stringify(edited));
    install(balanced);
    assert.equal(compactionOf(settingsPath)?.reserveTokens, 8192, "a value the operator changed while the profile was active is left alone");
    assert.equal(compactionOf(settingsPath)?.enabled, false, "the untouched key still comes back");
  } finally {
    rmWorkspace(ws);
  }
}
// The second finding: uninstall removed the kit but left the profile's compaction keys in pi's
// global settings.json, so pi kept compacting with lite's 4,096-token reserve on every model.
function testUninstallRestoresCompaction(): void {
  const ws = tmpWorkspace("pi-kit-footprint-uninstall-");
  try {
    const agentDir = path.join(ws, "agent");
    const binDir = path.join(ws, "bin");
    const home = path.join(ws, "home");
    for (const dir of [agentDir, binDir, home]) fs.mkdirSync(dir, { recursive: true });
    // A fake pi logs its arguments and exits 0: no real installation is touched. The kit is already
    // registered, so the --settings-only install narrows that entry instead of running pi install.
    const logPath = path.join(ws, "pi-calls.log");
    fs.writeFileSync(path.join(binDir, "pi"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexit 0\n`, { mode: 0o755 });
    const settingsPath = path.join(agentDir, "settings.json");
    const operator = { enabled: false, reserveTokens: 20000 };
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: [ROOT], compaction: operator }));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_LEAN_CTX_BIN: path.join(agentDir, "definitely-not-installed-lean-ctx"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const runScript = (script: string, args: string[]): string => {
      const result = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", script), ...args], { cwd: ws, env, encoding: "utf8" });
      assert.equal(result.status, 0, `${script} ${args.join(" ")} exited ${String(result.status)}: ${result.stdout}\n${result.stderr}`);
      return `${result.stdout}\n${result.stderr}`;
    };
    runScript("install.ts", ["--profile", "lite", "--no-externals", "--settings-only", "--mode", "local", "--scope", "global"]);
    assert.equal(compactionOf(settingsPath)?.reserveTokens, 4096, "the install writes lite's reserveTokens");
    const recordPath = path.join(agentDir, "pi-kit", "profile-settings.json");
    assert.ok(fs.existsSync(recordPath), "the install records the pi settings the profile owns");
    runScript("uninstall.ts", ["--scope", "global", "--yes"]);
    assert.deepEqual(compactionOf(settingsPath), operator, "uninstall puts the operator's own compaction values back");
    assert.ok(fs.readFileSync(logPath, "utf8").split("\n").includes(`remove ${ROOT}`), "uninstall removes the kit registration");
    assert.ok(!fs.existsSync(recordPath), "uninstall drops the ownership record");
  } finally {
    rmWorkspace(ws);
  }
}

// ---- f. plan-valid rate per model -----------------------------------------------------------

function testPlanValidRate(): void {
  const isValid = (plan: unknown): boolean => isRecord(plan) && plan.valid === true;
  const records: readonly unknown[] = [
    { model: "small-a", steps: { valid: true } },
    { model: "small-a", steps: { valid: false } },
    { model: "small-a", steps: "not a plan" },
    { model: "small-b", steps: { valid: true } },
    { model: "small-b" }, // no steps: the whole record is the plan
    { model: "" }, // no usable model: ignored
    { model: 7 },
    { steps: { valid: true } }, // no model at all
    "not an object",
    null,
  ];
  const rate = planValidRate(records, isValid);
  assert.equal(rate.total, 5, "only records with a usable model are counted");
  assert.deepEqual(Object.keys(rate.perModel).sort(), ["small-a", "small-b"]);
  assert.deepEqual({ ...rate.perModel["small-a"] }, { total: 3, valid: 1, rate: 0.333 });
  assert.deepEqual({ ...rate.perModel["small-b"] }, { total: 2, valid: 1, rate: 0.5 });
}

// ---- g. the live-only fixture is registered and does nothing offline ------------------------

async function testLiveOnlyFixtureIsSkippedOffline(): Promise<void> {
  const fixture = fixtures.find((f) => f.name === "small-model/plan-valid-rate");
  assert.ok(fixture, "the plan-valid fixture is registered in eval/fixtures.ts");
  const restore = setEnv("PI_KIT_PLAN_RATE_FILE", undefined);
  try {
    // Unset gate: returns before reading anything or reaching any model.
    await fixture.run();
  } finally {
    restore();
  }
}

// ---- h. the --category gate refuses a missing or unknown value -------------------------------
// The finding: `--category` with no value ran every fixture and exited 0, a false green from the
// regression gate. A value naming no category was refused only as a side effect of running zero
// fixtures, without saying the category was unknown. Both must be an explicit exit 2.
function testEvalCategoryGate(): void {
  const ws = tmpWorkspace("pi-footprint-eval-category-");
  try {
    const agentDir = path.join(ws, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const policyPath = path.join(ws, "firewall.json");
    fs.writeFileSync(policyPath, JSON.stringify({ defaults: { unknown: "allow" }, tools: {}, command_rules: { deny: [], ask: [] } }));
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_KIT_FIREWALL_POLICY: policyPath };
    const run = (args: string[]): { status: number | null; stderr: string } => {
      const result = spawnSync(process.execPath, ["packages/core/eval/run.ts", ...args], { cwd: ROOT, env, encoding: "utf8" });
      return { status: result.status, stderr: result.stderr ?? "" };
    };
    const unknown = run(["--category", "__no_such_category__"]);
    assert.notEqual(unknown.status, 0, "an unknown category must not exit 0");
    assert.match(unknown.stderr, /unknown category/, "an unknown category is named on stderr");
    const missing = run(["--category"]);
    assert.notEqual(missing.status, 0, "a --category with no value must not exit 0");
  } finally {
    rmWorkspace(ws);
  }
}

/** The CLI V-81 documents: measure a profile, print JSON, and record a baseline byte-identically. */
// ---- runner ---------------------------------------------------------------------------------

const tests: Array<[string, () => void | Promise<void>]> = [
  ["lite compaction settings are sized for a small window and reach pi's settings.json", testLiteCompactionAndConsumer],
  ["a profile switch and an uninstall put the operator's own compaction values back", testProfileSettingsRestore],
  ["uninstall leaves no profile compaction key in the global settings.json", testUninstallRestoresCompaction],
  ["plan-valid rate per model, malformed records ignored", testPlanValidRate],
  ["the live-only plan-valid fixture is registered and skipped offline", testLiveOnlyFixtureIsSkippedOffline],
  ["the eval --category gate refuses an unknown or missing value", testEvalCategoryGate],
  ];

const restoreEnv = isolateKitEnv();
let failed = 0;
try {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  OK: ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(`    ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`);
    }
  }
} finally {
  restoreEnv();
}
if (failed > 0) {
  console.error(`\n[eval-footprint-smoke] ${String(failed)}/${String(tests.length)} FAILED`);
  process.exit(1);
}
console.log(`\n[eval-footprint-smoke] all ${String(tests.length)} checks passed`);
