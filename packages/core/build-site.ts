#!/usr/bin/env node
/**
 * Assemble the static Luna website (docs/website.md) into an output directory:
 *
 *   <out>/index.html, site.css, favicon.svg   from website/, with {{TAG}} and {{VERSION}} filled
 *                                             from the newest pushed v* tag at or below the
 *                                             package.json version, so the install command on
 *                                             the page always names a tag that exists
 *   <out>/assets/luna-*.svg                   the illustrations from docs/assets
 *   <out>/.nojekyll                           serve the files as they are
 *
 * The documentation is built into <out>/docs by mkdocs afterwards
 * (`python -m mkdocs build --strict --site-dir <out>/docs`), which is what
 * .github/workflows/pages.yml does. The page runs no script; tests/site-smoke.ts checks that, the
 * placeholders and the links between the files.
 *
 *   node packages/core/build-site.ts [--out _site]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { object, parseJsonAs, string } from "./lib/guard.ts";
import { WORKSPACE_ROOT } from "./lib/paths.ts";
import { compareSemver, parseSemver } from "./lib/semver.ts";

export const WEBSITE_DIR = path.join(WORKSPACE_ROOT, "website");

/** The release the page names, and the package.json version still waiting for its tag (null when none is). */
export type SiteRelease = { version: string; tag: string; pending: string | null };

/**
 * The newest pushed release the page may name: the highest `v*` tag at or below the package.json
 * version. A release branch bumps package.json before its tag can exist (the tag must point at the
 * merged commit on main), so naming package.json would publish an install command for a tag that is
 * not there yet; between that merge and the tag push the page keeps the previous release and
 * `pending` names the missing one (docs/releasing.md).
 */
export function pickRelease(packageVersion: string, tags: readonly string[]): SiteRelease {
  if (!parseSemver(packageVersion)) throw new Error(`package.json version ${packageVersion} is not semver`);
  const released = tags
    .map((t) => t.trim())
    .filter((t) => t.startsWith("v") && parseSemver(t.slice(1)) && compareSemver(t.slice(1), packageVersion) <= 0)
    .sort((a, b) => compareSemver(b.slice(1), a.slice(1)));
  const tag = released[0];
  if (!tag) throw new Error(`no v* release tag at or below ${packageVersion}: fetch the tags (actions/checkout fetch-depth: 0) before building the site`);
  const version = tag.slice(1);
  return { version, tag, pending: compareSemver(version, packageVersion) === 0 ? null : packageVersion };
}

/** The `v*` tags merged into HEAD, so a tag on an unmerged branch is never named. */
export function mergedTags(root = WORKSPACE_ROOT): string[] {
  return execFileSync("git", ["-C", root, "tag", "--list", "v*", "--merged", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
}

/** The release the page names, from package.json and the checkout's tags. */
export function release(root = WORKSPACE_ROOT, tags: readonly string[] = mergedTags(root)): SiteRelease {
  const pkg = parseJsonAs(object({ version: string() }), fs.readFileSync(path.join(root, "package.json"), "utf8"), "package.json");
  return pickRelease(pkg.version, tags);
}

/** Fill the page's placeholders; an unknown or unfilled one is an error, never shipped. */
export function fill(text: string, values: Readonly<Record<string, string>>, file: string): string {
  const out = text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`${file}: unknown placeholder ${whole}`);
    return value;
  });
  if (out.includes("{{")) throw new Error(`${file}: an unfilled placeholder remains`);
  return out;
}

/** Every file of the site except the documentation, as published path -> contents. */
export function siteFiles(root = WORKSPACE_ROOT, named: SiteRelease = release(root)): Map<string, string> {
  const { version, tag } = named;
  const out = new Map<string, string>();
  const website = path.join(root, "website");
  // Directory entries carry their type, so nothing is checked and then opened separately.
  for (const entry of fs.readdirSync(website, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    const name = entry.name;
    if (!entry.isFile()) throw new Error(`website/${name}: only flat files are published`);
    const text = fs.readFileSync(path.join(website, name), "utf8");
    out.set(name, name.endsWith(".html") ? fill(text, { TAG: tag, VERSION: version }, `website/${name}`) : text);
  }
  const assets = path.join(root, "docs", "assets");
  for (const name of fs.readdirSync(assets).filter((n) => /^luna-[a-z-]+\.svg$/.test(n)).sort()) out.set(`assets/${name}`, fs.readFileSync(path.join(assets, name), "utf8"));
  out.set(".nojekyll", "");
  return out;
}

/** A directory's entries, or none when it does not exist. */
function listIfPresent(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function main(argv: readonly string[]): number {
  const at = argv.indexOf("--out");
  const out = path.resolve(at >= 0 ? (argv[at + 1] ?? "") : path.join(WORKSPACE_ROOT, "_site"));
  if (at >= 0 && !argv[at + 1]) {
    console.error("usage: node packages/core/build-site.ts [--out <dir>] [--tags <v1,v2,...>]");
    return 2;
  }
  // A fresh directory only: the build never deletes or overwrites what it did not write. The
  // directory is listed once (missing counts as empty), and every file is created with "wx", so a
  // file that appears after this check fails the build instead of being overwritten.
  if (listIfPresent(out).length > 0) {
    console.error(`build-site: ${out} is not empty; remove it first`);
    return 1;
  }
  // --tags replaces the checkout's tags (tests; a shallow CI checkout has none). The pages workflow reads git.
  const tagsAt = argv.indexOf("--tags");
  if (tagsAt >= 0 && !argv[tagsAt + 1]) {
    console.error("usage: node packages/core/build-site.ts [--out <dir>] [--tags <v1,v2,...>]");
    return 2;
  }
  const named = tagsAt >= 0 ? release(WORKSPACE_ROOT, (argv[tagsAt + 1] ?? "").split(",")) : release();
  if (named.pending) {
    const note = `package.json is at ${named.pending} but tag v${named.pending} is not pushed: the site names ${named.tag}. Push the tag, then re-run the pages workflow (docs/releasing.md).`;
    console.log(process.env.GITHUB_ACTIONS === "true" ? `::warning title=Release tag missing::${note}` : `build-site: ${note}`);
  }
  for (const [name, body] of siteFiles(WORKSPACE_ROOT, named)) {
    const file = path.join(out, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { flag: "wx" });
  }
  console.log(`build-site: wrote ${out} (${named.tag}); build the documentation into ${path.join(out, "docs")} with mkdocs`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
