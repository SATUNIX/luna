#!/usr/bin/env node
/**
 * Compile the console's browser code (internal/docs/adr/0002).
 *
 * Sources live in packages/web-ui/src/ in the same layout they are served from
 * (src/public/js/*.ts -> public/js/*.js, src/mobile/js/*.ts -> mobile/js/*.js,
 * src/mobile/dev/*.ts -> mobile/dev/*.js). tsc strips the types and rewrites `./x.ts` imports to
 * `./x.js`; the output is committed, so serving, the Android build, git delivery and the npm
 * artefact need no build step. Type safety is `npm run test:typecheck`'s job; this only emits.
 *
 * Usage:
 *   node packages/web-ui/build-web.ts           # write the compiled files
 *   node packages/web-ui/build-web.ts --check   # fail if a committed file differs, is missing or is stale
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_UI = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(WEB_UI, "src");
/** Served directories whose .js files are all generated from src/. */
const OUTPUT_DIRS = ["public/js", "mobile/js", "mobile/dev"];

const header = (source: string): string =>
  `// Generated from packages/web-ui/src/${source} by \`npm run build:web\` (internal/docs/adr/0002).\n` +
  "// Edit the TypeScript source, not this file.\n";

/** Compile every source into a scratch directory; returns output path (relative to web-ui) -> contents. */
export function compileBrowser(): Map<string, string> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-build-"));
  try {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    execFileSync(
      process.execPath,
      [tsc, "-p", path.join(SRC, "tsconfig.json"), "--noEmit", "false", "--noCheck", "--outDir", work, "--removeComments", "false", "--newLine", "lf"],
      { stdio: "inherit" },
    );
    const out = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const rel = path.relative(work, full).split(path.sep).join("/");
          const source = rel.replace(/\.js$/, ".ts");
          if (!fs.existsSync(path.join(SRC, source))) throw new Error(`tsc emitted ${rel} with no source`);
          out.set(rel, header(source) + fs.readFileSync(full, "utf8"));
        }
      }
    };
    walk(work);
    return out;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** A file's text, or null when it does not exist (read directly, no exists-then-read race). */
function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** The .js files currently committed in the generated directories (relative to web-ui). */
function committedOutputs(): string[] {
  const found: string[] = [];
  for (const dir of OUTPUT_DIRS) {
    const abs = path.join(WEB_UI, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) if (name.endsWith(".js")) found.push(`${dir}/${name}`);
  }
  return found;
}

if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  const check = process.argv.includes("--check");
  const compiled = compileBrowser();
  const problems: string[] = [];
  for (const [rel, text] of compiled) {
    const target = path.join(WEB_UI, rel);
    const current = readIfPresent(target);
    if (current === text) continue;
    if (check) problems.push(current === null ? `missing: ${rel}` : `out of date: ${rel}`);
    else fs.writeFileSync(target, text);
  }
  for (const rel of committedOutputs()) {
    if (compiled.has(rel)) continue;
    if (check) problems.push(`stale (no source in src/): ${rel}`);
    else fs.rmSync(path.join(WEB_UI, rel));
  }
  if (problems.length) {
    for (const problem of problems) console.error(`[build-web] ${problem}`);
    console.error("[build-web] the committed browser JavaScript does not match src/: run `npm run build:web` and commit the result");
    process.exit(1);
  }
  console.log(`[build-web] ${compiled.size} files ${check ? "match their sources" : "written"}`);
}
