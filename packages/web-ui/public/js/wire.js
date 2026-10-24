// Generated from packages/web-ui/src/public/js/wire.ts by `npm run build:web` (internal/docs/adr/0002).
// Edit the TypeScript source, not this file.
// wire.ts — the JSON the console API returns and accepts, as the browser relies on it.
//
// Types only: this module has no runtime code and its compiled wire.js is an empty module. The
// shapes are written out here rather than imported because browser code cannot reach the server
// sources at run time; server/wire-contract.ts proves at compile time that the server's real types
// are assignable to these (internal/docs/adr/0002, decision 4), so the two cannot drift.
//
// Each type lists only what the client reads. A field the server may omit, or that the client
// reads defensively without depending on it, is optional. api.ts and sse.ts narrow the parsed
// JSON (`unknown`) to these types with cheap structural checks before anything reads it.
export {};
