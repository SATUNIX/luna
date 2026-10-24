#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.ts";

async function loadConductor() {
  const register = await loadExtension("extensions/conductor/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

interface Note {
  message: string;
  level: string | undefined;
}

interface EngagementRecord {
  phase: string;
  history: unknown[];
}

type SmokeTest = () => Promise<void>;

function context(ws: string, notes: Note[]) {
  return { cwd: ws, ui: { notify: (message: string, level?: string) => notes.push({ message, level }), setStatus() {} } };
}

// The most recent notification; a missing one fails the calling assertion just as before.
function lastMessage(notes: Note[]): string {
  const last = notes.at(-1);
  assert.ok(last, "expected at least one notification");
  return last.message;
}

function writeEngagement(ws: string, phase = "intake"): string {
  const file = path.join(ws, ".pi", "engagement", "engagement.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ version: 1, phase, startedAt: now, updatedAt: now, history: [{ phase, at: now }] }), "utf8");
  return file;
}

function writePassingBoard(ws: string): void {
  const file = path.join(ws, ".pi", "verdicts.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // WU-1: completion requires at least one trusted source, so the "all-pass" board uses
  // `verify` (an independent writer). An untrusted-only `smoke` PASS no longer advances.
  fs.writeFileSync(file, JSON.stringify({ verdicts: { verify: { pass: true, summary: "all good", at: new Date().toISOString() } } }), "utf8");
}

async function testDiskResume() {
  const ws = tmpWorkspace("pi-kit-conductor-resume-");
  try {
    writeEngagement(ws, "execution");
    const pi = await loadConductor();
    const notes: Note[] = [];
    await pi.commands.get("engagement").handler("status", context(ws, notes));
    assert.match(lastMessage(notes), /engagement: execution/);
  } finally {
    rmWorkspace(ws);
  }
}

async function testAdvanceWithPassingVerdict() {
  const ws = tmpWorkspace("pi-kit-conductor-pass-");
  try {
    const pi = await loadConductor();
    const notes: Note[] = [];
    const ctx = context(ws, notes);
    await pi.commands.get("engagement").handler("start", ctx);
    writePassingBoard(ws);
    await pi.commands.get("engagement").handler("phase authorisation", ctx);
    const record = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "engagement", "engagement.json"), "utf8")) as EngagementRecord;
    assert.equal(record.phase, "authorisation");
    assert.equal(record.history.length, 2);
    assert.match(lastMessage(notes), /advanced from intake to authorisation/);
  } finally {
    rmWorkspace(ws);
  }
}

async function testAdvanceBlockedWithoutPassingVerdict() {
  const ws = tmpWorkspace("pi-kit-conductor-block-");
  try {
    const pi = await loadConductor();
    const notes: Note[] = [];
    const ctx = context(ws, notes);
    await pi.commands.get("engagement").handler("start", ctx);
    const file = path.join(ws, ".pi", "engagement", "engagement.json");
    const before = fs.readFileSync(file, "utf8");
    await pi.commands.get("engagement").handler("phase authorisation", ctx);
    assert.equal(fs.readFileSync(file, "utf8"), before, "blocked transition must not mutate the engagement record");
    assert.match(lastMessage(notes), /phase advance blocked/i);
  } finally {
    rmWorkspace(ws);
  }
}

async function testAdvanceBlockedWithFailingVerdict() {
  const ws = tmpWorkspace("pi-kit-conductor-failing-board-");
  try {
    const pi = await loadConductor();
    const notes: Note[] = [];
    const ctx = context(ws, notes);
    await pi.commands.get("engagement").handler("start", ctx);
    const file = path.join(ws, ".pi", "engagement", "engagement.json");
    const before = fs.readFileSync(file, "utf8");
    const boardFile = path.join(ws, ".pi", "verdicts.json");
    fs.writeFileSync(boardFile, JSON.stringify({ verdicts: { smoke: { pass: false, summary: "smoke failed", at: new Date().toISOString() } } }), "utf8");
    await pi.commands.get("engagement").handler("phase authorisation", ctx);
    assert.equal(fs.readFileSync(file, "utf8"), before, "blocked transition must not mutate the engagement record");
    assert.match(lastMessage(notes), /phase advance blocked/i);
  } finally {
    rmWorkspace(ws);
  }
}

async function testAdvanceBlockedWithPendingValidator() {
  const ws = tmpWorkspace("pi-kit-conductor-pending-validator-");
  try {
    const pi = await loadConductor();
    const notes: Note[] = [];
    const ctx = context(ws, notes);
    await pi.commands.get("engagement").handler("start", ctx);
    writePassingBoard(ws);
    const file = path.join(ws, ".pi", "engagement", "engagement.json");
    const before = fs.readFileSync(file, "utf8");
    const pending = path.join(ws, ".pi", "engagement", "findings", "account-exposure", "pending-validation.json");
    fs.mkdirSync(path.dirname(pending), { recursive: true });
    fs.writeFileSync(pending, JSON.stringify({ at: new Date().toISOString() }), "utf8");
    await pi.commands.get("engagement").handler("phase authorisation", ctx);
    assert.equal(fs.readFileSync(file, "utf8"), before, "a pending validator must block phase advance even with an all-pass board");
    assert.match(lastMessage(notes), /validator:account-exposure \(pending\)/);
  } finally {
    rmWorkspace(ws);
  }
}

// ORC-10: history entries are checked on read, so a malformed entry is dropped instead of being
// carried as an EngagementHistory it is not.
async function testMalformedHistoryEntriesAreDropped() {
  const ws = tmpWorkspace("pi-kit-conductor-history-");
  try {
    const file = path.join(ws, ".pi", "engagement", "engagement.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({
      version: 2, phase: "intake", startedAt: now, updatedAt: now,
      history: [{ phase: "intake", at: now }, { phase: "teleported", at: now }, null, { phase: "intake", at: 5 }],
      recursion: { maxDepth: 2, maxDispatches: 8, dispatchesUsed: 0 },
    }), "utf8");
    const pi = await loadConductor();
    const notes: Note[] = [];
    await pi.commands.get("engagement").handler("status", context(ws, notes));
    assert.match(lastMessage(notes), /history entries: 1\n/, "only the well-formed history entry is kept");
  } finally {
    rmWorkspace(ws);
  }
}

const tests: Array<[string, SmokeTest]> = [
  ["malformed engagement history entries are dropped on read (ORC-10)", testMalformedHistoryEntriesAreDropped],
  ["a fresh extension resumes engagement state from disk", testDiskResume],
  ["start then phase advance succeeds with an all-pass board", testAdvanceWithPassingVerdict],
  ["missing verdict board blocks advance without mutating state", testAdvanceBlockedWithoutPassingVerdict],
  ["failing verdict board blocks advance without mutating state", testAdvanceBlockedWithFailingVerdict],
  ["pending validator blocks advance despite an all-pass board", testAdvanceBlockedWithPendingValidator],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\n[conductor-engagement-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[conductor-engagement-smoke] all ${tests.length} checks passed`);
