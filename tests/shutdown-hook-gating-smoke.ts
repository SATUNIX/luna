#!/usr/bin/env node
// Shutdown hooks must ignore one-shot internal pi children, while retaining
// their normal top-level behavior and explicit operator commands.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assert,
  fakePi,
  isolateKitEnv,
  loadExtension,
  rmWorkspace,
  setEnv,
  tmpWorkspace,
} from "../packages/core/eval/harness.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(cwd: string): void {
  git(cwd, ["init"]);
  git(cwd, ["config", "user.name", "Pi Kit Smoke"]);
  git(cwd, ["config", "user.email", "pi-kit-smoke@example.invalid"]);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "baseline\n");
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-m", "initial"]);
}

function shutdownCtx(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: { notify() {} },
    sessionManager: {
      getEntries: () => [{
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "smoke work" }] },
      }],
    },
  };
}

async function run(): Promise<void> {
  const workspace = tmpWorkspace("pi-kit-shutdown-gating-");
  const restoreIsolation = isolateKitEnv();
  const restoreInternalChild = setEnv("PI_KIT_INTERNAL_CHILD", undefined);
  const restoreAutoMode = setEnv("PI_KIT_AUTO_MODE", undefined);
  const restoreAudit = setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(workspace, "firewall-audit.jsonl"));
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent"));
  try {
    const autoCommit = await loadExtension("vendor/auto-commit-on-exit/index.ts");
    const handoff = await loadExtension("vendor/handoff/index.ts");

    // A real top-level shutdown commits a dirty real git worktree.
    const commitRepo = path.join(workspace, "commit-baseline");
    fs.mkdirSync(commitRepo);
    initRepo(commitRepo);
    fs.appendFileSync(path.join(commitRepo, "tracked.txt"), "top-level change\n");
    const beforeCommit = git(commitRepo, ["rev-parse", "HEAD"]);
    const commitPi = fakePi({ cwd: commitRepo });
    autoCommit(commitPi.api);
    await commitPi.handlers.get("session_shutdown")({}, shutdownCtx(commitRepo));
    assert(git(commitRepo, ["rev-parse", "HEAD"]) !== beforeCommit, "top-level shutdown must commit dirty work");
    assert(git(commitRepo, ["status", "--porcelain"]) === "", "top-level auto-commit must leave the worktree clean");

    // Kit artefacts under <cwd>/.pi (save snapshots, compaction copies, audit logs) are never
    // staged: the project change is committed, .pi/ stays untracked.
    const piDirRepo = path.join(workspace, "commit-pi-dir");
    fs.mkdirSync(piDirRepo);
    initRepo(piDirRepo);
    fs.appendFileSync(path.join(piDirRepo, "tracked.txt"), "project change\n");
    fs.mkdirSync(path.join(piDirRepo, ".pi", "snapshots"), { recursive: true });
    fs.writeFileSync(path.join(piDirRepo, ".pi", "snapshots", "Latest Compact.md"), "Authorization: Bearer smoke-secret-value\n");
    fs.writeFileSync(path.join(piDirRepo, ".pi", "human-console-audit.jsonl"), "{}\n");
    const piDirPi = fakePi({ cwd: piDirRepo });
    autoCommit(piDirPi.api);
    await piDirPi.handlers.get("session_shutdown")({}, shutdownCtx(piDirRepo));
    const committed = git(piDirRepo, ["show", "--name-only", "--format=", "HEAD"]).split("\n");
    assert(committed.includes("tracked.txt"), "auto-commit still commits the project change");
    assert(!committed.some((f) => f.startsWith(".pi/")), `auto-commit must not stage .pi/ (committed: ${committed.join(", ")})`);
    assert(git(piDirRepo, ["status", "--porcelain"]) === "?? .pi/", "the .pi/ directory stays untracked");

    // Opt-in: no shipped profile enables auto-commit-on-exit and it is not on by default.
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/extensions/third_party/auto-commit-on-exit/extension.json"), "utf8"));
    assert(isRecord(manifest) && manifest.enabledByDefault === false, "auto-commit-on-exit must have enabledByDefault false");
    assert(Array.isArray(manifest.profiles) && manifest.profiles.length === 0, "auto-commit-on-exit must list no profiles");
    assert(manifest.status === "experimental", "an extension in no profile is experimental (verify rejects orphaned stable ones)");
    const profilesDir = path.join(ROOT, "packages/kit/profiles");
    for (const file of fs.readdirSync(profilesDir).filter((f) => f.endsWith(".json"))) {
      const profile: unknown = JSON.parse(fs.readFileSync(path.join(profilesDir, file), "utf8"));
      const include = isRecord(profile) && Array.isArray(profile.include) ? profile.include : [];
      assert(!include.includes("auto-commit-on-exit"), `profile ${file} must not include auto-commit-on-exit (opt-in only)`);
    }

    // An internal child leaves both the commit history and dirty worktree alone.
    const childRepo = path.join(workspace, "commit-child");
    fs.mkdirSync(childRepo);
    initRepo(childRepo);
    fs.appendFileSync(path.join(childRepo, "tracked.txt"), "child change\n");
    const childBeforeCommit = git(childRepo, ["rev-parse", "HEAD"]);
    const childCommitPi = fakePi({ cwd: childRepo });
    autoCommit(childCommitPi.api);
    process.env.PI_KIT_INTERNAL_CHILD = "1";
    await childCommitPi.handlers.get("session_shutdown")({}, shutdownCtx(childRepo));
    assert(git(childRepo, ["rev-parse", "HEAD"]) === childBeforeCommit, "internal child shutdown must not commit");
    assert(git(childRepo, ["status", "--porcelain"]) !== "", "internal child shutdown must preserve dirty work");
    delete process.env.PI_KIT_INTERNAL_CHILD;

    // The automatic shutdown note is opt-in (it carried no resumable content and littered
    // every directory with HANDOFF.md); off by default, available to a top-level session.
    const handoffTop = path.join(workspace, "handoff-top");
    fs.mkdirSync(handoffTop);
    const handoffPi = fakePi();
    handoff(handoffPi.api);
    await handoffPi.handlers.get("session_shutdown")({}, shutdownCtx(handoffTop));
    assert(!fs.existsSync(path.join(handoffTop, "HANDOFF.md")), "no automatic handoff note unless PI_KIT_HANDOFF_AUTO=1");
    const restoreAuto = setEnv("PI_KIT_HANDOFF_AUTO", "1");
    try {
      await handoffPi.handlers.get("session_shutdown")({}, shutdownCtx(handoffTop));
    } finally {
      restoreAuto();
    }
    assert(fs.readFileSync(path.join(handoffTop, "HANDOFF.md"), "utf8").includes("Session ended."), "opted-in top-level shutdown writes a handoff");

    // Automatic handoff is suppressed for internal children, but /handoff is not.
    const handoffChild = path.join(workspace, "handoff-child");
    fs.mkdirSync(handoffChild);
    const childHandoffPi = fakePi();
    handoff(childHandoffPi.api);
    process.env.PI_KIT_INTERNAL_CHILD = "1";
    process.env.PI_KIT_HANDOFF_AUTO = "1"; // even when opted in, children never write one
    await childHandoffPi.handlers.get("session_shutdown")({}, shutdownCtx(handoffChild));
    delete process.env.PI_KIT_HANDOFF_AUTO;
    assert(!fs.existsSync(path.join(handoffChild, "HANDOFF.md")), "internal child shutdown must not write a handoff");
    await childHandoffPi.commands.get("handoff").handler("operator note", { cwd: handoffChild, ui: { notify() {} } });
    assert(fs.readFileSync(path.join(handoffChild, "HANDOFF.md"), "utf8").includes("operator note"), "/handoff must work for internal children");
    delete process.env.PI_KIT_INTERNAL_CHILD;

    // The firewall's auto-mode judge runs in process (no child, so no env marker to pass);
    // a stubbed verdict is honoured for a headless caller. A medium-tier shell call reaches the
    // judge; an unknown tool would not, because only the operator can authorise one.
    const firewall = await loadExtension("extensions/tool-firewall/index.ts");
    const firewallPi = fakePi();
    let judged = 0;
    firewall(firewallPi.api, { complete: async () => { judged++; return '{"verdict":"allow","reason":"smoke"}'; } });
    process.env.PI_KIT_AUTO_MODE = "1";
    const result = await firewallPi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "npm install shutdown-hook-fixture" } },
      { cwd: workspace, hasUI: false, ui: {} },
    );
    assert(result === undefined, "judge approval should allow the test call");
    assert(judged === 1, "the in-process judge must be consulted");

    console.log("[smoke:shutdown-hook-gating] OK");
  } finally {
    restoreInternalChild();
    restoreAutoMode();
    restoreAudit();
    restoreAgentDir();
    restoreIsolation();
    rmWorkspace(workspace);
  }
}

await run();
