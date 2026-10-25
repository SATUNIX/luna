import fs from "node:fs";
import { array, boolean, isRecord, literal, object, optional, parseJson, string, type Infer } from "./guard.ts";
import { SOURCES_PATH } from "./paths.ts";

/** One companion package in sources.json (mirrors packages/core/schema/sources.schema.json). */
export const ExternalSourceSchema = object({
  name: string(),
  mode: literal("reference", "bundle"),
  source: string(),
  /** Entry path within the installed package, used when embedding it into a generated surface. */
  entry: optional(string()),
  /** Opt-in companions are in no profile and are installed only when their prerequisite exists. */
  optional: optional(boolean()),
  provides: optional(array(string())),
  profiles: optional(array(string())),
  review: optional(string()),
  /** The package's sha512 dist.integrity; the installer compares npm's record with it (lib/companions.ts). */
  integrity: optional(string()),
  /** Set only with the reviewed reason a companion needs its lifecycle scripts; absent means they never run. */
  allowInstallScripts: optional(string()),
});
export type ExternalSource = Infer<typeof ExternalSourceSchema>;

export const SourcesSchema = object({ external: array(ExternalSourceSchema) });
export type Sources = Infer<typeof SourcesSchema>;

// Read packages/core/sources.json, or any similarly-shaped file. A missing file, invalid
// JSON, or a value that is not an object with an `external` array all fall back to the empty
// default `{ external: [] }`, so callers can dereference `external` without a shape guard.
// An `external` array whose entries do not match the schema is a broken registry, not an absent
// one: that throws a ValidationError naming the offending entry.
export function readSources(file: string = SOURCES_PATH): Sources {
  let parsed: unknown;
  try {
    parsed = parseJson(fs.readFileSync(file, "utf8"));
  } catch {
    return { external: [] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.external)) return { external: [] };
  return SourcesSchema.parse(parsed, file);
}

export function getExternalByProfile(profile: string): ExternalSource[] {
  const { external } = readSources();
  return external.filter(e => e.profiles?.includes(profile));
}
