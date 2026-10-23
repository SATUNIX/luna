// Generated from packages/web-ui/src/public/js/guards.ts by `npm run build:web` (internal/docs/adr/0002).
// Edit the TypeScript source, not this file.
// guards.ts — tiny narrowing helpers shared by the browser modules: for JSON from the network,
// caught errors and DOM lookups.
//
// Everything the console reads from the server (fetch answers, SSE frames) is unknown until
// read. api.ts and sse.ts check its structure with `isRecord`/`isArrayOf`; the DOM renderers
// (render, panels, activity) narrow it field by field without changing what the old JavaScript
// showed. app.ts and agentui.ts look their elements up with `byId`.
/** A plain JSON object (not null, not an array). */
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** An array whose every item passes `test`. */
export function isArrayOf(value, test) {
    return Array.isArray(value) && value.every(test);
}
/**
 * A non-null object (arrays included), whose fields are unknown until each is narrowed: the
 * renderers' old `value && typeof value === "object"` test.
 */
export function isObject(value) {
    return typeof value === "object" && value !== null;
}
/** The value as a record, or an empty one: the old `value || {}` for a field read off it. */
export function asRecord(value) {
    return isObject(value) ? value : {};
}
/**
 * String(value) for JSON data, spelt out so that no object's own toString runs: primitives as
 * String() gives them, arrays joined with commas as Array#toString does, other objects tagged.
 */
export function toText(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint" ||
        value === undefined ||
        value === null) {
        return String(value);
    }
    if (isArray(value)) {
        return value.map((item) => (item === null || item === undefined ? "" : toText(item))).join(",");
    }
    return Object.prototype.toString.call(value);
}
/** What `textContent = value` shows: nothing for null/undefined, the string form otherwise. */
export function displayText(value) {
    return value === null || value === undefined ? "" : toText(value);
}
/** Array.isArray without the `any[]` it narrows to. */
export function isArray(value) {
    return Array.isArray(value);
}
/**
 * The element with this id, checked to be of the expected type. A missing or wrong-typed
 * element is a broken page (index.html and the scripts ship together), so it throws.
 */
export function byId(id, type) {
    const node = document.getElementById(id);
    if (!(node instanceof type))
        throw new Error(`#${id} is missing or is not a ${type.name}`);
    return node;
}
/**
 * The old `err.message` of a caught value, as text: an Error's message, an object's `message`
 * field, and nothing for anything else (what `textContent = undefined` showed).
 */
export function errorMessage(err) {
    if (err instanceof Error)
        return err.message;
    return isObject(err) ? displayText(err.message) : "";
}
