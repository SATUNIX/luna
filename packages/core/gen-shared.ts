#!/usr/bin/env node
/**
 * Generate the copies of the shared security helpers in packages/core/shared/.
 *
 * Extensions are self-contained (CONTRIBUTING.md, "Per-extension contract": no sibling or
 * packages/core imports), and the role-runner image ships without packages/core,
 * so each consumer holds a generated copy of the helper it uses: a fixed header naming the source,
 * then the source byte for byte. One source means one behaviour: a fix lands everywhere at once.
 *
 *   node packages/core/gen-shared.ts           # (re)write every copy
 *   node packages/core/gen-shared.ts --check   # exit 1 when a copy is missing or differs
 *
 * `npm run verify` runs the check (section "shared helper copies"), and
 * tests/redaction-corpus-smoke.ts and tests/workspace-symlink-smoke.ts exercise the copies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SHARED_DIR = "packages/core/shared";

/** Source file in SHARED_DIR -> the repository paths of its generated copies. */
export const SHARED_COPIES: Readonly<Record<string, readonly string[]>> = {
  "safe-fs.ts": [
    "packages/extensions/src/autonomous-loop/shared/safe-fs.ts",
    "packages/extensions/src/branch-lab/shared/safe-fs.ts",
    "packages/extensions/src/conductor/shared/safe-fs.ts",
    "packages/extensions/src/context-sieve/shared/safe-fs.ts",
    "packages/extensions/src/goal-core/shared/safe-fs.ts",
    "packages/extensions/src/guidelines/shared/safe-fs.ts",
    "packages/extensions/src/memory-local/shared/safe-fs.ts",
    "packages/extensions/src/orchestrator/shared/safe-fs.ts",
    "packages/extensions/src/pentest-governance-domain/shared/safe-fs.ts",
    "packages/extensions/src/progress-guard/shared/safe-fs.ts",
    "packages/extensions/src/recovery-orchestrator/shared/safe-fs.ts",
    "packages/extensions/src/save/shared/safe-fs.ts",
    "packages/extensions/src/self-improvement/shared/safe-fs.ts",
    "packages/extensions/src/skill-forge/shared/safe-fs.ts",
    "packages/extensions/src/task-graph/shared/safe-fs.ts",
    "packages/extensions/src/tool-firewall/shared/safe-fs.ts",
    "packages/extensions/src/trace-ledger/shared/safe-fs.ts",
    "packages/extensions/src/verifier-board/shared/safe-fs.ts",
    "packages/extensions/src/verify-gate/shared/safe-fs.ts",
    "packages/extensions/third_party/caveman/shared/safe-fs.ts",
    "packages/extensions/third_party/plan-mode/shared/safe-fs.ts",
    "packages/extensions/third_party/subagent/shared/safe-fs.ts",
    "packages/extensions/third_party/todo/shared/safe-fs.ts",
  ],
  "redact.ts": [
    "packages/extensions/src/memory-mem0/shared/redact.ts",
    "packages/extensions/src/memory-vault/shared/redact.ts",
    "packages/extensions/src/save/shared/redact.ts",
    "packages/extensions/src/tool-firewall/shared/redact.ts",
    "packages/extensions/third_party/subagent/shared/redact.ts",
    "packages/role-runner/src/shared/redact.ts",
  ],
  "kit-source.ts": [
    "packages/extensions/src/remote-control/shared/kit-source.ts",
    "packages/extensions/src/session-helpers/shared/kit-source.ts",
    "packages/extensions/src/web-console/shared/kit-source.ts",
  ],
  "node-runtime.ts": [
    "packages/extensions/src/autonomy-run/shared/node-runtime.ts",
    "packages/extensions/src/kit-update/shared/node-runtime.ts",
    "packages/extensions/src/remote-control/shared/node-runtime.ts",
    "packages/extensions/src/session-helpers/shared/node-runtime.ts",
    "packages/extensions/src/web-console/shared/node-runtime.ts",
    "packages/extensions/third_party/subagent/shared/node-runtime.ts",
  ],
  "inline-guard.ts": [
    "packages/extensions/src/tool-firewall/shared/inline-guard.ts",
    "packages/extensions/third_party/protected-paths/shared/inline-guard.ts",
  ],
  "safe-regex.ts": [
    "packages/extensions/src/skill-router/shared/safe-regex.ts",
    "packages/extensions/third_party/subagent/shared/safe-regex.ts",
  ],
};

/** The exact text a copy of `source` must hold. */
export function expectedCopy(source: string, sourceText: string): string {
  return `// GENERATED from ${SHARED_DIR}/${source} by packages/core/gen-shared.ts. Do not edit this copy:\n// change the source and run \`npm run gen:shared\` (\`npm run verify\` fails when a copy differs).\n${sourceText}`;
}

/**
 * True when the consumer a copy belongs to is in this tree: the directory holding its `shared/`
 * folder exists. The public export leaves private packages out (internal/public-release/
 * manifest.json), and a copy for a package that is not there is not required.
 */
function consumerPresent(root: string, copy: string): boolean {
  return fs.existsSync(path.dirname(path.dirname(path.join(root, copy))));
}

/** Problems with the copies under `root`: one line per missing or differing copy. */
export function checkSharedCopies(root: string = ROOT): string[] {
  const problems: string[] = [];
  for (const [source, copies] of Object.entries(SHARED_COPIES)) {
    const sourcePath = path.join(root, SHARED_DIR, source);
    if (!fs.existsSync(sourcePath)) {
      problems.push(`${SHARED_DIR}/${source} is missing`);
      continue;
    }
    const want = expectedCopy(source, fs.readFileSync(sourcePath, "utf8"));
    for (const copy of copies) {
      if (!consumerPresent(root, copy)) continue;
      const file = path.join(root, copy);
      const have = readIfPresent(file);
      if (have === null) problems.push(`${copy} is missing (run npm run gen:shared)`);
      else if (have !== want) problems.push(`${copy} differs from ${SHARED_DIR}/${source} (run npm run gen:shared)`);
    }
  }
  return problems;
}

/** The file's text, or null when it does not exist (one read, no separate existence check). */
function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function writeSharedCopies(root: string = ROOT): number {
  let written = 0;
  for (const [source, copies] of Object.entries(SHARED_COPIES)) {
    const want = expectedCopy(source, fs.readFileSync(path.join(root, SHARED_DIR, source), "utf8"));
    for (const copy of copies) {
      if (!consumerPresent(root, copy)) continue;
      const file = path.join(root, copy);
      if (readIfPresent(file) === want) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, want);
      written++;
    }
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const problems = checkSharedCopies();
    for (const p of problems) console.error(`gen-shared: ${p}`);
    if (problems.length) process.exit(1);
    console.log("gen-shared: every copy matches its source");
  } else {
    const n = writeSharedCopies();
    console.log(`gen-shared: ${n} ${n === 1 ? "copy" : "copies"} written`);
  }
}
