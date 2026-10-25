#!/usr/bin/env node
/**
 * Regression coverage for helpers/pi-kit-helper.sh.
 *
 * Root cause this guards (shipped once, 2026-09): `pick_profile()` printed its
 * interactive menu AND the selected profile name to stdout. Both call sites capture
 * the function with command substitution:
 *
 *     profile=$(pick_profile)
 *
 * so `$profile` became the whole menu text ("profiles\n  1) quick\n...balanced")
 * instead of a bare profile name, and install/update-kit failed for EVERY profile
 * with:
 *
 *     [install] Profile not found: .../profiles/profiles ... balanced.json
 *
 * The fix routes all human-facing menu output to stderr and leaves only the bare
 * selected profile name on stdout (the return channel).
 *
 * Fully offline and non-mutating: the install-path test puts fake `node`/`git`/
 * `npm`/`pi` shims first on PATH, so nothing real is installed and the heavy
 * `node packages/core/install.ts` (which itself runs the verify gate even under --dry-run)
 * never executes. It asserts the exact argv the helper hands to `node`.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "packages", "core", "helpers", "pi-kit-helper.sh");
const PROFILES = [
  "quick",
  "balanced",
  "long-horizon",
  "autonomous",
  "pentest",
  "self-improving",
];

const bashAvailable = (() => {
  const r = spawnSync("bash", ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
})();

function bash(args: string[], opts: Omit<SpawnSyncOptions, "encoding"> = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", args, { encoding: "utf8", ...opts });
}

// 1. The script must be syntactically valid.
function testSyntax() {
  const r = bash(["-n", HELPER]);
  assert.equal(r.status, 0, `bash -n failed:\n${r.stderr}`);
}

// Build a probe script: the helper with its `main "$@"` dispatch removed, so sourcing
// it only defines functions, then call pick_profile. This is exactly how the real call
// sites consume it (function output = return value).
let _probePath: string | null = null;
function probePath(): string {
  if (_probePath) return _probePath;
  const src = fs.readFileSync(HELPER, "utf8");
  assert.ok(
    /^main "\$@"\s*$/m.test(src),
    'helper must dispatch via a top-level `main "$@"` line',
  );
  const stripped = src.replace(/^main "\$@"\s*$/m, "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-helper-probe-"));
  _probePath = path.join(dir, "probe.sh");
  fs.writeFileSync(_probePath, `${stripped}\npick_profile\n`);
  return _probePath;
}

// 2. `profile=$(pick_profile)` must capture exactly a bare profile name.
function testPickProfileStdoutIsBareName() {
  const cases = [
    ["1", "quick"],
    ["2", "balanced"],
    ["3", "long-horizon"],
    ["4", "autonomous"],
    ["5", "pentest"],
    ["6", "self-improving"],
    ["99", "balanced"], // out of range -> default
    ["abc", "balanced"], // non-numeric -> default
    ["", "balanced"], // empty -> default 2
  ];
  for (const [input, expected] of cases) {
    const r = bash([probePath()], { input: `${input}\n` });
    assert.equal(
      r.status,
      0,
      `probe exited ${r.status} for input ${JSON.stringify(input)}: ${r.stderr}`,
    );
    assert.equal(
      r.stdout,
      `${expected}\n`,
      `input ${JSON.stringify(input)}: stdout must be exactly the bare profile name, got ${JSON.stringify(r.stdout)}`,
    );
  }
}

// 3. The menu is not lost - it moves to stderr, so the operator still sees it.
function testPickProfileMenuGoesToStderr() {
  const r = bash([probePath()], { input: "2\n" });
  assert.equal(r.status, 0);
  for (const entry of PROFILES) {
    assert.ok(
      r.stderr.includes(entry),
      `menu on stderr must still list profile "${entry}", stderr was: ${JSON.stringify(r.stderr)}`,
    );
  }
  // NB: bash suppresses the `read -p` prompt when stdin is a pipe (non-interactive),
  // so we deliberately do not require "Choose a profile" here - it is only emitted on a
  // tty. The menu header and entries above are the parts we control and must not leak
  // to stdout.
  // No menu/answer noise on stdout beyond the single bare name.
  assert.ok(
    !r.stdout.includes(")"),
    `stdout must not contain menu entries, got ${JSON.stringify(r.stdout)}`,
  );
  assert.equal(
    r.stdout.trim().split("\n").length,
    1,
    "stdout must be exactly one line",
  );
}

// 4. The real install path must forward a valid profile name, never the menu text.
//    Hermetic: fake node/git/npm/pi first on PATH record their argv and change nothing.
function testInstallForwardsRealProfileArg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-helper-install-"));
  try {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    const logPath = path.join(dir, "log.txt");
    fs.writeFileSync(logPath, "");

    const shim = (name: string, body: string): void => {
      const file = path.join(binDir, name);
      fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
      fs.chmodSync(file, 0o755);
    };
    shim(
      "node",
      [
        `if [ "$1" = "--version" ]; then echo "v22.0.0-fake"; exit 0; fi`,
        // Locate the first non-flag argument, which is the script path the helper
        // hands to node. It must resolve from the shim's cwd (helper cd's to
        // packages/core). A missing file is exactly the "packages/core/packages/core"
        // defect, so fail loudly instead of silently accepting a bogus path.
        `script=""`,
        `for arg in "$@"; do`,
        `  case "$arg" in --*) continue ;; *) script="$arg"; break ;; esac`,
        `done`,
        `if [ -n "$script" ] && [ ! -f "$script" ]; then`,
        `  echo "fake node: script not found: $script (cwd $(pwd))" >&2`,
        `  exit 1`,
        `fi`,
        `printf '%s\\n' "$*" >> "$FAKE_LOG"`,
      ].join("\n"),
    );
    shim(
      "git",
      `if [ "$1" = "--version" ]; then echo "git version 2.0.0-fake"; exit 0; fi\nexit 0`,
    );
    shim(
      "npm",
      `if [ "$1" = "--version" ]; then echo "10.0.0-fake"; exit 0; fi\nprintf 'npm %s\\n' "$*" >> "$FAKE_LOG"`,
    );
    shim("pi", `echo "0.0.0-fake"`);

    const env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_LOG: logPath,
      PI_CODING_AGENT_DIR: path.join(dir, "agent"),
    };

    // profile=balanced, scope=global, decline the real apply.
    const r = bash([HELPER, "install"], { input: "2\ng\nn\n", env });
    assert.equal(r.status, 0, `install helper exited ${r.status}: ${r.stderr}`);

    const invoked = fs.readFileSync(logPath, "utf8");
    assert.match(
      invoked,
      /packages\/core\/install\.ts --profile balanced --scope global --dry-run/,
      `helper must pass a bare profile name to install.ts, invoked: ${JSON.stringify(invoked)}`,
    );
    // The recorded script path must resolve to a real file from the helper's cwd.
    const coreDir = path.join(ROOT, "packages", "core");
    const scriptArg = invoked.trim().split(/\s+/)[0];
    assert.ok(scriptArg, `the helper log must record a script path, log: ${JSON.stringify(invoked)}`);
    const scriptPath = path.isAbsolute(scriptArg)
      ? scriptArg
      : path.resolve(coreDir, scriptArg);
    assert.ok(
      fs.existsSync(scriptPath),
      `install.ts must resolve from the helper's cwd; got ${JSON.stringify(scriptArg)} -> ${scriptPath}`,
    );
    assert.ok(
      !/profiles\/profiles|profiles\\\\profiles/.test(
        r.stdout + r.stderr + invoked,
      ),
      "the old menu-capture bug produced a 'profiles/profiles...' path; it must not reappear",
    );
    assert.ok(
      r.stdout.includes("Dry run only — nothing changed."),
      "declining the apply must not install anything",
    );
    assert.ok(
      !/install:lite|--surface/.test(invoked),
      "the retired lite surface build must not be invoked (lite is a profile now)",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 5. Shared fake-tool harness for the update-kit path: fake node/git first on PATH,
//    recording their argv. Mirrors testInstallForwardsRealProfileArg. `dirty` controls
//    what `git status` reports, so the dirty-tree guard can be exercised without a repo.
interface UpdateKitHarness {
  env: NodeJS.ProcessEnv;
  logPath: string;
}

function makeUpdateKitHarness(dir: string, dirty: boolean): UpdateKitHarness {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const logPath = path.join(dir, "log.txt");
  fs.writeFileSync(logPath, "");

  const shim = (name: string, body: string): void => {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };
  shim(
    "node",
    [
      `if [ "$1" = "--version" ]; then echo "v22.0.0-fake"; exit 0; fi`,
      `script=""`,
      `for arg in "$@"; do`,
      `  case "$arg" in --*) continue ;; *) script="$arg"; break ;; esac`,
      `done`,
      `if [ -n "$script" ] && [ ! -f "$script" ]; then`,
      `  echo "fake node: script not found: $script (cwd $(pwd))" >&2`,
      `  exit 1`,
      `fi`,
      `printf '%s\\n' "$*" >> "$FAKE_LOG"`,
    ].join("\n"),
  );
  shim(
    "git",
    [
      `if [ "$1" = "--version" ]; then echo "git version 2.0.0-fake"; exit 0; fi`,
      `if [ "$1" = "status" ]; then`,
      dirty
        ? `  printf '%s\\n' " M packages/core/some-file.mjs"`
        : `  :`,
      `  exit 0`,
      `fi`,
      `if [ "$1" = "pull" ]; then`,
      `  printf 'git %s\\n' "$*" >> "$FAKE_LOG"`,
      `  exit 0`,
      `fi`,
      `exit 0`,
    ].join("\n"),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_LOG: logPath,
    PI_CODING_AGENT_DIR: path.join(dir, "agent"),
  };
  return { env, logPath };
}

// 5a. A clean tree: update-kit must git pull, capture the picked profile, and forward
//     it to the real install.ts path (which the fake node records but does not run).
function testUpdateKitCleanTreePullsThenForwardsProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-helper-update-"));
  try {
    const { env, logPath } = makeUpdateKitHarness(dir, false);
    const r = bash([HELPER, "update-kit"], { input: "2\n", env });
    assert.equal(r.status, 0, `update-kit exited ${r.status}: ${r.stderr}`);

    const invoked = fs.readFileSync(logPath, "utf8");
    assert.match(
      invoked,
      /^git pull$/m,
      `update-kit on a clean tree must run git pull, log: ${JSON.stringify(invoked)}`,
    );
    assert.match(
      invoked,
      /packages\/core\/install\.ts --profile balanced --yes/,
      `update-kit must forward the picked profile to install.ts, log: ${JSON.stringify(invoked)}`,
    );
    // The recorded script path must resolve to a real file from the helper's cwd
    // (packages/core), so the command is the real installer and not a bogus path.
    const installLine = invoked.split("\n").find((l) => l.includes("install.ts"));
    assert.ok(installLine, `install.ts must be invoked, log: ${JSON.stringify(invoked)}`);
    const scriptArg = installLine.trim().split(/\s+/)[0];
    assert.ok(scriptArg, `the install line must start with a script path: ${JSON.stringify(installLine)}`);
    const coreDir = path.join(ROOT, "packages", "core");
    const scriptPath = path.isAbsolute(scriptArg)
      ? scriptArg
      : path.resolve(coreDir, scriptArg);
    assert.ok(
      fs.existsSync(scriptPath),
      `install.ts must resolve from the helper's cwd; got ${JSON.stringify(scriptArg)} -> ${scriptPath}`,
    );
    assert.ok(
      !/profiles\/profiles|profiles\\\\profiles/.test(r.stdout + r.stderr + invoked),
      "the old menu-capture bug produced a 'profiles/profiles...' path; it must not reappear",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 5b. A dirty tree: update-kit must refuse, running neither git pull nor install.ts.
function testUpdateKitDirtyTreeBlocksPullAndInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-helper-update-dirty-"));
  try {
    const { env, logPath } = makeUpdateKitHarness(dir, true);
    const r = bash([HELPER, "update-kit"], { input: "2\n", env });
    assert.notEqual(r.status, 0, "update-kit on a dirty tree must fail");

    const invoked = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    assert.ok(
      !/^git pull$/m.test(invoked),
      `a dirty tree must not run git pull, log: ${JSON.stringify(invoked)}`,
    );
    assert.ok(
      !invoked.includes("install.ts"),
      `a dirty tree must not invoke install.ts, log: ${JSON.stringify(invoked)}`,
    );
    assert.match(
      r.stderr,
      /uncommitted change/,
      `a dirty tree must explain why it stopped, stderr: ${JSON.stringify(r.stderr)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 6. Both call sites must keep consuming pick_profile via command substitution into a
//    scratch variable (if one is ever changed to build a path from unquoted output,
//    the bug class reopens).
function testBothCallSitesCapturePickProfile() {
  const src = fs.readFileSync(HELPER, "utf8");
  const captures = src.match(/profile=\$\(pick_profile\)/g) ?? [];
  assert.equal(
    captures.length,
    2,
    "both cmd_install and cmd_update_kit must capture pick_profile output",
  );
  for (const fn of ["cmd_install", "cmd_update_kit"]) {
    const body = src.slice(src.indexOf(`${fn}()`));
    assert.match(
      body.slice(0, 800),
      /profile=\$\(pick_profile\)/,
      `${fn} must capture pick_profile`,
    );
  }
}

// 7. update-pi installs exactly the pi version the kit is tested against (package.json
//    devDependencies), with --ignore-scripts, never "latest"; a non-exact pin refuses. The
//    PowerShell helper carries the same rule (checked statically: no pwsh in CI).
function testUpdatePiInstallsTheKitPin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-helper-update-pi-"));
  try {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    const logPath = path.join(dir, "log.txt");
    fs.writeFileSync(logPath, "");
    for (const name of ["npm", "pi"]) {
      fs.writeFileSync(path.join(binDir, name), `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> "$FAKE_LOG"\n`, { mode: 0o755 });
    }
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_LOG: logPath, PI_CODING_AGENT_DIR: path.join(dir, "agent") };
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const devDependencies = typeof pkg === "object" && pkg !== null && "devDependencies" in pkg ? pkg.devDependencies : undefined;
    const pinned = typeof devDependencies === "object" && devDependencies !== null && "@earendil-works/pi-coding-agent" in devDependencies ? devDependencies["@earendil-works/pi-coding-agent"] : undefined;
    assert.equal(typeof pinned, "string", "package.json pins pi in devDependencies");
    const r = bash([HELPER, "update-pi"], { env });
    assert.equal(r.status, 0, `update-pi exited ${r.status}: ${r.stderr}`);
    const invoked = fs.readFileSync(logPath, "utf8");
    assert.match(invoked, new RegExp(`^npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${String(pinned).replace(/\./g, "\\.")}$`, "m"), `update-pi must install the kit's pin without scripts, log: ${JSON.stringify(invoked)}`);
    const ps1 = fs.readFileSync(path.join(ROOT, "packages", "core", "helpers", "pi-kit-helper.ps1"), "utf8");
    assert.match(ps1, /npm install -g --ignore-scripts "@earendil-works\/pi-coding-agent@\$version"/, "the PowerShell helper installs the same pin without scripts");
    for (const [label, src] of [["sh", fs.readFileSync(HELPER, "utf8")], ["ps1", ps1]] as const) {
      assert.doesNotMatch(src, /npm install -g @earendil-works\/pi-coding-agent\s*$/m, `the ${label} helper never installs an unpinned pi`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tests: Array<[name: string, fn: () => void]> = [
  ["helper script is syntactically valid", testSyntax],
  [
    "pick_profile stdout is exactly a bare profile name",
    testPickProfileStdoutIsBareName,
  ],
  ["pick_profile menu/prompt move to stderr", testPickProfileMenuGoesToStderr],
  [
    "install path forwards a real --profile and never a menu-captured path",
    testInstallForwardsRealProfileArg,
  ],
  [
    "update-kit on a clean tree pulls then forwards the picked profile to install.ts",
    testUpdateKitCleanTreePullsThenForwardsProfile,
  ],
  [
    "update-kit on a dirty tree blocks git pull and install.ts",
    testUpdateKitDirtyTreeBlocksPullAndInstall,
  ],
  [
    "both call sites capture pick_profile output",
    testBothCallSitesCapturePickProfile,
  ],
  [
    "update-pi installs the kit's pinned pi version without install scripts",
    testUpdatePiInstallsTheKitPin,
  ],
];

if (!bashAvailable) {
  console.log("[helper-smoke] skipped: bash is not available on this host");
  process.exit(0);
}

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\n[helper-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[helper-smoke] all ${tests.length} checks passed`);
