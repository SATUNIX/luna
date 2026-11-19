#!/usr/bin/env node
/**
 * /packages (packages/core/lib/user-packages.ts, packages/core/packages.ts, AUTHORITY) against a
 * local fixture registry and a stub `pi`:
 *   - the registry: https, or http to loopback only, no credentials in the URL, capped bodies;
 *   - search and review only read; a review shows install scripts, dependencies, maintainers and age;
 *   - add pins the exact version and sha512 into pi-kit/user-packages.json, installs with scripts
 *     off at user scope, and verifies npm's recorded integrity (removing the package when it differs);
 *   - add is refused before pi runs without an accepted integrity, when the registry now serves
 *     another one, when the tarball's bytes do not hash to it (tampered), when the tarball is on
 *     another origin, for a kit companion, and for a package already added;
 *   - remove removes only what the ledger recorded and leaves kit companions alone;
 *   - the /packages command: an add or remove needs an interactive root session, asks, passes the
 *     integrity it showed, and reads success back from the ledger.
 * Hermetic: a temporary agent directory, a loopback registry and a stub pi on PATH.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakePi, isolateKitEnv, loadModule } from "../packages/core/eval/harness.ts";
import { readSources } from "../packages/core/lib/sources.ts";
import { npmSpec } from "../packages/core/lib/companions.ts";
import { cappedFetcher, readLedger, registryUrl, reviewPackage, userPackagesPath } from "../packages/core/lib/user-packages.ts";
import { main } from "../packages/core/packages.ts";
import type * as SessionHelpers from "../packages/extensions/src/session-helpers/index.ts";

type SessionHelpersView = Omit<typeof SessionHelpers, "default"> & { default: (api: ReturnType<typeof fakePi>["api"]) => void };

const restoreEnv = isolateKitEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-userpkg-"));
const agent = path.join(work, "agent");
const bin = path.join(work, "bin");
const log = path.join(work, "pi.log");
const lockFixture = path.join(work, "lock.json");
fs.mkdirSync(path.join(agent, "pi-kit"), { recursive: true });
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "pi"), [
  "#!/bin/sh",
  'echo "$* ignore=${npm_config_ignore_scripts:-}" >> "$PI_STUB_LOG"',
  'case "$1" in install) mkdir -p "$PI_CODING_AGENT_DIR/npm"; cp "$PI_STUB_LOCK" "$PI_CODING_AGENT_DIR/npm/package-lock.json";; esac',
  "exit 0",
].join("\n"), { mode: 0o755 });

const sri = (bytes: Buffer): string => `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
const TARBALL = Buffer.from("fixture tarball for pi-demo 1.2.0");
const OTHER = Buffer.from("fixture tarball for pi-other 0.1.0");
const companion = readSources(path.join(ROOT, "packages", "core", "sources.json")).external.map((e) => npmSpec(e.source)?.name).find((n): n is string => typeof n === "string");
assert.ok(companion, "sources.json has an npm companion to test with");

// The fixture registry. `tamper` serves other bytes for the tarball; `move` puts it on another origin.
const state = { tamper: false, move: false, big: false };
let base = "";
const packument = (name: string, version: string, bytes: Buffer, extra: object = {}) => ({
  name, "dist-tags": { latest: version },
  versions: { [version]: { name, version, description: `the ${name} fixture`, dist: { integrity: sri(bytes), tarball: `${state.move ? "http://127.0.0.2:9" : base}/${name}/-/${name}-${version}.tgz` }, ...extra } },
  time: { [version]: "2026-01-01T00:00:00.000Z" },
});
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/-/v1/search") {
    assert.match(url.searchParams.get("text") ?? "", /^keywords:pi-package/);
    json(200, { objects: [{ package: { name: "pi-demo", version: "1.2.0", description: "demo\u0007" } }, { package: { name: "../evil", version: "1" } }] });
  } else if (url.pathname === "/pi-demo") {
    if (state.big) { res.writeHead(200); res.end("x".repeat(4096)); return; }
    json(200, packument("pi-demo", "1.2.0", TARBALL, { scripts: { postinstall: "node steal.js", test: "x" }, dependencies: { "left-pad": "1.3.0" }, maintainers: [{ name: "alice" }] }));
  } else if (url.pathname === "/pi-other") json(200, packument("pi-other", "0.1.0", OTHER));
  else if (url.pathname === "/pi-sha1") json(200, { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { dist: { integrity: "sha1-qL7t3E6xvvsl7gpJGqg7Fh4AObs=", tarball: `${base}/x.tgz` } } } });
  else if (url.pathname === "/pi-nosha") json(200, { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { dist: { shasum: "abc", tarball: `${base}/x.tgz` } } } });
  else if (companion && url.pathname === `/${companion.replace("/", "%2f")}`) json(200, packument(companion, "9.9.9", OTHER));
  else if (url.pathname === "/pi-demo/-/pi-demo-1.2.0.tgz") { res.writeHead(200); res.end(state.tamper ? Buffer.from("tampered") : TARBALL); }
  else if (url.pathname === "/pi-other/-/pi-other-0.1.0.tgz") { res.writeHead(200); res.end(OTHER); }
  else json(404, { error: "not found" });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address !== null && typeof address === "object");
base = `http://127.0.0.1:${String(address.port)}`;

const setLock = (name: string, version: string, integrity: string) => fs.writeFileSync(lockFixture, JSON.stringify({ packages: { [`node_modules/${name}`]: { version, integrity } } }));
const piCalls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const ledgerFile = userPackagesPath(agent);
const ledger = () => readLedger(ledgerFile);
const cli = async (...argv: string[]) => {
  const lines: string[] = [];
  try {
    const code = await main(argv, (l) => lines.push(l));
    return { code, out: lines.join("\n") };
  } catch (error) {
    return { code: 1, out: `${lines.join("\n")}\n${error instanceof Error ? error.message : String(error)}` };
  }
};

try {
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, npm_config_registry: base, PI_STUB_LOG: log, PI_STUB_LOCK: lockFixture, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });

  // --- the registry ---------------------------------------------------------------------------------
  assert.equal(registryUrl({}).origin, "https://registry.npmjs.org");
  assert.throws(() => registryUrl({ npm_config_registry: "http://registry.example.com" }), /only https \(or http to loopback\)/);
  assert.throws(() => registryUrl({ npm_config_registry: "https://user:pw@registry.example.com" }), /carries credentials/);
  assert.equal(registryUrl({ npm_config_registry: "http://localhost:4873" }).origin, "http://localhost:4873");
  state.big = true;
  await assert.rejects(reviewPackage("pi-demo", undefined, registryUrl(), cappedFetcher(1000)), /limit is 1000|over the 1000-byte limit/, "a response over the cap is an error, never truncated data");
  state.big = false;
  console.log("  OK: https or loopback http only, no credentials in the URL, capped bodies");

  // --- search and review (read-only) ----------------------------------------------------------------
  const search = await cli("search", "demo");
  assert.equal(search.code, 0, search.out);
  assert.match(search.out, /pi-demo@1\.2\.0 - demo /, "control characters are stripped");
  assert.ok(!search.out.includes("evil"), "a result that is not a package name is dropped");
  assert.match(search.out, /UNREVIEWED/);
  const review = await cli("review", "pi-demo");
  assert.equal(review.code, 0, review.out);
  for (const want of [/^UNREVIEWED: pi-demo is not reviewed by Luna/m, /postinstall: node steal\.js/, /left-pad@1\.3\.0/, /maintainers: {2}alice/, /day\(s\) ago/, new RegExp(sri(TARBALL).replace(/[+/]/g, "\\$&"))]) assert.match(review.out, want);
  assert.ok(!/test: x/.test(review.out), "only scripts npm runs on install are listed");
  assert.match((await cli("review", "pi-nosha")).out, /publishes no sha512 integrity/);
  assert.match((await cli("review", "pi-sha1")).out, /publishes no sha512 integrity/, "a weaker digest cannot be pinned");
  assert.match((await cli("review", "pi-absent")).out, /not on the registry/);
  assert.match((await cli("review", "pi-demo@9.9.9")).out, /pi-demo@9\.9\.9 is not on the registry/);
  assert.deepEqual(piCalls(), [], "searching and reviewing never run pi");
  assert.ok(!fs.existsSync(ledgerFile), "nor write the ledger");
  console.log("  OK: search and review read only; the review shows scripts, dependencies, maintainers, age and integrity");

  // --- add refusals before pi runs ------------------------------------------------------------------
  assert.match((await cli("add", "pi-demo@1.2.0")).out, /add needs --accept/, "an add is never unattended");
  assert.match((await cli("add", "pi-demo@1.2.0", "--accept")).out, /add needs --accept/);
  assert.match((await cli("add", "pi-demo", "--accept", sri(TARBALL))).out, /name the exact version/);
  assert.match((await cli("add", "pi-demo@1.2.0", "--accept", sri(OTHER))).out, /now serves integrity .* not the .* you accepted/, "the registry changed since the review");
  state.tamper = true;
  assert.match((await cli("add", "pi-demo@1.2.0", "--accept", sri(TARBALL))).out, /the tarball hashes to .* not the pinned .*refusing it/, "a tampered tarball is refused");
  state.tamper = false;
  state.move = true;
  assert.match((await cli("add", "pi-demo@1.2.0", "--accept", sri(TARBALL))).out, /the tarball is on http:\/\/127\.0\.0\.2:9, not the registry/);
  state.move = false;
  assert.match((await cli("add", `${companion}@9.9.9`, "--accept", sri(OTHER))).out, /is a Luna companion or Luna itself/, "a kit companion is never added here");
  assert.match((await cli("add", "@satunix/pi-system@1.0.0", "--accept", sri(OTHER))).out, /is a Luna companion or Luna itself/);
  assert.deepEqual(piCalls(), [], "every refusal comes before pi runs");
  assert.ok(!fs.existsSync(ledgerFile));
  console.log("  OK: add is refused before pi runs without acceptance, on a changed or tampered pin, another origin or a kit package");

  // --- add pins and verifies ------------------------------------------------------------------------
  setLock("pi-demo", "1.2.0", sri(TARBALL));
  const added = await cli("add", "pi-demo@1.2.0", "--accept", sri(TARBALL));
  assert.equal(added.code, 0, added.out);
  assert.match(added.out, /UNREVIEWED by Luna/);
  assert.deepEqual(piCalls(), ["install npm:pi-demo@1.2.0 ignore=true"], "user scope (no -l), lifecycle scripts off");
  const [entry] = ledger();
  assert.ok(entry);
  assert.deepEqual({ ...entry, acceptedAt: "" }, { name: "pi-demo", version: "1.2.0", source: "npm:pi-demo@1.2.0", integrity: sri(TARBALL), review: "user-accepted", acceptedAt: "" });
  assert.equal(fs.statSync(ledgerFile).mode & 0o777, 0o600, "the ledger is 0600");
  assert.match((await cli("add", "pi-demo@1.2.0", "--accept", sri(TARBALL))).out, /already added/);
  assert.match((await cli("list")).out, /npm:pi-demo@1\.2\.0 {2}UNREVIEWED/);
  // npm recorded another integrity: the package is removed again and not recorded.
  setLock("pi-other", "0.1.0", sri(TARBALL));
  const mismatch = await cli("add", "pi-other@0.1.0", "--accept", sri(OTHER));
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.out, /npm recorded integrity .*removed it again/);
  assert.deepEqual(piCalls().slice(1), ["install npm:pi-other@0.1.0 ignore=true", "remove npm:pi-other@0.1.0 ignore="]);
  assert.deepEqual(ledger().map((p) => p.name), ["pi-demo"]);
  console.log("  OK: add pins version and sha512, installs with scripts off at user scope, and verifies npm's record");

  // --- remove ---------------------------------------------------------------------------------------
  fs.writeFileSync(log, "");
  assert.match((await cli("remove", companion)).out, /is a Luna companion; \/packages removes only what it added/, "kit companions are left alone");
  assert.match((await cli("remove", "pi-other")).out, /was not added with \/packages, so it is left alone/);
  assert.deepEqual(piCalls(), []);
  const removed = await cli("remove", "pi-demo");
  assert.equal(removed.code, 0, removed.out);
  assert.deepEqual(piCalls(), ["remove npm:pi-demo@1.2.0 ignore="]);
  assert.deepEqual(ledger(), []);
  fs.writeFileSync(ledgerFile, JSON.stringify({ schemaVersion: 1, packages: [{ name: "pi-x", version: "1.0.0", source: "npm:pi-y@1.0.0", integrity: sri(OTHER), review: "user-accepted", acceptedAt: "t" }] }));
  assert.match((await cli("list")).out, /not a valid pin/, "a hand-edited pin that names another source is refused");
  fs.rmSync(ledgerFile);
  console.log("  OK: remove removes only what the ledger recorded; companions are left alone");

  // --- the /packages command ------------------------------------------------------------------------
  process.env.PI_KIT_ROOT = ROOT;
  fs.writeFileSync(log, "");
  setLock("pi-demo", "1.2.0", sri(TARBALL));
  const helpers = await loadModule<SessionHelpersView>("extensions/session-helpers/index.ts");
  const pi = fakePi({ cwd: work });
  helpers.default(pi.api);
  const notes: string[] = [];
  const titles: string[] = [];
  let answer = (options: string[]) => options[0];
  const ctx = (hasUI: boolean) => ({ cwd: work, hasUI, ui: { notify: (m: string) => notes.push(m), select: async (title: string, options: string[]) => { titles.push(title); return answer(options); }, confirm: async () => false, setStatus() {} } });
  const run = async (args: string, hasUI = true) => { await pi.commands.get("packages").handler(args, ctx(hasUI)); return notes.at(-1) ?? ""; };
  assert.match(await run("add pi-demo", false), /needs a choice at the terminal of an interactive root session/);
  assert.match(await run("add pi-demo"), /not added; nothing was changed/, "the safe answer is the default");
  assert.match(titles.at(-1) ?? "", /UNREVIEWED: pi-demo[\s\S]*postinstall: node steal\.js[\s\S]*Add it\?/, "the operator sees the review before choosing");
  assert.deepEqual(piCalls(), []);
  answer = (options) => options[1];
  await run("add pi-demo");
  assert.ok(notes.some((n) => /run \/reload to load it/.test(n)), notes.join("\n"));
  assert.deepEqual(ledger().map((p) => [p.name, p.integrity]), [["pi-demo", sri(TARBALL)]], "the command passed the integrity it showed");
  assert.match(await run(`add ${companion}`), /is a Luna companion or Luna itself/);
  // pi.exec reports a signal-killed child as code 0: success is read from the ledger, not the code.
  const realExec = pi.api.exec;
  pi.api.exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => (args.includes("add") ? Promise.resolve({ stdout: "", stderr: "", code: 0, killed: true }) : realExec(command, args, options));
  notes.length = 0;
  await run("add pi-other");
  assert.ok(notes.some((n) => /packages: \(no output\)/.test(n)) && !notes.some((n) => /run \/reload/.test(n)), `a killed add is not reported as added: ${notes.join(" | ")}`);
  pi.api.exec = realExec;
  assert.match(await run("list"), /npm:pi-demo@1\.2\.0/);
  await run("remove pi-demo");
  assert.deepEqual(ledger(), []);
  assert.match(await run("frobnicate x"), /usage: \/packages/);
  console.log("  OK: /packages asks at an interactive root terminal, shows the review, and records what it accepted");
} finally {
  server.close();
  restoreEnv();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log("[user-packages-smoke] OK");
