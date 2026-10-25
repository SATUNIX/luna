/**
 * Shell idioms that let a failing command pass a CI step. One list, shared by
 * tests/workflow-policy-smoke.ts (GitHub workflows) and tests/gitlab-ci-structure-smoke.ts (the
 * GitLab pipeline), so both pipelines are held to the same fail-closed rule. Each pattern is
 * matched against one non-comment line of a job; each smoke runs mutated copies to show every
 * pattern is caught.
 */
export const FAIL_OPEN_SHELL: ReadonlyArray<readonly [RegExp, string]> = [
  [/\|\|\s*(?:true|:)(?=\s|$|;|\))/, '"|| true" hides a failing command'],
  [/\|\|\s*exit\s+0\b/, '"|| exit 0" turns a failing command into success'],
  [/\|\|\s*echo\b/, '"|| echo" replaces a failing command with output'],
  [/\bset\s+\+[A-Za-z]*e[A-Za-z]*\b|\bset\s+\+o\s+errexit\b/, '"set +e" stops failing commands from failing the step'],
];

/** The fail-open problems in one line of job script, as their messages; [] when it fails closed. */
export function failOpen(line: string): string[] {
  if (line.trim().startsWith("#")) return [];
  return FAIL_OPEN_SHELL.filter(([pattern]) => pattern.test(line)).map(([, message]) => message);
}

/** One benign line per pattern, for the mutation tests: each must be caught by `failOpen`. */
export const FAIL_OPEN_SAMPLES: readonly string[] = ["npm test || true", "npm test || exit 0", "npm test || echo skipped", "set +e"];
