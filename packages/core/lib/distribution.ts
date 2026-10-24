import { createHash } from "node:crypto";
// How the kit is delivered to users: git (release tags and the main branch of the kit's git
// repository) or npm (dist-tags of the published package). packages/core/distribution.json
// holds the setting; PI_KIT_DELIVERY and PI_SYSTEM_GIT_SOURCE override it per machine.
//
// Both deliveries expose the same channels, so the installer, /profile and /update behave the
// same either way:
//   latest   the newest release (a stable release once one exists, otherwise the newest beta)
//   next     every commit on main
//   X.Y.Z    exactly that release, never moved automatically
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { array, isRecord, object, optional, parseJson, string, ValidationError, type Infer } from "./guard.ts";
import { KIT_PACKAGE_NAME } from "./identity.ts";
import { CORE_DIR } from "./paths.ts";
import { parseSemver, compareSemver } from "./semver.ts";

export const DISTRIBUTION_PATH = path.join(CORE_DIR, "distribution.json");

/** packages/core/distribution.json as written in the repository (every key optional; defaults below). */
export const DistributionConfigSchema = object({
  delivery: optional(string()),
  /** The extensions every profile and every narrowed (--only) install loads. */
  requiredProfileExtensions: optional(array(string({ minLength: 1 }))),
  git: optional(object({
    source: optional(string()),
    branch: optional(string()),
    tagPrefix: optional(string()),
    /** Retired private sources: host/path keys or `sha256:<hex of the key>` fingerprints. */
    legacySources: optional(array(string())),
    /** Former public deliveries, matched by repository identity, ignoring refs. */
    previousSources: optional(array(string({ minLength: 1 }))),
  })),
  npm: optional(object({ package: optional(string()) })),
});
export type DistributionConfig = Infer<typeof DistributionConfigSchema>;

export type KitDelivery = "git" | "npm";

/** The effective delivery settings: distribution.json with the per-machine overrides applied. */
export interface Distribution {
  delivery: KitDelivery;
  git: {
    source: string;
    branch: string;
    tagPrefix: string;
    legacySources: string[];
    previousSources: string[];
    /** A PI_SYSTEM_GIT_SOURCE naming a retired source, ignored (reported by the caller), or null. */
    ignoredEnvSource: string | null;
  };
  npm: {
    package: string;
  };
}

/** The environment variables readDistribution() consults. */
export interface DistributionEnv {
  readonly PI_KIT_DELIVERY?: string | undefined;
  readonly PI_SYSTEM_GIT_SOURCE?: string | undefined;
}

function isKitDelivery(value: string): value is KitDelivery {
  return value === "git" || value === "npm";
}

// A missing or unparseable file, or one that is not a JSON object, falls back to the defaults.
// An object whose keys have the wrong types is a broken release artefact and is refused (it holds
// the list of retired sources, so it must never be half-read).
export function readDistribution(file: string = DISTRIBUTION_PATH, env: DistributionEnv = process.env): Distribution {
  let config: DistributionConfig = {};
  let parsed: unknown;
  try {
    parsed = parseJson(fs.readFileSync(file, "utf8"));
  } catch {
    /* defaults below */
  }
  if (isRecord(parsed)) {
    try {
      config = DistributionConfigSchema.parse(parsed, "distribution");
    } catch (error) {
      if (error instanceof ValidationError) throw new Error(`invalid kit distribution config ${file}: ${error.message}`, { cause: error });
      throw error;
    }
  }
  validatePreviousSources(config.git?.previousSources);
  const delivery = (env.PI_KIT_DELIVERY || config.delivery || "git").trim();
  if (!isKitDelivery(delivery)) throw new Error(`unknown kit delivery "${delivery}" (expected git or npm)`);
  const legacySources = (config.git?.legacySources ?? []).filter((s) => s.trim()).map((s) => s.trim().toLowerCase());
  // PI_SYSTEM_GIT_SOURCE used to be the documented way to reach the private remote over SSH. An
  // override that still names a retired source is ignored (and reported), so a stale variable
  // in a shell profile can never reconnect an install to the private remote.
  const envSource = (env.PI_SYSTEM_GIT_SOURCE || "").trim();
  const envIsLegacy = envSource !== "" && isLegacyGitSource(envSource, legacySources);
  return {
    delivery,
    git: {
      source: ((envIsLegacy ? "" : envSource) || config.git?.source || "").trim(),
      branch: config.git?.branch || "main",
      tagPrefix: config.git?.tagPrefix ?? "v",
      legacySources,
      previousSources: config.git?.previousSources ?? [],
      ignoredEnvSource: envIsLegacy ? envSource : null,
    },
    npm: {
      package: config.npm?.package || KIT_PACKAGE_NAME,
    },
  };
}

/**
 * distribution.json's requiredProfileExtensions: the one list of extensions every install loads
 * (profile-check enforces it on each shipped profile; install.ts adds it back under --only and
 * ignores an overrides.json removal of it). A missing or unreadable file is an error, never an
 * empty base.
 */
export function readRequiredProfileExtensions(file: string = DISTRIBUTION_PATH): string[] {
  const required = DistributionConfigSchema.parse(parseJson(fs.readFileSync(file, "utf8")), "distribution").requiredProfileExtensions;
  if (!required?.length) throw new Error(`${file} names no requiredProfileExtensions`);
  return required;
}

const CHANNEL = /^(latest|next|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/;

export function isChannel(value: unknown): value is string {
  return typeof value === "string" && CHANNEL.test(value);
}

// --- git sources -------------------------------------------------------------------------
// pi writes git packages as `git:<host>/<path>[@ref]`, `git:git@<host>:<path>[@ref]` or a
// protocol URL. Its package identity is host + path, ignoring the ref (see
// node_modules/@earendil-works/pi-coding-agent/dist/utils/git.js), and so is ours.

/** A parsed git source. `repo` is what git clones; `key` is host/path; `ref` is the pinned ref, if any. */
export interface GitSource {
  repo: string;
  ref: string | null;
  key: string;
}

/** {repo, ref, key} of a git source, or null. */
export function parseGitSource(source: unknown): GitSource | null {
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  const hasPrefix = trimmed.startsWith("git:");
  const url = hasPrefix ? trimmed.slice(4).trim() : trimmed;
  if (!hasPrefix && !/^(https?|ssh|git):\/\//i.test(url)) return null;
  let host: string;
  let rest: string;
  let rebuild: (p: string) => string;
  const scp = url.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    const [, scpHost = "", scpRest = ""] = scp;
    host = scpHost;
    rest = scpRest;
    rebuild = (p) => `git@${scpHost}:${p}`;
  } else if (/^[a-z]+:\/\//i.test(url)) {
    const m = url.match(/^([a-z]+:\/\/[^/]+)\/(.+)$/i);
    if (!m) return null;
    const [, origin = "", urlRest = ""] = m;
    host = origin.replace(/^[a-z]+:\/\/(?:[^@/]+@)?/i, "").replace(/:\d+$/, "");
    rest = urlRest;
    rebuild = (p) => `${origin}/${p}`;
  } else {
    const slash = url.indexOf("/");
    if (slash < 0) return null;
    host = url.slice(0, slash);
    rest = url.slice(slash + 1);
    const bareHost = host;
    rebuild = (p) => `https://${bareHost}/${p}`;
  }
  const at = rest.indexOf("@");
  const repoPath = (at < 0 ? rest : rest.slice(0, at)).replace(/\.git$/, "").replace(/\/+$/, "");
  const ref = at < 0 ? null : rest.slice(at + 1) || null;
  if (!host || repoPath.split("/").length < 2) return null;
  return { repo: rebuild(repoPath), ref, key: `${host.toLowerCase()}/${repoPath.toLowerCase()}` };
}

/** Refuse malformed previous-source metadata wherever distribution metadata is consumed. */
export function validatePreviousSources(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error("distribution.git.previousSources must be an array of git sources");
  for (const [index, source] of value.entries()) {
    if (typeof source !== "string" || !parseGitSource(source)) {
      throw new Error(`distribution.git.previousSources[${index}] must be a git source`);
    }
  }
}

/** A former public delivery, matched by repository rather than transport or ref. */
export function isPreviousGitSource(source: unknown, previousSources: readonly string[]): boolean {
  const key = parseGitSource(source)?.key;
  return Boolean(key && previousSources.some((previous) => parseGitSource(previous)?.key === key));
}

/** True when `source` (any ref, any URL form) is one of the retired private sources in `legacySources` (host/path keys). */
export function isLegacyGitSource(source: unknown, legacySources: readonly string[] = []): boolean {
  const key = parseGitSource(source)?.key;
  return Boolean(key && legacySources.some((legacy) => legacy.toLowerCase() === key || legacy === `sha256:${createHash("sha256").update(key).digest("hex")}`));
}

/** The settings source for a git ref: `null` (next) is the unpinned repository, otherwise `<repo>@<ref>`. */
export function gitSourceFor(baseSource: string, ref: string | null | undefined): string {
  const parsed = parseGitSource(baseSource);
  const base = parsed?.ref ? baseSource.slice(0, baseSource.length - parsed.ref.length - 1) : baseSource;
  return ref ? `${base}@${ref}` : base;
}

/** Release versions from `git ls-remote --tags` output (`<sha>\trefs/tags/v1.2.3`). */
export function releaseTags(lsRemoteOutput: string, tagPrefix = "v"): string[] {
  const versions = new Set<string>();
  for (const line of lsRemoteOutput.split(/\r?\n/)) {
    const tag = line.match(/\trefs\/tags\/(.+?)(\^\{\})?$/)?.[1];
    if (!tag?.startsWith(tagPrefix)) continue;
    const version = tag.slice(tagPrefix.length);
    if (parseSemver(version)) versions.add(version);
  }
  return [...versions].sort(compareSemver);
}

/** The `latest` release among versions: the newest stable one, or the newest prerelease before any stable exists. */
export function latestRelease(versions: readonly string[]): string | null {
  const stable = versions.filter((v) => {
    const parsed = parseSemver(v);
    if (!parsed) throw new Error(`not semver: ${v}`);
    return !parsed.prerelease;
  });
  const pool = stable.length ? stable : versions;
  return [...pool].sort(compareSemver).at(-1) ?? null;
}

/** Channel implied by a registered git source when nothing else records it. */
export function channelOfGitSource(source: unknown, tagPrefix = "v"): string {
  const ref = parseGitSource(source)?.ref;
  if (!ref) return "next";
  return ref.startsWith(tagPrefix) && parseSemver(ref.slice(tagPrefix.length)) ? "latest" : ref;
}

/** `git ls-remote --tags` against a repository (uses the user's own git credentials). */
export function lsRemoteTags(repo: string, run = (args: string[]): string => execFileSync("git", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })): string {
  return run(["ls-remote", "--tags", repo]);
}
