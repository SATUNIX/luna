// Lossless, rotating, self-pruning capture store.
//
//   <dir>/segments/<host>-<pid>-<start>-<n>.jsonl      active segment of one process (0600)
//   <dir>/segments/<host>-<pid>-<start>-<n>.jsonl.gz   rotated + compressed
//   <dir>/blobs/<aa>/<sha256>.gz                       content-addressed values too big to inline
//   <dir>/retention.jsonl                              every file the pruner deleted, and why
//
// Each process writes only its own segment, so concurrent sessions and subagents never share a
// file handle (no interleaving, no locks on the hot path). A value too large for a line is never
// cut: it is stored whole as a gzip blob named by the sha256 of its exact bytes and the record
// links to it. Every JSON value survives: strings with control bytes, NULs or lone surrogates are
// escaped by JSON.stringify; bytes (Buffer/Uint8Array) become blobs; non-JSON values are tagged.
// When the disk budget or free space runs out the oldest compressed segments and least recently
// referenced blobs are pruned (logged in retention.jsonl); if space is still short, blobs and then
// records are skipped with an explicit marker ($blob_skipped, a "gap" record) — never silently.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

// encoding: how to turn the blob bytes back into the value — "utf8" string, "utf16le" string
// (a string with lone surrogates, which UTF-8 cannot carry), or raw "bytes".
export type BlobRef = { $blob: string; bytes: number; encoding: "utf8" | "utf16le" | "bytes" };
export type Skipped = { $blob_skipped: string; bytes: number; sha256?: string };

export type StoreOptions = {
  dir: string;
  inlineBytes: number; // strings longer than this (UTF-8 bytes) go to blobs
  segmentBytes: number; // rotate the active segment after this many bytes
  budgetBytes: number; // total size of compressed segments + blobs
  minFreeBytes: number; // keep at least this much free on the filesystem
  maxBlobBytes: number; // a single attachment larger than this is recorded as skipped
};

export function defaultOptions(dir: string): StoreOptions {
  const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const budget = num("PI_KIT_CAPTURE_MAX_BYTES", 2 * 1024 ** 3);
  return {
    dir,
    inlineBytes: num("PI_KIT_CAPTURE_INLINE_BYTES", 32 * 1024),
    segmentBytes: num("PI_KIT_CAPTURE_SEGMENT_BYTES", 32 * 1024 ** 2),
    budgetBytes: budget,
    minFreeBytes: num("PI_KIT_CAPTURE_MIN_FREE_BYTES", 1024 ** 3),
    maxBlobBytes: num("PI_KIT_CAPTURE_MAX_BLOB_BYTES", Math.max(1, Math.floor(budget / 4))),
  };
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class CaptureStore {
  readonly opts: StoreOptions;
  readonly host = os.hostname().replace(/[^A-Za-z0-9.-]/g, "_");
  readonly started = new Date().toISOString().replace(/[:.]/g, "-");
  private fd: number | null = null;
  private segPath = "";
  private segBytes = 0;
  private segIndex = 0;
  private seq = 0;
  private lastPrune = 0;
  private pressure: "ok" | "blobs" | "records" = "ok";
  private dropped = 0;
  private closed = false;
  readonly stats = { records: 0, blobs: 0, blobReuse: 0, errors: 0, dropped: 0, pruned: 0, lastError: "" };
  private pendingWork = new Set<Promise<unknown>>();

  constructor(opts: StoreOptions) {
    this.opts = opts;
  }

  get segmentsDir(): string {
    return path.join(this.opts.dir, "segments");
  }
  get blobsDir(): string {
    return path.join(this.opts.dir, "blobs");
  }
  get activeSegment(): string {
    return this.segPath;
  }

  init(): void {
    for (const d of [this.opts.dir, this.segmentsDir, this.blobsDir]) {
      fs.mkdirSync(d, { recursive: true, mode: DIR_MODE });
      try {
        fs.chmodSync(d, DIR_MODE);
      } catch {
        /* not ours to chmod */
      }
    }
    this.sweepOrphans();
    this.maybePrune(true);
  }

  // --- values -------------------------------------------------------------------------------

  // A JSON-safe, lossless copy of `value`: big strings and bytes are moved to blobs.
  encode(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") <= this.opts.inlineBytes) return value;
      return wellFormed(value) ? this.putBlob(Buffer.from(value, "utf8"), "utf8") : this.putBlob(Buffer.from(value, "utf16le"), "utf16le");
    }
    if (typeof value === "bigint") return { $bigint: value.toString() };
    if (typeof value === "undefined") return { $undefined: true };
    if (typeof value === "function") return { $function: value.name || "anonymous" };
    if (typeof value === "symbol") return { $symbol: value.toString() };
    if (value instanceof Uint8Array) return this.putBlob(Buffer.from(value.buffer, value.byteOffset, value.byteLength), "bytes");
    if (value instanceof ArrayBuffer) return this.putBlob(Buffer.from(value), "bytes");
    if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? String(value) : value.toISOString() };
    if (value instanceof Error) return { $error: value.name, message: this.encode(value.message, seen, depth + 1), stack: this.encode(value.stack ?? "", seen, depth + 1) };
    if (typeof value !== "object") {
      const other: unknown = value; // not reached: typeof has no other primitive left
      return { $unknown: String(other) };
    }
    if (seen.has(value)) return { $circular: true };
    if (depth > 64) return { $depth_limit: true, json: this.encode(safeStringify(value), seen, depth) };
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((v) => this.encode(v, seen, depth + 1));
      if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [this.encode(k, seen, depth + 1), this.encode(v, seen, depth + 1)]) };
      if (value instanceof Set) return { $set: [...value].map((v) => this.encode(v, seen, depth + 1)) };
      // A null-prototype record: assigning "__proto__" onto {} would set the prototype instead of
      // keeping the key, and the subtree would vanish from the lossless log.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const k of Object.keys(value)) {
        let v: unknown;
        try {
          v = (value as Record<string, unknown>)[k];
        } catch (error) {
          v = { $getter_error: String(error) };
        }
        out[k] = this.encode(v, seen, depth + 1);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  putBlob(bytes: Buffer, encoding: BlobRef["encoding"]): BlobRef | Skipped {
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (this.pressure !== "ok" || bytes.length > this.opts.maxBlobBytes) return { $blob_skipped: this.pressure !== "ok" ? "disk_pressure" : "exceeds_max_blob_bytes", bytes: bytes.length, sha256: sha };
    const file = this.blobPath(sha);
    try {
      if (fs.existsSync(file)) {
        const now = new Date();
        fs.utimesSync(file, now, now); // recency drives pruning: a reused blob stays
        this.stats.blobReuse++;
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, zlib.gzipSync(bytes), { mode: FILE_MODE });
        fs.renameSync(tmp, file);
        this.stats.blobs++;
      }
      return { $blob: `sha256:${sha}`, bytes: bytes.length, encoding };
    } catch (error) {
      this.fail(error);
      return { $blob_skipped: `write_error: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`, bytes: bytes.length, sha256: sha };
    }
  }

  blobPath(sha: string): string {
    return path.join(this.blobsDir, sha.slice(0, 2), `${sha}.gz`);
  }

  // Streams a file (e.g. pi's full bash output) into a blob without loading it into memory.
  async putFileBlob(file: string): Promise<BlobRef | Skipped> {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch (error) {
      return { $blob_skipped: `unreadable: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`, bytes: 0 };
    }
    if (this.pressure !== "ok" || size > this.opts.maxBlobBytes) return { $blob_skipped: this.pressure !== "ok" ? "disk_pressure" : "exceeds_max_blob_bytes", bytes: size };
    const tmp = path.join(this.blobsDir, `.incoming-${process.pid}-${crypto.randomUUID()}.gz`);
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    try {
      await pipeline(
        fs.createReadStream(file),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            bytes += chunk.length;
            yield chunk;
          }
        },
        zlib.createGzip(),
        fs.createWriteStream(tmp, { mode: FILE_MODE }),
      );
      const sha = hash.digest("hex");
      const dest = this.blobPath(sha);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: DIR_MODE });
      if (fs.existsSync(dest)) {
        fs.unlinkSync(tmp);
        const now = new Date();
        fs.utimesSync(dest, now, now);
        this.stats.blobReuse++;
      } else {
        fs.renameSync(tmp, dest);
        this.stats.blobs++;
      }
      return { $blob: `sha256:${sha}`, bytes, encoding: "bytes" };
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* never created */
      }
      this.fail(error);
      return { $blob_skipped: `write_error: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`, bytes: size };
    }
  }

  // --- records ------------------------------------------------------------------------------

  append(record: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.maybePrune(false);
      if (this.pressure === "records") {
        this.dropped++;
        this.stats.dropped++;
        return;
      }
      if (this.dropped) {
        const gap = this.dropped;
        this.dropped = 0;
        this.writeLine({ kind: "gap", dropped: gap, reason: "disk_pressure" });
      }
      this.writeLine(record);
    } catch (error) {
      this.fail(error);
    }
  }

  private writeLine(record: Record<string, unknown>): void {
    const line = `${safeStringify({ v: 1, ts: new Date().toISOString(), seq: ++this.seq, host: this.host, pid: process.pid, ...record })}\n`;
    const buf = Buffer.from(line, "utf8");
    if (this.fd === null || this.segBytes + buf.length > this.opts.segmentBytes) this.rotate();
    let off = 0;
    while (off < buf.length) off += fs.writeSync(this.fd as number, buf, off, buf.length - off);
    this.segBytes += buf.length;
    this.stats.records++;
  }

  rotate(): void {
    const prev = this.fd !== null ? this.segPath : null;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
    if (prev && !this.closed) this.track(this.compress(prev));
    if (this.closed) return;
    this.segIndex++;
    this.segPath = path.join(this.segmentsDir, `${this.host}-${process.pid}-${this.started}-${String(this.segIndex).padStart(4, "0")}.jsonl`);
    this.fd = fs.openSync(this.segPath, "a", FILE_MODE);
    this.segBytes = 0;
  }

  async compress(file: string): Promise<void> {
    const gz = `${file}.gz`;
    const tmp = `${gz}.${process.pid}.tmp`;
    try {
      await pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(tmp, { mode: FILE_MODE }));
      fs.renameSync(tmp, gz);
      fs.unlinkSync(file);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* none */
      }
      this.fail(error);
    }
  }

  // Segments left uncompressed by processes that are gone (crash, kill -9) are compressed now.
  sweepOrphans(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.segmentsDir);
    } catch {
      return;
    }
    for (const n of names) {
      const full = path.join(this.segmentsDir, n);
      if (n.endsWith(".tmp")) {
        try {
          if (Date.now() - fs.statSync(full).mtimeMs > 3_600_000) fs.unlinkSync(full);
        } catch {
          /* raced */
        }
        continue;
      }
      if (!n.endsWith(".jsonl")) continue;
      const m = /^(.+)-(\d+)-\d{4}-\d\d-\d\dT[\d-]+Z-\d+\.jsonl$/.exec(n);
      if (!m || (m[1] === this.host && alive(Number(m[2])))) continue;
      if (m[1] !== this.host && Date.now() - safeMtime(full) < 24 * 3_600_000) continue; // another host's live file on a shared dir
      this.track(this.compress(full));
    }
  }

  // --- retention ----------------------------------------------------------------------------

  maybePrune(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    try {
      this.prune();
    } catch (error) {
      this.fail(error);
    }
  }

  prune(): void {
    const files: { path: string; bytes: number; mtime: number; kind: "segment" | "blob" }[] = [];
    for (const n of safeReaddir(this.segmentsDir)) {
      if (!n.endsWith(".jsonl.gz")) continue;
      const p = path.join(this.segmentsDir, n);
      const st = safeStat(p);
      if (st) files.push({ path: p, bytes: st.size, mtime: st.mtimeMs, kind: "segment" });
    }
    for (const d of safeReaddir(this.blobsDir)) {
      const sub = path.join(this.blobsDir, d);
      for (const n of safeReaddir(sub)) {
        if (!n.endsWith(".gz")) continue;
        const p = path.join(sub, n);
        const st = safeStat(p);
        if (st) files.push({ path: p, bytes: st.size, mtime: st.mtimeMs, kind: "blob" });
      }
    }
    let total = files.reduce((n, f) => n + f.bytes, 0);
    let free = freeBytes(this.opts.dir);
    const target = Math.floor(this.opts.budgetBytes * 0.9);
    const needed = () => total > this.opts.budgetBytes || (free !== null && free < this.opts.minFreeBytes);
    if (needed()) {
      // Oldest first; segments before blobs of the same age, so records go before what they link.
      files.sort((a, b) => a.mtime - b.mtime || (a.kind === "segment" ? -1 : 1));
      for (const f of files) {
        if (!(total > target || (free !== null && free < this.opts.minFreeBytes))) break;
        const reason = total > target ? "budget" : "free_space";
        try {
          fs.unlinkSync(f.path);
          total -= f.bytes;
          if (free !== null) free += f.bytes;
          this.stats.pruned++;
          this.logRetention({ deleted: path.relative(this.opts.dir, f.path), kind: f.kind, bytes: f.bytes, mtime: new Date(f.mtime).toISOString(), reason });
        } catch {
          /* raced with another pruner */
        }
      }
    }
    this.pressure = free !== null && free < this.opts.minFreeBytes ? (free < this.opts.minFreeBytes / 4 ? "records" : "blobs") : total > this.opts.budgetBytes ? "blobs" : "ok";
  }

  private logRetention(entry: Record<string, unknown>): void {
    try {
      fs.appendFileSync(path.join(this.opts.dir, "retention.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`, { mode: FILE_MODE });
    } catch {
      /* best effort */
    }
  }

  usage(): { segments: number; segmentBytes: number; blobs: number; blobBytes: number; free: number | null; pressure: string } {
    let segments = 0;
    let segmentBytes = 0;
    let blobs = 0;
    let blobBytes = 0;
    for (const n of safeReaddir(this.segmentsDir)) {
      const st = safeStat(path.join(this.segmentsDir, n));
      if (st && /\.jsonl(\.gz)?$/.test(n)) {
        segments++;
        segmentBytes += st.size;
      }
    }
    for (const d of safeReaddir(this.blobsDir)) {
      for (const n of safeReaddir(path.join(this.blobsDir, d))) {
        const st = safeStat(path.join(this.blobsDir, d, n));
        if (st && n.endsWith(".gz")) {
          blobs++;
          blobBytes += st.size;
        }
      }
    }
    return { segments, segmentBytes, blobs, blobBytes, free: freeBytes(this.opts.dir), pressure: this.pressure };
  }

  // --- lifecycle ----------------------------------------------------------------------------

  track(p: Promise<unknown>): void {
    this.pendingWork.add(p);
    // `finally` returns a derived promise that rejects when `p` rejects. Observe it so it can
    // never surface as an unhandled rejection; `flush()` still observes the original `p`.
    void p.finally(() => this.pendingWork.delete(p)).catch(() => { /* observed via flush()'s allSettled */ });
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingWork]);
  }

  // Close and compress the active segment (session end / process exit).
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush(); // background attachments still append to this segment
    if (this.closed) return;
    const last = this.fd !== null ? this.segPath : null;
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* closed */
      }
      this.fd = null;
    }
    if (last) this.track(this.compress(last));
    await this.flush();
  }

  // Synchronous close for process 'exit': the segment stays .jsonl and the next start compresses it.
  closeSync(): void {
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* closed */
      }
      this.fd = null;
    }
  }

  private fail(error: unknown): void {
    this.stats.errors++;
    this.stats.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }
}

function wellFormed(s: string): boolean {
  // isWellFormed is ES2024 (newer than the lib this project compiles against), so it may be absent.
  const f = (s as string & { isWellFormed?: () => boolean }).isWellFormed;
  return typeof f === "function" ? f.call(s) : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch (error) {
    return JSON.stringify({ $unserializable: error instanceof Error ? error.message : String(error) });
  }
}

function alive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function safeMtime(p: string): number {
  return safeStat(p)?.mtimeMs ?? 0;
}

function freeBytes(dir: string): number | null {
  try {
    const statfs: ((p: string) => { bavail: number | bigint; bsize: number | bigint }) | undefined = fs.statfsSync;
    if (typeof statfs !== "function") return null;
    const s = statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
