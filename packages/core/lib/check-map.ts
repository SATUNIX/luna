/**
 * Changed-path -> check map: which acceptance checks a diff implies.
 *
 * Why this exists: a cycle's own verify list was assembled by hand, so a check the host gate runs
 * on the same files could go unrun until the gate rejected the cycle, making its reds invisible
 * until too late. This table makes the mapping data, not prose, so `check-all --for-changed` can
 * print the checks a diff implies and a cycle can name every RAN and SKIPPED check in `verify.md`.
 *
 * The glob dialect is `**` (any number of path segments, including none), `*` (within one
 * segment) and `?` (one character); everything else is literal. It mirrors the matcher in
 * packages/autonomy/lib/glob.ts, kept self-contained here because core must not depend on autonomy.
 * Every check named below must exist in the root package.json `scripts`; the smoke test pins that.
 *
 * Besides the table, a changed file that a check script directly runs (a test file) plans that
 * check too, so a diff cannot break a check and not name it: `scriptTargets` (lib/wiring.ts) maps
 * each file to the scripts that run it. Only names in the check namespace are added, so the table
 * stays the data spine. A byte-copy pair is still a table row: the copying is an assertion, not a
 * script run, so no script names the two source files.
 */
import { scriptTargets } from "./wiring.ts";

/** Name prefixes that make a package.json script a check (`smoke:`, `test:`). */
export const CHECK_NAME_PREFIXES: readonly string[] = ["smoke:", "test:"];

/** Whole names check-all runs that no prefix covers. */
export const CHECK_NAME_EXACT: readonly string[] = ["verify", "eval", "docs:check", "docs:mermaid", "profile:check"];

/** True when `name` names a check check-all runs (`smoke:*` / `test:*` / an exact check). */
export function isCheckName(name: string): boolean {
  return CHECK_NAME_PREFIXES.some((prefix) => name.startsWith(prefix)) || CHECK_NAME_EXACT.includes(name);
}

/** One changed-path rule: paths matching `glob` need `checks` (all matching rules contribute). */
export interface CheckRule {
  readonly glob: string;
  readonly checks: readonly string[];
}

/** Changed-path rules. A path may match several rows; the union of their checks is the plan. */
export const CHANGED_PATH_CHECKS: readonly CheckRule[] = [
  { glob: "packages/extensions/third_party/**", checks: ["verify", "smoke:new-extension", "smoke:eval-footprint", "smoke:subagent-roles-isolation", "smoke:workflow-notify"] },
  // smoke:workflow-notify asserts the fence functions in third_party are byte-identical to both
  // source copies, so a change to either source side must plan it (tests/workflow-notify-smoke.ts).
  { glob: "packages/extensions/src/secret-guard/**", checks: ["smoke:secret-guard", "smoke:workflow-notify"] },
  { glob: "packages/autonomy/lib/templates/common.ts", checks: ["smoke:workflow-notify"] },
  { glob: "packages/extensions/**", checks: ["smoke:new-extension", "verify"] },
  { glob: "packages/core/eval/**", checks: ["smoke:eval-footprint"] },
  { glob: "packages/kit/**", checks: ["verify", "smoke:autonomy-selfimprove"] },
  { glob: "docs/**", checks: ["docs:check", "smoke:docs"] },
  { glob: "**/*.md", checks: ["smoke:docs"] },
  { glob: "packages/autonomy/**", checks: ["smoke:autonomy", "smoke:autonomy-run", "smoke:autonomy-selfimprove"] },
  { glob: "packages/core/check-all.ts", checks: ["smoke:check-all-npm", "smoke:docs"] },
  { glob: "packages/core/lib/**", checks: ["smoke:check-all-npm", "smoke:docs"] },
  { glob: "packages/core/install.ts", checks: ["smoke:install-marker", "smoke:install-filter", "smoke:profile-transaction"] },
  { glob: "packages/core/coverage.ts", checks: ["smoke:check-all-npm"] },
  // CI policy: the workflow policy check pins ci.yml itself and every other workflow, while the
  // settings and ownership checks pin their own .github files (tests/workflow-policy-smoke.ts,
  // tests/github-settings-check-smoke.ts, tests/codeowners-coverage-smoke.ts).
  { glob: ".github/workflows/**", checks: ["smoke:workflow-policy", "smoke:release-workflow"] },
  { glob: ".github/expected-settings.json", checks: ["smoke:workflow-policy", "smoke:github-settings-check"] },
  { glob: ".github/CODEOWNERS", checks: ["smoke:codeowners-coverage"] },
];

/** Checks every change must run, whatever paths it touches. */
export const ALWAYS_CHECKS: readonly string[] = ["verify", "test:typecheck", "test:lint"];

/** True when one path segment matches one glob segment (literals, `*` any run, `?` one char). */
function segmentMatches(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let star = -1;
  let starText = 0;
  while (ti < text.length) {
    const c = pattern[pi];
    if (c === "?") {
      pi++;
      ti++;
    } else if (c === "*") {
      star = pi;
      starText = ti;
      pi++;
    } else if (c !== undefined && c === text[ti]) {
      pi++;
      ti++;
    } else if (star !== -1) {
      pi = star + 1;
      starText++;
      ti = starText;
    } else return false;
  }
  while (pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

/** True when `path` matches `glob`, with `**` as a whole segment matching zero or more segments. */
function globMatches(glob: string, path: string): boolean {
  const g = glob.split("/");
  const p = path.split("/");
  const matchFrom = (gi: number, pi: number): boolean => {
    if (gi === g.length) return pi === p.length;
    if (g[gi] === "**") {
      for (let skip = pi; skip <= p.length; skip++) if (matchFrom(gi + 1, skip)) return true;
      return false;
    }
    const segment = p[pi];
    return segment !== undefined && segmentMatches(g[gi] ?? "", segment) && matchFrom(gi + 1, pi + 1);
  };
  return matchFrom(0, 0);
}

/** A repository-relative, `/`-separated path: strip backslashes and a leading `./`. */
const normalisePath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * The checks a set of changed paths implies: `ALWAYS_CHECKS` plus the checks of every matching
 * row, de-duplicated and sorted. A path matching no row contributes only the always checks.
 *
 * When `scripts` (package.json `scripts`) is given, a changed file that a check script runs
 * directly (`scriptTargets`) contributes that check too, so a changed test file plans the check
 * that runs it. Only names in the check namespace are added; the table remains the spine.
 */
export function checksForChangedPaths(paths: readonly string[], scripts?: Readonly<Record<string, unknown>>): string[] {
  const out = new Set<string>(ALWAYS_CHECKS);
  const targets = scripts === undefined ? null : scriptTargets(scripts);
  for (const raw of paths) {
    const p = normalisePath(raw);
    for (const rule of CHANGED_PATH_CHECKS) if (globMatches(rule.glob, p)) for (const name of rule.checks) out.add(name);
    if (targets !== null) for (const name of targets.get(p) ?? []) if (isCheckName(name)) out.add(name);
  }
  return [...out].sort();
}

/**
 * Split the checks a change implies from the rest of `knownChecks`: `run` is the sorted
 * intersection, `skipped` the sorted remainder. The two are disjoint and together cover
 * `knownChecks`, so a caller can print one RAN/SKIPPED line per known check. When `scripts` is
 * given it is forwarded to `checksForChangedPaths` so a changed test file plans its own check.
 */
export function verifyPlan(paths: readonly string[], knownChecks: readonly string[], scripts?: Readonly<Record<string, unknown>>): { run: string[]; skipped: string[] } {
  const planned = new Set(checksForChangedPaths(paths, scripts));
  const known = [...new Set(knownChecks)].sort();
  const run = known.filter((name) => planned.has(name));
  const runSet = new Set(run);
  const skipped = known.filter((name) => !runSet.has(name));
  return { run, skipped };
}
