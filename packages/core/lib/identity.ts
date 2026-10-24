/** Package identities accepted during source changes; defaults retain the shipped identity. */
export const KIT_PACKAGE_NAME = "@satunix/pi-system";

// Accepted identities stay independent of whichever name is the delivery default.
const KIT_PACKAGE_NAMES = new Set(["@satunix/pi-system", "@satunix/luna"]);

export function isKitPackageName(name: unknown): boolean {
  return typeof name === "string" && KIT_PACKAGE_NAMES.has(name);
}

/** Bare pi-system is a legacy checkout name; bare luna belongs to another package. */
export function isKitLocalPackageName(name: unknown): boolean {
  return isKitPackageName(name) || name === "pi-system";
}

/** A normalised host/path key. Luna forks require explicit previous-source metadata. */
export function isKitGitKey(key: string): boolean {
  return /\/pi-system$/.test(key) || key === "github.com/satunix/luna";
}
