/**
 * Semver precedence for release tooling (no dependency on the `semver` package).
 * Build metadata is ignored; prerelease identifiers compare per the spec
 * (0.2.1-beta.0 < 0.2.1-beta.1 < 0.2.1-beta.10 < 0.2.1).
 */
export const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A parsed version. `prerelease` is the dotted identifier list after `-`, or null for a release. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

/** The version in `v` (trimmed), or null when it is absent or not semver. */
export function parseSemver(v: string | null | undefined): Semver | null {
  const m = SEMVER.exec((v ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

/** Negative, zero or positive as `a` precedes, equals or follows `b`; throws when either is not semver. */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`not semver: ${String(!pa ? a : b)}`);
  for (const k of ["major", "minor", "patch"] as const) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  if (!pa.prerelease || !pb.prerelease) return pa.prerelease ? -1 : pb.prerelease ? 1 : 0;
  const xa = pa.prerelease.split(".");
  const xb = pb.prerelease.split(".");
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
