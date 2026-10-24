#!/usr/bin/env node
/**
 * Decide what a CI publish run publishes: the version and the ONE npm dist-tag it goes to.
 * Used by .github/workflows/release.yml; pure logic lives in planPublish() so it is tested.
 *
 * Channels (see docs/releasing.md):
 *   next     every push to main: a snapshot version (packages/core/snapshot-version.ts).
 *   latest   a pushed vX.Y.Z tag: the newest release. Before the first stable release a
 *            prerelease (vX.Y.Z-beta.N) is also latest, so `pi install npm:@satunix/pi-system`
 *            always gets the newest release. Once a stable release exists, prereleases go
 *            to `beta` and never displace it.
 *   release-X.Y  a stable tag OLDER than the current latest (a maintenance release on an old
 *            line) is published without moving latest backwards.
 *
 * One tag per publish on purpose: npm trusted publishing (OIDC) authorises `npm publish`
 * only, so a second `npm dist-tag add` would need a long-lived token.
 *
 * Usage:
 *   node packages/core/publish-plan.ts --ref refs/tags/v0.2.1-beta.1 --dist-tags '{"latest":"0.2.1-beta.0"}'
 *   node packages/core/publish-plan.ts --ref refs/heads/main --sha <sha> --write
 * Prints `version=...`, `tag=...` lines (append them to $GITHUB_OUTPUT).
 */
import fs from "node:fs";
import path from "node:path";
import { isRecord, parseJson } from "./lib/guard.ts";
import { WORKSPACE_ROOT } from "./lib/paths.ts";
import { compareSemver, parseSemver } from "./lib/semver.ts";
import { readPackageJson, snapshotVersion } from "./snapshot-version.ts";

export interface PublishInput {
  /** The git ref being built (`refs/tags/v1.2.3` or `refs/heads/main`). */
  ref?: string | undefined;
  packageVersion: string;
  /** The package's current npm dist-tags (`npm view <pkg> dist-tags --json`). */
  distTags?: Readonly<Record<string, unknown>>;
  sha?: string | undefined;
  now?: Date;
}

export interface PublishPlan {
  version: string;
  tag: string;
  kind: "release" | "snapshot";
}

export function planPublish({ ref, packageVersion, distTags = {}, sha, now = new Date() }: PublishInput): PublishPlan {
  const tagMatch = /^refs\/tags\/v(.+)$/.exec(ref ?? "");
  if (tagMatch) {
    const version = tagMatch[1] ?? "";
    const parsed = parseSemver(version);
    if (!parsed) throw new Error(`tag v${version} is not a semver version`);
    if (/(^|\.)next(\.|$)/.test(parsed.prerelease ?? "")) throw new Error(`tag v${version} is a snapshot version; snapshots are published from main`);
    if (version !== packageVersion) throw new Error(`tag v${version} does not match package.json version ${packageVersion}; cut releases with npm run release`);
    const { latest: latestTag } = distTags;
    const latest = typeof latestTag === "string" && latestTag && parseSemver(latestTag) ? latestTag : null;
    const latestIsStable = latest !== null && !parseSemver(latest)?.prerelease;
    let tag: string;
    if (parsed.prerelease) tag = latestIsStable ? "beta" : !latest || compareSemver(version, latest) > 0 ? "latest" : "beta";
    else tag = !latest || compareSemver(version, latest) > 0 ? "latest" : `release-${parsed.major}.${parsed.minor}`;
    return { version, tag, kind: "release" };
  }
  if (ref === "refs/heads/main") {
    if (!sha) throw new Error("a main snapshot needs --sha");
    return { version: snapshotVersion(packageVersion, sha, now), tag: "next", kind: "snapshot" };
  }
  throw new Error(`nothing to publish for ref ${String(ref)} (only main and v* tags publish)`);
}

if (process.argv[1]?.endsWith("publish-plan.ts")) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null | undefined => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);
  const pkgPath = path.join(WORKSPACE_ROOT, "package.json");
  const { pkg, version: packageVersion } = readPackageJson(pkgPath);
  try {
    let distTags: Record<string, unknown> = {};
    try {
      const parsed = parseJson(get("--dist-tags") || "{}");
      distTags = isRecord(parsed) ? parsed : {};
    } catch {
      distTags = {};
    }
    const plan = planPublish({ ref: get("--ref") ?? process.env.GITHUB_REF, packageVersion, distTags, sha: get("--sha") ?? process.env.GITHUB_SHA });
    if (args.includes("--write") && plan.version !== packageVersion) {
      pkg.version = plan.version;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
    console.log(`version=${plan.version}`);
    console.log(`tag=${plan.tag}`);
    console.log(`kind=${plan.kind}`);
  } catch (error) {
    console.error(`[publish-plan] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
