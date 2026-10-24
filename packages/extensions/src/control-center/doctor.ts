/**
 * The Doctor page: read-only checks over the install marker, the running pi against the kit's pin
 * and floor, the companions the marker records against pi's settings.json, and what the process
 * registries report. Every line names the command that gives more detail. It is pure data in, lines
 * out, so the drift cases are tested from fixtures in a temporary agent directory.
 *
 * Self-containment rule: import only node:* builtins and sibling modules.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { settingsSources, type KitMarkerView } from "./values.ts";

export interface DoctorInput {
  marker: KitMarkerView;
  /** The running pi version (`VERSION`). */
  piVersion: string;
  /** The kit's own version, from the checkout's root package.json. */
  kitVersion?: string | undefined;
  /** The pi version the kit pins in devDependencies. */
  kitTestedPin?: string | undefined;
  /** The peer range floor (e.g. ">=0.85.1"). */
  kitFloor?: string | undefined;
  /** The pi settings.json holding the registered packages. */
  settingsFile: string;
  registries: {
    effort?: string | undefined;
    protections: number;
    delegation?: string | undefined;
    compaction?: string | undefined;
    unattended?: string | undefined;
    subagents?: string | undefined;
    security?: string | undefined;
  };
}

/** One Doctor line. `command` is the typed command that gives more detail. */
export interface DoctorLine {
  label: string;
  value: string;
  command: string;
  ok: boolean;
}

/** The kit root from a module URL inside `packages/extensions/src/<name>/`. */
export function kitRootFromModuleUrl(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..", "..", "..");
}

export interface KitManifest {
  version?: string | undefined;
  testedPin?: string | undefined;
  floor?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A JSON object read from a file, or undefined when the file is missing or not an object. */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The kit's version, tested pi pin and peer floor, from its root package.json. */
export function readKitManifest(kitRoot: string): KitManifest {
  const pkg = readJsonObject(path.join(kitRoot, "package.json")) ?? {};
  const dev = isRecord(pkg.devDependencies) ? pkg.devDependencies : {};
  const peer = isRecord(pkg.peerDependencies) ? pkg.peerDependencies : {};
  return {
    version: typeof pkg.version === "string" ? pkg.version : undefined,
    testedPin: typeof dev["@earendil-works/pi-coding-agent"] === "string" ? dev["@earendil-works/pi-coding-agent"] : undefined,
    floor: typeof peer["@earendil-works/pi-coding-agent"] === "string" ? peer["@earendil-works/pi-coding-agent"] : undefined,
  };
}

/** A three-number version, ignoring any prerelease suffix. */
function versionParts(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.replace(/^[^0-9]*/, ""));
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The package name of a source, without its npm:/git: prefix or pinned version. */
export function sourcePackageName(source: string): string {
  const withoutPrefix = source.replace(/^(npm|git):/, "");
  const at = withoutPrefix.lastIndexOf("@");
  return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix;
}

/**
 * The Doctor's lines. `ok: false` marks a drift the doctor wants the operator to look at; it never
 * changes anything.
 */
export function doctorLines(input: DoctorInput): DoctorLine[] {
  const lines: DoctorLine[] = [];

  const profile = input.marker.profile ?? "unknown";
  const version = input.kitVersion ?? "unknown";
  const scope = input.marker.scope ?? "global";
  lines.push({ label: "Kit", value: `version ${version} · profile ${profile} · scope ${scope}`, command: "/update status", ok: true });

  const pin = input.kitTestedPin;
  const floor = input.kitFloor;
  const pinMatches = pin ? compareVersions(input.piVersion, pin) === 0 : true;
  const aboveFloor = floor ? compareVersions(input.piVersion, floor) >= 0 : true;
  lines.push({
    label: "pi",
    value: `${input.piVersion} (tested pin ${pin ?? "?"}${floor ? `, floor ${floor}` : ""})${pinMatches ? "" : " — differs from the tested pin"}${aboveFloor ? "" : " — BELOW the peer floor"}`,
    command: "/update status",
    ok: pinMatches && aboveFloor,
  });

  const registered = settingsSources(input.settingsFile);
  const missing = input.marker.companions.filter((source) => {
    const name = sourcePackageName(source);
    return ![...registered].some((entry) => sourcePackageName(entry) === name);
  });
  if (input.marker.companions.length === 0) {
    lines.push({ label: "Companions", value: "none recorded in the marker", command: "/update status", ok: true });
  } else if (registered.size === 0) {
    lines.push({ label: "Companions", value: `${input.marker.companions.length} recorded, but settings.json lists no packages`, command: "/update status", ok: false });
  } else if (missing.length) {
    lines.push({ label: "Companions", value: `marker lists not registered: ${missing.join(", ")}`, command: "/update status", ok: false });
  } else {
    lines.push({ label: "Companions", value: `${input.marker.companions.length} recorded and registered`, command: "/update status", ok: true });
  }

  const r = input.registries;
  if (r.effort) lines.push({ label: "Effort", value: r.effort, command: "/effort status", ok: true });
  lines.push({ label: "Protections", value: `${r.protections} recorded`, command: "/firewall status", ok: r.protections > 0 });
  if (r.delegation) lines.push({ label: "Delegation", value: r.delegation, command: "/orchestrate status", ok: true });
  if (r.compaction) lines.push({ label: "Compaction", value: r.compaction, command: "/compaction status", ok: true });
  if (r.unattended) lines.push({ label: "Unattended", value: r.unattended, command: "/auto explain", ok: true });
  if (r.subagents) lines.push({ label: "Subagents", value: r.subagents, command: "/subagents", ok: true });
  if (r.security) lines.push({ label: "Security", value: r.security, command: "/security status", ok: true });

  return lines;
}
