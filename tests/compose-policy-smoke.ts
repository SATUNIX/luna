#!/usr/bin/env node
/**
 * Compose policy: every compose file the repository tracks is checked against one
 * policy, so a new service or port cannot ship looser than the reviewed ones.
 *
 * Every service in a base compose file (one that names an image or a build):
 *   - publishes ports only on a loopback host IP (127.0.0.1 or ::1), never on every interface;
 *   - when it publishes a port, requires a credential: an environment entry whose value is a
 *     required `${VAR:?...}` interpolation of a KEY/TOKEN/PASSWORD/SECRET-named variable, or a
 *     recorded exemption below with its reason;
 *   - drops every capability and sets no-new-privileges; is never privileged, never on the host
 *     network or PID namespace, and never mounts the container-engine socket.
 * Override files (services with neither image nor build) are checked for the same port, privilege
 * and socket rules. The pentest-capable `pi-agent` service mounts its engagement directory
 * read-only at /workspace/engagement from outside its data root.
 *
 * Each rule is shown to fail on a fixture. Not covered here: an internal network with a
 * scope-enforcing egress proxy for the pentest container (the container still has ordinary
 * egress; packages/container/README.md says so). Parses YAML with `yaml`, which pi itself depends on.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { ROOT } from "../packages/core/eval/harness.ts";
import { isRecord } from "../packages/core/lib/guard.ts";

/** Services allowed to publish a port without a credential, and why. */
const CREDENTIAL_EXEMPT: Readonly<Record<string, string>> = {
  "pi-agent": "publishes only the read-only health endpoint (scripts/healthcheck.py), on loopback",
};
/** Services that run the pentest capability and so must take their engagement scope read-only. */
const ENGAGEMENT_SERVICES = ["pi-agent"];
const ENGAGEMENT_TARGET = "/workspace/engagement";
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]"]);
const CREDENTIAL_NAME = /(KEY|TOKEN|PASSWORD|SECRET)/i;

/** A compose value with every `${VAR:-default}` / `${VAR-default}` replaced by its default. */
const withDefaults = (text: string): string => text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, "$1");

/** The host IP of a short-syntax port mapping, or null when it binds every interface. */
function shortHostIp(spec: string): string | null {
  const value = withDefaults(spec).replace(/\/(tcp|udp|sctp)$/, "");
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 && value.slice(end + 1).split(":").length === 3 ? value.slice(0, end + 1) : null;
  }
  const parts = value.split(":");
  return parts.length === 3 ? parts[0] ?? null : null;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** The environment of a service as name -> raw value (list or map syntax). */
function environment(svc: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const env = svc.environment;
  if (Array.isArray(env)) for (const item of strings(env)) { const i = item.indexOf("="); out.set(i < 0 ? item : item.slice(0, i), i < 0 ? "" : item.slice(i + 1)); }
  else if (isRecord(env)) for (const [k, v] of Object.entries(env)) out.set(k, typeof v === "string" ? v : String(v));
  return out;
}

const requiredCredential = (svc: Record<string, unknown>): boolean =>
  [...environment(svc).values()].some((v) => /^\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}$/.exec(v.trim())?.[1]?.match(CREDENTIAL_NAME) != null);

interface Mount { source: string | null; target: string | null; readOnly: boolean }
function mounts(svc: Record<string, unknown>): Mount[] {
  const out: Mount[] = [];
  for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
    if (typeof v === "string") {
      const [source = null, target = null, mode = ""] = v.split(":");
      out.push({ source, target, readOnly: mode.split(",").includes("ro") });
    } else if (isRecord(v)) {
      out.push({ source: typeof v.source === "string" ? v.source : null, target: typeof v.target === "string" ? v.target : null, readOnly: v.read_only === true });
    }
  }
  return out;
}

/** Every policy problem in one compose file's text. */
function composePolicyProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  const doc: unknown = parse(text);
  if (!isRecord(doc) || !isRecord(doc.services)) return [`${file}: no services`];
  for (const [name, raw] of Object.entries(doc.services)) {
    const at = `${file}: service ${name}`;
    if (!isRecord(raw)) { problems.push(`${at}: not a mapping`); continue; }
    const svc = raw;
    const base = svc.image !== undefined || (isRecord(svc.build) && svc.build.context !== undefined) || typeof svc.build === "string";
    const ports: unknown[] = Array.isArray(svc.ports) ? svc.ports : [];
    for (const port of ports) {
      const ip = typeof port === "string" || typeof port === "number" ? shortHostIp(String(port)) : isRecord(port) && typeof port.host_ip === "string" ? withDefaults(port.host_ip) : null;
      if (ip === null) problems.push(`${at}: port ${JSON.stringify(port)} names no host IP, so it binds every interface`);
      else if (!LOOPBACK.has(ip)) problems.push(`${at}: port ${JSON.stringify(port)} binds ${ip}, not loopback`);
    }
    if (ports.length && base && !requiredCredential(svc) && !Object.hasOwn(CREDENTIAL_EXEMPT, name)) problems.push(`${at}: publishes a port but requires no credential (a \${VAR:?} KEY/TOKEN/PASSWORD/SECRET variable)`);
    if (svc.privileged === true) problems.push(`${at}: privileged`);
    for (const key of ["network_mode", "pid", "ipc"]) if (svc[key] === "host") problems.push(`${at}: ${key}: host`);
    for (const m of mounts(svc)) if (m.source && /(^|\/)(docker|podman)\.sock$/.test(withDefaults(m.source))) problems.push(`${at}: mounts the container-engine socket`);
    if (strings(svc.cap_add).length) problems.push(`${at}: cap_add ${strings(svc.cap_add).join(",")}`);
    if (base) {
      if (!strings(svc.cap_drop).some((c) => c.toUpperCase() === "ALL")) problems.push(`${at}: missing cap_drop: [ALL]`);
      if (!strings(svc.security_opt).some((o) => /^no-new-privileges(:true)?$/.test(o))) problems.push(`${at}: missing security_opt no-new-privileges:true`);
    }
    if (base && ENGAGEMENT_SERVICES.includes(name)) {
      const engagement = mounts(svc).filter((m) => m.target === ENGAGEMENT_TARGET);
      const dataRoots = mounts(svc).filter((m) => m.target !== ENGAGEMENT_TARGET).map((m) => withDefaults(m.source ?? ""));
      if (engagement.length !== 1) problems.push(`${at}: must mount its engagement directory at ${ENGAGEMENT_TARGET} exactly once`);
      for (const m of engagement) {
        if (!m.readOnly) problems.push(`${at}: the engagement mount must be read-only`);
        const src = withDefaults(m.source ?? "");
        if (dataRoots.some((root) => root && (src === root || src.startsWith(`${root}/`)))) problems.push(`${at}: the engagement source ${src} is inside a writable data mount`);
      }
    }
  }
  return problems;
}

// --- the repository's compose files ---------------------------------------------------------------
const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
assert.equal(tracked.status, 0, tracked.stderr);
const composeFiles = tracked.stdout.split("\0").filter((f) => /(^|\/)([^/]*compose[^/]*)\.ya?ml$/.test(f));
assert.ok(composeFiles.length >= 4, `the compose files were found: ${composeFiles.join(", ")}`);
for (const file of composeFiles) {
  assert.deepEqual(composePolicyProblems(file, fs.readFileSync(path.join(ROOT, file), "utf8")), [], `${file} meets the compose policy`);
}
const qdrant = fs.readFileSync(path.join(ROOT, "packages/container/mcp-servers/memory-mcp/docker-compose.yml"), "utf8");
assert.match(qdrant, /QDRANT__SERVICE__API_KEY: \$\{QDRANT_API_KEY:\?/, "Qdrant requires an API key");
assert.match(qdrant, /-unprivileged@sha256:[0-9a-f]{64}/, "Qdrant runs the non-root image, pinned by digest");

// --- each rule can fail -------------------------------------------------------------------------
const svc = (body: string): string => `services:\n  store:\n    image: example.invalid/store:1\n${body}`;
const hardened = "    cap_drop: [ALL]\n    security_opt: [\"no-new-privileges:true\"]\n";
const key = "    environment:\n      API_KEY: ${STORE_API_KEY:?required}\n";
const cases: Array<[string, string, RegExp]> = [
  ["all interfaces", svc(`    ports: ["\${PORT:-6333}:6333"]\n${key}${hardened}`), /names no host IP/],
  ["a LAN address", svc(`    ports: ["0.0.0.0:6333:6333"]\n${key}${hardened}`), /binds 0\.0\.0\.0, not loopback/],
  ["long syntax without host_ip", svc(`    ports:\n      - target: 6333\n        published: 6333\n${key}${hardened}`), /names no host IP/],
  ["no credential", svc(`    ports: ["127.0.0.1:6333:6333"]\n${hardened}`), /requires no credential/],
  ["an optional credential", svc(`    ports: ["127.0.0.1:6333:6333"]\n    environment:\n      API_KEY: \${STORE_API_KEY:-}\n${hardened}`), /requires no credential/],
  ["capabilities kept", svc(`    security_opt: ["no-new-privileges:true"]\n`), /missing cap_drop/],
  ["privilege escalation allowed", svc(`    cap_drop: [ALL]\n`), /missing security_opt no-new-privileges/],
  ["privileged", svc(`    privileged: true\n${hardened}`), /privileged/],
  ["host network", svc(`    network_mode: host\n${hardened}`), /network_mode: host/],
  ["engine socket", svc(`    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n${hardened}`), /container-engine socket/],
  ["override publishing everywhere", "services:\n  store:\n    ports: [\"8080:8080\"]\n", /names no host IP/],
  ["writable engagement", `services:\n  pi-agent:\n    image: x\n${hardened}    volumes:\n      - type: bind\n        source: /srv/eng\n        target: ${ENGAGEMENT_TARGET}\n`, /engagement mount must be read-only/],
  ["no engagement mount", `services:\n  pi-agent:\n    image: x\n${hardened}`, /engagement directory at \/workspace\/engagement exactly once/],
  ["engagement inside the data root", `services:\n  pi-agent:\n    image: x\n${hardened}    volumes:\n      - type: bind\n        source: \${DATA:-/srv/data}\n        target: /srv/data\n      - type: bind\n        source: /srv/data/engagement\n        target: ${ENGAGEMENT_TARGET}\n        read_only: true\n`, /inside a writable data mount/],
];
for (const [label, text, expected] of cases) {
  assert.match(composePolicyProblems(label, text).join("\n"), expected, `fixture "${label}" fails`);
}
assert.deepEqual(composePolicyProblems("good", svc(`    ports: ["127.0.0.1:\${PORT:-6333}:6333", "[::1]:6334:6334"]\n${key}${hardened}`)), [], "a loopback, credentialed, hardened service passes");

console.log(`[compose-policy-smoke] OK (${composeFiles.length} compose files meet the policy; ${cases.length} fixtures each fail their rule)`);
