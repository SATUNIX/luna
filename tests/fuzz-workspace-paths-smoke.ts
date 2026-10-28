#!/usr/bin/env node
/**
 * Property-based fuzzing of the safe-write helper (packages/core/shared/safe-fs.ts), which every
 * kit state write inside a workspace goes through.
 *
 * tests/workspace-symlink-smoke.ts plants known links and drives each writer. This test generates
 * paths: random sequences of real directories, links that point out of the workspace, `..`, `.`
 * and new names, and writes through them with each helper. For every generated path:
 *
 *   1. the write is refused (it throws), or the file it wrote resolves inside the workspace;
 *   2. nothing outside the workspace is created or changed, whatever the helper did.
 *
 * Inputs come from packages/core/eval/fuzz.ts (fixed seed in check:all, random in the weekly
 * security workflow). Hermetic: everything lives in temporary directories removed at the end.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, rmWorkspace, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { fuzzSeed, propertyAsync } from "../packages/core/eval/fuzz.ts";
import { appendFileSafe, createFileExclusive, ensureDirSafe, isInside, writeFileSafe } from "../packages/core/shared/safe-fs.ts";

isolateKitEnv();

const base = tmpWorkspace("pi-kit-fuzz-paths-");
const ws = path.join(base, "ws");
const outside = path.join(base, "outside");
fs.mkdirSync(path.join(ws, "a", "b"), { recursive: true });
fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, "sentinel.txt"), "SENTINEL: must never change\n");
// Links a cloned repository could commit: out of the workspace, to its parent, and to a file outside.
fs.symlinkSync(outside, path.join(ws, "out"));
fs.symlinkSync("..", path.join(ws, "a", "up"));
fs.symlinkSync(path.join("..", "..", "..", "outside"), path.join(ws, "a", "b", "away"));
fs.symlinkSync(path.join(outside, "sentinel.txt"), path.join(ws, ".pi", "state.json"));
fs.symlinkSync(outside, path.join(ws, ".pi", "logs"));

/** Every entry under `dir` (relative path -> content digest, or the link target). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isSymbolicLink()) out.set(rel, `link:${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) {
        out.set(rel, "dir");
        walk(p);
      } else out.set(rel, crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

const outsideBefore = snapshot(outside);
const baseEntriesBefore = fs.readdirSync(base).sort();
const realWs = fs.realpathSync(ws);

const SEGMENTS = ["a", "b", "out", "up", "away", ".pi", "logs", "..", ".", "new", "deeper", "state.json", "sentinel.txt"];
const NAMES = ["note.md", "state.json", "sentinel.txt", "trace.jsonl", "x", ".hidden", "logs"];
const HELPERS = ["writeFileSafe", "appendFileSafe", "createFileExclusive", "ensureDirSafe"] as const;
type Helper = (typeof HELPERS)[number];

/** Runs one helper; false when it declined without throwing (createFileExclusive on a taken name). */
function run(helper: Helper, target: string): boolean {
  const options = { root: ws };
  if (helper === "createFileExclusive") return createFileExclusive(target, "fuzz\n", options);
  if (helper === "writeFileSafe") writeFileSafe(target, "fuzz\n", options);
  else if (helper === "appendFileSafe") appendFileSafe(target, "fuzz\n", options);
  else ensureDirSafe(target, options);
  return true;
}

let refused = 0;
let written = 0;
try {
  const runs = await propertyAsync(
    "workspace writes stay inside the workspace",
    300,
    (r) => {
      const segments: string[] = [];
      for (let i = 0, n = r.int(5); i < n; i++) segments.push(r.pick(SEGMENTS));
      return { helper: r.pick(HELPERS), segments, name: r.pick(NAMES) };
    },
    async ({ helper, segments, name }) => {
      const target = path.join(ws, ...segments, name);
      let threw: boolean;
      try {
        threw = !run(helper, target);
      } catch {
        threw = true; // a refusal (UnsafePathError) or an ordinary failure (ENOTDIR, ENOENT): either is safe
      }
      if (threw) refused++;
      else {
        written++;
        const real = fs.realpathSync(target);
        assert.ok(isInside(realWs, real), `${helper} wrote ${real}, outside the workspace`);
      }
      assert.deepEqual(snapshot(outside), outsideBefore, `${helper} changed something outside the workspace`);
      assert.deepEqual(fs.readdirSync(base).sort(), baseEntriesBefore, `${helper} created something next to the workspace`);
    },
  );
  assert.ok(refused > 0 && written > 0, `the generator reaches both outcomes (refused ${refused}, written ${written})`);
  console.log(`  ok  generated paths through links, '..' and '.' never write outside the workspace (${runs} cases: ${written} written inside, ${refused} refused)`);
  console.log(`[fuzz-workspace-paths-smoke] OK: seed ${fuzzSeed()}`);
} finally {
  rmWorkspace(base);
}
