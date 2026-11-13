// The update journal: what Luna was before /update changed it, so `/update undo` can go back.
//
// Written once, before the first step of a plan runs: the kit (how it is delivered, source, version,
// commit, channel), the pi version, the recorded profile and a copy of the configuration files an
// update or a profile re-apply can change. `/update undo` returns the kit to the recorded version,
// then puts those files back byte for byte. pi itself is NOT rolled back (it only moves forward with
// `pi update --self`), and a package a step updated is not either; the journal says so.
//
// The copies hold configuration only: settings.json, the install markers, firewall.json,
// security.json, overrides.json and profile-settings.json. Never `.env`, which holds API keys. The
// journal is written 0600. install.ts keeps the same snapshots in memory for a single install run;
// this is the persisted form, because an update outlives a process (extensions may not import
// toolchain code, so it is not the same code).
//
// Self-containment rule: import only node:* builtins and sibling modules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateStoredExtension, migrateStoredPolicy, migrateStoredProfile } from "./shared/profile-names.ts";

export const JOURNAL_VERSION = 1;

/** The kit as the update found it. Mirrors the fields of `KitInstall` an undo needs. */
export interface JournalKit {
  kind: "npm" | "git" | "local" | "none";
  source: string | null;
  version: string | null;
  commit: string | null;
  channel: string | null;
  root: string | null;
  scope: "user" | "project";
}

export interface JournalFile {
  path: string;
  /** base64 of the file as it was, or null when it did not exist. */
  content: string | null;
}

export interface Journal {
  version: number;
  createdAt: string;
  /** The plan that was about to run, for the message. */
  steps: string[];
  pi: string;
  profile: string | null;
  kit: JournalKit;
  files: JournalFile[];
  /** True once the update this journal was written for finished. A finished update's journal is replaced by the next update's; an unfinished one is kept across a retry. */
  complete: boolean;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function journalPath(): string {
  return path.join(agentDir(), "pi-kit", "update-journal.json");
}

/** Every configuration file an update can change, for both scopes. Honours the same path overrides the kit's own readers do. */
function configPaths(cwd: string) {
  const dir = agentDir();
  return {
    settings: path.join(dir, "settings.json"),
    marker: path.join(dir, ".pi-kit.json"),
    projectSettings: path.join(cwd, ".pi", "settings.json"),
    projectMarker: path.join(cwd, ".pi", ".pi-kit.json"),
    firewall: process.env.PI_KIT_FIREWALL_CONFIG?.trim() || path.join(dir, "pi-kit", "firewall.json"),
    security: process.env.PI_KIT_SECURITY_CONFIG?.trim() || path.join(dir, "pi-kit", "security.json"),
    overrides: path.join(dir, "pi-kit", "overrides.json"),
    profileSettings: path.join(dir, "pi-kit", "profile-settings.json"),
  };
}

export function configFiles(cwd: string): string[] {
  return Object.values(configPaths(cwd));
}

function readIfPresent(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function writeAtomic(file: string, data: Buffer | string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** Record the state before an update. Throws when the journal cannot be written: the update must not start without it. */
export function writeJournal(input: { cwd: string; steps: string[]; pi: string; profile: string | null; kit: JournalKit }): Journal {
  const files = configFiles(input.cwd).map((file): JournalFile => ({ path: file, content: readIfPresent(file)?.toString("base64") ?? null }));
  const journal: Journal = { version: JOURNAL_VERSION, createdAt: new Date().toISOString(), steps: input.steps, pi: input.pi, profile: input.profile, kit: input.kit, files, complete: false };
  writeAtomic(journalPath(), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
  return journal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The journal, or null when there is none or it cannot be trusted (wrong version, wrong shape). */
export function readJournal(): Journal | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(journalPath(), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== JOURNAL_VERSION || !isRecord(raw.kit) || !Array.isArray(raw.files)) return null;
  const kind = raw.kit.kind;
  if (kind !== "npm" && kind !== "git" && kind !== "local" && kind !== "none") return null;
  const files: JournalFile[] = [];
  for (const f of raw.files) {
    if (!isRecord(f) || typeof f.path !== "string" || (f.content !== null && typeof f.content !== "string")) return null;
    files.push({ path: f.path, content: f.content });
  }
  return {
    version: JOURNAL_VERSION,
    createdAt: text(raw.createdAt) ?? "",
    steps: Array.isArray(raw.steps) ? raw.steps.filter((s): s is string => typeof s === "string") : [],
    pi: text(raw.pi) ?? "",
    profile: text(raw.profile),
    kit: {
      kind,
      source: text(raw.kit.source),
      version: text(raw.kit.version),
      commit: text(raw.kit.commit),
      channel: text(raw.kit.channel),
      root: text(raw.kit.root),
      scope: raw.kit.scope === "project" ? "project" : "user",
    },
    files,
    complete: raw.complete === true,
  };
}

/** Record that the update this journal was written for finished, so the next update starts a fresh journal. */
export function markJournalComplete(): void {
  const journal = readJournal();
  if (journal === null || journal.complete) return;
  writeAtomic(journalPath(), `${JSON.stringify({ ...journal, complete: true }, null, 2)}\n`, 0o600);
}

/** Put every recorded file back (or remove one that did not exist). Returns the files it could not restore. */
export function restoreFiles(journal: Journal): string[] {
  const failed: string[] = [];
  for (const file of journal.files) {
    try {
      if (file.content === null) fs.rmSync(file.path, { force: true });
      else writeAtomic(file.path, Buffer.from(file.content, "base64"), 0o600);
    } catch {
      failed.push(file.path);
    }
  }
  return failed;
}

export function removeJournal(): void {
  fs.rmSync(journalPath(), { force: true });
}

/**
 * The state kept under an old name that the next update rewrites under its new one: a renamed
 * profile, a firewall policy, a security level, an extension name in overrides.json. Told once, after
 * the update, so the rename is not a surprise. Removed at 0.5.0, with the migrations it reports
 * (`shared/profile-names.ts`, `migrateLevel`).
 */
export function migrationNotes(cwd: string): string[] {
  const read = (file: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const paths = configPaths(cwd);
  const notes: string[] = [];
  const profile = text(read(fs.existsSync(paths.projectMarker) ? paths.projectMarker : paths.marker).profile);
  if (profile !== null && migrateStoredProfile(profile) !== profile) notes.push(`profile "${profile}" is now "${migrateStoredProfile(profile)}"`);
  const policy = read(paths.firewall).policy;
  if (typeof policy === "string" && migrateStoredPolicy(policy) !== policy) notes.push(`firewall policy "${policy}" is now "${String(migrateStoredPolicy(policy))}"`);
  if (read(paths.security).level === "relaxed") notes.push('security level "relaxed" is now "balanced" (they behaved the same)');
  const extensions = read(paths.overrides).extensions;
  for (const key of ["add", "remove"]) {
    const names = isRecord(extensions) && Array.isArray(extensions[key]) ? extensions[key] : [];
    for (const name of names) if (typeof name === "string" && migrateStoredExtension(name) !== name) notes.push(`extension "${name}" is now "${migrateStoredExtension(name)}" (overrides.json ${key})`);
  }
  return notes;
}
