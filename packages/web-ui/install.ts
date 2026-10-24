#!/usr/bin/env node
/**
 * Standalone installer for the Pi Console web UI.
 *
 * The UI is two things in this repo:
 *   - packages/web-ui/            the zero-dependency server + browser assets
 *   - the `web-console` extension the `/console` (alias `/webui`) slash command
 *
 * This script:
 *   1. checks prerequisites (Node >= 22.19, the pi CLI, the server files)
 *   2. registers the `web-console` extension with pi via the kit installer when no
 *      kit is installed yet, and explains how to enable it when one already is
 *   3. prints how to start the UI
 *
 * It is non-destructive: it never rewrites an existing kit install's extension set.
 *
 * Usage:
 *   node packages/web-ui/install.ts [--start] [--dry-run] [--help]
 *
 *   --start     also launch the server now and print the URL
 *   --dry-run   show what would happen without running the installer
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseJson } from "../core/lib/guard.ts";
import { KitMarkerSchema, type KitMarker } from "../core/lib/settings.ts";
import { applyExtensionOverrides, listProfiles, loadProfileDef, overridesPath, readOverrides } from "../core/lib/profiles.ts";

const WEB_UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB_UI_DIR, "..", "..");
const INSTALLER = path.join(ROOT, "packages", "core", "install.ts");

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const dryRun = has("--dry-run");
const start = has("--start");

if (has("--help") || has("-h")) {
  console.log(`Usage: node packages/web-ui/install.ts [--start] [--dry-run]`);
  process.exit(0);
}

const problems: string[] = [];

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function resolveCommand(name: string): string | null {
  const pathEnv = process.env.Path || process.env.PATH || "";
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, `${name}${ext}`))) return path.join(dir, `${name}${ext}`);
    }
  }
  return null;
}

/**
 * The install marker, or null when there is none (missing, unparseable, or a falsy JSON value).
 * Any other JSON value means a kit is installed: one that is not a marker object is treated as
 * a custom install, which this script never touches.
 */
function readMarker(): KitMarker | null {
  // Match uninstall.ts: a project marker in the cwd wins, otherwise the global marker.
  const projectMarker = path.join(process.cwd(), ".pi", ".pi-kit.json");
  const file = fs.existsSync(projectMarker) ? projectMarker : path.join(agentDir(), ".pi-kit.json");
  let parsed: unknown;
  try {
    parsed = parseJson(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (!isRecord(parsed)) return {};
  const marker = KitMarkerSchema.parse(parsed, file);
  // The schema drops a field of the wrong type; for the scope that would silently retarget the
  // reconcile at the default scope, so a scope that is present but unknown stops the install.
  if (Object.hasOwn(parsed, "scope") && parsed.scope != null && marker.scope === undefined) {
    console.error(`[web-ui] FAIL: ${file} names an unknown scope (${JSON.stringify(parsed.scope)}); fix or remove the marker before installing.`);
    process.exit(1);
  }
  return marker;
}

/**
 * The extensions a profile reinstall would select (the profile's `include` with the operator's
 * overrides applied, as the kit installer computes it), or null when the profile cannot be read;
 * the kit installer then reports that itself.
 */
function profileSelection(profile: string): string[] | null {
  try {
    return applyExtensionOverrides(loadProfileDef(profile).include ?? [], readOverrides());
  } catch {
    return null;
  }
}

/** The profiles whose own `include` lists web-console. */
function profilesWithWebConsole(): string[] {
  return listProfiles().filter((name) => {
    try {
      return (loadProfileDef(name).include ?? []).includes("web-console");
    } catch {
      return false;
    }
  });
}

console.log("[web-ui] Pi Console installer\n");

// 1. Prerequisites
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
if (
  nodeMajor === undefined ||
  !Number.isFinite(nodeMajor) ||
  nodeMajor < 22 ||
  (nodeMajor === 22 && !(nodeMinor !== undefined && nodeMinor >= 19))
) {
  problems.push(`Node.js >= 22.19 is required, because pi needs it (found ${process.version}).`);
}
if (!fs.existsSync(path.join(WEB_UI_DIR, "server", "server.ts"))) {
  problems.push(`Server entrypoint missing: ${path.join(WEB_UI_DIR, "server", "server.ts")}`);
}
if (!fs.existsSync(INSTALLER)) {
  problems.push(`Kit installer missing: ${INSTALLER}`);
}
const piBin = resolveCommand("pi");
if (!piBin) problems.push("The `pi` CLI was not found on PATH; install it before registering the extension.");

if (problems.length > 0) {
  for (const p of problems) console.error(`[web-ui] FAIL: ${p}`);
  process.exit(1);
}
console.log(`  node:      ${process.version}`);
console.log(`  pi:        ${piBin}`);
console.log(`  web ui:    ${WEB_UI_DIR}`);
console.log("");

// 2. Register the /console extension (additively / non-destructively)
// False when the extension is not installed and this run did not install it, so /console is not offered.
let consoleRegistered = true;
const marker = readMarker();
const selection = marker?.profile && marker.profile !== "custom" ? profileSelection(marker.profile) : null;
// Installer flags for `profile`, keeping the marker's scope and git ref: core/install.ts
// defaults to global scope, so dropping them would install a second, unrelated copy.
const installerArgs = (profile: string): string[] => {
  const args = ["--profile", profile, "--yes"];
  if (marker?.scope) args.push("--scope", marker.scope);
  if (marker?.mode === "git" && marker.ref) args.push("--mode", "git", "--git-ref", marker.ref);
  return args;
};
if (marker) {
  const installed = marker.extensions ?? [];
  if (installed.includes("web-console")) {
    console.log("[web-ui] The web-console extension is already installed - /console will work after /reload.");
  } else if (marker.profile && selection && !selection.includes("web-console")) {
    // Reinstalling this profile would select the same extensions again, without web-console.
    consoleRegistered = false;
    const overrideRemoves = readOverrides().extensions.remove.includes("web-console");
    if (overrideRemoves && profilesWithWebConsole().includes(marker.profile)) {
      // The profile includes it and the operator's own override excludes it; switching profiles would not help either.
      console.log(
        `[web-ui] ${overridesPath()} lists web-console in extensions.remove, so reinstalling "${marker.profile}" would not add /console. Not touching the install.\n` +
          "[web-ui] Remove web-console from extensions.remove and rerun this script.",
      );
    } else {
      // Suggest balanced by name: the list is alphabetical, and its first entry (autonomous) is a
      // weaker security posture than the operator may want.
      console.log(
        `[web-ui] The "${marker.profile}" profile does not include web-console, so reinstalling it would not add /console. Not touching the install.\n` +
          `[web-ui] Profiles that include it: ${profilesWithWebConsole().join(", ")}. Switch with, e.g.:\n` +
          `[web-ui]   node packages/core/install.ts ${installerArgs("balanced").join(" ")}\n` +
          `[web-ui] or add web-console to extensions.add in ${overridesPath()} and rerun this script.`,
      );
      if (overrideRemoves) {
        console.log(`[web-ui] ${overridesPath()} also lists web-console in extensions.remove; remove that entry as well, or no profile will add /console.`);
      }
    }
  } else if (marker.profile && marker.profile !== "custom") {
    // Reconcile the existing profile install so it picks up web-console. This is the
    // same idempotent reinstall the /profile command performs; it does not drop any
    // extension the profile already included.
    const cmd = [INSTALLER, ...installerArgs(marker.profile)];
    if (dryRun) {
      console.log(`[web-ui] Dry run: would reconcile the existing "${marker.profile}" install: node ${cmd.slice(1).join(" ")}`);
    } else {
      console.log(`[web-ui] Existing "${marker.profile}" kit install found - reconciling to add web-console...`);
      try {
        execFileSync(process.execPath, cmd, { cwd: ROOT, stdio: "inherit" });
      } catch {
        console.error("[web-ui] FAIL: the kit installer did not complete. See its output above.");
        process.exit(1);
      }
      if (!(readMarker()?.extensions ?? []).includes("web-console")) {
        console.error(`[web-ui] FAIL: the "${marker.profile}" install still does not include web-console, so /console is not registered.`);
        process.exit(1);
      }
    }
  } else {
    consoleRegistered = false;
    console.log(
      "[web-ui] A custom kit install already exists and does not include web-console. Not touching it.\n" +
        "[web-ui] Enable it by reinstalling with a profile that includes it, e.g.:\n" +
        `[web-ui]   node packages/core/install.ts ${installerArgs("balanced").join(" ")}`,
    );
  }
} else if (dryRun) {
  console.log(`[web-ui] Dry run: would run ${INSTALLER} --only web-console --yes`);
} else {
  console.log("[web-ui] No kit install found - registering the web-console extension...");
  try {
    execFileSync(process.execPath, [INSTALLER, "--only", "web-console", "--yes"], { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error("[web-ui] FAIL: the kit installer did not complete. See its output above.");
    process.exit(1);
  }
}

// 3. How to start
const port = process.env.PI_CONSOLE_PORT || "8123";
const host = process.env.PI_CONSOLE_HOST || "127.0.0.1";
const url = `http://${host}:${port}`;

if (start) {
  const runtime = path.join(WEB_UI_DIR, ".runtime");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(runtime, "server.log"), "a");
  // The server requires an access token. Generate one and hand it over as an owner-only file
  // (not on the command line or in the log), unless the operator supplied their own or turned
  // authentication off. The login URL is printed to this terminal only.
  const childEnv = { ...process.env };
  let token = process.env.PI_CONSOLE_TOKEN || null;
  const authOff = (process.env.PI_CONSOLE_AUTH || "").toLowerCase() === "off";
  if (!authOff && !token && !process.env.PI_CONSOLE_TOKEN_FILE) {
    token = crypto.randomBytes(32).toString("hex");
    const tokenFile = path.join(runtime, "console.token");
    fs.rmSync(tokenFile, { force: true });
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
    childEnv.PI_CONSOLE_TOKEN_FILE = tokenFile;
  }
  const child = spawn(process.execPath, [path.join(WEB_UI_DIR, "server", "server.ts")], {
    cwd: WEB_UI_DIR,
    detached: true,
    stdio: ["ignore", log, log],
    env: childEnv,
  });
  child.unref();
  fs.closeSync(log);
  console.log(`\n[web-ui] Started the server (pid ${child.pid}) at ${url}`);
  if (token) console.log(`[web-ui] Login link (keep it private): ${url}/#token=${token}`);
  else if (authOff) console.log("[web-ui] WARNING: PI_CONSOLE_AUTH=off - authentication is disabled (loopback development only).");
  else console.log("[web-ui] The access token comes from PI_CONSOLE_TOKEN_FILE.");
}

const inPi = consoleRegistered
  ? "  In pi:   /console            (alias: /webui) - prints the login link"
  : "  In pi:   not available - the web-console extension is not installed (see above)";
console.log(`
[web-ui] Done.

Start it:
${inPi}
  Shell:   node packages/web-ui/server/server.ts  (prints the login link on a terminal)

Then open the login link (it looks like ${url}/#token=...).

The server binds ${host} and requires an access token; a non-loopback bind is refused unless
PI_CONSOLE_ALLOW_REMOTE=1 is set. Keep it on loopback.
`);