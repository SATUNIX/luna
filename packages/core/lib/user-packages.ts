/**
 * Packages the operator adds to pi themselves, with a pin ledger (`/packages`, AUTHORITY).
 *
 *   <agent dir>/pi-kit/user-packages.json
 *   { "schemaVersion": 1, "packages": [ { "name", "version", "source": "npm:<name>@<version>",
 *     "integrity": "sha512-...", "review": "user-accepted", "acceptedAt": "<ISO time>" } ] }
 *
 * The rules, each pinned by tests/user-packages-smoke.ts:
 *   - search and review only read the registry (npm's search API for the keyword pi-package, and the
 *     package's metadata); nothing is installed by looking;
 *   - an add names one exact version and the sha512 integrity the operator accepted after seeing the
 *     review (install scripts, dependencies, maintainers, age); a registry that now serves a different
 *     integrity, or a tarball whose bytes do not hash to it, is refused before pi runs;
 *   - pi installs it at user scope with lifecycle scripts off (npm_config_ignore_scripts), and the
 *     integrity npm recorded must match the pin, or the package is removed again;
 *   - a kit companion (sources.json, current or retired) or the kit itself is never added or removed
 *     here, and `remove` removes only what the ledger recorded;
 *   - a package added here is unreviewed by Luna: every listing says so.
 * Network: the registry comes from npm_config_registry (default registry.npmjs.org); plain http is
 * refused except to loopback, every response body is capped, and requests time out.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { array, isRecord, literal, object, parseJson, parseJsonAs, string, type Infer } from "./guard.ts";
import { checkInstalledIntegrity, isSha512Integrity, npmSpec, piNpmRoot } from "./companions.ts";
import { writeFileSafe } from "../shared/safe-fs.ts";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const SEARCH_KEYWORD = "pi-package";
export const METADATA_MAX_BYTES = 8 * 1024 * 1024;
export const TARBALL_MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
/** npm's package-name rule (scoped or not), lower case, no path tricks. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Lifecycle scripts npm would run when the package is installed from a registry. */
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

export const isPackageName = (name: string): boolean => PACKAGE_NAME.test(name) && !name.includes("..");
export const isExactVersion = (version: string): boolean => EXACT_VERSION.test(version);

// --- the ledger ---------------------------------------------------------------------------------

const EntrySchema = object({
  name: string(),
  version: string(),
  source: string(),
  integrity: string(),
  review: literal("user-accepted"),
  acceptedAt: string(),
});
const LedgerSchema = object({ schemaVersion: literal(1), packages: array(EntrySchema, { maxItems: 500 }) });
export type UserPackage = Infer<typeof EntrySchema>;

export function userPackagesPath(agentDir: string): string {
  return path.join(agentDir, "pi-kit", "user-packages.json");
}

/** The ledger: empty when absent; an unreadable or malformed one throws (never silently reset). */
export function readLedger(file: string): UserPackage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const ledger = parseJsonAs(LedgerSchema, raw, file);
  for (const p of ledger.packages) {
    if (!isPackageName(p.name) || !isExactVersion(p.version) || p.source !== `npm:${p.name}@${p.version}` || !isSha512Integrity(p.integrity)) {
      throw new Error(`${file}: the entry for ${JSON.stringify(p.name)} is not a valid pin; fix or remove it by hand`);
    }
  }
  return ledger.packages;
}

export function writeLedger(file: string, packages: readonly UserPackage[]): void {
  writeFileSafe(file, `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
}

// --- the registry -------------------------------------------------------------------------------

/** The registry base URL, checked: https anywhere, http only to loopback. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = (env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY).trim() || DEFAULT_REGISTRY;
  let url: URL;
  try { url = new URL(raw.endsWith("/") ? raw : `${raw}/`); } catch { throw new Error(`the registry ${JSON.stringify(raw)} is not a URL`); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`refusing the registry ${url.origin}: only https (or http to loopback) is allowed`);
  if (url.username || url.password) throw new Error("refusing a registry URL that carries credentials");
  return url;
}

export type Fetcher = (url: URL) => Promise<{ status: number; body: Uint8Array }>;

/** GET `url`, reading at most `max` bytes (a larger body is an error, never truncated data). */
export function cappedFetcher(max: number): Fetcher {
  return async (url) => {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json, application/octet-stream" } });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > max) throw new Error(`${url.origin}${url.pathname}: the response is ${String(declared)} bytes; the limit is ${String(max)}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          await reader.cancel();
          throw new Error(`${url.origin}${url.pathname}: the response is over the ${String(max)}-byte limit`);
        }
        chunks.push(value);
      }
    }
    return { status: response.status, body: Buffer.concat(chunks) };
  };
}

async function getJson(fetcher: Fetcher, url: URL): Promise<unknown> {
  const r = await fetcher(url);
  if (r.status === 404) throw new Error(`${url.pathname.replace(/^\//, "")} is not on the registry`);
  if (r.status !== 200) throw new Error(`the registry answered ${String(r.status)} for ${url.pathname}`);
  return parseJson(Buffer.from(r.body).toString("utf8"));
}

// Control and format characters (bidi overrides, zero-width) are replaced, so a review reads as stored.
const text = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, max) : "");

export interface SearchHit {
  name: string;
  version: string;
  description: string;
}

/** npm's search for packages with the pi-package keyword and the operator's words. Read-only. */
export async function searchPackages(query: string, registry: URL, fetcher: Fetcher = cappedFetcher(METADATA_MAX_BYTES)): Promise<SearchHit[]> {
  const url = new URL("-/v1/search", registry);
  url.searchParams.set("text", `keywords:${SEARCH_KEYWORD} ${query}`.trim());
  url.searchParams.set("size", "25");
  const body = await getJson(fetcher, url);
  const objects = isRecord(body) && Array.isArray(body.objects) ? body.objects : [];
  const hits: SearchHit[] = [];
  for (const o of objects) {
    const p = isRecord(o) && isRecord(o.package) ? o.package : null;
    if (!p || typeof p.name !== "string" || !isPackageName(p.name)) continue;
    hits.push({ name: p.name, version: text(p.version, 40), description: text(p.description) });
  }
  return hits;
}

/** What the operator sees before accepting a package. */
export interface PackageReview {
  name: string;
  version: string;
  source: string;
  integrity: string;
  tarball: string;
  installScripts: Record<string, string>;
  dependencies: string[];
  maintainers: string[];
  publishedAt: string | null;
  ageDays: number | null;
  description: string;
}

/** The registry's metadata for `name` at `version` (default: its `latest` tag). Read-only. */
export async function reviewPackage(name: string, version: string | undefined, registry: URL, fetcher: Fetcher = cappedFetcher(METADATA_MAX_BYTES), now = new Date()): Promise<PackageReview> {
  if (!isPackageName(name)) throw new Error(`${JSON.stringify(name)} is not an npm package name`);
  if (version !== undefined && !isExactVersion(version)) throw new Error(`${JSON.stringify(version)} is not an exact version`);
  const doc = await getJson(fetcher, new URL(name.replaceAll("/", "%2f"), registry));
  if (!isRecord(doc)) throw new Error(`the registry's metadata for ${name} is not an object`);
  const tags = isRecord(doc["dist-tags"]) ? doc["dist-tags"] : {};
  const chosen = version ?? (typeof tags.latest === "string" ? tags.latest : undefined);
  if (chosen === undefined || !isExactVersion(chosen)) throw new Error(`${name} has no usable latest version; name one exactly`);
  const versions = isRecord(doc.versions) ? doc.versions : {};
  const meta = Object.hasOwn(versions, chosen) ? versions[chosen] : undefined;
  if (!isRecord(meta)) throw new Error(`${name}@${chosen} is not on the registry`);
  const dist = isRecord(meta.dist) ? meta.dist : {};
  if (!isSha512Integrity(dist.integrity)) throw new Error(`${name}@${chosen} publishes no sha512 integrity; it cannot be pinned`);
  if (typeof dist.tarball !== "string") throw new Error(`${name}@${chosen} names no tarball`);
  const scripts = isRecord(meta.scripts) ? meta.scripts : {};
  const installScripts: Record<string, string> = {};
  for (const key of INSTALL_SCRIPTS) if (typeof scripts[key] === "string") installScripts[key] = text(scripts[key], 300);
  const deps = isRecord(meta.dependencies) ? meta.dependencies : {};
  const maintainers = (Array.isArray(meta.maintainers) ? meta.maintainers : Array.isArray(doc.maintainers) ? doc.maintainers : [])
    .map((m) => (isRecord(m) ? text(m.name, 80) : text(m, 80))).filter(Boolean);
  const times = isRecord(doc.time) ? doc.time : {};
  const published = typeof times[chosen] === "string" ? times[chosen] : null;
  const at = published === null ? NaN : Date.parse(published);
  return {
    name, version: chosen, source: `npm:${name}@${chosen}`, integrity: dist.integrity, tarball: dist.tarball,
    installScripts,
    dependencies: Object.keys(deps).sort().map((d) => `${text(d, 120)}@${text(deps[d], 60)}`),
    maintainers,
    publishedAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    ageDays: Number.isFinite(at) ? Math.floor((now.getTime() - at) / 86_400_000) : null,
    description: text(meta.description ?? doc.description),
  };
}

/** The review as the operator reads it, with the unreviewed banner. */
export function formatReview(r: PackageReview): string[] {
  const scripts = Object.entries(r.installScripts);
  return [
    `UNREVIEWED: ${r.name} is not reviewed by Luna. Adding it means you accept it yourself.`,
    `  package:      ${r.name}@${r.version}${r.description ? ` - ${r.description}` : ""}`,
    `  published:    ${r.publishedAt ?? "unknown"}${r.ageDays === null ? "" : ` (${String(r.ageDays)} day(s) ago)`}`,
    `  maintainers:  ${r.maintainers.join(", ") || "none listed"}`,
    `  dependencies: ${r.dependencies.length ? `${r.dependencies.join(", ")} (resolved by range when installed: NOT pinned or verified by Luna)` : "none"}`,
    `  install scripts (not run: installs here have scripts off): ${scripts.length ? scripts.map(([k, v]) => `${k}: ${v}`).join("; ") : "none"}`,
    `  integrity:    ${r.integrity}`,
  ];
}

/** Download the tarball and compare its sha512 with the pinned integrity. */
export async function verifyTarball(r: PackageReview, registry: URL, fetcher: Fetcher = cappedFetcher(TARBALL_MAX_BYTES)): Promise<void> {
  let url: URL;
  try { url = new URL(r.tarball); } catch { throw new Error(`${r.name}@${r.version}: the tarball URL is not a URL`); }
  if (url.origin !== registry.origin) throw new Error(`${r.name}@${r.version}: the tarball is on ${url.origin}, not the registry ${registry.origin}`);
  const got = await fetcher(url);
  if (got.status !== 200) throw new Error(`${r.name}@${r.version}: the registry answered ${String(got.status)} for the tarball`);
  const integrity = `sha512-${crypto.createHash("sha512").update(got.body).digest("base64")}`;
  if (integrity !== r.integrity) throw new Error(`${r.name}@${r.version}: the tarball hashes to ${integrity}, not the pinned ${r.integrity}; refusing it`);
}

// --- add and remove -----------------------------------------------------------------------------

export interface PackageDeps {
  agentDir: string;
  registry: URL;
  /** Package names the kit owns (sources.json external and retired, and the kit's own packages). */
  kitPackages: ReadonlySet<string>;
  /** Run `pi <args>` with extra environment; throws on failure. */
  pi: (args: readonly string[], env: Readonly<Record<string, string>>) => void;
  metadata?: Fetcher;
  tarballs?: Fetcher;
  now?: Date;
}

/**
 * Add `name@version` with the integrity the operator accepted. Refuses before pi runs when the
 * package is the kit's, already recorded, or the registry now serves anything other than the
 * accepted pin; removes it again when npm recorded a different integrity. Returns the ledger entry.
 */
export async function addPackage(deps: PackageDeps, name: string, version: string, accepted: string): Promise<UserPackage> {
  if (deps.kitPackages.has(name)) throw new Error(`${name} is a Luna companion or Luna itself; the kit installs and pins it, /packages does not`);
  if (!isSha512Integrity(accepted)) throw new Error("the accepted integrity must be the sha512 the review showed");
  const file = userPackagesPath(deps.agentDir);
  const ledger = readLedger(file);
  if (ledger.some((p) => p.name === name)) throw new Error(`${name} is already added; remove it first to change the version`);
  const review = await reviewPackage(name, version, deps.registry, deps.metadata, deps.now);
  if (review.integrity !== accepted) throw new Error(`${name}@${version}: the registry now serves integrity ${review.integrity}, not the ${accepted} you accepted; refusing it`);
  await verifyTarball(review, deps.registry, deps.tarballs);
  // The registry that was reviewed is the one npm installs from: npm otherwise also reads .npmrc,
  // including a scoped registry, which the environment variable alone does not override.
  const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : null;
  deps.pi(["install", review.source], { npm_config_ignore_scripts: "true", npm_config_registry: deps.registry.href, ...(scope ? { [`npm_config_${scope}:registry`]: deps.registry.href } : {}) });
  const checked = checkInstalledIntegrity(piNpmRoot("global", deps.agentDir, deps.agentDir), { name, source: review.source, integrity: review.integrity, mode: "reference" });
  if (!checked.ok) {
    deps.pi(["remove", review.source], {});
    throw new Error(`${checked.reason}; removed it again`);
  }
  const entry: UserPackage = { name, version: review.version, source: review.source, integrity: review.integrity, review: "user-accepted", acceptedAt: (deps.now ?? new Date()).toISOString() };
  try {
    writeLedger(file, [...ledger, entry]);
  } catch (error) {
    // Never leave an installed package the ledger does not know about.
    deps.pi(["remove", review.source], {});
    throw new Error(`could not record ${review.source} in ${file} (${error instanceof Error ? error.message : String(error)}); removed it again`, { cause: error });
  }
  return entry;
}

/** Remove a package /packages added. Anything the ledger did not record is refused. */
export function removePackage(deps: Pick<PackageDeps, "agentDir" | "kitPackages" | "pi">, name: string): UserPackage {
  // A kit companion is refused whatever the ledger says: a hand-edited entry cannot remove one.
  if (deps.kitPackages.has(name)) throw new Error(`${name} is a Luna companion; /packages removes only what it added (change the profile instead)`);
  const file = userPackagesPath(deps.agentDir);
  const ledger = readLedger(file);
  const entry = ledger.find((p) => p.name === name);
  if (!entry) throw new Error(`${name} was not added with /packages, so it is left alone`);
  if (npmSpec(entry.source)?.name !== name) throw new Error(`${file}: the entry for ${name} names another source`);
  deps.pi(["remove", entry.source], {});
  writeLedger(file, ledger.filter((p) => p !== entry));
  return entry;
}
