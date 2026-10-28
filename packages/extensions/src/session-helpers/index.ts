import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentDir,
  computeCompactionState,
  describeCompaction,
  formatK,
  markWarned,
  publishCompaction,
  warnOnce,
  type CompactionState,
} from "./compaction-state.ts";
import { transactionalSwitch, type SwitchOutcome } from "./profile-switch.ts";
import { confirmLowering, securityFilePath, securityLowering } from "./security-guard.ts";
import { KIT_PACKAGE_NAMES, isKitLocalPackageName, trustedMarkerKitRoot, type MarkerKitRoot } from "./shared/kit-source.ts";
import { nodeRuntime } from "./shared/node-runtime.ts";

// Self-containment rule: import only node:* builtins and typebox peer.
// No sibling imports. No toolchain-lib imports. See CONTRIBUTING.md.
//
// session-helpers adds manual, non-autonomous convenience commands on top of the
// kit's autonomous behaviour. The slash commands are explicit user actions. The one
// hook here is a session_start preflight that warns — once, cleanly — when the
// pi-lean-ctx extension is loaded but its external `lean-ctx` CLI is missing, which
// would otherwise surface only as an opaque `spawn ENOENT` (plan Sprint 1.1).

const CLEAR_GUIDE = [
  "pi has no /clear command, so nothing was cleared. Pick the reset you actually want:",
  "",
  "  /compact   Summarise and shrink the current context. Keeps the session, goal and thread.",
  "             This is the usual 'clear' for a long session that has grown heavy.",
  "  /compress  Instant /compact with no model call: keeps asks and replies, drops tool output.",
  "  /save      Write a snapshot of the session to disk or a vault project. Does not compact.",
  "  /new       Start a fresh session. Drops the current context entirely.",
  "             Run /handoff first if you want a clean way to resume the thread later.",
  "  /fork      Branch from an earlier message to try a different path (original is kept).",
  "",
  "Compaction is also automatic (pi's own auto-compaction; see /compaction to view or change it),",
  "so you rarely need to do it by hand.",
].join("\n");


type Level = "info" | "warning" | "error";

// Operator-facing output. ctx.ui.notify is the kit's standard fire-and-forget path (see
// custom-footer), but it is a no-op in print/JSON runs, where a command used to print nothing at
// all. Without a UI the message goes to stderr (stdout stays reserved for the run's own output);
// notify is still called best-effort so a UI-less host that does implement it keeps working.
function report(ctx: ExtensionContext, content: string, level: Level = "info"): void {
  let hasUI: boolean;
  try {
    hasUI = ctx.hasUI;
  } catch {
    return; // pi throws on any use of a ctx that a reload replaced: nothing left to tell
  }
  if (hasUI) {
    try {
      ctx.ui.notify(content, level);
    } catch {
      /* stale ctx after a reload: nothing left to tell */
    }
    return;
  }
  try {
    process.stderr.write(`[pi-kit] ${content}\n`);
  } catch {
    /* no stderr */
  }
  try {
    ctx.ui?.notify?.(content, level);
  } catch {
    /* no-op UI */
  }
}

function show(ctx: ExtensionContext, content: string): void {
  report(ctx, content, "info");
}

// --- profile switching -------------------------------------------------------
// `/profile` is a TUI front-end for the same operation the CLI installer performs:
// reinstall the registered kit package with a different profile (`node
// packages/core/install.ts --profile <name> --yes`), then reload so pi re-reads
// settings.json. The install logic stays single-sourced in the installer; this
// command only locates the kit checkout, picks a profile, and drives it.

// Kit layouts we can drive. The monorepo is the source of truth
// (<root>/packages/core/install.ts + <root>/packages/kit/profiles); a legacy flat
// kit checkout keeps the installer at <root>/kit/install.mjs with profiles beside
// it. The published npm package keeps the monorepo layout. Anything else makes /profile
// degrade to a clear "set PI_KIT_ROOT" message rather than guessing.
export interface KitLayout {
  root: string;
  installer: string;
  profilesDir: string;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
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

/** Resolve the installer + profiles for a kit root, or null if `root` is not a kit. */
export function resolveKitLayout(root: string): KitLayout | null {
  const monorepoInstaller = kitInstaller(root);
  const monorepoProfiles = path.join(root, "packages", "kit", "profiles");
  if (monorepoInstaller && isFile(monorepoInstaller) && isDir(monorepoProfiles)) {
    return { root, installer: monorepoInstaller, profilesDir: monorepoProfiles };
  }
  const legacyInstaller = path.join(root, "kit", "install.mjs");
  const legacyProfiles = path.join(root, "profiles");
  if (isFile(legacyInstaller) && isDir(legacyProfiles)) {
    return { root, installer: legacyInstaller, profilesDir: legacyProfiles };
  }
  return null;
}

interface Marker {
  kitSource?: string;
  profile?: string;
  scope?: string;
  mode?: string;
  ref?: string | null;
  channel?: string | null;
  companions?: unknown;
  extensions?: unknown;
  installedAt?: string;
}

function toMarker(raw: Record<string, unknown>): Marker {
  const marker: Marker = {};
  for (const key of ["kitSource", "profile", "scope", "mode", "installedAt"] as const) {
    const v = raw[key];
    if (typeof v === "string") marker[key] = v;
  }
  for (const key of ["ref", "channel"] as const) {
    const v = raw[key];
    if (typeof v === "string" || v === null) marker[key] = v;
  }
  if (raw.companions !== undefined) marker.companions = raw.companions;
  if (raw.extensions !== undefined) marker.extensions = raw.extensions;
  return marker;
}

function readMarker(cwd: string = process.cwd()): Marker {
  // Match uninstall.ts: a project marker in the cwd wins, otherwise the global marker.
  const projectMarker = path.join(cwd, ".pi", ".pi-kit.json");
  const file = fs.existsSync(projectMarker) ? projectMarker : path.join(agentDir(), ".pi-kit.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    // Written by the kit's installer, but still a file: a field of the wrong type is left out.
    return isRecord(parsed) ? toMarker(parsed) : {};
  } catch {
    return {};
  }
}

// The kit this module was loaded from: a checkout, git clone or npm install of the kit all keep
// the monorepo layout, with this module at <kit>/packages/extensions/src/<name>/ (four levels up);
// a legacy flat kit has it at <kit>/extensions/<name>/ (two levels up).
function installedKitRoot(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const installed of [path.resolve(here, "..", "..", "..", ".."), path.resolve(here, "..", "..")]) {
      if (resolveKitLayout(installed)) return installed;
    }
  } catch {
    /* import.meta.url unavailable (non-ESM loader) - fall through */
  }
  return null;
}

// A marker's kitSource names a kit checkout only when it is absolute, resolves (through links)
// outside the workspace, has a kit layout, and its package.json carries a kit package name
// (trustedMarkerKitRoot, ./shared/kit-source.ts). A project marker is repository content, so a
// relative or in-workspace path would let an opened repository choose the installer /profile
// runs. npm and git sources are not paths and are ignored silently.
function markerKitRoot(kitSource: string, cwd: string): MarkerKitRoot {
  return trustedMarkerKitRoot(kitSource, cwd, (dir) => resolveKitLayout(dir) !== null);
}

const kitRootWarnings = new Set<string>();

// Resolve the kit root. PI_KIT_ROOT wins (also what tests set), then the install marker's
// kitSource when markerKitRoot accepts it, then the package this module was loaded from.
// Returns null rather than guessing. A kitSource that names a code location but is refused is
// reported once through `warn`, and the installed package is used instead.
export function findKitRoot(cwd: string = process.cwd(), warn?: (message: string) => void): string | null {
  const override = process.env.PI_KIT_ROOT?.trim();
  if (override) return resolveKitLayout(override) ? override : null;
  const installed = installedKitRoot();
  const marker = readMarker(cwd);
  const fromMarker = marker.kitSource ? markerKitRoot(marker.kitSource, cwd) : null;
  if (fromMarker && "root" in fromMarker) return fromMarker.root;
  if (fromMarker && warn && !(installed && sameDir(installed, path.resolve(cwd, marker.kitSource ?? "")))) {
    const message = `pi-system: ignored ${fromMarker.ignored}; using the installed kit${installed ? ` at ${installed}` : ""}. An install marker never chooses the installer that runs.`;
    if (!kitRootWarnings.has(message)) {
      kitRootWarnings.add(message);
      warn(message);
    }
  }
  return installed;
}

interface ProfileInfo {
  name: string;
  description: string;
}

export function listProfiles(kitRoot: string): ProfileInfo[] {
  const dir = resolveKitLayout(kitRoot)?.profilesDir ?? path.join(kitRoot, "profiles");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const name = f.replace(/\.json$/, "");
      let description = "";
      try {
        const value = prop(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), "description") ?? "";
        description = typeof value === "string" ? value.trim() : "";
      } catch {
        /* a malformed profile is still selectable; the installer will reject it */
      }
      return { name, description };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- actual loaded set vs profiles ------------------------------------------

/** A value decoded from JSON at a file boundary, before any shape is asserted. */
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Everything JSON.parse can return passes; the check makes that a proof rather than a cast.
function isJsonValue(v: unknown): v is JsonValue {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.every(isJsonValue);
  return isRecord(v) && Object.values(v).every(isJsonValue);
}

// `v?.[key]` for parsed JSON: undefined unless v is a plain object.
function prop(v: unknown, key: string): JsonValue {
  return isRecord(v) && isJsonValue(v[key]) ? v[key] : undefined;
}

// A parsed JSON value as message text: what `${v}` printed for a scalar, JSON for anything else.
function shown(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null || v === undefined ? String(v) : JSON.stringify(v);
}

function readJsonFile(file: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export const KIT_PACKAGE = "@satunix/pi-system";


// True for either scoped kit identity on any channel or version.
export function isKitNpmSource(source: string): boolean {
  if (!source.startsWith("npm:")) return false;
  const body = source.slice(4);
  return [...KIT_PACKAGE_NAMES].some((name) => body === name || body.startsWith(`${name}@`));
}

// A repository key for the URL forms /profile recognises, ignoring any ref.
function gitSourceKey(source: string): string | null {
  const url = source.startsWith("git:") && !source.startsWith("git://") ? source.slice(4) : /^(https?|ssh|git):\/\//i.test(source) ? source : null;
  if (!url) return null;
  const match = url.trim().match(/^(?:[a-z]+:\/\/(?:[^@/]+@)?|git@)?([^/:]+)(?::\d+)?[/:](.+)$/i);
  if (!match) return null;
  const [, host = "", rest = ""] = match;
  const repo = rest.split("@")[0]?.replace(/\.git$/, "").replace(/\/+$/, "");
  return repo ? `${host}/${repo}`.toLowerCase() : null;
}

export function isKitGitSource(source: string, previousSources: readonly string[] = []): boolean {
  const url = source.startsWith("git:") ? source.slice(4) : /^(https?|ssh|git):\/\//i.test(source) ? source : null;
  // Preserve every legacy match, including its ref restrictions.
  if (url && /[/:]pi-system(\.git)?(@[^/:]*)?$/i.test(url.trim())) return true;
  const key = gitSourceKey(source);
  return key !== null && (key === "github.com/satunix/luna" || previousSources.some((previous) => gitSourceKey(previous) === key));
}

function previousKitSources(kitRoot: string): string[] {
  const config = readJsonFile(path.join(kitRoot, "packages", "core", "distribution.json"));
  const value = prop(prop(config, "git"), "previousSources");
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((source: unknown) => typeof source !== "string" || !gitSourceKey(source))) {
    throw new Error("distribution.git.previousSources must be an array of git sources");
  }
  return value.filter((source): source is string => typeof source === "string");
}

// The kit's own package entry: a local path equal to kitRoot, or the npm or git package when
// kitRoot is pi's installed copy of it (<agent dir>/npm/node_modules/..., <agent dir>/git/...).
function isKitEntrySource(source: string, base: string, kitRoot: string): boolean {
  if (isKitNpmSource(source) || isKitGitSource(source, previousKitSources(kitRoot))) {
    // Mirror kit-update's isKitRoot: accept the legacy "pi-system" package name and require
    // the monorepo installer, so /profile agrees with /update for legacy-named checkouts.
    const name = prop(readJsonFile(path.join(kitRoot, "package.json")), "name");
    return isKitLocalPackageName(name) && kitInstaller(kitRoot) !== null;
  }
  if (source.startsWith("npm:") || source.startsWith("git:")) return false;
  return sameDir(path.resolve(base, source), kitRoot);
}

// The `packages` array of a parsed settings file ([] when absent or malformed).
function kitPackages(settings: unknown): unknown[] {
  const packages = prop(settings, "packages");
  return Array.isArray(packages) ? packages : [];
}

// A package entry's source: the string itself, or the `source` of an object entry.
function packageSource(pkg: unknown): JsonValue {
  return typeof pkg === "string" ? pkg : prop(pkg, "source");
}

// Names of kit extensions in the kit's settings entry (null when the entry is missing or
// unfiltered, i.e. pi loads the whole package).
export function loadedKitExtensions(settingsFile: string, kitRoot: string): string[] | null {
  const settings = readJsonFile(settingsFile);
  const base = path.dirname(settingsFile);
  for (const pkg of kitPackages(settings)) {
    const source = packageSource(pkg);
    if (typeof source !== "string" || !isKitEntrySource(source, base, kitRoot)) continue;
    const extensions = prop(pkg, "extensions");
    if (typeof pkg === "string" || !Array.isArray(extensions)) return null;
    return extensions
      .map((e: unknown) => (typeof e === "string" ? e.match(/(?:src|third_party)\/([^/]+)\/index\.ts$/)?.[1] : undefined))
      .filter((n): n is string => Boolean(n));
  }
  return null;
}

// Whether a settings file has a kit package entry at all, filtered or not. `loadedKitExtensions`
// treats an unfiltered entry as "the whole package" and returns null, so it cannot tell an absent
// entry from an unfiltered one; scope detection needs the latter (the project settings entry is
// authoritative even without a project marker).
function projectKitEntry(settingsFile: string, kitRoot: string): boolean {
  const settings = readJsonFile(settingsFile);
  const base = path.dirname(settingsFile);
  for (const pkg of kitPackages(settings)) {
    const source = packageSource(pkg);
    if (typeof source === "string" && isKitEntrySource(source, base, kitRoot)) return true;
  }
  return false;
}

function isKitExtension(kitRoot: string, name: string): boolean {
  return ["src", "third_party"].some((avenue) => isFile(path.join(kitRoot, "packages", "extensions", avenue, name, "index.ts")));
}

function readOverrides(): { add: string[]; remove: string[] } {
  const raw = readJsonFile(path.join(agentDir(), "pi-kit", "overrides.json"));
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const extensions = prop(raw, "extensions");
  return { add: list(prop(extensions, "add")), remove: list(prop(extensions, "remove")) };
}

export function hasOverridesFile(): boolean {
  return fs.existsSync(path.join(agentDir(), "pi-kit", "overrides.json"));
}

// The in-package extensions a profile would load once overrides are applied.
export function profileKitExtensions(kitRoot: string, profile: string): string[] {
  const layout = resolveKitLayout(kitRoot);
  const def = layout ? readJsonFile(path.join(layout.profilesDir, `${profile}.json`)) : null;
  const o = readOverrides();
  const rawInclude = prop(def, "include");
  const include: string[] = Array.isArray(rawInclude) ? rawInclude.filter((n): n is string => typeof n === "string") : [];
  const out = include.filter((n) => !o.remove.includes(n));
  for (const n of o.add) if (!out.includes(n)) out.push(n);
  return out.filter((n) => isKitExtension(kitRoot, n));
}

export function diffSets(from: string[], to: string[]): { add: string[]; remove: string[] } {
  return { add: to.filter((n) => !from.includes(n)), remove: from.filter((n) => !to.includes(n)) };
}

// Which profile the loaded set matches: exact, or the closest by symmetric difference. Profiles can
// have identical extension sets (long-horizon and autonomous do): `prefer` (the marker's profile) wins
// such a tie, otherwise the alphabetically first twin would be reported for both.
export function matchProfile(kitRoot: string, loaded: string[], profiles: string[], prefer?: string): { exact?: string; closest?: string | undefined; distance: number } {
  let best: { name?: string; distance: number } = { distance: Number.POSITIVE_INFINITY };
  const ordered = prefer && profiles.includes(prefer) ? [prefer, ...profiles.filter((p) => p !== prefer)] : profiles;
  for (const name of ordered) {
    const d = diffSets(loaded, profileKitExtensions(kitRoot, name));
    const distance = d.add.length + d.remove.length;
    if (distance === 0) return { exact: name, closest: name, distance: 0 };
    if (distance < best.distance) best = { name, distance };
  }
  return { closest: best.name, distance: best.distance };
}

// The installer is a Node script. Under a compiled `pi` binary process.execPath is pi itself,
// and `pi install.ts ...` would read the script path as a prompt, so the runtime comes from
// ./shared/node-runtime.ts. With none found, bare `node` keeps the old behaviour: pi.exec
// reports that it cannot be run.
function nodeBinary(): string {
  const runtime = nodeRuntime();
  return runtime.ok ? runtime.command : "node";
}

// --- compaction status/toggle -------------------------------------------------
// pi's own auto-compaction is `compaction.enabled` (global settings, overridden by the
// project's .pi/settings.json). The kit's trigger-compact adds a fixed-budget trigger that
// obeys the same switch plus its own on/off (<agent dir>/pi-kit/trigger-compact.json). The
// effective state is computed in ./compaction-state.ts with pi's own precedence and thresholds;
// this wrapper feeds it what only the live session knows (model window, trust, trigger loaded).

/** The live session's view of compaction, published for other extensions after every change. */
export function currentCompactionState(pi: ExtensionAPI, ctx: ExtensionContext): CompactionState {
  let contextWindow: number | null | undefined;
  try {
    // A model with no window is reported as 0 (unknown), no model at all as undefined.
    const model: unknown = ctx.model;
    contextWindow = model ? Number((isRecord(model) ? model.contextWindow : undefined) ?? 0) : undefined;
  } catch {
    contextWindow = undefined;
  }
  let projectTrusted: boolean | undefined;
  try {
    projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : undefined;
  } catch {
    projectTrusted = undefined;
  }
  let kitTriggerLoaded: boolean;
  try {
    kitTriggerLoaded = pi.getCommands().some((cmd) => cmd.name === "compact-threshold");
  } catch {
    kitTriggerLoaded = false;
  }
  return computeCompactionState({ cwd: ctx.cwd ?? process.cwd(), projectTrusted, contextWindow, kitTriggerLoaded });
}

// Recompute, publish `globalThis[Symbol.for("pi-kit.compaction")]`, and warn once per session.
function refreshCompaction(pi: ExtensionAPI, ctx: ExtensionContext, opts: { warn?: boolean } = {}): CompactionState | null {
  try {
    const state = currentCompactionState(pi, ctx);
    publishCompaction(state);
    if (opts.warn !== false) warnOnce(ctx, state);
    return state;
  } catch {
    publishCompaction(null);
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// Set pi's global compaction.enabled, preserving every other setting. Refuses to touch a
// settings file that does not parse (writing {} back would erase the operator's config).
export function setGlobalCompactionEnabled(enabled: boolean): void {
  const file = path.join(agentDir(), "settings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = readJsonFile(file);
    if (!isRecord(parsed)) throw new Error(`${file} is not valid JSON; not changed`);
    settings = parsed;
  }
  const previous = settings.compaction ?? {};
  settings.compaction = { ...(typeof previous === "object" && previous !== null ? previous : {}), enabled };
  writeJsonAtomic(file, settings);
}

export function setKitTriggerEnabled(enabled: boolean): void {
  const file = path.join(agentDir(), "pi-kit", "trigger-compact.json");
  const raw = readJsonFile(file) ?? {};
  const current = isRecord(raw) ? raw : {};
  if (enabled) delete current.enabled;
  else current.enabled = false;
  if (Object.keys(current).length === 0) fs.rmSync(file, { force: true });
  else writeJsonAtomic(file, current);
}

export { computeCompactionState, describeCompaction, publishCompaction, COMPACTION_GLOBAL_KEY } from "./compaction-state.ts";
export type { CompactionState, PublishedCompaction } from "./compaction-state.ts";

// --- pi-lean-ctx binary preflight -------------------------------------------
// pi-lean-ctx routes bash/read/grep output through an external `lean-ctx` CLI that
// is NOT bundled and NOT on npm (see packages/core/sources.json). When it is loaded
// but the binary is absent, its MCP bridge fails with `spawn ENOENT`. We detect that
// here and warn once instead. Uses node builtins only (self-containment rule).

function isExpectedLeanCtx(): boolean {
  const override = process.env.PI_KIT_LEAN_CTX?.trim();
  if (override === "0" || override === "off" || override === "false") return false;
  if (override === "1" || override === "on" || override === "true") return true;
  // Auto-detect: is the pi-lean-ctx extension actually installed anywhere obvious?
  const candidates = [
    path.join(os.homedir(), ".pi", "agent", "extensions", "pi-lean-ctx"),
    path.join(os.homedir(), ".pi", "agent", "node_modules", "pi-lean-ctx"),
    path.join(process.cwd(), "node_modules", "pi-lean-ctx"),
  ];
  return candidates.some((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
}

function leanCtxBinaryPresent(): boolean {
  const configured = process.env.PI_LEAN_CTX_BIN?.trim() || process.env.LEAN_CTX_BIN?.trim();
  if (configured) {
    try {
      return fs.existsSync(configured);
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH || process.env.Path || "";
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, `lean-ctx${ext}`))) return true;
      } catch {
        /* ignore unreadable PATH entries */
      }
    }
  }
  return false;
}

// A bare `pi install git:<host>/<owner>/pi-system@<tag>` (or `npm:@satunix/pi-system`)
// registers the package unfiltered, so pi loads every extension in it, experimental ones
// included. The first session after that applies the default profile (settings only) and asks
// for a reload; `/profile` picks another. PI_KIT_AUTO_PROFILE=0 turns this off,
// PI_KIT_AUTO_PROFILE=<name> picks the profile.
export function unfilteredKitEntry(settingsFile: string): boolean {
  const root = findKitRoot();
  const previousSources = root ? previousKitSources(root) : [];
  const settings = readJsonFile(settingsFile);
  for (const pkg of kitPackages(settings)) {
    const source = packageSource(pkg);
    if (typeof source !== "string" || !(isKitNpmSource(source) || isKitGitSource(source, previousSources))) continue;
    return typeof pkg === "string" || !Array.isArray(prop(pkg, "extensions"));
  }
  return false;
}

/** @deprecated use unfilteredKitEntry (also matches git installs). */
export const unfilteredNpmKitEntry = unfilteredKitEntry;

// --- transactional switch orchestration ---------------------------------------
// The mechanics (snapshot, verify, rollback) live in ./profile-switch.ts; this part decides which
// files a switch can touch and what the requested profile expects, then drives the installer.

// Extensions whose absence widens what the agent may do; /profile status flags them. Extensions may
// not import core, so this is a copy: tests/profile-safety-smoke.ts pins it to the protections in
// distribution.json requiredProfileExtensions.
export const MANDATORY_PROTECTION: readonly string[] = ["tool-firewall", "protected-paths"];
const NOTABLE_EXTENSIONS = [
  "tool-firewall", "protected-paths", "verify-gate", "verifier-board", "trigger-compact", "custom-compaction", "context-sieve",
  "finish-reason-retry", "autonomous-loop", "autonomy-run", "conductor", "subagent", "delegation-guard", "effort", "memory-vault", "goal-core",
];

export function firewallConfigFile(): string {
  return process.env.PI_KIT_FIREWALL_CONFIG?.trim() || path.join(agentDir(), "pi-kit", "firewall.json");
}

/**
 * The firewall a profile demands, or null when the profile names a policy or mode this kit does
 * not know. Mirrors firewallConfigFor() in packages/core/lib/profiles.ts; an unknown value must
 * stop the switch rather than quietly become the default.
 */
export function firewallExpectation(def: unknown): { policy: "coding" | "pentest"; mode: "auto" | "manual" } | null {
  const fw = prop(def, "firewall");
  if (fw === undefined || fw === null) return { policy: "coding", mode: "manual" };
  if (!isRecord(fw)) return null;
  const { policy, mode } = fw;
  if (policy !== undefined && policy !== "coding" && policy !== "pentest") return null;
  if (mode !== undefined && mode !== "auto" && mode !== "manual") return null;
  return { policy: policy === "pentest" ? "pentest" : "coding", mode: mode === "auto" ? "auto" : "manual" };
}

/** Every file a switch can change, for both scopes (a global switch must not disturb the project, and vice versa). */
export function switchFiles(projectCwd: string): string[] {
  return [
    path.join(agentDir(), "settings.json"),
    path.join(agentDir(), ".pi-kit.json"),
    path.join(projectCwd, ".pi", "settings.json"),
    path.join(projectCwd, ".pi", ".pi-kit.json"),
    firewallConfigFile(),
    process.env.PI_KIT_SECURITY_CONFIG?.trim() || path.join(agentDir(), "pi-kit", "security.json"),
    path.join(agentDir(), "pi-kit", "overrides.json"),
    path.join(agentDir(), ".env"),
  ];
}

interface SwitchRequest {
  kitRoot: string;
  layout: KitLayout;
  target: string;
  installArgs: string[];
  projectScoped: boolean;
  projectCwd: string;
  /** false: apply and ask the operator to /reload (first-run auto-profile). */
  reload: boolean;
  announce: (warnings: string[]) => void;
}

async function runSwitch(pi: ExtensionAPI, c: ExtensionContext, req: SwitchRequest): Promise<SwitchOutcome> {
  const def = readJsonFile(path.join(req.layout.profilesDir, `${req.target}.json`));
  const fw = firewallExpectation(def);
  const rawSecurityLevel = prop(def, "securityLevel");
  const securityLevel = rawSecurityLevel === undefined ? (req.target === "pentest" ? "guarded" : "balanced") : rawSecurityLevel;
  if (!fw || typeof securityLevel !== "string" || !["relaxed", "balanced", "guarded", "strict"].includes(securityLevel)) {
    return {
      ok: false,
      stage: "install",
      message: !fw
        ? `profile: refusing to switch to "${req.target}": its firewall block names an unknown policy or mode (${JSON.stringify(prop(def, "firewall"))}). Known policies: coding, pentest; modes: auto, manual. Nothing was changed.`
        : `profile: refusing to switch to "${req.target}": unknown or unavailable securityLevel ${JSON.stringify(securityLevel)}. Nothing was changed.`,
      warnings: [],
      rolledBack: false,
      rollbackErrors: [],
      backupDir: null,
    };
  }
  const command = c as ExtensionCommandContext;
  return transactionalSwitch({
    exec: (cmd, args, options) => pi.exec(cmd, args, options),
    command: nodeBinary(),
    // --no-migrate: the rollback below restores files only, so the switch never moves the kit's source.
    args: [...req.installArgs, "--no-migrate"],
    cwd: req.projectScoped ? req.projectCwd : req.layout.root,
    timeoutMs: 120_000,
    files: switchFiles(req.projectCwd),
    expectation: {
      profile: req.target,
      scope: req.projectScoped ? "project" : "global",
      kitRoot: req.kitRoot,
      markerFile: req.projectScoped ? path.join(req.projectCwd, ".pi", ".pi-kit.json") : path.join(agentDir(), ".pi-kit.json"),
      settingsFile: req.projectScoped ? path.join(req.projectCwd, ".pi", "settings.json") : path.join(agentDir(), "settings.json"),
      firewallFile: firewallConfigFile(),
      security: { file: securityFilePath(agentDir()), level: securityLevel },
      extensions: () => profileKitExtensions(req.kitRoot, req.target),
      firewall: fw,
      loadedExtensions: (file) => loadedKitExtensions(file, req.kitRoot),
      extensionExists: (name) => isKitExtension(req.kitRoot, name),
    },
    announce: req.announce,
    reload: req.reload
      ? async () => {
          await command.waitForIdle?.();
          await command.reload();
        }
      : undefined,
    reloadOld: req.reload
      ? async () => {
          await command.reload();
        }
      : undefined,
  });
}

// --- /profile status: the effective configuration in a screenful ----------------

function companionLabel(source: string): string {
  return source.replace(/^npm:/, "").replace(/^git:/, "");
}

function registeredSources(settingsFile: string): Set<string> {
  const out = new Set<string>();
  const settings = readJsonFile(settingsFile);
  for (const pkg of kitPackages(settings)) {
    const source = packageSource(pkg);
    if (typeof source === "string") out.add(source);
  }
  return out;
}

function overridesSummary(): string {
  const file = path.join(agentDir(), "pi-kit", "overrides.json");
  if (!fs.existsSync(file)) return "none";
  const raw = readJsonFile(file);
  if (!raw || typeof raw !== "object") return `UNREADABLE (${file} is not valid JSON; the installer will refuse to switch until it is fixed)`;
  const n = (section: string, key: string) => {
    const v = prop(prop(raw, section), key);
    return Array.isArray(v) ? v.length : 0;
  };
  const parts = [
    `extensions +${n("extensions", "add")}/-${n("extensions", "remove")}`,
    `skills -${n("skills", "exclude")}/+${n("skills", "include")}`,
    `prompts -${n("prompts", "exclude")}/+${n("prompts", "include")}`,
  ];
  return `${parts.join(", ")} (${file})`;
}

export interface StatusInput {
  kitRoot: string;
  settingsFile: string;
  loaded: string[] | null;
  currentLabel: string;
  marker: ReturnType<typeof readMarker>;
  compaction: CompactionState | null;
}

export function effectiveConfigLines(input: StatusInput): string[] {
  const { marker, loaded, compaction } = input;
  const lines: string[] = [];
  const recorded = marker.profile && input.currentLabel !== marker.profile ? ` (install marker says "${marker.profile}")` : "";
  lines.push(`Profile: ${input.currentLabel}${recorded}`);
  lines.push(
    `Install: ${marker.mode ?? "unknown"}${marker.channel ? ` · channel ${marker.channel}` : ""}${marker.ref ? ` · ref ${marker.ref}` : ""} · scope ${marker.scope ?? "global"} · source ${marker.kitSource ?? "unknown"}${marker.installedAt ? ` · installed ${marker.installedAt}` : ""}`,
  );
  if (loaded === null) {
    lines.push("Extensions: not filtered - every kit extension loads (experimental ones included). Run /profile <name> to apply a profile.");
  } else {
    const notable = NOTABLE_EXTENSIONS.filter((n) => loaded.includes(n));
    lines.push(`Extensions: ${loaded.length} loaded${notable.length ? ` - notable: ${notable.join(", ")}` : ""}`);
    for (const name of MANDATORY_PROTECTION) {
      if (!loaded.includes(name)) lines.push(`  WARNING: ${name} is NOT loaded - its protection is off for this session`);
    }
  }
  const fw = readJsonFile(firewallConfigFile());
  if (!fw || typeof fw !== "object") lines.push(`Firewall: no config at ${firewallConfigFile()} (tool-firewall uses its built-in defaults)`);
  else {
    const policy = prop(fw, "policy");
    const mode = prop(fw, "mode");
    const source = prop(fw, "source");
    const known = (policy === "coding" || policy === "pentest") && (mode === "auto" || mode === "manual");
    lines.push(`Firewall: policy ${shown(policy ?? "?")} · mode ${shown(mode ?? "?")}${source ? ` (${source === "user" ? "set with /auto" : "from the profile"})` : ""}${known ? "" : "  WARNING: unknown policy or mode - the firewall treats this as invalid, run /profile <name> to rewrite it"}`);
  }
  if (compaction) {
    const src = compaction.source === "default" ? "default" : `${compaction.source} settings`;
    const trigger = !compaction.kitTrigger.loaded ? "no kit trigger" : compaction.kitTrigger.effective ? `kit trigger at ${formatK(compaction.kitTrigger.thresholdTokens)}` : compaction.kitTrigger.enabled ? "kit trigger idle" : "kit trigger off";
    lines.push(`Compaction: pi auto ${compaction.enabled ? "ON" : "OFF"} (${src}) · earliest trigger ${compaction.enabled ? formatK(compaction.thresholdTokens) : "none"} · ${trigger}`);
    if (compaction.reason) lines.push(`  WARNING: ${compaction.reason}`);
  } else {
    lines.push("Compaction: state unavailable");
  }
  lines.push(`Overrides: ${overridesSummary()}`);
  const companions: string[] = Array.isArray(marker.companions) ? marker.companions.filter((x: unknown): x is string => typeof x === "string") : [];
  if (companions.length === 0) lines.push("Companions: none recorded");
  else {
    const registered = registeredSources(input.settingsFile);
    lines.push(`Companions: ${companions.map((s) => `${companionLabel(s)}${registered.has(s) ? "" : " (not registered)"}`).join(", ")}`);
  }
  return lines;
}

async function applyDefaultProfile(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  // Interactive sessions only: print/JSON runs and tests must never rewrite settings.
  if (!ctx.hasUI) return;
  const setting = process.env.PI_KIT_AUTO_PROFILE?.trim();
  if (["0", "off", "false", "no"].includes((setting ?? "").toLowerCase())) return;
  const cwd = ctx.cwd ?? process.cwd();
  const scope = unfilteredKitEntry(path.join(cwd, ".pi", "settings.json")) ? "project" : "global";
  if (scope === "global" && !unfilteredKitEntry(path.join(agentDir(), "settings.json"))) return;
  const kitRoot = findKitRoot(cwd, (message) => ctx.ui.notify(message, "warning"));
  const layout = kitRoot ? resolveKitLayout(kitRoot) : null;
  if (!kitRoot || !layout) return;
  const profile = setting && listProfiles(kitRoot).some((p) => p.name === setting) ? setting : "balanced";
  const outcome = await runSwitch(pi, ctx, {
    kitRoot,
    layout,
    target: profile,
    installArgs: [layout.installer, "--profile", profile, "--yes", "--settings-only", "--scope", scope],
    projectScoped: scope === "project",
    projectCwd: cwd,
    reload: false,
    announce: () => {},
  });
  if (outcome.ok) {
    ctx.ui.notify(`pi-system: applied the "${profile}" profile (the package was loading every extension). Run /reload to load it, or /profile to choose another.${outcome.warnings.length ? `\n${outcome.warnings.join("\n")}` : ""}`, "info");
  } else {
    ctx.ui.notify(`pi-system: every extension is loaded because no profile is applied, and applying "${profile}" failed. Run /profile.\n${outcome.message.slice(-800)}`, "warning");
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    // First and independent of everything below: publish the effective compaction state for the
    // footer and warn once if compaction is off or cannot work. Must never break session start.
    refreshCompaction(pi, ctx);
    try {
      await applyDefaultProfile(pi, ctx);
    } catch {
      // Never break session start.
    }
    try {
      if (isExpectedLeanCtx() && !leanCtxBinaryPresent()) {
        show(
          ctx,
          [
            "session-helpers: pi-lean-ctx is loaded but the external `lean-ctx` CLI was not found on PATH.",
            "Output compression is disabled (the MCP bridge would fail with spawn ENOENT).",
            "Fix: install lean-ctx (leanctx.com) and add it to PATH, set PI_LEAN_CTX_BIN=/path/to/lean-ctx,",
            "or set PI_KIT_LEAN_CTX=0 to silence this notice. See docs/efficiency-and-loops.md.",
          ].join(" "),
        );
      }
    } catch {
      // Preflight must never break session start.
    }
  });

  // The window changes with the model, and settings may be edited by hand mid-session: keep the
  // published state current (cheap: two small JSON reads). The warning stays once per session.
  pi.on("model_select", async (_event: unknown, ctx: ExtensionContext) => {
    refreshCompaction(pi, ctx);
  });
  pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (ctx) refreshCompaction(pi, ctx);
    return undefined;
  });
  pi.on("session_shutdown", async () => {
    publishCompaction(null);
  });

  pi.registerCommand("clear", {
    description: "How to reset context (pi has no native /clear). Non-destructive: prints guidance only.",
    handler: async (_args, ctx) => {
      show(ctx, CLEAR_GUIDE);
    },
  });


  pi.registerCommand("compaction", {
    description: "Show or change auto-compaction: /compaction [status|on|off|trigger on|trigger off]",
    getArgumentCompletions: (prefix: string) =>
      ["status", "on", "off", "trigger on", "trigger off"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const c = ctx;
      const kitLoaded = pi.getCommands().some((cmd) => cmd.name === "compact-threshold");
      let arg = args.trim().toLowerCase().replace(/\s+/g, " ");
      if (!arg && c.hasUI) {
        const state = currentCompactionState(pi, c);
        const options = [
          `${state.enabled ? "Turn OFF" : "Turn ON"} pi auto-compaction`,
          ...(kitLoaded && state.enabled ? [`${state.kitTrigger.enabled ? "Turn OFF" : "Turn ON"} the kit fixed-budget trigger (${formatK(state.kitTrigger.thresholdTokens)})`] : []),
          "Show status",
        ];
        const choice = await c.ui.select(`Auto-compaction is ${state.enabled ? "ON" : "OFF"}`, options);
        if (choice === undefined) return;
        arg = choice.startsWith("Show") ? "status" : choice.includes("kit") ? `trigger ${state.kitTrigger.enabled ? "off" : "on"}` : state.enabled ? "off" : "on";
      }
      if (!arg || arg === "status") {
        const state = currentCompactionState(pi, c);
        publishCompaction(state);
        report(c, describeCompaction(state), state.reason ? "warning" : "info");
        if (state.reason) markWarned(c);
        return;
      }
      try {
        if (arg === "on" || arg === "off") {
          setGlobalCompactionEnabled(arg === "on");
          const state = currentCompactionState(pi, c);
          publishCompaction(state);
          const projectNote = state.source === "project" && state.enabled !== (arg === "on") ? `\nNote: ${path.join(c.cwd ?? process.cwd(), ".pi", "settings.json")} sets compaction.enabled=${state.enabled} and overrides the global setting for this project.` : "";
          const offNote = arg === "off" ? "\nWARNING: with auto-compaction off pi also stops recovering from a context overflow, so a run ends when the window fills. Subagents and other child sessions inherit this. /compaction on restores it." : "";
          report(c, `Auto-compaction ${arg === "on" ? "enabled" : "disabled"} (global settings). Reloading so pi picks it up...${offNote}${projectNote}`, arg === "off" ? "warning" : "info");
          markWarned(c); // said above; the session_start that follows the reload must not repeat it
          // pi keeps settings in memory; reload so its own threshold/overflow checks see the change.
          await c.waitForIdle?.();
          await c.reload();
          return;
        }
        if (arg === "trigger on" || arg === "trigger off") {
          setKitTriggerEnabled(arg === "trigger on");
          const state = currentCompactionState(pi, c);
          publishCompaction(state);
          report(c, `Kit fixed-budget trigger ${arg === "trigger on" ? "enabled" : "disabled"}.${kitLoaded ? "" : " (trigger-compact is not loaded in this profile, so this has no effect until it is.)"}`);
          return;
        }
      } catch (error) {
        report(c, `compaction: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      report(c, `compaction: unknown option "${arg}". Use status, on, off, trigger on, trigger off.`, "error");
    },
  });

  pi.registerCommand("profile", {
    description:
      "Switch the pi-kit profile in place, all-or-nothing: `/profile` picker, `/profile <name>`, `/profile status` (effective configuration), `/profile list`. Rewrites the kit's settings entry (keeping overrides.json customisations), verifies the result, rolls back on any failure, then reloads - no restart.",
    getArgumentCompletions: (prefix: string) => {
      const kitRoot = findKitRoot();
      const names = kitRoot ? listProfiles(kitRoot).map((p) => p.name) : [];
      return ["status", "list", ...names].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v }));
    },
    handler: async (args, ctx) => {
      const c = ctx;
      const kitRoot = findKitRoot(c.cwd ?? process.cwd(), (message) => report(c, message, "warning"));
      const layout = kitRoot ? resolveKitLayout(kitRoot) : null;
      if (!kitRoot || !layout) {
        report(c, "profile: could not locate the kit (needs its installer and a profiles directory). Set PI_KIT_ROOT to the kit path, or reinstall it (docs/INSTALL.md)", "error");
        return;
      }

      const profiles = listProfiles(kitRoot);
      if (profiles.length === 0) {
        report(c, "profile: no profiles found in the kit checkout.", "error");
        return;
      }
      const projectCwd = c.cwd ?? process.cwd();
      const marker = readMarker(projectCwd);
      // The project settings entry is authoritative for scope, like kit-update's
      // isProjectScoped: in the inconsistent state (project entry, no project marker) the
      // global marker would otherwise make /profile re-register globally from the kit root.
      const projectSettingsFile = path.join(projectCwd, ".pi", "settings.json");
      const projectScoped = marker.scope === "project" || projectKitEntry(projectSettingsFile, kitRoot);
      const settingsFile = projectScoped ? projectSettingsFile : path.join(agentDir(), "settings.json");
      const loaded = loadedKitExtensions(settingsFile, kitRoot);
      // "Current" is what is actually configured, not what the marker last recorded: the two
      // drift when settings are edited by hand, and a stale marker made /profile refuse to
      // re-apply a profile ("already on X") that was no longer in effect.
      const match = loaded ? matchProfile(kitRoot, loaded, profiles.map((p) => p.name), marker.profile) : { exact: undefined, closest: marker.profile, distance: 0 };
      // With no readable kit entry (missing or unfiltered) the marker is the only record.
      const current = match.exact ?? (loaded ? null : marker.profile ?? null);
      const currentLabel = current ?? (loaded ? `custom (closest: ${match.closest ?? "?"}, ${match.distance} difference${match.distance === 1 ? "" : "s"})` : `${marker.profile ?? "unknown"} (unfiltered package)`);
      const requested = args.trim();

      const diffLabel = (name: string) => {
        if (!loaded) return "";
        const d = diffSets(loaded, profileKitExtensions(kitRoot, name));
        return d.add.length || d.remove.length ? ` [+${d.add.length} −${d.remove.length}]` : "";
      };

      // Arguments are validated before anything can change: one word, or nothing.
      const words = requested.split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        report(c, `profile: expected one argument, got ${words.length}: "${requested}". Usage: /profile [status|list|<${profiles.map((p) => p.name).join("|")}>]. Nothing was changed.`, "error");
        return;
      }

      if (requested === "list" || requested === "--list" || requested === "status") {
        const lines = [`Current: ${currentLabel}`, `Settings: ${settingsFile}`, ""];
        if (requested === "status") {
          lines.push(...effectiveConfigLines({ kitRoot, settingsFile, loaded, currentLabel, marker, compaction: refreshCompaction(pi, c, { warn: false }) }), "");
          if (loaded && !current && match.closest) {
            const d = diffSets(profileKitExtensions(kitRoot, match.closest), loaded);
            if (d.add.length) lines.push(`  extra vs ${match.closest}: ${d.add.join(", ")}`);
            if (d.remove.length) lines.push(`  missing vs ${match.closest}: ${d.remove.join(", ")}`);
            lines.push("");
          }
        }
        lines.push("Profiles:", ...profiles.map((p) => `  ${p.name === current ? "*" : " "} ${p.name}${diffLabel(p.name)} - ${p.description}`), "", "Switch with: /profile <name>");
        if (hasOverridesFile() && requested !== "status") lines.push(`Overrides applied to every profile: ${path.join(agentDir(), "pi-kit", "overrides.json")}`);
        show(c, lines.join("\n"));
        return;
      }

      let target = requested;
      if (!target) {
        if (!c.hasUI) {
          report(c, `profile: usage: /profile <${profiles.map((p) => p.name).join("|")}> (or /profile status)`, "error");
          return;
        }
        const labels = profiles.map((p) => `${p.name}${p.name === current ? " (current)" : ""}${diffLabel(p.name)} - ${p.description}`);
        const choice = await c.ui.select(`Switch pi-kit profile (current: ${currentLabel})`, labels);
        if (choice === undefined) return; // cancelled: nothing changes
        target = profiles[labels.indexOf(choice)]?.name ?? "";
      }

      // Renamed profiles (mirrors PROFILE_ALIASES in packages/core/lib/profiles.ts).
      if (target === "engagement") target = "pentest";
      if (!profiles.some((p) => p.name === target)) {
        report(c, `profile: unknown profile "${target}". Known: ${profiles.map((p) => p.name).join(", ")}. Nothing was changed.`, "error");
        return;
      }
      if (target === current) {
        report(c, `profile: already on "${target}" - nothing to do.`, "info");
        return;
      }

      // A switch that lowers the security level in force is a weakening (security-guard.ts).
      const levelOf = (name: string | null | undefined) => (name ? prop(readJsonFile(path.join(layout.profilesDir, `${name}.json`)), "securityLevel") : undefined);
      const lowering = securityLowering(securityFilePath(agentDir()), levelOf(current ?? marker.profile), levelOf(target));
      if (lowering) {
        const answer = await confirmLowering(c, target, lowering);
        if (answer !== "confirmed") {
          report(c, answer === "refused"
            ? `profile: switching to "${target}" lowers security from ${lowering.from} to ${lowering.to}, which needs a choice at the terminal of an interactive root session; refused in headless, RPC and delegated/child sessions. Nothing was changed.`
            : `profile: kept security at ${lowering.from}; nothing was changed. /security sets the level on its own.`, answer === "refused" ? "warning" : "info");
          return;
        }
      }

      // First switch after hand edits: offer to keep them (they would otherwise be replaced by
      // the profile's list, which is exactly how removed extensions kept coming back).
      let capture = false;
      if (c.hasUI && loaded && !current && !hasOverridesFile() && marker.profile) {
        capture = await c.ui.confirm(
          "Keep your customisations?",
          `Your settings differ from the "${marker.profile}" profile you installed (hand-edited extensions or skill/prompt filters). Save those edits to ~/.pi/agent/pi-kit/overrides.json so every profile keeps them?\n\nChoose No to switch to the plain "${target}" profile.`,
        );
      }

      if (c.hasUI) c.ui.setStatus("profile", `switching to ${target}...`);
      // Pass the install options the marker recorded straight back to the installer, so a
      // project-scoped install is not silently re-registered globally.
      const installArgs = [layout.installer, "--profile", target, "--yes", "--settings-only"];
      if (capture) installArgs.push("--capture-overrides");
      if (projectScoped) installArgs.push("--scope", "project");
      else if (marker.scope === "global") installArgs.push("--scope", "global");
      // The installer keeps the registered source and its recorded channel; only the delivery
      // is passed, so a checkout found by PI_KIT_ROOT never replaces a git or npm install.
      if (marker.mode === "git" || marker.mode === "npm") installArgs.push("--mode", marker.mode);

      let outcome: SwitchOutcome;
      try {
        // install.ts derives a project install's settings and marker paths from
        // process.cwd(), so a project-scoped switch must run in the user's project rather
        // than in the kit root. A global switch is unaffected.
        outcome = await runSwitch(pi, c, {
          kitRoot,
          layout,
          target,
          installArgs,
          projectScoped,
          projectCwd,
          reload: true,
          announce: (warnings) => {
            if (c.hasUI) c.ui.setStatus("profile", undefined);
            const extra = warnings.length ? `\nWarnings:\n${warnings.map((w) => `  ${w}`).join("\n")}` : "";
            report(c, `profile: switched to "${target}"${capture ? " (customisations saved to overrides.json)" : ""}. Verified: marker, extension list and firewall match the profile.${extra}\nReloading...`, "info");
          },
        });
      } catch (error) {
        outcome = { ok: false, stage: "install", message: `profile: switch to "${target}" FAILED: ${error instanceof Error ? error.message : String(error)}`, warnings: [], rolledBack: false, rollbackErrors: [], backupDir: null };
      }
      // After a successful switch the reload has replaced this ctx, and pi throws on any use of
      // it, reading hasUI included.
      try {
        if (c.hasUI) c.ui.setStatus("profile", undefined);
      } catch {
        /* stale ctx */
      }
      if (!outcome.ok) report(c, outcome.message + (outcome.warnings.length ? `\nWarnings:\n${outcome.warnings.map((w) => `  ${w}`).join("\n")}` : ""), "error");
      // On success the reload has already replaced this instance: the announcement was made before it.
    },
  });
}
