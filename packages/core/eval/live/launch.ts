// Writable, disposable Pi settings; policy and kit remain read-only mounts.
import fs from "node:fs";
import { spawn } from "node:child_process";
fs.mkdirSync("/tmp/pi-config", { recursive: true });
for (const name of ["models.json", "settings.json"]) fs.copyFileSync(`/config/${name}`, `/tmp/pi-config/${name}`);
const child = spawn("pi", process.argv.slice(2), { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: "/tmp/pi-config" } });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
