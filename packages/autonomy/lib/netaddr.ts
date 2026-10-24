// Host-name and address handling for the egress allowlist (lib/egress-proxy.ts) and for the
// contract's `permissions.network.egress` entries. Everything here is deliberately strict: a
// name that cannot be normalised is refused rather than guessed at, and an address is public
// only when it is in a range known to be globally routable.
import net from "node:net";

/** The IPv4 address classes classifyV4 can name. */
export type V4Class = "unspecified" | "private" | "carrier-grade-nat" | "loopback" | "metadata" | "link-local" | "reserved" | "documentation" | "benchmark" | "multicast" | "public";

/** Every class classifyAddress can return; only "public" is ever reachable as an egress destination. */
export type AddressClass =
  | V4Class
  | `ipv4-mapped-${Exclude<V4Class, "public">}` | "ipv4-mapped-public"
  | "ipv4-compatible" | "nat64" | "6to4" | "teredo" | "unique-local" | "site-local" | "invalid";

/**
 * A canonical host name: lower case, one trailing dot removed, IPv6 brackets removed. Returns
 * null for anything that is not a plain host: user info, ports, paths, wildcards, whitespace,
 * percent-encoding, IPv6 zone ids, non-ASCII.
 */
export function normaliseHost(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let host = input.trim();
  if (!host || host !== input) return null; // whitespace around the name is a red flag, not something to fix
  if (host.length > 260) return null;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  else if (host.includes(":")) return null; // a port, or an unbracketed IPv6 literal
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
  if (/[\s\0-\x1f\x7f-￿@/\\*%?#,;'"<>|^`{}]/.test(host)) return null;
  host = host.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.endsWith(".") || host.startsWith(".") || host.includes("..")) return null;
  return host;
}

/** inet_aton-style IPv4 forms (127.1, 0x7f.0.0.1, 2130706433, 0177.0.0.1) as a canonical dotted quad, else null. */
export function parseLegacyIPv4(host: unknown): string | null {
  if (typeof host !== "string" || !host) return null;
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? NaN : Number.parseInt(p, 16);
    else if (/^0[0-7]*$/.test(p)) n = Number.parseInt(p, 8) || 0;
    else if (/^[1-9][0-9]*$/.test(p)) n = Number.parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  const last = nums.pop();
  if (last === undefined) return null; // unreachable: split() always yields at least one part
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  let value = last;
  nums.forEach((n, i) => { value += n * 256 ** (3 - i); });
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

/** True for anything a resolver could read as an IP address: canonical IPv4/IPv6 or a legacy numeric IPv4 form. */
export function isIpLiteral(host: unknown): boolean {
  if (typeof host !== "string") return false;
  return net.isIP(host) !== 0 || parseLegacyIPv4(host) !== null;
}

/** The canonical text of an IP-literal host (IPv6 lower-cased, legacy IPv4 expanded), or null. */
export function canonicalIp(host: string): string | null {
  if (net.isIPv4(host)) return host;
  if (net.isIPv6(host)) return host.toLowerCase();
  return parseLegacyIPv4(host);
}

/** Eight 16-bit groups of an IPv6 address, or null. Handles `::` and an embedded dotted IPv4 tail. */
export function ipv6Groups(ip: string): number[] | null {
  if (!net.isIPv6(ip) || ip.includes("%")) return null;
  let text = ip.toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  const quad = tail?.[1];
  if (quad) {
    const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = quad.split(".").map(Number);
    text = `${text.slice(0, -quad.length)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest === undefined ? [] : rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0 || (rest === undefined && left.length !== 8)) return null;
  const groups = [...left, ...new Array<string>(fill).fill("0"), ...right].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4 = (ip: string): number[] => ip.split(".").map(Number);
const inV4 = (b: readonly number[], base: string, bits: number): boolean => {
  const [a0 = 0, a1 = 0, a2 = 0, a3 = 0] = b;
  const value = ((a0 << 24) | (a1 << 16) | (a2 << 8) | a3) >>> 0;
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = v4(base);
  const baseValue = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
};

const V4_CLASSES: readonly (readonly [base: string, bits: number, name: Exclude<V4Class, "public">])[] = [
  ["0.0.0.0", 8, "unspecified"], ["10.0.0.0", 8, "private"], ["100.64.0.0", 10, "carrier-grade-nat"], ["127.0.0.0", 8, "loopback"],
  ["169.254.169.254", 32, "metadata"], ["169.254.170.2", 32, "metadata"], ["169.254.0.0", 16, "link-local"], ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"], ["192.0.2.0", 24, "documentation"], ["192.88.99.0", 24, "reserved"], ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmark"], ["198.51.100.0", 24, "documentation"], ["203.0.113.0", 24, "documentation"], ["224.0.0.0", 4, "multicast"], ["240.0.0.0", 4, "reserved"],
];

function classifyV4(ip: string): V4Class {
  const b = v4(ip);
  for (const [base, bits, name] of V4_CLASSES) if (inV4(b, base, bits)) return name;
  return "public";
}

/**
 * "public" for a globally routable unicast address, otherwise the name of the class it belongs to
 * (loopback, private, link-local, metadata, multicast, unique-local, ipv4-mapped-loopback, ...).
 * Unknown text is "invalid".
 */
export function classifyAddress(input: unknown): AddressClass {
  const ip = typeof input === "string" ? canonicalIp(input.startsWith("[") ? input.slice(1, -1) : input) : null;
  if (!ip) return "invalid";
  if (net.isIPv4(ip)) return classifyV4(ip);
  const g = ipv6Groups(ip);
  if (!g) return "invalid";
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return "loopback";
  if (g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff) { const c = classifyV4(embedded(g6, g7)); return c === "public" ? "ipv4-mapped-public" : `ipv4-mapped-${c}`; }
  if (g.slice(0, 6).every((x) => x === 0)) return "ipv4-compatible"; // ::a.b.c.d, deprecated
  if (g0 === 0x64 && g1 === 0xff9b) return "nat64";
  if (g0 === 0x2002) return "6to4";
  if (g0 === 0x2001 && g1 === 0) return "teredo";
  if (g0 === 0x2001 && g1 === 0xdb8) return "documentation";
  if ((g0 & 0xfe00) === 0xfc00) return "unique-local";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  if ((g0 & 0xffc0) === 0xfec0) return "site-local";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  if ((g0 & 0xe000) === 0x2000) return "public"; // 2000::/3 global unicast
  return "reserved";
}

/** A public IP-literal host (any accepted spelling), for contract validation. */
export function isPublicIpLiteral(host: unknown): boolean {
  return isIpLiteral(host) && classifyAddress(host) === "public";
}

/** May a run service (private, unique-local) live at this class? Never loopback, link-local, metadata or multicast. */
export const SERVICE_OK_CLASSES: ReadonlySet<AddressClass> = new Set<AddressClass>(["private", "unique-local"]);
