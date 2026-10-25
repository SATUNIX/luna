#!/usr/bin/env node
/**
 * Ledger anchor (packages/container/scripts/validate-ledgers.py).
 * The audit/evidence hash chain detects accidental damage only: whoever can write the data root can
 * rewrite a record and recompute every later hash, and the plain chain check still passes (shown
 * below). The anchor is a head (record count + last record_hash) the operator records OUTSIDE the
 * data root; checked against it:
 *   - a ledger that only grew since the anchor passes;
 *   - a rewritten ledger with a recomputed chain fails;
 *   - a ledger truncated below the anchor, or deleted, fails;
 *   - an anchor path inside the data root is refused.
 * Needs python3; the records are benign fixtures.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../packages/core/eval/harness.ts";

if (spawnSync("python3", ["--version"]).status !== 0) {
  console.log("[ledger-anchor-smoke] SKIP: python3 is not available");
  process.exit(0);
}

const VALIDATOR = path.join(ROOT, "packages", "container", "scripts", "validate-ledgers.py");
type Flat = Record<string, string | number>;

/** The validator's stable_json (sorted keys, two-space indent) for flat records of strings and integers. */
const stableJson = (record: Flat): string => JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2);
const chain = (bodies: Flat[]): string => {
  let previous = "";
  return bodies.map((body, i) => {
    const base: Flat = { ...body, sequence: i + 1, previous_hash: previous };
    const record_hash = createHash("sha256").update(stableJson(base)).digest("hex");
    previous = record_hash;
    return `${JSON.stringify({ ...base, record_hash })}\n`;
  }).join("");
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-ledger-anchor-"));
try {
  const dataRoot = path.join(work, "data");
  const ledger = path.join(dataRoot, "audit", "audit.jsonl");
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const anchor = path.join(work, "operator", "ledger-anchor.json");
  const validate = (...extra: string[]) => spawnSync("python3", ["-I", VALIDATOR, "--data-root", dataRoot, ...extra], { encoding: "utf8" });
  const events = (n: number, label = "event"): Flat[] => Array.from({ length: n }, (_, i) => ({ action: `${label}-${i + 1}`, tool: "echo" }));

  fs.writeFileSync(ledger, chain(events(3)));
  const written = validate("--write-anchor", anchor);
  assert.equal(written.status, 0, written.stderr);
  const recorded: unknown = JSON.parse(fs.readFileSync(anchor, "utf8"));
  assert.match(JSON.stringify(recorded), /"audit":\{"count":3,"record_hash":"[0-9a-f]{64}"\}/, "the anchor records the audit head");

  fs.writeFileSync(ledger, chain(events(5)));
  const grown = validate("--anchor", anchor);
  assert.equal(grown.status, 0, `a ledger that only grew passes:\n${grown.stderr}`);

  const rewritten = events(5);
  rewritten[1] = { action: "event-2-edited", tool: "true" };
  fs.writeFileSync(ledger, chain(rewritten));
  assert.equal(validate().status, 0, "the plain chain check cannot see a rewrite with recomputed hashes (the limitation the anchor addresses)");
  const caught = validate("--anchor", anchor);
  assert.equal(caught.status, 1, "a rewritten ledger fails against the anchor");
  assert.match(caught.stderr, /record 3 no longer has the anchored hash/);

  fs.writeFileSync(ledger, chain(events(2)));
  const truncated = validate("--anchor", anchor);
  assert.equal(truncated.status, 1);
  assert.match(truncated.stderr, /has 2 record\(s\) but the anchor records 3/);

  fs.rmSync(ledger);
  const deleted = validate("--anchor", anchor);
  assert.equal(deleted.status, 1);
  assert.match(deleted.stderr, /ledger is missing but the anchor records 3/);

  const insideRoot = validate("--write-anchor", path.join(dataRoot, "anchor.json"));
  assert.equal(insideRoot.status, 2, "an anchor inside the data root is refused");
  assert.match(insideRoot.stderr, /must live outside the data root/);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log("[ledger-anchor-smoke] OK (growth passes; a recomputed rewrite, a truncation and a deletion fail against the anchor; an anchor in the data root is refused)");
