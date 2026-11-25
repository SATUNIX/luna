#!/usr/bin/env node
// Offline regression smoke for the web-ui server's disk readers. Covers
// valid-JSON-but-non-object persisted input, which previously threw
// `TypeError: Cannot read properties of null` inside /api/sessions/:id/stats
// (statsFromDisk).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const statsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-stats-"));
const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-sessions-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-home-"));
let failed = false;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed = true;
    console.error(`  not ok - ${name}`);
    console.error(error instanceof Error && error.stack ? error.stack : error);
  }
}

try {
  // config.ts captures these paths at import time, so set every env var before the
  // first dynamic import (stats.ts -> models.ts -> config.ts).
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
  process.env.PI_CODING_AGENT_DIR = homeDir;
  const { statsFromDisk } = await import(
    "../packages/web-ui/server/stats.ts"
  );
  const { listSessions } = await import(
    "../packages/web-ui/server/sessions.ts"
  );
  const { listModels } = await import(
    "../packages/web-ui/server/models.ts"
  );

  // (a) stats JSONL: null line, 0 line, malformed line, one valid message.
  const sessionFile = path.join(statsDir, "session.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      "null",
      "0",
      "{not json",
      JSON.stringify({ type: "message", message: { role: "user" } }),
      "",
    ].join("\n"),
  );

  check("statsFromDisk tolerates null/primitive/malformed lines", () => {
    const stats = statsFromDisk(sessionFile);
    assert.equal(stats.userMessages, 1, "the valid user message must be counted");
    assert.equal(stats.totalMessages, 1);
    assert.equal(stats.live, false);
  });

  // (c) listSessions: a session JSONL whose first/next line is `null`.
  const sessionSubdir = path.join(sessionsRoot, "proj");
  fs.mkdirSync(sessionSubdir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionSubdir, "disk-session.jsonl"),
    [
      "null",
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "hello from disk" },
      }),
    ].join("\n"),
  );

  check("listSessions tolerates a null line and keeps the valid session", () => {
    const sessions = listSessions();
    assert.equal(sessions.length, 1, "the valid session must still be listed");
    assert.ok(sessions[0], "the valid session must still be listed");
    assert.equal(sessions[0].id, "disk-session");
    assert.equal(sessions[0].preview, "hello from disk");
    assert.equal(sessions[0].entryCount, 2);
  });

  // (d) listModels: a models.json whose models array contains a null element.
  fs.writeFileSync(
    path.join(homeDir, "models.json"),
    JSON.stringify({
      providers: {
        x: { models: [null, "string-model", { id: "obj-model", contextWindow: 100 }] },
      },
    }),
  );

  check("listModels tolerates a null models element", () => {
    const { providers } = listModels();
    assert.equal(providers.length, 1);
    assert.ok(providers[0], "the provider is listed");
    assert.deepEqual(
      providers[0].models.map((m: { id: string }) => m.id),
      ["string-model", "obj-model"],
      "the null element must be skipped, valid entries kept",
    );
  });

  // (e) listModels: a provider whose value is null.
  fs.writeFileSync(
    path.join(homeDir, "models.json"),
    JSON.stringify({
      providers: { foo: null, bar: { models: [{ id: "obj-model" }] } },
    }),
  );

  check("listModels tolerates a null provider value", () => {
    const { providers } = listModels();
    assert.deepEqual(
      providers.map((p) => p.name),
      ["bar"],
      "the null provider must be skipped, valid providers kept",
    );
    assert.ok(providers[0], "the valid provider is listed");
    assert.deepEqual(providers[0].models.map((m: { id: string }) => m.id), ["obj-model"]);
  });
} finally {
  fs.rmSync(statsDir, { recursive: true, force: true });
  fs.rmSync(sessionsRoot, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
}

if (failed) {
  console.error("web-ui-server smoke: FAIL");
  process.exit(1);
}
console.log("web-ui-server smoke: OK");