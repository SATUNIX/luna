// What the host may publish from the run's bare repository to a promotion destination. The container can push
// anything to its bare repo (it has no other remote); only the integration branch
// (experimental/main) and the run's exp/<run>/ tags leave the machine, fast-forward only, with
// the operator's own git credentials on the host. Nothing is ever force-pushed: the cycle's
// working branch, the only branch that moves backwards, stays on this machine.

/** The part of the runtime configuration (lib/runcfg.ts) that decides what is published. */
export interface PublishConfig {
  readonly integrationBranch: string;
  /** exp/<run>/ style prefix of the run's tags. */
  readonly tagPrefix: string;
  readonly publishTags?: boolean | undefined;
}

/** Refspecs to push, from `git for-each-ref` output lines "<sha> <refname>". */
export function publishRefspecs(forEachRef: string, cfg: PublishConfig): string[] {
  const branch = `refs/heads/${cfg.integrationBranch}`;
  const tagPrefix = `refs/tags/${cfg.tagPrefix}`;
  const specs: string[] = [];
  for (const line of forEachRef.split("\n")) {
    const ref = line.trim().split(/\s+/)[1];
    if (!ref) continue;
    if (ref === branch || (cfg.publishTags !== false && ref.startsWith(tagPrefix) && isSafeRefTail(ref.slice(tagPrefix.length)))) specs.push(`${ref}:${ref}`);
  }
  return specs;
}

function isSafeRefTail(tail: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(tail) && !tail.includes("..");
}

/** Receive settings for the run's bare repo: no history rewrites, no deletions from inside. */
export const BARE_REPO_CONFIG: readonly (readonly [string, string])[] = [
  ["receive.denyNonFastForwards", "true"],
  ["receive.denyDeletes", "true"],
  ["receive.fsckObjects", "true"],
];
