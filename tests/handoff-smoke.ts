#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";

const restoreEnv = isolateKitEnv();
const workspace = tmpWorkspace("pi-kit-handoff-");
const register = await loadExtension("vendor/handoff/index.ts");
const pi = fakePi();
register(pi.api);
const ctx = { cwd: workspace, hasUI: false };
async function note(file: string, text = "Keep this note"): Promise<void> {
  const restore = setEnv("PI_KIT_HANDOFF_FILE", file);
  try { await pi.commands.get("handoff").handler(text, ctx); }
  finally { restore(); }
}

try {
  const file = path.join(workspace, "new.md");
  await note(file, "  First note  ");
  assert.match(fs.readFileSync(file, "utf8"), /^# Handoff Notes\n\n## [^\n]+\n\nFirst note\n$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const first = fs.readFileSync(file, "utf8");
  await note(file, "Second note");
  assert.ok(fs.readFileSync(file, "utf8").startsWith(first), "appending preserves every existing byte");
  assert.equal(fs.readFileSync(file, "utf8").match(/# Handoff Notes/g)?.length, 1);

  // A second writer creates the destination just before our attempted create.
  const concurrent = path.join(workspace, "concurrent.md");
  const open = fs.openSync;
  let raced = false;
  fs.openSync = (target, flags, ...args) => {
    if (target === concurrent && !raced) {
      raced = true;
      fs.writeFileSync(concurrent, "Another writer's notes\n");
    }
    return open(target, flags, ...args);
  };
  try { await note(concurrent); }
  finally { fs.openSync = open; }
  assert.match(fs.readFileSync(concurrent, "utf8"), /^Another writer's notes\n\n## [^\n]+\n\nKeep this note\n$/);

  if (fs.constants.O_NOFOLLOW) {
    const victim = path.join(workspace, "victim.md");
    const link = path.join(workspace, "link.md");
    fs.writeFileSync(victim, "Victim must remain unchanged");
    fs.symlinkSync(victim, link);
    await assert.rejects(note(link), { code: "ELOOP" });
    assert.equal(fs.readFileSync(victim, "utf8"), "Victim must remain unchanged");

    // Replacement after open must not redirect the actual write to the new path.
    const swapped = path.join(workspace, "swapped.md");
    const original = path.join(workspace, "opened.md");
    const stat = fs.fstatSync;
    let replaced = false;
    // The wrapper forwards to the real overloads unchanged; one signature stands in for all of them.
    fs.fstatSync = ((fd: number, ...args: [options?: fs.StatOptions]) => {
      if (!replaced) {
        replaced = true;
        fs.renameSync(swapped, original);
        fs.symlinkSync(victim, swapped);
      }
      return stat(fd, ...args);
    }) as typeof fs.fstatSync;
    try { await note(swapped); }
    finally { fs.fstatSync = stat; }
    assert.match(fs.readFileSync(original, "utf8"), /Keep this note/);
    assert.equal(fs.readFileSync(victim, "utf8"), "Victim must remain unchanged");
  }

  const write = fs.writeFileSync;
  let failedFd: number | undefined;
  fs.writeFileSync = (target, ...args) => {
    if (typeof target === "number") {
      failedFd = target;
      throw new Error("Simulated disk write failure");
    }
    write(target, ...args);
  };
  try { await assert.rejects(note(path.join(workspace, "failed.md")), /Simulated disk write failure/); }
  finally { fs.writeFileSync = write; }
  const closedFd = failedFd;
  assert.ok(closedFd !== undefined, "the simulated write failure must have captured a descriptor");
  assert.throws(() => fs.fstatSync(closedFd), { code: "EBADF" }, "write failures close the descriptor");
  await assert.rejects(note(path.join(workspace, "missing", "note.md")), { code: "ENOENT" });
  await assert.rejects(note(workspace), { code: "EISDIR" });
  console.log("handoff-smoke: OK (create, append, concurrent creation, descriptor safety and failure cleanup)");
} finally {
  rmWorkspace(workspace);
  restoreEnv();
}
