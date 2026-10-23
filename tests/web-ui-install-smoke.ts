#!/usr/bin/env node
/**
 * Offline check that the standalone web-ui installer resolves the install marker with the
 * same precedence as uninstall.ts: a project marker in the cwd wins over the global one.
 *
 * Fully hermetic: `--dry-run` means the kit installer is never executed, and a throwaway
 * `pi` on PATH satisfies the prerequisite check. The project marker asks for a reconcile,
 * which is exactly the branch that used to be reached only through the global marker.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "packages", "web-ui", "install.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-webui-install-"));
const agent = path.join(dir, "agent");
const project = path.join(dir, "project");
const bin = path.join(dir, "bin");
try {
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  // A fake pi is enough for the prerequisite check; --dry-run never invokes it.
  fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(bin, "pi"), 0o755);

  // A global marker that must be ignored because a project marker exists in the cwd.
  fs.writeFileSync(
    path.join(agent, ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: "global-prof", scope: "global", extensions: [] }),
  );
  fs.writeFileSync(
    path.join(project, ".pi", ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: "proj-prof", scope: "project", extensions: [] }),
  );

  const result = spawnSync(process.execPath, [INSTALL, "--dry-run"], {
    cwd: project,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(!/No kit install found/.test(result.stdout), "the project marker must be found");
  assert.match(result.stdout, /would reconcile the existing "proj-prof" install/);
  assert.match(result.stdout, /--profile proj-prof --yes --scope project/);

  console.log("[web-ui-install-smoke] OK: project marker is resolved before the global marker");

  // A marker whose scope is unknown must stop the install, not reconcile against the default scope.
  fs.writeFileSync(
    path.join(project, ".pi", ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: "proj-prof", scope: "elsewhere", extensions: [] }),
  );
  const badScope = spawnSync(process.execPath, [INSTALL, "--dry-run"], {
    cwd: project,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  assert.equal(badScope.status, 1, badScope.stdout);
  assert.match(badScope.stderr, /names an unknown scope/);
  assert.ok(!/would reconcile/.test(badScope.stdout), "an unknown scope must not reach the kit installer");
  console.log("[web-ui-install-smoke] OK: an unknown marker scope stops the install");

  // A profile without web-console (lite): reinstalling it cannot add /console, so the installer
  // must say so, name the profiles that include it, and not tell the operator /console will work.
  const elsewhere = path.join(dir, "elsewhere");
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(
    path.join(agent, ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: "lite", scope: "global", extensions: ["tool-firewall"] }),
  );
  const runElsewhere = () =>
    spawnSync(process.execPath, [INSTALL, "--dry-run"], {
      cwd: elsewhere,
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
  const lite = runElsewhere();
  assert.equal(lite.status, 0, lite.stderr || lite.stdout);
  assert.ok(!/would reconcile|reconciling to add web-console/.test(lite.stdout), lite.stdout);
  assert.match(lite.stdout, /The "lite" profile does not include web-console/);
  assert.match(lite.stdout, /Profiles that include it: .*balanced/, "a profile that includes web-console is named");
  assert.match(lite.stdout, /--profile balanced --yes/, "the suggested switch is balanced, not the first profile alphabetically");
  assert.ok(!/In pi: {3}\/console/.test(lite.stdout), "the installer must not say /console works");
  console.log("[web-ui-install-smoke] OK: a profile without web-console is reported, not reconciled");

  // An overrides.json that adds web-console makes the same profile reconcile.
  fs.mkdirSync(path.join(agent, "pi-kit"), { recursive: true });
  fs.writeFileSync(path.join(agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { add: ["web-console"] } }));
  const added = runElsewhere();
  assert.equal(added.status, 0, added.stderr || added.stdout);
  assert.match(added.stdout, /would reconcile the existing "lite" install/);
  console.log("[web-ui-install-smoke] OK: overrides that add web-console still reconcile");

  // A profile that includes web-console, with the operator's overrides removing it: the message
  // names the override, not the profile, and does not list that profile as a way to get it.
  fs.writeFileSync(
    path.join(agent, ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: "balanced", scope: "global", extensions: ["tool-firewall"] }),
  );
  fs.writeFileSync(path.join(agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { remove: ["web-console"] } }));
  const removed = runElsewhere();
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.ok(!/would reconcile/.test(removed.stdout), removed.stdout);
  assert.match(removed.stdout, /lists web-console in extensions\.remove/);
  assert.ok(!/profile does not include web-console|Profiles that include it/.test(removed.stdout), removed.stdout);
  assert.ok(!/In pi: {3}\/console/.test(removed.stdout), "the installer must not say /console works");
  console.log("[web-ui-install-smoke] OK: an override that removes web-console is named as the cause");

  // A profile without web-console (lite) and an override that removes it: the profile is the
  // cause, and the extensions.remove entry is named as a second thing to undo.
  fs.writeFileSync(
    path.join(agent, ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: "lite", scope: "global", extensions: ["tool-firewall"] }),
  );
  const liteRemoved = runElsewhere();
  assert.equal(liteRemoved.status, 0, liteRemoved.stderr || liteRemoved.stdout);
  assert.ok(!/would reconcile/.test(liteRemoved.stdout), liteRemoved.stdout);
  assert.match(liteRemoved.stdout, /The "lite" profile does not include web-console/);
  assert.match(liteRemoved.stdout, /Profiles that include it: .*balanced/);
  assert.match(liteRemoved.stdout, /also lists web-console in extensions\.remove; remove that entry as well/);
  assert.ok(!/reinstalling "lite" would not add \/console/.test(liteRemoved.stdout), "the override is not named as the only cause");
  assert.ok(!/In pi: {3}\/console/.test(liteRemoved.stdout), "the installer must not say /console works");
  console.log("[web-ui-install-smoke] OK: a profile without web-console plus an override removal names both");

  // A project-scope lite install: the suggested switch keeps --scope project, or following it
  // would create a second, global install and leave the project's lite install in place.
  fs.rmSync(path.join(agent, "pi-kit", "overrides.json"));
  fs.writeFileSync(
    path.join(project, ".pi", ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: "lite", scope: "project", extensions: ["tool-firewall"] }),
  );
  const projectLite = spawnSync(process.execPath, [INSTALL, "--dry-run"], {
    cwd: project,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  assert.equal(projectLite.status, 0, projectLite.stderr || projectLite.stdout);
  assert.match(projectLite.stdout, /The "lite" profile does not include web-console/);
  assert.match(projectLite.stdout, /install\.ts --profile balanced --yes --scope project\n/, projectLite.stdout);
  console.log("[web-ui-install-smoke] OK: the suggested profile switch keeps the marker's project scope");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
