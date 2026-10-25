#!/usr/bin/env node
// Scan coverage. Every dependency manifest the repository tracks is watched and
// scanned: each npm lockfile, pip requirements file, Gradle build, Dockerfile or Containerfile, and
// compose file that pulls a registry image has a Dependabot entry for its ecosystem and directory;
// OSV scans the whole tree recursively (security.yml, and the GitLab osv-scanner job where that
// file exists); and every lockfile is one `lockfile-check --list` reports, which is the list the
// GitHub and GitLab audit loops walk. A manifest added later fails here until it is covered.
// Mutated copies show each check fails.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverLockfiles } from "../packages/core/lockfile-check.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Dependabot entries: ecosystem -> the directories it watches (leading `/`, no trailing one). */
export function dependabotEntries(yml: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const block of yml.split(/^ {2}- package-ecosystem:/m).slice(1)) {
    const ecosystem = block.match(/^\s*([a-z-]+)/)?.[1] ?? "";
    const dirs = new Set<string>();
    const single = block.match(/^ {4}directory:\s*(\S+)/m)?.[1];
    if (single !== undefined) dirs.add(single);
    const list = block.match(/^ {4}directories:\s*\n((?: {6}- .*\n?)+)/m)?.[1] ?? "";
    for (const m of list.matchAll(/^ {6}- (\S+)/gm)) dirs.add(m[1] ?? "");
    const set = out.get(ecosystem) ?? new Set<string>();
    for (const d of dirs) set.add(d.replace(/(.)\/$/, "$1"));
    out.set(ecosystem, set);
  }
  return out;
}

/** The ecosystem a tracked file belongs to, or null when it is not a dependency manifest. */
export function ecosystemOf(file: string, text: string): string | null {
  const base = path.posix.basename(file);
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return "npm";
  if (/^requirements[^/]*\.txt$/.test(base)) return "pip";
  if (/\.gradle(?:\.kts)?$/.test(base)) return "gradle";
  if (/^(?:Dockerfile|Containerfile)(?:\..+)?$/.test(base)) return "docker";
  // A compose file only needs watching when it pulls a registry image (not a locally built one).
  if (/^(?:docker-)?compose[^/]*\.ya?ml$/.test(base)) return /^\s*image:\s*(?!\$\{)[a-z0-9.-]+[/:]/m.test(text) ? "docker-compose" : null;
  return null;
}

/** The Dependabot directory for a manifest: its own directory, or for Gradle the build root. */
function dependabotDir(file: string, files: ReadonlySet<string>): string {
  let dir = path.posix.dirname(file);
  if (ecosystemOf(file, "") === "gradle") {
    for (let d = dir; d !== "."; d = path.posix.dirname(d)) if (files.has(`${d}/settings.gradle.kts`) || files.has(`${d}/settings.gradle`)) { dir = d; break; }
  }
  return dir === "." ? "/" : `/${dir}`;
}

type Sources = { files: ReadonlyMap<string, string>; dependabot: string; security: string; gitlab: string | null; lockfiles: readonly string[] };

/** Coverage gaps; [] when every manifest is watched and scanned. */
export function problems(src: Sources): string[] {
  const out: string[] = [];
  const entries = dependabotEntries(src.dependabot);
  const names = new Set(src.files.keys());
  for (const [file, text] of src.files) {
    const eco = ecosystemOf(file, text);
    if (eco === null) continue;
    const dir = dependabotDir(file, names);
    if (!entries.get(eco)?.has(dir)) out.push(`${file}: no Dependabot ${eco} entry for ${dir}`);
    if (eco === "npm" && !src.lockfiles.includes(file)) out.push(`${file}: lockfile-check --list does not report it, so no audit loop walks it`);
  }
  if (!/osv-scanner-reusable\.yml@[0-9a-f]{40}[\s\S]*?scan-args:[\s\S]*?--recursive/.test(src.security)) out.push("security.yml: the osv-scanner job does not scan --recursive");
  if (!/locks="\$\(node packages\/core\/lockfile-check\.ts --list\)"\s*\n\s*for lock in \$locks; do[\s\S]*?npm audit --audit-level=high/.test(src.security)) out.push("security.yml: the dependencies job does not audit every lockfile-check --list lockfile");
  if (src.gitlab !== null) {
    if (!/osv-scanner scan source --recursive \.\//.test(src.gitlab)) out.push(".gitlab-ci.yml: the osv-scanner job does not scan --recursive");
    if (!/locks="\$\(node packages\/core\/lockfile-check\.ts --list\)"\s*\n\s*for lock in \$locks; do[\s\S]*?npm audit --audit-level=high/.test(src.gitlab)) out.push(".gitlab-ci.yml: the dependencies job does not audit every lockfile-check --list lockfile");
  }
  return out;
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const files = new Map<string, string>();
for (const f of tracked) if (ecosystemOf(f, "x") !== null || /compose[^/]*\.ya?ml$/.test(f)) files.set(f, read(f));
const src: Sources = {
  files,
  dependabot: read(".github/dependabot.yml"),
  security: read(".github/workflows/security.yml"),
  gitlab: fs.existsSync(path.join(ROOT, ".gitlab-ci.yml")) ? read(".gitlab-ci.yml") : null,
  lockfiles: discoverLockfiles(ROOT),
};
let passed = 0;
const ok = (name: string): void => { passed++; console.log(`  ok  ${name}`); };

const manifests = [...files].filter(([f, t]) => ecosystemOf(f, t) !== null);
assert.ok(manifests.length >= 8, "the manifests were found");
assert.deepEqual(problems(src), []);
ok(`all ${manifests.length} dependency manifests have a Dependabot entry; OSV scans recursively; every lockfile is audited${src.gitlab === null ? "" : " (GitHub and GitLab)"}`);

const dockerFile = manifests.map(([f]) => f).find((f) => ecosystemOf(f, "") === "docker" && src.dependabot.includes(`      - /${path.posix.dirname(f)}\n`)) ?? "";
assert.ok(dockerFile, "a docker manifest listed under a Dependabot directories: entry exists");
const dockerDir = `/${path.posix.dirname(dockerFile)}`;
const firstLock = manifests.find(([f]) => f.endsWith("package-lock.json") && f.includes("/"))?.[0] ?? "";
const mutations: Array<[string, Sources, RegExp]> = [
  ["a new lockfile without Dependabot", { ...src, files: new Map([...files, ["packages/new/package-lock.json", "{}"]]), lockfiles: [...src.lockfiles, "packages/new/package-lock.json"] }, /packages\/new\/package-lock\.json: no Dependabot npm entry/],
  ["a lockfile the audit loop misses", { ...src, lockfiles: src.lockfiles.filter((l) => l !== firstLock) }, /lockfile-check --list does not report it/],
  ["a new Containerfile", { ...src, files: new Map([...files, ["packages/x/Containerfile", "FROM node\n"]]) }, /packages\/x\/Containerfile: no Dependabot docker entry for \/packages\/x/],
  ["a compose file pulling a registry image", { ...src, files: new Map([...files, ["packages/x/compose.yaml", "services:\n  a:\n    image: redis:7\n"]]) }, /no Dependabot docker-compose entry/],
  // The target is a docker manifest this tree has: the public export lacks some private ones.
  ["a dropped Dependabot directory", { ...src, dependabot: src.dependabot.replace(`      - ${dockerDir}\n`, "") }, new RegExp(`${dockerFile.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: no Dependabot docker entry`)],
  ["OSV without --recursive", { ...src, security: src.security.replace(/--recursive\n/, "") }, /osv-scanner job does not scan --recursive/],
  ["an audit loop removed", { ...src, security: src.security.replace('for lock in $locks; do', "for lock in package-lock.json; do") }, /security\.yml: the dependencies job/],
  ["an unchecked lockfile list", { ...src, security: src.security.replace('locks="$(node packages/core/lockfile-check.ts --list)"\n          for lock in $locks; do', "for lock in $(node packages/core/lockfile-check.ts --list); do") }, /security\.yml: the dependencies job/],
];
for (const [label, changed, expected] of mutations) {
  const found = problems(changed);
  assert.ok(found.some((p) => expected.test(p)), `mutation "${label}" is caught (got: ${found.join("; ")})`);
}
assert.equal(ecosystemOf("packages/container/docker-compose.yml", "    image: ${PI_AGENT_IMAGE:-pi-system:local}\n"), null, "a compose file using only a locally built image needs no entry");
ok(`each of ${mutations.length} mutations is caught, and a locally built compose image is not required`);

console.log(`scan-coverage smoke: ${passed} checks passed`);
