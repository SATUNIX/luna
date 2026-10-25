#!/usr/bin/env node
/**
 * Verification gate. Runs on every push and before install.
 * Checks: schema validation, tsc --noEmit, self-containment lint,
 *         name-collision check, sources/manifest bundle cross-check.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { capabilityMatrixContent } from "./capability-matrix.ts";
import { extensionsCatalogueDrift, type ExtensionManifest } from "./registry.ts";
import { noticesContent } from "./gen-notices.ts";
import { checkDocsNav } from "./docs-nav-check.ts";
import { checkSharedCopies, SHARED_COPIES } from "./gen-shared.ts";
import { skillsCatalogueContent } from "./skills-catalogue.ts";
import { buildDistributionContract, distributionContractProblems } from "./distribution-contract.ts";
import { buildCommandContractInput, commandContractProblems } from "./lib/command-contract.ts";
import { isRecord, parseJson } from "./lib/guard.ts";
import { parseProfile, type Profile } from "./lib/profiles.ts";
import type { Sources } from "./lib/sources.ts";
import type AjvExports from "ajv";
import type { Schema as JsonSchema } from "ajv";
import { WORKSPACE_ROOT, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, SKILLS_DIR, SCHEMA_DIR, POLICIES_DIR, SOURCES_PATH, CORE_DIR } from "./lib/paths.ts";

const require = createRequire(import.meta.url);
const ROOT = WORKSPACE_ROOT;
const SCHEMA_PATH = path.join(SCHEMA_DIR, "extension.schema.json");
/** An extension.json that passed extension.schema.json (which requires these fields). */
type VerifiedManifest = ExtensionManifest & { entry: string; hooks: string[]; profiles: string[]; status: string };

/** A value decoded from a JSON file: a record of what `JSON.parse` can return, not a shape claim. */
type ParsedJson = string | number | boolean | null | ParsedJson[] | { [key: string]: ParsedJson };

// ajv is CommonJS: require() returns its module.exports, whose `default` is the Ajv class.
let Ajv: typeof AjvExports;
try {
  Ajv = require("ajv") as typeof AjvExports;
} catch {
  console.error("[verify] ajv not found — run: npm install --save-dev ajv");
  process.exit(1);
}

const ajv = new Ajv.default({ strict: false });

// Read + parse a JSON file. Wraps both the read and the parse so a corrupt or
// missing file yields a clear, labelled error instead of an opaque SyntaxError.
function readJsonFile(file: string): ParsedJson {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    return parseJson(text) as ParsedJson;
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

// A JSON Schema file: an object (or boolean) schema, or a labelled error.
function readSchemaFile(file: string): JsonSchema {
  const value = readJsonFile(file);
  if (isRecord(value) || typeof value === "boolean") return value;
  throw new Error(`invalid JSON schema in ${file}: not an object`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// What a failed step printed (a child process's stdout), else its message.
function errorOutput(error: unknown): string {
  if (isRecord(error)) {
    const out = error.stdout || error.message;
    if (typeof out === "string") return out;
    if (Buffer.isBuffer(out)) return out.toString();
  }
  return errorMessage(error);
}

// The value at `keys` inside nested JSON objects, or undefined.
function at(value: unknown, ...keys: string[]): ParsedJson | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current as ParsedJson | undefined;
}

// The string items of a JSON array (anything else reads as empty).
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// The items of a JSON array (anything else reads as empty).
function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const schema = readSchemaFile(SCHEMA_PATH);
const validate = ajv.compile<VerifiedManifest>(schema);

let errors = 0;

function fail(msg: string): void {
  console.error(`  FAIL: ${msg}`);
  errors++;
}

console.log("\n[verify] distribution composition contract");
// A malformed manifest makes the derivation throw; the per-extension schema pass below reports
// that same manifest cleanly, so a derivation failure is reported and the gate continues (B-092).
try {
  for (const problem of distributionContractProblems(buildDistributionContract())) fail(problem);
} catch (error) {
  fail(`distribution contract could not be derived: ${errorMessage(error)}`);
}

console.log("\n[verify] command contract");
// Duplicate names, commands that shadow a prompt template or a pi built-in, and manifest/code
// drift. The built-in name copy lives in lib/pi-builtins.ts; tests/command-contract-smoke.ts
// pins it to the installed pi dist.
{
  const before = errors;
  try {
    for (const problem of commandContractProblems(buildCommandContractInput())) fail(problem.message);
    if (errors === before) console.log("  OK: command names are unique, do not shadow prompts or built-ins, and match their manifests");
  } catch (error) {
    fail(`command contract could not be derived: ${errorMessage(error)}`);
  }
}

// Extension avenues: packages/extensions/{src,third_party}.
const EXT_AVENUES = [
  { dir: FIRST_PARTY_DIR, avenue: "first-party" },
  { dir: THIRD_PARTY_DIR, avenue: "third-party" },
];
const extensionEntryPath = (name: string): string | null => {
  for (const { dir } of EXT_AVENUES) {
    const candidate = path.join(dir, name, "index.ts");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

// Recursively collect `.ts` files under an extension dir as paths relative to
// extDir (e.g. "sub/bad.ts"), sorted for stable messages. Descends into every
// directory; non-.ts files are skipped.
function collectTsFiles(extDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), entryRel);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(entryRel);
      }
    }
  };
  walk(extDir, "");
  return out.sort();
}

const seenNames = new Map<string, string>();

for (const { dir, avenue } of EXT_AVENUES) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith("_")) continue;
    const extDir = path.join(dir, name);
    if (!fs.statSync(extDir).isDirectory()) continue;

    console.log(`\n[verify] ${avenue}/${name}`);

    // 1. extension.json exists and validates
    const metaPath = path.join(extDir, "extension.json");
    if (!fs.existsSync(metaPath)) {
      fail(`extension.json missing`);
      continue;
    }
    let meta: unknown;
    try {
      meta = parseJson(fs.readFileSync(metaPath, "utf8"));
    } catch (e) {
      fail(`extension.json parse error: ${errorMessage(e)}`);
      continue;
    }
    if (!validate(meta)) {
      fail(`extension.json schema invalid: ${ajv.errorsText(validate.errors)}`);
      // A non-object manifest (e.g. literal `null`) makes every later deref
      // (meta.name, meta.hooks, ...) throw a TypeError that would abort the
      // whole gate and hide later checks. Report and move on instead.
      continue;
    }

    // 2. Name collision
    if (seenNames.has(meta.name)) {
      fail(`name collision: "${meta.name}" also in ${seenNames.get(meta.name)}`);
    } else {
      seenNames.set(meta.name, `${avenue}/${name}`);
    }

    // 3. Entry exists
    const entryPath = path.join(extDir, meta.entry || "index.ts");
    if (!fs.existsSync(entryPath)) {
      fail(`entry file missing: ${meta.entry}`);
      continue;
    }

    // 4. Self-containment lint: scan ALL .ts files in the extension dir.
    //    No import/export may reference a path that resolves outside the extension dir.
    //    No import of the toolchain lib (packages/core/lib).
    const tsFiles = collectTsFiles(extDir);
    const registeredHooks = new Set<string>();
    for (const tsFile of tsFiles) {
      const src = fs.readFileSync(path.join(extDir, tsFile), "utf8");
      const importLines = src.split("\n").filter((l) => /^\s*(import|export)\b/.test(l));
      for (const line of importLines) {
        const imp = /from\s+["']([^"']+)["']/.exec(line)?.[1];
        if (imp === undefined) continue;
        // All relative imports must stay inside the extension dir
        if (imp.startsWith("./") || imp.startsWith("../")) {
          const resolved = path.resolve(path.dirname(path.join(extDir, tsFile)), imp);
          if (!resolved.startsWith(extDir + path.sep) && resolved !== extDir) {
            fail(`self-containment violation in ${tsFile}: imports outside extension dir: ${imp}`);
          }
        }
        // packages/core/lib is toolchain-only — never runtime
        if (imp.includes("packages/core/lib") || imp.includes("packages\\core\\lib") || imp.includes("kit/lib") || imp.includes("kit\\lib")) {
          fail(`self-containment violation in ${tsFile}: imports the toolchain lib (toolchain-only): ${imp}`);
        }
      }
      // Collect every pi.on("<event>", ...) registration for the hooks-drift check below.
      const hookRe = /pi\.on\(\s*["']([a-zA-Z_]+)["']/g;
      let hookMatch = hookRe.exec(src);
      while (hookMatch) {
        const [, hook] = hookMatch;
        if (hook !== undefined) registeredHooks.add(hook);
        hookMatch = hookRe.exec(src);
      }
    }

    // 4b. Hooks manifest drift: every pi.on(...) event actually registered in code
    //     must be declared in extension.json's hooks[] array. One-directional
    //     (code -> manifest) since under-declaration (not over-declaration) is the
    //     observed failure mode — a stale hooks[] silently hides what an extension
    //     really reacts to from anyone reading the manifest.
    const declaredHooks = new Set(meta.hooks);
    for (const hook of registeredHooks) {
      if (!declaredHooks.has(hook)) {
        fail(`hooks manifest drift: ${avenue}/${name} registers pi.on("${hook}", ...) but extension.json hooks[] does not declare "${hook}"`);
      }
    }

    // 5b. system-prompt injection monopoly lint
    // Only extensions/context-sieve/index.ts may return { systemPrompt } from before_agent_start:
    // several extensions each rewriting the whole prompt fight over it. The one exception is the
    // effort extension, whose contribution must reach EVERY profile (context-sieve is not in
    // `quick`) and must apply at the user-turn boundary; it may only return the prompt through
    // withEffortBlock(), which replaces its own marked block and so can never duplicate or
    // clobber anything else.
    const ctxSieveEntry = extensionEntryPath("context-sieve");
    for (const tsFile of tsFiles) {
      const fullPath = path.join(extDir, tsFile);
      if (ctxSieveEntry && fullPath === ctxSieveEntry) continue;
      const src = fs.readFileSync(fullPath, "utf8");
      if (/return\s*\{\s*systemPrompt/.test(src)) {
        if (meta.name === "effort" && /return\s*\{\s*systemPrompt:\s*withEffortBlock\(/.test(src)) continue;
        fail(`self-injection violation in ${avenue}/${name}/${tsFile}: only context-sieve may return { systemPrompt } from before_agent_start (effort may, via withEffortBlock only)`);
      }
    }

    console.log(`  OK: ${meta.name} (${meta.status})`);
  }
}

// The "version" string of a package.json, or undefined when it is missing, unreadable or not a string.
function packageVersion(file: string): string | undefined {
  try {
    const version = at(readJsonFile(file), "version");
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

// The pi version root package.json pins in devDependencies, and the one installed in node_modules.
// The kit compiles against pi's .d.ts files, which change between releases, so the type check only
// means something against the pin. The pi-compat CI lane installs other pi versions over the pinned
// tree; there verify skips tsc (the verify job type-checks the pin). Either value missing (a fixture
// tree, no node_modules) runs tsc as before.
function piVersionMismatch(): { installed: string; pinned: string } | undefined {
  const pi = "@earendil-works/pi-coding-agent";
  let pinned: ParsedJson | undefined;
  try {
    pinned = at(readJsonFile(path.join(ROOT, "package.json")), "devDependencies", pi);
  } catch {
    return undefined;
  }
  const installed = packageVersion(path.join(ROOT, "node_modules", ...pi.split("/"), "package.json"));
  if (typeof pinned !== "string" || installed === undefined || installed === pinned) return undefined;
  return { installed, pinned };
}

// 5. tsc --noEmit
console.log("\n[verify] tsc --noEmit");
const piMismatch = piVersionMismatch();
if (piMismatch) {
  console.log(`  SKIP: installed pi ${piMismatch.installed} is not the pinned ${piMismatch.pinned}; the verify job type-checks the pin`);
} else {
  try {
    // An argument vector; Windows needs the shell to find npx.cmd (the arguments are constants).
    execFileSync("npx", ["tsc", "--noEmit"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    console.log("  OK: type check passed");
  } catch {
    console.error("  FAIL: type check failed");
    errors++;
  }
}

// 6. sources.json validates
const sourcesPath = SOURCES_PATH;
// Only a sources.json that passed sources.schema.json feeds the cross-checks below.
let sources: Sources | undefined;
if (fs.existsSync(sourcesPath)) {
  console.log("\n[verify] sources.json");
  const sourcesSchema = readSchemaFile(path.join(SCHEMA_DIR, "sources.schema.json"));
  const validateSources = ajv.compile<Sources>(sourcesSchema);
  const rawSources = readJsonFile(sourcesPath);
  if (validateSources(rawSources)) {
    sources = rawSources;
    console.log("  OK: sources.json valid");
  } else {
    fail(`sources.json schema invalid: ${ajv.errorsText(validateSources.errors)}`);
  }

  // 7. Bundle/sources cross-check: every bundle-mode entry in sources.json
  //    must also appear in package.json dependencies + bundledDependencies.
  console.log("\n[verify] bundle/sources cross-check");
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = readJsonFile(pkgPath);
  const dependencies = at(pkg, "dependencies");
  const deps = isRecord(dependencies) ? Object.keys(dependencies) : [];
  const bundled = strings(at(pkg, "bundledDependencies"));

  const bundleEntries = (sources?.external ?? []).filter((e) => e.mode === "bundle");
  if (bundleEntries.length === 0) {
    console.log("  OK: no bundle-mode entries (nothing to cross-check)");
  } else {
    for (const entry of bundleEntries) {
      if (!deps.includes(entry.name)) {
        fail(`bundle-mode source "${entry.name}" missing from package.json dependencies`);
      }
      if (!bundled.includes(entry.name)) {
        fail(`bundle-mode source "${entry.name}" missing from package.json bundledDependencies`);
      }
    }
    if (errors === 0) console.log(`  OK: ${bundleEntries.length} bundle entry/entries match package.json`);
  }
}

// 8. Trust guards (Epic 1 Sprint 1.3): profile/manifest cross-validation +
//    stub/TODO quarantine.
{

  // Load profiles and classify experimental vs non-experimental.
  const profilesDir = path.join(PROFILES_DIR);
  // A profile that does not match lib/profiles.ts's schema is reported and left out.
  const profiles = new Map<string, Profile>();
  for (const f of fs.readdirSync(profilesDir)) {
    if (!f.endsWith(".json")) continue;
    const file = path.join(profilesDir, f);
    try {
      profiles.set(f.replace(/\.json$/, ""), parseProfile(readJsonFile(file), file));
    } catch (error) {
      fail(`profile ${f} is invalid: ${errorMessage(error)}`);
    }
  }
  const nonExperimentalProfiles = new Set(
    [...profiles].filter(([, p]) => !p.experimental).map(([name]) => name),
  );

  // Actual membership per extension name (which profiles' include lists reference it).
  const membership = new Map<string, Set<string>>(); // name -> Set(profileName)
  for (const [pname, pdef] of profiles) {
    for (const ext of pdef.include ?? []) {
      let members = membership.get(ext);
      if (!members) {
        members = new Set();
        membership.set(ext, members);
      }
      members.add(pname);
    }
  }


  // Manifests (in-repo + vendor) keyed by extension name.
  // Read leniently: the schema pass above already reported invalid manifests.
  const manifests = new Map<string, { meta: Record<string, unknown>; dir: string; extDir: string; tsFiles: string[] }>();
  for (const { dir, avenue } of EXT_AVENUES) {
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith("_")) continue;
      const extDir = path.join(dir, n);
      const mp = path.join(extDir, "extension.json");
      if (!fs.existsSync(mp)) continue;
      let meta: unknown;
      try {
        meta = parseJson(fs.readFileSync(mp, "utf8"));
      } catch {
        continue; // already reported by the schema pass above
      }
      if (!isRecord(meta) || typeof meta.name !== "string") {
        continue; // non-object manifest or non-string name already reported by the schema pass above
      }
      const tsFiles = collectTsFiles(extDir);
      manifests.set(meta.name, { meta, dir: `${avenue}/${n}`, extDir, tsFiles });
    }
  }

  // External names declared in sources.json (legitimately manifest-less).
  const externalNames = new Set<string>();
  if (sources) {
    for (const e of sources.external ?? []) {
      for (const name of e.provides ?? [e.name]) externalNames.add(name);
    }
  }

  // 8a. Profile <-> manifest bidirectional cross-validation.
  console.log("\n[verify] profile/manifest cross-check");
  // Forward: every non-external name referenced in a profile must have a manifest.
  for (const [name, inProfiles] of membership) {
    if (!manifests.has(name) && !externalNames.has(name)) {
      fail(`profile include "${name}" (in ${[...inProfiles].join(", ")}) has no extension.json and no sources.json entry`);
    }
  }
  // Bidirectional: declared profiles must exactly equal actual membership.
  for (const [name, { meta }] of manifests) {
    const declared = [...new Set(strings(meta.profiles))].sort();
    const actual = [...(membership.get(name) ?? new Set<string>())].sort();
    if (declared.join(",") !== actual.join(",")) {
      fail(
        `profile metadata drift for "${name}": extension.json profiles [${declared.join(", ")}] != profiles/*.json membership [${actual.join(", ")}]`,
      );
    }
    // A real (stable/beta) extension must ship in at least one profile.
    if ((meta.status === "stable" || meta.status === "beta") && actual.length === 0) {
      fail(`orphaned extension "${name}": status ${meta.status} but shipped in no profile`);
    }
  }
  if (errors === 0) console.log(`  OK: ${manifests.size} manifests consistent with profiles/*.json`);

  // 8a2. External source profile metadata must exactly match actual membership.
  console.log("\n[verify] external source/profile cross-check");
  const externalProfileErrors = errors;
  for (const entry of sources?.external ?? []) {
    const declared = [...new Set(entry.profiles ?? [])].sort();
    for (const name of entry.provides ?? [entry.name]) {
      const actual = [...(membership.get(name) ?? new Set<string>())].sort();
      if (declared.join(",") !== actual.join(",")) {
        fail(
          `external source profile drift for "${name}" (source "${entry.name}"): sources.json profiles [${declared.join(", ")}] != profiles/*.json membership [${actual.join(", ")}]`,
        );
      }
    }
  }
  if (errors === externalProfileErrors) console.log("  OK: external source profiles consistent with profiles/*.json");

  // 8b. Stub/TODO quarantine: nothing shipped in a non-experimental profile or the
  //     may be a stub/experimental or emit "(stub)"/": TODO" strings.
  console.log("\n[verify] stub/TODO quarantine");
  let stubViolations = 0;
  for (const [name, { meta, dir, extDir, tsFiles }] of manifests) {
    const nonExpMembership = [...(membership.get(name) ?? new Set<string>())].filter((p) =>
      nonExperimentalProfiles.has(p),
    );
    const shippedNonExperimentally = nonExpMembership.length > 0;
    if (!shippedNonExperimentally) continue;

    if (meta.status === "stub" || meta.status === "experimental") {
      fail(
        `stub/experimental extension "${name}" (status ${meta.status}) ships in non-experimental context [${nonExpMembership.join(", ")}]`,
      );
      stubViolations++;
    }
    for (const tsFile of tsFiles) {
      const src = fs.readFileSync(path.join(extDir, tsFile), "utf8");
      if (/\(stub\)/.test(src) || /:\s*TODO/.test(src)) {
        fail(`stub marker in ${dir}/${tsFile}: "(stub)"/": TODO" but extension ships in a non-experimental context`);
        stubViolations++;
      }
    }
  }
  if (stubViolations === 0) console.log("  OK: no stub/TODO extensions in any non-experimental profile");

  // 8c. Firewall starter policy: embedded copy must equal the canonical packages/core/policies mirror,
  //     and must default-deny unknown tools (never allow-all). (Epic 2 Sprint 2.1.)
  console.log("\n[verify] tool-firewall starter policy");
  const embeddedPolicyPath = path.join(FIRST_PARTY_DIR, "tool-firewall", "default-policy.json");
  const canonicalPolicyPath = path.join(POLICIES_DIR, "default.json");
  if (fs.existsSync(embeddedPolicyPath)) {
    if (fs.existsSync(canonicalPolicyPath)) {
      const embeddedRaw = fs.readFileSync(embeddedPolicyPath, "utf8");
      const canonicalRaw = fs.readFileSync(canonicalPolicyPath, "utf8");
      if (embeddedRaw !== canonicalRaw) {
        fail("tool-firewall/default-policy.json and packages/core/policies/default.json have diverged (must be byte-identical)");
      }
      let policy: unknown;
      try {
        policy = parseJson(embeddedRaw);
      } catch (error) {
        fail(`default-policy.json parse error: ${errorMessage(error)}`);
        policy = null;
      }
      if (policy) {
        const unknownDefault = at(policy, "defaults", "unknown");
        if (unknownDefault === "allow") {
          fail("firewall starter policy defaults.unknown must not be 'allow' (default-deny requirement)");
        }
        // v2: shell commands are classified by the firewall's analyser (covered by
        // tests/firewall-shell-smoke.ts); the regex deny list is the strict pentest policy's.
        const strict = at(policy, "policies", "pentest", "command_rules");
        const operatorDeny = items(at(policy, "command_rules", "deny")).length;
        const strictDeny = items(at(strict, "deny")).length;
        const denyCount = operatorDeny + strictDeny;
        if (denyCount === 0) fail("firewall starter policy has zero deny command_rules (operator + pentest)");
        if (errors === 0) console.log(`  OK: policy default unknown=${typeof unknownDefault === "string" ? unknownDefault : JSON.stringify(unknownDefault)}, pentest policy ${strictDeny} deny + ${items(at(strict, "ask")).length} ask rules, ${operatorDeny} operator deny rules`);
      }
    } else {
      fail("packages/core/policies/default.json missing (canonical starter policy mirror)");
    }
  } else {
    fail("tool-firewall/default-policy.json missing (shipped starter policy)");
  }

  // 8d. Security pattern parity (Epic 2 Sprint 2.2 cross-link): the firewall's strict pentest
  //     policy must be at least as strict as pentest-governance-domain. Firewall pentest
  //     deny patterns >= pentest DESTRUCTIVE_COMMANDS; secret-guard PROTECTED_PATTERNS >=
  //     pentest PROTECTED_PATTERNS. (Coding policies classify shell commands structurally;
  //     tests/firewall-shell-smoke.ts pins that each destructive class is still caught.)
  console.log("\n[verify] security pattern parity");
  const pentestSrcPath = path.join(FIRST_PARTY_DIR, "pentest-governance-domain", "index.ts");
  const secretGuardSrcPath = path.join(FIRST_PARTY_DIR, "secret-guard", "index.ts");
  if (fs.existsSync(pentestSrcPath) && fs.existsSync(secretGuardSrcPath) && fs.existsSync(embeddedPolicyPath)) {
    const pentestSrc = fs.readFileSync(pentestSrcPath, "utf8");
    const secretGuardSrc = fs.readFileSync(secretGuardSrcPath, "utf8");

    const extractArrayBlock = (src: string, varName: string): string => {
      const start = src.indexOf(`const ${varName}`);
      if (start < 0) return "";
      const open = src.indexOf("[", start);
      const close = src.indexOf("];", open);
      return open >= 0 && close >= 0 ? src.slice(open + 1, close) : "";
    };
    const regexSources = (block: string): string[] => {
      const out: string[] = [];
      const re = /\/((?:\\.|[^/\\\n])+)\/[gimsuy]*/g; // [^/\\\n]: a backslash is only ever matched by the escape alternative, so this cannot backtrack exponentially
      let m = re.exec(block);
      while (m) {
        const [, source] = m;
        if (source !== undefined) out.push(source);
        m = re.exec(block);
      }
      return out;
    };
    const stringLiterals = (block: string): string[] => {
      const out: string[] = [];
      const re = /"((?:\\.|[^"\\])*)"/g;
      let m = re.exec(block);
      while (m) {
        const [, literal] = m;
        if (literal !== undefined) out.push(literal.replace(/\\"/g, '"'));
        m = re.exec(block);
      }
      return out;
    };

    // Destructive-command parity: firewall deny >= pentest DESTRUCTIVE_COMMANDS.
    const pentestDestructive = regexSources(extractArrayBlock(pentestSrc, "DESTRUCTIVE_COMMANDS"));
    const policy = readJsonFile(embeddedPolicyPath);
    const firewallDeny = new Set([...items(at(policy, "command_rules", "deny")), ...items(at(policy, "policies", "pentest", "command_rules", "deny"))].map((r) => at(r, "pattern")));
    const missingDestructive = pentestDestructive.filter((p) => !firewallDeny.has(p));
    if (pentestDestructive.length === 0) {
      fail("could not extract DESTRUCTIVE_COMMANDS from pentest-governance-domain (parity check broken)");
    } else if (missingDestructive.length) {
      fail(`firewall starter policy is missing pentest DESTRUCTIVE_COMMANDS patterns: ${missingDestructive.join(" | ")}`);
    }

    // Protected-path parity: secret-guard PROTECTED_PATTERNS >= pentest PROTECTED_PATTERNS.
    const pentestProtected = stringLiterals(extractArrayBlock(pentestSrc, "PROTECTED_PATTERNS"));
    const secretGuardProtected = new Set(stringLiterals(extractArrayBlock(secretGuardSrc, "PROTECTED_PATTERNS")));
    const missingProtected = pentestProtected.filter((p) => !secretGuardProtected.has(p));
    if (pentestProtected.length === 0) {
      fail("could not extract PROTECTED_PATTERNS from pentest-governance-domain (parity check broken)");
    } else if (missingProtected.length) {
      fail(`secret-guard PROTECTED_PATTERNS is missing pentest patterns: ${missingProtected.join(" | ")}`);
    }

    if (errors === 0) {
      console.log(`  OK: firewall covers ${pentestDestructive.length} destructive patterns; secret-guard covers ${pentestProtected.length} protected patterns`);
    }
  } else {
    console.log("  SKIP: parity sources not all present");
  }

  // 8d'. Workflow redaction copies: third_party/subagent/redact.ts holds byte-identical copies of
  //      trace-ledger's targetOf() rules and secret-guard's SECRET_CONTENT_PATTERNS lines
  //      (tests/workflow-redaction-smoke.ts checks order and behaviour as well).
  console.log("\n[verify] workflow redaction copies");
  const redactPath = path.join(THIRD_PARTY_DIR, "subagent", "redact.ts");
  const traceLedgerPath = path.join(FIRST_PARTY_DIR, "trace-ledger", "index.ts");
  if (fs.existsSync(redactPath) && fs.existsSync(traceLedgerPath) && fs.existsSync(secretGuardSrcPath)) {
    const redactSrc = fs.readFileSync(redactPath, "utf8");
    const traceRules = [...fs.readFileSync(traceLedgerPath, "utf8").matchAll(/^\s*\.replace\((\/.+\/[gimsuy]*), ("[^"]*")\);?$/gm)].map((m) => `[${m[1] ?? ""}, ${m[2] ?? ""}]`);
    const guardLines = [...fs.readFileSync(secretGuardSrcPath, "utf8").matchAll(/^\s*(\{ re: \/.+\/[gimsuy]*, label: "[^"]*" \},)$/gm)].map((m) => m[1] ?? "");
    const missing = [...traceRules, ...guardLines].filter((line) => !redactSrc.includes(line));
    if (traceRules.length < 4 || guardLines.length < 8) fail("could not extract the trace-ledger or secret-guard redaction rules (copy check broken)");
    else if (missing.length) fail(`third_party/subagent/redact.ts has drifted from its sources: ${missing.join(" | ")}`);
    else console.log(`  OK: redact.ts copies ${traceRules.length} trace-ledger rules and ${guardLines.length} secret-guard patterns`);
  } else {
    fail("workflow redaction copy check: redact.ts, trace-ledger or secret-guard source missing");
  }

  // 8d''. Shared security helpers: every generated copy of packages/core/shared/* (safe-fs, redact,
  //       safe-regex, kit-source, inline-guard) is byte-identical to its source plus the fixed header (packages/core/gen-shared.ts).
  console.log("\n[verify] shared helper copies");
  {
    const problems = checkSharedCopies(ROOT);
    for (const p of problems) fail(p);
    if (!problems.length) console.log(`  OK: ${Object.values(SHARED_COPIES).reduce((n, list) => n + list.length, 0)} generated copies match packages/core/shared/`);
  }

  // 8e. Skills catalogue drift + skills frontmatter lint (Epic 3 Sprint 3.1).
  console.log("\n[verify] skills catalogue");
  const skillsCatalogueScript = path.join(CORE_DIR, "skills-catalogue.ts");
  if (fs.existsSync(skillsCatalogueScript)) {
    // Kept in parity with packages/core/skills-catalogue.ts's CATEGORY_ORDER by hand (duplicated,
    // not imported - importing that script would run its top-level doc-generation code
    // as a side effect). It previously only checked that "category:" was present
    // and non-empty, not that its VALUE was one of the recognized categories - a typo
    // silently filed the skill nowhere in the generated catalogue instead of failing loud.
    const KNOWN_SKILL_CATEGORIES = new Set([
      "coding-workflow", "efficiency", "context-and-small-models", "memory", "orchestration-recovery",
      "mcp-governance", "pentest", "evidence-reporting", "documentation", "maintainer", "uncategorised",
    ]);
    // Frontmatter lint: every SKILL.md must have name + description + a recognized category.
    const skillsDir = path.join(SKILLS_DIR);
    if (fs.existsSync(skillsDir)) {
      for (const name of fs.readdirSync(skillsDir)) {
        const mp = path.join(skillsDir, name, "SKILL.md");
        if (!fs.existsSync(mp)) continue;
        const text = fs.readFileSync(mp, "utf8");
        const fmEnd = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
        const fm = fmEnd > 0 ? text.slice(3, fmEnd) : "";
        for (const key of ["name", "description", "category"]) {
          if (!new RegExp(`\\n?${key}:\\s*\\S`).test(fm)) {
            fail(`skill ${name}/SKILL.md frontmatter missing "${key}:"`);
          }
        }
        const category = /\n?category:\s*(\S+)/.exec(fm)?.[1];
        if (category !== undefined && !KNOWN_SKILL_CATEGORIES.has(category)) {
          fail(`skill ${name}/SKILL.md has unrecognized category "${category}" — must be one of: ${[...KNOWN_SKILL_CATEGORIES].join(", ")}`);
        }
        // Trigger-shape lint: descriptions must be "what + when" (kit standard, see
        // docs/WRITING_EXTENSIONS.md "Writing skills"), not a bare purpose
        // statement — otherwise the model has nothing to match against for discovery.
        const description = /\n?description:\s*(.+)/.exec(fm)?.[1];
        if (description !== undefined && !/\buse\b/i.test(description)) {
          fail(`skill ${name}/SKILL.md description lacks a "Use ..." trigger clause (kit standard: "what + when", see docs/WRITING_EXTENSIONS.md "Writing skills")`);
        }
      }
    }
    // Drift: committed doc must match a fresh regen.
    try {
      const current = fs.existsSync(path.join(ROOT, "docs", "skills-catalogue.md")) ? fs.readFileSync(path.join(ROOT, "docs", "skills-catalogue.md"), "utf8") : "";
      if (current !== skillsCatalogueContent()) throw new Error("skills catalogue is stale");
      if (errors === 0) console.log("  OK: docs/skills-catalogue.md matches frontmatter; all skills have name/description/category");
    } catch (error) {
      fail(`docs/skills-catalogue.md is stale — run 'npm run catalog' (${errorOutput(error).trim().split(/\r?\n/).slice(-2).join(" ")})`);
    }
  }

  // 8f. Capability matrix drift (Epic 3 Sprint 3.3).
  console.log("\n[verify] capability matrix");
  const capMatrixScript = path.join(CORE_DIR, "capability-matrix.ts");
  if (fs.existsSync(capMatrixScript)) {
    try {
      const current = fs.existsSync(path.join(ROOT, "docs", "capability-matrix.md")) ? fs.readFileSync(path.join(ROOT, "docs", "capability-matrix.md"), "utf8") : "";
      if (current !== capabilityMatrixContent()) throw new Error("capability matrix is stale");
      console.log("  OK: docs/capability-matrix.md matches profiles/manifests");
    } catch {
      fail("docs/capability-matrix.md is stale — run 'npm run catalog'");
    }
  }

  // 8f-ter. Extensions catalogue drift (B-098): registry.ts --write-docs output was
  // the only generated doc without a drift gate, so a hand-edited summary passed CI.
  console.log("\n[verify] extensions catalogue");
  const current = fs.existsSync(path.join(ROOT, "docs", "EXTENSIONS.md")) ? fs.readFileSync(path.join(ROOT, "docs", "EXTENSIONS.md"), "utf8") : "";
  const catalogueDrift = extensionsCatalogueDrift(current);
  if (catalogueDrift.error) {
    fail(`extensions catalogue check failed: ${catalogueDrift.error}`);
  } else if (catalogueDrift.stale) {
    fail("docs/EXTENSIONS.md is stale — run 'npm run catalog'");
  } else {
    console.log("  OK: docs/EXTENSIONS.md matches packages/core/registry.ts");
  }

  // 8f-bis. Third-party notices drift (npm distribution Phase 1b).
  console.log("\n[verify] third-party notices");
  try {
    const noticesPath = path.join(ROOT, "THIRD_PARTY_NOTICES.md");
    const current = fs.existsSync(noticesPath) ? fs.readFileSync(noticesPath, "utf8") : "";
    if (current !== noticesContent()) throw new Error("third-party notices are stale");
    console.log("  OK: THIRD_PARTY_NOTICES.md matches third_party/*/SOURCE.md");
  } catch {
    fail("THIRD_PARTY_NOTICES.md is stale — run 'node packages/core/gen-notices.ts'");
  }

  // 8g. Docs nav + internal links (offline stand-in for `mkdocs build --strict`).
  console.log("\n[verify] docs nav + links");
  const docsNavScript = path.join(CORE_DIR, "docs-nav-check.ts");
  if (fs.existsSync(docsNavScript)) {
    try {
      if (!checkDocsNav()) throw new Error("docs nav/link check failed");
      console.log("  OK: mkdocs nav entries exist and internal doc links resolve");
    } catch (error) {
      const out = errorOutput(error).trim().split(/\r?\n/).filter((l) => /FAIL/.test(l));
      fail(`docs nav/link check failed: ${out.join("; ") || "see node packages/core/docs-nav-check.ts"}`);
    }
  }

  // 8h. Conductor agent-synth template contract (Phase 2).
  console.log("\n[verify] agent-synth output contract");
  const agentSynthPath = path.join(FIRST_PARTY_DIR, "conductor", "synth", "agent-synth.ts");
  if (fs.existsSync(agentSynthPath)) {
    const agentSynthSource = fs.readFileSync(agentSynthPath, "utf8");
    if (!agentSynthSource.includes("\n## Scope\n")) fail('agent-synth markdown template is missing its scope marker');
    if (!agentSynthSource.includes("\ntools: ${tools}\n")) fail("agent-synth markdown template is missing its tools marker");
    if (errors === 0) console.log("  OK: agent-synth template declares scope and tools markers");
  } else {
    fail("extensions/conductor/synth/agent-synth.ts is missing");
  }

  // 8i. Conductor validator least-privilege contract (Phase 3).
  console.log("\n[verify] validator role least-privilege contract");
  const validatorPath = path.join(FIRST_PARTY_DIR, "conductor", "agents", "validator.md");
  if (fs.existsSync(validatorPath)) {
    const validator = fs.readFileSync(validatorPath, "utf8");
    const tools = validator.match(/^tools:\s*(.*)$/m)?.[1] ?? "";
    if (/(^|,\s*)(write|edit|bash)(,|$)/.test(tools)) fail("validator.md tools frontmatter must not grant write, edit, or bash");
    else if (tools !== "read, grep, find, ls") fail("validator.md must declare exactly read, grep, find, ls tools");
    else if (errors === 0) console.log("  OK: validator role is limited to read, grep, find, ls");
  } else {
    fail("extensions/conductor/agents/validator.md is missing");
  }
}

if (errors > 0) {
  console.error(`\n[verify] FAILED with ${errors} error(s)`);
  process.exit(1);
} else {
  console.log("\n[verify] All checks passed.");
}
