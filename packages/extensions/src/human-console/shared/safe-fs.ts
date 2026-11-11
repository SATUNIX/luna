// GENERATED from packages/core/shared/safe-fs.ts by packages/core/gen-shared.ts. Do not edit this copy:
// change the source and run `npm run gen:shared` (`npm run verify` fails when a copy differs).
/**
 * Safe file writes for kit state (the secure file-I/O standard in docs/security.md, "Workspace
 * file writes").
 *
 * A cloned repository is untrusted content, and git stores symlinks, so any path under a workspace
 * (`<cwd>/.pi/...`, `AGENTS.md`) may be a committed link to a file elsewhere, such as a shell rc
 * file or `~/.ssh/authorized_keys`. Node's writeFileSync, appendFileSync and mkdirSync all follow
 * such links. Every write here instead:
 *   - refuses a target outside `root` when a root is given (a `path.relative` check, not a string
 *     prefix), and lstats each directory from `root` down to the target's parent, refusing a
 *     symlink or a non-directory and creating a missing one;
 *   - opens the target itself with O_NOFOLLOW, then fstats the open file and requires a regular
 *     file owned by the current user with one link;
 *   - replaces a whole file through a fresh temporary file created with O_EXCL in the same
 *     directory and renamed over the target, so a reader never sees a half-written file and a
 *     planted link at the temporary name is refused rather than followed.
 *
 * Not covered: a local process racing the checks (between the lstat of a directory and the open
 * below it). The threat is content committed to a repository, which cannot race. On Windows,
 * O_NOFOLLOW and the owner check do not exist; the lstat checks still run.
 *
 * Canonical source: packages/core/shared/safe-fs.ts. Extensions and packages that cannot import
 * it hold generated, byte-checked copies (`npm run gen:shared`; `npm run verify` fails on drift).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Thrown when a write is refused because a path component is unsafe. */
export class UnsafePathError extends Error {
  readonly code = "EUNSAFEPATH";
  readonly target: string;
  constructor(target: string, reason: string) {
    super(`refusing to write ${target}: ${reason}`);
    this.name = "UnsafePathError";
    this.target = target;
  }
}

export interface SafeWriteOptions {
  /**
   * The trusted directory the target must lie inside (for workspace state, the workspace root).
   * Every directory below it on the way to the target is checked. Without it only the target's
   * own name is protected, which suits a path the operator configured.
   */
  root?: string;
  /** File mode for a newly created file (subject to the umask). Defaults to 0o600 for a new file, or the existing file's mode on replacement. */
  mode?: number;
  /** Directory mode for directories this call creates. Defaults to 0o700. */
  dirMode?: number;
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const uid = typeof process.getuid === "function" ? process.getuid() : null;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** True when `target` is `root` itself or lies inside it (after resolving `.` and `..`, not links). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The workspace a kit state path belongs to: the parent of the last `.pi` component of `file`, or
 * undefined when it has none. For helpers that receive only a path under `<workspace>/.pi/`.
 */
export function piWorkspaceOf(file: string): string | undefined {
  const parts = path.resolve(file).split(path.sep);
  const at = parts.lastIndexOf(".pi");
  if (at <= 0) return undefined;
  return parts.slice(0, at).join(path.sep) || path.sep;
}

/** Options for a write under `file`'s workspace (see piWorkspaceOf), with an optional mode. */
export function piWorkspaceOptions(file: string, mode?: number): SafeWriteOptions {
  const root = piWorkspaceOf(file);
  return { ...(root === undefined ? {} : { root }), ...(mode === undefined ? {} : { mode }) };
}

/**
 * Creates `dir` and any missing parents below `root`, refusing a symlink or a non-directory at any
 * component. `root` itself is trusted (created when missing). Without a root only `dir`'s own name
 * is checked, and missing parents are created with mkdirSync.
 */
export function ensureDirSafe(dir: string, options: SafeWriteOptions = {}): void {
  const target = path.resolve(dir);
  const mode = options.dirMode ?? 0o700;
  if (options.root === undefined) {
    const st = lstatOrNull(target);
    if (st) {
      if (!st.isDirectory()) throw new UnsafePathError(target, st.isSymbolicLink() ? "the directory is a symbolic link" : "not a directory");
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode });
    try {
      fs.mkdirSync(target, { mode });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const after = fs.lstatSync(target);
    if (!after.isDirectory()) throw new UnsafePathError(target, "not a directory");
    return;
  }
  const root = path.resolve(options.root);
  if (!isInside(root, target)) throw new UnsafePathError(target, `it is outside ${root}`);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode });
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st = lstatOrNull(current);
    if (!st) {
      try {
        fs.mkdirSync(current, { mode });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      st = fs.lstatSync(current);
    }
    if (st.isSymbolicLink()) throw new UnsafePathError(target, `${current} is a symbolic link`);
    if (!st.isDirectory()) throw new UnsafePathError(target, `${current} is not a directory`);
  }
}

function checkOpenFile(fd: number, target: string): fs.Stats {
  const st = fs.fstatSync(fd);
  if (!st.isFile()) throw new UnsafePathError(target, "not a regular file");
  if (uid !== null && st.uid !== uid) throw new UnsafePathError(target, "owned by another user");
  if (st.nlink > 1) throw new UnsafePathError(target, "the file has more than one hard link");
  return st;
}

function openNoFollow(target: string, flags: number, mode: number): number {
  try {
    return fs.openSync(target, flags | O_NOFOLLOW, mode);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP" || code === "EMLINK") throw new UnsafePathError(target, "the file is a symbolic link");
    throw error;
  }
}

function prepare(file: string, options: SafeWriteOptions): string {
  const target = path.resolve(file);
  if (options.root !== undefined && !isInside(options.root, target)) throw new UnsafePathError(target, `it is outside ${path.resolve(options.root)}`);
  ensureDirSafe(path.dirname(target), options);
  const st = lstatOrNull(target);
  if (st?.isSymbolicLink()) throw new UnsafePathError(target, "the file is a symbolic link");
  if (st && !st.isFile()) throw new UnsafePathError(target, "not a regular file");
  return target;
}

/** Appends `data` to `file`, creating it (mode 0o600 unless given) when absent. */
export function appendFileSafe(file: string, data: string | Uint8Array, options: SafeWriteOptions = {}): void {
  const target = prepare(file, options);
  const fd = openNoFollow(target, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, options.mode ?? 0o600);
  try {
    checkOpenFile(fd, target);
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
  } finally {
    fs.closeSync(fd);
  }
}

/** Replaces `file` with `data` in one rename, keeping an existing file's mode unless one is given. */
export function writeFileSafe(file: string, data: string | Uint8Array, options: SafeWriteOptions = {}): void {
  const target = prepare(file, options);
  let mode = options.mode ?? 0o600;
  const existing = lstatOrNull(target);
  if (existing) {
    if (uid !== null && existing.uid !== uid) throw new UnsafePathError(target, "owned by another user");
    if (existing.nlink > 1) throw new UnsafePathError(target, "the file has more than one hard link");
    if (options.mode === undefined) mode = existing.mode & 0o777;
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = openNoFollow(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    try {
      fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      fs.fchmodSync(fd, mode);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* already renamed or never created */
    }
    throw error;
  }
}

/**
 * Creates `file` only when nothing (not even a link) exists at its name, and writes `data`.
 * Returns false when the name is taken. For one-shot scaffolds and lock files.
 */
export function createFileExclusive(file: string, data: string | Uint8Array, options: SafeWriteOptions = {}): boolean {
  const fd = openFileExclusive(file, options);
  if (fd === null) return false;
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Opens a new file exclusively (O_CREAT|O_EXCL|O_NOFOLLOW) and returns its descriptor, or null when the name is taken. */
export function openFileExclusive(file: string, options: SafeWriteOptions = {}): number | null {
  const target = path.resolve(file);
  if (options.root !== undefined && !isInside(options.root, target)) throw new UnsafePathError(target, `it is outside ${path.resolve(options.root)}`);
  ensureDirSafe(path.dirname(target), options);
  try {
    return openNoFollow(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, options.mode ?? 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return null;
    throw error;
  }
}

/**
 * Renames `file` to `<file>.1` (replacing an older copy) once it is larger than `maxBytes`. A
 * symlink at either name is refused; an absent file is left alone.
 */
export function rotateFileSafe(file: string, maxBytes: number, options: SafeWriteOptions = {}): void {
  const target = path.resolve(file);
  if (options.root !== undefined && !isInside(options.root, target)) throw new UnsafePathError(target, `it is outside ${path.resolve(options.root)}`);
  const st = lstatOrNull(target);
  if (!st || st.size <= maxBytes) return;
  if (!st.isFile()) throw new UnsafePathError(target, st.isSymbolicLink() ? "the file is a symbolic link" : "not a regular file");
  const old = lstatOrNull(`${target}.1`);
  if (old && !old.isFile()) throw new UnsafePathError(`${target}.1`, old.isSymbolicLink() ? "the file is a symbolic link" : "not a regular file");
  try {
    fs.renameSync(target, `${target}.1`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error; // another process rotated it first
  }
}
