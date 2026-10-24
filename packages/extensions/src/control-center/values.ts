/**
 * Current values for the hub rows.
 *
 * The hub never imports another extension: a value comes either from a process registry another
 * extension already publishes on `globalThis[Symbol.for("pi-kit.*")]`, or from a read-only file
 * (`pi-kit/firewall.json`, the install marker, `settings.json`). Every read is defensive, so a
 * registry that is absent, half-written or a different shape degrades to "unknown" rather than
 * breaking the hub.
 *
 * Self-containment rule: import only node:* builtins and pi peer types.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The agent directory, the same resolution the rest of the kit uses. */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** The kit state directory (`<agent dir>/pi-kit`). */
export function kitStateDir(): string {
  return path.join(agentDir(), "pi-kit");
}

/** A value decoded from JSON at a file boundary, before any shape is asserted. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Everything JSON.parse returns passes; checking it makes that a proof rather than a cast.
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function readJson(file: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A value another extension published on globalThis, before its shape is checked. */
type PublishedValue = Record<string, unknown> | Set<unknown> | unknown[] | string | number | boolean | null | undefined;

function registry(name: string): PublishedValue {
  return (globalThis as Record<symbol, PublishedValue>)[Symbol.for(name)];
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

// --- install marker and settings ---------------------------------------------------------------

export interface KitMarkerView {
  profile?: string | undefined;
  scope?: string | undefined;
  mode?: string | undefined;
  companions: string[];
  extensions: string[];
  kitSource?: string | undefined;
}

/** True when `cwd` has a project install marker (`.pi/.pi-kit.json`). */
function hasProjectMarker(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, ".pi", ".pi-kit.json"));
}

/** The install marker: a project `.pi/.pi-kit.json` wins, else the global `<agent dir>/.pi-kit.json`. */
export function readMarker(cwd: string): KitMarkerView {
  const file = hasProjectMarker(cwd) ? path.join(cwd, ".pi", ".pi-kit.json") : path.join(agentDir(), ".pi-kit.json");
  const raw = readJson(file);
  const record = isRecord(raw) ? raw : {};
  return {
    profile: text(record.profile),
    scope: text(record.scope),
    mode: text(record.mode),
    kitSource: text(record.kitSource),
    companions: Array.isArray(record.companions) ? record.companions.filter((c): c is string => typeof c === "string") : [],
    extensions: Array.isArray(record.extensions) ? record.extensions.filter((c): c is string => typeof c === "string") : [],
  };
}

/**
 * The settings.json of the same scope as the marker `readMarker(cwd)` reads: the project
 * `.pi/settings.json` beside a project marker, else the global `<agent dir>/settings.json`. A project
 * settings.json without a project marker is not where a global install registered its packages.
 */
export function settingsFileFor(cwd: string): string {
  return hasProjectMarker(cwd) ? path.join(cwd, ".pi", "settings.json") : path.join(agentDir(), "settings.json");
}

/** The source of a pi settings `packages` entry (a bare string or an object with `source`). */
function packageSource(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (isRecord(entry)) return text(entry.source);
  return undefined;
}

/** The package sources registered in a pi settings.json. */
export function settingsSources(settingsFile: string): Set<string> {
  const raw = readJson(settingsFile);
  const record = isRecord(raw) ? raw : {};
  const packages = Array.isArray(record.packages) ? record.packages : [];
  const out = new Set<string>();
  for (const entry of packages) {
    const source = packageSource(entry);
    if (source) out.add(source);
  }
  return out;
}

// --- registries --------------------------------------------------------------------------------

/** `Symbol.for("pi-kit.effort").snapshot().label`, e.g. "E3 standard". */
export function readEffort(): string | undefined {
  const reg = registry("pi-kit.effort");
  if (!isRecord(reg) || typeof reg.snapshot !== "function") return undefined;
  try {
    const snapshot: unknown = (reg.snapshot as () => unknown)();
    if (!isRecord(snapshot)) return undefined;
    return text(snapshot.label) ?? text(snapshot.tier) ?? text(snapshot.code);
  } catch {
    return undefined;
  }
}

/** Names recorded in `Symbol.for("pi-kit.protections")` (a Set, or an object with `list()`). */
export function readProtections(): string[] {
  const reg = registry("pi-kit.protections");
  if (reg instanceof Set) return [...reg].map(String).sort((a, b) => a.localeCompare(b));
  if (isRecord(reg) && typeof reg.list === "function") {
    try {
      const listed: unknown = (reg.list as () => unknown)();
      if (Array.isArray(listed)) return listed.map(String).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }
  return [];
}

/** `Symbol.for("pi-kit.delegation").requiredForChild().length` as a short status. */
export function readDelegation(): string | undefined {
  const reg = registry("pi-kit.delegation");
  if (!isRecord(reg) || typeof reg.requiredForChild !== "function") return undefined;
  try {
    const required: unknown = (reg.requiredForChild as () => unknown)();
    if (!Array.isArray(required)) return undefined;
    return `${required.length} required`;
  } catch {
    return undefined;
  }
}

/** `Symbol.for("pi-kit.compaction")`: `{ enabled, thresholdTokens, reason }`. */
export function readCompaction(): string | undefined {
  const reg = registry("pi-kit.compaction");
  if (!isRecord(reg) || (reg.enabled !== true && reg.enabled !== false)) return undefined;
  const state = reg.enabled ? "on" : "off";
  const threshold = typeof reg.thresholdTokens === "number" ? ` at ${formatK(reg.thresholdTokens)}` : "";
  return `${state}${threshold}`;
}

/** `Symbol.for("pi-kit.unattended")`: `{ active, boundary, label }`. */
export function readUnattended(): string | undefined {
  const reg = registry("pi-kit.unattended");
  if (!isRecord(reg)) return undefined;
  if (reg.active === true) return text(reg.label) ?? "active";
  if (process.env.PI_KIT_UNATTENDED === "1") return "requested, not enforced";
  return undefined;
}

/** `Symbol.for("pi-kit.subagents").snapshot()`: `{ live, finished, failures }`. */
export function readSubagents(): string | undefined {
  const reg = registry("pi-kit.subagents");
  if (!isRecord(reg) || typeof reg.snapshot !== "function") return undefined;
  try {
    const snapshot: unknown = (reg.snapshot as () => unknown)();
    if (!isRecord(snapshot) || typeof snapshot.live !== "number") return undefined;
    return `${snapshot.live} running`;
  } catch {
    return undefined;
  }
}

export interface SecurityView {
  /** What the hub shows as the effective security level. */
  effective: string;
  /** Shown only when it differs from `effective`. */
  requested?: string | undefined;
  source?: string | undefined;
  /** True when no `pi-kit.security` registry is published: the tool firewall is not loaded. */
  missing: boolean;
}

/** Shown instead of a level when the tool firewall, which owns the level, is not loaded. */
export const NO_FIREWALL = "not enforced (tool-firewall not loaded)";

/**
 * The security level from the `pi-kit.security` registry the tool firewall publishes (the level
 * `/security` sets). Without the registry no firewall is loaded, so there is no level to show.
 */
export function readSecurity(): SecurityView {
  const reg = registry("pi-kit.security");
  if (isRecord(reg) && typeof reg.snapshot === "function") {
    try {
      const snapshot: unknown = (reg.snapshot as () => unknown)();
      if (isRecord(snapshot)) {
        const effective = text(snapshot.effective);
        if (effective) {
          const requested = text(snapshot.requested);
          return {
            effective,
            requested: requested && requested !== effective ? requested : undefined,
            source: text(snapshot.source),
            missing: false,
          };
        }
      }
    } catch {
      /* a broken registry reads as missing */
    }
  }
  return { effective: NO_FIREWALL, missing: true };
}

// --- firewall (read-only file) -----------------------------------------------------------------

export interface FirewallFileView {
  mode?: string | undefined;
  policy?: string | undefined;
}

/** `pi-kit/firewall.json` (or `PI_KIT_FIREWALL_CONFIG`): `{ mode, policy }`. */
export function readFirewallFile(): FirewallFileView {
  const file = process.env.PI_KIT_FIREWALL_CONFIG?.trim() || path.join(kitStateDir(), "firewall.json");
  const raw = readJson(file);
  const record = isRecord(raw) ? raw : {};
  return { mode: text(record.mode), policy: text(record.policy) };
}

// --- assembling the value table ----------------------------------------------------------------

/** Everything the model resolves a row's `valueKey` against. Missing keys read as "unknown". */
export interface HubValues {
  profile?: string | undefined;
  effort?: string | undefined;
  thinking?: string | undefined;
  security?: string | undefined;
  /** True when the tool firewall's security registry is not published. */
  securityMissing: boolean;
  securityRequested?: string | undefined;
  approvals?: string | undefined;
  policy?: string | undefined;
  compaction?: string | undefined;
  subagents?: string | undefined;
  protections?: string | undefined;
  delegation?: string | undefined;
  unattended?: string | undefined;
}

export interface ValueInput {
  cwd: string;
  /** `pi.getThinkingLevel()`, when the hub has the API. */
  thinkingLevel?: string | undefined;
}

/** Read every published value once, when the hub opens. */
export function readValues(input: ValueInput): HubValues {
  const marker = readMarker(input.cwd);
  const firewall = readFirewallFile();
  const security = readSecurity();
  const protections = readProtections();
  return {
    profile: marker.profile,
    effort: readEffort(),
    thinking: input.thinkingLevel,
    security: security.requested ? `${security.effective} (requested ${security.requested})` : security.effective,
    securityMissing: security.missing,
    securityRequested: security.requested,
    approvals: firewall.mode ? `${firewall.mode}${firewall.policy ? `/${firewall.policy}` : ""}` : undefined,
    policy: firewall.policy,
    compaction: readCompaction(),
    subagents: readSubagents(),
    protections: protections.length ? protections.join(", ") : undefined,
    delegation: readDelegation(),
    unattended: readUnattended(),
  };
}

function formatK(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
