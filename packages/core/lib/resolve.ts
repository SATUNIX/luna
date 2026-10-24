/**
 * Resolve an extension name to its source location.
 * Multi-source: first-party (src/) → third-party (third_party/) → external (sources.json).
 */
import fs from "node:fs";
import path from "node:path";
import { FIRST_PARTY_DIR, THIRD_PARTY_DIR } from "./paths.ts";
import { readSources, type ExternalSource } from "./sources.ts";

/** Where a name resolved: an in-repo entry file, or the external package that provides it. */
export type Resolution =
  | { avenue: "first-party" | "third-party"; path: string }
  | { avenue: "external"; source: string; mode: ExternalSource["mode"] };

/** A profile name with its resolution, as resolveProfile() returns it. */
export type ResolvedExtension = { name: string } & Resolution;

export function resolve(name: string): Resolution | null {
  const firstParty = path.join(FIRST_PARTY_DIR, name, "index.ts");
  if (fs.existsSync(firstParty)) return { avenue: "first-party", path: firstParty };

  const thirdParty = path.join(THIRD_PARTY_DIR, name, "index.ts");
  if (fs.existsSync(thirdParty)) return { avenue: "third-party", path: thirdParty };

  const sources = readSources();
  const ext = sources.external.find(e => e.provides?.includes(name) || e.name === name);
  if (ext) return { avenue: "external", source: ext.source, mode: ext.mode };

  return null;
}

/**
 * Resolve all names in a profile, error on unresolved or duplicate.
 */
export function resolveProfile(names: readonly string[]): ResolvedExtension[] {
  const seen = new Set<string>();
  return names.map(name => {
    if (seen.has(name)) throw new Error(`Duplicate extension name: ${name}`);
    seen.add(name);
    const result = resolve(name);
    if (!result) throw new Error(`Unresolved extension: ${name}`);
    return { name, ...result };
  });
}
