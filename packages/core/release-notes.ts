#!/usr/bin/env node
/**
 * Release notes for one version: its CHANGELOG.md section, plus how to install that release
 * with the kit's delivery (packages/core/distribution.json).
 *
 * Usage: node packages/core/release-notes.ts <version> [--out <file>]
 * Exits 1 when CHANGELOG.md has no "## [<version>]" section or the section is empty.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WORKSPACE_ROOT } from "./lib/paths.ts";
import { readDistribution } from "./lib/distribution.ts";

/** The kit's delivery settings, as lib/distribution.ts reads them. */
export type Distribution = ReturnType<typeof readDistribution>;

export interface ReleaseNotesInput {
  changelog: string;
  distribution: Distribution;
}

export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## [${version}]` || l.startsWith(`## [${version}] `));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## \[/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

export function installLines(version: string, distribution: Distribution): string[] {
  if (distribution.delivery === "npm") {
    const pkg = distribution.npm.package;
    return [
      `Install: \`pi install npm:${pkg}@${version}\`, then pick a profile with \`/profile\`.`,
      `Or with a profile in one step: \`npx ${pkg} --channel ${version} --profile balanced\`.`,
    ];
  }
  const tag = `${distribution.git.tagPrefix}${version}`;
  return [
    `Install: \`pi install ${distribution.git.source}@${tag}\`, then start pi (the \`balanced\` profile is applied on first start; \`/profile\` picks another).`,
    `Already installed: \`/update\` in pi, or \`/update channel ${version}\` to pin this release.`,
  ];
}

export function releaseNotes(version: string, { changelog, distribution }: ReleaseNotesInput): string | null {
  const section = changelogSection(changelog, version);
  if (!section) return null;
  return `${section}\n\n${installLines(version, distribution).join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const version = args.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1));
  if (!version) {
    console.error("usage: node packages/core/release-notes.ts <version> [--out <file>]");
    process.exit(2);
  }
  const notes = releaseNotes(version.replace(/^v/, ""), {
    changelog: fs.readFileSync(path.join(WORKSPACE_ROOT, "CHANGELOG.md"), "utf8"),
    distribution: readDistribution(),
  });
  if (!notes) {
    console.error(`[release-notes] CHANGELOG.md has no non-empty "## [${version}]" section`);
    process.exit(1);
  }
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  if (outIdx >= 0) {
    if (out === undefined) {
      console.error("usage: node packages/core/release-notes.ts <version> [--out <file>]");
      process.exit(2);
    }
    fs.writeFileSync(out, notes);
  }
  else process.stdout.write(notes);
}
