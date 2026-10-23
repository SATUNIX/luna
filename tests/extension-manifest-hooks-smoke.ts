#!/usr/bin/env node
/**
 * WU-3 regression coverage: the extension hook contract must be accurate in three
 * places at once.
 *
 *   1. Every hook declared in an `extension.json` must exist in the schema enum
 *      (`packages/core/schema/extension.schema.json` → hooks.items.enum) and must
 *      actually be registered by a `pi.on("<hook>", ...)` in that extension's `.ts`
 *      files. `verify.ts` only checks code -> manifest; this closes the reverse
 *      (manifest -> code) direction that let `todo` declare `session_start` while
 *      never registering it.
 *   2. The hooks table in `docs/WRITING_EXTENSIONS.md` must not name anything
 *      outside the schema enum (it used to list `message`, `session_end`, `compact`
 *      and `error`, none of which exist).
 *
 * Fully hermetic: reads local files only — no pi, docker, or network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(ROOT, "packages", "core", "schema", "extension.schema.json");
const DOC = path.join(ROOT, "docs", "WRITING_EXTENSIONS.md");
const EXTENSION_ROOTS = [
  path.join(ROOT, "packages", "extensions", "src"),
  path.join(ROOT, "packages", "extensions", "third_party"),
];

// The doc accidentally shipped these non-existent hooks; keep them called out so a
// regression is reported by name rather than merely as "not in enum".
const FICTIONAL_HOOKS = ["message", "session_end", "compact", "error"];

/** The slice of extension.schema.json this smoke reads. */
interface ExtensionSchema {
  properties: { hooks: { items: { enum: string[] } } };
}
/** The extension.json fields this smoke inspects (arrays are re-checked at runtime). */
interface ExtensionManifest {
  name: string;
  hooks?: string[];
  env?: string[];
  runtime?: { nodeBuiltins?: string[] };
}

const schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8")) as ExtensionSchema;
const hookEnum = schema.properties.hooks.items.enum;
assert.ok(Array.isArray(hookEnum) && hookEnum.length > 0, "schema hooks enum must be a non-empty array");
const hookSet = new Set(hookEnum);
// Hard assertions on the enum itself: a silent removal of a host hook must fail here.
// Pinned to the host set as of the 36-hook contract; do NOT compare against the installed
// package at runtime (that would couple the schema to a package version).
const REQUIRED_HOOKS = [
  "agent_settled",
  "before_provider_headers",
  "project_trust",
  "session_compact_failed",
  "session_info_changed",
  "ui_prompt_start",
  "ui_prompt_end",
];
assert.equal(hookEnum.length, 36, `schema hooks enum must contain exactly 36 hooks, found ${hookEnum.length}`);
assert.equal(hookSet.size, hookEnum.length, "schema hooks enum must not contain duplicates");
for (const hook of REQUIRED_HOOKS) {
  assert.ok(hookSet.has(hook), `schema hooks enum must contain host hook "${hook}"`);
}
console.log(`OK: loaded ${hookEnum.length} hooks from schema enum`);

// --- Walk every extension.json under both extension roots ---
function extensionDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "extension.json")));
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function registeredHooks(dir: string): Set<string> {
  const hooks = new Set<string>();
  const re = /pi\.on\(\s*["']([a-zA-Z_]+)["']/g;
  for (const file of listTsFiles(dir)) {
    const src = fs.readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) if (m[1]) hooks.add(m[1]);
  }
  return hooks;
}

let extensionCount = 0;
for (const root of EXTENSION_ROOTS) {
  for (const dir of extensionDirs(root)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8")) as ExtensionManifest;
    const declared = manifest.hooks ?? [];
    assert.ok(Array.isArray(declared), `${manifest.name}: hooks must be an array`);
    const registered = registeredHooks(dir);
    for (const hook of declared) {
      assert.ok(hookSet.has(hook), `${manifest.name}: declared hook "${hook}" is not in the schema enum`);
      assert.ok(
        registered.has(hook),
        `${manifest.name}: declares hook "${hook}" but no pi.on("${hook}", ...) is registered in its .ts files`,
      );
    }
    extensionCount++;
  }
}
console.log(`OK: ${extensionCount} extension manifests declare only schema hooks that are registered in code`);

// --- B-021: targeted env[] allowlist for extensions whose manifest drifted from code ---
// Only these two are pinned; a general bidirectional env check would fail on many other
// extensions (skill-router, todo, verifier-board, orchestrator internal vars, ...).
const ENV_ALLOWLIST: Record<string, string[]> = {
  orchestrator: ["PI_KIT_ORCH_THRESHOLD", "PI_KIT_ORCH_DISABLE"],
  "branch-lab": ["PI_KIT_BRANCH_LEASES_FILE", "PI_KIT_MAX_BRANCHES"],
};
let envChecked = 0;
for (const root of EXTENSION_ROOTS) {
  for (const dir of extensionDirs(root)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8")) as ExtensionManifest;
    const expected: string[] | undefined = ENV_ALLOWLIST[manifest.name];
    if (!expected) continue;
    const declaredEnv = manifest.env ?? [];
    assert.ok(Array.isArray(declaredEnv), `${manifest.name}: env must be an array`);
    assert.deepEqual(
      [...declaredEnv].sort(),
      [...expected].sort(),
      `${manifest.name}: env[] must declare exactly [${expected.join(", ")}], found [${declaredEnv.join(", ")}]`,
    );
    envChecked++;
  }
}
assert.equal(envChecked, Object.keys(ENV_ALLOWLIST).length, "the env[] allowlist must match extensions that exist");
console.log(`OK: ${envChecked} pinned extensions declare the exact env vars their code reads`);

// --- C2: runtime.nodeBuiltins must cover every node:* import in the extension's .ts files ---
// The save manifest declared ["fs", "path"] while index.ts also imported `node:os`,
// so a shipped extension could reach a builtin its manifest never allowed. For every
// shipped manifest (skipping `_`-prefixed scaffolds) walk EVERY `.ts` file under the
// extension directory (recursively, skipping node_modules) and collect `node:*`
// specifiers from static imports (`from "node:x"` / `import "node:x"`),
// `require("node:x")`, and dynamic `import("node:x")`, then assert each is covered by
// runtime.nodeBuiltins. A declared bare name ("fs") covers the prefixed form (`node:fs`)
// and any `node:fs/...` subpath; `node:` is normalised on both sides.
function normalizeBuiltin(spec: string): string {
  return spec.replace(/^node:/, "");
}

// B-010 / B-012: comment/string-aware view of TS source for the nodeBuiltins scan. Line and block
// comments are replaced with a space, as are the delimiters/content of string, template and regex
// literals. The one exception: a specifier string that directly follows `from`, `import(` or
// `require(` is kept verbatim, because the scanner regex matches the quoted specifier —
// blanking it would also hide real imports. Escaped quotes (`\`) are handled. Template-literal
// `${...}` interpolation is deliberately not scanned (it is dropped with the literal).
//
// B-012: regex literals (e.g. /\"/, /\'/, /[/"']/) carry quote characters that used to be
// mistaken for string starts; the resulting "string" swallowed the opening quote of a following
// import, so collectNodeBuiltins() missed a real `node:` builtin and the guard silently passed.
// `slashIsRegex` disambiguates regex from division by inspecting the previous significant
// emitted character (or trailing keyword). Blanking an actual regex is safe: a regex never
// directly precedes `from`, so no import specifier can be hidden by the space it emits.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);
const REGEX_PRECEDING_CHARS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);

function slashIsRegex(out: string): boolean {
  // `out` is everything emitted so far. Find the previous significant (non-whitespace) char.
  let k = out.length - 1;
  while (k >= 0 && /\s/.test(out.charAt(k))) k--;
  if (k < 0) return true; // start of input => regex
  const prev = out.charAt(k);
  // Identifier char, ')' ']' or a quote/backtick means division — unless the trailing token is
  // a keyword such as `return`/`typeof`/`in`/`of`, which is followed by an expression (regex).
  if (/[A-Za-z0-9_$)\]'"`]/.test(prev)) {
    const m = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(out.slice(0, k + 1));
    if (m?.[1] && REGEX_PRECEDING_KEYWORDS.has(m[1])) return true;
    return false;
  }
  return REGEX_PRECEDING_CHARS.has(prev);
}

function stripCommentsAndStrings(src: string): string {
  const importSpecifier = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)$/;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "/" && next !== "/" && next !== "*" && slashIsRegex(out)) {
      // Regex literal: scan the body honouring backslash escapes and [...] character classes
      // (a `/` inside a class does not terminate the regex), then consume trailing flags.
      let j = i + 1;
      let inClass = false;
      let terminated = false;
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break; // a regex cannot span a newline => unterminated
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          j++;
          terminated = true;
          break;
        }
        j++;
      }
      if (terminated) {
        while (j < src.length && /[a-zA-Z]/.test(src.charAt(j))) j++;
        out += " ";
        i = j;
        continue;
      }
      // Unterminated: not a real regex literal; fall through and emit the slash verbatim.
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === ch) {
          j++;
          break;
        } else j++;
      }
      out += importSpecifier.test(out) ? src.slice(i, Math.min(j, src.length)) : " ";
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function collectNodeBuiltins(dir: string): Map<string, Set<string>> {
  // normalized specifier -> Set of files that reference it (for error messages)
  const specifiers = new Map<string, Set<string>>();
  const re = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)['"](node:[^'"]+)['"]/g;
  for (const file of listTsFiles(dir)) {
    const src = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
    let m = re.exec(src);
    while (m) {
      const spec = normalizeBuiltin(m[1] ?? "");
      let files = specifiers.get(spec);
      if (!files) specifiers.set(spec, (files = new Set()));
      files.add(file);
      m = re.exec(src);
    }
  }
  return specifiers;
}

let builtinChecked = 0;
for (const root of EXTENSION_ROOTS) {
  for (const dir of extensionDirs(root)) {
    if (path.basename(dir).startsWith("_")) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8")) as ExtensionManifest;
    const declaredRaw = manifest.runtime?.nodeBuiltins ?? [];
    assert.ok(Array.isArray(declaredRaw), `${manifest.name}: runtime.nodeBuiltins must be an array`);
    const declared = new Set(declaredRaw.map(normalizeBuiltin));
    const specifiers = collectNodeBuiltins(dir);
    for (const [spec, files] of specifiers) {
      const covered = declared.has(spec) || [...declared].some((d) => spec.startsWith(`${d}/`));
      assert.ok(
        covered,
        `${manifest.name}: ${path.relative(ROOT, [...files][0] ?? "")} imports "node:${spec}" but runtime.nodeBuiltins ` +
          `declares [${declaredRaw.join(", ")}]`,
      );
    }
    builtinChecked++;
  }
}
console.log(`OK: ${builtinChecked} extension manifests cover every node:* import in their .ts files`);

// --- self-test: the nodeBuiltins scanner must see helper modules and require()/import() ---
// This must fail with an entry-only / static-import-only scanner. Synthetic extension
// under os.tmpdir: index.ts statically imports node:fs/node:path plus require(node:crypto)
// and import(node:http); a helper module imports node:os. The manifest declares only
// ["fs", "path"], so a correct scanner detects os (helper), crypto (require) and http
// (dynamic import) as uncovered builtins.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-nodewalk-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "extension.json"),
      JSON.stringify({ name: "selftest", runtime: { nodeBuiltins: ["fs", "path"] } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "index.ts"),
      [
        'import { readFileSync } from "node:fs";',
        'import path from "node:path";',
        'const http = await import("node:http");',
        'const crypto = require("node:crypto");',
        '// import x from "node:comment-only"',
        '/* import("node:block-comment") */',
        'const doc = "require(\\"node:in-a-string\\")";',
        // B-012: a quote-bearing regex literal used to be read as a string, swallowing the
        // opening quote of the next import and hiding a real builtin from the scanner.
        'const dbl = /"/;',
        'import { PassThrough } from "node:stream";',
        "const sgl = /'/;",
        'import zlib from "node:zlib";',
        'const cls = /[/"\']/;',
        'import events from "node:events";',
        // Division must be treated as division, not over-eagerly as a regex.
        'const ratio = 8 / 2;',
        'import util from "node:util";',
      ].join("\n"),
    );
    fs.mkdirSync(path.join(tmpDir, "lib"));
    fs.writeFileSync(
      path.join(tmpDir, "lib", "helper.ts"),
      ['import os from "node:os";', "export const helper = os;"].join("\n"),
    );
    const found = collectNodeBuiltins(tmpDir);
    assert.ok(found.has("os"), "scanner self-test: node:os imported by a helper module must be detected");
    assert.ok(found.has("http"), 'scanner self-test: dynamic import("node:http") must be detected');
    assert.ok(found.has("crypto"), 'scanner self-test: require("node:crypto") must be detected');
    assert.ok(found.has("fs") && found.has("path"), "scanner self-test: static node: imports must be detected");
    assert.ok(!found.has("comment-only"), "scanner self-test: node: spec inside a // comment must not be detected");
    assert.ok(!found.has("block-comment"), "scanner self-test: node: spec inside a /* */ comment must not be detected");
    assert.ok(!found.has("in-a-string"), "scanner self-test: node: spec inside a string literal must not be detected");
    assert.ok(found.has("stream"), 'scanner self-test: regex /"/ must not hide a following node:stream import');
    assert.ok(found.has("zlib"), "scanner self-test: regex /'/ must not hide a following node:zlib import");
    assert.ok(
      found.has("events"),
      "scanner self-test: regex character class /[/\"']/ must not hide a following node:events import",
    );
    assert.ok(found.has("util"), "scanner self-test: division (8 / 2) must not hide a following node:util import");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
console.log("OK: nodeBuiltins scanner self-test detects helper-module and dynamic/require imports");


// --- Parse the hooks table in the docs (the `## Hooks` section) ---
const docLines = fs.readFileSync(DOC, "utf8").split(/\r?\n/);
const hooksHeading = docLines.findIndex((l) => /^##\s+Hooks\s*$/.test(l));
assert.ok(hooksHeading !== -1, `${path.relative(ROOT, DOC)} must have a "## Hooks" section`);

const docHooks: string[] = [];
for (let i = hooksHeading + 1; i < docLines.length; i++) {
  const line = docLines[i] ?? "";
  if (/^##\s/.test(line)) break; // next section
  if (!/^\s*\|/.test(line)) continue;
  const firstCell = line.split("|")[1]?.trim() ?? "";
  const m = firstCell.match(/^`([a-zA-Z_]+)`$/);
  if (m?.[1]) docHooks.push(m[1]);
}
assert.ok(docHooks.length > 0, "the hooks table must name at least one hook");
console.log(`OK: parsed ${docHooks.length} hook names from the WRITING_EXTENSIONS.md hooks table`);

for (const hook of docHooks) {
  assert.ok(hookSet.has(hook), `WRITING_EXTENSIONS.md hooks table names "${hook}", which is not in the schema enum`);
}
for (const hook of REQUIRED_HOOKS) {
  assert.ok(
    docHooks.includes(hook),
    `WRITING_EXTENSIONS.md hooks table must document host hook "${hook}"`,
  );
}
for (const fictional of FICTIONAL_HOOKS) {
  assert.ok(
    !docHooks.includes(fictional),
    `WRITING_EXTENSIONS.md hooks table must not name the fictional hook "${fictional}"`,
  );
}
console.log("OK: documented hooks are a subset of the schema enum (no fictional hooks)");

console.log("OK: extension hook contract is consistent (manifest, code, schema, docs)");
