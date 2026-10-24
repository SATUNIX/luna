// The version references a release moves: the README's version badge (a static shields.io
// badge) with its alt text, and the install pins (`git:github.com/SATUNIX/pi-system@vX.Y.Z`) in
// the README, AGENTS.md and docs/. release.ts rewrites them with the version bump, and the docs
// smoke test fails if any of them disagrees with package.json.
import fs from "node:fs";
import path from "node:path";

const BADGE = /(https:\/\/img\.shields\.io\/badge\/version-)((?:[^-_?)\s]|--|__)+)(-[0-9A-Za-z]+)/;
const BADGE_ALT = /(<img src="https:\/\/img\.shields\.io\/badge\/version-[^"]*" alt="version )([^"]*)(")/;
const INSTALL_PIN = /(git:github\.com\/SATUNIX\/pi-system@v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/g;

// shields.io static badges use `-` as the field separator: a literal `-` is `--`, `_` is `__`.
const escapeField = (text: string): string => text.replace(/-/g, "--").replace(/_/g, "__");
const unescapeField = (text: string): string => text.replace(/--/g, "-").replace(/__/g, "_");

/** The version the README's badge shows, or null when it has none. */
export function readmeBadgeVersion(readme: string): string | null {
  const match = BADGE.exec(readme);
  const version = match?.[2];
  return version === undefined ? null : unescapeField(version);
}

/** The version the badge's alt text names, or null when it has none. */
export function readmeBadgeAltVersion(readme: string): string | null {
  return BADGE_ALT.exec(readme)?.[2] ?? null;
}

/** The README with its version badge and the badge's alt text set to `version`; unchanged when it has no badge. */
export function setReadmeBadgeVersion(readme: string, version: string): string {
  return readme
    .replace(BADGE, (_all: string, prefix: string, _old: string, color: string) => `${prefix}${escapeField(version)}${color}`)
    .replace(BADGE_ALT, (_all: string, prefix: string, _old: string, close: string) => `${prefix}${version}${close}`);
}

/** Every release version an install pin in `text` names, in order. */
export function installPinVersions(text: string): string[] {
  return [...text.matchAll(INSTALL_PIN)].map((match) => match[2] ?? "");
}

/** `text` with every install pin moved to `version`. */
export function setInstallPins(text: string, version: string): string {
  return text.replace(INSTALL_PIN, (_all: string, prefix: string) => `${prefix}${version}`);
}

/** The public pages whose install pins name the current release: README.md, AGENTS.md and every page under docs/. */
export function installPinFiles(root: string): string[] {
  const pages = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return pages(file);
      return entry.isFile() && entry.name.endsWith(".md") ? [file] : [];
    });
  return [path.join(root, "README.md"), path.join(root, "AGENTS.md"), ...pages(path.join(root, "docs")).sort()];
}
