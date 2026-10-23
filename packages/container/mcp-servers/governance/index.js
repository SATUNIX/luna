// Kept so MCP configs written before the TypeScript move (args ending in index.js) still start
// the server; the server itself is index.ts, run by Node's type stripping (Node >= 22.18).
await import("./index.ts");
