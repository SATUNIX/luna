import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Transactional profile switching for /profile (and the first-run auto-profile).
//
// The installer (packages/core/install.ts) writes each file atomically, but a switch touches
// several files (settings.json, the install marker, firewall.json, overrides.json, the .env
// scaffold) in sequence, so a failure part-way used to leave a mixed configuration behind: a new
// extension list with the old marker, a new firewall policy with the old profile, and so on.
// This module makes the whole switch all-or-nothing at the command level:
//
//   1. snapshot every file the switch can change (bytes and mode, or absence),
//   2. run the installer,
//   3. treat ANY of {throw, killed, non-zero exit, no completion, corrupt or mismatching result}
//      as failure and restore the snapshot byte-for-byte,
//   4. only then reload; a failed reload also rolls back (and reloads the old configuration).
//
// pi.exec() reports a signal-killed child as `code: 0` (child-process.js resolves `code ?? 0`), so
// a zero exit code is NOT evidence that the installer finished. The proof is in the files: the
// marker is the installer's last write, so a marker stamped after the switch started, naming the
// requested profile, together with a settings entry and firewall config that agree with it, is.

export interface FileSnapshot {
  path: string;
  existed: boolean;
  bytes: Buffer | null;
  mode: number | null;
}

export function snapshotFiles(paths: string[]): FileSnapshot[] {
  const seen = new Set<string>();
  const out: FileSnapshot[] = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      // One open file: the mode recorded and the bytes captured are those of the same file.
      const fd = fs.openSync(abs, "r");
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error(`${abs} exists but is not a regular file`);
        out.push({ path: abs, existed: true, bytes: fs.readFileSync(fd), mode: stat.mode & 0o7777 });
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") out.push({ path: abs, existed: false, bytes: null, mode: null });
      else throw error;
    }
  }
  return out;
}

// Files an interrupted installer can leave behind next to a snapshotted file: its lock and the
// per-process temp file of an atomic write (`<file>.<pid>.tmp`).
function transientSiblings(file: string): string[] {
  const dir = path.dirname(file);
  const base = path.basename(file);
  // Only files that exist now: the "before" set must hold what was already there, so that
  // anything the switch adds (and only that) is removed on rollback.
  const out = fs.existsSync(`${file}.pi-kit.lock`) ? [`${file}.pi-kit.lock`] : [];
  try {
    for (const name of fs.readdirSync(dir)) if (name.startsWith(`${base}.`) && /\.\d+\.tmp$/.test(name)) out.push(path.join(dir, name));
  } catch {
    /* directory absent: nothing to clean */
  }
  return out;
}

export function transientPaths(snaps: FileSnapshot[]): Set<string> {
  const all = new Set<string>();
  for (const s of snaps) for (const t of transientSiblings(s.path)) all.add(t);
  return all;
}

function writeAtomic(file: string, bytes: Buffer, mode: number | null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Created 0600 and exclusively (O_EXCL: a planted name is refused, not followed), then given the
  // snapshot's mode, so a restored .env is never world-readable, even briefly.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.restore.tmp`;
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export interface RestoreResult {
  restored: string[];
  errors: string[];
}

/** Put every snapshotted file back (or delete it when it did not exist), then verify byte equality. */
export function restoreSnapshots(snaps: FileSnapshot[], transientBefore: Set<string> = new Set()): RestoreResult {
  const restored: string[] = [];
  const errors: string[] = [];
  for (const s of snaps) {
    try {
      if (s.existed && s.bytes) {
        const current = fs.existsSync(s.path) ? fs.readFileSync(s.path) : null;
        if (!current?.equals(s.bytes)) writeAtomic(s.path, s.bytes, s.mode);
        else if (s.mode !== null) fs.chmodSync(s.path, s.mode);
        // Never trust the write: read it back.
        if (!fs.readFileSync(s.path).equals(s.bytes)) throw new Error("content differs after restore");
      } else if (fs.existsSync(s.path)) {
        fs.rmSync(s.path, { force: true });
        if (fs.existsSync(s.path)) throw new Error("could not remove a file the switch created");
      }
      restored.push(s.path);
    } catch (error) {
      errors.push(`${s.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Leftover lock / temp files created by an installer that died mid-write.
  for (const t of transientPaths(snaps)) {
    if (transientBefore.has(t)) continue;
    try {
      fs.rmSync(t, { force: true });
    } catch {
      /* best effort */
    }
  }
  return { restored, errors };
}

/** Last-resort copy of the pre-switch bytes, written only when a restore failed. */
export function saveBackup(snaps: FileSnapshot[]): string | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-backup-"));
    for (const s of snaps) {
      if (!s.existed || !s.bytes) continue;
      fs.writeFileSync(path.join(dir, s.path.replace(/[\\/:]/g, "_")), s.bytes, { mode: 0o600 });
    }
    return dir;
  } catch {
    return null;
  }
}

export interface Expectation {
  profile: string;
  scope: "global" | "project";
  kitRoot: string;
  markerFile: string;
  settingsFile: string;
  firewallFile: string;
  security?: { file: string; level: string };
  /**
   * In-package extension names the settings entry must list, in order (profile include + overrides).
   * A function, because overrides.json may be (re)written by the installer during the switch.
   */
  extensions: string[] | (() => string[]);
  /** Firewall policy the profile demands, and the mode it defaults to. */
  firewall: { policy: "coding" | "pentest"; mode: "auto" | "manual" };
  /** ms epoch the switch started; the marker (the installer's last write) must be newer. */
  startedAt: number;
  /** Reads the kit entry's extension names from a settings file (null: entry missing or unfiltered). */
  loadedExtensions: (settingsFile: string) => string[] | null;
  /** True when this in-package extension exists on disk. */
  extensionExists: (name: string) => boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// A parsed JSON value as message text: what `${v}` printed for a scalar, JSON for anything else.
function shown(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null || v === undefined ? String(v) : JSON.stringify(v);
}

function readJson(file: string): { value: unknown; error: string | null } {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "is missing" : `is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Check that the configuration pi would load equals what the requested profile expects.
 * Returns the list of problems; empty means the switch is consistent.
 */
export function verifySwitch(exp: Expectation): string[] {
  const problems: string[] = [];
  const expected = typeof exp.extensions === "function" ? exp.extensions() : exp.extensions;

  const marker = readJson(exp.markerFile);
  const m = marker.value;
  if (marker.error || !isRecord(m)) {
    problems.push(`install marker ${exp.markerFile} ${marker.error ?? "is not an object"}`);
  } else {
    if (m.profile !== exp.profile) problems.push(`marker records profile "${shown(m.profile)}", expected "${exp.profile}"`);
    const stamp = Date.parse(shown(m.installedAt ?? ""));
    if (!Number.isFinite(stamp) || stamp < exp.startedAt - 2000) problems.push("marker was not rewritten by this switch (the installer did not reach its final step)");
    if (m.scope !== undefined && m.scope !== exp.scope) problems.push(`marker scope is "${shown(m.scope)}", expected "${exp.scope}"`);
    const markerExtensions = m.extensions;
    if (Array.isArray(markerExtensions)) {
      const missing = expected.filter((n) => !markerExtensions.includes(n));
      if (missing.length) problems.push(`marker extension list lacks: ${missing.join(", ")}`);
    } else {
      problems.push("marker has no extension list");
    }
  }

  const settings = readJson(exp.settingsFile);
  if (settings.error) problems.push(`settings ${exp.settingsFile} ${settings.error}`);
  else {
    const loaded = exp.loadedExtensions(exp.settingsFile);
    if (loaded === null) problems.push(`no filtered kit entry in ${exp.settingsFile} (pi would load every extension, experimental ones included)`);
    else {
      if (!same(loaded, expected)) {
        const extra = loaded.filter((n) => !expected.includes(n));
        const missing = expected.filter((n) => !loaded.includes(n));
        problems.push(
          `settings extension list differs from profile "${exp.profile}"` +
            `${extra.length ? `; unexpected: ${extra.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
            (!extra.length && !missing.length ? "; same names in a different order" : ""),
        );
      }
      const dangling = loaded.filter((n) => !exp.extensionExists(n));
      if (dangling.length) problems.push(`settings list extensions that do not exist in the kit: ${dangling.join(", ")}`);
    }
  }

  // firewall.json and security.json are machine-global: a project-scope install never writes them
  // (it warns when the profile wants another gate), so only a global switch is held to them.
  if (exp.scope === "project") return problems;
  const firewall = readJson(exp.firewallFile);
  const fwValue = firewall.value;
  if (firewall.error || !isRecord(fwValue)) {
    problems.push(`firewall config ${exp.firewallFile} ${firewall.error ?? "is not an object"}`);
  } else {
    const { policy, mode, source } = fwValue;
    if (policy !== "coding" && policy !== "pentest") problems.push(`firewall policy "${shown(policy)}" is not a known policy (coding|pentest)`);
    else if (policy !== exp.firewall.policy) problems.push(`firewall policy is "${policy}", profile "${exp.profile}" requires "${exp.firewall.policy}"`);
    if (mode !== "auto" && mode !== "manual") problems.push(`firewall mode "${shown(mode)}" is not a known mode (auto|manual)`);
    else if (source !== "user" && mode !== exp.firewall.mode) problems.push(`firewall mode is "${mode}", profile "${exp.profile}" requires "${exp.firewall.mode}"`);
  }
  if (exp.security) {
    const result = readJson(exp.security.file);
    const v = result.value;
    const levels = ["relaxed", "balanced", "guarded", "strict"];
    if (result.error || !isRecord(v) || v.schemaVersion !== 1 || typeof v.level !== "string" || !levels.includes(v.level)
      || (v.source !== "operator" && v.source !== "profile") || typeof v.revision !== "number" || !Number.isSafeInteger(v.revision) || v.revision < 0
      || typeof v.changedAt !== "string" || !Number.isFinite(Date.parse(v.changedAt))) {
      problems.push(`security config ${exp.security.file} ${result.error ?? "is invalid"}`);
    } else {
      // Verify the effective result including the engagement and strengthening-only env
      // floors. An operator's request survives a profile switch, even beneath a floor.
      const floor = exp.firewall.policy === "pentest" ? levels.indexOf("guarded") : 0;
      const pin = levels.indexOf(process.env.PI_KIT_SECURITY_LEVEL ?? "");
      const effective = Math.max(levels.indexOf(v.level), floor, pin);
      const expected = Math.max(levels.indexOf(v.source === "operator" ? v.level : exp.security.level), floor, pin);
      if ((v.source === "profile" && v.level !== exp.security.level) || effective !== expected) problems.push(`security level is ${v.level} (effective ${levels[effective]}), profile requires ${exp.security.level} (effective ${levels[expected]})`);
    }
  }
  return problems;
}

export interface ExecLike {
  (command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;
}

export interface SwitchInput {
  exec: ExecLike;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Every file the switch may change. */
  files: string[];
  expectation: Omit<Expectation, "startedAt">;
  /**
   * Called once the switch is verified and BEFORE the reload: after a reload the calling
   * extension's ctx is stale, so the operator must be told first.
   */
  announce?: (warnings: string[]) => void;
  /** Called after a verified install; a throw is a failed reload. Omit for "apply, then ask the user to /reload". */
  reload?: (() => Promise<void>) | undefined;
  /** Called to reload the OLD configuration after a rolled-back reload failure (best effort). */
  reloadOld?: (() => Promise<void>) | undefined;
  /** Test hook: fires between stages. */
  onStage?: (stage: "snapshot" | "install" | "verify" | "reload") => void;
}

export type SwitchStage = "install" | "verify" | "reload";

export interface SwitchOutcome {
  ok: boolean;
  stage: SwitchStage | null;
  /** One-paragraph operator-facing result (already says what was rolled back). */
  message: string;
  warnings: string[];
  rolledBack: boolean;
  rollbackErrors: string[];
  backupDir: string | null;
}

function warningLines(...streams: string[]): string[] {
  const lines: string[] = [];
  for (const stream of streams) {
    for (const raw of stream.split(/\r?\n/)) {
      const line = raw.trim();
      if (/\bWARN(ING)?\b/i.test(line) && !lines.includes(line)) lines.push(line.replace(/^\[install\]\s*/, ""));
    }
  }
  return lines;
}

const tail = (text: string, n = 1200): string => text.trim().slice(-n);

/** The `pi install` / `pi remove` commands the installer reports having run; restoring files cannot undo them. */
export function packageChangeLines(...streams: string[]): string[] {
  const changes: string[] = [];
  for (const stream of streams) {
    for (const match of stream.matchAll(/^\[install\] Package change \(a rollback cannot undo it\): (.+)$/gm)) {
      const change = match[1]?.trim();
      if (change && !changes.includes(change)) changes.push(change);
    }
  }
  return changes;
}

export async function transactionalSwitch(input: SwitchInput): Promise<SwitchOutcome> {
  const snaps = snapshotFiles(input.files);
  const transientBefore = transientPaths(snaps);
  input.onStage?.("snapshot");
  const startedAt = Date.now();
  let warnings: string[] = [];
  let packageChanges: string[] = [];

  const rollback = (stage: SwitchStage, detail: string): SwitchOutcome => {
    const result = restoreSnapshots(snaps, transientBefore);
    const backupDir = result.errors.length ? saveBackup(snaps) : null;
    const changed = snaps.filter((s) => s.existed).length;
    const message = result.errors.length
      ? `profile: switch to "${input.expectation.profile}" FAILED at ${stage} (${detail}) and the rollback was INCOMPLETE - ${result.errors.join("; ")}.` +
        `${backupDir ? ` The original bytes were saved in ${backupDir}.` : ""} Restore those files by hand before continuing.`
      : packageChanges.length
        ? `profile: switch to "${input.expectation.profile}" FAILED at ${stage}: ${detail}. ${changed} configuration file(s) were restored byte-for-byte, so the previous profile's settings are back, ` +
          `but these package operations had already run and were NOT rolled back: ${packageChanges.join("; ")}. pi may have changed those packages' files on disk; \`pi list\` shows what is registered.`
        : `profile: switch to "${input.expectation.profile}" FAILED at ${stage}: ${detail}. Nothing was changed: ${changed} configuration file(s) were restored byte-for-byte and the previous profile stays in force.`;
    return { ok: false, stage, message, warnings, rolledBack: result.errors.length === 0, rollbackErrors: result.errors, backupDir };
  };

  // 1. install
  input.onStage?.("install");
  let exec: Awaited<ReturnType<ExecLike>>;
  try {
    exec = await input.exec(input.command, input.args, { cwd: input.cwd, timeout: input.timeoutMs });
  } catch (error) {
    return rollback("install", `could not run the installer: ${error instanceof Error ? error.message : String(error)}`);
  }
  warnings = warningLines(exec.stderr ?? "", exec.stdout ?? "");
  packageChanges = packageChangeLines(exec.stdout ?? "", exec.stderr ?? "");
  if (exec.killed) return rollback("install", `the installer was killed after ${Math.round(input.timeoutMs / 1000)}s${tail(exec.stderr ?? "") ? `\n${tail(exec.stderr ?? "")}` : ""}`);
  if (exec.code !== 0) return rollback("install", `installer exited ${exec.code}\n${tail(exec.stderr || exec.stdout || "") || "(no output)"}`);
  // A signal-killed installer reads as exit 0 in pi.exec; a finished one always says so.
  if ((exec.stdout ?? "").trim() && !/\[install\] Done\./.test(exec.stdout)) {
    return rollback("install", `the installer stopped before finishing (exit 0 without its completion line - it was probably killed)\n${tail(exec.stderr || exec.stdout)}`);
  }

  // 2. verify what pi would actually load
  input.onStage?.("verify");
  let problems: string[];
  try {
    problems = verifySwitch({ ...input.expectation, startedAt });
  } catch (error) {
    problems = [`verification threw: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (problems.length) return rollback("verify", problems.join("; "));
  try {
    input.announce?.(warnings);
  } catch {
    /* an announcement failure must not undo a verified switch */
  }

  // 3. reload
  if (input.reload) {
    input.onStage?.("reload");
    try {
      await input.reload();
    } catch (error) {
      const outcome = rollback("reload", `pi could not reload the new configuration: ${error instanceof Error ? error.message : String(error)}`);
      if (input.reloadOld) {
        try {
          await input.reloadOld();
        } catch (again) {
          outcome.message += ` Reloading the restored configuration also failed (${again instanceof Error ? again.message : String(again)}); run /reload.`;
        }
      }
      return outcome;
    }
  }
  return { ok: true, stage: null, message: `profile: switched to "${input.expectation.profile}".`, warnings, rolledBack: false, rollbackErrors: [], backupDir: null };
}
