import { createHash } from "node:crypto";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeRuntime } from "./shared/node-runtime.ts";

// Self-containment rule: import only node:* builtins and the pi peer.
// No sibling imports. No toolchain-lib imports. See CONTRIBUTING.md.
//
// kit-update tells the user when pi, the pi-system kit, or a package linked to it can be
// updated, and `/update` applies it. It drives pi's own package manager (`pi update`,
// `pi install`) rather than reimplementing it, then re-applies the active profile with the
// kit's installer so a new release's extensions and reviewed companion pins take effect.
//
// The kit is delivered from git (release tags `vX.Y.Z` and the main branch of its repository)
// or from npm (dist-tags of @satunix/pi-system); packages/core/distribution.json in the kit
// says which. Both have the same channels: `latest` (the newest release), `next` (every
// commit on main) and an exact version, which is a pin and is never moved except by an
// explicit `/update channel`. If a kit release changes the delivery, `/update kit` moves the
// install over, keeping its channel and profile.
//
// pi itself moves only within the versions the installed kit release is tested with: the kit's
// package.json pins that pi version as a devDependency. A newer pi is reported, not offered.

export const KIT_PACKAGE = "@satunix/pi-system";

// Keep recognition independent of the current delivery default.
const KIT_PACKAGE_NAMES = new Set(["@satunix/pi-system", "@satunix/luna"]);
function isKitPackageName(name: unknown): boolean {
  return typeof name === "string" && KIT_PACKAGE_NAMES.has(name);
}
function isKitLocalPackageName(name: unknown): boolean {
  return isKitPackageName(name) || name === "pi-system";
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const GIT_TIMEOUT_MS = 20_000;

// --- small helpers -------------------------------------------------------------

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `obj[key]` when `obj` is a JSON object, else undefined. */
function field(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The elements of a JSON array, else none. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function isOff(value: string | undefined): boolean {
  return ["0", "off", "false", "no"].includes((value ?? "").trim().toLowerCase());
}

/** Package name and version/tag of an `npm:` source (`npm:@a/b@next` -> {name:"@a/b", spec:"next"}). */
export function parseNpmSource(source: string): { name: string; spec: string | null } | null {
  if (!source.startsWith("npm:")) return null;
  const body = source.slice(4).trim();
  const at = body.indexOf("@", body.startsWith("@") ? 1 : 0);
  return at === -1 ? { name: body, spec: null } : { name: body.slice(0, at), spec: body.slice(at + 1) };
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isExactVersion(value: string | null | undefined): boolean {
  return typeof value === "string" && SEMVER.test(value);
}

/** Semver precedence (prerelease-aware). Unparseable versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a.trim());
  const pb = SEMVER.exec(b.trim());
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const xa = pa[4].split(".");
  const xb = pb[4].split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const ia = xa[i];
    const ib = xb[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb && Number(ia) !== Number(ib)) return Number(ia) - Number(ib);
    if (na !== nb) return na ? -1 : 1;
    if (ia !== ib) return ia < ib ? -1 : 1;
  }
  return 0;
}

// --- delivery (packages/core/distribution.json) ----------------------------------

/** The public source of the kit: what an install migrates to when its registered source is retired. */
export const PUBLIC_KIT_SOURCE = "git:github.com/SATUNIX/pi-system";

/** Retired private sources (host/path keys). distribution.json may list more; these are always treated as retired. */
const BUILTIN_LEGACY_SOURCES = ["sha256:1bbc2f0c5eb44c5382561c9a9d60d688210cd833bb6f3e996010062adb26661e", "sha256:030059d98cf655b13e2e1e0e9c8cbf9f399b37295682f59f65a95b8f5f5e05a9", "sha256:435873f62f8eae368718d4365b76952caaa67ff4136de5301f6b92a653ed638a", "sha256:89ee5220340d2687c6a3bcebb6dcb08a2209218833807a4aa1589897f82cc140"];

export interface Distribution {
  /** null when the kit ships no distribution.json and PI_KIT_DELIVERY is unset. */
  delivery: "git" | "npm" | null;
  gitSource: string | null;
  branch: string;
  tagPrefix: string;
  /** Retired private sources (host/path keys, lower case): installs registered from one are migrated. */
  legacySources: string[];
  previousSources: string[];
  npmPackage: string;
  /** PI_SYSTEM_GIT_SOURCE when it names a retired source (ignored, and reported). */
  ignoredEnvSource: string | null;
}

export function readDistribution(root: string | null): Distribution {
  const config = root ? readJson(path.join(root, "packages", "core", "distribution.json")) : null;
  const git = field(config, "git");
  const previousSources = field(git, "previousSources");
  if (previousSources !== undefined && (!Array.isArray(previousSources) || previousSources.some((source: unknown) => typeof source !== "string" || !parseGitSource(source)))) {
    throw new Error("distribution.git.previousSources must be an array of git sources");
  }
  const raw = (process.env.PI_KIT_DELIVERY || str(field(config, "delivery")) || "").trim();
  const legacySources = [
    ...new Set([...BUILTIN_LEGACY_SOURCES, ...list(field(git, "legacySources")).filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase())]),
  ];
  // An override that still names a retired source (the old SSH instructions told users to export
  // one) never reconnects an install to the private remote.
  const envSource = process.env.PI_SYSTEM_GIT_SOURCE?.trim() || "";
  const envIsLegacy = envSource !== "" && isLegacyGitSource(envSource, legacySources);
  const source = str(field(git, "source"));
  const configured = source !== undefined && !isLegacyGitSource(source, legacySources) ? source : null;
  return {
    delivery: raw === "git" || raw === "npm" ? raw : null,
    gitSource: (envIsLegacy ? "" : envSource) || configured || null,
    branch: str(field(git, "branch")) || "main",
    tagPrefix: str(field(git, "tagPrefix")) ?? "v",
    legacySources,
    previousSources: list(previousSources).filter((source): source is string => typeof source === "string"),
    npmPackage: str(field(field(config, "npm"), "package")) || KIT_PACKAGE,
    ignoredEnvSource: envIsLegacy ? envSource : null,
  };
}

export interface GitSource {
  /** What git clones (`https://host/owner/repo`, `git@host:owner/repo`, ...). */
  repo: string;
  host: string;
  path: string;
  ref: string | null;
}

/** Parse a pi git source (`git:host/owner/repo[@ref]`, `git:git@host:owner/repo[@ref]`, or a URL). */
export function parseGitSource(source: string | null | undefined): GitSource | null {
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  const hasPrefix = trimmed.startsWith("git:");
  const url = hasPrefix ? trimmed.slice(4).trim() : trimmed;
  if (!hasPrefix && !/^(https?|ssh|git):\/\//i.test(url)) return null;
  let host: string;
  let rest: string;
  let rebuild: (p: string) => string;
  // Both groups of each pattern are mandatory, so a match always has them; the "" defaults only
  // satisfy the type (an empty host is rejected below).
  const scp = url.match(/^git@([^:]+):(.+)$/);
  const proto = url.match(/^([a-z]+:\/\/[^/]+)\/(.+)$/i);
  if (scp) {
    const [, scpHost = "", scpPath = ""] = scp;
    host = scpHost;
    rest = scpPath;
    rebuild = (p) => `git@${scpHost}:${p}`;
  } else if (proto) {
    const [, origin = "", protoPath = ""] = proto;
    host = origin.replace(/^[a-z]+:\/\/(?:[^@/]+@)?/i, "").replace(/:\d+$/, "");
    rest = protoPath;
    rebuild = (p) => `${origin}/${p}`;
  } else {
    const slash = url.indexOf("/");
    if (slash < 0) return null;
    host = url.slice(0, slash);
    rest = url.slice(slash + 1);
    rebuild = (p) => `https://${host}/${p}`;
  }
  const at = rest.indexOf("@");
  const repoPath = (at < 0 ? rest : rest.slice(0, at)).replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || repoPath.split("/").length < 2) return null;
  return { repo: rebuild(repoPath), host, path: repoPath, ref: at < 0 ? null : rest.slice(at + 1) || null };
}

/** The same git source on another ref (`null`: unpinned, i.e. follows the default branch). */
export function gitSourceWithRef(source: string, ref: string | null): string {
  const parsed = parseGitSource(source);
  const base = parsed?.ref ? source.slice(0, source.length - parsed.ref.length - 1) : source;
  return ref ? `${base}@${ref}` : base;
}

/** True when `source` names one of the retired private sources (any ref or URL form). */
export function isLegacyGitSource(source: string | null | undefined, legacySources: string[] = BUILTIN_LEGACY_SOURCES): boolean {
  const git = parseGitSource(source);
  return Boolean(git && legacySources.some((legacy) => { const key = `${git.host}/${git.path}`.toLowerCase(); return legacy === key || legacy === `sha256:${createHash("sha256").update(key).digest("hex")}`; }));
}

export function isKitGitSource(source: string, previousSources: readonly string[] = []): boolean {
  const git = parseGitSource(source);
  return Boolean(git && (/(^|\/)pi-system$/i.test(git.path) || `${git.host}/${git.path}`.toLowerCase() === "github.com/satunix/luna" || isPreviousGitSource(source, previousSources)));
}

function isPreviousGitSource(source: string | null, previousSources: readonly string[]): boolean {
  const git = parseGitSource(source);
  return Boolean(git && previousSources.some((previous) => {
    const other = parseGitSource(previous);
    return other && `${other.host}/${other.path}`.toLowerCase() === `${git.host}/${git.path}`.toLowerCase();
  }));
}

/** Release versions among `git ls-remote --tags` lines, oldest first. */
export function releaseTags(lsRemote: string, tagPrefix = "v"): string[] {
  const versions = new Set<string>();
  for (const line of lsRemote.split(/\r?\n/)) {
    const tag = line.match(/\trefs\/tags\/(.+?)(\^\{\})?$/)?.[1];
    if (tag?.startsWith(tagPrefix) && isExactVersion(tag.slice(tagPrefix.length))) versions.add(tag.slice(tagPrefix.length));
  }
  return [...versions].sort(compareVersions);
}

/** `latest`: the newest stable release, or the newest prerelease before any stable one exists. */
export function latestRelease(versions: string[]): string | null {
  const stable = versions.filter((v) => !v.includes("-"));
  const pool = stable.length ? stable : versions;
  return [...pool].sort(compareVersions)[pool.length - 1] ?? null;
}

/** The commit a branch points at, from `git ls-remote --heads` output. */
export function branchHead(lsRemote: string, branch: string): string | null {
  const m = lsRemote.match(new RegExp(`^([0-9a-f]{40})\\trefs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  return m?.[1] ?? null;
}

/** Runs git and resolves its stdout, or null when it fails. Never prompts for credentials. */
export type GitLike = (args: string[]) => Promise<string | null>;

export const runGit: GitLike = (args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" },
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });

// --- where and how the kit is installed ------------------------------------------

export interface KitInstall {
  kind: "npm" | "local" | "git" | "none";
  scope: "user" | "project";
  /** The source string exactly as written in settings.json. */
  source: string | null;
  /** npm and git: "latest", "next", or the pinned version (npm: also any other dist-tag). */
  channel: string | null;
  pinned: boolean;
  /** The kit's package root on disk (for its installer and sources.json), when known. */
  root: string | null;
  version: string | null;
  /** git and local installs: the checked-out commit (filled in by checkForUpdates). */
  commit?: string | null;
  /** git only: the registered source is a retired private one; /update kit migrates it to the public source. */
  legacy?: boolean;
}

interface PackageEntry {
  source: string;
  scope: "user" | "project";
  settingsFile: string;
}

function settingsFiles(cwd: string): Array<{ file: string; scope: "user" | "project" }> {
  return [
    { file: path.join(cwd, ".pi", "settings.json"), scope: "project" },
    { file: path.join(agentDir(), "settings.json"), scope: "user" },
  ];
}

/** Every package entry pi would load, project scope first (it wins over user scope). */
export function packageEntries(cwd: string): PackageEntry[] {
  const out: PackageEntry[] = [];
  for (const { file, scope } of settingsFiles(cwd)) {
    for (const pkg of list(field(readJson(file), "packages"))) {
      const source = typeof pkg === "string" ? pkg : field(pkg, "source");
      if (typeof source === "string" && source.trim()) out.push({ source, scope, settingsFile: file });
    }
  }
  return out;
}

function gitInstallDir(git: GitSource, scope: "user" | "project", cwd: string): string {
  const root = scope === "project" ? path.join(cwd, ".pi", "git") : path.join(agentDir(), "git");
  return path.join(root, git.host, ...git.path.split("/"));
}

/** The channel recorded by the installer for this exact source, if it is the recorded one. */
function recordedChannel(source: string, cwd: string): string | null {
  const marker = readMarker(cwd);
  if (typeof marker.channel !== "string" || typeof marker.kitSource !== "string") return null;
  const a = parseGitSource(marker.kitSource);
  const b = parseGitSource(source);
  const same = a && b ? a.host === b.host && a.path === b.path && a.ref === b.ref : marker.kitSource === source;
  return same ? marker.channel : null;
}

function npmInstallDir(name: string, scope: "user" | "project", cwd: string): string {
  const root = scope === "project" ? path.join(cwd, ".pi", "npm") : path.join(agentDir(), "npm");
  return path.join(root, "node_modules", ...name.split("/"));
}

function installedVersionAt(dir: string): string | null {
  const v = field(readJson(path.join(dir, "package.json")), "version");
  return typeof v === "string" ? v : null;
}

/**
 * The kit installer under a kit root, by stem (internal/docs/adr/0001): install.ts in a checkout or
 * git install, install.js in the compiled npm artefact, install.mjs in kits from before the
 * TypeScript migration (a delivery or channel switch can land on one).
 */
function kitInstaller(root: string): string | null {
  for (const name of ["install.ts", "install.js", "install.mjs"]) {
    const candidate = path.join(root, "packages", "core", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isKitRoot(dir: string): boolean {
  const name = field(readJson(path.join(dir, "package.json")), "name");
  return isKitLocalPackageName(name) && kitInstaller(dir) !== null;
}

/** The kit root this extension was loaded from (PI_KIT_ROOT overrides, as for /profile). */
export function ownKitRoot(): string | null {
  const override = process.env.PI_KIT_ROOT?.trim();
  if (override) return isKitRoot(override) ? override : null;
  try {
    // <root>/packages/extensions/src/kit-update/index.ts
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    return isKitRoot(root) ? root : null;
  } catch {
    return null;
  }
}

/** A user agent-dir role copy that shadows a shipped kit role with different content. */
export interface StaleRoleCopy {
  name: string;
  path: string;
}

/** Shipped kit roles: `<kitRoot>/packages/kit/agents/*.md`, filename stem -> file content. Empty when there is no readable kit root. */
export function shippedRoles(kitRoot: string | null): Map<string, string> {
  const roles = new Map<string, string>();
  if (!kitRoot) return roles;
  let files: string[];
  try {
    files = fs.readdirSync(path.join(kitRoot, "packages", "kit", "agents"));
  } catch {
    return roles;
  }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      roles.set(file.slice(0, -3), fs.readFileSync(path.join(kitRoot, "packages", "kit", "agents", file), "utf8"));
    } catch {
      /* an unreadable role is simply not shipped */
    }
  }
  return roles;
}

/**
 * User agent-dir role copies (`<agentDir>/agents/*.md`) whose name is a shipped kit role but whose
 * content differs. Byte-equal copies are harmless and non-kit roles are ignored. Report-only: nothing
 * is deleted.
 */
export function detectStaleRoleCopies(agentDir: string, kitRoot: string | null): StaleRoleCopy[] {
  const shipped = shippedRoles(kitRoot);
  const dir = path.join(agentDir, "agents");
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const stale: StaleRoleCopy[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    const shippedContent = shipped.get(name);
    if (shippedContent === undefined) continue;
    const filePath = path.join(dir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (content !== shippedContent) stale.push({ name, path: filePath });
  }
  return stale.sort((a, b) => a.name.localeCompare(b.name));
}

function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export function detectKitInstall(cwd: string): KitInstall {
  const own = ownKitRoot();
  for (const entry of packageEntries(cwd)) {
    const npm = parseNpmSource(entry.source);
    if (npm) {
      if (!isKitPackageName(npm.name)) continue;
      const dir = npmInstallDir(npm.name, entry.scope, cwd);
      const root = isKitRoot(dir) ? dir : own;
      const pinned = isExactVersion(npm.spec);
      return { kind: "npm", scope: entry.scope, source: entry.source, channel: npm.spec ?? "latest", pinned, root, version: root ? installedVersionAt(root) : null };
    }
    const git = parseGitSource(entry.source);
    if (git) {
      const dir = gitInstallDir(git, entry.scope, cwd);
      const root = isKitRoot(dir) ? dir : own;
      if (!isKitGitSource(entry.source, readDistribution(root).previousSources)) continue;
      const prefix = readDistribution(root).tagPrefix;
      const inferred = !git.ref ? "next" : git.ref.startsWith(prefix) && isExactVersion(git.ref.slice(prefix.length)) ? "latest" : git.ref;
      const channel = recordedChannel(entry.source, cwd) ?? inferred;
      const legacy = isLegacyGitSource(entry.source, readDistribution(root).legacySources);
      return { kind: "git", scope: entry.scope, source: entry.source, channel, pinned: channel !== "latest" && channel !== "next", root, version: root ? installedVersionAt(root) : null, legacy };
    }
    const dir = path.resolve(path.dirname(entry.settingsFile), entry.source);
    if (isKitRoot(dir) || (own && sameDir(dir, own))) {
      return { kind: "local", scope: entry.scope, source: entry.source, channel: null, pinned: false, root: dir, version: installedVersionAt(dir) };
    }
  }
  return { kind: "none", scope: "user", source: null, channel: null, pinned: false, root: own, version: own ? installedVersionAt(own) : null };
}

// --- registry -------------------------------------------------------------------

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function registryBase(): string {
  return (process.env.PI_KIT_NPM_REGISTRY?.trim() || "https://registry.npmjs.org").replace(/\/+$/, "");
}

/** dist-tags of an npm package ({latest, next, ...}), or null when unreachable. */
export async function fetchDistTags(name: string, fetchImpl: FetchLike): Promise<Record<string, string> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${registryBase()}/-/package/${name.replace(/\//g, "%2f")}/dist-tags`;
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const tags = await res.json();
    if (!tags || typeof tags !== "object") return null;
    // A dist-tag maps a tag name to a version string; anything else in the payload is not one.
    return Object.fromEntries(Object.entries(tags).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- the check ------------------------------------------------------------------

export interface PackageStatus {
  source: string;
  name: string;
  scope: "user" | "project";
  installed: string | null;
  /** The kit's reviewed pin for this companion (packages/core/sources.json), if any. */
  kitPin: string | null;
  latest: string | null;
  /** reconcile: registered spec differs from the kit's pin; update: unpinned and behind; pinned: newer exists but the spec is pinned. */
  action: "reconcile" | "update" | "pinned" | null;
}

export interface UpdateReport {
  /** The working directory the check ran in: which marker the runtime readers resolve. */
  cwd: string;
  checkedAt: string;
  pi: {
    current: string;
    latest: string | null;
    /** `latest` is newer than `current` and not past `tested`, so /update offers it. */
    available: boolean;
    /** The pi version this kit release is tested with (its pinned devDependency), or null when unknown. */
    tested: string | null;
    /** A newer pi exists but is past `tested`: reported, not offered. */
    beyondTested: boolean;
  };
  kit: KitInstall & {
    target: string | null;
    available: boolean;
    note: string | null;
    /** What each channel currently points at: npm dist-tags, or for git the newest release tag and main's commit. */
    tags: Record<string, string> | null;
    /** The delivery this install should move to (a kit release changed it), or null. */
    migrateTo: "git" | "npm" | null;
    /** A previous public repository moving to the current git.source. */
    migrateSource?: string | null;
    /** A local checkout whose `origin` is a retired private source: it is never contacted, so it is never pulled. */
    legacyOrigin?: boolean;
  };
  packages: PackageStatus[];
  staleRoles: StaleRoleCopy[];
  /** True when at least one registry or git lookup failed (results may be incomplete). */
  offline: boolean;
}

function kitPins(root: string | null): Map<string, string> {
  const pins = new Map<string, string>();
  const sources = root ? readJson(path.join(root, "packages", "core", "sources.json")) : null;
  for (const e of list(field(sources, "external"))) {
    const source = field(e, "source");
    if (typeof source !== "string") continue;
    const npm = parseNpmSource(source);
    if (npm) pins.set(npm.name, source);
  }
  return pins;
}

/** The pi version the kit at `root` is tested with: its exact `devDependencies` pin of pi, or null. */
export function testedPiVersion(root: string | null): string | null {
  const pin = root ? str(field(field(readJson(path.join(root, "package.json")), "devDependencies"), PI_PACKAGE)) : undefined;
  return pin !== undefined && isExactVersion(pin) ? pin : null;
}

export async function checkForUpdates(cwd: string, fetchImpl: FetchLike, piVersion: string = PI_VERSION, git: GitLike = runGit): Promise<UpdateReport> {
  const kit = detectKitInstall(cwd);
  const dist = readDistribution(kit.root);
  const previousSource = kit.kind === "git" && !kit.legacy && isPreviousGitSource(kit.source, dist.previousSources)
    && dist.gitSource !== null && !isPreviousGitSource(kit.source, [dist.gitSource]);
  const migrateSource = previousSource ? dist.gitSource : null;
  const migrateTo = dist.delivery && (kit.kind === "git" || kit.kind === "npm") && dist.delivery !== kit.kind ? dist.delivery : null;
  const pins = kitPins(kit.root);
  const others = packageEntries(cwd).flatMap((e) => {
    const npm = parseNpmSource(e.source);
    return npm && !isKitPackageName(npm.name) ? [{ ...e, npm }] : [];
  });
  const names = [...new Set(others.map((e) => e.npm.name))];
  const wantKitTags = kit.kind === "npm" || migrateTo === "npm";
  const [piTags, kitTags, ...pkgTags] = await Promise.all([
    fetchDistTags(PI_PACKAGE, fetchImpl),
    wantKitTags ? fetchDistTags(kit.kind === "npm" ? parseNpmSource(kit.source ?? "")?.name ?? dist.npmPackage : dist.npmPackage, fetchImpl) : Promise.resolve(null),
    ...names.map((n) => fetchDistTags(n, fetchImpl)),
  ]);
  const tagsByName = new Map(names.map((n, i) => [n, pkgTags[i]]));
  let offline = !piTags || (wantKitTags && !kitTags) || pkgTags.some((t) => !t);

  const piLatest = piTags?.latest ?? null;
  const piTested = testedPiVersion(kit.root);
  const piNewer = Boolean(piLatest && compareVersions(piLatest, piVersion) > 0);
  const piBeyondTested = Boolean(piNewer && piLatest && piTested && compareVersions(piLatest, piTested) > 0);
  const pi = { current: piVersion, latest: piLatest, available: piNewer && !piBeyondTested, tested: piTested, beyondTested: piBeyondTested };

  let target: string | null = null;
  let available = false;
  let note: string | null = null;
  let tags: Record<string, string> | null = kitTags;
  let commit: string | null = null;
  let legacyOrigin = false;
  if (migrateSource && !migrateTo) {
    available = true;
    target = `${migrateSource.replace(/^git:/, "")} (${kit.channel ?? "latest"})`;
    note = `pi-system is registered from a previous public source; /update kit moves it to ${migrateSource}, keeping channel ${kit.channel ?? "latest"} and the same profile`;
  } else if (migrateTo) {
    available = true;
    target = `${migrateTo} delivery`;
    note = `pi-system is now delivered from ${migrateTo}: /update kit moves this install (channel ${kit.channel ?? "latest"}, same profile)`;
  } else if (kit.kind === "npm") {
    if (kit.pinned) {
      note = `pinned to ${kit.channel}; /update channel latest|next to follow a channel`;
      target = kitTags?.latest ?? null;
    } else {
      target = kitTags?.[kit.channel ?? "latest"] ?? null;
      available = Boolean(target && kit.version && compareVersions(target, kit.version) > 0);
      if (kitTags && !target) note = `no "${kit.channel}" dist-tag is published`;
    }
  } else if (kit.kind === "git" && kit.legacy) {
    // Never contact the retired private remote: the move goes to the public source. A pinned
    // private tag does not exist publicly, so anything but `next` follows the newest release.
    const publicSource = dist.gitSource && !isLegacyGitSource(dist.gitSource, dist.legacySources) ? dist.gitSource : PUBLIC_KIT_SOURCE;
    const channel = kit.channel === "next" ? "next" : "latest";
    available = true;
    target = `${publicSource.replace(/^git:/, "")} (${channel})`;
    note = `pi-system is registered from a retired private source (${kit.source}); /update kit moves it to ${publicSource.replace(/^git:/, "")} on channel ${channel}, keeping the profile and your hand edits`;
    if (dist.ignoredEnvSource) note += `. PI_SYSTEM_GIT_SOURCE=${dist.ignoredEnvSource} names the retired source and is ignored; unset it`;
  } else if (kit.kind === "git") {
    // detectKitInstall only reports kind "git" for a source parseGitSource accepted.
    const source = parseGitSource(kit.source);
    if (!source) throw new Error(`pi-system: cannot parse the git source ${String(kit.source)}`);
    const [remote, head] = await Promise.all([git(["ls-remote", "--tags", "--heads", source.repo]), kit.root ? git(["-C", kit.root, "rev-parse", "HEAD"]) : Promise.resolve(null)]);
    commit = head?.trim() || null;
    if (remote === null) {
      offline = true;
      note = `could not reach ${source.repo} (git ls-remote failed: offline, or no git credentials for it)`;
    } else {
      const latest = latestRelease(releaseTags(remote, dist.tagPrefix));
      const main = branchHead(remote, dist.branch);
      tags = { latest: latest ?? "-", next: main ? `${dist.branch}@${main.slice(0, 7)}` : "-" };
      if (kit.channel === "next") {
        target = main ? `${dist.branch}@${main.slice(0, 7)}` : null;
        available = Boolean(main && commit && main !== commit);
      } else if (kit.channel === "latest") {
        target = latest;
        available = Boolean(latest && kit.version && compareVersions(latest, kit.version) > 0);
        if (!latest) note = `no release tags (${dist.tagPrefix}X.Y.Z) in ${source.repo} yet`;
      } else {
        target = latest;
        note = `pinned to ${kit.channel}; /update channel latest|next to follow a channel`;
      }
    }
  } else if (kit.kind === "local") {
    note = "local checkout: /update kit pulls it with git (fast-forward only)";
    if (kit.root) {
      const [head, branch] = await Promise.all([git(["-C", kit.root, "rev-parse", "HEAD"]), git(["-C", kit.root, "rev-parse", "--abbrev-ref", "HEAD"])]);
      commit = head?.trim() || null;
      const name = branch?.trim();
      // A checkout whose origin is a retired private source is never contacted (no ls-remote, no pull): the host may not exist
      // for this machine, and "up to date" from a failed contact would be false. The operator re-points it or reinstalls.
      const originUrl = (await git(["-C", kit.root, "remote", "get-url", "origin"]))?.trim() ?? null;
      // `git remote get-url` may print a URL or the scp form (git@host:owner/repo), which parseGitSource reads with its `git:` prefix.
      legacyOrigin = Boolean(originUrl && isLegacyGitSource(/^[a-z][a-z+.-]*:\/\//i.test(originUrl) ? originUrl : `git:${originUrl}`, dist.legacySources));
      if (legacyOrigin) {
        offline = true; // nothing was looked up, so the report must not read as "up to date"
        note = `this checkout's origin (${originUrl}) is a retired private source, so /update does not contact it. Install from ${PUBLIC_KIT_SOURCE.replace(/^git:/, "")} (pi install ${PUBLIC_KIT_SOURCE}) or point origin at the public repository; see docs/migration.md`;
      } else if (commit && name && name !== "HEAD") {
        const remote = await git(["-C", kit.root, "ls-remote", "origin", `refs/heads/${name}`]);
        const upstream = remote ? branchHead(remote, name) : null;
        if (remote === null) offline = true;
        // Behind only if upstream moved to a commit this checkout does not already contain.
        const contained = upstream ? (await git(["-C", kit.root, "merge-base", "--is-ancestor", upstream, "HEAD"])) !== null : true;
        if (upstream && upstream !== commit && !contained) {
          available = true;
          target = `${name}@${upstream.slice(0, 7)}`;
        }
      }
    }
  } else {
    note = `pi-system is not registered in pi settings`;
  }

  const packages: PackageStatus[] = others.map((e) => {
    const npm = e.npm;
    const installed = installedVersionAt(npmInstallDir(npm.name, e.scope, cwd));
    const latest = tagsByName.get(npm.name)?.latest ?? null;
    const kitPin = pins.get(npm.name) ?? null;
    let action: PackageStatus["action"] = null;
    if (kitPin && kitPin !== e.source) action = "reconcile";
    else if (!isExactVersion(npm.spec) && latest && installed && compareVersions(latest, installed) > 0) action = "update";
    else if (npm.spec !== null && isExactVersion(npm.spec) && latest && compareVersions(latest, npm.spec) > 0) action = "pinned";
    return { source: e.source, name: npm.name, scope: e.scope, installed, kitPin, latest, action };
  });

  return { cwd, checkedAt: new Date().toISOString(), pi, kit: { ...kit, commit, target, available, note, tags, migrateTo, migrateSource, ...(legacyOrigin ? { legacyOrigin } : {}) }, packages, staleRoles: detectStaleRoleCopies(agentDir(), kit.root), offline };
}

/** Anything the user can act on (pinned-only notices do not count). */
export function hasUpdates(report: UpdateReport): boolean {
  return report.pi.available || report.kit.available || report.packages.some((p) => p.action === "reconcile" || p.action === "update");
}

export function summaryLine(report: UpdateReport): string {
  const parts: string[] = [];
  if (report.kit.legacy) parts.push("pi-system is on a retired private source and moves to the public one");
  else if (report.kit.migrateTo) parts.push(`pi-system moves to ${report.kit.migrateTo} delivery`);
  else if (report.kit.available) parts.push(`pi-system ${report.kit.version} → ${report.kit.target}${report.kit.channel ? ` (${report.kit.channel})` : ""}`);
  if (report.pi.available) parts.push(`pi ${report.pi.current} → ${report.pi.latest}`);
  const pkgs = report.packages.filter((p) => p.action === "reconcile" || p.action === "update");
  if (pkgs.length) parts.push(`${pkgs.length} linked package${pkgs.length === 1 ? "" : "s"}`);
  if (parts.length) return `Updates available: ${parts.join(", ")}. Run /update.`;
  // A lookup that failed is not evidence that nothing is new.
  return report.offline ? "Could not check everything (a lookup failed: offline, or no credentials for a remote), so this may not be up to date. /update status says which." : "Everything is up to date.";
}

export function formatReport(report: UpdateReport): string {
  const k = report.kit;
  const lines = ["pi-system update status", ""];
  const kitWhere =
    k.kind === "npm" || k.kind === "git"
      ? `${k.kind}, channel ${k.pinned ? `pinned ${k.channel}` : k.channel}${k.scope === "project" ? ", project scope" : ""}`
      : k.kind;
  const at = k.commit ? ` @${k.commit.slice(0, 7)}` : "";
  lines.push(`  pi-system  ${k.version ?? "?"}${at}  [${kitWhere}${k.legacy ? ", retired private source" : ""}]${k.available ? `  →  ${k.target}` : (k.kind === "npm" || k.kind === "git") && k.target && !k.pinned ? "  (up to date)" : ""}`);
  if (k.tags) lines.push(`             ${k.kind === "git" ? "available" : "published"}: latest ${k.tags.latest ?? "-"}, next ${k.tags.next ?? "-"}`);
  if (k.note) lines.push(`             ${k.note}`);
  const piInfo = report.pi;
  const piState = piInfo.available
    ? `  →  ${piInfo.latest}`
    : piInfo.beyondTested
      ? `  (${piInfo.latest} is out, past the tested ${piInfo.tested}: update pi-system first, or run "pi update --self" yourself)`
      : piInfo.latest
        ? "  (up to date)"
        : "  (latest unknown)";
  const piAhead = piInfo.tested && compareVersions(piInfo.current, piInfo.tested) > 0 ? `  [newer than the tested ${piInfo.tested}]` : "";
  lines.push(`  pi         ${piInfo.current}${piState}${piAhead}`);
  if (report.packages.length) {
    lines.push("", "  Linked packages:");
    for (const p of report.packages) {
      const state =
        p.action === "reconcile"
          ? `→ ${p.kitPin?.replace(/^npm:/, "")} (kit's reviewed pin)`
          : p.action === "update"
            ? `→ ${p.latest}`
            : p.action === "pinned"
              ? `pinned; ${p.latest} exists (the kit moves this pin after review)`
              : "up to date";
      lines.push(`    ${p.name.padEnd(22)} ${(p.installed ?? "not installed").padEnd(12)} ${state}`);
    }
  }
  if (report.offline) lines.push("", "  Some registry or git lookups failed (offline?); results may be incomplete.");
  const staleRoles = report.staleRoles ?? [];
  if (staleRoles.length) {
    lines.push("", `  Stale role copies in ${agentDir()}/agents (shadow the shipped kit roles; delete or update them):`);
    for (const role of staleRoles) lines.push(`    ${role.name}  ${role.path}`);
  }
  lines.push("", "  /update            pick what to update", "  /update all        update everything, re-apply the profile, reload", "  /update channel <latest|next|X.Y.Z>   switch the kit's release channel");
  return lines.join("\n");
}

// --- throttle state -------------------------------------------------------------

function stateFile(): string {
  return path.join(agentDir(), "pi-kit", "update-check.json");
}

function checkIntervalMs(): number {
  const hours = Number(process.env.PI_KIT_UPDATE_CHECK_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : DAY_MS;
}

export function shouldCheckNow(now = Date.now()): boolean {
  const last = Date.parse(str(field(readJson(stateFile()), "checkedAt")) ?? "");
  return !Number.isFinite(last) || now - last >= checkIntervalMs();
}

// --- actions --------------------------------------------------------------------

// Under a compiled pi binary process.execPath IS pi; otherwise rely on PATH.
function piBinary(): string {
  const exe = (process.execPath || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  return exe === "pi" ? process.execPath : "pi";
}

// The installer is a Node script; never pi itself (./shared/node-runtime.ts). With none found,
// bare `node` keeps the old behaviour: the step reports that it cannot be run.
function nodeBinary(): string {
  const runtime = nodeRuntime();
  return runtime.ok ? runtime.command : "node";
}

/** The install marker fields kit-update reads; each is a string or absent. */
interface MarkerData {
  profile?: string;
  scope?: string;
  kitSource?: string;
  channel?: string;
  installedAt?: string;
}

const MARKER_FIELDS = ["profile", "scope", "kitSource", "channel", "installedAt"] as const;

/**
 * Resolve the install marker the way uninstall.ts does: a project marker in the
 * working directory wins when it exists, otherwise the global marker under the agent
 * dir. A missing or unparseable marker yields {} rather than throwing, and a field
 * that is not a string reads as absent.
 */
function readMarker(cwd: string): MarkerData {
  const projectMarker = path.join(cwd, ".pi", ".pi-kit.json");
  const file = fs.existsSync(projectMarker) ? projectMarker : path.join(agentDir(), ".pi-kit.json");
  const raw = readJson(file);
  const marker: MarkerData = {};
  for (const key of MARKER_FIELDS) {
    const value = field(raw, key);
    if (typeof value === "string") marker[key] = value;
  }
  return marker;
}

/**
 * The scope to pass back to the installer. The scope derived from settings
 * (`detectKitInstall`) is authoritative; the marker is the fallback so a project
 * install is never silently re-registered globally.
 */
function effectiveScope(kit: KitInstall, marker: MarkerData): "project" | "global" | null {
  if (kit.scope === "project" || marker.scope === "project") return "project";
  return marker.scope === "global" ? "global" : null;
}

/**
 * One command of an update plan. `verify` runs after the command exits 0 and returns a problem
 * description when the update did not actually take effect (a package manager that exits 0
 * without moving anything must never be reported as an update). `null` means verified.
 */
/** What a step's `verify` says: null (the update took effect), a problem (it did not), or that it could not be checked. */
type Verdict = string | null | { unverified: string };
// `verify: undefined` (set explicitly when there is nothing to check against) means the same as no verify.
// `changesKit` marks a step that replaces the kit's code and says what it was before (with a command
// back when one exists); `reapplies` marks a step that re-applies the profile. A plan that stops
// between the two leaves the new kit under the previous profile's settings, and says so.
type Step = { label: string; command: string; args: string[]; cwd?: string; verify?: (() => Promise<Verdict>) | undefined; changesKit?: string; reapplies?: boolean };

/** What the kit was before a step replaces it, and the command that returns to it when there is one. */
function kitBefore(kit: KitInstall, switching = false): string {
  const was = `pi-system ${kit.version ?? "(unknown version)"}${kit.channel ? ` on ${kit.channel}` : ""}${kit.commit ? ` (commit ${kit.commit.slice(0, 12)})` : ""}`;
  if (switching && kit.channel && isChannelName(kit.channel)) return `${was}; /update channel ${kit.channel} goes back`;
  if ((kit.kind === "npm" || (kit.kind === "git" && kit.channel !== "next")) && isExactVersion(kit.version)) return `${was}; /update channel ${kit.version} goes back to it`;
  if (kit.kind === "local" && kit.root && kit.commit) return `${was}; git -C "${kit.root}" reset --keep ${kit.commit.slice(0, 12)} goes back to it`;
  return was;
}

function tail(result: ExecResult): string {
  return (result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-12).join("\n");
}

/** Project scope from either the settings entry (authoritative) or the marker. */
function isProjectScoped(cwd: string, marker = readMarker(cwd)): boolean {
  return detectKitInstall(cwd).scope === "project" || marker.scope === "project";
}

/** Re-apply the recorded profile with the (possibly just updated) kit installer. */
function reconcileStep(kit: KitInstall, cwd: string, extraArgs: string[] = []): Step | null {
  const marker = readMarker(cwd);
  const profile = typeof marker.profile === "string" && !["custom", "all"].includes(marker.profile) ? marker.profile : null;
  const root = kit.kind === "npm" ? (kit.root ?? null) : kit.root;
  if (!profile || !root) return null;
  const installer = kitInstaller(root);
  if (!installer) return null;
  const args = [installer, "--profile", profile, "--yes", "--settings-only", ...extraArgs];
  const scope = effectiveScope(kit, marker);
  if (scope) args.push("--scope", scope);
  // install.ts derives the project settings/marker paths from process.cwd(), so a project
  // install must run in the user's project, not in the kit root (which would write into the
  // kit checkout and never update the project). Global scope keeps the kit root as before.
  return { label: `re-apply the ${profile} profile`, command: nodeBinary(), args, cwd: scope === "project" ? cwd : root, reapplies: true };
}

function recordedProfile(cwd: string): string {
  const marker = readMarker(cwd);
  return typeof marker.profile === "string" && !["custom", "all"].includes(marker.profile) ? marker.profile : "balanced";
}

/** Run the kit's installer from `root` to register the kit on another delivery or channel. */
function installerStep(root: string, label: string, mode: "git" | "npm", channel: string, settingsOnly: boolean, cwd: string): Step | null {
  const installer = kitInstaller(root);
  if (!installer) return null;
  const args = [installer, "--mode", mode, "--channel", channel, "--profile", recordedProfile(cwd), "--yes", ...(settingsOnly ? ["--settings-only"] : [])];
  // Project scope, like reconcileStep, must run install.ts in the user's project so
  // process.cwd() inside it is the project rather than the kit root. The settings entry is
  // authoritative, so a project install without a marker (the inconsistent state) is still
  // treated as project scope.
  const project = isProjectScoped(cwd);
  if (project) args.push("--scope", "project");
  return { label, command: nodeBinary(), args, cwd: project ? cwd : root };
}

/** After the step: the kit must now be registered and installed at `expected`. */
function verifyKitVersion(cwd: string, expected: string): () => Promise<string | null> {
  return async () => {
    const after = detectKitInstall(cwd);
    if (after.version === expected) return null;
    return `pi-system is ${after.version ?? "not installed"} after the update, expected ${expected}`;
  };
}

/** After the step: the kit's checkout must be at the commit `next` pointed at (`main@abc1234`). */
function verifyKitCommit(root: string | null, target: string | null, git: GitLike): () => Promise<string | null> {
  return async () => {
    const want = target?.split("@")[1];
    if (!root || !want) return null;
    const head = (await git(["-C", root, "rev-parse", "HEAD"]))?.trim() ?? null;
    return head?.startsWith(want) ? null : `pi-system is at ${head ? head.slice(0, 7) : "an unknown commit"} after the update, expected ${want}`;
  };
}

function verifyPackageVersion(name: string, scope: "user" | "project", cwd: string, expected: string): () => Promise<string | null> {
  return async () => {
    const now = installedVersionAt(npmInstallDir(name, scope, cwd));
    return now && compareVersions(now, expected) >= 0 ? null : `${name} is ${now ?? "not installed"} after the update, expected ${expected}`;
  };
}

/** After `pi update --self`: the pi on PATH must now report the new version (the running process still has the old one). */
function verifyPiVersion(pi: ExtensionAPI, cwd: string, expected: string): () => Promise<Verdict> {
  return async () => {
    let out: string;
    try {
      const result = await pi.exec(piBinary(), ["--version"], { cwd, timeout: 30_000 });
      out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    } catch {
      return { unverified: `could not run \`${piBinary()} --version\` to check that pi is now ${expected}` }; // not evidence either way, and not reported as verified
    }
    return out.includes(expected) ? null : `pi reports "${out.trim().split(/\r?\n/)[0] ?? ""}" after the update, expected ${expected}`;
  };
}

/** After the profile is re-applied: the install marker must have been rewritten by this step. */
function verifyReconciled(cwd: string, startedAt: () => number): () => Promise<string | null> {
  return async () => {
    const at = Date.parse(readMarker(cwd).installedAt ?? "");
    return Number.isFinite(at) && at >= startedAt() - 1000 ? null : "the profile was not re-applied (the install marker was not rewritten)";
  };
}

export function planUpdate(report: UpdateReport, what: "all" | "kit" | "pi" | "packages", pi_: ExtensionAPI | null = null, git: GitLike = runGit): { steps: Step[]; notes: string[] } {
  const steps: Step[] = [];
  const notes: string[] = [];
  const kit = report.kit;
  const pi = piBinary();
  const scopeFlag = kit.scope === "project" ? ["-l"] : [];
  let kitChanged = false;
  let planStart = Date.now();
  const startedAt = () => planStart;

  if (what === "kit" || what === "all") {
    if (kit.kind === "git" && kit.legacy && kit.root) {
      // The retired private source is never contacted: the installer registers the public source
      // (capturing hand edits as overrides first) and applies the recorded profile itself.
      const channel = kit.channel === "next" ? "next" : "latest";
      const step = installerStep(kit.root, `move pi-system from the retired private source to the public source (${channel})`, "git", channel, false, report.cwd);
      if (step) {
        step.verify = async () => {
          const after = detectKitInstall(report.cwd);
          return after.kind === "git" && !after.legacy ? null : "pi-system is still registered from the retired private source";
        };
        steps.push(step);
      } else notes.push("pi-system: cannot locate the kit installer to leave the retired private source. Reinstall from the public repository (see docs/INSTALL.md).");
    } else if (kit.migrateSource && !kit.migrateTo) {
      const channel = kit.channel && isChannelName(kit.channel) ? kit.channel : "latest";
      const step = kit.root ? installerStep(kit.root, `move pi-system to ${kit.migrateSource} (${channel})`, "git", channel, false, report.cwd) : null;
      if (step) {
        step.verify = async () => {
          const after = detectKitInstall(report.cwd);
          return after.kind === "git" && isPreviousGitSource(after.source, [kit.migrateSource ?? ""]) && after.channel === channel
            ? null : "pi-system has not moved to the current public source on the same channel";
        };
        steps.push(step);
      } else notes.push("pi-system: cannot locate the kit installer to move to the current public source.");
    } else if (kit.migrateTo && kit.root) {
      const channel = kit.channel && isChannelName(kit.channel) ? kit.channel : "latest";
      const step = installerStep(kit.root, `move pi-system to ${kit.migrateTo} delivery (${channel})`, kit.migrateTo, channel, false, report.cwd);
      if (step) steps.push(step);
      else notes.push(`pi-system: cannot locate the kit installer to move to ${kit.migrateTo} delivery.`);
    } else if (kit.kind === "npm" && kit.available && kit.source) {
      steps.push({ label: `update pi-system to ${kit.target}`, command: pi, args: ["update", kit.source], verify: kit.target ? verifyKitVersion(report.cwd, kit.target) : undefined, changesKit: kitBefore(kit) });
      kitChanged = true;
    } else if (kit.kind === "git" && kit.available && kit.source) {
      if (kit.channel === "next") {
        steps.push({ label: `update pi-system to ${kit.target}`, command: pi, args: ["update", kit.source], verify: verifyKitCommit(kit.root, kit.target, git), changesKit: kitBefore(kit) });
      } else {
        const prefix = readDistribution(kit.root).tagPrefix;
        steps.push({ label: `update pi-system to ${kit.target}`, command: pi, args: ["install", gitSourceWithRef(kit.source, `${prefix}${kit.target}`), ...scopeFlag], verify: kit.target ? verifyKitVersion(report.cwd, kit.target) : undefined, changesKit: kitBefore(kit) });
      }
      kitChanged = true;
    } else if (kit.kind === "local" && kit.legacyOrigin) {
      notes.push(`pi-system: ${kit.note}`);
    } else if (kit.kind === "local" && kit.root && (kit.available || what === "kit")) {
      steps.push({ label: "pull the local checkout (fast-forward only)", command: "git", args: ["-C", kit.root, "pull", "--ff-only"], changesKit: kitBefore(kit) });
      kitChanged = true;
    } else if (what === "kit" && kit.note) {
      notes.push(`pi-system: ${kit.note}`);
    }
  }
  if (what === "packages" || what === "all") {
    const unpinned = report.packages.filter((p) => p.action === "update");
    for (const p of unpinned) steps.push({ label: `update ${p.name} to ${p.latest}`, command: pi, args: ["update", p.source], verify: p.latest ? verifyPackageVersion(p.name, p.scope, report.cwd, p.latest) : undefined });
  }
  const needsReconcile = kitChanged || ((what === "packages" || what === "all") && report.packages.some((p) => p.action === "reconcile"));
  if (needsReconcile) {
    const step = reconcileStep(kit, report.cwd);
    if (step) {
      step.verify = verifyReconciled(report.cwd, startedAt);
      steps.push(step);
    } else notes.push("No recorded profile to re-apply; run /profile to apply one so new extensions and companion pins load.");
  }
  if ((what === "pi" || what === "all") && report.pi.available) {
    steps.push({ label: `update pi to ${report.pi.latest}`, command: pi, args: ["update", "--self"], verify: pi_ && report.pi.latest ? verifyPiVersion(pi_, report.cwd, report.pi.latest) : undefined });
  } else if ((what === "pi" || what === "all") && report.pi.beyondTested) {
    // `pi update --self` always goes to the newest pi, so a step past the tested version cannot be capped: leave it to the user.
    notes.push(`pi: ${report.pi.latest} is newer than ${report.pi.tested}, the pi this pi-system release is tested with, so /update leaves pi at ${report.pi.current}. Update pi-system first, or run "pi update --self" yourself.`);
  }
  planStart = Date.now(); // the marker must be rewritten after planning, i.e. by a step that runs later
  return { steps, notes };
}

function isChannelName(channel: string): boolean {
  return /^(latest|next|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/.test(channel);
}

export function planChannelSwitch(report: UpdateReport, channel: string): { steps: Step[]; notes: string[] } {
  const plan = planChannelSwitchSteps(report, channel);
  const last = plan.steps[plan.steps.length - 1];
  // The recorded channel is what /update and the installer follow next time: confirm it moved.
  if (last && !last.verify) {
    last.verify = async () => {
      const after = detectKitInstall(report.cwd);
      return after.channel === channel ? null : `pi-system is on channel ${after.channel ?? "unknown"} after the switch, expected ${channel}`;
    };
  }
  return plan;
}

function planChannelSwitchSteps(report: UpdateReport, channel: string): { steps: Step[]; notes: string[] } {
  if (!isChannelName(channel)) {
    return { steps: [], notes: [`Unknown channel "${channel}". Use latest, next, or an exact version.`] };
  }
  const kit = report.kit;
  const steps: Step[] = [];
  const notes: string[] = [];
  const delivery = kit.migrateTo ?? (kit.kind === "npm" || kit.kind === "git" ? kit.kind : readDistribution(kit.root).delivery ?? "git");
  if (kit.kind === "npm" && delivery === "npm") {
    // `pi install` rewrites the existing entry's source in place and keeps its filters.
    const name = parseNpmSource(kit.source ?? "")?.name ?? readDistribution(kit.root).npmPackage;
    const spec = channel === "latest" ? `npm:${name}` : `npm:${name}@${channel}`;
    steps.push({ label: `switch pi-system to ${channel}`, command: piBinary(), args: ["install", spec, ...(kit.scope === "project" ? ["-l"] : [])], changesKit: kitBefore(kit, true) });
    const step = reconcileStep(kit, report.cwd);
    if (step) steps.push(step);
  } else if (kit.root) {
    // The installer resolves the channel (for git, `latest` is the newest release tag), registers
    // it in place of the current copy, records the channel and applies the profile. Then the
    // profile is re-applied with the newly installed copy's own installer.
    const moving = kit.kind !== delivery || Boolean(kit.migrateSource);
    const label = moving ? `move pi-system from ${kit.kind} to ${delivery} (${channel}), profile ${recordedProfile(report.cwd)}` : `switch pi-system to ${channel}`;
    const step = installerStep(kit.root, label, delivery, channel, !moving, report.cwd);
    if (step) {
      steps.push(step);
      if (!moving) {
        const again = reconcileStep(kit, report.cwd);
        if (again) steps.push(again);
      }
    } else notes.push("Cannot locate the kit installer (packages/core/install.ts). Reinstall the kit, or set PI_KIT_ROOT.");
  } else {
    notes.push("Cannot locate the kit. Reinstall it (see docs/INSTALL.md), or set PI_KIT_ROOT.");
  }
  return { steps, notes };
}

export interface StepOutcome {
  ok: boolean;
  done: string[];
  /** Steps that exited 0 but that nothing could confirm (no check exists, or the check could not run), with why. */
  unverified?: Array<{ label: string; why: string }>;
  /** The step that failed, and why (non-zero exit, or exit 0 without the promised effect). */
  failed?: { label: string; reason: string };
  /** The plan stopped after replacing the kit and before re-applying the profile: the step that replaced it and what it was before. */
  kitChanged?: { label: string; before: string; reapply: string };
}

/** Show `message`: in the UI when there is one, on stderr otherwise (print, JSON and RPC modes have no notify surface). */
function say(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stderr.write(`[update] ${message}\n`);
}

/**
 * Run the plan's commands in order, stopping at the first failure. A step succeeds only when
 * the command exits 0 AND its `verify` (when it has one) confirms the update took effect.
 */
export async function runPlan(pi: ExtensionAPI, cwd: string, steps: Step[], ui?: { setStatus(key: string, text: string | undefined): void }): Promise<StepOutcome> {
  const done: string[] = [];
  const unverified: Array<{ label: string; why: string }> = [];
  let kitChanged: { label: string; before: string } | null = null;
  // Only a profile re-apply still to come makes the stop a mixed state; its command is the way forward.
  const mixed = (index: number): Pick<StepOutcome, "kitChanged"> => {
    const reapply = steps.slice(index).find((s) => s.reapplies);
    if (!kitChanged || !reapply) return {};
    const shown = [reapply.command, ...reapply.args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
    return { kitChanged: { ...kitChanged, reapply: reapply.cwd ? `(cd ${JSON.stringify(reapply.cwd)} && ${shown})` : shown } };
  };
  for (const [index, step] of steps.entries()) {
    ui?.setStatus("kit-update", `${step.label}...`);
    let result: ExecResult;
    try {
      result = await pi.exec(step.command, step.args, { cwd: step.cwd ?? cwd, timeout: 10 * 60_000 });
    } catch (error) {
      result = { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1, killed: false };
    }
    if (result.code !== 0) {
      ui?.setStatus("kit-update", undefined);
      return { ok: false, done, failed: { label: step.label, reason: `exit ${result.code}${result.killed ? " (timed out or killed)" : ""}\n${tail(result)}`.trim() }, ...mixed(index) };
    }
    if (step.verify) {
      let verdict: Verdict;
      try {
        verdict = await step.verify();
      } catch (error) {
        verdict = `could not verify the result: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (typeof verdict === "string" && verdict) {
        ui?.setStatus("kit-update", undefined);
        return { ok: false, done, failed: { label: step.label, reason: `the command exited 0 but the update did not take effect: ${verdict}` }, ...mixed(index) };
      }
      if (verdict && typeof verdict === "object") unverified.push({ label: step.label, why: verdict.unverified });
    } else {
      unverified.push({ label: step.label, why: "the command exited 0; nothing independent confirms it" });
    }
    done.push(step.label);
    if (step.changesKit) kitChanged = { label: step.label, before: step.changesKit };
    if (step.reapplies) kitChanged = null;
  }
  ui?.setStatus("kit-update", undefined);
  return { ok: true, done, ...(unverified.length ? { unverified } : {}) };
}

/** The success message: "verified" only for what was confirmed, and what was not is named. */
export function successMessage(outcome: StepOutcome): string {
  const unverified = new Map((outcome.unverified ?? []).map((u) => [u.label, u.why]));
  if (unverified.size === 0) return `Updated (verified): ${outcome.done.join("; ")}.`;
  const parts = outcome.done.map((label) => (unverified.has(label) ? `${label} (NOT verified: ${unverified.get(label)})` : `${label} (verified)`));
  return `Updated: ${parts.join("; ")}.`;
}

async function runSteps(pi: ExtensionAPI, ctx: ExtensionCommandContext, steps: Step[]): Promise<StepOutcome> {
  const outcome = await runPlan(pi, ctx.cwd, steps, ctx.hasUI ? ctx.ui : undefined);
  if (!outcome.ok && outcome.failed) {
    const next = outcome.kitChanged
      ? `\nNothing after it was run, and /update does not undo "${outcome.kitChanged.label}": the new kit is installed, but the profile was not re-applied, so the settings still hold the previous profile selection. ` +
        `Before the update it was ${outcome.kitChanged.before}. To finish instead, fix the cause and re-apply the profile with: ${outcome.kitChanged.reapply}`
      : "\nNothing after it was run. Fix the cause and run /update again; /update status shows where things stand.";
    say(ctx, `update: "${outcome.failed.label}" failed: ${outcome.failed.reason}${outcome.done.length ? `\nDone before it: ${outcome.done.join("; ")}.` : ""}${next}`, "error");
  }
  return outcome;
}

// --- extension ------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const fetchImpl: FetchLike = (url, init) => fetch(url, init);
  let lastReport: UpdateReport | null = null;

  async function check(cwd: string): Promise<UpdateReport> {
    lastReport = await checkForUpdates(cwd, fetchImpl);
    try {
      writeJsonAtomic(stateFile(), { checkedAt: lastReport.checkedAt, summary: summaryLine(lastReport), available: hasUpdates(lastReport) });
    } catch {
      /* the throttle file is best-effort */
    }
    return lastReport;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || process.env.PI_OFFLINE || isOff(process.env.PI_KIT_UPDATE_CHECK)) return;
    const cwd = ctx.cwd ?? process.cwd();
    if (!shouldCheckNow()) {
      // Keep the reminder visible between checks without another network round trip.
      if (field(readJson(stateFile()), "available")) ctx.ui.setStatus("kit-update", "updates: /update");
      return;
    }
    // Never block or break session start: the check runs in the background.
    void check(cwd)
      .then((report) => {
        if (report.staleRoles?.length) ctx.ui.notify(`pi-system: ${report.staleRoles.length} stale role copies shadow shipped roles (see /update status).`, "warning");
        if (!hasUpdates(report)) return;
        ctx.ui.setStatus("kit-update", "updates: /update");
        ctx.ui.notify(summaryLine(report), "info");
      })
      .catch(() => {});
  });

  pi.registerCommand("update", {
    description:
      "Check for and apply updates to pi, the pi-system kit (on its latest/next channel, from git or npm) and linked packages: `/update`, `/update status`, `/update all|kit|pi|packages`, `/update channel <latest|next|X.Y.Z>`.",
    getArgumentCompletions: (prefix: string) =>
      ["status", "all", "kit", "pi", "packages", "channel latest", "channel next"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v })),
    handler: async (args, c) => {
      const cwd = c.cwd ?? process.cwd();
      let arg = args.trim().toLowerCase();

      if (c.hasUI) c.ui.setStatus("kit-update", "checking for updates...");
      const report = await check(cwd);
      if (c.hasUI) c.ui.setStatus("kit-update", hasUpdates(report) ? "updates: /update" : undefined);

      if (arg === "status" || arg === "check") {
        say(c, formatReport(report), "info");
        return;
      }

      if (!arg) {
        if (!c.hasUI) {
          // No selector without a UI: show where things stand, and how to apply it.
          say(c, `${formatReport(report)}\n\nNon-interactive session: run \`/update all|kit|pi|packages\` explicitly to apply.`, "info");
          return;
        }
        const options: Array<{ label: string; value: string }> = [];
        const pkgCount = report.packages.filter((p) => p.action === "reconcile" || p.action === "update").length;
        if (hasUpdates(report)) options.push({ label: "Update everything", value: "all" });
        if (report.kit.migrateTo) options.push({ label: `Move pi-system to ${report.kit.migrateTo} delivery`, value: "kit" });
        else if (report.kit.available && report.kit.kind !== "local") options.push({ label: `pi-system ${report.kit.version} → ${report.kit.target}`, value: "kit" });
        if (report.kit.kind === "local") options.push({ label: `Pull the local pi-system checkout (git, fast-forward only)${report.kit.available ? ` → ${report.kit.target}` : ""}`, value: "kit" });
        if (report.pi.available) options.push({ label: `pi ${report.pi.current} → ${report.pi.latest}`, value: "pi" });
        if (pkgCount) options.push({ label: `${pkgCount} linked package${pkgCount === 1 ? "" : "s"}`, value: "packages" });
        const other = (report.kit.kind === "npm" || report.kit.kind === "git") && report.kit.channel === "next" ? "latest" : "next";
        options.push({ label: `Switch pi-system channel to ${other}${other === "next" ? " (tracks main)" : " (releases)"}`, value: `channel ${other}` });
        options.push({ label: "Show details", value: "status" });
        const choice = await c.ui.select(summaryLine(report), options.map((o) => o.label));
        if (choice === undefined) return;
        arg = options.find((o) => o.label === choice)?.value ?? "status";
        if (arg === "status") {
          c.ui.notify(formatReport(report), "info");
          return;
        }
      }

      let plan: { steps: Step[]; notes: string[] };
      if (arg.startsWith("channel")) {
        const channel = arg.slice("channel".length).trim();
        if (!channel) {
          say(c, "update: usage: /update channel <latest|next|X.Y.Z>", "error");
          return;
        }
        plan = planChannelSwitch(report, channel);
      } else if (["all", "kit", "pi", "packages"].includes(arg)) {
        plan = planUpdate(report, arg as "all" | "kit" | "pi" | "packages", pi);
      } else {
        say(c, `update: unknown option "${arg}". Use status, all, kit, pi, packages or channel <name>.`, "error");
        return;
      }

      if (plan.steps.length === 0) {
        say(c, [...plan.notes, "Nothing to update."].join("\n"), "info");
        return;
      }
      if (c.hasUI) {
        const ok = await c.ui.confirm("Apply updates?", [...plan.steps.map((s) => `• ${s.label}`), ...plan.notes.map((n) => `Note: ${n}`)].join("\n"));
        if (!ok) return;
      }

      const outcome = await runSteps(pi, c, plan.steps);
      if (!outcome.ok) return;
      const piUpdated = plan.steps.some((s) => s.args.includes("--self"));
      const reloadNeeded = plan.steps.some((s) => !s.args.includes("--self"));
      try {
        fs.rmSync(stateFile(), { force: true }); // re-check on next start
      } catch {
        /* best-effort */
      }
      say(c, [successMessage(outcome), ...plan.notes, piUpdated ? "Restart pi to run the new pi version." : "", reloadNeeded ? "Reloading..." : ""].filter(Boolean).join("\n"), "info");
      if (reloadNeeded) {
        await c.waitForIdle?.();
        await c.reload();
      }
    },
  });
}
