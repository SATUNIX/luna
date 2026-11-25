// profiles.ts — read-only view of the kit's profiles and the pi packages this install registers.
//
// Powers the console's Profiles & packages pages: which shipped and user profiles exist, and
// which pi packages pi's settings.json lists. Nothing here writes: profile switching and package
// add/remove stay operator commands (`/profile`, `/packages`), so the console cannot change the
// agent's configuration. The mobile app and the browser read the same JSON.
import * as fs from "node:fs";
import * as path from "node:path";
import { array, object, string, unknownValue } from "../../core/lib/guard.ts";
import { KIT_ROOT, PI_HOME, SETTINGS_FILE } from "./config.ts";
import { lenient, readJsonFile } from "./json.ts";

/** The shipped profile definitions, read in place (packages/kit/profiles/<name>.json). */
const SHIPPED_PROFILES_DIR = path.join(KIT_ROOT, "profiles");
/** The operator's own profiles, beside the kit's configuration (shared/user-profile.ts). */
const USER_PROFILES_DIR = path.join(PI_HOME, "pi-kit", "profiles");

/** One profile as the view lists it. */
export interface ProfileSummary {
	name: string;
	description: string;
	/** "shipped" is one of the kit's profile files, "user" the operator's own (a base + overrides). */
	source: "shipped" | "user";
	/** For a user profile: the shipped profile it extends. */
	base?: string;
	/** How many extensions the profile adds: a shipped profile's `include`, a user profile's `extensions.add`. */
	extensions: number;
}

/** One registered pi package as the view lists it (pi's settings.json `packages` entry). */
export interface PackageSummary {
	source: string;
	extensions: number;
	skills: number;
	prompts: number;
}

export interface ProfilesResponse { readonly profiles: ProfileSummary[] }
export interface PackagesResponse { readonly packages: PackageSummary[] }

// The kit owns these files, but another program writes settings.json: only the fields read are
// checked, and a field of the wrong type is treated as absent rather than failing the whole read.
const ShippedProfileSchema = object({
	name: lenient(string()),
	description: lenient(string()),
	include: lenient(array(string())),
});
const UserProfileSchema = object({
	name: lenient(string()),
	description: lenient(string()),
	extends: lenient(string()),
	extensions: lenient(object({ add: lenient(array(string())) })),
});
const PackageEntrySchema = object({
	source: lenient(string()),
	extensions: lenient(array(string())),
	skills: lenient(array(string())),
	prompts: lenient(array(string())),
});
const SettingsSchema = object({ packages: lenient(array(unknownValue())) });

/** The profile files in `dir`, sorted; an unreadable directory is empty. */
function jsonFiles(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return [];
	}
}


/** Every shipped profile, then the operator's own (as `/profile` and the installer list them). */
export function listProfiles(): ProfileSummary[] {
	const shipped: ProfileSummary[] = [];
	const shippedNames = new Set<string>();
	for (const file of jsonFiles(SHIPPED_PROFILES_DIR)) {
		const name = file.slice(0, -".json".length);
		const def = lenient(ShippedProfileSchema).parse(readJsonFile(path.join(SHIPPED_PROFILES_DIR, file))) ?? {};
		shippedNames.add(name);
		shipped.push({
			name: def.name || name,
			description: def.description || "",
			source: "shipped",
			extensions: def.include?.length ?? 0,
		});
	}
	const user: ProfileSummary[] = [];
	for (const file of jsonFiles(USER_PROFILES_DIR)) {
		const name = file.slice(0, -".json".length);
		// A user profile may not take a shipped name; that file is not one the installer would load.
		if (shippedNames.has(name)) continue;
		const def = lenient(UserProfileSchema).parse(readJsonFile(path.join(USER_PROFILES_DIR, file))) ?? {};
		user.push({
			name: def.name || name,
			description: def.description || "",
			source: "user",
			...(def.extends ? { base: def.extends } : {}),
			extensions: def.extensions?.add?.length ?? 0,
		});
	}
	return [...shipped, ...user];
}

/** The pi packages pi's settings.json registers, as the console shows them; never a write. */
export function listPackages(): PackageSummary[] {
	const settings = lenient(SettingsSchema).parse(readJsonFile(SETTINGS_FILE)) ?? {};
	const packages: PackageSummary[] = [];
	for (const entry of settings.packages ?? []) {
		if (typeof entry === "string") {
			packages.push({ source: entry, extensions: 0, skills: 0, prompts: 0 });
			continue;
		}
		const parsed = lenient(PackageEntrySchema).parse(entry);
		if (!parsed?.source) continue;
		packages.push({
			source: parsed.source,
			extensions: parsed.extensions?.length ?? 0,
			skills: parsed.skills?.length ?? 0,
			prompts: parsed.prompts?.length ?? 0,
		});
	}
	return packages;
}
