#!/usr/bin/env node
/**
 * Scripted installer for pi-system.
 * Wraps pi's CLI: pi install, pi config. Idempotent / reconciling.
 *
 * Usage:
 *   node packages/core/install.ts [--profile <quick|balanced|long-horizon|autonomous|self-improving|pentest|lite>]
 *                        [--only <names>] [--all] [--scope <global|project>] [--mode <local|git|npm>]
 *                        [--channel <latest|next|X.Y.Z>] [--git-ref <ref>] [--yes] [--dry-run] [--uninstall]
 *                        [--no-externals] [--settings-only] [--capture-overrides] [--no-migrate]
 *
 *   --mode local         Register this checkout in place (edits apply on /reload). The default
 *                        when run from a git checkout without --channel.
 *   --mode git|npm       Register the released kit instead, delivered from the kit's git
 *                        repository (release tags and main) or the npm package. The default is
 *                        `delivery` in packages/core/distribution.json (PI_KIT_DELIVERY overrides).
 *                        Run from a copy pi installed itself, the installer keeps that delivery.
 *   --channel            latest (the newest release, the default), next (every commit on main)
 *                        or a pinned X.Y.Z[-pre]. On its own it implies the configured delivery.
 *   --git-ref <ref>      Git delivery only: register an arbitrary branch, tag or commit.
 *
 *   --settings-only      Fast path used by the in-TUI /profile command: skip the verify gate,
 *                        and skip re-registering the kit and companions that are already
 *                        registered. Only rewrites the kit's settings entry (then /reload).
 *   --capture-overrides  Save hand edits in the current settings entry (vs the installed
 *                        profile) to <agent dir>/pi-kit/overrides.json so later profile
 *                        switches keep them. Alone: capture and exit.
 *   --no-migrate         Stop, before any change, instead of moving the kit off a retired or
 *                        previous source (/profile passes it: its rollback restores files and
 *                        cannot bring back the clone `pi remove` deletes).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { displayCommand, runPi } from "./lib/pi-cli.ts";
import fs from "node:fs";
import path from "node:path";
import { resolveProfile, type ResolvedExtension } from "./lib/resolve.ts";
import { readSources } from "./lib/sources.ts";
import { mergePackageBlock, removeOtherKitEntries, leanCtxBinaryAvailable, globalSettingsPath, globalAgentDir, readSettings, findPackageEntry, writeSettingsAtomic, isKitNpmSource, isKitGitSource, packageEntrySource, readKitMarker, type KitMarker, type PackageFilters } from "./lib/settings.ts";
import { readDistribution, readRequiredProfileExtensions, isChannel, parseGitSource, gitSourceFor, channelOfGitSource, releaseTags, latestRelease, lsRemoteTags, isLegacyGitSource, isPreviousGitSource, type Distribution } from "./lib/distribution.ts";
import { readOverrides, readOverridesChecked, reconcileOverrides, writeOverrides, isEmptyOverrides, applyExtensionOverrides, excludedSkills, excludedPrompts, skillFilterPatterns, promptFilterPatterns, captureDrift, overridesPath, canonicalProfileName, writeFirewallConfig, checkFirewallConfig, firewallConfigPath, writeSecurityConfig, checkSecurityConfig, securityConfigPath, kitSkills, kitPrompts, snapshotFiles, restoreSnapshots, loadProfileDef, globalGateDrift, type Profile } from "./lib/profiles.ts";
import { resolve as resolveName } from "./lib/resolve.ts";
import { isRecord, parseJson } from "./lib/guard.ts";
import { WORKSPACE_ROOT, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, SOURCES_PATH, ENV_EXAMPLE, extensionRelPath } from "./lib/paths.ts";

const ROOT = WORKSPACE_ROOT;

/** The kit source to register and the channel it follows (null for a local checkout). */
interface KitChoice {
  source: string;
  channel: string | null;
  /** Set when the kit moves from a retired private or previous public git source. */
  migration?: SourceMigration;
}

/** A source registration being replaced, and the channel it moves to. */
interface SourceMigration {
  retired: boolean;
  from: string;
  channel: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const args = process.argv.slice(2);
// A flag's value; undefined when the flag is the last argument, `def` when it is absent.
const get = <D extends string | null>(flag: string, def: D): string | D | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const has = (flag: string): boolean => args.includes(flag);

// Every argument must be a known flag, and a value flag needs a value that is not another flag:
// a typo such as `--profle pentest` used to be ignored and run a default balanced install.
const VALUE_FLAGS = ["--profile", "--only", "--scope", "--mode", "--channel", "--git-ref", "--surface"];
const BOOLEAN_FLAGS = ["--all", "--yes", "--dry-run", "--uninstall", "--no-externals", "--settings-only", "--capture-overrides", "--no-migrate"];
const USAGE = "usage: install.ts [--profile <name>] [--only <a,b>] [--all] [--scope global|project] [--mode local|git|npm] " +
  "[--channel latest|next|X.Y.Z] [--git-ref <ref>] [--yes] [--dry-run] [--uninstall] [--no-externals] [--settings-only] [--capture-overrides] [--no-migrate]";
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (BOOLEAN_FLAGS.includes(arg)) continue;
  const problem = !VALUE_FLAGS.includes(arg)
    ? `unknown argument "${arg}"`
    : args[i + 1] === undefined || String(args[i + 1]).startsWith("--") ? `${arg} needs a value` : null;
  if (problem) {
    console.error(`[install] ${problem}\n${USAGE}`);
    process.exit(1);
  }
  i++;
}

// The split lite surface is now the lite profile of the single package.
const legacySurface = get("--surface", null);
if (legacySurface && legacySurface !== "lite") {
  console.error(`[install] --surface was removed: pi-system ships as one package. Use --profile <name> instead.`);
  process.exit(1);
}
if (legacySurface) console.warn("[install] --surface lite is deprecated; installing the lite profile (--profile lite).");
const explicitProfile = args.includes("--profile") || Boolean(legacySurface);
const profile = canonicalProfileName(String(legacySurface ? "lite" : get("--profile", "balanced")));
const onlyNames = get("--only", null)?.split(",").map((n) => n.trim());
const all = has("--all");
const scopeArg = get("--scope", "global");
if (scopeArg !== "global" && scopeArg !== "project") throw new Error(`[install] unknown --scope "${String(scopeArg)}" (expected global or project)`);
const scope = scopeArg;
const dryRun = has("--dry-run");
const uninstall = has("--uninstall");
const noExternals = has("--no-externals");
const settingsOnly = has("--settings-only");
const captureOverrides = has("--capture-overrides");
const noMigrate = has("--no-migrate");
const explicitChannel = get("--channel", null);
const legacyGitRef = get("--git-ref", null);

if (uninstall) {
  // uninstall.ts reads the state marker, so it also removes the companions this installer
  // registered, whichever copy of the kit (git, npm or checkout) is installed.
  // Forward --scope only when the operator passed it: without --scope uninstall.ts
  // auto-detects the marker (project .pi/.pi-kit.json in the cwd, else the global one),
  // so the documented `install.ts --uninstall` from the repo root finds a project install.
  const forwarded = [...(args.includes("--scope") ? ["--scope", scope] : []), ...(dryRun ? ["--dry-run"] : []), ...(has("--yes") ? ["--yes"] : [])];
  const result = spawnSync(process.execPath, [path.join(WORKSPACE_ROOT, "packages", "core", "uninstall.ts"), ...forwarded], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}


let distribution: Distribution;
// The extensions every install loads (distribution.json requiredProfileExtensions).
let requiredExtensions: string[];
try {
  distribution = readDistribution();
  requiredExtensions = readRequiredProfileExtensions();
} catch (error) {
  console.error(`[install] ${errorMessage(error)}`);
  process.exit(1);
}

const settingsPath = scope === "global"
  ? globalSettingsPath()
  : path.join(process.cwd(), ".pi", "settings.json");
// The state marker follows the scope: a project install records its marker under the
// project's .pi/ so it never clobbers the global ~/.pi/agent marker (and vice versa).
const markerPath = scope === "global"
  ? path.join(globalAgentDir(), ".pi-kit.json")
  : path.join(process.cwd(), ".pi", ".pi-kit.json");

// Whole-run rollback for the fast --settings-only path (what /profile drives). Each write below is
// atomic, but the run writes several files in sequence; any exit that is not a clean finish (a
// failed step, an uncaught exception, SIGINT/SIGTERM) restores every one of them, so the
// configuration is either the old one or the complete new one. `installCommitted` flips once the
// marker, the last write, is on disk. A SIGKILL cannot run code; /profile snapshots as well.
// The snapshots cover configuration files only: a `pi install` or `pi remove` the run already made
// (recorded in `packageChanges`) is not undone, and the rollback message names each one.
let installCommitted = false;
const packageChanges: string[] = [];
if (settingsOnly && !dryRun) {
  const snapshots = snapshotFiles([settingsPath, markerPath, firewallConfigPath(), securityConfigPath(), overridesPath(), path.join(globalAgentDir(), ".env")]);
  process.on("exit", (code) => {
    if (installCommitted || code === 0) return;
    const failed = restoreSnapshots(snapshots);
    if (failed.length) console.error(`[install] ROLLBACK INCOMPLETE: could not restore ${failed.join(", ")}`);
    else if (packageChanges.length) {
      console.error(`[install] Rolled back ${snapshots.length} configuration file(s), but NOT the package operations pi already ran: ${packageChanges.join("; ")}. ` +
        "The settings are as before; pi may have changed those packages' files on disk (`pi list` shows what is registered).");
    } else console.error(`[install] Rolled back ${snapshots.length} configuration file(s); nothing was changed.`);
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) process.on(signal, () => process.exit(code));
}

// A copy pi installed itself lives under <agent dir>/git or <agent dir>/npm (or .pi/git, .pi/npm
// for project scope). Run from there (by /profile, /update or the first-run auto-profile), the
// installer keeps registering that same delivery instead of the clone as a local checkout.
function managedInstallKind(root: string): "npm" | "git" | null {
  const parts = path.resolve(root).split(path.sep);
  if (parts.includes("node_modules")) return "npm";
  const gitIdx = parts.lastIndexOf("git");
  if (gitIdx > 0 && (parts[gitIdx - 1] === path.basename(globalAgentDir()) || parts[gitIdx - 1] === ".pi")) return "git";
  return null;
}
// A git checkout installs itself in place unless a release channel is asked for.
const isCheckout = fs.existsSync(path.join(WORKSPACE_ROOT, ".git"));
const managedKind = managedInstallKind(WORKSPACE_ROOT);
const defaultMode = managedKind ?? (explicitChannel || legacyGitRef ? distribution.delivery : isCheckout ? "local" : distribution.delivery);
const mode = get("--mode", legacyGitRef ? "git" : defaultMode);
if (mode !== "local" && mode !== "git" && mode !== "npm") {
  console.error(`[install] unknown --mode "${String(mode)}" (expected local, git or npm)`);
  process.exit(1);
}
if (explicitChannel && !isChannel(explicitChannel)) {
  console.error(`[install] invalid --channel "${String(explicitChannel)}" (expected latest, next or an exact version such as 0.2.4-beta.0)`);
  process.exit(1);
}

function readMarkerFile(): KitMarker | null {
  return readKitMarker(markerPath);
}

function registeredKitSource(match: (source: string) => boolean): string | null {
  const settings = readSettings(settingsPath);
  for (const entry of settings.packages ?? []) {
    const src = packageEntrySource(entry);
    if (match(src)) return src;
  }
  return null;
}

// The channel recorded when this source was installed (the marker), if it is the same package.
function recordedChannel(source: string): string | null {
  const marker = readMarkerFile();
  if (!marker?.channel || typeof marker.kitSource !== "string") return null;
  const a = parseGitSource(marker.kitSource);
  const b = parseGitSource(source);
  const same = a && b ? a.key === b.key && a.ref === b.ref : marker.kitSource === source;
  return same ? marker.channel : null;
}

// npm delivery: an explicit --channel wins; otherwise keep the channel the kit is already
// registered on (so /profile never moves a user between latest and next), otherwise follow
// this copy's own version (a main snapshot means next).
function ownVersion(): string {
  try {
    const pkg = parseJson(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return isRecord(pkg) && typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}
function npmKitSource(): KitChoice {
  const pkg = distribution.npm.package;
  if (!explicitChannel) {
    const existing = registeredKitSource(isKitNpmSource);
    if (existing) {
      const spec = existing.slice(4).replace(/^@?[^@]+/, "").replace(/^@/, "");
      return { source: existing, channel: spec || "latest" };
    }
  }
  const channel = explicitChannel ?? (/[.-]next\./.test(ownVersion()) ? "next" : "latest");
  // Unversioned tracks latest in `pi update`; a dist-tag or exact version is kept as given.
  return { source: channel === "latest" ? `npm:${pkg}` : `npm:${pkg}@${channel}`, channel };
}

// git delivery: `next` is the unpinned repository (pi follows its default branch), a release is
// its `v<version>` tag, and `latest` resolves to the newest release tag with `git ls-remote`.
// With no --channel, the registered source and its recorded channel are kept.
//
// A registration from a retired private source (distribution.json git.legacySources) is never
// reused: the kit is registered from the public source instead, on the channel the install was
// following (`next` stays `next`; a release or a pin becomes `latest`, because a private tag
// does not exist publicly). `sourceMigration` records what was replaced so the rest of the
// installer can preserve hand edits and remove the old copy.
// The text a failed `git ls-remote` reported: its stderr, else the error message.
function commandErrorText(error: unknown): string {
  if (!isRecord(error)) return "";
  const text = error.stderr || error.message;
  if (Buffer.isBuffer(text)) return text.toString().trim();
  return typeof text === "string" ? text.trim() : "";
}

function gitKitSource(): KitChoice {
  const registered = registeredKitSource(isKitGitSource);
  const legacy = registered && isLegacyGitSource(registered, distribution.git.legacySources) ? registered : null;
  if (distribution.git.ignoredEnvSource) {
    console.warn(`[install] Ignoring PI_SYSTEM_GIT_SOURCE=${distribution.git.ignoredEnvSource}: it names the retired private source. Unset it; the kit installs from ${distribution.git.source}.`);
  }
  const base = distribution.git.source || (legacy ? "" : registered) || "";
  if (!parseGitSource(base)) {
    console.error(`[install] no usable git source for the kit ("${base}"). Set git.source in packages/core/distribution.json or PI_SYSTEM_GIT_SOURCE=git:<host>/<owner>/pi-system.`);
    process.exit(1);
  }
  // A non-retired fork remains the user's choice unless a source override or previous-source
  // migration selects the configured repository.
  // A profile switch keeps its registration. An explicit channel request (as /update kit
  // supplies) moves a former public delivery to the configured source.
  const previous = explicitChannel && registered && !legacy && isPreviousGitSource(registered, distribution.git.previousSources)
    && !isPreviousGitSource(registered, [base]) ? registered : null;
  const keepRegistered = registered && !legacy && !previous && !process.env.PI_SYSTEM_GIT_SOURCE?.trim();
  const effectiveBase = keepRegistered ? registered : base;
  if (legacyGitRef) {
    const next = legacyGitRef === distribution.git.branch;
    return { source: gitSourceFor(effectiveBase, next ? null : legacyGitRef), channel: next ? "next" : legacyGitRef };
  }
  if (!explicitChannel && registered && !legacy) {
    return { source: registered, channel: recordedChannel(registered) ?? channelOfGitSource(registered, distribution.git.tagPrefix) };
  }
  let channel = explicitChannel ?? "latest";
  let migration: SourceMigration | undefined;
  if (legacy) {
    const before = recordedChannel(legacy) ?? channelOfGitSource(legacy, distribution.git.tagPrefix);
    if (!explicitChannel) channel = before === "next" ? "next" : "latest";
    migration = { from: legacy, channel, retired: true };
    console.warn(`[install] Migrating the kit from the retired private source ${legacy} to ${distribution.git.source} (channel ${channel}).`);
  }
  if (previous) {
    migration = { from: previous, channel, retired: false };
    console.log(`[install] Moving the kit from the previous public source ${previous} to ${base} (channel ${channel}).`);
  }
  if (migration && noMigrate) {
    console.error(`[install] --no-migrate: not moving the kit off ${migration.from}. Nothing was changed. Move it with /update kit, or with Route 1 of docs/migration.md, then switch profiles.`);
    process.exit(1);
  }
  const choice = (source: string, chosen: string): KitChoice => (migration ? { source, channel: chosen, migration } : { source, channel: chosen });
  if (channel === "next") return choice(gitSourceFor(effectiveBase, null), channel);
  if (channel !== "latest") return choice(gitSourceFor(effectiveBase, `${distribution.git.tagPrefix}${channel}`), channel);
  const parsedBase = parseGitSource(effectiveBase);
  // effectiveBase is either the validated base or a registered source isKitGitSource() parsed.
  if (!parsedBase) throw new Error(`[install] cannot parse the git source "${effectiveBase}"`);
  const repo = parsedBase.repo;
  let versions: string[];
  try {
    versions = releaseTags(lsRemoteTags(repo), distribution.git.tagPrefix);
  } catch (error) {
    console.error(`[install] could not list release tags of ${repo}: ${commandErrorText(error)}`);
    console.error("[install] Check network access to the repository (git ls-remote), or install --channel next.");
    process.exit(1);
  }
  const version = latestRelease(versions);
  if (!version) {
    console.error(`[install] ${repo} has no release tags (${distribution.git.tagPrefix}X.Y.Z) yet. Install --channel next to follow main, or see docs/releasing.md.`);
    process.exit(1);
  }
  return choice(gitSourceFor(effectiveBase, `${distribution.git.tagPrefix}${version}`), "latest");
}

const kit: KitChoice = mode === "local"
  ? { source: ROOT, channel: null }
  : mode === "npm"
    ? npmKitSource()
    : gitKitSource();
const kitSource = kit.source;
// `sourceMigration` records what was replaced so the rest of the installer can preserve hand edits
// and remove the old copy.
const sourceMigration = kit.migration ?? null;

// pi removes the replaced copy's clone as well as its settings entry (it deletes the clone even when
// the entry is already gone); if that fails the settings entry is still dropped and the orphaned
// clone is harmless.
function removeMigratedSource(): void {
  if (!sourceMigration || dryRun) return;
  try {
    recordPackageChange(["remove", sourceMigration.from, ...scopeArgs]);
    runPi(piBin, ["remove", sourceMigration.from, ...scopeArgs], { stdio: "pipe" });
    console.log(`[install] Removed the ${sourceMigration.retired ? "retired" : "previous public"} registration ${sourceMigration.from}.`);
  } catch {
    console.warn(`[install] Could not run \`pi remove ${sourceMigration.from}\`; its settings entry is dropped instead.`);
  }
}

// pi is run with an argument vector (lib/pi-cli.ts): a source string is data, never shell text.
// The marker line lets /profile tell a configuration-only rollback from one that left package changes.
function recordPackageChange(args: string[]): number {
  const shown = `pi ${args.join(" ")}`;
  console.log(`[install] Package change (a rollback cannot undo it): ${shown}`);
  return packageChanges.push(shown) - 1;
}
function runPiCommand(args: string[]): void {
  console.log(`  > ${displayCommand(args)}`);
  if (dryRun) return;
  const at = recordPackageChange(args);
  try {
    runPi(piBin, args);
  } catch (error) {
    packageChanges[at] = `${packageChanges[at] ?? ""} (failed part-way)`;
    throw error;
  }
}

function resolveCommand(name: string): string | null {
  const pathEnv = process.env.Path || process.env.PATH || "";
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// --- Load profile from profiles/<name>.json ---
function loadProfile(name: string): Profile {
  const p = path.join(PROFILES_DIR, `${canonicalProfileName(name)}.json`);
  if (!fs.existsSync(p)) throw new Error(`[install] Profile not found: ${p}`);
  return loadProfileDef(name, PROFILES_DIR);
}

// --- Collect all extension names from in-repo + vendor ---
function allExtensionNames(): string[] {
  const names: string[] = [];
  for (const full of [FIRST_PARTY_DIR, THIRD_PARTY_DIR]) {
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.startsWith("_")) continue;
      if (fs.statSync(path.join(full, name)).isDirectory()) names.push(name);
    }
  }
  // Also add external names from sources.json
  const sourcesPath = SOURCES_PATH;
  if (fs.existsSync(sourcesPath)) {
    const { external } = readSources(sourcesPath);
    for (const e of external) names.push(...(e.provides ?? [e.name]));
  }
  return [...new Set(names)];
}

// --- Capture hand edits as overrides (before anything is rewritten) ---
// Also runs automatically when the kit moves off a retired private or previous public source: the old
// entry is about to be replaced, so its hand edits (extensions added or removed, skill and
// prompt exclusions) become overrides first and survive the move.
if (captureOverrides || sourceMigration) {
  const checked = readOverridesChecked();
  if (checked.error) throw new Error(`[install] capture-overrides: refusing to overwrite overrides: ${checked.error}`);
  const marker = readMarkerFile();
  const settings = readSettings(settingsPath);
  const idx = findPackageEntry(settings, sourceMigration?.from ?? kitSource, settingsPath);
  if (!marker?.profile || idx === -1) {
    console.log("[install] capture-overrides: no installed kit profile/entry to compare against; nothing captured.");
  } else if (!isEmptyOverrides(readOverrides())) {
    console.log(`[install] capture-overrides: ${overridesPath()} already has overrides; left unchanged.`);
  } else {
    let installedDef: Profile;
    try { installedDef = loadProfile(marker.profile); } catch { installedDef = { include: [] }; }
    // Compare extensions against what was actually installed (the marker), not the profile
    // file as it is today — the profile may have changed since.
    const baseline: Profile = { ...installedDef, include: marker.extensions ?? installedDef.include ?? [] };
    const entry = settings.packages?.[idx];
    const comparable = entry !== undefined && typeof entry !== "string" && Array.isArray(entry.extensions);
    const drift = comparable ? captureDrift(entry, baseline, (name) => resolveName(name)?.avenue !== "external" && resolveName(name) !== null) : readOverrides();
    if (!comparable) console.log("[install] capture-overrides: kit entry has no comparable extension list; nothing to capture.");
    if (isEmptyOverrides(drift)) {
      console.log("[install] capture-overrides: settings match the installed profile; nothing to capture.");
    } else if (dryRun) {
      console.log(`[install] Dry run: would write overrides ${JSON.stringify(drift)}`);
    } else {
      writeOverrides(drift);
      console.log(`[install] capture-overrides: saved hand edits to ${overridesPath()}: ${JSON.stringify(drift)}`);
    }
  }
  if (captureOverrides && !explicitProfile && !onlyNames && !all) process.exit(0);
}

// Determine selected name set
let selected: string[];
let profileDef: Profile | null = null;
// Operator overrides. Only a profile install applies them, so only then can they stop the run:
// an unreadable file may hold a removal of a protection we cannot see (fail closed), and removing
// a mandatory protection extension is refused outright. Names that no longer exist in this kit
// (renamed or removed extensions, skills, prompts) are dropped with a warning instead of failing
// the whole switch.
let overrides = readOverrides();
if (!all && !onlyNames) {
  const read = readOverridesChecked();
  if (read.error) {
    console.error(`[install] FAIL: ${read.error}. Fix or delete it, then retry; nothing was changed.`);
    process.exit(1);
  }
  const reconciled = reconcileOverrides(read.overrides, {
    extensionExists: (name) => resolveName(name) !== null,
    skills: kitSkills().map((s) => s.name),
    prompts: kitPrompts(),
    required: requiredExtensions,
  });
  for (const warning of reconciled.warnings) console.warn(`[install] WARN: ${warning}`);
  if (reconciled.errors.length) {
    for (const error of reconciled.errors) console.error(`[install] FAIL: ${error}`);
    process.exit(1);
  }
  overrides = reconciled.overrides;
}
if (all) {
  selected = allExtensionNames();
} else if (onlyNames) {
  // --only narrows what loads, but never below the required base (tool-firewall, protected-paths, ...).
  const added = requiredExtensions.filter((name) => !onlyNames.includes(name));
  if (added.length) console.warn(`[install] WARN: --only did not name the required extension(s) ${added.join(", ")}; adding them (every install loads ${requiredExtensions.join(", ")}).`);
  selected = [...onlyNames, ...added];
} else {
  profileDef = loadProfile(profile);
  // Safety-critical config is validated before anything is written: an unknown firewall policy or
  // mode (in the profile or in the existing firewall.json) or an unreadable firewall.json stops here.
  try {
    checkFirewallConfig(profileDef);
    checkSecurityConfig(profileDef);
  } catch (error) {
    console.error(`[install] FAIL: ${errorMessage(error)}`);
    process.exit(1);
  }
  // Operator overrides apply on top of every profile so a switch never undoes hand edits.
  selected = applyExtensionOverrides(profileDef.include ?? [], overrides);
}

// Profile installs also own the kit's skill/prompt filters (schema v2). --only / --all leave
// whatever filters the entry already has.
const profileFilters = profileDef
  ? {
      skills: skillFilterPatterns(excludedSkills(profileDef, overrides)),
      prompts: promptFilterPatterns(excludedPrompts(profileDef, overrides)),
    }
  : null;
const packageFilters: PackageFilters = profileFilters ?? {};

// Full-package installs (--all) intentionally load everything; --profile and --only must
// load exactly `selected`.
// F-01 fix: previously `selected` was computed but never used to narrow what pi
// actually loads at runtime - the installer always registered the whole wildcard
// root package (packages/core/lib/settings.ts's mergePackageBlock existed to do this but was
// never called from here). resolveProfile() resolves each selected name to its
// in-repo/vendor/external avenue and throws on typos/unresolved names; mergePackageBlock
// rewrites the package entry pi install just wrote into settings.json to an object
// form scoped to exactly the resolved in-repo/vendor extensions (external companions
// are installed separately as their own package entries in step 3 below).
const shouldFilterExtensions = !all;
let resolvedResources: ResolvedExtension[] | null = null;
if (shouldFilterExtensions) {
  try {
    resolvedResources = resolveProfile(selected);
  } catch (error) {
    console.error(`[install] FAIL: ${errorMessage(error)}`);
    process.exit(1);
  }
}
// Set exactly when shouldFilterExtensions (resolveProfile either returned or the run exited).
const extensionPatterns = resolvedResources
  ? resolvedResources
      .filter((r) => r.avenue !== "external")
      .map((r) => extensionRelPath(r.name, r.avenue))
  : null;

// --- Preflight: check required tools ---
// `name` is run with `--version` (an argument vector, no shell); a command that cannot be spawned
// directly (a Windows .cmd shim) is still found on PATH by resolveCommand().
function check(name: string, required = true): boolean {
  if (dryRun) {
    if (!resolveCommand(name) && required) console.warn(`[install] WARN: ${name} not found - preview continues (dry run)`);
    return true;
  }
  try { execFileSync(name, ["--version"], { stdio: "pipe" }); return true; }
  catch {
    if (resolveCommand(name)) return true;
    if (required) { console.error(`[install] FAIL: ${name} is required`); process.exit(1); }
    console.warn(`[install] WARN: ${name} not found - some features will be unavailable`);
    return false;
  }
}

// git is needed to register a checkout or clone a git source.
if (mode !== "npm") check("git");
check("pi");
const piBin = resolveCommand("pi") || "pi";

console.log(`\n[install] pi-system`);
console.log(`  profile:      ${all ? "all" : onlyNames ? "--only" : profile}`);
console.log(`  extensions:   ${selected.join(", ") || "(none)"}`);
console.log(`  filter:       ${extensionPatterns ? `${extensionPatterns.length} in-package extension(s) enabled, rest disabled` : "(none - full package)"}`);
console.log(`  scope:        ${scope}`);
console.log(`  mode:         ${mode}${kit.channel ? ` (channel ${kit.channel})` : ""}`);
console.log(`  source:       ${kitSource}`);
console.log(`  settings:     ${settingsPath}`);
console.log(`  no-externals: ${noExternals}`);
if (profileFilters) console.log(`  hidden:       ${profileFilters.skills.length} skill(s), ${profileFilters.prompts.length} prompt(s)${isEmptyOverrides(overrides) ? "" : ` (overrides: ${overridesPath()})`}`);
if (settingsOnly) console.log("  mode:         settings-only (no verify gate, no re-registration)");
console.log(`  dry-run:      ${dryRun}`);
console.log("");

// 1. Verify gate (skipped for --settings-only: switching which already-verified extensions
// load does not change any code, and the gate made every /profile switch slow and fallible).
// Only a local checkout is gated: a release (git tag or npm) and main were checked in CI, and
// the gate would check this copy, not the one being registered.
if (!settingsOnly && !dryRun && mode === "local") {
  console.log("[install] Running verify gate...");
  try {
    execFileSync(process.execPath, ["packages/core/verify.ts"], { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error("[install] Verify gate failed. Fix errors before installing.");
    process.exit(1);
  }
}

// Registered as exactly this source? (A git or npm entry on another ref/channel is the same
// package to pi, but must be re-registered to move it; local paths are normalized by pi.)
const isRegistered = (source: string): boolean => {
  const settings = readSettings(settingsPath);
  const idx = findPackageEntry(settings, source, settingsPath);
  if (idx === -1) return false;
  if (mode === "local") return true;
  const entry = settings.packages?.[idx];
  return entry !== undefined && packageEntrySource(entry) === source;
};

// 2. Register the kit
const scopeArgs = scope === "project" ? ["-l"] : [];
if (settingsOnly && isRegistered(kitSource)) {
  console.log("\n[install] Kit already registered; updating its settings entry only.");
} else {
  console.log("\n[install] Registering kit with pi...");
  runPiCommand(["install", kitSource, ...scopeArgs]);
}

// 2b. Narrow the registered package to the profile/--only selection (F-01 fix).
// `pi install` always registers the full wildcard package; without this step every
// profile - including "quick" - would still load every extension, including
// quarantined stubs and experimental extensions.
if (resolvedResources && extensionPatterns) {
  if (dryRun) {
    console.log(`\n[install] Dry run: would narrow package to ${extensionPatterns.length} extension(s): ${extensionPatterns.join(", ") || "(none)"}`);
  } else {
    try {
      mergePackageBlock(settingsPath, kitSource, resolvedResources, packageFilters);
      console.log(`[install] Narrowed package to ${extensionPatterns.length} extension(s) in ${settingsPath}`);
    } catch (error) {
      console.error(`[install] FAIL: ${errorMessage(error)} - install would silently load the full package.`);
      process.exit(1);
    }
  }
}

// Keep exactly one copy of the kit registered: a checkout, a git clone and the npm package
// (and the retired dist/pi-kit-* surfaces) all ship the same tools, so any other copy left
// registered would collide on every shared extension, skill, prompt and theme name.
if (!dryRun) {
  // Under --settings-only it runs after the commit instead: the rollback restores files only, and a
  // restored settings.json must never point at a clone `pi remove` has already deleted. Its entry
  // stays until then, because pi removes a package only while settings.json still lists it.
  if (!settingsOnly) removeMigratedSource();
  removeOtherKitEntries(settingsPath, kitSource, settingsOnly ? sourceMigration?.from ?? null : null);
}

// Companion sources this install is responsible for, recorded in the state marker so
// uninstall.ts can remove them again. Filled inside the block below (empty with
// --no-externals), so it is declared here where the marker write can still see it.
const markerCompanions: string[] = [];

// 3. Install companion external sources (reference mode only, unless --no-externals)
if (!noExternals) {
  const sourcesPath = SOURCES_PATH;
  if (fs.existsSync(sourcesPath)) {
    const { external } = readSources(sourcesPath);
    const companions = external.filter((e) =>
      e.mode === "reference" &&
      selected.some((n) => (e.provides ?? [e.name]).includes(n))
    ).filter((e) => {
      if (e.name !== "pi-lean-ctx" || leanCtxBinaryAvailable()) return true;
      console.warn("[install] Skipping pi-lean-ctx: its required lean-ctx CLI is not available on PATH (set PI_LEAN_CTX_BIN or LEAN_CTX_BIN after installing it).");
      return false;
    });
    // A companion registered at a different pinned version is reinstalled at the kit's pin
    // (`pi install` updates the existing entry in place), so a kit update carries its
    // reviewed companion versions with it.
    const missing = companions.filter((c) => {
      const settings = readSettings(settingsPath);
      const idx = findPackageEntry(settings, c.source, settingsPath);
      if (idx === -1) return true;
      const entry = settings.packages?.[idx];
      return entry === undefined || packageEntrySource(entry) !== c.source;
    });
    // Record only the companions this run installs (a companion registered at a different
    // version is reinstalled, so it too is ours). One already registered at the kit's pin
    // before this run is the operator's own unless a previous marker recorded it (carried over
    // at step 5), so uninstall never removes a package this installer did not add. A companion
    // dropped by the prerequisite filter above (pi-lean-ctx without its CLI) is never recorded.
    // The strings are the exact `source` values uninstall.ts passes back to `pi remove`.
    markerCompanions.push(...missing.map((c) => c.source));
    if (missing.length > 0) {
      console.log(`\n[install] Installing ${missing.length} companion external(s)...`);
      for (const c of missing) {
        runPiCommand(["install", c.source, ...scopeArgs]);
      }
    } else if (companions.length > 0) {
      console.log(`\n[install] ${companions.length} companion external(s) already registered.`);
    }
  }
}

// 4. Scaffold .env if absent
const envExample = ENV_EXAMPLE;
const envTarget = path.join(globalAgentDir(), ".env");
if (!fs.existsSync(envTarget) && fs.existsSync(envExample)) {
  if (!dryRun) {
    console.log(`\n[install] Scaffolding ${envTarget} from .env.example...`);
    fs.mkdirSync(path.dirname(envTarget), { recursive: true, mode: 0o700 });
    // .env holds API keys: create it 0600 (copyFileSync would keep the template's 0644).
    fs.writeFileSync(envTarget, fs.readFileSync(envExample), { mode: 0o600, flag: "wx" });
  } else {
    console.log(`\n[install] Dry run: would scaffold ${envTarget} from .env.example`);
  }
}

// 4b. Firewall policy and default mode from the profile (tool-firewall and protected-paths read it).
// Both files are machine-global, so a --scope project install leaves them alone and only warns
// where the profile's gate differs (TOO-1).
if (profileDef && scope === "project") {
  try {
    for (const warning of globalGateDrift(profileDef)) console.warn(`[install] WARN: ${warning}`);
  } catch (error) {
    console.error(`[install] FAIL: ${errorMessage(error)}`);
    process.exit(1);
  }
} else if (profileDef) {
  if (dryRun) {
    console.log(`[install] Dry run: would set securityLevel ${profileDef.securityLevel ?? "balanced"} in ${securityConfigPath()}`);
    console.log(`[install] Dry run: would set firewall ${profileDef.firewall?.mode ?? "manual"}/${profileDef.firewall?.policy ?? "coding"} in ${firewallConfigPath()}`);
  } else {
    try {
      const fw = writeFirewallConfig(profileDef);
      writeSecurityConfig(profileDef);
      console.log(`[install] Firewall: mode ${fw.mode}${fw.source === "user" ? " (kept, set with /auto)" : ""}, policy ${fw.policy} -> ${firewallConfigPath()}`);
    } catch (error) {
      // The firewall config is safety-critical: continuing would record a profile whose gate was
      // never applied. Fail closed (the run rolls back under --settings-only).
      console.error(`[install] FAIL: could not write ${firewallConfigPath()}: ${errorMessage(error)}`);
      process.exit(1);
    }
  }
}

// 5. Record state marker for uninstall
if (!dryRun) {
  // Carry over companions already recorded by a previous install: a profile switch that
  // no longer selects them must not orphan a package `pi` still has registered. A
  // companion stays tracked until it is actually removed from settings.json. Each carried
  // source is re-read from settings.json, so one that `pi install` replaced in place at a new
  // pin is recorded at the version actually registered, and one no longer registered is dropped.
  const settingsNow = readSettings(settingsPath);
  const carriedCompanions = (readMarkerFile()?.companions ?? []).flatMap((source) => {
    const entry = settingsNow.packages?.[findPackageEntry(settingsNow, source, settingsPath)];
    return entry === undefined ? [] : [packageEntrySource(entry)];
  });
  const marker: KitMarker = {
    kitSource,
    profile: all ? "all" : onlyNames ? "custom" : profile,
    extensions: selected,
    overrides: isEmptyOverrides(overrides) ? null : overridesPath(),
    scope,
    mode,
    ref: mode === "git" ? parseGitSource(kitSource)?.ref ?? null : null,
    channel: kit.channel,
    companions: [...new Set([...carriedCompanions, ...markerCompanions])],
    installedAt: new Date().toISOString(),
  };
  writeSettingsAtomic(markerPath, marker);
}
installCommitted = true;
if (settingsOnly && sourceMigration && !dryRun) {
  removeMigratedSource();
  removeOtherKitEntries(settingsPath, kitSource);
}

const webConsoleSelected = selected.includes("web-console");
console.log(`
[install] Done.

Next steps:
  1. Start pi:      pi          (or /reload if pi is already running)
  2. Check loaded:  pi list
  3. Switch later:  /profile    Updates: /update
${webConsoleSelected ? "\nWeb console: run /console in pi (alias /webui), or 'npm run install:web' for a standalone setup.\n" : ""}`);
