#!/usr/bin/env node
// Benign-command corpus for the shipped guard handlers (board item PG-23).
//
// These are real repository commands an agent runs while reading or checking its own
// source. They are read-only or print-only; none reads a credential file or writes a
// protected path. The corpus sends each row through every loaded tool_call handler and
// asserts that each allows it. A failure names the exact command and why it is benign.
//
// The task names `third_party/protected-paths`; the eval harness maps its logical
// `vendor/protected-paths` alias onto that directory, so this uses the alias.
import assert from "node:assert/strict";
import path from "node:path";
import {
  fakePi,
  isolateKitEnv,
  loadExtension,
  setEnv,
  tmpWorkspace,
  rmWorkspace,
  type RegisteredHandler,
} from "../packages/core/eval/harness.ts";

export interface BenignCommand {
  readonly command: string;
  readonly reason: string;
}

export const BENIGN_COMMANDS: readonly BenignCommand[] = [
  { command: "ls packages/extensions/src/secret-guard", reason: "Lists a source directory; ls does not read file contents." },
  { command: "find packages/extensions/src -not -path \"*/node_modules/*\" -name \"*.ts\"", reason: "Read-only source discovery with node_modules excluded." },
  { command: "rg -n \"secret-guard\" packages/extensions/src", reason: "Searches source text for the extension name; no secret file is read." },
  { command: "git status", reason: "Read-only working-tree status." },
  { command: "git log --oneline -5", reason: "Read-only commit history." },
  { command: "git diff --stat", reason: "Read-only diff summary." },
  { command: "git show HEAD --stat", reason: "Read-only commit summary." },
  { command: "git branch --list", reason: "Read-only branch list." },
  { command: "ls packages/extensions/src", reason: "Lists the source extension directories." },
  { command: "ls -la packages/core", reason: "Lists the core package files." },
  { command: "find tests -maxdepth 1 -name \"*.ts\"", reason: "Read-only test file discovery." },
  { command: "find packages/extensions/src -type f -name \"index.ts\"", reason: "Read-only source file discovery." },
  { command: "rg -n \"secret-guard\" packages/extensions/src/secret-guard/index.ts", reason: "Searches one ordinary source file for its own name." },
  { command: "rg -n \"tool_call\" packages/extensions/src/secret-guard", reason: "Searches the extension source for its hook name." },
  { command: "grep -n \"commandReferencesSecret\" packages/extensions/src/secret-guard/index.ts", reason: "Searches one source file for a function name." },
  { command: "grep -R \"SECRET_PATH_PATTERNS\" packages/extensions/src/secret-guard", reason: "Searches source for a pattern constant." },
  { command: "sed -n '1,20p' packages/extensions/src/secret-guard/index.ts", reason: "Reads the first 20 lines of ordinary source." },
  { command: "sed -n '100,140p' packages/extensions/src/secret-guard/index.ts", reason: "Reads a middle range of ordinary source." },
  { command: "cat packages/extensions/src/secret-guard/index.ts", reason: "Reads ordinary source, not a credential file." },
  { command: "head -20 packages/extensions/src/secret-guard/index.ts", reason: "Reads the top of ordinary source." },
  { command: "tail -20 packages/extensions/src/secret-guard/index.ts", reason: "Reads the bottom of ordinary source." },
  { command: "cat packages/core/eval/harness.ts", reason: "Reads the eval harness source." },
  { command: "head -5 tests/tool-firewall-smoke.ts", reason: "Reads the top of a test source file." },
  { command: "sed -n '1,10p' tests/secret-guard-smoke.ts", reason: "Reads the top of a test source file." },
  { command: "cat README.md", reason: "Reads repository documentation." },
  { command: "ls packages/core", reason: "Lists core package files." },
  { command: "rg -n \"secret-guard\" docs", reason: "Searches documentation for the extension name." },
  { command: "find packages -maxdepth 2 -name \"*.json\" -not -path \"*/node_modules/*\"", reason: "Read-only package manifest discovery." },
  { command: "git status --short", reason: "Read-only short working-tree status." },
  { command: "git log -1 --format=\"%H %s\"", reason: "Read-only latest commit summary." },
  { command: "git diff -- packages/extensions/src/secret-guard/index.ts", reason: "Read-only diff of one source file." },
  { command: "git show HEAD:tests/tool-firewall-smoke.ts", reason: "Read-only blob of a test source file." },
  { command: "npm run smoke:tool-firewall", reason: "Runs the repository's own tool-firewall smoke." },
  { command: "npm run smoke:secret-guard", reason: "Runs the repository's own secret-guard smoke." },
  { command: "npm run test:typecheck", reason: "Runs the repository's typecheck." },
  { command: "npm run test:lint", reason: "Runs the repository's lint." },
  { command: "node packages/core/check-all.ts --list", reason: "Lists the repository's checks without running them." },
  { command: "echo \"benign corpus check\"", reason: "Prints a fixed string." },
  { command: "printf 'benign\\n'", reason: "Prints a fixed string." },
  { command: "pwd", reason: "Prints the working directory." },
];

interface CorpusContext {
  hasUI: boolean;
  cwd: string;
  ui: { notify(): void };
}

interface LoadedGuard {
  name: string;
  handler: RegisteredHandler;
}

async function loadGuard(extension: string): Promise<LoadedGuard> {
  const pi = fakePi();
  const register = await loadExtension< (api: unknown) => unknown >(extension);
  register(pi.api);
  const handler = pi.handlers.find("tool_call");
  assert.ok(handler, `${extension} must register a tool_call handler`);
  const start = pi.handlers.find("session_start");
  if (start) await start({}, { hasUI: false, cwd: process.cwd(), ui: { notify() {} } });
  return { name: extension, handler };
}

/**
 * Run the benign-command corpus through the shipped tool-firewall, secret-guard and
 * protected-paths handlers. Every handler must allow every row. Exported so the
 * already-wired tool-firewall smoke can invoke it without a package.json script.
 */
export async function runFirewallBenignCorpus(): Promise<void> {
  const workspace = tmpWorkspace("pi-kit-benign-corpus-");
  const restoreIsolation = isolateKitEnv();
  const restores: Array<() => void> = [restoreIsolation];
  try {
    restores.push(
      setEnv("HOME", path.join(workspace, "home")),
      setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent")),
      setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(workspace, "audit.jsonl")),
      setEnv("PI_KIT_FIREWALL_SESSIONS_DIR", path.join(workspace, "sessions")),
      setEnv("PI_KIT_FIREWALL_LEARNED_PROFILE", path.join(workspace, "firewall-profile.json")),
      setEnv("PI_KIT_FIREWALL_PROFILE", "coding"),
      setEnv("PI_KIT_AUTO_MODE", "0"),
    );
    const guards: LoadedGuard[] = [];
    for (const extension of [
      "extensions/tool-firewall/index.ts",
      "extensions/secret-guard/index.ts",
      "vendor/protected-paths/index.ts",
    ]) {
      guards.push(await loadGuard(extension));
    }
    const ctx: CorpusContext = { hasUI: false, cwd: process.cwd(), ui: { notify() {} } };
    for (const row of BENIGN_COMMANDS) {
      for (const guard of guards) {
        const result = await guard.handler({ toolName: "bash", input: { command: row.command } }, ctx);
        assert.equal(
          result,
          undefined,
          `${guard.name} blocked benign command ${JSON.stringify(row.command)} (${row.reason})`,
        );
      }
    }
    assert.equal(BENIGN_COMMANDS.length, 40, "the corpus is exactly 40 commands");
    console.log(`[test:security firewall-benign-corpus] OK (${BENIGN_COMMANDS.length} commands, ${guards.length} handlers)`);
  } finally {
    for (const restore of restores.reverse()) restore();
    rmWorkspace(workspace);
  }
}
