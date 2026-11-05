#!/usr/bin/env node
/**
 * Assemble the static Luna website (docs/website.md) into an output directory:
 *
 *   <out>/index.html, site.css, favicon.svg   from website/, with {{TAG}} and {{VERSION}} filled
 *                                             from package.json, so the install command on the
 *                                             page always names the current release
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
import { fileURLToPath } from "node:url";
import { object, parseJsonAs, string } from "./lib/guard.ts";
import { WORKSPACE_ROOT } from "./lib/paths.ts";

export const WEBSITE_DIR = path.join(WORKSPACE_ROOT, "website");

/** The release the page names: the version in package.json and its tag. */
export function release(root = WORKSPACE_ROOT): { version: string; tag: string } {
  const pkg = parseJsonAs(object({ version: string() }), fs.readFileSync(path.join(root, "package.json"), "utf8"), "package.json");
  return { version: pkg.version, tag: `v${pkg.version}` };
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
export function siteFiles(root = WORKSPACE_ROOT): Map<string, string> {
  const { version, tag } = release(root);
  const out = new Map<string, string>();
  const website = path.join(root, "website");
  for (const name of fs.readdirSync(website).sort()) {
    const file = path.join(website, name);
    if (!fs.statSync(file).isFile()) throw new Error(`website/${name}: only flat files are published`);
    const text = fs.readFileSync(file, "utf8");
    out.set(name, name.endsWith(".html") ? fill(text, { TAG: tag, VERSION: version }, `website/${name}`) : text);
  }
  const assets = path.join(root, "docs", "assets");
  for (const name of fs.readdirSync(assets).filter((n) => /^luna-[a-z-]+\.svg$/.test(n)).sort()) out.set(`assets/${name}`, fs.readFileSync(path.join(assets, name), "utf8"));
  out.set(".nojekyll", "");
  return out;
}

function main(argv: readonly string[]): number {
  const at = argv.indexOf("--out");
  const out = path.resolve(at >= 0 ? (argv[at + 1] ?? "") : path.join(WORKSPACE_ROOT, "_site"));
  if (at >= 0 && !argv[at + 1]) {
    console.error("usage: node packages/core/build-site.ts [--out <dir>]");
    return 2;
  }
  // A fresh directory only: the build never deletes or overwrites what it did not write.
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
    console.error(`build-site: ${out} is not empty; remove it first`);
    return 1;
  }
  for (const [name, body] of siteFiles()) {
    const file = path.join(out, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { flag: "wx" });
  }
  console.log(`build-site: wrote ${out} (${release().tag}); build the documentation into ${path.join(out, "docs")} with mkdocs`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
