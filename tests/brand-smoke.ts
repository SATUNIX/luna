#!/usr/bin/env node
// Brand smoke: keep the Luna rename honest. Checks the site name, the README title and hero, and
// that every `pi-system` occurrence anywhere in the repository is a deliberate identity whose
// exact form docs/branding.md lists. Each remaining hit is reported as `file:line` only, never the
// matched text (dotenv files can hold secrets).
//
// Scope: the files git tracks at the repository root (an explicit allowlist via `git ls-files`),
// minus the generated/vendored trees (see SKIP_DIRS) and the files never read (see
// SKIP_NAMES/SKIP_FILES). The records under autonomy/ and the generated package-lock.json are
// excluded because their contents are historical or machine-owned, not prose the rename can edit.
// A finding is `file:line` only.
//
// Deterministic; reads files only, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_ROOT } from "../packages/core/lib/paths.ts";

let checks = 0;

function ok(condition: boolean, message: string): void {
  assert.ok(condition, message);
  checks++;
}

function read(relative: string): string {
  return fs.readFileSync(path.join(WORKSPACE_ROOT, relative), "utf8");
}

// A path expressed relative to `root` with POSIX separators.
function rootRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

// Directories never entered, matched by path segment so the rules work for any root: generated
// trees and the agent's own config. The autonomy records under <root>/autonomy are skipped by
// path, so packages/autonomy/ source stays in scope.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "site", ".pi"]);
// Files never read: the lockfile and the changelog are machine-owned history, branding.md defines
// the identities, and this test names every pattern it searches for.
const SKIP_NAMES = new Set(["package-lock.json"]);
const SKIP_FILES = new Set(["CHANGELOG.md", "docs/branding.md", "tests/brand-smoke.ts"]);

// A dotenv file holds runtime secrets and must never be scanned or echoed. `.env.example` is the
// deliberately non-secret template, so it is excluded from this and read normally.
function isDotenvName(name: string): boolean {
  return /^\.env(?:\.|$)/.test(name) && name !== ".env.example";
}

// A file the scan may read: source, config and documentation text. Extensionless container
// scripts and Dockerfiles are named explicitly.
function isTextFile(name: string): boolean {
  if (isDotenvName(name)) return false;
  if (name === "Dockerfile" || name === "pi-agent" || name === "pi-agent-idle") return true;
  if (name === ".env.example") return true;
  return /\.(?:md|ts|js|mjs|json|yml|yaml|sh|ps1|py|html|css|toml|env)$/.test(name);
}

// The named files SKIP_NAMES/SKIP_FILES hold, checked relative to `root`.
function isSkippedFile(root: string, file: string): boolean {
  if (SKIP_NAMES.has(path.basename(file))) return true;
  return SKIP_FILES.has(rootRelative(root, file));
}

// A path the scan never reads, whether it came from the walker or from `git ls-files`: any
// SKIP_DIRS segment, the autonomy records, or a SKIP_NAMES/SKIP_FILES entry.
function isSkippedPath(root: string, file: string): boolean {
  const rel = rootRelative(root, file);
  if (rel === "" || rel === ".." || rel.startsWith("../")) return true;
  const segments = rel.split("/");
  if (segments[0] === "autonomy") return true;
  if (segments.some((segment) => SKIP_DIRS.has(segment))) return true;
  return isSkippedFile(root, file);
}

// Fallback scan used only when git cannot enumerate the tracked files.
function walkText(root: string, out: string[]): void {
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || rootRelative(root, full) === "autonomy") continue;
        visit(full);
      } else if (entry.isFile()) {
        if (isSkippedFile(root, full)) continue;
        if (isTextFile(entry.name)) out.push(full);
      }
    }
  };
  visit(root);
}

// The explicit deterministic allowlist: files git tracks under `root` as absolute paths, or null
// when git is unavailable or the directory is not a repository.
function gitTrackedFiles(root: string): string[] | null {
  try {
    const output = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
    return output
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => path.join(root, entry));
  } catch {
    return null;
  }
}

// The files the scan reads: the tracked allowlist when available, the filesystem walk otherwise,
// then the skip rules and the text-file filter.
function brandFiles(root: string): string[] {
  const tracked = gitTrackedFiles(root);
  const candidates: string[] = [];
  if (tracked !== null) {
    candidates.push(...tracked);
  } else {
    walkText(root, candidates);
  }
  return candidates.filter((file) => !isSkippedPath(root, file) && isTextFile(path.basename(file)));
}

// Deliberate pi-system identities (docs/branding.md). Each pattern names the category it allows;
// removing these from a line must leave no `pi[- ]system` text behind.
const ALLOWED: readonly RegExp[] = [
  // npm package names: @satunix/pi-system and @satunix/pi-system-lite.
  /@satunix\/pi-system(?:-lite)?/gi,
  // bin names: the root `pi-system` command and pi-system-install / pi-system-verify.
  /\bpi-system-(?:install|verify)\b/gi,
  // Install and data paths: /srv/data/pi-system* and /opt/pi-system*.
  /\/srv\/data\/pi-system[\w./-]*/gi,
  /\/opt\/pi-system[\w./-]*/gi,
  // The legacy checkout directory path segment: /opt/pi-system, /srv/data/pi-system,
  // /path/to/pi-system or ../../../pi-system.
  /\/pi-system\b/gi,
  // PI_SYSTEM_* environment variables.
  /\bPI_SYSTEM_[A-Z0-9_]*/g,
  // Compose project and container names: pi-system, pi-system-pi-agent-1 and
  // pi-system-governance-mcp.
  /\bpi-system-(?:pi-agent-1|governance-mcp)\b/gi,
  // The pi-system:local image tag.
  /\bpi-system:local\b/gi,
  // The governance MCP server protocol name and its smoke client (pi-system-governance,
  // pi-system-governance-smoke); the local server key pi_system_governance is derived from it.
  /\bpi-system-governance(?:-smoke)?\b/gi,
  // YAML identity fields: capability id and compose project name (id: pi-system, name: pi-system).
  /\bid:\s*pi-system\b/gi,
  /\bname:\s*pi-system\b/gi,
  // Symbol.for("pi-system.remote-control.*") keys and ids.
  /\bpi-system\.remote-control\.[\w.*-]+/gi,
  // urn:pi-system:* identifiers.
  /\burn:pi-system:[\w.:-]+/gi,
  // CAPABILITY_ID "pi-system" strings (single- or double-quoted).
  /(?:"|')pi-system(?:"|')/gi,
  // The github.com/SATUNIX/pi-system git source.
  /\bgithub\.com\/SATUNIX\/pi-system\b/gi,
  // The backticked or quoted historical identity `pi-system`, as in rename notes and the
  // compose project name.
  /`pi-system`|"pi-system"|'pi-system'/g,
  // Legacy identity regexes: a `pi-system` literal followed by a regex metacharacter inside the
  // matchers that keep recognising the old checkout name (isKitGitSource, remote-version).
  /\bpi-system(?=\$|\()/gi,
  // npm tarball filename: npm pack publishes @satunix/pi-system as satunix-pi-system-<version>.tgz,
  // an external on-the-wire contract (tests/clean-install-smoke.ts).
  /\bsatunix-pi-system-[\d.]+\.tgz\b/gi,
  // Internal temp-directory prefixes: fs.mkdtempSync path values in packages/core/build-npm.ts and
  // packages/core/pack-check.ts. They are scratch paths, not user-facing names; the cycle-20 review
  // (commit c3ca15c) ruled they stay as-is.
  /\bpi-system-(?:build-npm|pack)-/gi,
];

// Scan `root`'s tracked text files for `pi-system` prose outside a deliberate identity. Findings
// carry the file:line only, never the matched or surrounding text.
function scanBrand(root: string): { scanned: string[]; problems: string[] } {
  const scanned = brandFiles(root);

  const problems: string[] = [];
  for (const file of scanned) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      let remainder = line;
      for (const allowed of ALLOWED) remainder = remainder.replace(allowed, "");
      if (/pi[- ]system/i.test(remainder)) {
        problems.push(`${rootRelative(root, file)}:${index + 1}`);
      }
    });
  }
  return { scanned, problems };
}

const mkdocs = read("mkdocs.yml");
ok(/^site_name:\s*Luna\s*$/m.test(mkdocs), "mkdocs.yml sets site_name to Luna");

const readme = read("README.md");
const firstHeading = readme.split(/\r?\n/).find((line) => /^#{1,6}\s/.test(line));
ok(firstHeading === "# Luna", "README.md's first heading is '# Luna'");

const heroLine = readme.split(/\r?\n/).find((line) => /<img\b/i.test(line) && /luna-/i.test(line));
ok(heroLine !== undefined, "README.md has a hero img line naming Luna");
if (heroLine !== undefined) {
  ok(/src="[^"]*docs\/assets\/luna-[^"]*"/i.test(heroLine), "README.md hero img src names Luna");
  ok(/alt="[^"]*Luna[^"]*"/i.test(heroLine), "README.md hero img alt contains Luna");
}

const brandingPath = path.join(WORKSPACE_ROOT, "docs", "branding.md");
ok(fs.existsSync(brandingPath), "docs/branding.md exists");
const branding = fs.readFileSync(brandingPath, "utf8");
for (const identity of ["@satunix/pi-system", "@satunix/pi-system-lite", "pi-system:local", "urn:pi-system:", "CAPABILITY_ID", "previousSources", "CHANGELOG"]) {
  ok(branding.includes(identity), `docs/branding.md names ${identity}`);
}
ok(mkdocs.includes("branding.md"), "mkdocs.yml lists branding.md in its nav");

// The tracked-file scope: every text file git tracks under WORKSPACE_ROOT except the skipped trees
// and files above.
const { scanned, problems } = scanBrand(WORKSPACE_ROOT);
assert.deepEqual(problems, [], `pi-system prose outside a deliberate identity (docs/branding.md):\n${problems.join("\n")}`);
checks++;

ok(scanned.length > 100, "the whole-repository scope reaches beyond the root documentation");
ok(scanned.some((file) => rootRelative(WORKSPACE_ROOT, file) === "packages/core/install.ts"), "the scope includes packages/core/install.ts, outside the old system surfaces");
ok(scanned.some((file) => rootRelative(WORKSPACE_ROOT, file) === "packages/container/capability.yaml"), "the scope includes packages/container text files");

// New: dotenv files must never be scanned or echoed, and the tracked allowlist must ignore
// untracked files. Both cases run in a throwaway temporary git repository.
const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "brand-smoke-"));
try {
  execFileSync("git", ["init", "-q", tempRepo]);
  fs.mkdirSync(path.join(tempRepo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(tempRepo, ".env"), "pi-system secretvalue\n");
  fs.writeFileSync(path.join(tempRepo, ".env.example"), "pi-system\n");
  fs.writeFileSync(path.join(tempRepo, "docs", "probe.md"), "Pi System\n");
  execFileSync("git", ["-C", tempRepo, "add", "--", ".env", ".env.example", "docs/probe.md"]);

  const dotenv = scanBrand(tempRepo);
  const dotenvScanned = dotenv.scanned.map((file) => rootRelative(tempRepo, file));
  ok(!dotenvScanned.includes(".env"), "a dotenv file is never scanned");
  ok(dotenvScanned.includes(".env.example"), ".env.example stays in scope");
  ok(!dotenv.problems.some((problem) => problem.includes("secretvalue")), "a dotenv match never leaks into a finding");
  assert.deepEqual(
    dotenv.problems.filter((problem) => problem.startsWith("docs/probe.md:")),
    ["docs/probe.md:1"],
    "a prose finding is file:line only",
  );
  checks++;

  const before = brandFiles(tempRepo).map((file) => rootRelative(tempRepo, file)).sort();
  fs.writeFileSync(path.join(tempRepo, ".gitignore"), "ignored.md\n");
  execFileSync("git", ["-C", tempRepo, "add", "--", ".gitignore"]);
  fs.writeFileSync(path.join(tempRepo, "ignored.md"), "pi-system\n");
  const after = brandFiles(tempRepo).map((file) => rootRelative(tempRepo, file)).sort();
  assert.deepEqual(after, before, "the tracked-file scope ignores untracked files");
  checks++;
} finally {
  fs.rmSync(tempRepo, { recursive: true, force: true });
}

console.log(`[brand-smoke] all ${checks} checks passed`);
