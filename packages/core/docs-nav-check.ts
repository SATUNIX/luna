#!/usr/bin/env node
/**
 * Offline, deterministic docs nav + link validator — the environment-independent stand-in
 * for `mkdocs build --strict` (which needs Python/mkdocs). Checks:
 *   1. Every file referenced in mkdocs.yml nav exists under docs/.
 *   2. Every markdown doc under docs/ appears in the nav (no orphans) — warn-listed.
 *   3. Every relative markdown link / image in a nav'd doc resolves to a real file.
 * Exit non-zero on any broken nav entry or broken internal link. (Epic 3 Sprint 3.3.)
 *
 * Usage: node packages/core/docs-nav-check.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ROOT } from "./lib/paths.ts";

const ROOT = WORKSPACE_ROOT;
const DOCS = path.join(ROOT, "docs");
const MKDOCS = path.join(ROOT, "mkdocs.yml");

// Minimal YAML nav extractor: collect every `something.md` token under the nav: block.
function navTargets(): string[] {
  const text = fs.readFileSync(MKDOCS, "utf8").split(/\r?\n/);
  const targets: string[] = [];
  let inNav = false;
  for (const line of text) {
    if (/^nav:\s*$/.test(line)) {
      inNav = true;
      continue;
    }
    if (inNav && /^\S/.test(line) && !/^\s/.test(line)) break; // dedent to a new top-level key
    if (!inNav) continue;
    const m = line.match(/:\s*([A-Za-z0-9_./-]+\.md)\s*$/) ?? line.match(/^\s*-\s*([A-Za-z0-9_./-]+\.md)\s*$/);
    if (m?.[1]) targets.push(m[1]);
  }
  return targets;
}

function listDocs(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) listDocs(full, acc);
    else if (entry.endsWith(".md")) acc.push(path.relative(DOCS, full).replace(/\\/g, "/"));
  }
  return acc;
}

export function checkDocsNav(): boolean {
  let errors = 0;
  const fail = (m: string): void => {
    console.error(`  FAIL: ${m}`);
    errors++;
  };
  console.log("[docs-nav-check] nav ↔ files");
  const targets = navTargets();
  if (targets.length === 0) fail("no nav entries found in mkdocs.yml");
  const navSet = new Set(targets);

  // 1. nav entries exist.
  for (const t of targets) {
    if (!fs.existsSync(path.join(DOCS, t))) fail(`nav entry has no file: docs/${t}`);
  }

  // 2. orphans (docs not in nav) — reported, not fatal (registry.json etc. are generated).
  const allDocs = listDocs(DOCS);
  const IGNORE_ORPHAN = new Set(["registry.json"]);
  const orphans = allDocs.filter((d) => !navSet.has(d) && !IGNORE_ORPHAN.has(d));
  if (orphans.length) {
    console.log(`  NOTE: ${orphans.length} doc(s) not in nav: ${orphans.join(", ")}`);
  }

  // 3. relative links inside nav'd docs resolve.
  console.log("[docs-nav-check] internal links");
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const t of targets) {
    const file = path.join(DOCS, t);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(linkRe)) {
      const link = m[1] ?? "";
      let target = link.trim();
      if (/^(https?:|mailto:|#)/.test(target)) continue; // external / anchor
      target = target.split("#")[0]?.split("?")[0] ?? "";
      if (!target) continue;
      if (target.startsWith("/")) continue; // site-absolute; skip
      const resolved = path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) fail(`broken link in docs/${t}: ${link}`);
    }
  }
  if (errors === 0) console.log("[docs-nav-check] OK: nav entries exist and internal links resolve.");
  return errors === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!checkDocsNav()) process.exit(1);
}
