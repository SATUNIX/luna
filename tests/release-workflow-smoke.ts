#!/usr/bin/env node
/**
 * Static checks on the GitHub workflows: a dry run of the release workflow cannot publish or
 * release anything, untrusted pull-request code never gets publishing credentials, and the
 * functional gate runs on pull requests.
 *
 * The workflows are YAML, and the repository deliberately has no YAML dependency, so this reads
 * the small subset the workflows use: top-level keys, jobs at two-space indent, and `if:` /
 * `permissions:` / `on:` lines. It is a structural guard, not a general YAML parser: a workflow
 * that stops fitting this shape fails the test loudly rather than passing by accident.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const read = (name: string): string => fs.readFileSync(path.join(WORKFLOWS, name), "utf8");

/** Job name -> job text, for the two-space-indented job keys under `jobs:`. */
export function parseJobs(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, "workflow has a top-level `jobs:` block");
  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // next top-level key
    const name = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)?.[1];
    if (name !== undefined) {
      current = name;
      jobs.set(current, []);
    } else if (current) jobs.get(current)?.push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join("\n")]));
}

/** The trigger names under the top-level `on:` key. */
export function triggers(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^(on|"on"):\s*$/.test(l));
  assert.ok(start >= 0, "workflow has a top-level `on:` block");
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const name = line.match(/^ {2}([A-Za-z_]+):/)?.[1];
    if (name !== undefined) out.push(name);
  }
  return out;
}

// Anything that changes the world outside the runner.
const SIDE_EFFECTS: Array<[pattern: RegExp, label: string]> = [
  [/\bnpm publish\b(?!.*--dry-run)/, "npm publish without --dry-run"],
  [/\bgh release (create|edit|upload|delete)\b/, "gh release"],
  [/\bgit (push|tag)\b/, "git push/tag"],
  [/\bgh api\b.*(-X|--method)\s+(POST|PUT|PATCH|DELETE)/, "mutating gh api call"],
  [/\bcontents:\s*write\b/, "contents: write"],
  [/\bid-token:\s*write\b/, "id-token: write"],
  [/secrets\.NPM_TOKEN/, "the npm token"],
];

// Command and permission lines only: comments and step `name:` labels may mention these words.
const isCode = (line: string): boolean => !line.trim().startsWith("#") && !/^\s*(-\s+)?name:/.test(line);
const sideEffectsOf = (text: string): string[] => SIDE_EFFECTS.filter(([re]) => text.split(/\r?\n/).some((l) => isCode(l) && re.test(l))).map(([, label]) => label);

const tests: Record<string, () => void> = {
  "release workflow only runs by hand": () => {
    const text = read("release.yml");
    assert.deepEqual(triggers(text), ["workflow_dispatch"], "release.yml must not run on push, tag, schedule or pull_request");
    assert.match(text, /dry-run:\s*\n\s+description:[^\n]*\n\s+type: boolean\n\s+default: true/, "the dry-run input defaults to true");
    assert.match(text, /publish-npm:\s*\n\s+description:[^\n]*\n\s+type: boolean\n\s+default: false/, "npm publishing defaults to off");
    assert.match(text, /^permissions:\s*\{\}\s*$/m, "workflow-level permissions are empty; each job asks for what it needs");
  },

  "only the release jobs have side effects, and each needs an explicit non-dry-run": () => {
    const jobs = parseJobs(read("release.yml"));
    const allowed = new Set(["github-release", "npm-publish"]);
    for (const [name, body] of jobs) {
      const effects = sideEffectsOf(body);
      if (!allowed.has(name)) {
        assert.deepEqual(effects, [], `job "${name}" must be side-effect free but has: ${effects.join(", ")}`);
        assert.ok(!/\benvironment:/.test(body), `job "${name}" must not use a deployment environment`);
        continue;
      }
      const guard = body.match(/^ {4}if:\s*(.+)$/m)?.[1] ?? "";
      assert.ok(guard.includes("github.event_name == 'workflow_dispatch'"), `${name}: guarded by the manual event`);
      assert.ok(guard.includes("inputs.dry-run == false"), `${name}: guarded by an explicit inputs.dry-run == false`);
      assert.ok(guard.includes("startsWith(github.ref, 'refs/tags/v')"), `${name}: only from a v* tag`);
      assert.ok(effects.length > 0, `${name} is expected to have side effects`);
    }
    assert.match(jobs.get("npm-publish") ?? "", /inputs\.publish-npm == true/, "npm publishing needs its own explicit opt-in");
    assert.match(jobs.get("npm-publish") ?? "", /environment:\s*\n\s+name: npm/, "npm publishing runs in the `npm` environment");
  },

  "nothing releases unless the full gate and the dry-run plan passed for the same commit (the needs: chain)": () => {
    const jobs = parseJobs(read("release.yml"));
    const needs = (name: string): string[] => {
      const body = jobs.get(name) ?? "";
      const inline = body.match(/^ {4}needs:\s*\[?([^\]\n]+)\]?\s*$/m)?.[1];
      if (inline !== undefined) return inline.split(",").map((s) => s.trim()).filter(Boolean);
      const block = body.match(/^ {4}needs:\s*\n((?: {6}- .+\n?)+)/m)?.[1];
      return block !== undefined ? block.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean) : [];
    };
    assert.match(jobs.get("gate") ?? "", /uses:\s*\.\/\.github\/workflows\/ci\.yml/, "the gate is the same CI workflow every pull request runs, by local path (the same commit)");
    assert.deepEqual(needs("gate"), [], "the gate depends on nothing");
    assert.deepEqual(needs("plan"), ["gate"], "the plan (dry run) waits for the gate");
    assert.deepEqual(needs("github-release"), ["plan"], "creating the release waits for the plan");
    assert.deepEqual(needs("npm-publish"), ["plan"], "publishing waits for the plan");
    // plan needs gate, so both release jobs transitively need it.
  },

  "no job releases or publishes through a third-party action (the side-effect scan reads commands, not actions)": () => {
    // SIDE_EFFECTS matches command lines. A `uses:` of a release, publish or deploy action would slip past it, so none is
    // allowed anywhere: the release is made with `gh release create` and `npm publish` in the two guarded jobs.
    const RELEASING_ACTION = /^\s*(?:-\s*)?uses:\s*\S*(?:release|publish|deploy|upload-release|create-pull-request|build-push|pages)\S*/i;
    for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"))) {
      for (const line of read(file).split(/\r?\n/)) {
        if (isCode(line) && RELEASING_ACTION.test(line)) assert.fail(`${file}: \`${line.trim()}\` is a releasing or publishing action, which the guarded jobs' structure test cannot see`);
      }
    }
  },

  "the dry-run job only ever runs npm publish with --dry-run": () => {
    const plan = parseJobs(read("release.yml")).get("plan") ?? "";
    const publishes = plan.split(/\r?\n/).filter((l) => /\bnpm publish\b/.test(l) && isCode(l));
    assert.ok(publishes.length >= 1, "the plan job exercises npm publish");
    for (const line of publishes) assert.match(line, /--dry-run/, line);
    assert.match(plan, /permissions:\s*\n\s+contents: read/);
  },

  "no workflow can be triggered by untrusted code with write or publishing rights": () => {
    for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"))) {
      const text = read(file);
      const on = triggers(text);
      assert.ok(!on.includes("pull_request_target"), `${file}: pull_request_target runs untrusted code with secrets`);
      if (on.includes("pull_request")) {
        for (const [name, body] of parseJobs(text)) {
          const effects = sideEffectsOf(body).filter((e) => e !== "contents: write");
          assert.deepEqual(effects, [], `${file} job ${name} runs on pull requests and must not publish or push: ${effects.join(", ")}`);
          assert.ok(!/contents:\s*write/.test(body), `${file} job ${name} runs on pull requests and must not have contents: write`);
        }
        const [preamble] = text.split(/\n(?=jobs:)/);
        assert.ok(preamble !== undefined);
        assert.ok(!/^permissions:[\s\S]*?\bwrite\b/m.test(preamble), `${file}: no workflow-level write permission on pull requests`);
      }
    }
  },

  "the functional gate runs on pull requests and on main, with every check": () => {
    const ci = read("ci.yml");
    const on = triggers(ci);
    for (const t of ["push", "pull_request", "workflow_call"]) assert.ok(on.includes(t), `ci.yml triggers on ${t}`);
    assert.ok(!/^\s+paths(-ignore)?:/m.test(ci), "no path filters: a docs-only or workflow-only change still runs the gate");
    assert.match(ci, /npm run -s check:all/);
    assert.match(ci, /python -m mkdocs build --strict/);
    assert.match(ci, /npm run -s security:lockfile/);
    const jobs = parseJobs(ci);
    for (const name of ["verify", "docs-build", "profile-regression", "pi-compat"]) assert.ok(jobs.has(name), `ci.yml has the ${name} job`);
    const security = read("security.yml");
    assert.ok(triggers(security).includes("pull_request"), "security scans run on pull requests");
  },

  "every third-party action is pinned to a full commit SHA": () => {
    for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"))) {
      for (const line of read(file).split(/\r?\n/)) {
        const action = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/)?.[1];
        if (action === undefined || action.startsWith("./")) continue;
        assert.match(action, /@[0-9a-f]{40}$/, `${file}: ${action} is not pinned to a commit SHA`);
      }
    }
  },

  "every container image a job runs in is pinned by digest, and the docs toolchain by version": () => {
    for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"))) {
      for (const line of read(file).split(/\r?\n/)) {
        const image = isCode(line) ? line.match(/^\s*image:\s*(\S+)/)?.[1] : undefined;
        if (image !== undefined) assert.match(image, /@sha256:[0-9a-f]{64}$/, `${file}: image ${image} is a mutable tag; pin it by digest`);
      }
    }
    const req = fs.readFileSync(path.join(ROOT, "requirements-docs.txt"), "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
    assert.ok(req.length > 0, "requirements-docs.txt names the docs toolchain");
    for (const line of req) assert.match(line, /^[A-Za-z0-9_.-]+==[0-9][0-9A-Za-z.+-]*$/, `requirements-docs.txt: "${line}" must be an exact version (the docs build is part of the release gate)`);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${String(error instanceof Error ? error.message || error : error)}`);
  }
}
if (failed) {
  console.error(`\n[release-workflow-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[release-workflow-smoke] all ${Object.keys(tests).length} checks passed`);
