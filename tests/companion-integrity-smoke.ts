#!/usr/bin/env node
/**
 * Companion installs are pinned, script-free and integrity-checked (packages/core/lib/companions.ts).
 *   - every reference companion in packages/core/sources.json names an exact npm version and the
 *     package's sha512 integrity, and the JSON schema accepts only a sha512 value;
 *   - `pi install` for a companion runs with npm_config_ignore_scripts=true, unless the entry
 *     records a reviewed allowInstallScripts reason;
 *   - after the install, the integrity npm recorded in pi's npm-root package-lock.json must equal
 *     the pin: a different value removes the package again and fails the install; a matching one
 *     passes; a root without a lockfile entry is a warning.
 *   - a skill filter declared for a companion in sources.json (`skills`, pi-lens's is `[]`) is written
 *     onto its settings.json entry, whether the run registered the companion or it was registered
 *     already, and an entry that has a filter of its own keeps it.
 * Hermetic: the real install.ts runs against a fake `pi` that logs its argv and environment and
 * copies a prepared lockfile into the npm root. No network, no real npm.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../packages/core/eval/harness.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import { checkInstalledIntegrity, companionInstallEnv, companionPinProblems, isSha512Integrity, npmSpec, piNpmRoot } from "../packages/core/lib/companions.ts";
import { runPi } from "../packages/core/lib/pi-cli.ts";
import { readSources, type ExternalSource } from "../packages/core/lib/sources.ts";

const INSTALL = path.join(ROOT, "packages", "core", "install.ts");
const { external } = readSources(path.join(ROOT, "packages", "core", "sources.json"));
const reference = external.filter((e) => e.mode === "reference");
assert.ok(reference.length >= 2, "sources.json lists reference companions");

// --- the pins ----------------------------------------------------------------------------------
for (const e of reference) {
  assert.deepEqual(companionPinProblems(e), [], `${e.name} is pinned to an exact version and its sha512 integrity`);
  assert.equal(e.allowInstallScripts, undefined, `${e.name} installs with lifecycle scripts off (no allowInstallScripts)`);
}
const schema = parseJson(fs.readFileSync(path.join(ROOT, "packages", "core", "schema", "sources.schema.json"), "utf8"));
const integrityPattern = isRecord(schema) && isRecord(schema.properties) && isRecord(schema.properties.external) && isRecord(schema.properties.external.items) && isRecord(schema.properties.external.items.properties) && isRecord(schema.properties.external.items.properties.integrity) ? schema.properties.external.items.properties.integrity.pattern : undefined;
assert.equal(integrityPattern, "^sha512-[A-Za-z0-9+/]{86}==$", "the schema accepts only a sha512 integrity");

const sample: ExternalSource = { name: "example-companion", mode: "reference", source: "npm:example-companion@1.2.3", integrity: `sha512-${"A".repeat(86)}==` };
assert.deepEqual(npmSpec("npm:@scope/pkg@1.0.0-beta.1"), { name: "@scope/pkg", version: "1.0.0-beta.1" });
for (const loose of ["npm:example-companion", "npm:example-companion@^1.2.3", "npm:example-companion@latest", "git:example.invalid/x"]) {
  assert.equal(npmSpec(loose), null, `${loose} is not an exact npm source`);
  assert.match(companionPinProblems({ ...sample, source: loose }).join(""), /not an exact npm/);
}
assert.match(companionPinProblems({ name: sample.name, mode: sample.mode, source: sample.source }).join(""), /sha512 dist\.integrity/, "a missing integrity is a problem");
assert.match(companionPinProblems({ ...sample, integrity: "sha1-AAAA" }).join(""), /sha512 dist\.integrity/, "a weaker hash is a problem");
assert.equal(isSha512Integrity(sample.integrity), true);
assert.match(companionPinProblems({ ...sample, allowInstallScripts: "yes" }).join(""), /reviewed reason/, "allowInstallScripts needs a real reason");
assert.deepEqual(companionInstallEnv(sample), { npm_config_ignore_scripts: "true" });
assert.deepEqual(companionInstallEnv({ allowInstallScripts: "builds a native addon that has no prebuilt binary" }), {});
assert.equal(piNpmRoot("global", "/agent", "/work"), path.join("/agent", "npm"));
assert.equal(piNpmRoot("project", "/agent", "/work"), path.join("/work", ".pi", "npm"));

// runPi passes the extra variables on top of the inherited environment.
{
  let seen: NodeJS.ProcessEnv | undefined;
  // A spawn double: it records the options and returns only the status runPi reads, so it is cast to spawnSync's overloaded type (as tests/pi-cli-smoke.ts does).
  const spawn = ((_command: string, _args: readonly string[], options: SpawnSyncOptions): Pick<SpawnSyncReturns<Buffer>, "status"> => { seen = options.env; return { status: 0 }; }) as typeof spawnSync;
  runPi("pi", ["install", sample.source], { spawn, platform: "linux", env: { npm_config_ignore_scripts: "true" } });
  assert.equal(seen?.npm_config_ignore_scripts, "true");
  assert.equal(seen?.PATH, process.env.PATH, "the rest of the environment is inherited");
  runPi("pi", ["list"], { spawn, platform: "linux" });
  assert.equal(seen, undefined, "without env the child inherits the environment unchanged");
}

// checkInstalledIntegrity against lockfiles.
const lockFor = (entries: Array<[string, string, string]>): string => {
  const packages: Record<string, { version?: string; integrity?: string }> = { "": {} };
  for (const [name, version, integrity] of entries) packages[`node_modules/${name}`] = { version, integrity };
  return JSON.stringify({ name: "npm", lockfileVersion: 3, packages });
};
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-companion-integrity-"));
try {
  const root = path.join(work, "root");
  fs.mkdirSync(root);
  const absent = checkInstalledIntegrity(root, sample);
  assert.ok(!absent.ok && absent.missing === true, "no lockfile: reported as missing, not as a pass");
  fs.writeFileSync(path.join(root, "package-lock.json"), lockFor([["example-companion", "1.2.3", sample.integrity ?? ""]]));
  assert.deepEqual(checkInstalledIntegrity(root, sample), { ok: true, integrity: sample.integrity });
  fs.writeFileSync(path.join(root, "package-lock.json"), lockFor([["example-companion", "1.2.3", `sha512-${"B".repeat(86)}==`]]));
  const changed = checkInstalledIntegrity(root, sample);
  assert.ok(!changed.ok && changed.missing === undefined && /npm recorded integrity/.test(changed.reason), "a different integrity fails");
  fs.writeFileSync(path.join(root, "package-lock.json"), lockFor([["example-companion", "1.2.4", sample.integrity ?? ""]]));
  const version = checkInstalledIntegrity(root, sample);
  assert.ok(!version.ok && /npm installed 1\.2\.4/.test(version.reason), "a different version fails");

  // --- the real installer -------------------------------------------------------------------------
  const installRun = (label: string, lock: string | null, seed?: object): { result: SpawnSyncReturns<string>; log: string[]; agentDir: string } => {
    const dir = path.join(work, label);
    const agentDir = path.join(dir, "agent");
    const binDir = path.join(dir, "bin");
    for (const d of [agentDir, binDir, path.join(dir, "home")]) fs.mkdirSync(d, { recursive: true });
    const logPath = path.join(dir, "pi-calls.log");
    const lockPath = path.join(dir, "prepared-lock.json");
    if (lock !== null) fs.writeFileSync(lockPath, lock);
    if (seed !== undefined) fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(seed));
    // The fake pi logs "<argv> | ignore-scripts=<value>" and, for an install, copies the prepared lockfile into pi's npm root
    // and registers an npm source as the bare string `pi install` writes (a source already listed is left as it is).
    const register = `const fs=require("fs"),p=process.env.PI_CODING_AGENT_DIR+"/settings.json";let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}s.packages=s.packages||[];if(!s.packages.some(e=>(e.source||e)===process.argv[1]))s.packages.push(process.argv[1]);fs.writeFileSync(p,JSON.stringify(s))`;
    fs.writeFileSync(path.join(binDir, "pi"), [
      "#!/bin/sh",
      `printf '%s | ignore-scripts=%s\\n' "$*" "\${npm_config_ignore_scripts:-unset}" >> "$PI_FAKE_LOG"`,
      `if [ "$1" = install ] && [ -f "$PI_FAKE_LOCK" ]; then mkdir -p "$PI_CODING_AGENT_DIR/npm" && cp "$PI_FAKE_LOCK" "$PI_CODING_AGENT_DIR/npm/package-lock.json"; fi`,
      `if [ "$1" = install ]; then case "$2" in npm:*) '${process.execPath}' -e '${register}' "$2";; esac; fi`,
      "exit 0",
      "",
    ].join("\n"));
    fs.chmodSync(path.join(binDir, "pi"), 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: path.join(dir, "home"),
      PI_CODING_AGENT_DIR: agentDir,
      PI_LEAN_CTX_BIN: path.join(agentDir, "definitely-not-installed-lean-ctx"),
      PI_FAKE_LOG: logPath,
      PI_FAKE_LOCK: lockPath,
      PI_KIT_FIREWALL_CONFIG: "",
      PI_KIT_SECURITY_CONFIG: "",
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const result = spawnSync(process.execPath, [INSTALL, "--all", "--settings-only", "--mode", "local"], { cwd: ROOT, env, encoding: "utf8" });
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
    return { result, log, agentDir };
  };
  const installed = reference.filter((e) => e.name !== "pi-lean-ctx");
  const pinned = (e: ExternalSource): [string, string, string] => { const s = npmSpec(e.source); assert.ok(s && e.integrity); return [s.name, s.version, e.integrity]; };

  const good = installRun("good", lockFor(installed.map(pinned)));
  assert.equal(good.result.status, 0, `${good.result.stdout}\n${good.result.stderr}`);
  const companionInstalls = good.log.filter((l) => installed.some((e) => l.startsWith(`install ${e.source}`)));
  assert.equal(companionInstalls.length, installed.length, good.log.join("\n"));
  for (const l of companionInstalls) assert.match(l, /\| ignore-scripts=true$/, `a companion install runs with lifecycle scripts off: ${l}`);
  for (const l of good.log.filter((x) => !companionInstalls.includes(x))) assert.match(l, /\| ignore-scripts=unset$/, `only companion installs get the variable: ${l}`);
  assert.ok(!good.log.some((l) => l.startsWith("remove ")), "matching integrities remove nothing");

  // The skill filter sources.json declares goes onto the registered entry: pi-lens loads none of its four
  // bundled skills (they cost every first request about 420 tokens); a companion with no declared filter stays a bare source.
  assert.deepEqual(external.find((e) => e.name === "pi-lens")?.skills, [], "sources.json declares pi-lens's skill filter as none");
  const registeredIn = (agentDir: string): unknown[] => {
    const settings: unknown = parseJson(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    return isRecord(settings) && Array.isArray(settings.packages) ? settings.packages : [];
  };
  const expectedEntry = (e: ExternalSource): unknown => (e.skills === undefined ? e.source : { source: e.source, skills: e.skills });
  assert.deepEqual(registeredIn(good.agentDir).filter((p) => installed.some((e) => (isRecord(p) ? p.source : p) === e.source)), installed.map(expectedEntry), "each installed companion is registered with the filter sources.json declares for it");
  assert.match(good.result.stdout, /pi-lens: skill filter applied/);

  // Registered before this run (a kit update re-applying its profile): no reinstall, but the filter is added.
  const lens = installed.find((e) => e.name === "pi-lens");
  assert.ok(lens);
  const upgraded = installRun("upgrade", lockFor(installed.map(pinned)), { packages: [lens.source] });
  assert.equal(upgraded.result.status, 0, `${upgraded.result.stdout}\n${upgraded.result.stderr}`);
  assert.ok(!upgraded.log.some((l) => l.startsWith(`install ${lens.source}`)), "a companion registered at its pin is not reinstalled");
  assert.deepEqual(registeredIn(upgraded.agentDir).find((p) => isRecord(p) && p.source === lens.source), { source: lens.source, skills: [] }, "and still gets the filter");

  // An entry that has a filter of its own keeps it: this is how an operator opts a companion's skills back in.
  const optedIn = { source: lens.source, skills: ["+skills/pi-lens-ast-grep"] };
  const kept = installRun("opted-in", lockFor(installed.map(pinned)), { packages: [optedIn] });
  assert.equal(kept.result.status, 0, `${kept.result.stdout}\n${kept.result.stderr}`);
  assert.deepEqual(registeredIn(kept.agentDir).find((p) => isRecord(p) && p.source === lens.source), optedIn, "an operator's own skills filter is left alone");
  assert.doesNotMatch(kept.result.stdout, /pi-lens: skill filter applied/);

  const target = installed[0];
  assert.ok(target);
  const tampered = installRun("tampered", lockFor(installed.map((e) => { const [n, v, i] = pinned(e); return [n, v, e === target ? `sha512-${"C".repeat(86)}==` : i]; })));
  assert.equal(tampered.result.status, 1, "a companion whose recorded integrity differs fails the install");
  assert.match(tampered.result.stderr, /npm recorded integrity sha512-C+==, sources\.json pins sha512-/);
  assert.ok(tampered.log.some((l) => l.startsWith(`remove ${target.source}`)), `the unreviewed package is removed again:\n${tampered.log.join("\n")}`);

  const noLock = installRun("no-lock", null);
  assert.equal(noLock.result.status, 0, noLock.result.stderr);
  assert.match(noLock.result.stderr, /WARNING: .*package-lock\.json is missing or unreadable/, "a root with no lockfile is warned about");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`[companion-integrity-smoke] OK (${reference.length} companions pinned with sha512; installs run with scripts off; a different recorded integrity removes the package and fails)`);
