// Path globs for `permissions.writeAreas`. A deliberately small dialect: `**` matches any
// number of path segments (including none), `*` matches within one segment, `?` one character.
// Everything else is literal. Paths are repository-relative and use `/`.

const SPECIAL = /[.+^${}()|[\]\\]/g;

/** True when `text` holds a C0 control character (U+0000-U+001F), as /[\0-\x1f]/ would match. */
export const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) <= 0x1f) return true;
  return false;
};

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(SPECIAL, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Why a glob is not acceptable as a write area, or null. */
export function globProblem(glob: unknown): string | null {
  if (typeof glob !== "string" || !glob.trim()) return "must be a non-empty string";
  if (glob.length > 200) return "is longer than 200 characters";
  if (glob.startsWith("/") || /^[A-Za-z]:/.test(glob)) return "must be relative to the workspace";
  if (glob.includes("\\")) return "must use / as the separator";
  if (glob.split("/").includes("..")) return 'must not contain ".." segments';
  if (hasControlChar(glob)) return "must not contain control characters";
  if (glob === ".git" || glob.startsWith(".git/")) return "must not target .git";
  return null;
}

export const normaliseRepoPath = (p: unknown): string => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

/** Paths (repository-relative) that no glob in `areas` allows. */
export function pathsOutsideAreas(paths: readonly unknown[], areas: readonly string[]): string[] {
  const res = areas.map((area) => globToRegExp(area));
  return paths.map(normaliseRepoPath).filter((p) => !res.some((re) => re.test(p)));
}
