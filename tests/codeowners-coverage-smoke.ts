#!/usr/bin/env node
// CODEOWNERS coverage. Code owner review only protects the paths CODEOWNERS
// names, so the files that decide what CI checks, what ships and what the security layer does are
// listed in CONTROLS below. Every tracked file a control glob matches must be owned by a CODEOWNERS
// rule, matched with GitHub's rules (a leading `/` anchors at the root, a trailing `/` owns a whole
// directory, `*` stays within one path segment, `**` crosses segments, and the last matching rule
// wins, so a later ownerless rule removes ownership). A fixture CODEOWNERS shows the check fails.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Control paths, as CODEOWNERS-style patterns. A file matching one must have an owner. */
export const CONTROLS: readonly string[] = [
  "/.github/", "/.gitleaks.toml", "/.semgrepignore", "/.gitattributes", "/SECURITY.md", "/AGENTS.md", "/CLAUDE.md",
  "/package.json", "/package-lock.json", "/eslint.config.ts", "/tsconfig*.json", "/mkdocs.yml", "/requirements-docs.*",
  "/tests/", "/apps/android/gradle/", "/apps/android/gradlew", "/apps/android/gradlew.bat",
  "/docs/security.md", "/docs/security-level.md", "/docs/ci-security.md", "/docs/supply-chain.md", "/docs/releasing.md", "/docs/repository-topology.md",
  "/docs/security-standard.md", "/docs/security-controls.md", "/docs/threat-model.md", "/docs/vulnerability-management.md",
  "/docs/incident-response.md", "/docs/operator-checklist.md",
  "/packages/core/check-all.ts", "/packages/core/verify.ts", "/packages/core/pack-check.ts", "/packages/core/build-npm.ts",
  "/packages/core/release.ts", "/packages/core/release-notes.ts", "/packages/core/gitlab-release.ts", "/packages/core/publish-plan.ts",
  "/packages/core/profile-check.ts", "/packages/core/lockfile-check.ts", "/packages/core/install.ts", "/packages/core/uninstall.ts",
  "/packages/core/prepush-scan.ts", "/packages/core/lib/leak-scan.ts", "/packages/core/lib/wiring.ts", "/packages/core/lib/profiles.ts",
  "/packages/core/leak-scan-exceptions.json", "/packages/core/scan-suppressions.json", "/packages/core/distribution.json",
  "/packages/core/sources.json", "/packages/core/policies/", "/packages/kit/profiles/",
  "/packages/extensions/src/tool-firewall/", "/packages/extensions/src/secret-guard/", "/packages/extensions/src/delegation-guard/",
  "/packages/web-ui/server/", "/packages/autonomy/", "/packages/container/",
];

function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") { out += ".*"; i++; } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** Whether a CODEOWNERS pattern matches a repository-relative file path. */
export function patternMatches(pattern: string, file: string): boolean {
  const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
  const dir = pattern.endsWith("/");
  const body = globSource(pattern.replace(/^\//, "").replace(/\/$/, ""));
  const re = new RegExp(`${anchored ? "^" : "(?:^|/)"}${body}${dir ? "/" : "(?:$|/)"}`);
  return re.test(file);
}

/** CODEOWNERS rules in file order: pattern and owners (comments and blank lines dropped). */
export function parseCodeowners(text: string): Array<{ pattern: string; owners: string[] }> {
  return text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, "").trim()).filter(Boolean).map((l) => {
    const [pattern = "", ...owners] = l.split(/\s+/);
    return { pattern, owners };
  });
}

/** Owners of a file: the last matching rule's owners, [] when nothing matches. */
export function ownersOf(rules: ReturnType<typeof parseCodeowners>, file: string): string[] {
  let owners: string[] = [];
  for (const r of rules) if (patternMatches(r.pattern, file)) owners = r.owners;
  return owners;
}

/** Control files without an owner; [] when every one is owned. */
export function unowned(codeowners: string, files: readonly string[], controls: readonly string[] = CONTROLS): string[] {
  const rules = parseCodeowners(codeowners);
  return files.filter((f) => controls.some((c) => patternMatches(c, f)) && ownersOf(rules, f).length === 0);
}

const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const codeowners = fs.readFileSync(path.join(ROOT, ".github/CODEOWNERS"), "utf8");
let passed = 0;
const ok = (name: string): void => { passed++; console.log(`  ok  ${name}`); };

// The matcher follows GitHub's rules.
assert.ok(patternMatches("/tests/", "tests/a/b.ts"));
assert.ok(!patternMatches("/tests/", "packages/x/tests/a.ts"), "a leading / anchors at the root");
assert.ok(patternMatches("/tsconfig*.json", "tsconfig.base.json"));
assert.ok(!patternMatches("/tsconfig*.json", "packages/x/tsconfig.json"));
assert.ok(patternMatches("/packages/core/install.ts", "packages/core/install.ts"));
assert.ok(!patternMatches("/packages/core/install.ts", "packages/core/install.tsx"));
assert.ok(patternMatches("*.yml", "a/b/c.yml"), "an unanchored pattern matches at any depth");
assert.ok(patternMatches("/docs/**/x.md", "docs/a/b/x.md"));
assert.deepEqual(ownersOf(parseCodeowners("/a/ @o\n/a/b.ts\n"), "a/b.ts"), [], "a later ownerless rule removes ownership");
ok("the CODEOWNERS matcher anchors, owns directories, globs and lets the last rule win");

const controlled = files.filter((f) => CONTROLS.some((c) => patternMatches(c, f)));
assert.ok(controlled.length > 50, "the control globs match the tracked files");
assert.deepEqual(unowned(codeowners, files), [], "every control file has a code owner");
ok(`all ${controlled.length} tracked control files are owned in .github/CODEOWNERS`);

// A fixture CODEOWNERS without the tests rule, or with an ownerless override, fails.
const withoutTests = codeowners.replace(/^\/tests\/.*\n/m, "");
assert.notEqual(withoutTests, codeowners);
assert.ok(unowned(withoutTests, files).some((f) => f.startsWith("tests/")), "dropping /tests/ leaves tests unowned");
assert.ok(unowned(`${codeowners}\n/packages/core/install.ts\n`, files).includes("packages/core/install.ts"), "an ownerless override is caught");
assert.deepEqual(unowned("/x/ @o\n", ["packages/core/verify.ts", "README.md"]), ["packages/core/verify.ts"], "only control files are required");
ok("a missing rule and an ownerless override are each caught");

console.log(`codeowners-coverage smoke: ${passed} checks passed`);
