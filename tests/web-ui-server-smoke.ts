#!/usr/bin/env node
// Offline regression smoke for the web-ui server's disk readers. Covers
// valid-JSON-but-non-object persisted input, which previously threw
// `TypeError: Cannot read properties of null` inside /api/sessions/:id/stats
// (statsFromDisk) and /api/sessions/:id/lens (sessionLens).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const lensDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-lens-"));
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
  process.env.PI_LENS_DIR = lensDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
  process.env.PI_CODING_AGENT_DIR = homeDir;
  const { statsFromDisk } = await import(
    "../packages/web-ui/server/stats.ts"
  );
  const { sessionLens } = await import(
    "../packages/web-ui/server/lens.ts"
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

  // (b) pi-lens session: null file entry plus an entry with object runners.
  const sessionId = "smoke-session";
  const sessionsDir = path.join(lensDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({
      savedAt: "2026-01-01T00:00:00.000Z",
      widget: {
        files: [
          null,
          { filePath: "a.ts", runners: { x: 1 }, diagnosticCounts: null },
        ],
      },
    }),
  );

  check("sessionLens tolerates null entries and non-array runners", () => {
    const lens = sessionLens(sessionId);
    assert.equal(lens.files.length, 1, "the null file entry must be skipped");
    const [file] = lens.files;
    assert.ok(file, "the valid file entry is kept");
    assert.equal(file.filePath, "a.ts");
    assert.deepEqual(file.runners, [], "non-array runners must coerce to []");
    assert.equal(file.blocking, 0);
    assert.equal(file.errors, 0);
    assert.equal(file.warnings, 0);
    assert.equal(file.touchedAt, null);
  });

  check("sessionLens emits null filePath for non-string filePath", () => {
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        widget: { files: [{ filePath: 42, runners: [], diagnosticCounts: {} }] },
      }),
    );
    const lens = sessionLens(sessionId);
    assert.equal(lens.files.length, 1);
    assert.ok(lens.files[0], "the file entry is kept");
    assert.equal(lens.files[0].filePath, null);
  });

  check("sessionLens tolerates malformed runner elements", () => {
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        widget: {
          files: [
            {
              filePath: "b.ts",
              runners: [
                ["lint", { status: "ok", count: 3, durationMs: 5 }],
                null,
                7,
                [null],
              ],
            },
          ],
        },
      }),
    );
    let lens: ReturnType<typeof sessionLens> | undefined;
    assert.doesNotThrow(() => {
      lens = sessionLens(sessionId);
    });
    assert.ok(lens);
    assert.equal(lens.files.length, 1, "the one file entry must be kept");
    assert.ok(lens.files[0], "the one file entry must be kept");
    assert.deepEqual(
      lens.files[0].runners,
      [{ name: "lint", status: "ok", count: 3, durationMs: 5 }],
      "only the valid [name, info] runner must survive",
    );
  });

  check("sessionLens reports an invalid savedAt as null instead of throwing", () => {
    for (const savedAt of ["not a date", 1e20]) {
      fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify({ savedAt, widget: { files: [] } }));
      assert.equal(sessionLens(sessionId).savedAt, null, JSON.stringify(savedAt));
    }
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify({ savedAt: 1767225600000, widget: { files: [] } }));
    assert.equal(sessionLens(sessionId).savedAt, "2026-01-01T00:00:00.000Z");
  });

  // (b2) path traversal: the route decodes the session id, so an id such as
  // "../secret" (from `..%2Fsecret`) must not read a JSON file outside
  // LENS_DIR/sessions. `path.join` would otherwise normalise it and escape.
  fs.writeFileSync(
    path.join(lensDir, "secret.json"),
    JSON.stringify({ savedAt: 1, widget: { files: [{ filePath: "ESCAPED" }] } }),
  );

  check("sessionLens refuses path traversal outside sessions dir", () => {
    const lens = sessionLens("../secret");
    assert.equal(lens.available, false, "the escaped file must not be read");
    assert.ok(
      !JSON.stringify(lens).includes("ESCAPED"),
      "escaped file content must not leak into the response",
    );
  });

  // (b3) two-level traversal (the decoded `..%2F..%2F` route id) must also be
  // refused rather than reading a file several levels above the sessions dir.
  check("sessionLens refuses multi-level traversal ids", () => {
    const lens = sessionLens("../../secret");
    assert.equal(lens.available, false);
    assert.ok(!JSON.stringify(lens).includes("ESCAPED"));
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
  fs.rmSync(lensDir, { recursive: true, force: true });
  fs.rmSync(statsDir, { recursive: true, force: true });
  fs.rmSync(sessionsRoot, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
}

if (failed) {
  console.error("web-ui-server smoke: FAIL");
  process.exit(1);
}
console.log("web-ui-server smoke: OK");