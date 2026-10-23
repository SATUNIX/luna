// Checked access to what the eval loads at runtime: extension modules compiled on the fly and the
// handlers, tools and commands they register on a fake pi. Their shapes are not known statically,
// so each value stays unknown and every call checks that it really has a function to call.
import { isRecord } from "../lib/guard.ts";

/** `value[key]` for an object, otherwise undefined (as `value?.[key]` gives for a primitive). */
export const prop = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** `value?.[k1]?.[k2]...` through plain objects. */
export function dig(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) current = prop(current, key);
  return current;
}

/** Calls `fn(...args)`; `what` names it in the error when it is not a function. */
export function call(fn: unknown, what: string, ...args: readonly unknown[]): unknown {
  if (typeof fn !== "function") throw new TypeError(`${what} is not a function`);
  return Reflect.apply(fn, undefined, args);
}

/** Calls `target[name](...args)` with `target` as `this`. */
export function callMethod(target: unknown, name: string, ...args: readonly unknown[]): unknown {
  const fn = prop(target, name);
  if (typeof fn !== "function") throw new TypeError(`${name} is not a function`);
  return Reflect.apply(fn, target, args);
}

/** The text of a tool result's first content block (`result.content[0].text`), or "". */
export function firstText(result: unknown): string {
  const content = prop(result, "content");
  const text = Array.isArray(content) ? prop(content[0], "text") : undefined;
  return typeof text === "string" ? text : "";
}
