#!/usr/bin/env node
/**
 * Package-contents gate for the single published package, @satunix/pi-system.
 *
 * Builds the npm artefact (`build-npm.ts`, internal/docs/adr/0001), packs it exactly as
 * `npm publish dist/npm` would (`npm pack --json`, no registry, no credentials), unpacks the
 * tarball under a `node_modules/@satunix/pi-system` path (where Node refuses to strip types) and
 * proves the installed copy works on its own:
 *
 *   1. Allowlist holds: every extension, profile, skill, prompt, theme, agent and workflow
 *      is present, and nothing private leaks (tests/, docs/, reviews/, .pi/, dist/, .env
 *      files other than the template, node_modules, the extension _template).
 *   2. Every glob in the `pi` manifest matches at least one packed file, so `pi install
 *      npm:@satunix/pi-system` loads the same resources a checkout does.
 *   3. Every profile resolves against the UNPACKED copy (not the checkout), and the
 *      installer's modules import from it, so `/profile` works after an npm install.
 *   4. Size stays under budget, so an accidental large file fails the build.
 *   5. No Node-run TypeScript is left in the tarball and every `bin` names a packed file, so a
 *      missed compile fails here rather than on a user's machine.
 *
 * Usage:
 *   node packages/core/pack-check.ts            # check
 *   node packages/core/pack-check.ts --keep     # also print the scratch dir and keep it
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildNpm, compileSet, jsPath } from "./build-npm.ts";
import { array, isRecord, number, object, optional, parseJsonAs, record, string, unknownValue } from "./lib/guard.ts";
import { WORKSPACE_ROOT } from "./lib/paths.ts";
import { readDistribution } from "./lib/distribution.ts";
import type * as PathsModule from "./lib/paths.ts";
import type * as ProfilesModule from "./lib/profiles.ts";
import type * as ResolveModule from "./lib/resolve.ts";

type ResolvedExtension = ReturnType<typeof ResolveModule.resolveProfile>[number];
/** A resolved extension that ships inside the package (it has a path; external ones have a source). */
type InPackageExtension = Extract<ResolvedExtension, { path: string }>;

const ROOT = WORKSPACE_ROOT;
const keep = process.argv.includes("--keep");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;

let errors = 0;
const fail = (m: string): void => {
  console.error(`  FAIL: ${m}`);
  errors++;
};
const ok = (m: string): void => console.log(`  OK: ${m}`);

// The root manifest fields this gate checks. The scalar ones stay unknown: checking them is the gate's job.
const ManifestSchema = object({
  name: optional(unknownValue()),
  private: optional(unknownValue()),
  version: optional(unknownValue()),
  publishConfig: optional(unknownValue()),
  repository: optional(unknownValue()),
  pi: optional(record(array(string()))),
  bin: optional(record(string())),
});
// What `npm pack --json` prints for each packed package (the fields read here).
const PackInfoSchema = array(
  object({
    name: string(),
    version: string(),
    filename: string(),
    size: number(),
    unpackedSize: number(),
    files: array(object({ path: string() })),
  }),
);

/** A property of an unknown value, or undefined. */
const prop = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const pkg = parseJsonAs(ManifestSchema, fs.readFileSync(path.join(ROOT, "package.json"), "utf8"), "package.json");
if (pkg.name !== "@satunix/pi-system") fail(`package name is ${String(pkg.name)}, expected @satunix/pi-system`);
if (pkg.private) fail("root package.json is private; it is the published package");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(typeof pkg.version === "string" ? pkg.version : "")) fail(`version "${String(pkg.version)}" is not semver`);
if (prop(pkg.publishConfig, "access") !== "public") fail("publishConfig.access must be public for a scoped package");
// npm provenance only verifies against a public GitHub (or GitLab.com) repository, so the npm
// delivery needs repository.url to point there; git delivery only needs it set.
const delivery = readDistribution().delivery;
// The host of repository.url (`git+https://github.com/owner/repo.git`, `https://...`), compared as a host, not as a substring.
function repositoryHost(url: unknown): string {
  try {
    return new URL(String(url).replace(/^git\+/, "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}
const repositoryUrl = prop(pkg.repository, "url");
if (!repositoryUrl) fail("repository.url is not set");
else if (delivery === "npm" && !["github.com", "www.github.com"].includes(repositoryHost(repositoryUrl))) fail("npm delivery: repository.url must point at the public GitHub repo (npm provenance checks it)");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-pack-"));
try {
  console.log("[pack-check] build-npm + npm pack");
  const stage = path.join(scratch, "stage");
  buildNpm(ROOT, stage);
  const staged = parseJsonAs(ManifestSchema, fs.readFileSync(path.join(stage, "package.json"), "utf8"), "staged package.json");
  const out = execFileSync(npmCmd, ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
    cwd: stage,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const [info] = parseJsonAs(PackInfoSchema, out, "npm pack --json");
  if (!info) throw new Error("npm pack --json reported no package");
  const files = info.files.map((f) => f.path.replace(/\\/g, "/"));
  const fileSet = new Set(files);
  console.log(`  ${info.name}@${info.version}: ${files.length} files, ${info.size} bytes packed, ${info.unpackedSize} unpacked`);

  // 1. Allowlist.
  console.log("\n[pack-check] contents");
  const required = ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md", "packages/core/install.js", "packages/core/sources.json", "packages/core/distribution.json", "packages/core/.env.example"];
  for (const dir of ["packages/extensions/src", "packages/extensions/third_party"]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.startsWith("_") || !fs.existsSync(path.join(ROOT, dir, name, "index.ts"))) continue;
      required.push(`${dir}/${name}/index.ts`, `${dir}/${name}/extension.json`);
    }
  }
  const listed: [dir: string, test: (f: string) => boolean][] = [
    ["packages/kit/profiles", (f) => f.endsWith(".json")],
    ["packages/kit/prompts", (f) => f.endsWith(".md")],
    ["packages/kit/themes", (f) => f.endsWith(".json")],
    ["packages/kit/agents", (f) => f.endsWith(".md")],
    ["packages/kit/workflows", (f) => f.endsWith(".md") || f.endsWith(".js")],
    ["packages/core/lib", (f) => f.endsWith(".ts")],
  ];
  for (const [dir, test] of listed) {
    // Node-run sources are published compiled; data files and extensions as they are.
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(test)) required.push(compileSet([`${dir}/${f}`]).length ? jsPath(`${dir}/${f}`) : `${dir}/${f}`);
  }
  for (const skill of fs.readdirSync(path.join(ROOT, "packages/kit/skills"))) {
    if (fs.existsSync(path.join(ROOT, "packages/kit/skills", skill, "SKILL.md"))) required.push(`packages/kit/skills/${skill}/SKILL.md`);
  }
  const missing = required.filter((f) => !fileSet.has(f));
  if (missing.length) fail(`missing from the tarball: ${missing.join(", ")}`);
  else ok(`${required.length} required files present`);

  const forbidden: [RegExp, string][] = [
    [/^tests\//, "tests"],
    [/^docs\//, "docs"],
    [/^reviews\//, "review records"],
    [/^dist\//, "build output"],
    [/(^|\/)\.pi\//, "pi runtime state"],
    [/(^|\/)node_modules\//, "node_modules"],
    [/(^|\/)\.env(?!\.example$)(\.|$)/, "an env file"],
    [/^packages\/extensions\/src\/_template\//, "the extension template"],
    [/^packages\/container\//, "the container package"],
    [/^packages\/core\/eval\//, "the eval harness"],
    [/^packages\/autonomy\//, "the autonomy runner"],
    [/\.(log|jsonl|pem|key|p12|tgz)$/, "logs, keys or archives"],
  ];
  const leaked = files.filter((f) => forbidden.some(([re]) => re.test(f)));
  if (leaked.length) {
    for (const f of leaked.slice(0, 20)) fail(`should not be published (${forbidden.find(([re]) => re.test(f))?.[1] ?? ""}): ${f}`);
  } else ok("no private or build files");

  if (info.unpackedSize > MAX_UNPACKED_BYTES) fail(`unpacked size ${info.unpackedSize} exceeds the ${MAX_UNPACKED_BYTES} byte budget`);
  else ok(`unpacked size within ${MAX_UNPACKED_BYTES / 1024 / 1024} MB budget`);

  // 2. Every pi manifest glob matches something that was packed.
  console.log("\n[pack-check] pi manifest");
  // `**` crosses directories, `*` does not.
  const globToRe = (glob: string): RegExp =>
    new RegExp(`^${glob.split("**").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join(".*")}$`);
  for (const [kind, globs] of Object.entries(pkg.pi ?? {})) {
    for (const glob of globs) {
      if (glob.startsWith("!")) continue;
      const re = globToRe(glob);
      const count = files.filter((f) => re.test(f)).length;
      if (count === 0) fail(`pi.${kind} glob "${glob}" matches no packed file`);
      else ok(`pi.${kind} ${glob}: ${count}`);
    }
  }

  const uncompiled = compileSet(files);
  if (uncompiled.length) fail(`Node-run TypeScript left in the tarball (Node will not strip it under node_modules): ${uncompiled.slice(0, 10).join(", ")}`);
  else ok("no Node-run TypeScript in the tarball (extensions stay .ts for pi's loader)");

  // 3. The unpacked copy, installed where npm would put it, resolves every profile on its own.
  console.log("\n[pack-check] installed copy");
  const installed = path.join(scratch, "project", "node_modules", "@satunix", "pi-system");
  fs.mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(scratch, info.filename), "-C", installed, "--strip-components=1"]);
  const lib = (name: string): string => pathToFileURL(path.join(installed, "packages", "core", "lib", name)).href;
  // The installed copy's own modules, which have the same shape as the checkout's.
  const [{ resolveProfile }, { listProfiles, loadProfileDef, excludedSkills, normalizeOverrides }, paths] = await Promise.all([
    import(lib("resolve.js")) as Promise<typeof ResolveModule>,
    import(lib("profiles.js")) as Promise<typeof ProfilesModule>,
    import(lib("paths.js")) as Promise<typeof PathsModule>,
  ]);
  if (paths.WORKSPACE_ROOT !== installed) fail(`installed copy resolves its root to ${paths.WORKSPACE_ROOT}, not ${installed}`);
  const profilesDir = path.join(installed, "packages", "kit", "profiles");
  const profiles = listProfiles(profilesDir);
  for (const name of profiles) {
    try {
      const def = loadProfileDef(name, profilesDir);
      const resolved = resolveProfile(def.include ?? []);
      const inPackage = resolved.filter((r: ResolvedExtension): r is InPackageExtension => r.avenue !== "external");
      const absent = inPackage.filter((r: InPackageExtension) => !fs.existsSync(r.path) || !r.path.startsWith(installed));
      if (absent.length) fail(`profile ${name}: extensions not in the installed copy: ${absent.map((r: InPackageExtension) => r.name).join(", ")}`);
      excludedSkills(def, normalizeOverrides({}));
      ok(`profile ${name}: ${inPackage.length} extensions + ${resolved.length - inPackage.length} companions resolve from the package`);
    } catch (error) {
      fail(`profile ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Every relative import in the compiled files names a packed file (a .ts specifier tsc failed to
  // rewrite, or a module left out of `files`, would only fail when that code path runs).
  const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
  const unresolved: string[] = [];
  for (const file of files.filter((f) => f.endsWith(".js") && !f.startsWith("packages/web-ui/public/"))) {
    // Comment lines are skipped: JSDoc `import("./x.ts")` types are not module loads.
    const text = fs.readFileSync(path.join(installed, file), "utf8").split("\n").filter((line) => !/^\s*(?:\*|\/\*|\/\/)/.test(line)).join("\n");
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? "";
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!fileSet.has(target)) unresolved.push(`${file} -> ${spec}`);
    }
  }
  if (unresolved.length) fail(`relative imports that name no packed file: ${unresolved.slice(0, 10).join(", ")}`);
  else ok("every relative import in the compiled files resolves inside the package");
  for (const entry of ["packages/web-ui/server/server.js", "packages/web-ui/server/remote-host.js", "packages/web-ui/server/remote-cli.js"]) {
    if (!fileSet.has(entry)) fail(`${entry} is not in the tarball`);
    else execFileSync(process.execPath, ["--check", path.join(installed, entry)]);
  }
  ok("the console and remote-control entry points are compiled and parse");
  const help = execFileSync(process.execPath, ["--check", path.join(installed, "packages", "core", "install.js")], { encoding: "utf8" });
  if (help.trim()) console.log(help.trim());
  ok("installer parses in the installed copy");
  if (staged.bin && !Object.values(staged.bin).every((b) => fileSet.has(b.replace(/^\.\//, "")))) fail("a bin entry is not in the tarball");
  else ok("every bin entry is in the tarball");
} catch (error) {
  // execFileSync attaches the child's stderr (a string or Buffer) to its error.
  const stderr = prop(error, "stderr");
  const stderrText = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : "";
  const message = prop(error, "message");
  fail(stderrText || (typeof message === "string" ? message : "") || String(error));
} finally {
  if (keep) console.log(`\n[pack-check] scratch kept at ${scratch}`);
  else fs.rmSync(scratch, { recursive: true, force: true });
}

if (errors) {
  console.error(`\n[pack-check] FAILED with ${errors} error(s)`);
  process.exit(1);
}
console.log("\n[pack-check] OK");
