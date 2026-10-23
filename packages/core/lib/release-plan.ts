// What a release run has to do, decided from the version asked for, the version the manifests
// already carry and the release tags that exist. It is pure, so tests/release-plan-smoke.ts covers
// every case without git or a working tree.
import { compareSemver, parseSemver } from "./semver.ts";

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

export type ReleasePlan =
  /** `bump`: move every version field to the new version and commit it before tagging. */
  | { ok: true; bump: boolean; newestTag: string | null }
  | { ok: false; reason: string };

/** The newest release tag (`vX.Y.Z`, prerelease-aware) among `tags`, or null when there is none. */
export function newestReleaseTag(tags: readonly string[]): string | null {
  let newest: string | null = null;
  for (const tag of tags) {
    const version = RELEASE_TAG.exec(tag.trim())?.[1];
    if (version === undefined || !parseSemver(version)) continue;
    if (newest === null || compareSemver(version, newest) > 0) newest = version;
  }
  return newest === null ? null : `v${newest}`;
}

/**
 * The plan for releasing `version` when the manifests say `current` and `tags` exist.
 *
 * - A version that is already tagged, or not newer than the newest release tag, is refused.
 * - A version older than `current` is refused: that would be a downgrade.
 * - A version equal to `current` is already in the manifests, either because `--bump-only` wrote
 *   it in a reviewed change or because this is the first release. The run only gates and tags.
 * - A newer version is bumped, committed and tagged.
 */
export function planRelease(version: string, current: string, tags: readonly string[]): ReleasePlan {
  if (!parseSemver(version)) return { ok: false, reason: `${version} is not a semver version` };
  if (!parseSemver(current)) return { ok: false, reason: `package.json version ${current} is not a semver version` };
  if (tags.some((tag) => tag.trim() === `v${version}`)) return { ok: false, reason: `tag v${version} already exists` };
  const newestTag = newestReleaseTag(tags);
  if (newestTag !== null && compareSemver(version, newestTag.slice(1)) <= 0) {
    return { ok: false, reason: `version ${version} is not newer than the latest release ${newestTag}` };
  }
  const order = compareSemver(version, current);
  if (order < 0) return { ok: false, reason: `version ${version} is older than the current ${current}` };
  return { ok: true, bump: order > 0, newestTag };
}
