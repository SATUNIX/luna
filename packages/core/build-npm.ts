#!/usr/bin/env node
/**
 * Stage the npm artefact of @satunix/pi-system in dist/npm/ (internal/docs/adr/0001).
 *
 * Source is the runtime everywhere the kit runs from a checkout or a git-delivered install, but Node
 * refuses to strip types under node_modules, which is where an npm install puts the package. So the
 * npm artefact alone is compiled:
 *
 *   1. Copy exactly the files `npm pack` would publish (the package.json `files` set) into the stage.
 *   2. Compile the Node-run TypeScript among them with tsc (`./x.ts` imports become `./x.js`) and
 *      remove those .ts sources from the stage. Extensions stay .ts: pi loads them with its own
 *      loader, including from node_modules.
 *   3. Point the staged package.json's `bin` and `files` at the compiled .js entry points.
 *
 * `npm publish dist/npm` publishes the stage; `smoke:package` and `smoke:clean-install` pack it and
 * run it from a node_modules path, so a missed compile fails the gate.
 *
 * Usage: node packages/core/build-npm.ts [--out <dir>]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { array, isRecord, object, parseJson, parseJsonAs, string } from "./lib/guard.ts";
import { WORKSPACE_ROOT } from "./lib/paths.ts";

const ROOT = WORKSPACE_ROOT;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

/** Code pi loads itself (from node_modules too), so it ships as TypeScript. */
const PI_LOADED = /^packages\/extensions\//;

const PackDryRun = array(object({ files: array(object({ path: string() })) }));

/** The repository-relative paths `npm pack` would publish. */
export function packedFiles(root: string): string[] {
  const out = execFileSync(npmCmd, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32",
  });
  const [pack] = parseJsonAs(PackDryRun, out, "npm pack --dry-run");
  if (!pack) throw new Error("npm pack --dry-run reported no package");
  return pack.files.map((file) => file.path).sort();
}

/** The staged files Node runs that must be compiled: TypeScript outside the pi-loaded trees. */
export function compileSet(files: readonly string[]): string[] {
  return files.filter((file) => /\.(?:ts|mts)$/.test(file) && !file.endsWith(".d.ts") && !PI_LOADED.test(file));
}

export const jsPath = (file: string): string => file.replace(/\.ts$/, ".js").replace(/\.mts$/, ".mjs");

/** Rewrite the staged package.json so `bin` and exact `files` entries name the compiled files. */
export function rewriteManifest(manifest: Record<string, unknown>, compiled: ReadonlySet<string>): Record<string, unknown> {
  const swap = (value: string): string => {
    const rel = value.replace(/^\.\//, "");
    return compiled.has(rel) ? jsPath(value) : value;
  };
  const out: Record<string, unknown> = { ...manifest };
  const { bin, files } = manifest;
  if (typeof bin === "string") out.bin = swap(bin);
  else if (bin !== null && typeof bin === "object" && !Array.isArray(bin)) {
    out.bin = Object.fromEntries(Object.entries(bin).map(([name, target]) => [name, typeof target === "string" ? swap(target) : target]));
  }
  if (Array.isArray(files)) out.files = files.map((entry: unknown) => (typeof entry === "string" ? swap(entry) : entry));
  return out;
}

function tscBin(): string {
  return createRequire(import.meta.url).resolve("typescript/bin/tsc");
}

export function buildNpm(root: string, outDir: string): { files: number; compiled: string[] } {
  const files = packedFiles(root);
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const file of files) {
    const target = path.join(outDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }

  const compiled = compileSet(files);
  if (compiled.length) {
    // Emit into a scratch directory and take only the outputs of the compile set: a type-only import
    // of an extension module would otherwise drop a stray .js beside the extension's .ts.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-build-npm-"));
    try {
      const config = {
        compilerOptions: {
          target: "ES2022", lib: ["ES2023"], module: "NodeNext", moduleResolution: "NodeNext", types: ["node"],
          rewriteRelativeImportExtensions: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true,
          // Type safety is the job of `npm run test:typecheck`; the build only strips and rewrites.
          noCheck: true, skipLibCheck: true, removeComments: false, newLine: "lf",
          rootDir: root, outDir: path.join(work, "out"),
          typeRoots: [path.join(root, "node_modules", "@types")],
        },
        files: compiled.map((file) => path.join(root, file)),
      };
      const tsconfig = path.join(work, "tsconfig.json");
      fs.writeFileSync(tsconfig, JSON.stringify(config));
      execFileSync(process.execPath, [tscBin(), "-p", tsconfig], { cwd: root, stdio: "inherit" });
      for (const file of compiled) {
        const emitted = path.join(work, "out", jsPath(file));
        if (!fs.existsSync(emitted)) throw new Error(`tsc emitted nothing for ${file}`);
        fs.copyFileSync(emitted, path.join(outDir, jsPath(file)));
        fs.rmSync(path.join(outDir, file));
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  const manifestPath = path.join(outDir, "package.json");
  const manifest = parseJson(fs.readFileSync(manifestPath, "utf8"));
  if (!isRecord(manifest)) throw new Error("package.json is not an object");
  fs.writeFileSync(manifestPath, `${JSON.stringify(rewriteManifest(manifest, new Set(compiled)), null, 2)}\n`);
  return { files: files.length, compiled };
}

if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  const at = process.argv.indexOf("--out");
  const outArg = at >= 0 ? process.argv[at + 1] : undefined;
  if (at >= 0 && !outArg) {
    console.error("usage: node packages/core/build-npm.ts [--out <dir>]");
    process.exit(2);
  }
  const outDir = path.resolve(outArg ?? path.join(ROOT, "dist", "npm"));
  const { files, compiled } = buildNpm(ROOT, outDir);
  console.log(`[build-npm] staged ${files} files in ${path.relative(ROOT, outDir) || outDir}; compiled ${compiled.length} to .js`);
}
