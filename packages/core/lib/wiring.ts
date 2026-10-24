/**
 * Test wiring: which test files does the CI gate actually run?
 *
 * `check-all` enumerates the `smoke:*` / `test:*` scripts in package.json. A test file that no
 * script names is never run, so it can rot (or never have passed) behind a green pipeline. This
 * module finds those files, scripts that point at a file that does not exist, and test files that
 * assert nothing, so a suite that silently does zero work is reported instead of counted as a pass.
 *
 * A test suite is wired when a package.json script names it. A shared helper (a file that is not
 * itself a suite, such as a harness) is wired when a wired file mentions its name. A suite is never
 * wired by being mentioned: comments and docs name other suites all the time, and that must not
 * excuse a suite nobody runs. Files that genuinely cannot run in CI
 * (they need a container engine) are listed in MANUAL_ONLY with the reason, so the exception is
 * visible and reviewed rather than an accident.
 */
import fs from "node:fs";
import path from "node:path";

/** Files that are deliberately not part of check:all, with why. Keys are repo-relative, posix. */
export const MANUAL_ONLY: Readonly<Record<string, string>> = {
  "packages/autonomy/tests/boundary-probe.ts": "needs a container engine (Docker or Podman); run by the operator as the container-boundary check",
  "packages/container/capability/tests/smoke.sh": "needs a container engine and the capability image; run by the operator",
  "packages/container/capability/tests/validate-compose.sh": "needs a container engine (docker compose config); run by the operator",
};

const TEST_DIR = /(^|\/)(tests?|__tests__)\//;
const TEST_EXT = /\.(mjs|cjs|js|ts|mts|sh|py)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".cache", "dist", "site", "coverage"]);
const ASSERTION_MARKS = /\bassert\b|\bthrow new Error\b|process\.exit\(\s*[1-9]|\bexit 1\b|\bset -e\b|\bunittest\b|\bpytest\b/;

// A suite is something a script must run; anything else in a tests/ directory is a helper.
const SUITE = /(?:-smoke|-test|-tests|\.test|\.spec)\.(?:mjs|cjs|js|ts|mts)$|\.(?:sh|py)$/;

const toPosix = (p: string): string => p.split(path.sep).join("/");

/** Every test file under `root`: anything in a `tests/`, `test/` or `__tests__/` directory. */
export function listTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (TEST_EXT.test(entry.name)) {
        const rel = toPosix(path.relative(root, full));
        if (TEST_DIR.test(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Files the scripts run directly: `node x.mjs` / `node x.ts`, `bash x.sh`, `python x.py`, ignoring flags.
 * Returns file -> names of the scripts that run it.
 */
export function scriptTargets(scripts: Readonly<Record<string, unknown>> | undefined): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  const re = /(?:^|[\s&;|(])(?:node|bash|sh|python3?)\s+((?:-{1,2}[^\s]+\s+)*)([^\s&;|)]+\.(?:mjs|cjs|js|ts|mts|sh|py))/g;
  for (const [name, command] of Object.entries(scripts ?? {})) {
    for (const match of String(command).matchAll(re)) {
      const file = (match[2] ?? "").replace(/^\.\//, "");
      const names = targets.get(file);
      if (names) names.push(name);
      else targets.set(file, [name]);
    }
  }
  return targets;
}

export interface WiringOptions {
  /** The repository root the test files are listed from. */
  root: string;
  /** package.json `scripts`. */
  scripts?: Readonly<Record<string, unknown>> | undefined;
  /** Files deliberately left out of check:all, with why (defaults to MANUAL_ONLY). */
  manual?: Readonly<Record<string, string>>;
}

export interface WiringProblems {
  /** Test files no script runs and no wired file mentions. */
  unwired: string[];
  /** Scripts that run a test file that does not exist. */
  missingTargets: { script: string; file: string }[];
  /** Wired suites that assert nothing. */
  noAssertions: string[];
  /** The manual-only exceptions that apply to files present in the tree. */
  manual: { file: string; reason: string }[];
}

export function findWiringProblems({ root, scripts, manual = MANUAL_ONLY }: WiringOptions): WiringProblems {
  const files = listTestFiles(root);
  const targets = scriptTargets(scripts);
  const wired = new Set<string>();
  for (const file of files) if (targets.has(file)) wired.add(file);

  // A helper a wired file mentions by name is wired too (a shared harness). Suites are not.
  const text = new Map<string, string>();
  const read = (file: string): string => {
    let content = text.get(file);
    if (content === undefined) {
      try { content = fs.readFileSync(path.join(root, file), "utf8"); } catch { content = ""; }
      text.set(file, content);
    }
    return content;
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const file of files) {
      if (wired.has(file) || SUITE.test(file)) continue;
      const base = path.posix.basename(file);
      for (const other of wired) {
        if (read(other).includes(base)) { wired.add(file); grew = true; break; }
      }
    }
  }

  const missingTargets: WiringProblems["missingTargets"] = [];
  for (const [file, [script = ""]] of targets) {
    if (!TEST_DIR.test(file) && !/(^|\/)scripts\/.*smoke/.test(file)) continue;
    if (!fs.existsSync(path.join(root, file))) missingTargets.push({ script, file });
  }

  const unwired = files.filter((f) => !wired.has(f) && !(f in manual));
  // Only files a script runs directly are judged: a shared helper asserts nothing by design.
  const noAssertions = [...wired].filter((f) => targets.has(f) && /\.(mjs|cjs|js|ts|mts)$/.test(f) && !ASSERTION_MARKS.test(read(f))).sort();
  const manualUsed = Object.entries(manual)
    .filter(([file]) => files.includes(file))
    .map(([file, reason]) => ({ file, reason }));
  return { unwired, missingTargets, noAssertions, manual: manualUsed };
}

/** One human-readable line per problem (manual-only exceptions are not problems). */
export function describeProblems(problems: Pick<WiringProblems, "unwired" | "missingTargets" | "noAssertions">): string[] {
  const lines: string[] = [];
  for (const f of problems.unwired) lines.push(`unwired test (no package.json script runs it, no wired test mentions it): ${f}`);
  for (const m of problems.missingTargets) lines.push(`script "${m.script}" runs a file that does not exist: ${m.file}`);
  for (const f of problems.noAssertions) lines.push(`test asserts nothing (no assert, throw or non-zero exit): ${f}`);
  return lines;
}
