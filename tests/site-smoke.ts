#!/usr/bin/env node
/**
 * Website and illustrations (docs/website.md). Pins:
 *   1. the committed docs/assets/luna-*.svg are exactly what packages/core/readme-art.ts generates,
 *      and nothing else under that name is committed;
 *   2. every illustration is well-formed SVG with a title and description, runs no script, loads
 *      nothing, has a reduced-motion rule, and stays within its size budget;
 *   3. the built page fills every placeholder with the package.json release, runs no script, keeps
 *      its content security policy, and every local link, image and fragment resolves (a docs/
 *      link to a page mkdocs builds from docs/);
 *   4. every <picture> in the README and the page pairs a light image with its -dark variant;
 *   5. build-site.ts writes the files into an empty directory and refuses a non-empty one, and an
 *      unknown or unfilled placeholder fails;
 *   6. mkdocs loads the Proof stylesheet and no syntax highlighter.
 * Deterministic and offline.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fill, pickRelease, release, siteFiles } from "../packages/core/build-site.ts";
import { artFiles } from "../packages/core/readme-art.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "docs", "assets");
const SVG_BUDGET = 32 * 1024;
let passed = 0;

/**
 * Problems with an XML document's structure: every tag closes in order, nothing is left open, and
 * text holds no raw `<` and only the five XML entities. Enough for the generated SVGs, which have no
 * comments, CDATA or processing instructions.
 */
export function xmlProblems(xml: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  let last = 0;
  const text = (chunk: string): void => {
    if (chunk.includes("<")) out.push(`a raw "<" in text near ${JSON.stringify(chunk.slice(0, 40))}`);
    for (const m of chunk.matchAll(/&([^;\s]*);?/g)) if (!/^(?:amp|lt|gt|quot|apos)$/.test(m[1] ?? "") || !m[0].endsWith(";")) out.push(`a bad entity ${m[0]}`);
  };
  for (const m of xml.matchAll(tag)) {
    text(xml.slice(last, m.index));
    last = m.index + m[0].length;
    const [, close, name = "", , self] = m;
    if (close) {
      const open = stack.pop();
      if (open !== name) out.push(`</${name}> closes <${open ?? "nothing"}>`);
    } else if (!self) stack.push(name);
  }
  text(xml.slice(last));
  for (const open of stack) out.push(`<${open}> is never closed`);
  return out;
}

/** Every value of the attribute `name` in a document. */
function attrs(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1] ?? "");
}
const ok = (message: string): void => {
  passed += 1;
  console.log(`ok - ${message}`);
};

// 1. Generated art is current, and no hand-made file hides among it.
const art = artFiles();
for (const [name, body] of art) assert.equal(fs.readFileSync(path.join(ASSETS, name), "utf8"), body, `docs/assets/${name} is stale: run node packages/core/readme-art.ts`);
const committed = fs.readdirSync(ASSETS).filter((n) => /^luna-.*\.svg$/.test(n)).sort();
assert.deepEqual(committed, [...art.keys()].sort(), "docs/assets/luna-*.svg holds only generated files");
assert.ok(!fs.existsSync(path.join(ASSETS, "luna.gif")), "the retired GIF is not committed");
ok(`${art.size} illustrations match the generator`);

// 2. Each illustration is safe to embed and small.
const BANNED: ReadonlyArray<[RegExp, string, string]> = [
  [/<script\b/i, "a script element", "<script>"],
  [/<foreignObject\b/i, "foreignObject", "<foreignObject>"],
  [/\bon[a-z]+\s*=/i, "an event handler attribute", "onload="],
  [/\b(?:xlink:)?href\s*=/i, "a link or external reference", 'href="x"'],
  [/url\(\s*['"]?(?!#)/i, "a url() that is not a local fragment", "url(https://x)"],
  [/@import\b/i, "an @import", "@import"],
  [/<image\b/i, "an embedded image", "<image>"],
];
for (const [name, body] of art) {
  assert.ok(Buffer.byteLength(body) <= SVG_BUDGET, `${name} is ${Buffer.byteLength(body)} bytes, over the ${SVG_BUDGET}-byte budget`);
  for (const [pattern, what] of BANNED) assert.ok(!pattern.test(body), `${name} contains ${what}`);
  assert.deepEqual(xmlProblems(body), [], `${name} is well-formed`);
  assert.match(body, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" [^>]*role="img"/, `${name} is an SVG with role="img"`);
  assert.ok((/<title id="t">([^<]{6,})<\/title>/.exec(body)?.[1] ?? "").length > 5, `${name} has a title`);
  assert.ok((/<desc id="d">([^<]{41,})<\/desc>/.exec(body)?.[1] ?? "").length > 40, `${name} has a description`);
  assert.match(body, /@media \(prefers-reduced-motion:reduce\)\{\*\{animation-delay:-[\d.]+s!important;animation-play-state:paused!important\}\}/, `${name} pauses on a still frame for reduced motion`);
  assert.match(body, /@keyframes /, `${name} is animated`);
}
assert.ok(xmlProblems("<svg><g></svg>").length > 0 && xmlProblems("<svg>a < b</svg>").length > 0 && xmlProblems("<svg>&nbsp;</svg>").length > 0, "the well-formedness check detects its cases");
for (const [pattern, what, sample] of BANNED) assert.ok(pattern.test(sample), `the ${what} rule detects its case`);
ok("every illustration is well-formed, script-free, loads nothing and is within budget");

// 3. The page.
// The page names the newest pushed tag at or below package.json, never a version whose tag is not
// pushed yet. Synthetic tag lists, so a shallow checkout without tags tests the same thing.
const pkgVersion = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
assert.deepEqual(pickRelease("0.3.0-beta.1", ["v0.2.4-beta.1", "v0.2.4-beta.9", "v0.2.4-beta.10"]), { version: "0.2.4-beta.10", tag: "v0.2.4-beta.10", pending: "0.3.0-beta.1" }, "a release whose tag is not pushed keeps the previous tag and reports it as pending");
assert.deepEqual(pickRelease("0.3.0-beta.1", ["v0.2.4-beta.9", "v0.3.0-beta.1"]), { version: "0.3.0-beta.1", tag: "v0.3.0-beta.1", pending: null }, "once the tag is pushed the page names it");
assert.equal(pickRelease("0.3.0-beta.1", ["v0.3.0-beta.1", "v0.3.0", "v1.0.0", "v-next", "cycle-01", "0.2.0"]).tag, "v0.3.0-beta.1", "tags above package.json and non-release tags are never named");
assert.equal(pickRelease("0.3.0", ["v0.3.0-beta.2", "v0.3.0-beta.10"]).tag, "v0.3.0-beta.10", "prereleases compare numerically");
assert.throws(() => pickRelease("0.3.0", []), /no v\* release tag/, "a checkout without tags fails the build instead of naming an untagged version");
assert.throws(() => pickRelease("0.3.0", ["v0.4.0"]), /no v\* release tag/, "only tags above package.json also fail");
assert.deepEqual(release(ROOT, [`v${pkgVersion}`]), { version: pkgVersion, tag: `v${pkgVersion}`, pending: null }, "release() reads package.json");
const tag = "v9.8.7-beta.6";
const files = siteFiles(ROOT, { version: "9.8.7-beta.6", tag, pending: null });
const html = files.get("index.html");
assert.ok(html !== undefined, "the site has an index.html");
assert.ok(!html.includes("{{"), "every placeholder is filled");
assert.ok(html.includes(`pi install git:github.com/SATUNIX/luna@${tag}`), `the page installs the release it is given (${tag})`);
assert.ok(!/<script\b/i.test(html) && !/\son[a-z]+\s*=/i.test(html) && !/javascript:/i.test(html), "the page runs no script");
const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1] ?? "";
for (const directive of ["default-src 'none'", "img-src 'self'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive), `the CSP has ${directive}`);
assert.ok(!/script-src/.test(csp), "the CSP allows no script source");
assert.deepEqual(xmlProblems(html.replace(/^<!doctype html>/i, "").replace(/<(meta|link|img|source|br)\b([^>]*)>/g, "<$1$2/>")), [], "the page's tags balance");
const ids = new Set(attrs(html, "id"));
const refs = ["href", "src", "srcset"].flatMap((name) => attrs(html, name)).map((ref) => ref.replace(/&amp;/g, "&"));
let checked = 0;
for (const ref of refs) {
  if (/^https:\/\//.test(ref)) {
    assert.match(ref, /^https:\/\/(?:github\.com\/SATUNIX\/luna\b|fonts\.googleapis\.com\b|fonts\.gstatic\.com\b)/, `the page links only to the repository and Google Fonts, not ${ref}`);
    continue;
  }
  assert.ok(!/^[a-z]+:/i.test(ref), `no other scheme: ${ref}`);
  checked += 1;
  if (ref.startsWith("#")) assert.ok(ids.has(ref.slice(1)), `fragment ${ref} names an element`);
  else if (ref === "./") continue;
  else if (ref.startsWith("docs/")) {
    const slug = ref.slice("docs/".length).replace(/\/$/, "");
    const md = slug === "" ? "index.md" : `${slug}.md`;
    assert.ok(fs.existsSync(path.join(ROOT, "docs", md)), `${ref} is built from docs/${md}`);
  } else assert.ok(files.has(ref), `${ref} is a file of the site`);
}
assert.ok(checked > 20, `the page's local references are checked (${checked})`);
assert.ok(files.has(".nojekyll"), "the site is served as it is (.nojekyll)");
assert.ok(html.includes(`Luna ${tag}`), "the footer names the release");
ok(`the page names ${tag}, runs no script and its ${checked} local references resolve`);

// 4. Every <picture> pairs a light image with its -dark variant.
const pictures = (text: string): Array<[string, string]> =>
  [...text.matchAll(/<picture>\s*<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)">\s*<img src="([^"]+)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]);
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
for (const [where, text] of [["README.md", readme], ["website/index.html", html]] as const) {
  const found = pictures(text);
  assert.equal(found.length, (text.match(/<picture>/g) ?? []).length, `${where}: every <picture> has the dark source first`);
  for (const [dark, light] of found) assert.equal(dark, light.replace(/\.svg$/, "-dark.svg"), `${where}: ${dark} is the dark variant of ${light}`);
}
assert.ok(pictures(readme).length >= 5, "the README shows the five illustrations");
ok("every <picture> pairs a light image with its dark variant");

// 5. The build writes into an empty directory only, and placeholders fail closed.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-site-"));
try {
  const out = path.join(temp, "_site");
  const current = `v${pkgVersion}`;
  const first = spawnSync(process.execPath, [path.join(ROOT, "packages/core/build-site.ts"), "--out", out, "--tags", `v0.0.1,${current}`], { encoding: "utf8" });
  assert.equal(first.status, 0, `build-site succeeds: ${first.stderr}`);
  assert.doesNotMatch(first.stdout, /not pushed/, "no warning once the package.json release is tagged");
  for (const name of files.keys()) assert.ok(fs.existsSync(path.join(out, name)), `build-site wrote ${name}`);
  assert.equal(fs.readFileSync(path.join(out, "index.html"), "utf8"), siteFiles(ROOT, release(ROOT, [current])).get("index.html"), "the written page is the checked one");
  const pendingOut = path.join(temp, "_pending");
  const pending = spawnSync(process.execPath, [path.join(ROOT, "packages/core/build-site.ts"), "--out", pendingOut, "--tags", "v0.0.1"], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true" } });
  assert.equal(pending.status, 0, `build-site builds with an older tag: ${pending.stderr}`);
  assert.match(pending.stdout, new RegExp(`^::warning title=Release tag missing::package\\.json is at ${pkgVersion.replace(/\./g, "\\.")} but tag ${current.replace(/\./g, "\\.")} is not pushed: the site names v0\\.0\\.1\\.`, "m"), "an untagged package.json release is a workflow warning");
  assert.ok(fs.readFileSync(path.join(pendingOut, "index.html"), "utf8").includes("luna@v0.0.1"), "and the page keeps naming the pushed tag");
  const none = spawnSync(process.execPath, [path.join(ROOT, "packages/core/build-site.ts"), "--out", path.join(temp, "_none"), "--tags", "v99.0.0"], { encoding: "utf8" });
  assert.notEqual(none.status, 0, "no usable tag fails the build");
  const second = spawnSync(process.execPath, [path.join(ROOT, "packages/core/build-site.ts"), "--out", out, "--tags", current], { encoding: "utf8" });
  assert.equal(second.status, 1, "build-site refuses a non-empty directory");
  assert.match(second.stderr, /is not empty/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
assert.throws(() => fill("{{NOPE}}", { TAG: "v1" }, "x.html"), /unknown placeholder \{\{NOPE\}\}/);
assert.throws(() => fill("{{TAG}} {{", { TAG: "v1" }, "x.html"), /unfilled placeholder/);
assert.equal(fill("a {{TAG}} b", { TAG: "v1" }, "x.html"), "a v1 b");
ok("build-site writes into an empty directory only; placeholders fail closed");

// 6. The documentation theme.
const mkdocs = fs.readFileSync(path.join(ROOT, "mkdocs.yml"), "utf8");
assert.match(mkdocs, /^extra_css:\n {2}- assets\/proof-docs\.css$/m, "mkdocs loads the Proof stylesheet");
assert.ok(fs.existsSync(path.join(ASSETS, "proof-docs.css")), "docs/assets/proof-docs.css exists");
assert.match(mkdocs, /^ {2}highlightjs: false$/m, "mkdocs loads no syntax highlighter");
ok("the documentation uses the Proof stylesheet and no highlighter");

console.log(`site smoke: ${passed} checks passed`);
