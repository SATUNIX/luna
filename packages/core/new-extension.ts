#!/usr/bin/env node
/**
 * Scaffold a new in-repo extension from _template, then regenerate the catalogue
 * (`npm run catalog`) so the next `npm run verify` passes on the untouched scaffold.
 * Usage: node packages/core/new-extension.ts <name>
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveNpmCommand } from "./check-all.ts";
import { FIRST_PARTY_DIR, WORKSPACE_ROOT } from "./lib/paths.ts";

const name = process.argv[2];

if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("Usage: node packages/core/new-extension.ts <kebab-case-name>");
  process.exit(1);
}

const src = path.join(FIRST_PARTY_DIR, "_template");
const dst = path.join(FIRST_PARTY_DIR, name);
const rel = path.relative(WORKSPACE_ROOT, dst).replace(/\\/g, "/");

if (fs.existsSync(dst)) {
  console.error(`${rel} already exists.`);
  process.exit(1);
}

fs.mkdirSync(dst);
const created: string[] = [];
for (const file of fs.readdirSync(src).sort()) {
  let content = fs.readFileSync(path.join(src, file), "utf8");
  content = content.replaceAll("_template", name).replaceAll("EXTENSION_NAME", name);
  fs.writeFileSync(path.join(dst, file), content);
  created.push(`${rel}/${file}`);
}
console.log(`Created ${rel}/`);

// The extension catalogue lists every extension, so a new one makes it stale until regenerated.
const npm = resolveNpmCommand();
const catalog = spawnSync(npm.command, ["run", "-s", "catalog"], { cwd: WORKSPACE_ROOT, encoding: "utf8", shell: npm.shell });
if (catalog.status !== 0) {
  console.error(`npm run catalog failed (${catalog.status === null ? `signal ${String(catalog.signal)}` : `exit ${catalog.status}`}):\n${catalog.stderr}`);
  process.exit(1);
}
console.log("Regenerated the catalogue (npm run catalog).");

// Only a checkout that carries the release manifest classifies files; the public repository has none.
const manifest = "internal/public-release/manifest.json";
const steps = [
  `implement ${rel}/index.ts and fill ${rel}/extension.json;`,
  `to ship it in a profile, add "${name}" to packages/kit/profiles/<profile>.json "include" and to the "profiles" field of extension.json;`,
  ...(fs.existsSync(path.join(WORKSPACE_ROOT, manifest)) ? [`add the new files to the sorted "public" list of ${manifest}:\n${created.map((file) => `       ${file}`).join("\n")}`] : []),
  "after editing extension.json, run: npm run catalog",
  "run: npm run verify",
];
console.log(`Next:\n${steps.map((step, i) => `  ${i + 1}. ${step}`).join("\n")}`);
