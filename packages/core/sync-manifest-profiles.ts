#!/usr/bin/env node
/**
 * Derive each extension manifest's `profiles` array from `packages/kit/profiles/*.json`.
 *
 * A profile's `include` list is the one place an extension is added to a profile; the `profiles`
 * field of its `extension.json` is generated from it (`npm run catalog` runs this first), so adding
 * an extension to a profile is a one-file change. A manifest whose list already names the right
 * profiles is not rewritten, so the command is idempotent and leaves formatting alone.
 *
 *   node packages/core/sync-manifest-profiles.ts           write the arrays that differ
 *   node packages/core/sync-manifest-profiles.ts --check   exit 1 if any array differs, change nothing
 */
import fs from "node:fs";
import path from "node:path";
import { FIRST_PARTY_DIR, THIRD_PARTY_DIR, PROFILES_DIR } from "./lib/paths.ts";
import { listProfiles, loadProfileDef } from "./lib/profiles.ts";
import { isRecord, parseJson } from "./lib/guard.ts";

/** Profile names per extension name, from every profile's include list. */
export function membershipFromProfiles(profilesDir: string = PROFILES_DIR): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const profile of listProfiles(profilesDir)) {
    for (const name of loadProfileDef(profile, profilesDir).include ?? []) {
      const members = out.get(name) ?? [];
      if (!members.includes(profile)) members.push(profile);
      out.set(name, members);
    }
  }
  return out;
}

const PROFILES_FIELD = /("profiles"\s*:\s*)\[[^\]]*\]/;

/** The manifest text with its `profiles` array set to `want`, or null when it already names them. */
export function withProfiles(text: string, want: readonly string[]): string | null {
  const parsed: unknown = parseJson(text);
  const have = isRecord(parsed) && Array.isArray(parsed.profiles) ? parsed.profiles.filter((p): p is string => typeof p === "string") : [];
  const sorted = [...want].sort();
  if (have.length === sorted.length && [...have].sort().every((p, i) => p === sorted[i])) return null;
  if (!PROFILES_FIELD.test(text)) throw new Error('no "profiles" array to rewrite');
  return text.replace(PROFILES_FIELD, `$1[${sorted.map((p) => JSON.stringify(p)).join(", ")}]`);
}

/** Manifest files that need rewriting, with their new text. */
export function pendingManifestChanges(
  roots: readonly string[] = [FIRST_PARTY_DIR, THIRD_PARTY_DIR],
  profilesDir: string = PROFILES_DIR,
): Array<{ file: string; text: string }> {
  const membership = membershipFromProfiles(profilesDir);
  const out: Array<{ file: string; text: string }> = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const file = path.join(root, entry.name, "extension.json");
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      const parsed: unknown = parseJson(text);
      if (!isRecord(parsed) || typeof parsed.name !== "string") continue;
      const next = withProfiles(text, membership.get(parsed.name) ?? []);
      if (next !== null) out.push({ file, text: next });
    }
  }
  return out;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const check = process.argv.includes("--check");
  const pending = pendingManifestChanges();
  for (const { file, text } of pending) {
    if (check) console.error(`[sync-manifest-profiles] ${path.relative(process.cwd(), file)}: profiles differ from packages/kit/profiles/*.json (run npm run catalog)`);
    else fs.writeFileSync(file, text);
  }
  if (!check && pending.length > 0) console.log(`[sync-manifest-profiles] updated ${pending.length} manifest(s) from packages/kit/profiles/*.json`);
  process.exit(check && pending.length > 0 ? 1 : 0);
}
