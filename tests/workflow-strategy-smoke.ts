#!/usr/bin/env node
// One decision policy: `decide()` turns a stall or refusal signal into one move.
// Pending: this file only registers the script. It proves the one thing true today, that the module does not exist,
// so it fails as soon as the module lands and the change that adds the module must replace it with the real cases.
import assert from "node:assert/strict";
import fs from "node:fs";

assert.equal(fs.existsSync(new URL("../packages/extensions/src/effort/strategy.ts", import.meta.url)), false, "the module exists: replace this stub with its cases");
console.log("workflow-strategy-smoke: pending");
