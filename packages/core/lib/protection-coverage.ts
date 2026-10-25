/**
 * Mandatory-protection coverage for shipped profiles.
 *
 * `MANDATORY_PROTECTION_EXTENSIONS` names the extensions whose absence widens what the agent may
 * do. A shipped profile must load every one of them, or this file must record, with a reason, why
 * that profile goes without one. An exemption is a reviewed code change here, never a silent
 * omission in a profile's `include` list: `packages/core/profile-check.ts` runs this rule for every
 * shipped profile, and `tests/profile-protections-smoke.ts` pins it (a profile that drops a
 * protection with no recorded exemption fails).
 */
import { MANDATORY_PROTECTION_EXTENSIONS } from "./profiles.ts";

/** Why a profile is allowed to go without one mandatory protection. */
export type ProtectionExemptions = Readonly<Record<string, Readonly<Record<string, string>>>>;

const SECRET_GUARD_OPT_IN =
  "secret-guard blocks every write to a path containing 'secret' or 'credentials', which breaks ordinary work in this profile; " +
  "the tool firewall's classifier still treats credential-file reads as credential reads. Enable it with extensions.add in overrides.json.";

/** The recorded exemptions: profile name -> extension name -> reason. */
export const PROTECTION_EXEMPTIONS: ProtectionExemptions = {
  quick: { "secret-guard": SECRET_GUARD_OPT_IN },
  lite: { "secret-guard": SECRET_GUARD_OPT_IN },
  "long-horizon": { "secret-guard": `${SECRET_GUARD_OPT_IN} The autonomy image bakes this profile and runs it on repositories whose own paths contain those words.` },
  "self-improving": { "secret-guard": `${SECRET_GUARD_OPT_IN} Self-improvement cycles edit the kit itself, including secret-guard's own source.` },
  pentest: { "secret-guard": `${SECRET_GUARD_OPT_IN} pentest-governance-domain enforces the same protected-path list (parity checked by packages/core/verify.ts).` },
};

/**
 * Problems with one profile's coverage of the mandatory protections: a protection that is neither
 * included nor exempted, an exemption with no reason, an exemption for a protection the profile
 * already loads (stale), or an exemption naming something that is not a mandatory protection.
 */
export function protectionCoverageProblems(
  profile: string,
  includes: readonly string[],
  exemptions: ProtectionExemptions = PROTECTION_EXEMPTIONS,
  mandatory: readonly string[] = MANDATORY_PROTECTION_EXTENSIONS,
): string[] {
  const problems: string[] = [];
  const own = Object.hasOwn(exemptions, profile) ? exemptions[profile] : undefined;
  const exempt = own ?? {};
  for (const name of mandatory) {
    const reason = Object.hasOwn(exempt, name) ? exempt[name] : undefined;
    if (includes.includes(name)) {
      if (reason !== undefined) problems.push(`'${name}' is included but still carries an exemption; remove the stale exemption`);
      continue;
    }
    if (reason === undefined) problems.push(`mandatory protection '${name}' is missing and has no recorded exemption (packages/core/lib/protection-coverage.ts)`);
    else if (reason.trim().length === 0) problems.push(`the exemption for '${name}' has no reason`);
  }
  for (const name of Object.keys(exempt)) {
    if (!mandatory.includes(name)) problems.push(`exemption for '${name}', which is not a mandatory protection`);
  }
  return problems;
}
