#!/usr/bin/env node
/**
 * The slash-command contract (packages/core/lib/command-contract.ts), which `npm run verify`
 * enforces. Two layers:
 *
 *   1. the pure rule set, over hand-built fixtures: duplicate names, commands that shadow a prompt
 *      template or a pi built-in, and manifest/code drift;
 *   2. the checkout itself, plus a parity check of the built-in name copy in
 *      packages/core/lib/pi-builtins.ts against the installed pi dist: an exact match at the
 *      pinned pi, and a superset of the installed names at any other supported pi.
 *
 * Hermetic and offline: it reads repository and node_modules files only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  bareCommandName,
  buildCommandContractInput,
  commandContractProblems,
  registeredCommandsInSource,
  type CommandContractInput,
} from "../packages/core/lib/command-contract.ts";
import {
  PI_BUILTIN_EXTENSION_COMMANDS,
  PI_BUILTIN_SLASH_COMMANDS,
  PI_BUILTIN_TESTED_VERSION,
  piBuiltinCommandNames,
} from "../packages/core/lib/pi-builtins.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";

const ROOT = path.resolve(".");
const PI_DIR = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");

/** A minimal clean input: one extension, no collisions. */
function input(overrides: Partial<CommandContractInput> = {}): CommandContractInput {
  return {
    extensions: [{ label: "first-party/alpha", name: "alpha", manifestCommands: ["effort"], codeCommands: ["effort"] }],
    promptTemplates: ["code-plan"],
    builtinCommands: piBuiltinCommandNames(),
    ...overrides,
  };
}

const codes = (problems: ReturnType<typeof commandContractProblems>): string[] => problems.map((p) => p.code);

function testCleanInputHasNoProblems() {
  assert.deepEqual(commandContractProblems(input()), [], "a consistent input must produce no problems");
}

function testLeadingSlashIsNormalised() {
  assert.equal(bareCommandName("/effort"), "effort");
  assert.equal(bareCommandName("effort"), "effort");
  const problems = commandContractProblems(
    input({ extensions: [{ label: "first-party/alpha", name: "alpha", manifestCommands: ["/effort"], codeCommands: ["effort"] }] }),
  );
  assert.deepEqual(problems, [], "a manifest '/' prefix must not read as drift");
}

function testDuplicateCommandIsReported() {
  const problems = commandContractProblems(
    input({
      extensions: [
        { label: "first-party/alpha", name: "alpha", manifestCommands: ["shared"], codeCommands: ["shared"] },
        { label: "third-party/beta", name: "beta", manifestCommands: ["shared"], codeCommands: ["shared"] },
      ],
    }),
  );
  assert.ok(codes(problems).includes("duplicate-command"), `expected duplicate-command in ${codes(problems).join(",")}`);
  const message = problems.find((p) => p.code === "duplicate-command")?.message ?? "";
  assert.match(message, /first-party\/alpha/);
  assert.match(message, /third-party\/beta/);
}

function testPromptShadowIsReported() {
  const problems = commandContractProblems(
    input({ promptTemplates: ["effort"], extensions: [{ label: "first-party/alpha", name: "alpha", manifestCommands: ["effort"], codeCommands: ["effort"] }] }),
  );
  assert.deepEqual(codes(problems), ["shadows-prompt"], "a command named like a prompt template must be reported");
}

function testBuiltinShadowIsReported() {
  const problems = commandContractProblems(
    input({
      builtinCommands: ["compact"],
      extensions: [{ label: "first-party/alpha", name: "alpha", manifestCommands: ["compact"], codeCommands: ["compact"] }],
    }),
  );
  assert.deepEqual(codes(problems), ["shadows-builtin"], "a command named like a pi built-in must be reported");
}

function testManifestDriftIsReported() {
  const missing = commandContractProblems(
    input({ extensions: [{ label: "first-party/alpha", name: "alpha", manifestCommands: [], codeCommands: ["effort"] }] }),
  );
  assert.deepEqual(codes(missing), ["manifest-drift"], "a command registered in code but absent from extension.json must be reported");
  const extra = commandContractProblems(
    input({ extensions: [{ label: "first-party/alpha", name: "alpha", manifestCommands: ["effort"], codeCommands: [] }] }),
  );
  assert.deepEqual(codes(extra), ["manifest-drift"], "a command declared but not registered must be reported");
}

function testRegisteredCommandsInSource() {
  const src = `
    pi.registerCommand("one", { description: "a" });
    // pi.registerCommand("commented-out", {});
    pi.registerCommand('two', {});
    pi.registerCommand(variableName, {});
  `;
  assert.deepEqual(registeredCommandsInSource(src), ["one", "two"], "only literal registerCommand names are collected");
}

function testCheckoutHasNoContractProblems() {
  const problems = commandContractProblems(buildCommandContractInput());
  assert.deepEqual(
    problems.map((p) => p.message),
    [],
    "the checkout must satisfy the command contract (manifest command names normalised to bare, no duplicates, no shadows)",
  );
}

/** The pi version the repository pins in the root package.json `devDependencies`. */
function pinnedPiVersion(): string {
  const pkg = parseJson(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const dev = isRecord(pkg) && isRecord(pkg.devDependencies) ? pkg.devDependencies : {};
  const pin = dev["@earendil-works/pi-coding-agent"];
  return typeof pin === "string" ? pin : "";
}

/** The installed pi's version, from its package.json. */
function installedPiVersion(): string {
  const pkg = parseJson(fs.readFileSync(path.join(PI_DIR, "package.json"), "utf8"));
  return isRecord(pkg) && typeof pkg.version === "string" ? pkg.version : "";
}

/** The names in the installed pi's `BUILTIN_SLASH_COMMANDS` (dist/core/slash-commands.js). */
function installedSlashCommands(): string[] {
  const distFile = path.join(PI_DIR, "dist", "core", "slash-commands.js");
  assert.ok(fs.existsSync(distFile), `installed pi dist not found at ${distFile}`);
  const src = fs.readFileSync(distFile, "utf8");
  const start = src.indexOf("BUILTIN_SLASH_COMMANDS");
  assert.ok(start >= 0, "BUILTIN_SLASH_COMMANDS not found in the installed pi dist");
  const end = src.indexOf("];", start);
  assert.ok(end > start, "BUILTIN_SLASH_COMMANDS array has no terminator");
  const block = src.slice(start, end);
  return [...block.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]).filter((n): n is string => typeof n === "string");
}

/** The literal `registerCommand("...")` names in the installed pi's built-in extensions (dist/extensions/<name>/index.js). */
function installedExtensionCommands(): string[] {
  const extDir = path.join(PI_DIR, "dist", "extensions");
  assert.ok(fs.existsSync(extDir), `installed pi built-in extensions not found at ${extDir}`);
  const names: string[] = [];
  for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
    const indexFile = path.join(extDir, entry.name, "index.js");
    if (!entry.isDirectory() || !fs.existsSync(indexFile)) continue;
    names.push(...registeredCommandsInSource(fs.readFileSync(indexFile, "utf8")));
  }
  return names;
}

const sorted = (names: readonly string[]): string[] => [...new Set(names)].sort((a, b) => a.localeCompare(b));

/**
 * At the pinned pi the copy must match exactly: that is the signal to refresh it after a pi
 * upgrade. At any other supported pi (the compat lanes install 0.85.1 and 0.99.2 over the pin)
 * the installed names must be a subset of the copy, so that a kit command shadowing a built-in on
 * any supported pi is still rejected; a pi that adds a built-in the copy lacks still fails.
 */
function testBuiltinListMatchesInstalledPi() {
  const pinned = pinnedPiVersion();
  assert.equal(PI_BUILTIN_TESTED_VERSION, pinned, "PI_BUILTIN_TESTED_VERSION must name the pi version pinned in devDependencies");
  assert.ok(PI_BUILTIN_EXTENSION_COMMANDS.length > 0, "the built-in extension command list must not be empty");
  const slash = installedSlashCommands();
  const ext = installedExtensionCommands();
  assert.ok(slash.length > 0, "no BUILTIN_SLASH_COMMANDS names parsed from the installed pi dist");
  if (installedPiVersion() === pinned) {
    assert.deepEqual(
      sorted(slash),
      sorted(PI_BUILTIN_SLASH_COMMANDS),
      "packages/core/lib/pi-builtins.ts is stale: update it to the installed pi's BUILTIN_SLASH_COMMANDS and bump PI_BUILTIN_TESTED_VERSION",
    );
    assert.deepEqual(
      sorted(ext),
      sorted(PI_BUILTIN_EXTENSION_COMMANDS),
      "PI_BUILTIN_EXTENSION_COMMANDS is stale: update it to the installed pi's built-in extension commands",
    );
    return;
  }
  assert.deepEqual(
    slash.filter((n) => !PI_BUILTIN_SLASH_COMMANDS.includes(n)),
    [],
    "the installed pi has built-in slash commands missing from packages/core/lib/pi-builtins.ts",
  );
  assert.deepEqual(
    ext.filter((n) => !PI_BUILTIN_EXTENSION_COMMANDS.includes(n)),
    [],
    "the installed pi has built-in extension commands missing from PI_BUILTIN_EXTENSION_COMMANDS",
  );
}

const tests: Array<[name: string, fn: () => void]> = [
  ["a consistent input produces no problems", testCleanInputHasNoProblems],
  ["a leading '/' in a manifest is normalised", testLeadingSlashIsNormalised],
  ["a command registered by two extensions is reported", testDuplicateCommandIsReported],
  ["a command named like a prompt template is reported", testPromptShadowIsReported],
  ["a command named like a pi built-in is reported", testBuiltinShadowIsReported],
  ["manifest/code drift is reported in both directions", testManifestDriftIsReported],
  ["registeredCommandsInSource collects literal names only", testRegisteredCommandsInSource],
  ["the checkout satisfies the command contract", testCheckoutHasNoContractProblems],
  ["the built-in copy matches the pinned pi dist and covers any other installed pi", testBuiltinListMatchesInstalledPi],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\n[command-contract-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[command-contract-smoke] all ${tests.length} checks passed`);
