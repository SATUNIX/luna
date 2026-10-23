#!/usr/bin/env node
/**
 * A derived, read-only view of the distribution's existing owners. It is not a second editable
 * manifest: identity and runtime compatibility come from package.json, delivery and the mandatory
 * profile base from packages/core/distribution.json, capability metadata from each extension.json
 * (through registry.ts) and profile composition from packages/kit/profiles/*.json.
 *
 * `verify` and `npm run -s smoke:distribution-contract` enforce the composition contract this
 * module derives; `npm run -s distribution:inspect` prints it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistryEntries, type RegistryEntry } from "./registry.ts";
import { DistributionConfigSchema, validatePreviousSources } from "./lib/distribution.ts";
import { isRecord, parseJson } from "./lib/guard.ts";
import { parseProfile, type Profile } from "./lib/profiles.ts";
import { WORKSPACE_ROOT, PROFILES_DIR, CORE_DIR } from "./lib/paths.ts";

/** The raw packages/core/distribution.json, plus the composition base the contract enforces. */
export interface DistributionMetadata {
  requiredProfileExtensions?: string[];
  [key: string]: unknown;
}

/** A profile as the contract derives it: its own declaration plus what its include list implies. */
export type DistributionContractProfile = Omit<Profile, "name" | "include" | "experimental"> & {
  name: string;
  include: string[];
  declaredTools: string[];
  declaredServices: string[];
  /** Names of the included capabilities whose manifest status is "experimental". */
  experimental: string[];
};

export interface DistributionContract {
  schemaVersion: 1;
  identity: { name: string; version: string; licence: string };
  runtime: { node: string; pi: string; testedPi: string };
  distribution: DistributionMetadata;
  capabilities: RegistryEntry[];
  profiles: DistributionContractProfile[];
}

/** Read a JSON file that must hold an object; anything else reads as an empty object. */
function readJsonObject(file: string): Record<string, unknown> {
  const parsed = parseJson(fs.readFileSync(file, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

/** The string at `keys` inside nested JSON objects, or "" when the path is absent or not a string. */
function stringAt(value: unknown, ...keys: string[]): string {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return "";
    current = current[key];
  }
  return typeof current === "string" ? current : "";
}

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** The strings of a manifest array (anything else reads as empty). */
function manifestStrings(entry: RegistryEntry, section: string, key: string): string[] {
  const container = entry[section];
  const value = isRecord(container) ? container[key] : undefined;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const profileRequires = (capability: RegistryEntry): string[] => {
  const value = capability.profileRequires;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
};

function profileFiles(): string[] {
  return fs.readdirSync(PROFILES_DIR).filter((name) => name.endsWith(".json")).sort();
}

/** Read distribution.json as typed metadata, keeping every key the file has. */
export function readDistributionMetadata(file: string = path.join(CORE_DIR, "distribution.json")): DistributionMetadata {
  const raw = readJsonObject(file);
  const config = DistributionConfigSchema.parse(raw, "distribution");
  validatePreviousSources(config.git?.previousSources);
  const out: DistributionMetadata = {};
  for (const [key, value] of Object.entries(raw)) out[key] = value;
  const required = raw.requiredProfileExtensions;
  if (Array.isArray(required)) out.requiredProfileExtensions = required.filter((item): item is string => typeof item === "string");
  return out;
}

export function buildDistributionContract(): DistributionContract {
  const pkg = readJsonObject(path.join(WORKSPACE_ROOT, "package.json"));
  const capabilities = buildRegistryEntries().sort((a, b) => a.name.localeCompare(b.name));
  const profiles = profileFiles().map((file) => ({
    fallbackName: path.basename(file, ".json"),
    profile: parseProfile(parseJson(fs.readFileSync(path.join(PROFILES_DIR, file), "utf8")), file),
  }));
  return {
    schemaVersion: 1,
    identity: {
      name: stringAt(pkg, "name"),
      version: stringAt(pkg, "version"),
      licence: stringAt(pkg, "license"),
    },
    runtime: {
      node: stringAt(pkg, "engines", "node"),
      pi: stringAt(pkg, "peerDependencies", "@earendil-works/pi-coding-agent"),
      testedPi: stringAt(pkg, "devDependencies", "@earendil-works/pi-coding-agent"),
    },
    distribution: readDistributionMetadata(),
    capabilities,
    profiles: profiles.map(({ fallbackName, profile }) => {
      const include = profile.include ?? [];
      const included = capabilities.filter((capability) => include.includes(capability.name));
      return {
        ...profile,
        name: profile.name ?? fallbackName,
        include,
        declaredTools: unique(included.flatMap((capability) => manifestStrings(capability, "registers", "tools"))),
        declaredServices: unique(included.flatMap((capability) => manifestStrings(capability, "runtime", "services"))),
        experimental: included.filter((capability) => capability.status === "experimental").map((capability) => capability.name),
      };
    }),
  };
}

/**
 * Tool names declared (`registers.tools`) by more than one of the capabilities one profile loads.
 * pi keeps the first registration of a tool name and drops the rest without a diagnostic, so two
 * owners in one profile means one extension's tool silently never runs. Only manifest
 * declarations are compared: external companions declare no tools here.
 */
export function duplicateToolProblems(profileName: string, loaded: readonly RegistryEntry[]): string[] {
  const owners = new Map<string, string[]>();
  for (const capability of loaded) {
    for (const tool of unique(manifestStrings(capability, "registers", "tools"))) owners.set(tool, [...(owners.get(tool) ?? []), capability.name]);
  }
  return [...owners]
    .filter(([, names]) => names.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, names]) => `${profileName}: tool ${tool} is registered by ${unique(names).join(", ")}; pi keeps only one`);
}

/** Every way a shipped profile can break its declared composition contract (empty means valid). */
export function distributionContractProblems(contract: DistributionContract): string[] {
  const problems: string[] = [];
  try {
    const config = DistributionConfigSchema.parse(contract.distribution, "distribution");
    validatePreviousSources(config.git?.previousSources);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const capabilities = new Map<string, RegistryEntry>(contract.capabilities.map((capability): [string, RegistryEntry] => [capability.name, capability]));
  const required = contract.distribution.requiredProfileExtensions;
  if (!Array.isArray(required) || required.length === 0 || required.some((name) => typeof name !== "string" || !capabilities.has(name))) {
    return [...problems, "distribution.requiredProfileExtensions must name a nonempty set of shipped capabilities"];
  }
  if (new Set(required).size !== required.length) problems.push("duplicate requiredProfileExtensions");
  for (const profile of contract.profiles) {
    const includes = new Set(profile.include);
    if (includes.size !== profile.include.length) problems.push(`${profile.name}: duplicate capability`);
    for (const name of required) if (!includes.has(name)) problems.push(`${profile.name}: missing distribution base ${name}`);
    for (const name of includes) {
      const capability = capabilities.get(name);
      if (!capability) {
        problems.push(`${profile.name}: unknown capability ${name}`);
        continue;
      }
      for (const dependency of profileRequires(capability)) {
        if (!includes.has(dependency)) problems.push(`${profile.name}: ${name} requires ${dependency}`);
      }
    }
    problems.push(...duplicateToolProblems(profile.name, [...includes].flatMap((name) => {
      const capability = capabilities.get(name);
      return capability ? [capability] : [];
    })));
  }
  return problems;
}

/** The mandatory profile base from distribution.json, refusing to proceed if the contract is broken. */
export function requiredProfileExtensions(): string[] {
  const contract = buildDistributionContract();
  const problems = distributionContractProblems(contract);
  if (problems.length) throw new Error(problems.join("; "));
  const required = contract.distribution.requiredProfileExtensions;
  if (!Array.isArray(required)) throw new Error("distribution.requiredProfileExtensions must be an array of capability names");
  return required;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const contract = buildDistributionContract();
    const problems = distributionContractProblems(contract);
    if (problems.length) throw new Error(problems.join("\n"));
    console.log(JSON.stringify(contract, null, 2));
  } catch (error) {
    console.error(`[distribution-contract] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
