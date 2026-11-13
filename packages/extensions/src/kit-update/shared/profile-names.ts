// GENERATED from packages/core/shared/profile-names.ts by packages/core/gen-shared.ts. Do not edit this copy:
// change the source and run `npm run gen:shared` (`npm run verify` fails when a copy differs).
/**
 * Profiles that no longer exist under their old name, and the one-way migration of stored names.
 *
 * Luna does not accept an old profile name as an alias. A name typed by a person or a script
 * (`--profile`, `/profile`, `PI_KIT_PROFILE`) that is in this table fails with an actionable
 * message. Names the kit itself stored earlier (the install marker's `profile`) are migrated once
 * when read and rewritten the next time the marker is written, so an upgrade does not strand an
 * install on a profile that is gone.
 *
 * Canonical source: packages/core/shared/profile-names.ts. Extensions hold generated, byte-checked
 * copies (`npm run gen:shared`; `npm run verify` fails on drift). Dependency-free on purpose.
 */

/** Old profile name -> the profile that replaced it. The one place a rename is recorded. */
export const RENAMED_PROFILES: Readonly<Record<string, string>> = {
  quick: "lite",
  autonomous: "long-horizon",
  pentest: "engagement",
};

/** The profile that replaced `name`, or undefined when `name` was not renamed. */
export function renamedProfile(name: string): string | undefined {
  // Own keys only: "constructor" or "__proto__" must not resolve to Object.prototype members.
  return Object.hasOwn(RENAMED_PROFILES, name) ? RENAMED_PROFILES[name] : undefined;
}

/** A stored profile name carried forward: the replacement when `name` was renamed, else `name`. */
export function migrateStoredProfile(name: string): string {
  return renamedProfile(name) ?? name;
}

/** The error text for a typed profile name that was renamed, or undefined when it was not. */
export function renamedProfileMessage(name: string): string | undefined {
  const to = renamedProfile(name);
  return to === undefined ? undefined : `profile "${name}" was renamed to "${to}"; use "${to}" instead`;
}

/** The firewall policies. The one list: every reader and writer validates against it. */
export const FIREWALL_POLICIES = ["coding", "engagement"] as const;
export type FirewallPolicy = (typeof FIREWALL_POLICIES)[number];

/** Old firewall policy name -> the policy that replaced it. Stored values only; never accepted as typed. */
export const RENAMED_POLICIES: Readonly<Record<string, string>> = { pentest: "engagement" };

export function isFirewallPolicy(value: unknown): value is FirewallPolicy {
  return FIREWALL_POLICIES.some((p) => p === value);
}

/**
 * A stored policy value carried forward (a one-way migration, rewritten on the next write): the
 * replacement when the name was renamed, else the value unchanged. Validate the result with
 * isFirewallPolicy; an unknown value must never select the weaker policy.
 */
export function migrateStoredPolicy(value: unknown): unknown {
  return typeof value === "string" && Object.hasOwn(RENAMED_POLICIES, value) ? RENAMED_POLICIES[value] : value;
}

/**
 * Extensions that no longer exist under their old name. Names the kit stored earlier (the marker's
 * `extensions`, overrides.json add/remove) are read as the replacement. settings.json filters hold
 * paths pi resolves itself, so a stale one cannot be migrated on read: session-helpers warns, and the
 * next install, `/profile` switch or `/update` rewrites it.
 */
export const RENAMED_EXTENSIONS: Readonly<Record<string, string>> = { "pentest-governance-domain": "engagement-governance" };

/** A stored extension name carried forward: the replacement when it was renamed, else `name`. */
export function migrateStoredExtension(name: string): string {
  return Object.hasOwn(RENAMED_EXTENSIONS, name) ? (RENAMED_EXTENSIONS[name] ?? name) : name;
}
