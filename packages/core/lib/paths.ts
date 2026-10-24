/**
 * Canonical path resolution for the pi-system monorepo.
 *
 * Every core script derives package locations from this single module so the
 * layout can change in one place. All paths are absolute.
 *
 *   pi-system/
 *     packages/core/          runtime + CLI + schemas + policies   (this package)
 *     packages/extensions/    first-party (src/) + vendored (third_party/)
 *     packages/kit/           skills, prompts, profiles, themes, agents, workflows
 *     packages/web-ui/        console server + assets
 *     packages/container/     deployment wrapper + MCP servers
 *     docs/ tests/ examples/
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // packages/core/lib

export const CORE_DIR = path.resolve(HERE, ".."); // packages/core
export const WORKSPACE_ROOT = path.resolve(CORE_DIR, "..", "..");
export const PACKAGES_DIR = path.join(WORKSPACE_ROOT, "packages");

export const EXTENSIONS_DIR = path.join(PACKAGES_DIR, "extensions");
export const FIRST_PARTY_DIR = path.join(EXTENSIONS_DIR, "src");
export const THIRD_PARTY_DIR = path.join(EXTENSIONS_DIR, "third_party");

export const KIT_DIR = path.join(PACKAGES_DIR, "kit");
export const SKILLS_DIR = path.join(KIT_DIR, "skills");
export const PROMPTS_DIR = path.join(KIT_DIR, "prompts");
export const PROFILES_DIR = path.join(KIT_DIR, "profiles");
export const THEMES_DIR = path.join(KIT_DIR, "themes");
export const AGENTS_DIR = path.join(KIT_DIR, "agents");

export const WEB_UI_DIR = path.join(PACKAGES_DIR, "web-ui");
export const CONTAINER_DIR = path.join(PACKAGES_DIR, "container");

export const DOCS_DIR = path.join(WORKSPACE_ROOT, "docs");
export const TESTS_DIR = path.join(WORKSPACE_ROOT, "tests");
export const EXAMPLES_DIR = path.join(WORKSPACE_ROOT, "examples");

export const SOURCES_PATH = path.join(CORE_DIR, "sources.json");
export const SCHEMA_DIR = path.join(CORE_DIR, "schema");
export const POLICIES_DIR = path.join(CORE_DIR, "policies");
export const ENV_EXAMPLE = path.join(CORE_DIR, ".env.example");

/** pi package globs, relative to WORKSPACE_ROOT, for the root package.json. */
export const PI_EXTENSION_GLOBS: readonly string[] = [
  "packages/extensions/src/*/index.ts",
  "packages/extensions/third_party/*/index.ts",
  "!packages/extensions/src/_template/index.ts",
];

/** Where an extension's source lives: first-party (src/), vendored (third_party/) or a separate package. */
export type ExtensionAvenue = "first-party" | "third-party" | "external";

/** Path of an extension entry, relative to WORKSPACE_ROOT (used in settings). */
export function extensionRelPath(name: string, avenue: ExtensionAvenue): string {
  return avenue === "third-party"
    ? `packages/extensions/third_party/${name}/index.ts`
    : `packages/extensions/src/${name}/index.ts`;
}

/** Absolute path of an extension's directory for a given avenue. */
export function extensionDir(name: string, avenue: ExtensionAvenue): string {
  return avenue === "third-party"
    ? path.join(THIRD_PARTY_DIR, name)
    : path.join(FIRST_PARTY_DIR, name);
}