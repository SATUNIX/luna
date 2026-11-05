#!/usr/bin/env node
// One run query: every run format, finished or live, across processes.
// Pending: this file only registers the script. It proves the one thing true today, that the module does not exist,
// so it fails as soon as the module lands and the change that adds the module must replace it with the real cases.
import assert from "node:assert/strict";
import fs from "node:fs";

assert.equal(fs.existsSync(new URL("../packages/extensions/third_party/subagent/run-query.ts", import.meta.url)), false, "the module exists: replace this stub with its cases");
console.log("run-query-smoke: pending");
