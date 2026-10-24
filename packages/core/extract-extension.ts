#!/usr/bin/env node
/**
 * Extract an in-repo extension into a standalone repo-ready package.
 * Usage: node packages/core/extract-extension.ts <name>
 *
 * Output: a staging directory at ../pi-ext-<name>/ ready to git init + push.
 * Next steps printed at the end.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ROOT, FIRST_PARTY_DIR } from "./lib/paths.ts";
import { isRecord, parseJson } from "./lib/guard.ts";
import { parseGitSource, readDistribution } from "./lib/distribution.ts";

const ROOT = WORKSPACE_ROOT;

/**
 * True when `name` is safe to use as a filesystem path segment for an
 * extension: a non-empty string that starts alphanumeric and contains only
 * `[A-Za-z0-9._-]`. `.` and `..` are rejected explicitly. This blocks path
 * separators, absolute paths and parent-directory traversal (B-105).
 */
export function isSafeExtensionName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name === "." || name === "..") return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/**
 * Copy one first-party extension into a standalone staging package.
 *
 * The paths are injectable so a test can exercise the copy against a temp fixture
 * without writing a sibling of the repository root. Returns `{ ok, exitCode, dst }`;
 * on failure it prints the same message the CLI printed before.
 */
export interface ExtractOptions {
  firstPartyDir?: string;
  dstBase?: string;
}

export type ExtractResult = { ok: true; exitCode: 0; dst: string } | { ok: false; exitCode: 1 };

export function extractExtension(name: string | undefined, { firstPartyDir = FIRST_PARTY_DIR, dstBase = path.resolve(ROOT, "..") }: ExtractOptions = {}): ExtractResult {
  if (!name) {
    console.error("Usage: node packages/core/extract-extension.ts <name>");
    return { ok: false, exitCode: 1 };
  }

  // A plain boolean: `name` is already a string here, so the type guard would narrow the failure branch to never.
  const safe: boolean = isSafeExtensionName(name);
  if (!safe) {
    console.error(`invalid extension name: ${name}`);
    return { ok: false, exitCode: 1 };
  }

  const src = path.join(firstPartyDir, name);
  if (!fs.existsSync(src)) {
    console.error(`extensions/${name} not found.`);
    return { ok: false, exitCode: 1 };
  }

  // Validate the source manifest before creating anything. A malformed
  // extension.json must not leave a half-written staging package behind (N1).
  const srcMetaPath = path.join(src, "extension.json");
  let sourceMeta: unknown = null;
  if (fs.existsSync(srcMetaPath)) {
    try {
      sourceMeta = parseJson(fs.readFileSync(srcMetaPath, "utf8"));
    } catch (err) {
      console.error(`invalid extension.json in ${src}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, exitCode: 1 };
    }
  }

  const dst = path.resolve(dstBase, `pi-ext-${name}`);
  if (fs.existsSync(dst)) {
    console.error(`${dst} already exists — remove it first.`);
    return { ok: false, exitCode: 1 };
  }

  fs.mkdirSync(dst, { recursive: true });
  fs.mkdirSync(path.join(dst, "extensions", name), { recursive: true });

  // Copy the whole extension tree, including subdirectories. `conductor` ships
  // agents/, synth/ and validate/, and index.ts imports ./validate/validator.ts,
  // so a top-level-only copy stages a package that cannot load (B-100).
  fs.cpSync(src, path.join(dst, "extensions", name), { recursive: true });

  // Write package.json for standalone package
  const pkg = {
    name: `@gitops/pi-ext-${name}`,
    version: "0.1.0",
    keywords: ["pi-package", "pi-extension"],
    type: "module",
    license: "MIT",
    pi: { extensions: [`extensions/${name}/index.ts`] },
    peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.85.1", typebox: "*" },
  };
  fs.writeFileSync(path.join(dst, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

  // Update homeRepo in extension.json using the object already parsed above
  // (never re-parse the copied manifest unguarded).
  const metaPath = path.join(dst, "extensions", name, "extension.json");
  if (isRecord(sourceMeta)) {
    // A placeholder home for the split-out repository: the kit's own host and owner, which the
    // operator changes if the extension is published elsewhere.
    const repo = parseGitSource(readDistribution().git.source)?.repo ?? "https://github.com/OWNER/pi-system";
    const home = repo.replace(/^https?:\/\//, "").replace(/\/[^/]+$/, "");
    sourceMeta.homeRepo = `git:${home}/pi-ext-${name}`;
    fs.writeFileSync(metaPath, `${JSON.stringify(sourceMeta, null, 2)}\n`);
  }

  console.log(`\nExtracted to: ${dst}`);
  return { ok: true, exitCode: 0, dst };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = extractExtension(process.argv[2]);
  if (!result.ok) process.exit(result.exitCode);
  console.log(`\nNext steps:`);
  console.log(`  1. cd ${result.dst} && git init && git add . && git commit -m "init: extract ${process.argv[2]} from pi-kit"`);
  console.log(`  2. Push it to a git host as pi-ext-${process.argv[2]} (update homeRepo in its extension.json to match)`);
  console.log(`  3. In pi-kit, add to packages/core/sources.json (reference or bundle mode)`);
  console.log(`  4. Remove extensions/${process.argv[2]}/ from this repo`);
  console.log(`  5. Profiles need no change — they still reference the name "${process.argv[2]}"`);
}
