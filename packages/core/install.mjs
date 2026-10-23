// Compatibility entry point. The installer is install.ts (internal/docs/adr/0001); kit versions
// from before the TypeScript migration run this path right after pulling an update, so keep it
// until no supported kit version names it. The npm artefact compiles install.ts to install.js.
import fs from "node:fs";

const source = new URL("./install.ts", import.meta.url);
await import(fs.existsSync(source) ? source.href : new URL("./install.js", import.meta.url).href);
