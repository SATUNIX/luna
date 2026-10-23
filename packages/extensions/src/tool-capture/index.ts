// tool-capture: a lossless record of every tool call and its output, for audit and SIEM.
//
// Each call produces a `call` record (the exact arguments the model sent) and a `result` record
// (the exact content and details the model got back, including firewall blocks and errors),
// joined by toolCallId and by the same action hash the firewall audit uses (and the argsHash
// trace-ledger uses). Nothing is truncated: values too large for a line are stored whole as
// content-addressed blobs, and pi's full-output temp file of a truncated bash result is copied
// into a blob and linked by an `attachment` record. Storage, rotation, compression and disk
// budget are in store.ts.
//
// Values are stored byte-exact, secrets included (operator choice), which is why the directory is
// 0700 with 0600 files, protected-paths refuses agent writes there, the firewall treats reading
// it as a credential read, and each record lists the secret kinds it contains in `secrets`.
// PI_KIT_CAPTURE_REDACT=1 stores redacted values instead. PI_KIT_CAPTURE=0 disables capture.
//
// Capture never breaks the agent: every hook is wrapped, failures are counted, reported once and
// shown by /capture.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CaptureStore, defaultOptions } from "./store.ts";

export function captureDir(): string {
  const explicit = process.env.PI_KIT_CAPTURE_DIR?.trim();
  if (explicit) return explicit;
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(process.env.HOME || os.homedir(), ".pi", "agent");
  return path.join(agentDir, "pi-kit", "capture");
}

// The firewall's action hash: sha256 of the key-sorted JSON of { toolName, input }.
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([l], [r]) => l.localeCompare(r)).map(([k, v]) => [k, sortJson(v)]));
}
export function actionHash(toolName: string, input: unknown): string {
  try {
    return crypto.createHash("sha256").update(JSON.stringify(sortJson({ toolName, input }))).digest("hex");
  } catch {
    return "unhashable";
  }
}

// trace-ledger's argsHash: sha256 of `${tool} ${stableStringify(input)}`.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
export function argsHash(tool: string, input: unknown): string {
  try {
    return crypto.createHash("sha256").update(tool + " " + stableStringify(input)).digest("hex");
  } catch {
    return "unhashable";
  }
}

// Secret detection: flags which kinds a record contains. Detection only (values are kept), except
// in redact mode. Every pattern runs in linear time and scanning stops after SCAN_BUDGET characters
// per record; the record then carries `unscanned: true`, and redact mode replaces the text it did
// not scan with `[REDACTED:unscanned]` instead of storing it.
const SECRET_PATTERNS: [string, RegExp][] = [
  ["private_key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["api_key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["bearer", /(authorization\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[^\s"']{8,}/gi],
  // The scheme is bounded (and unanchored) so a long run of scheme characters is not re-scanned
  // from every word boundary.
  ["url_credentials", /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi],
  // Linear time: a key starts only at a token start (lookbehind), the keyword is looked for in its
  // first 64 characters and the key is at most 128 long, and a quoted value needs no closing quote
  // (an unclosed one is redacted to the end of the line), so no run is ever re-scanned.
  ["password_assignment", /((?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{0,64}(?:password|passwd|secret|token|api[_-]?key))[A-Za-z0-9_-]{1,128}["']?\s*[:=]\s*)("[^"\n]{4,}"?|'[^'\n]{4,}'?|[^\s"',;&|]{6,})/gi],
];
const SCAN_BUDGET = 4 * 1024 * 1024;

export const UNSCANNED_MARKER = "[REDACTED:unscanned]";

export function scanSecrets(value: unknown, redact: boolean): { kinds: string[]; value: unknown; unscanned: boolean } {
  const kinds = new Set<string>();
  let budget = SCAN_BUDGET;
  let unscanned = false;
  const seen = new WeakSet<object>();
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (budget <= 0) {
        if (v.length === 0) return v;
        unscanned = true;
        return redact ? UNSCANNED_MARKER : v;
      }
      const scanned = v.length > budget ? v.slice(0, budget) : v;
      budget -= scanned.length;
      if (scanned.length < v.length) unscanned = true;
      // Redact mode keeps only the scanned prefix: text past the budget is never stored unredacted.
      let out = redact && scanned.length < v.length ? scanned : v;
      for (const [kind, re] of SECRET_PATTERNS) {
        re.lastIndex = 0;
        if (!re.test(scanned)) continue;
        kinds.add(kind);
        if (redact) {
          re.lastIndex = 0;
          out = out.replace(re, (m, keep?: string) => (typeof keep === "string" && m.startsWith(keep) ? `${keep}[REDACTED:${kind}]` : `[REDACTED:${kind}]`));
        }
      }
      return redact && scanned.length < v.length ? out + UNSCANNED_MARKER : out;
    }
    if (!v || typeof v !== "object" || v instanceof Uint8Array || v instanceof ArrayBuffer) return v;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) {
      const mapped = v.map(visit);
      return redact ? mapped : v;
    }
    if (v instanceof Date || v instanceof Error || v instanceof Map || v instanceof Set) return v;
    if (!redact) {
      for (const k of Object.keys(v)) {
        try {
          visit((v as Record<string, unknown>)[k]);
        } catch {
          /* getter threw */
        }
      }
      return v;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      try {
        out[k] = visit((v as Record<string, unknown>)[k]);
      } catch (error) {
        out[k] = { $getter_error: String(error) };
      }
    }
    return out;
  };
  const out = visit(value);
  return { kinds: [...kinds].sort(), value: redact ? out : value, unscanned };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A field pi's types do not declare (or of a loosely typed payload): `unknown` until checked. */
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function sessionIdOf(ctx: ExtensionContext | undefined): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id) return id;
  } catch {
    /* optional */
  }
  const sessionId = field(ctx, "sessionId");
  return typeof sessionId === "string" && sessionId ? sessionId : `pid-${process.pid}`;
}

function rootSessionOf(own: string): string {
  const inherited = process.env.PI_KIT_FIREWALL_ROOT_SESSION?.trim();
  return inherited && (process.env.PI_KIT_INTERNAL_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "1") ? inherited : own;
}

// One store per process, shared across extension reloads so the exit handler closes the current one.
const GLOBAL_KEY = Symbol.for("pi-kit.tool-capture.store");
type Holder = { store: CaptureStore | null; exitHooked: boolean };
function holder(): Holder {
  const g: Record<symbol, unknown> = globalThis;
  const existing = g[GLOBAL_KEY];
  // Only this extension writes the slot (any loaded copy of it), so what is there is a Holder.
  if (existing) return existing as Holder;
  const created: Holder = { store: null, exitHooked: false };
  g[GLOBAL_KEY] = created;
  return created;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_KIT_CAPTURE === "0") return;
  const redact = process.env.PI_KIT_CAPTURE_REDACT === "1";
  const started = new Map<string, number>();
  let store: CaptureStore | null = null;
  let initError = "";
  let warned = false;

  const report = (ctx: ExtensionContext | undefined, message: string) => {
    if (warned) return;
    warned = true;
    try {
      if (ctx?.hasUI) ctx.ui.notify(`tool-capture: ${message} (capture continues best-effort; /capture for status)`, "warning");
      else process.stderr.write(`tool-capture: ${message}\n`);
    } catch {
      /* nothing more to do */
    }
  };

  const open = (ctx?: ExtensionContext): CaptureStore | null => {
    if (store) return store;
    try {
      const h = holder();
      if (h.store) void h.store.close().catch(() => undefined);
      store = new CaptureStore(defaultOptions(captureDir()));
      store.init();
      h.store = store;
      if (!h.exitHooked) {
        h.exitHooked = true;
        process.once("exit", () => holder().store?.closeSync());
      }
      return store;
    } catch (error) {
      initError = error instanceof Error ? error.message : String(error);
      store = null;
      report(ctx, `cannot open ${captureDir()}: ${initError}`);
      return null;
    }
  };

  const common = (ctx: ExtensionContext | undefined) => {
    const session = sessionIdOf(ctx);
    return {
      session,
      rootSession: rootSessionOf(session),
      child: process.env.PI_KIT_INTERNAL_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "1" || undefined,
      agent: field(field(ctx, "agent"), "name") || field(ctx, "agentName") || undefined,
      cwd: typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd(),
    };
  };

  // Wraps a hook so capture can never throw into pi or delay a tool call beyond its own work.
  const guard =
    <E>(fn: (event: E, ctx: ExtensionContext) => void | Promise<void>) =>
    async (event: E, ctx: ExtensionContext): Promise<undefined> => {
      try {
        await fn(event, ctx);
        if (store?.stats.errors && !warned) report(ctx, store.stats.lastError);
      } catch (error) {
        if (store) store.stats.errors++;
        report(ctx, error instanceof Error ? error.message : String(error));
      }
      return undefined;
    };

  pi.on(
    "session_start",
    guard((event, ctx) => {
      const s = open(ctx);
      s?.append({ kind: "session", event: "start", reason: event?.reason, previousSessionFile: event?.previousSessionFile, ...common(ctx), redacted: redact || undefined, argv: process.argv.slice(1) });
    }),
  );

  pi.on(
    "tool_execution_start",
    guard((event, ctx) => {
      const s = open(ctx);
      if (!s) return;
      const tool = event?.toolName ?? "unknown";
      const id = event?.toolCallId ?? "";
      started.set(id, Date.now());
      if (started.size > 10_000) started.delete(started.keys().next().value as string);
      const args: unknown = event?.args;
      const scan = scanSecrets(args, redact);
      s.append({ kind: "call", ...common(ctx), toolCallId: id, tool, actionHash: actionHash(tool, args ?? {}), argsHash: argsHash(tool, args), args: s.encode(scan.value), secrets: scan.kinds.length ? scan.kinds : undefined, redacted: redact && (scan.kinds.length || scan.unscanned) ? true : undefined, unscanned: scan.unscanned || undefined });
    }),
  );

  pi.on(
    "tool_execution_end",
    guard((event, ctx) => {
      const s = open(ctx);
      if (!s) return;
      const tool = event?.toolName ?? "unknown";
      const id = event?.toolCallId ?? "";
      const t0 = started.get(id);
      started.delete(id);
      const result: unknown = event?.result;
      const scan = scanSecrets(result, redact);
      const base = { ...common(ctx), toolCallId: id, tool };
      s.append({ kind: "result", ...base, isError: event?.isError, durationMs: t0 === undefined ? undefined : Date.now() - t0, result: s.encode(scan.value), secrets: scan.kinds.length ? scan.kinds : undefined, redacted: redact && (scan.kinds.length || scan.unscanned) ? true : undefined, unscanned: scan.unscanned || undefined });

      // pi keeps the untruncated output of a long bash result in a temp file: store it whole.
      const full = field(field(result, "details"), "fullOutputPath");
      if (typeof full === "string" && full && !redact) {
        // Copied in the background (streamed, gzip) so a large output does not hold up the agent.
        s.track(s.putFileBlob(full).then((blob) => s.append({ kind: "attachment", ...base, role: "full_output", sourcePath: full, content: blob })));
      } else if (typeof full === "string" && full) {
        s.append({ kind: "attachment", ...base, role: "full_output", sourcePath: full, content: { $blob_skipped: "redact_mode", bytes: 0 } });
      }
    }),
  );

  pi.on(
    "session_shutdown",
    guard(async (event, ctx) => {
      if (!store) return;
      store.append({ kind: "session", event: "shutdown", reason: event?.reason, ...common(ctx) });
      const s = store;
      store = null;
      if (holder().store === s) holder().store = null;
      await s.close();
    }),
  );

  pi.registerCommand("capture", {
    description: "Tool I/O capture: status, or `prune` to apply the disk budget now.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const s = open(ctx);
      const say = (m: string): void => {
        if (ctx.hasUI) ctx.ui.notify(m, "info");
        else process.stdout.write(`${m}\n`);
      };
      if (!s) {
        say(`tool-capture: unavailable — ${initError || "disabled"} (${captureDir()})`);
        return;
      }
      if ((args ?? "").trim() === "prune") s.maybePrune(true);
      const u = s.usage();
      const mib = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MiB`;
      say(
        [
          `tool-capture: ${captureDir()}${redact ? " (redacted mode)" : ""}`,
          `  active segment: ${path.basename(s.activeSegment) || "(none yet)"}`,
          `  stored: ${u.segments} segment(s) ${mib(u.segmentBytes)}, ${u.blobs} blob(s) ${mib(u.blobBytes)} of ${mib(s.opts.budgetBytes)} budget; free ${u.free === null ? "?" : mib(u.free)}; pressure ${u.pressure}`,
          `  this process: ${s.stats.records} record(s), ${s.stats.blobs} new blob(s) (${s.stats.blobReuse} reused), ${s.stats.pruned} pruned, ${s.stats.dropped} dropped, ${s.stats.errors} error(s)${s.stats.lastError ? ` — last: ${s.stats.lastError}` : ""}`,
        ].join("\n"),
      );
    },
  });
}
