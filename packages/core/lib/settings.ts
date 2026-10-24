/**
 * Locate and safely merge pi settings.
 * Reads ~/.pi/agent/settings.json (global) or .pi/settings.json (project).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { array, isRecord, literal, nullable, object, optional, parseJson, safeParse, string, union, ValidationError, type Infer, type OptionalSchema, type Schema } from "./guard.ts";
import { extensionRelPath } from "./paths.ts";
import { parseGitSource, readDistribution, isPreviousGitSource } from "./distribution.ts";
import { isKitGitKey, isKitPackageName, isKitLocalPackageName } from "./identity.ts";
export { KIT_PACKAGE_NAME } from "./identity.ts";
import type { ResolvedExtension } from "./resolve.ts";

// --- pi's settings.json ------------------------------------------------------------------------
// pi owns this file and most of its keys, so every key (and every key of a package entry) is
// carried through untouched; only the shape of `packages` is checked here, against pi's own
// PackageSource type (node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.d.ts).

/** A package entry with resource filters. Keys this kit does not own (themes, autoload, ...) are preserved. */
export interface PackageObject {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  [key: string]: unknown;
}

/** A `packages` entry: a bare source, or a source with filters. */
export type PackageEntry = string | PackageObject;

/** pi's settings.json. Only `packages` is typed; every other key is pi's and is kept as read. */
export interface Settings {
  packages?: PackageEntry[];
  [key: string]: unknown;
}

const PackageFieldsSchema = object({
  source: string(),
  extensions: optional(array(string())),
  skills: optional(array(string())),
  prompts: optional(array(string())),
});

/** A package object: the known fields checked, every other key carried through. */
export const PackageObjectSchema: Schema<PackageObject> = {
  expected: "package object with a string source",
  parse(value, path = "value") {
    const known = PackageFieldsSchema.parse(value, path);
    return isRecord(value) ? { ...value, ...known } : known;
  },
};

export const PackageEntrySchema: Schema<PackageEntry> = union(string(), PackageObjectSchema);

/** A settings object: `packages`, when present, checked; every other key carried through. */
export const SettingsSchema: Schema<Settings> = {
  expected: "settings object",
  parse(value, path = "value") {
    if (!isRecord(value)) throw new ValidationError(path, "expected a JSON object");
    if (value.packages === undefined) return { ...value };
    return { ...value, packages: array(PackageEntrySchema).parse(value.packages, `${path}.packages`) };
  },
};

/** The source of a package entry (a bare string, or an object's `source`). */
export function packageEntrySource(entry: PackageEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Pi resolves its config directory from PI_CODING_AGENT_DIR when set (falling back to
// ~/.pi/agent) - see node_modules/@earendil-works/pi-coding-agent/docs/usage.md. Any
// deployment that sets this env var (e.g. pi-system's container, which
// points it at a durable data-root path distinct from $HOME) needs every kit script that
// locates pi's global config dir to agree, or `pi install`'s registration and the kit's
// own settings/marker reads+writes silently target different directories.
export function globalAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function globalSettingsPath(): string {
  return path.join(globalAgentDir(), "settings.json");
}

export function readSettings(settingsPath: string): Settings {
  if (!fs.existsSync(settingsPath)) return {};
  let parsed: unknown;
  try {
    parsed = parseJson(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    console.warn(`[settings] Could not parse ${settingsPath}`);
    return {};
  }
  // `null`, arrays and primitives are valid JSON but not settings objects; callers
  // dereference keys like `packages`, so fall back to {} instead of returning them.
  if (!isRecord(parsed)) return {};
  const settings = safeParse(SettingsSchema, parsed, settingsPath);
  if (settings.ok) return settings.value;
  console.warn(`[settings] Could not parse ${settingsPath} (${settings.error.message})`);
  return {};
}

// Serialise writers across processes (this installer, a /profile run, another pi session's
// installer) with an O_EXCL lock file, and replace the file atomically (tmp + rename) so pi —
// which reads settings.json at any time and writes it through its own locked writer — never
// observes a half-written file. A lock older than LOCK_STALE_MS is presumed abandoned.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withSettingsLock<T>(settingsPath: string, fn: () => T): T {
  const lock = `${settingsPath}.pi-kit.lock`;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between the failed create and the stat
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}; remove it if no installer is running`, { cause: error });
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Write any JSON object (settings.json, the install marker) atomically: tmp file + rename. */
export function writeSettingsAtomic(settingsPath: string, settings: object): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, settingsPath);
}

// Read-modify-write under the lock. `mutate` returns false to skip writing.
// A settings file that exists but does not parse is never rewritten: readSettings() falls back
// to {} for reads, and writing that back would erase every other setting the operator has. The
// same goes for a `packages` list pi itself could not read.
export function updateSettings<T>(settingsPath: string, mutate: (settings: Settings) => T): T {
  return withSettingsLock(settingsPath, () => {
    let settings: Settings = {};
    if (fs.existsSync(settingsPath)) {
      let parsed: unknown;
      try {
        parsed = parseJson(fs.readFileSync(settingsPath, "utf8"));
      } catch (error) {
        throw new Error(`Refusing to rewrite ${settingsPath}: it is not valid JSON (${errorMessage(error)}). Fix it by hand first.`, { cause: error });
      }
      if (isRecord(parsed)) {
        const checked = safeParse(SettingsSchema, parsed, settingsPath);
        if (!checked.ok) throw new Error(`Refusing to rewrite ${settingsPath}: ${checked.error.message}. Fix it by hand first.`);
        settings = checked.value;
      }
    }
    const result = mutate(settings);
    if (result !== false) writeSettingsAtomic(settingsPath, settings);
    return result;
  });
}

function isPathLikeSource(source: string): boolean {
  return !source.startsWith("npm:") && !parseGitSource(source);
}

// Retired split packages (never published, but a local registration may exist from the old
// dist/pi-kit-* exports): cleaned up like any other duplicate copy of the kit.
const LEGACY_KIT_PACKAGE_NAMES = new Set([
  "@satunix/pi-system-lite",
  ...["quick", "balanced", "long-horizon", "autonomous", "self-improving", "pentest", "engagement"].map((n) => `@satunix/pi-${n}`),
]);

/** Package name of an `npm:` source, without its version/tag (`npm:@a/b@next` -> `@a/b`). */
export function npmSourceName(source: unknown): string | null {
  if (typeof source !== "string" || !source.startsWith("npm:")) return null;
  const spec = source.slice(4).trim();
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
}

/** True for a git source of a pi-system repository, on any ref. */
export function isKitGitSource(source: unknown): boolean {
  const git = parseGitSource(source);
  return Boolean(git && (isKitGitKey(git.key) || isPreviousGitSource(source, readDistribution().git.previousSources)));
}

/** True for an npm source of this kit, on any channel or version. */
export function isKitNpmSource(source: unknown): boolean {
  return isKitPackageName(npmSourceName(source));
}

// pi normalizes local package sources to a path relative to the settings file's
// directory before writing them to settings.json (see
// node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js
// normalizePackageSourceForSettings), so a raw absolute kitSource will not
// string-match the entry `pi install` already wrote. Resolve both sides to an
// absolute path before comparing. npm sources match by package name and git sources by
// host/path, as pi's own package identity does, so `npm:x`, `npm:x@next` and `npm:x@1.2.3`
// are one entry, and so are `git:host/o/r` and `git:host/o/r@v1.2.3`.
function sourcesReferSamePackage(entrySource: string, kitSource: string, baseDir: string): boolean {
  if (entrySource === kitSource) return true;
  const entryNpm = npmSourceName(entrySource);
  if (entryNpm || npmSourceName(kitSource)) return entryNpm !== null && entryNpm === npmSourceName(kitSource);
  const entryGit = parseGitSource(entrySource);
  const kitGit = parseGitSource(kitSource);
  if (entryGit || kitGit) return entryGit !== null && entryGit.key === kitGit?.key;
  if (!isPathLikeSource(entrySource) || !isPathLikeSource(kitSource)) return false;
  const resolveAbs = (s: string): string => {
    const abs = path.isAbsolute(s) ? s : path.resolve(baseDir, s);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  };
  return resolveAbs(entrySource) === resolveAbs(kitSource);
}

// Index of the kit's package entry in settings.packages, or -1.
export function findPackageEntry(settings: Settings, kitSource: string, settingsPath: string): number {
  const baseDir = path.dirname(settingsPath);
  return (settings.packages ?? []).findIndex(p => sourcesReferSamePackage(packageEntrySource(p), kitSource, baseDir));
}

/** pi filter patterns for the kit entry; a key left undefined keeps the entry's existing filter. */
export interface PackageFilters {
  skills?: string[];
  prompts?: string[];
}

/**
 * Narrow an already-registered package entry (written by `pi install <kitSource>`)
 * to only the given resolved extensions, so --profile/--only actually control what
 * pi loads instead of being install-marker metadata only.
 * Throws if no matching package entry exists yet - callers must `pi install` first;
 * silently appending a second entry would leave the original unfiltered entry active
 * and register the package twice.
 *
 * `filters.skills` / `filters.prompts` (pi filter patterns) replace those keys when given;
 * otherwise the entry's existing keys are preserved. Keys this function does not own (themes,
 * future pi keys) are always preserved — the entry used to be rebuilt from scratch, which
 * silently wiped hand-made skill/prompt exclusions on every profile switch.
 */
export function mergePackageBlock(settingsPath: string, kitSource: string, resolvedResources: readonly ResolvedExtension[], filters: PackageFilters = {}): void {
  updateSettings(settingsPath, settings => {
    const packages = settings.packages ?? [];
    settings.packages = packages;
    const existingIdx = findPackageEntry(settings, kitSource, settingsPath);
    const existing = packages[existingIdx];
    if (existing === undefined) {
      throw new Error(`No registered package entry found for ${kitSource} in ${settingsPath} - install it first`);
    }
    const entry: PackageObject = typeof existing === "string" ? { source: existing } : { ...existing };
    entry.extensions = resolvedResources.flatMap(r => (r.avenue === "external" ? [] : [extensionRelPath(r.name, r.avenue)]));
    if (filters.skills !== undefined) {
      if (filters.skills.length) entry.skills = filters.skills;
      else delete entry.skills;
    }
    if (filters.prompts !== undefined) {
      if (filters.prompts.length) entry.prompts = filters.prompts;
      else delete entry.prompts;
    }
    packages[existingIdx] = entry;
  });
  console.log(`[settings] Updated ${settingsPath}`);
}

// Is `source` (as written in settings.json) a copy of this kit? npm: the package or a retired
// split package; git: a clone of a pi-system repository; local: a checkout whose package.json
// names the kit (current or pre-publish name) or a retired dist/pi-kit-* export.
function isKitSource(source: string, baseDir: string): boolean {
  const npmName = npmSourceName(source);
  if (npmName) return isKitPackageName(npmName) || LEGACY_KIT_PACKAGE_NAMES.has(npmName);
  const git = parseGitSource(source);
  if (git) return isKitGitSource(source);
  const dir = path.isAbsolute(source) ? source : path.resolve(baseDir, source);
  if (path.basename(dir).startsWith("pi-kit-") && path.basename(path.dirname(dir)) === "dist") return true;
  try {
    const pkg = parseJson(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const name = isRecord(pkg) ? pkg.name : undefined;
    return typeof name === "string" && (isKitLocalPackageName(name) || LEGACY_KIT_PACKAGE_NAMES.has(name));
  } catch {
    return false;
  }
}

/**
 * Keep exactly one registered copy of the kit: remove every other kit entry (another
 * checkout, a git clone, the npm package on another spec is the SAME entry and is kept, or a
 * retired dist/pi-kit-* / split npm package). Pi treats each as an independent package, and
 * two copies register every shared extension, skill, prompt and theme twice. `keep` names one
 * more entry to leave for now (a copy `pi remove` will remove, which it can do only while the
 * entry is still listed).
 */
export function removeOtherKitEntries(settingsPath: string, kitSource: string, keep: string | null = null): number {
  return updateSettings(settingsPath, settings => {
    if (!settings.packages) return false;
    const baseDir = path.dirname(settingsPath);
    const before = settings.packages.length;
    settings.packages = settings.packages.filter(entry => {
      const source = packageEntrySource(entry);
      if (sourcesReferSamePackage(source, kitSource, baseDir)) return true;
      if (keep !== null && source === keep) return true;
      return !isKitSource(source, baseDir);
    });
    const removed = before - settings.packages.length;
    if (removed === 0) return false;
    console.log(`[settings] Removed ${removed} other registered copy(ies) of the kit from ${settingsPath}`);
    return removed;
  }) || 0;
}

/**
 * pi-lean-ctx starts an MCP bridge around a separately installed `lean-ctx`
 * executable. Installing the npm extension without that executable makes Pi
 * emit a connection-closed error on every startup, so the installer must only
 * register it when the prerequisite can be found.
 */
export interface LeanCtxLookup {
  env?: Readonly<Record<string, string | undefined>>;
  /** The search path; defaults to the environment's Path / PATH. */
  pathEnv?: string;
  platform?: NodeJS.Platform;
}

export function leanCtxBinaryAvailable({ env = process.env, pathEnv = env.Path || env.PATH || "", platform = process.platform }: LeanCtxLookup = {}): boolean {
  const configured = env.PI_LEAN_CTX_BIN?.trim() || env.LEAN_CTX_BIN?.trim();
  if (configured) return fs.existsSync(configured);
  const extensions = platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (fs.existsSync(path.join(directory, `lean-ctx${extension}`))) return true;
    }
  }
  return false;
}

// --- install state marker (.pi-kit.json) ------------------------------------------------------
// install.ts writes it after a successful install (<agent dir>/.pi-kit.json, or <project>/.pi/.pi-kit.json
// for a project install); uninstall.ts, /profile and the session helpers read it back. It is a
// record of what was done, read by several kit versions, so each field is checked on its own: a
// field with the wrong type reads as absent instead of discarding the rest of the record.

export const KIT_MARKER_FILE = ".pi-kit.json";

/** `inner`, or absent when the value does not match (never a ValidationError). */
function lenient<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    optional: true,
    expected: `${inner.expected} (ignored when invalid)`,
    parse: (value, path = "value") => {
      const result = safeParse(inner, value, path);
      return result.ok ? result.value : undefined;
    },
  };
}

/** An array, keeping only its string elements. */
const stringItems: Schema<string[]> = {
  expected: "array of string",
  parse(value, path = "value") {
    if (!Array.isArray(value)) throw new ValidationError(path, "expected an array");
    return value.filter((item): item is string => typeof item === "string");
  },
};

export const KitMarkerSchema = object({
  /** The source registered with `pi install` (a checkout path, `npm:` or `git:` source). */
  kitSource: lenient(string()),
  /** A profile name, "all" (--all) or "custom" (--only). */
  profile: lenient(string()),
  /** The extensions selected for the kit entry. */
  extensions: lenient(stringItems),
  /** The overrides.json applied, or null when there were none. */
  overrides: lenient(nullable(string())),
  scope: lenient(literal("global", "project")),
  mode: lenient(literal("local", "git", "npm")),
  /** The git ref of a git install, otherwise null. */
  ref: lenient(nullable(string())),
  /** latest | next | X.Y.Z, or null for a local install. */
  channel: lenient(nullable(string())),
  /** Companion package sources this install registered; uninstall.ts passes them to `pi remove`. */
  companions: lenient(stringItems),
  installedAt: lenient(string()),
});
export type KitMarker = Infer<typeof KitMarkerSchema>;

/** The marker at `file`, or null when it is missing, unparseable or not a JSON object. */
export function readKitMarker(file: string): KitMarker | null {
  try {
    const parsed = parseJson(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? KitMarkerSchema.parse(parsed, file) : null;
  } catch {
    return null;
  }
}
