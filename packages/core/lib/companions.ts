// Companion installs (packages/core/sources.json): pinned, script-free and integrity-checked.
//
// `pi install npm:<name>@<version>` runs `npm install` in pi's npm root (<agent dir>/npm, or
// <project>/.pi/npm for a project install) with the user's privileges. Without care that runs every
// lifecycle script in the companion's dependency tree, and installs whatever tarball the registry
// serves for the version. So the installer:
//   - passes npm_config_ignore_scripts=true to the `pi install` child (npm, and pnpm, read it), unless
//     the entry records a reviewed reason in `allowInstallScripts`;
//   - after the install, reads the integrity npm recorded for the companion in that root's
//     package-lock.json and compares it with the sha512 pinned in sources.json; on a difference the
//     package is removed again and the install stops, naming both values. A root with no lockfile
//     entry (a pi that installs some other way) is a warning, not a pass.
// tests/companion-integrity-smoke.ts pins each rule.
import fs from "node:fs";
import path from "node:path";
import { isRecord, parseJson } from "./guard.ts";
import type { ExternalSource } from "./sources.ts";

/** An exact `npm:<name>@<version>` companion source, or null for anything else. */
export function npmSpec(source: string): { name: string; version: string } | null {
  const m = /^npm:((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(source);
  const name = m?.[1];
  const version = m?.[2];
  return name !== undefined && version !== undefined ? { name, version } : null;
}

/** A sha512 Subresource Integrity string, as npm records it. */
export const isSha512Integrity = (value: unknown): value is string => typeof value === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value);

/** Extra environment for the `pi install` child of one companion: lifecycle scripts off unless allowed. */
export function companionInstallEnv(entry: Pick<ExternalSource, "allowInstallScripts">): Record<string, string> {
  return entry.allowInstallScripts ? {} : { npm_config_ignore_scripts: "true" };
}

/** Problems with one sources.json entry's install pins (exact npm version, sha512 integrity, script policy). */
export function companionPinProblems(entry: ExternalSource): string[] {
  const problems: string[] = [];
  if (entry.mode !== "reference") return problems;
  if (!npmSpec(entry.source)) problems.push(`${entry.name}: source ${JSON.stringify(entry.source)} is not an exact npm:<name>@<version>`);
  if (!isSha512Integrity(entry.integrity)) problems.push(`${entry.name}: integrity must be the package's sha512 dist.integrity`);
  if (entry.allowInstallScripts !== undefined && entry.allowInstallScripts.trim().length < 20) problems.push(`${entry.name}: allowInstallScripts must give the reviewed reason`);
  return problems;
}

/** pi's npm root for a scope: <agent dir>/npm, or <cwd>/.pi/npm for a project install. */
export const piNpmRoot = (scope: "global" | "project", agentDir: string, cwd: string): string => (scope === "project" ? path.join(cwd, ".pi", "npm") : path.join(agentDir, "npm"));

export type IntegrityCheck = { ok: true; integrity: string } | { ok: false; missing: true; reason: string } | { ok: false; missing?: never; reason: string };

/** Compare what npm recorded in `<npmRoot>/package-lock.json` for the companion with its pin. */
export function checkInstalledIntegrity(npmRoot: string, entry: ExternalSource): IntegrityCheck {
  const spec = npmSpec(entry.source);
  if (!spec) return { ok: false, reason: `${entry.name}: not an exact npm source` };
  if (!isSha512Integrity(entry.integrity)) return { ok: false, reason: `${entry.name}: sources.json pins no sha512 integrity` };
  const lockPath = path.join(npmRoot, "package-lock.json");
  let lock: unknown;
  try {
    lock = parseJson(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return { ok: false, missing: true, reason: `${lockPath} is missing or unreadable, so ${entry.name}'s integrity could not be checked` };
  }
  const packages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
  const key = `node_modules/${spec.name}`;
  const record = Object.hasOwn(packages, key) ? packages[key] : undefined;
  if (!isRecord(record)) return { ok: false, missing: true, reason: `${lockPath} has no entry for ${spec.name}` };
  if (record.version !== spec.version) return { ok: false, reason: `${spec.name}: npm installed ${String(record.version)}, sources.json pins ${spec.version}` };
  if (record.integrity !== entry.integrity) return { ok: false, reason: `${spec.name}@${spec.version}: npm recorded integrity ${String(record.integrity)}, sources.json pins ${entry.integrity}` };
  return { ok: true, integrity: entry.integrity };
}
