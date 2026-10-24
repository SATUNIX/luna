/**
 * Workflow-script `meta` — a literal-only parser.
 *
 * A workflow script starts with `export const meta = {...}`. The registry reads that object
 * without running anything: this file parses it as a pure literal (strings, numbers, booleans,
 * null, arrays and objects with plain keys, comments and trailing commas allowed). A variable,
 * call, spread, computed key, shorthand property, method, regex or `${}` interpolation is a parse
 * error, so a registry listing never evaluates script code.
 *
 * See docs/workflows.md ("Script workflows"); tests/workflow-meta-smoke.ts pins the grammar.
 */

export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

export interface ScriptPhase {
  title: string;
  detail?: string | undefined;
  model?: string | undefined;
}

export interface ScriptMeta {
  name: string;
  description: string;
  whenToUse?: string | undefined;
  phases: ScriptPhase[];
}

const MAX_DEPTH = 16;
const MAX_TEXT = 4096;
export const META_NAME = /^[a-z][a-z0-9_-]{0,40}$/;

class MetaError extends Error {}

/** Parses a JS object literal starting at `start`; returns the value and the index after it. */
class LiteralParser {
  private i: number;
  private readonly src: string;
  constructor(src: string, start: number) {
    this.src = src;
    this.i = start;
  }

  get pos(): number {
    return this.i;
  }

  private fail(what: string): never {
    const line = this.src.slice(0, this.i).split("\n").length;
    throw new MetaError(`${what} at line ${line}`);
  }

  /** Skips whitespace and comments. */
  skip(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) return;
      if (/\s/.test(c)) {
        this.i++;
      } else if (this.src.startsWith("//", this.i)) {
        const end = this.src.indexOf("\n", this.i);
        this.i = end === -1 ? this.src.length : end + 1;
      } else if (this.src.startsWith("/*", this.i)) {
        const end = this.src.indexOf("*/", this.i + 2);
        if (end === -1) this.fail("unterminated comment");
        this.i = end + 2;
      } else return;
    }
  }

  value(depth: number): Literal {
    if (depth > MAX_DEPTH) this.fail("meta nests too deeply");
    this.skip();
    const c = this.src[this.i];
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"' || c === "'") return this.quoted(c);
    if (c === "`") return this.template();
    if (c === "-" || c === "+" || c === "." || (c !== undefined && /\d/.test(c))) return this.number();
    const word = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i))?.[0];
    if (word === "true" || word === "false" || word === "null") {
      this.i += word.length;
      return word === "true" ? true : word === "false" ? false : null;
    }
    if (c === undefined) this.fail("unexpected end of meta");
    this.fail(word ? `"${word}" is not a literal (meta must be a pure literal: no variables or calls)` : `unexpected "${c}" (meta must be a pure literal)`);
  }

  private object(depth: number): { [key: string]: Literal } {
    this.i++; // {
    const out: { [key: string]: Literal } = {};
    const seen = new Set<string>();
    for (;;) {
      this.skip();
      if (this.src[this.i] === "}") {
        this.i++;
        return out;
      }
      if (this.src.startsWith("...", this.i)) this.fail("spread is not allowed in meta");
      const key = this.key();
      this.skip();
      if (this.src[this.i] !== ":") this.fail(`property "${key}" needs "key: value" (no shorthand or methods)`);
      this.i++;
      if (key === "__proto__" || key === "constructor" || key === "prototype") this.fail(`property name "${key}" is not allowed`);
      if (seen.has(key)) this.fail(`duplicate property "${key}"`);
      seen.add(key);
      Object.defineProperty(out, key, { value: this.value(depth + 1), enumerable: true, writable: true, configurable: true });
      this.skip();
      const sep = this.src[this.i];
      if (sep === ",") this.i++;
      else if (sep !== "}") this.fail('expected "," or "}"');
    }
  }

  private key(): string {
    const c = this.src[this.i];
    if (c === '"' || c === "'") return this.quoted(c);
    if (c === "[") this.fail("computed keys are not allowed in meta");
    const word = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i))?.[0];
    if (!word) this.fail("expected a property name");
    this.i += word.length;
    return word;
  }

  private array(depth: number): Literal[] {
    this.i++; // [
    const out: Literal[] = [];
    for (;;) {
      this.skip();
      const c = this.src[this.i];
      if (c === "]") {
        this.i++;
        return out;
      }
      if (c === ",") this.fail("array holes are not allowed in meta");
      if (this.src.startsWith("...", this.i)) this.fail("spread is not allowed in meta");
      out.push(this.value(depth + 1));
      this.skip();
      const sep = this.src[this.i];
      if (sep === ",") this.i++;
      else if (sep !== "]") this.fail('expected "," or "]"');
    }
  }

  private escape(): string {
    const c = this.src[this.i++];
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        if (/\d/.test(this.src[this.i] ?? "")) this.fail("octal escapes are not allowed");
        return "\0";
      case "x": {
        const hex = /^[0-9a-fA-F]{2}/.exec(this.src.slice(this.i))?.[0];
        if (!hex) this.fail("bad \\x escape");
        this.i += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case "u": {
        const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(this.src.slice(this.i));
        const plain = /^[0-9a-fA-F]{4}/.exec(this.src.slice(this.i))?.[0];
        if (braced?.[1] !== undefined) {
          const cp = parseInt(braced[1], 16);
          if (cp > 0x10ffff) this.fail("bad \\u escape");
          this.i += braced[0].length;
          return String.fromCodePoint(cp);
        }
        if (!plain) this.fail("bad \\u escape");
        this.i += 4;
        return String.fromCharCode(parseInt(plain, 16));
      }
      case "\r":
        if (this.src[this.i] === "\n") this.i++;
        return "";
      case "\n":
      case " ":
      case " ":
        return "";
      case undefined:
        return this.fail("unterminated string");
      default:
        if (/[1-9]/.test(c)) this.fail("octal escapes are not allowed");
        return c;
    }
  }

  private quoted(q: string): string {
    this.i++;
    let out = "";
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined || c === "\n" || c === "\r") this.fail("unterminated string");
      this.i++;
      if (c === q) return out;
      out += c === "\\" ? this.escape() : c;
      if (out.length > MAX_TEXT) this.fail(`a meta string is longer than ${MAX_TEXT} characters`);
    }
  }

  private template(): string {
    this.i++;
    let out = "";
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) this.fail("unterminated template string");
      this.i++;
      if (c === "`") return out;
      if (c === "$" && this.src[this.i] === "{") this.fail("template interpolation is not allowed in meta");
      if (c === "\\") out += this.escape();
      else if (c === "\r") {
        if (this.src[this.i] === "\n") this.i++;
        out += "\n";
      } else out += c;
      if (out.length > MAX_TEXT) this.fail(`a meta string is longer than ${MAX_TEXT} characters`);
    }
  }

  private number(): number {
    const m = /^[+-]?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)/.exec(this.src.slice(this.i));
    if (!m) this.fail("bad number");
    const text = m[0];
    if (/^[+-]?0\d/.test(text)) this.fail("legacy octal numbers are not allowed");
    this.i += text.length;
    if (/^[\w$]/.test(this.src[this.i] ?? "")) this.fail("bad number");
    const sign = text.startsWith("-") ? -1 : 1;
    const body = text.replace(/^[+-]/, "").replace(/_/g, "");
    const n = /^0[xXoObB]/.test(body) ? Number(body) : Number.parseFloat(body);
    if (!Number.isFinite(n)) this.fail("bad number");
    return sign * n;
  }
}

const isRecord = (v: Literal | undefined): v is { [key: string]: Literal } => typeof v === "object" && v !== null && !Array.isArray(v);

function text(obj: { [key: string]: Literal }, key: string, where: string, required: boolean): string | undefined {
  const v = Object.hasOwn(obj, key) ? obj[key] : undefined;
  if (v === undefined) {
    if (required) throw new MetaError(`${where}${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new MetaError(`${where}${key} must be a string`);
  if (required && !v.trim()) throw new MetaError(`${where}${key} must not be empty`);
  return v;
}

/** Checks the parsed literal: `name` and `description` are required; `whenToUse` and `phases` are optional. */
export function validateMeta(value: Literal): ScriptMeta {
  if (!isRecord(value)) throw new MetaError("meta must be an object");
  const name = text(value, "name", "meta.", true) ?? "";
  if (!META_NAME.test(name)) throw new MetaError(`meta.name "${name}" must match ${META_NAME}`);
  const description = text(value, "description", "meta.", true) ?? "";
  const whenToUse = text(value, "whenToUse", "meta.", false);
  const rawPhases = Object.hasOwn(value, "phases") ? value.phases : undefined;
  const phases: ScriptPhase[] = [];
  if (rawPhases !== undefined) {
    if (!Array.isArray(rawPhases)) throw new MetaError("meta.phases must be an array");
    rawPhases.forEach((p, i) => {
      if (!isRecord(p)) throw new MetaError(`meta.phases[${i}] must be an object`);
      const where = `meta.phases[${i}].`;
      phases.push({ title: text(p, "title", where, true) ?? "", detail: text(p, "detail", where, false), model: text(p, "model", where, false) });
    });
  }
  return { name, description, whenToUse, phases };
}

/**
 * Reads `export const meta = {...}` from the top of a workflow script. Only whitespace and
 * comments may come before it; the literal may end with `;`. Nothing in the script is run.
 */
export function parseScriptMeta(source: string): { meta: ScriptMeta; error?: undefined } | { meta?: undefined; error: string } {
  const src = source.replace(/^\uFEFF/, "");
  try {
    const lead = new LiteralParser(src, 0);
    lead.skip();
    const head = /^export\s+const\s+meta\s*=/.exec(src.slice(lead.pos));
    if (!head) throw new MetaError("a workflow script must begin with `export const meta = {...}`");
    const body = new LiteralParser(src, lead.pos + head[0].length);
    const value = body.value(0);
    // The literal must end the statement: `;`, the end of the file, or a line break before
    // something that cannot continue the expression (so `{...}\n(call)()` is refused).
    const end = body.pos;
    body.skip();
    const next = src.slice(body.pos);
    const ended = next === "" || next.startsWith(";") || (/[\n\r\u2028\u2029]/.test(src.slice(end, body.pos)) && !/^(?:[([.`+\-*/%&|^<>=?,]|in\b|instanceof\b)/.test(next));
    if (!ended) throw new MetaError("meta must end after its literal (use `;` or a new line)");
    return { meta: validateMeta(value) };
  } catch (error) {
    if (error instanceof MetaError) return { error: error.message };
    throw error;
  }
}
