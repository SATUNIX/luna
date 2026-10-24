#!/usr/bin/env node
// `/console open` hands the login URL to the system opener (xdg-open, open, `cmd /c start`). The host and port come from the
// environment and the token may be operator-supplied, so only a plain http(s) URL is ever passed on: on Windows a `&` or `^`
// is a shell metacharacter, and elsewhere an argument that starts with `-` would be read as an option. This runs the real
// openBrowser with a stand-in opener on PATH and checks what reaches it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModule, setEnv } from "../packages/core/eval/harness.ts";
import type * as WebConsole from "../packages/extensions/src/web-console/index.ts";

if (process.platform === "win32") {
  console.log("[web-console-open-smoke] SKIPPED: the stand-in opener is a POSIX script");
  process.exit(0);
}

const { openBrowser } = await loadModule<typeof WebConsole>("extensions/web-console/index.ts");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-open-smoke-"));
const record = path.join(dir, "argv.log");
for (const name of ["xdg-open", "open"]) {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${record}"\n`, { mode: 0o755 });
}
const restore = setEnv("PATH", `${dir}${path.delimiter}${process.env.PATH}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const opened = async () => {
  await sleep(150);
  return fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n") : [];
};

try {
  const token = "a".repeat(64);
  const good = [`http://127.0.0.1:8123/#token=${token}`, "http://localhost:8123/", "https://console.example.org/#token=abc_DEF-123", "http://[::1]:8123/#token=0f", "http://127.0.0.1/"];
  for (const url of good) {
    fs.rmSync(record, { force: true });
    assert.equal(openBrowser(url), true, `${url} is opened`);
    assert.deepEqual(await opened(), [url], `${url} reaches the opener as one argument`);
  }

  const bad = [
    "http://127.0.0.1:8123/#token=a&calc",
    "http://127.0.0.1:8123/#token=a^b",
    "http://127.0.0.1:8123/#token=a b",
    "http://127.0.0.1:8123/#token=a\nb",
    'http://127.0.0.1:8123/#token=a"b',
    "http://host&calc:8123/",
    "http://127.0.0.1:99999999/",
    "http://127.0.0.1:8123/path?x=1",
    "-http://127.0.0.1:8123/",
    "--flag",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://user:pass@127.0.0.1:8123/",
    "http://127.0.0.1:8123/#token=",
    "",
  ];
  for (const url of bad) {
    fs.rmSync(record, { force: true });
    assert.equal(openBrowser(url), false, `${JSON.stringify(url)} is refused`);
    assert.deepEqual(await opened(), [], `${JSON.stringify(url)} never reaches the opener`);
  }
  console.log(`[web-console-open-smoke] OK (${good.length} URLs opened as one argument, ${bad.length} refused)`);
} finally {
  restore();
  fs.rmSync(dir, { recursive: true, force: true });
}
