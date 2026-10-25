// A conservative shell parser for the tool firewall.
//
// It turns a command string into the simple commands that would actually run ("segments"),
// looking through wrappers (`bash -c '…'`, `ssh host '…'`, `sudo`, `env`, `timeout`, `xargs`,
// `find -exec`, `eval`, `$( … )`, heredocs fed to a shell) so a classifier sees the real
// executable, its arguments, where it runs (locally, remotely, privileged) and in which
// directory. It is not a full shell: anything it cannot follow is reported in `opaque`, and
// callers treat opaque input as needing a closer look rather than as safe.
//
// Coverage contract (docs/autonomy-gate.md, "Parser coverage"): every construct that makes bash run
// a command is either modelled here, so the command appears as a segment, or reported in `opaque`.
// Modelled: command substitution anywhere in a word (inside `$(( ))`, `(( ))`, the word operand of a
// quoted or unquoted parameter expansion such as `${x:-…}`, and a `case` pattern), brace expansion of
// command words, function bodies (`f() {…}`, `function f {…}`, `coproc NAME {…}`), the builtins that
// take a command string (`trap`, `alias`, `complete -C`, `mapfile -C`, `bind -x`, `eval`), hook
// variables (`PS0`-`PS4`, `PROMPT_COMMAND`, `BASH_FUNC_*`) set as a prefix, through `export`/`declare`
// or as an `env NAME=value` operand, and the builtins that change what a later command name runs: a
// name an `alias` or `hash -p` redefined earlier in the same command is replaced by the alias value or
// hashed path where it is used. The environment a wrapper hands to the shell it starts (`env X=v bash
// -c …`) stays on the inner commands. Reported as opaque: command text in an array subscript that bash
// would evaluate arithmetically, history re-execution (`fc -s`, `fc -e`), an alias whose value is not a
// simple command, `enable -f`, and wrappers whose options this file does not know.
// tests/firewall-exec-oracle-smoke.ts runs a corpus through real bash and fails when an executed command
// is neither a segment nor reported as opaque.
//
// Not modelled (see docs/autonomy-gate.md): an alias or `hash` set outside the command (a profile, a
// sourced file), an alias value ending in a space (which makes bash alias-expand the next word too),
// positional parameters inside a function body (the call's arguments are not bound to `$1`…; classify.ts
// checks them as reads and writes instead), and values that only exist at run time.

export type Word = {
  text: string; // value after quote removal; `$VAR`, `${…}` and substitutions are kept verbatim
  raw: string; // source text
  dynamic: boolean; // contains an unquoted/double-quoted expansion or substitution
  quoted: boolean;
  ansiC: boolean; // used $'…' quoting
  fragmented: boolean; // quotes or backslashes inside the word (r''m, r\m)
  subs: string[]; // $( … ), ` … `, <( … ) bodies
  procSub: boolean;
};

export type Redirect = { op: string; fd: string; target: string; dynamic: boolean; body?: string };

export type Segment = {
  argv: string[];
  words: Word[];
  redirects: Redirect[];
  assigns: string[]; // NAME=value prefixes
  stdinBody?: string | undefined; // heredoc / here-string fed to the command
  pipeIn: boolean;
  pipeOut: boolean;
  prev?: Segment | undefined; // previous command in the same pipeline
  next?: Segment | undefined;
  background: boolean;
  cwd: string | null; // effective directory, null when unknown
  remote?: string | undefined; // host when the command runs over ssh
  sudo?: { nonInteractive: boolean; user?: string | undefined } | undefined;
  via: string[]; // wrappers it was found inside, outermost first
  depth: number;
  unknownArgs: boolean; // xargs / find -exec append arguments we cannot see
  filtered: boolean; // find -exec with a name/type filter (targets are a subset of the root)
  obfuscatedName: boolean; // command name built from fragments or $'…'
  dynamicName: boolean; // command name comes from a variable or substitution
  decoderInName: boolean; // …and that substitution decodes data (base64 -d, xxd -r, …)
  interactiveShell?: boolean; // sudo -i/-s, bare ssh host, bash with no script
  ssh?: { host: string; forwards: boolean; proxyCommand: boolean };
  evalOf?: boolean;
  fnCall?: boolean; // the command name is a shell function defined earlier in the same script
  vars: Record<string, string>; // plain NAME=value assignments seen earlier in the script
};

export type Parsed = { segments: Segment[]; opaque: string[] };

export type ParseEnv = {
  cwd: string | null;
  home: string;
  remote?: string | undefined;
  sudo?: Segment["sudo"];
  via?: string[];
  depth?: number;
  vars?: Record<string, string>;
  fns?: Set<string>; // shell functions defined so far (shared by every nested parse of one command)
  // Command names an `alias` or `hash -p` earlier in the same command redefines, and the words bash runs instead
  // (null: the alias value is not a simple command). Shared like `fns`.
  aliases?: Map<string, Word[] | null>;
  assigns?: string[]; // environment a wrapper passed to the command it runs (`env NAME=v bash -c …`, `NAME=v bash -c …`)
};

const MAX_DEPTH = 6;

type Tok =
  | { k: "w"; w: Word }
  | { k: "op"; v: string }
  | { k: "redir"; op: string; fd: string; body?: string };

// ANSI-C $'…' escapes.
const ANSI_C_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
function decodeAnsiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g, (_m, e: string) => {
    const c = e.charAt(0);
    if (c === "x" || c === "u" || c === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/[0-7]/.test(c)) return String.fromCharCode(parseInt(e, 8));
    if (c === "c") return String.fromCharCode(e.charCodeAt(1) & 31);
    return ANSI_C_ESCAPES[c] ?? `\\${e}`;
  });
}

// Scan a balanced $( … ) / <( … ) body starting just after the opening paren.
function scanParen(src: string, i: number): { body: string; end: number } | null {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", j + 1); if (e < 0) return null; j = e + 1; continue; }
    if (c === '"') {
      j++;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return null;
      j++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return { body: src.slice(i, j), end: j + 1 }; }
    j++;
  }
  return null;
}

function scanBacktick(src: string, i: number): { body: string; end: number } | null {
  let j = i;
  let body = "";
  while (j < src.length) {
    if (src[j] === "\\" && j + 1 < src.length) { body += src.charAt(j + 1); j += 2; continue; }
    if (src[j] === "`") return { body, end: j + 1 };
    body += src.charAt(j++);
  }
  return null;
}

// A parameter expansion body (`${x:-word}`, `${x:=word}`, `${x/pat/rep}`) starting just after "${". Bash expands
// the word operand, so every command substitution inside it runs; their bodies are returned for parsing.
// Quoting inside the braces is followed as bash does: single quotes are literal, double quotes still expand.
// Returns null when the expansion is not terminated.
function scanParamExpansion(src: string, i: number): { end: number; subs: string[] } | null {
  const subs: string[] = [];
  let depth = 0;
  let j = i;
  // One `$…` expansion at j inside the braces or inside double quotes: the index after it, or null.
  const expansion = (k: number): number | null => {
    if (src[k + 1] === "(" && src[k + 2] === "(") {
      const a = scanArith(src, k + 3);
      if (a) { subs.push(...a.subs); return a.end; }
    }
    if (src[k + 1] === "(") {
      const p = scanParen(src, k + 2);
      if (!p) return null;
      subs.push(p.body);
      return p.end;
    }
    if (src[k + 1] === "{") {
      const inner = scanParamExpansion(src, k + 2);
      if (!inner) return null;
      subs.push(...inner.subs);
      return inner.end;
    }
    return k + 1;
  };
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", j + 1); if (e < 0) return null; j = e + 1; continue; }
    if (c === '"') {
      j++;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$") { const next = expansion(j); if (next === null) return null; j = next; continue; }
        if (src[j] === "`") { const b = scanBacktick(src, j + 1); if (!b) return null; subs.push(b.body); j = b.end; continue; }
        j++;
      }
      if (j >= src.length) return null;
      j++;
      continue;
    }
    if (c === "$") { const next = expansion(j); if (next === null) return null; j = next; continue; }
    if (c === "`") { const b = scanBacktick(src, j + 1); if (!b) return null; subs.push(b.body); j = b.end; continue; }
    if (c === "{") depth++;
    else if (c === "}") { if (depth === 0) return { end: j + 1, subs }; depth--; }
    j++;
  }
  return null;
}

// An arithmetic body (`$(( … ))` or `(( … ))`) starting at `i`, just after the opening "((". Bash
// still runs every command substitution inside it, so their bodies are returned for parsing.
// Returns null when the text is not a well-formed arithmetic body, so the caller can fall back to
// reading it as a command substitution or subshell, as bash does.
function scanArith(src: string, i: number): { body: string; subs: string[]; end: number } | null {
  const subs: string[] = [];
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", j + 1); if (e < 0) return null; j = e + 1; continue; }
    if (c === "$" && src[j + 1] === "(" && src[j + 2] === "(") {
      const inner = scanArith(src, j + 3);
      if (!inner) return null;
      subs.push(...inner.subs);
      j = inner.end;
      continue;
    }
    if (c === "$" && src[j + 1] === "(") {
      const p = scanParen(src, j + 2);
      if (!p) return null;
      subs.push(p.body);
      j = p.end;
      continue;
    }
    if (c === "`") {
      const b = scanBacktick(src, j + 1);
      if (!b) return null;
      subs.push(b.body);
      j = b.end;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth > 0) depth--;
      else return src[j + 1] === ")" ? { body: src.slice(i, j), subs, end: j + 2 } : null;
    }
    j++;
  }
  return null;
}

export const MAX_BRACE_EXPANSIONS = 64;

// Bash brace expansion of one word: `{a,b}` alternatives (nested, several groups) and `{x..y[..step]}`
// sequences of integers or single letters; `${...}`, `{}` and `{x}` stay literal. Returns null when the word
// would expand to more than MAX_BRACE_EXPANSIONS words, so callers can fail closed.
export function expandBraces(word: string, max = MAX_BRACE_EXPANSIONS): string[] | null {
  for (let i = word.indexOf("{"); i >= 0; i = word.indexOf("{", i + 1)) {
    let depth = 0;
    let end = -1;
    const commas: number[] = [];
    for (let k = i; k < word.length; k++) {
      const ch = word[k];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = k; break; } }
      else if (ch === "," && depth === 1) commas.push(k);
    }
    if (end < 0) return [word];
    if (word[i - 1] === "$") { i = end; continue; }
    const prefix = word.slice(0, i);
    const suffix = word.slice(end + 1);
    let alts: string[];
    if (commas.length) {
      alts = [];
      let from = i + 1;
      for (const k of [...commas, end]) { alts.push(word.slice(from, k)); from = k + 1; }
    } else {
      const seq = braceSequence(word.slice(i + 1, end), max);
      if (seq === undefined) continue;
      if (seq === null) return null;
      alts = seq;
    }
    const out: string[] = [];
    for (const alt of alts) {
      const sub = expandBraces(prefix + alt + suffix, max);
      if (sub === null || out.length + sub.length > max) return null;
      out.push(...sub);
    }
    return out;
  }
  return [word];
}

// `x..y[..step]` inside braces: its words, null when there are too many, undefined when it is not a sequence.
function braceSequence(body: string, max: number): string[] | null | undefined {
  const m = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/.exec(body);
  if (!m) return undefined;
  const letters = m[3] !== undefined;
  const from = letters ? (m[3] ?? "").charCodeAt(0) : Number(m[1]);
  const to = letters ? (m[4] ?? "").charCodeAt(0) : Number(m[2]);
  const step = Math.abs(Number(m[5] ?? "1")) || 1;
  if (Math.floor(Math.abs(to - from) / step) + 1 > max) return null;
  const out: string[] = [];
  for (let v = from; from <= to ? v <= to : v >= to; v += from <= to ? step : -step) out.push(letters ? String.fromCharCode(v) : String(v));
  return out;
}

// A brace group bash would expand: `{a,b}` or `{x..y}` outside `${…}`.
const BRACE_GROUP_RE = /(?:^|[^$])\{[^{}]*(?:,|\.\.)[^{}]*\}/;

const OPS = ["&&", "||", ";;", "|&", ";", "|", "&", "\n", "(", ")"];

function tokenize(src: string, opaque: string[]): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  let cur = null as (Word & { started: boolean }) | null;
  const pendingHeredocs: { redir: number; strip: boolean }[] = [];
  const word = () => (cur ??= { text: "", raw: "", dynamic: false, quoted: false, ansiC: false, fragmented: false, subs: [], procSub: false, started: true });
  const flush = () => {
    if (cur) {
      const { started: _s, ...w } = cur;
      toks.push({ k: "w", w });
      cur = null;
    }
  };
  const readHeredocs = () => {
    for (const h of pendingHeredocs.splice(0)) {
      const delimTok = toks[h.redir + 1];
      const delim = delimTok?.k === "w" ? delimTok.w.text : "";
      const lines: string[] = [];
      let found = false;
      while (i < n) {
        const nl = src.indexOf("\n", i);
        const line = src.slice(i, nl < 0 ? n : nl);
        i = nl < 0 ? n : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === delim) { found = true; break; }
        lines.push(line);
      }
      if (!found) opaque.push(`unterminated heredoc <<${delim}`);
      const r = toks[h.redir];
      const body = lines.join("\n");
      if (r?.k === "redir") r.body = body;
      if (delimTok?.k === "w" && !delimTok.w.quoted && /\$\(|`/.test(body)) {
        // An unquoted heredoc still runs substitutions.
        for (const m of body.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) delimTok.w.subs.push(m[1] ?? m[2] ?? "");
      }
    }
  };

  while (i < n) {
    const c = src.charAt(i);
    // Line continuation.
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (c === " " || c === "\t" || c === "\r") { flush(); i++; continue; }
    if (c === "#" && !cur) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // Redirections (with an optional fd prefix held in the current word).
    if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      if (src[i + 1] === "(" && c !== "&") {
        const p = scanParen(src, i + 2);
        if (!p) { opaque.push("unbalanced process substitution"); i = n; break; }
        const w = word();
        w.text += `${c}(…)`; w.raw += src.slice(i, p.end); w.dynamic = true; w.procSub = true; w.subs.push(p.body);
        i = p.end;
        continue;
      }
      let fd = "";
      if (cur && /^\d+$/.test(cur.raw) && !cur.quoted) { fd = cur.raw; cur = null; }
      else flush();
      const m = /^(?:&>>|&>|<<<|<<-|<<|>>|>\||>&|<&|<>|>|<)/.exec(src.slice(i));
      if (!m) throw new Error(`no redirection operator at offset ${i}`); // unreachable: "<", ">" or "&>" is here
      const op = m[0];
      i += op.length;
      toks.push({ k: "redir", op, fd });
      if (op === "<<" || op === "<<-") pendingHeredocs.push({ redir: toks.length - 1, strip: op === "<<-" });
      continue;
    }
    if (c === "\n") {
      flush();
      toks.push({ k: "op", v: "\n" });
      i++;
      if (pendingHeredocs.length) readHeredocs();
      continue;
    }
    // `(( … ))` arithmetic command at the start of a command: one word, with every command substitution
    // inside it parsed. A body that is not arithmetic falls through to nested subshells, as in bash.
    if (c === "(" && src[i + 1] === "(" && !cur) {
      const a = scanArith(src, i + 2);
      if (a) {
        toks.push({ k: "w", w: { text: "((", raw: src.slice(i, a.end), dynamic: a.subs.length > 0, quoted: false, ansiC: false, fragmented: false, subs: a.subs, procSub: false } });
        i = a.end;
        continue;
      }
    }
    const fnDef = c === "(" && cur !== null && !cur.quoted && /^[A-Za-z_][\w.:-]*$/.test(cur.raw) && /^\(\s*\)/.test(src.slice(i));
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op && (op !== "(" || !cur || fnDef) && !(op === "&" && src[i + 1] === ">")) {
      // `name()` function definitions: keep "(" as an op so the parser can spot them.
      flush();
      toks.push({ k: "op", v: op });
      i += op.length;
      continue;
    }
    // Word characters.
    const w = word();
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) { opaque.push("unterminated single quote"); w.text += src.slice(i + 1); w.raw += src.slice(i); i = n; break; }
      if (w.raw.length > 0) w.fragmented = true;
      w.text += src.slice(i + 1, e); w.raw += src.slice(i, e + 1); w.quoted = true;
      i = e + 1;
      if (i < n && !/[\s;&|()<>]/.test(src.charAt(i))) w.fragmented = true;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      const start = i;
      let j = i + 2;
      while (j < n && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      if (j >= n) { opaque.push("unterminated $'…'"); i = n; break; }
      if (w.raw.length > 0) w.fragmented = true;
      w.text += decodeAnsiC(src.slice(i + 2, j)); w.raw += src.slice(start, j + 1); w.quoted = true; w.ansiC = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      if (w.raw.length > 0) w.fragmented = true;
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        const d = src.charAt(i);
        if (d === '"') { closed = true; i++; break; }
        if (d === "\\" && i + 1 < n) {
          const nx = src.charAt(i + 1);
          if (nx === "\n") { i += 2; continue; }
          w.text += /[$`"\\]/.test(nx) ? nx : `\\${nx}`;
          i += 2;
          continue;
        }
        if (d === "$" && src[i + 1] === "(" && src[i + 2] === "(") {
          const a = scanArith(src, i + 3);
          if (a) { w.subs.push(...a.subs); w.text += src.slice(i, a.end); w.dynamic = true; i = a.end; continue; }
        }
        if (d === "$" && src[i + 1] === "(") {
          const p = scanParen(src, i + 2);
          if (!p) { opaque.push("unbalanced $( in double quotes"); i = n; break; }
          w.subs.push(p.body); w.text += `$(${p.body})`; w.dynamic = true; i = p.end;
          continue;
        }
        if (d === "`") {
          const b = scanBacktick(src, i + 1);
          if (!b) { opaque.push("unterminated backtick"); i = n; break; }
          w.subs.push(b.body); w.text += `\`${b.body}\``; w.dynamic = true; i = b.end;
          continue;
        }
        if (d === "$" && /[A-Za-z_{@*#?$!0-9]/.test(src[i + 1] ?? "")) w.dynamic = true;
        w.text += d;
        i++;
      }
      if (!closed) opaque.push("unterminated double quote");
      w.raw += src.slice(start, i); w.quoted = true;
      if (i < n && !/[\s;&|()<>]/.test(src.charAt(i))) w.fragmented = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < n) {
        if (w.raw.length > 0) w.fragmented = true;
        w.text += src.charAt(i + 1); w.raw += src.slice(i, i + 2);
        i += 2;
      } else i++;
      continue;
    }
    if (c === "$" && src[i + 1] === "(" && src[i + 2] === "(") {
      // Arithmetic expansion: bash still runs the command substitutions inside it. Text that is not
      // arithmetic is a command substitution that starts with a subshell (`$((cmd) …)`), read below.
      const a = scanArith(src, i + 3);
      if (a) {
        w.subs.push(...a.subs); w.text += src.slice(i, a.end); w.raw += src.slice(i, a.end); w.dynamic = true;
        i = a.end;
        continue;
      }
    }
    if (c === "$" && src[i + 1] === "(") {
      const p = scanParen(src, i + 2);
      if (!p) { opaque.push("unbalanced $("); i = n; break; }
      w.subs.push(p.body); w.text += `$(${p.body})`; w.raw += src.slice(i, p.end); w.dynamic = true;
      i = p.end;
      continue;
    }
    if (c === "`") {
      const b = scanBacktick(src, i + 1);
      if (!b) { opaque.push("unterminated backtick"); i = n; break; }
      w.subs.push(b.body); w.text += `\`${b.body}\``; w.raw += src.slice(i, b.end); w.dynamic = true;
      i = b.end;
      continue;
    }
    if (c === "$" && src[i + 1] === "{") {
      // `${x:-$(cmd)}`: the substitution in the word operand runs, quoted or not.
      const pe = scanParamExpansion(src, i + 2);
      if (!pe) { opaque.push("unterminated ${"); w.text += src.slice(i); w.raw += src.slice(i); w.dynamic = true; i = n; break; }
      w.subs.push(...pe.subs); w.text += src.slice(i, pe.end); w.raw += src.slice(i, pe.end); w.dynamic = true;
      i = pe.end;
      continue;
    }
    if (c === "$" && /[A-Za-z_@*#?$!0-9]/.test(src[i + 1] ?? "")) {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[@*#?$!0-9])/.exec(src.slice(i));
      if (!m) throw new Error(`no parameter name at offset ${i}`); // unreachable: the next character was just checked
      w.text += m[0]; w.raw += m[0]; w.dynamic = true;
      i += m[0].length;
      continue;
    }
    w.text += c; w.raw += c;
    i++;
  }
  flush();
  if (pendingHeredocs.length) readHeredocs();
  return toks;
}

const RESERVED_SKIP = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time", "coproc"]);
// Builtins whose operands bash may evaluate as arithmetic or array subscripts.
const ARITH_CONSUMERS = new Set(["let", "declare", "typeset", "local", "export", "readonly", "unset", "printf", "read", "test", "[", "[[", "((", "mapfile", "readarray", "wait", "getopts", "shift", "return", "exit"]);

// Brace expansion of the command's words, as bash does after parsing. An unquoted word expands in place;
// a command name that mixes a brace group with quoting, or that would expand past the bound, cannot be
// read reliably and is reported. Operands past the bound stay as written (classify.ts then fails closed).
function expandWords(words: Word[], opaque: string[]): void {
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w === undefined) break;
    if (!BRACE_GROUP_RE.test(w.raw)) continue;
    if (w.quoted || w.raw !== w.text) {
      if (k === 0) opaque.push("brace expansion mixed with quoting in the command name");
      continue;
    }
    const alts = expandBraces(w.text);
    if (alts === null) {
      if (k === 0) opaque.push("brace expansion of the command name past the bound");
      continue;
    }
    if (alts.length < 2) continue;
    // Bash drops a word that expands to nothing (`{x,}` gives just `x`).
    const kept = alts.filter((text) => text !== "");
    words.splice(k, 1, ...kept.map((text) => ({ ...w, text, raw: text })));
    k += kept.length - 1;
  }
}
const RESERVED_END = new Set(["fi", "done", "}", "esac"]);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const DECODER_RE = /\bbase64\b[^|]*\s-(?:d|-decode|D)\b|\bxxd\b[^|]*\s-r|\bopenssl\b[^|]*\s(?:enc|base64)\b[^|]*-d\b|\bbase32\b[^|]*-d|\bgunzip\b|\bzcat\b|\brev\b|\bprintf\b[^|]*\\x/;

export function basenameOf(exe: string): string {
  const b = exe.replace(/\\/g, "/").split("/").pop() || exe;
  return b.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

function resolveCd(target: string | undefined, cwd: string | null, home: string, remote?: string): string | null {
  if (target === undefined || target === "~") return remote ? "~" : home;
  if (target === "-" || /[$`*?]/.test(target)) return null;
  if (target.startsWith("~/")) return remote ? target : home + target.slice(1);
  if (target.startsWith("/")) return normalize(target);
  if (cwd === null) return null;
  if (cwd === "~" || cwd.startsWith("~/")) return normalize(`${cwd}/${target}`);
  return normalize(`${cwd}/${target}`);
}

export function normalize(p: string): string {
  const abs = p.startsWith("/");
  const tilde = p.startsWith("~");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (out.length && out[out.length - 1] !== "~") out.pop(); continue; }
    out.push(part);
  }
  const joined = out.join("/");
  if (tilde) return joined || "~";
  return abs ? `/${joined}` : joined || ".";
}

type Raw = { words: Word[]; redirects: Redirect[]; pipeIn: boolean; pipeOut: boolean; background: boolean; stdinBody?: string; cwd: string | null };

export function parseShell(src: string, env: ParseEnv): Parsed {
  const opaque: string[] = [];
  const segments: Segment[] = [];
  parseInto(src, { ...env, fns: env.fns ?? new Set(), aliases: env.aliases ?? new Map<string, Word[] | null>() }, segments, opaque);
  return { segments, opaque };
}

function parseInto(src: string, env: ParseEnv, out: Segment[], opaque: string[]): void {
  const depth = env.depth ?? 0;
  if (depth > MAX_DEPTH) { opaque.push("nesting too deep"); return; }
  const toks = tokenize(src, opaque);
  let cwd = env.cwd;
  const vars: Record<string, string> = { ...(env.vars ?? {}) };
  env = { ...env, vars };
  const cwdStack: (string | null)[] = [];
  let caseMode = 0;
  let raw: Raw = { words: [], redirects: [], pipeIn: false, pipeOut: false, background: false, cwd };
  let prevInPipe: Segment | null = null;

  const finish = (op: string | null) => {
    const r = raw;
    r.cwd = cwd;
    if (op === "|" || op === "|&") r.pipeOut = true;
    if (op === "&") r.background = true;
    const produced = r.words.length || r.redirects.length ? buildSegments(r, env, cwd, out, opaque, depth) : null;
    if (produced) {
      if (prevInPipe && r.pipeIn) { produced.prev = prevInPipe; prevInPipe.next = produced; }
      prevInPipe = r.pipeOut ? produced : null;
      // Plain assignments (`DEST=~/x`, `export DEST=~/x`) let later paths resolve.
      const assignSrc = !produced.argv.length ? produced.assigns : produced.argv[0] === "export" || produced.argv[0] === "local" || produced.argv[0] === "declare" ? produced.argv.slice(1).filter((a) => ASSIGN_RE.test(a)) : [];
      for (const as of assignSrc) {
        const eq = as.indexOf("=");
        const name = as.slice(0, eq).replace(/\+$/, "");
        const value = as.slice(eq + 1);
        if (/[`]|\$\(/.test(value)) Reflect.deleteProperty(vars, name);
        else vars[name] = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m: string, v: string) => (Object.hasOwn(vars, v) ? vars[v] : undefined) ?? m);
      }
      // `cd` changes the directory for later commands in this list (not inside a pipeline).
      if (produced.argv[0] === "cd" || produced.argv[0] === "pushd") {
        if (!r.pipeIn && !r.pipeOut) cwd = resolveCd(produced.argv.slice(1).find((a) => !a.startsWith("-")), cwd, env.home, env.remote);
      } else if (produced.argv[0] === "popd") cwd = null;
    } else if (!r.pipeOut) prevInPipe = null;
    raw = { words: [], redirects: [], pipeIn: r.pipeOut, pipeOut: false, background: false, cwd };
  };

  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t];
    if (tok === undefined) break;
    if (tok.k === "op") {
      if (tok.v === "(") {
        // `name ()` function definition or a subshell.
        const after = toks[t + 1];
        if (raw.words.length === 1 && after?.k === "op" && after.v === ")") {
          const name = raw.words[0];
          if (name && !name.quoted) env.fns?.add(name.text);
          raw.words = [];
          t++;
          continue;
        }
        if (raw.words.length) finish(";");
        cwdStack.push(cwd);
        continue;
      }
      if (tok.v === ")") {
        if (caseMode > 0 && raw.words.length) {
          // A case pattern (`case x in $(cmd)) …`) is expanded before it is matched: its substitutions run.
          for (const w of raw.words) for (const s of w.subs) parseInto(s, { ...env, cwd, via: [...(env.via ?? []), "case"], depth: depth + 1 }, out, opaque);
          raw = { ...raw, words: [], redirects: [] };
          continue;
        }
        finish(";");
        if (cwdStack.length) cwd = cwdStack.pop() ?? null;
        continue;
      }
      finish(tok.v);
      continue;
    }
    if (tok.k === "redir") {
      const next = toks[t + 1];
      const target = next?.k === "w" ? next.w : null;
      if (target) t++;
      const redir: Redirect = { op: tok.op, fd: tok.fd, target: target?.text ?? "", dynamic: target?.dynamic ?? false };
      const body = tok.body;
      if (body !== undefined) { redir.body = body; raw.stdinBody = body; redir.target = ""; }
      if (tok.op === "<<<") raw.stdinBody = target?.text ?? "";
      if (target?.subs.length) for (const s of target.subs) parseInto(s, { ...env, cwd, via: [...(env.via ?? []), "$()"], depth: depth + 1 }, out, opaque);
      raw.redirects.push(redir);
      continue;
    }
    const w = tok.w;
    if (raw.words.length === 0 && !w.quoted) {
      if (w.text === "case") { caseMode++; }
      if (w.text === "esac") { caseMode = Math.max(0, caseMode - 1); continue; }
    }
    raw.words.push(w);
  }
  finish(null);
}

// Strip assignments / reserved words, expand substitutions, then unwrap wrappers. Returns the
// last segment produced for this simple command (used to link pipelines).
function buildSegments(r: Raw, env: ParseEnv, cwd: string | null, out: Segment[], opaque: string[], depth: number): Segment | null {
  const words = [...r.words];
  // Substitutions run before the command itself.
  for (const w of words) for (const s of w.subs) parseInto(s, { ...env, cwd, via: [...(env.via ?? []), w.procSub ? "<()" : "$()"], depth: depth + 1 }, out, opaque);
  const assigns: string[] = [];
  const assignWords: Word[] = [];
  let coproc = false;
  while (words.length) {
    const w = words[0];
    if (w === undefined) break;
    if (!w.quoted && w.text === "coproc") coproc = true;
    if (!w.quoted && RESERVED_SKIP.has(w.text)) { words.shift(); continue; }
    if (!w.quoted && RESERVED_END.has(w.text)) { words.shift(); continue; }
    if (ASSIGN_RE.test(w.raw)) { assigns.push(w.text); assignWords.push(w); words.shift(); continue; }
    // `function f {`, `function f() {`: the definition is not a command; its body is read on.
    if (!w.quoted && w.text === "function" && words[1]) {
      env.fns?.add(words[1].text.replace(/\(\)$/, ""));
      words.splice(0, 2);
      continue;
    }
    // `coproc NAME { … }` / `coproc NAME ( … )`: NAME labels the coprocess, the group is the command.
    if (coproc && words[1] && !words[1].quoted && (words[1].text === "{" || words[1].text === "(")) { words.shift(); continue; }
    break;
  }
  // A command name an earlier `alias` or `hash -p` redefined: bash runs the alias value (or the hashed path)
  // with these arguments, so that is what is classified. An alias value that is not a simple command is opaque.
  const aliasName = words[0] && !words[0].quoted ? words[0].text : "";
  if (aliasName && env.aliases?.has(aliasName)) {
    const value = env.aliases.get(aliasName);
    if (value === null || value === undefined) opaque.push(`alias ${aliasName} expands to a compound command`);
    else words.splice(0, 1, ...value);
  }
  const lead = words[0];
  if (lead && !lead.quoted && ["for", "select", "case", "in"].includes(lead.text)) words.length = 0;
  // Words bash would read as array subscripts or arithmetic operands are evaluated, and their
  // command substitutions run, even from a single-quoted literal (`let 'a[$(cmd)]'`). That is not
  // modelled: report it.
  const arithmeticText = (w: Word) => w.subs.length === 0 && /\[[^\]]*(?:\$\(|`)/.test(w.text);
  const leadName = lead && !lead.quoted ? lead.text : "";
  if (assignWords.some(arithmeticText) || (ARITH_CONSUMERS.has(leadName) && words.slice(1).some(arithmeticText))) {
    opaque.push("command text inside an array subscript or arithmetic operand");
  }
  if (leadName !== "[[" && leadName !== "((") expandWords(words, opaque);
  // Variables whose value the shell later runs as code (the debug prompt PS4 under `set -x`, the prompts,
  // PROMPT_COMMAND, an exported function): the value is parsed as commands now.
  const declared = /^(?:export|declare|typeset|local|readonly)$/.test(leadName) ? words.slice(1).map((w) => w.text) : [];
  parseCodeVars([...assigns, ...declared], env, cwd, out, opaque, depth);
  const head = words[0];
  if (head && !head.quoted && (head.text === "[[" || head.text === "[" || head.text === "((")) {
    // Tests only read.
    words.splice(0, words.length, { ...head, text: "test" });
  }
  const seg: Segment = {
    argv: words.map((w) => w.text),
    words,
    redirects: r.redirects,
    assigns: [...(env.assigns ?? []), ...assigns],
    stdinBody: r.stdinBody,
    pipeIn: r.pipeIn,
    pipeOut: r.pipeOut,
    background: r.background,
    cwd,
    remote: env.remote,
    sudo: env.sudo,
    via: [...(env.via ?? [])],
    depth,
    unknownArgs: false,
    filtered: false,
    obfuscatedName: false,
    dynamicName: false,
    decoderInName: false,
    vars: { ...(env.vars ?? {}) },
  };
  if (head && !head.quoted && env.fns?.has(head.text)) seg.fnCall = true;
  if (!seg.argv.length) {
    if (!assigns.length && !r.redirects.length) return null;
    seg.argv = [];
    out.push(seg);
    return seg;
  }
  return unwrap(seg, env, out, opaque);
}

// Variables whose value the shell later runs as code (the debug prompt PS4 under `set -x`, the prompts,
// PROMPT_COMMAND, an exported function): each value is parsed as commands now, wherever the assignment is
// written (a prefix, `export`/`declare`, or an `env NAME=value` operand).
function parseCodeVars(list: string[], env: ParseEnv, cwd: string | null, out: Segment[], opaque: string[], depth: number): void {
  for (const a of list) {
    const m = /^(PS0|PS1|PS2|PS4|PROMPT_COMMAND|BASH_FUNC_[^=]*)=([\s\S]+)$/.exec(a);
    if (m?.[2]?.trim()) parseInto(m[1]?.startsWith("BASH_FUNC_") ? m[2].replace(/^\(\)\s*/, "") : m[2], { ...env, cwd, via: [...(env.via ?? []), m[1] ?? ""], depth: depth + 1 }, out, opaque);
  }
}

function takeOptions(argv: string[], start: number, withArg: Set<string>, longWithArg: Set<string> = new Set()): number {
  let i = start;
  while (i < argv.length) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--") return i + 1;
    if (!a.startsWith("-") || a === "-") return i;
    if (a.startsWith("--")) {
      const name = a.split("=")[0] ?? a;
      i += longWithArg.has(name) && !a.includes("=") ? 2 : 1;
      continue;
    }
    // Clustered short flags: the arg-taking one must be last (`-u user`, `-nu user`).
    const last = a.charAt(a.length - 1);
    i += withArg.has(last) && a.length === 2 ? 2 : withArg.has(last) ? 2 : 1;
  }
  return i;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "busybox"]);
// A script operand that is really standard input.
const STDIN_PATH = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;
export function isStdinPath(p: string): boolean {
  return STDIN_PATH.test(p);
}

// Programs that run another program given on their command line (exec wrappers). Each entry names the
// options it knows: short flags, short options that take a value, long flags and long options that take a
// value (`--x=v` or `--x v`). An option not listed makes the inner command unreadable, which is reported as
// opaque rather than guessed (a guess could hand the classifier an option value as the command name).
// `sub` names the subcommand that runs the command (`uv run`), `positional` the operands before it
// (`chroot NEWROOT`), `priv` marks a change of user, `ns` a namespace or root-directory launcher, and
// `dashdash` a wrapper whose command only follows `--`.
type WrapSpec = { flags?: string; withArg?: string; long?: string[]; longArg?: string[]; sub?: string; positional?: number; priv?: boolean; ns?: boolean; dashdash?: boolean; longEq?: boolean };
const WRAPPERS: Record<string, WrapSpec> = {
  pkexec: { long: ["--disable-internal-agent", "--keep-cwd"], longArg: ["--user"], priv: true },
  run0: { withArg: "ugD", long: ["--no-ask-password", "--slice-inherit", "--empty-environment", "--pty", "--pipe", "--lightweight"], longArg: ["--user", "--group", "--nice", "--chdir", "--setenv", "--property", "--description", "--slice", "--unit", "--machine", "--background", "--shell-prompt-prefix", "--area"], priv: true },
  gosu: { positional: 1, priv: true },
  "su-exec": { positional: 1, priv: true },
  setuidgid: { positional: 1, priv: true },
  chroot: { long: ["--skip-chdir"], longArg: ["--userspec", "--groups"], positional: 1, ns: true },
  unshare: { flags: "muinpUCTfrc", withArg: "SGRwl", long: ["--mount", "--uts", "--ipc", "--net", "--pid", "--user", "--cgroup", "--time", "--fork", "--map-root-user", "--map-current-user", "--map-auto", "--mount-proc", "--mount-binfmt", "--kill-child", "--keep-caps"], longArg: ["--setuid", "--setgid", "--root", "--wd", "--propagation", "--setgroups", "--map-user", "--map-group", "--map-users", "--map-groups", "--monotonic", "--boottime", "--load-interp"], ns: true },
  nsenter: { flags: "amuinpCUTFZ", withArg: "tSGNrw", long: ["--all", "--mount", "--uts", "--ipc", "--net", "--pid", "--cgroup", "--user", "--time", "--no-fork", "--preserve-credentials", "--follow-context", "--user-parent", "--keep-caps", "--join-cgroup"], longArg: ["--target", "--setuid", "--setgid", "--net-socket", "--root", "--wd", "--env"], ns: true },
  setpriv: { flags: "d", long: ["--dump", "--nnp", "--no-new-privs", "--clear-groups", "--keep-groups", "--init-groups", "--reset-env"], longArg: ["--ruid", "--euid", "--rgid", "--egid", "--reuid", "--regid", "--groups", "--inh-caps", "--ambient-caps", "--bounding-set", "--securebits", "--pdeathsig", "--selinux-label", "--apparmor-profile", "--landlock-access", "--landlock-rule", "--seccomp-filter"], ns: true },
  "flatpak-spawn": { long: ["--host", "--clear-env", "--watch-bus", "--expose-pids", "--share-pids", "--no-network", "--sandbox", "--latest-version", "--verbose"], longArg: ["--env", "--unset-env", "--directory", "--forward-fd", "--sandbox-expose", "--sandbox-expose-ro", "--sandbox-expose-path", "--sandbox-expose-path-ro", "--sandbox-flag", "--app-path", "--usr-path"], ns: true },
  "systemd-run": { flags: "qGPSrt", withArg: "pEuHMd", long: ["--user", "--system", "--scope", "--wait", "--pipe", "--pty", "--quiet", "--collect", "--no-block", "--no-ask-password", "--same-dir", "--shell", "--remain-after-exit", "--send-sighup", "--service-type", "--expand-environment"], longArg: ["--unit", "--property", "--description", "--slice", "--setenv", "--host", "--machine", "--uid", "--gid", "--nice", "--working-directory", "--on-active", "--on-boot", "--on-startup", "--on-unit-active", "--on-unit-inactive", "--on-calendar", "--on-timezone-change", "--on-clock-change", "--timer-property", "--path-property", "--socket-property", "--service-type", "--wait-for"] },
  fakeroot: { flags: "uhv", withArg: "lsib", long: ["--unknown-is-real"], longArg: ["--lib", "--faked"] },
  faketime: { flags: "mf", withArg: "p", long: ["--exclude-monotonic"], longArg: ["--date-prog"], positional: 1 },
  "dbus-launch": { long: ["--exit-with-session", "--exit-with-x11", "--sh-syntax", "--csh-syntax", "--binary-syntax", "--close-stderr", "--autolaunch"], longArg: ["--config-file"] },
  "ssh-agent": { flags: "cDdsk", withArg: "aEtPO" },
  chpst: { flags: "vP012", withArg: "uUbe/nlLmdofpcrt" },
  prlimit: { withArg: "po", long: ["--noheadings", "--raw", "--verbose", "--as", "--core", "--cpu", "--data", "--fsize", "--locks", "--memlock", "--msgqueue", "--nice", "--nofile", "--nproc", "--rss", "--rtprio", "--rttime", "--sigpending", "--stack"], longArg: ["--pid", "--output"] },
  cgexec: { withArg: "g", long: ["--sticky"] },
  cpulimit: { flags: "fqkiv", withArg: "lpPe", long: ["--foreground", "--quiet", "--kill", "--restore", "--verbose", "--include-children"], longArg: ["--limit", "--pid", "--path", "--exe"] },
  envdir: { positional: 1 },
  ifne: { flags: "n" },
  valgrind: { flags: "qvh", longEq: true },
  rlwrap: { flags: "AcEhimNnorRUvWXt", withArg: "abCDefFgHlOpPqsSwz" },
  entr: { flags: "acdnprz" },
  "uv run": { sub: "run", flags: "qvnmsU", withArg: "wpfP", long: ["--module", "--script", "--gui-script", "--no-sync", "--locked", "--frozen", "--isolated", "--active", "--no-active", "--no-project", "--all-extras", "--no-dev", "--dev", "--all-packages", "--all-groups", "--no-default-groups", "--only-dev", "--no-editable", "--exact", "--inexact", "--upgrade", "--reinstall", "--no-build", "--no-binary", "--no-build-isolation", "--compile-bytecode", "--offline", "--no-cache", "--quiet", "--verbose", "--no-progress", "--native-tls", "--no-config", "--no-python-downloads", "--managed-python", "--no-managed-python", "--no-env-file", "--no-index", "--preview", "--no-install-project", "--no-install-workspace", "--no-install-local", "--refresh"], longArg: ["--with", "--with-editable", "--with-requirements", "--python", "--package", "--extra", "--no-extra", "--group", "--no-group", "--only-group", "--env-file", "--directory", "--project", "--index", "--default-index", "--index-url", "--extra-index-url", "--find-links", "--cache-dir", "--config-file", "--color", "--prerelease", "--resolution", "--exclude-newer", "--refresh-package", "--reinstall-package", "--upgrade-package", "--python-preference", "--index-strategy", "--keyring-provider", "--link-mode", "--config-setting", "--allow-insecure-host"] },
  "poetry run": { sub: "run", flags: "qvnhV", withArg: "CP", long: ["--quiet", "--verbose", "--no-ansi", "--ansi", "--no-interaction", "--no-plugins", "--no-cache"], longArg: ["--directory", "--project"] },
  "pdm run": { sub: "run", flags: "vqgsl", withArg: "p", long: ["--verbose", "--quiet", "--global", "--site-packages", "--list", "--json", "--recreate"], longArg: ["--project", "--venv"] },
  "pipenv run": { sub: "run" },
  "hatch run": { sub: "run" },
  "rye run": { sub: "run", flags: "l", long: ["--list"], longArg: ["--pyproject"] },
  "pixi run": { sub: "run", flags: "vq", withArg: "e", long: ["--frozen", "--locked", "--clean-env", "--force-activate", "--no-install", "--verbose", "--quiet"], longArg: ["--manifest-path", "--environment", "--color"] },
  "conda run": { sub: "run", flags: "v", withArg: "np", long: ["--verbose", "--debug-wrapper-scripts", "--no-capture-output", "--live-stream", "--dev"], longArg: ["--name", "--prefix", "--cwd"] },
  "mamba run": { sub: "run", flags: "v", withArg: "np", long: ["--verbose", "--debug-wrapper-scripts", "--no-capture-output", "--live-stream", "--dev"], longArg: ["--name", "--prefix", "--cwd"] },
  "micromamba run": { sub: "run", flags: "v", withArg: "np", long: ["--verbose", "--attach", "--detach", "--clean-env"], longArg: ["--name", "--prefix", "--cwd", "--env"] },
  "bundle exec": { sub: "exec", long: ["--keep-file-descriptors"], longArg: ["--gemfile"] },
  "bundler exec": { sub: "exec", long: ["--keep-file-descriptors"], longArg: ["--gemfile"] },
  "asdf exec": { sub: "exec" },
  "direnv exec": { sub: "exec", positional: 1 },
  "toolbox run": { sub: "run", withArg: "cdr", longArg: ["--container", "--distro", "--release"] },
  "devbox run": { sub: "run", withArg: "ce", longArg: ["--config", "--env", "--env-file"] },
  "mise exec": { sub: "exec", dashdash: true },
  "mise x": { sub: "x", dashdash: true },
  "distrobox enter": { sub: "enter", dashdash: true },
  "wezterm start": { sub: "start", dashdash: true },
  watchexec: { dashdash: true },
};
// Wrappers that launch their command in a namespace, a changed root or a sandbox escape: the inner
// command is classified, and the launch itself is never routine (see classify.ts).
export const NAMESPACE_WRAPPERS: ReadonlySet<string> = new Set([...Object.entries(WRAPPERS).filter(([, w]) => w.ns).map(([k]) => k), "bwrap", "systemd-nspawn", "machinectl"]);

// Where the wrapped command starts, or null when an option is not one the spec knows.
function wrapperStart(argv: string[], from: number, spec: WrapSpec): number | null {
  const long = new Set(spec.long ?? []);
  const longArg = new Set(spec.longArg ?? []);
  const flags = spec.flags ?? "";
  const withArg = spec.withArg ?? "";
  let i = from;
  while (i < argv.length) {
    const a = argv[i] ?? "";
    if (a === "--") { i++; return i + (spec.positional ?? 0); }
    if (spec.dashdash) { i++; continue; }
    if (!a.startsWith("-") || a === "-") break;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (long.has(name) || (spec.longEq && eq > 0)) { i++; continue; }
      if (longArg.has(name)) { i += eq < 0 ? 2 : 1; continue; }
      if (spec.longEq && /^--(?:help|version)$/.test(a)) { i++; continue; }
      return null;
    }
    let consumed = 1;
    for (let k = 1; k < a.length; k++) {
      const ch = a.charAt(k);
      if (withArg.includes(ch)) { consumed = k === a.length - 1 ? 2 : 1; break; }
      if (!flags.includes(ch)) return null;
    }
    i += consumed;
  }
  if (spec.dashdash) return null; // no `--`: the command cannot be told from the wrapper's own operands
  return i + (spec.positional ?? 0);
}

// bwrap's options and how many operands each takes; anything else (including --args, which reads more
// options from a file descriptor) leaves the command unreadable.
const BWRAP_ARGS: Record<string, number> = Object.fromEntries<number>([
  ...["--unshare-all", "--share-net", "--unshare-user", "--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-net", "--unshare-uts", "--unshare-cgroup", "--unshare-cgroup-try", "--clearenv", "--new-session", "--die-with-parent", "--as-pid-1", "--disable-userns", "--assert-userns-disabled", "--level-prefix"].map((o): [string, number] => [o, 0]),
  ...["--argv0", "--userns", "--userns2", "--pidns", "--info-fd", "--json-status-fd", "--sync-fd", "--block-fd", "--userns-block-fd", "--seccomp", "--add-seccomp-fd", "--lock-file", "--remount-ro", "--exec-label", "--file-label", "--proc", "--dev", "--tmpfs", "--mqueue", "--dir", "--chdir", "--unsetenv", "--hostname", "--uid", "--gid", "--cap-add", "--cap-drop", "--perms", "--size", "--overlay-src", "--tmp-overlay", "--ro-overlay"].map((o): [string, number] => [o, 1]),
  ...["--bind", "--bind-try", "--dev-bind", "--dev-bind-try", "--ro-bind", "--ro-bind-try", "--symlink", "--setenv", "--file", "--bind-data", "--ro-bind-data", "--chmod", "--bind-fd", "--ro-bind-fd"].map((o): [string, number] => [o, 2]),
  ["--overlay", 3] as [string, number],
]);
function bwrapStart(argv: string[]): number | null {
  let i = 1;
  while (i < argv.length) {
    const a = argv[i] ?? "";
    if (a === "--") return i + 1;
    if (!a.startsWith("--")) return i;
    const n = Object.hasOwn(BWRAP_ARGS, a) ? BWRAP_ARGS[a] : undefined;
    if (n === undefined) return null;
    i += 1 + n;
  }
  return i;
}

// Terminal emulators that start a program: the command follows -e / -x / --command / -- .
const TERMINALS = new Set(["xterm", "uxterm", "urxvt", "rxvt", "st", "alacritty", "konsole", "terminator", "xfce4-terminal", "tilix", "ghostty", "kitty", "foot", "gnome-terminal", "lxterminal", "mate-terminal", "qterminal", "sakura", "wezterm"]);
// Tools whose operands are shell command strings (each one is run through a shell).
const COMMAND_STRING_TOOLS = new Set(["concurrently", "hyperfine", "pee"]);
const SSH_ARG_OPTS = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));
const SUDO_ARG_OPTS = new Set("CDghpRrtTUu".split(""));

function unwrap(seg: Segment, env: ParseEnv, out: Segment[], opaque: string[]): Segment | null {
  for (let guard = 0; guard < 12; guard++) {
    const first = seg.words[0];
    if (first && (first.dynamic || first.procSub) && !first.quoted) {
      seg.dynamicName = true;
      if (first.subs.some((s) => DECODER_RE.test(s))) seg.decoderInName = true;
    } else if (first?.dynamic) {
      seg.dynamicName = true;
      if (first.subs.some((s) => DECODER_RE.test(s))) seg.decoderInName = true;
    }
    // `\rm` is the usual alias-bypass idiom; fragments elsewhere (`r''m`, `r\m`, $'\x72m') are not.
    if (first && (first.ansiC || (first.fragmented && !/^\\[A-Za-z]/.test(first.raw)))) seg.obfuscatedName = true;
    const exe = basenameOf(seg.argv[0] ?? "");
    const rest = seg.argv.slice(1);
    const setArgv = (from: number) => {
      seg.argv = seg.argv.slice(from);
      seg.words = seg.words.slice(from);
    };
    switch (exe) {
      case "sudo":
      case "doas": {
        const flags = rest.filter((a) => a.startsWith("-") && !a.startsWith("--"));
        const nonInteractive = flags.some((f) => /^-[A-Za-z]*n/.test(f) && !/^-[A-Za-z]*[CDghpRrtTUu]n/.test(f)) || rest.includes("--non-interactive");
        let user: string | undefined;
        const ui = rest.findIndex((a) => a === "-u" || a === "--user");
        if (ui >= 0) user = rest[ui + 1];
        const at = takeOptions(seg.argv, 1, SUDO_ARG_OPTS, new Set(["--user", "--group", "--prompt", "--chdir", "--close-from", "--role", "--type", "--other-user", "--host"]));
        seg.sudo = { nonInteractive: nonInteractive || (seg.sudo?.nonInteractive ?? false), user };
        seg.via = [...seg.via, "sudo"];
        if (at >= seg.argv.length || flags.some((f) => /^-[A-Za-z]*[is]/.test(f) && !/^-[A-Za-z]*[CDghpRrtTUu]/.test(f))) {
          if (at >= seg.argv.length) {
            seg.interactiveShell = flags.some((f) => /[is]/.test(f)) || rest.length === 0;
            seg.argv = flags.some((f) => /^-[A-Za-z]*[lvkK]/.test(f)) ? ["sudo-query"] : ["sudo-shell"];
            seg.words = [];
            out.push(seg);
            return seg;
          }
        }
        setArgv(at);
        continue;
      }
      case "env": {
        let i = 1;
        while (i < seg.argv.length) {
          const a = seg.argv[i];
          if (a === undefined) break;
          if (a === "-u" || a === "--unset" || a === "-C" || a === "--chdir" || a === "-S" || a === "--split-string") {
            if ((a === "-S" || a === "--split-string") && seg.argv[i + 1]) {
              parseInto(seg.argv.slice(i + 1).join(" "), { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, "env -S"], depth: seg.depth + 1, assigns: seg.assigns }, out, opaque);
              return null;
            }
            i += 2;
            continue;
          }
          if (a.startsWith("-")) { i++; continue; }
          if (ASSIGN_RE.test(a)) { seg.assigns.push(a); parseCodeVars([a], env, seg.cwd, out, opaque, seg.depth); i++; continue; }
          break;
        }
        if (i >= seg.argv.length) { seg.argv = ["env"]; seg.words = seg.words.slice(0, 1); out.push(seg); return seg; }
        setArgv(i);
        continue;
      }
      case "timeout": {
        let i = takeOptions(seg.argv, 1, new Set(["s", "k"]), new Set(["--signal", "--kill-after"]));
        i++; // duration
        if (i >= seg.argv.length) break;
        setArgv(i);
        continue;
      }
      case "nice": {
        const i = takeOptions(seg.argv, 1, new Set(["n"]), new Set(["--adjustment"]));
        if (i >= seg.argv.length) break;
        setArgv(i);
        continue;
      }
      case "ionice":
      case "chrt":
      case "taskset":
      case "numactl":
      case "stdbuf":
      case "setsid":
      case "nohup":
      case "unbuffer":
      case "chronic":
      case "caffeinate":
      case "time":
      case "builtin":
      case "exec":
      case "strace":
      case "ltrace":
      case "xvfb-run":
      case "dbus-run-session":
      case "proxychains":
      case "proxychains4":
      case "torsocks":
      case "firejail":
      case "catchsegv":
      case "systemd-inhibit":
      case "doppler":
      case "dotenv": {
        const argOpts = exe === "ionice" ? new Set(["c", "n", "p"]) : exe === "taskset" || exe === "chrt" ? new Set(["p"]) : exe === "exec" ? new Set(["a"]) : exe === "strace" || exe === "ltrace" ? new Set(["e", "o", "p", "s", "u"]) : new Set<string>();
        let i = takeOptions(seg.argv, 1, argOpts);
        if (exe === "taskset" || exe === "chrt") i++; // mask / priority
        if (exe === "doppler") { const r = seg.argv.indexOf("--"); if (seg.argv[1] !== "run" || r < 0) break; i = r + 1; }
        if (i >= seg.argv.length) break;
        seg.via = [...seg.via, exe];
        setArgv(i);
        continue;
      }
      case "command": {
        if (rest[0] === "-v" || rest[0] === "-V") { seg.argv = ["command-query", ...rest.slice(1)]; break; }
        const i = takeOptions(seg.argv, 1, new Set());
        if (i >= seg.argv.length) break;
        setArgv(i);
        continue;
      }
      case "flock": {
        const i = takeOptions(seg.argv, 1, new Set(["w", "E", "c"]), new Set(["--timeout", "--conflict-exit-code", "--command"]));
        const ci = seg.argv.findIndex((a) => a === "-c" || a === "--command");
        const command = seg.argv[ci + 1];
        if (ci >= 0 && command) {
          parseInto(command, { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, "flock"], depth: seg.depth + 1, assigns: seg.assigns }, out, opaque);
          return null;
        }
        if (i + 1 >= seg.argv.length) break;
        setArgv(i + 1);
        continue;
      }
      case "watch": {
        const i = takeOptions(seg.argv, 1, new Set(["n", "d", "g"]), new Set(["--interval", "--differences"]));
        if (i >= seg.argv.length) break;
        parseInto(seg.argv.slice(i).join(" "), { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, "watch"], depth: seg.depth + 1, assigns: seg.assigns }, out, opaque);
        return null;
      }
      case "xargs":
      case "parallel": {
        const i = takeOptions(seg.argv, 1, new Set(["I", "i", "n", "P", "d", "E", "L", "l", "s", "a", "j"]), new Set(["--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace", "--jobs"]));
        seg.via = [...seg.via, exe];
        seg.unknownArgs = true;
        if (i >= seg.argv.length) { seg.argv = ["echo"]; seg.words = []; out.push(seg); return seg; }
        setArgv(i);
        continue;
      }
      case "eval": {
        // `eval "$(tool init)"`: the substitution already ran as its own segment; the eval handler
        // decides whether its output is trusted setup code.
        if (seg.words.length > 1 && seg.words.slice(1).every((w) => w.subs.length > 0 && /^(?:\$\([\s\S]*\)|`[\s\S]*`)$/.test(w.text))) {
          out.push(seg);
          return seg;
        }
        const script = rest.join(" ");
        const inner: Segment[] = [];
        parseInto(script, { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, "eval"], depth: seg.depth + 1 }, inner, opaque);
        const dyn = seg.words.slice(1).some((w) => w.dynamic);
        for (const s of inner) { s.evalOf = dyn; out.push(s); }
        if (dyn && !inner.length) {
          seg.argv = ["eval"]; seg.evalOf = true;
          out.push(seg);
          return seg;
        }
        return inner[inner.length - 1] ?? null;
      }
      case "ssh": {
        const i = takeOptions(seg.argv, 1, SSH_ARG_OPTS);
        const host = seg.argv[i];
        if (!host) break;
        const forwards = rest.some((a) => /^-[A-Za-z]*[LRDw]/.test(a) && !a.startsWith("--"));
        const proxyCommand = seg.argv.some((a, k) => /ProxyCommand|LocalCommand|PermitLocalCommand/i.test(a) && (seg.argv[k - 1] === "-o" || a.startsWith("-o")));
        const hostName = host.replace(/^[^@]*@/, "");
        const remoteCmd = seg.argv.slice(i + 1);
        const conn: Segment = { ...seg, argv: ["ssh", hostName], words: seg.words.slice(0, 1), ssh: { host: hostName, forwards, proxyCommand } };
        if (remoteCmd.length) {
          out.push(conn);
          parseInto(remoteCmd.join(" "), { ...env, cwd: "~", remote: hostName, sudo: undefined, via: [...seg.via, `ssh ${hostName}`], depth: seg.depth + 1 }, out, opaque);
          return conn;
        }
        if (seg.stdinBody !== undefined) {
          out.push(conn);
          parseInto(seg.stdinBody, { ...env, cwd: "~", remote: hostName, sudo: undefined, via: [...seg.via, `ssh ${hostName}`], depth: seg.depth + 1 }, out, opaque);
          return conn;
        }
        conn.interactiveShell = !seg.pipeIn;
        if (seg.pipeIn) conn.unknownArgs = true; // remote script arrives on stdin
        out.push(conn);
        return conn;
      }
      default:
        break;
    }
    const inner = (script: string, via: string, cwd: string | null = seg.cwd) =>
      parseInto(script, { ...env, cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, via], depth: seg.depth + 1, assigns: seg.assigns }, out, opaque);
    const unread = (what: string) => { opaque.push(what); out.push(seg); return seg; };
    // Builtins that take a command string: bash runs it later (a trap, an alias, a completion or
    // key binding, a mapfile callback), so it is parsed now, alongside the builtin itself.
    {
      if (exe === "trap" && seg.argv.length > 2 && !/^-[lp]*$/.test(seg.argv[1] ?? "") && seg.argv[1] !== "-") {
        const action = seg.argv[seg.argv[1] === "--" ? 2 : 1];
        if (action?.trim()) inner(action, "trap");
        out.push(seg);
        return seg;
      }
      if (exe === "alias") {
        for (const a of rest) {
          const eq = a.indexOf("=");
          if (eq <= 0) continue;
          const name = a.slice(0, eq);
          const value = a.slice(eq + 1);
          // Later uses of the name run the value with their own arguments appended, which cannot be seen here.
          const before = out.length;
          if (value.trim()) inner(value, "alias");
          for (const s of out.slice(before)) s.unknownArgs = true;
          const valueOpaque: string[] = [];
          const toks = tokenize(value, valueOpaque);
          env.aliases?.set(name, valueOpaque.length || toks.some((t) => t.k !== "w") ? null : toks.flatMap((t) => (t.k === "w" ? [t.w] : [])));
        }
        out.push(seg);
        return seg;
      }
      // `hash -p FILE NAME…`: later uses of NAME run FILE.
      if (exe === "hash") {
        const pi = seg.argv.indexOf("-p");
        const file = pi > 0 ? seg.argv[pi + 1] : undefined;
        if (file) for (const name of seg.argv.slice(pi + 2).filter((a) => !a.startsWith("-"))) env.aliases?.set(name, [{ text: file, raw: file, dynamic: false, quoted: false, ansiC: false, fragmented: false, subs: [], procSub: false }]);
        out.push(seg);
        return seg;
      }
      // `enable -f FILE NAME` loads a builtin from a shared object: what NAME then does is not readable.
      if (exe === "enable" && rest.some((a) => /^-[A-Za-z]*f/.test(a))) return unread("enable -f loads a builtin from a shared object");
      if (exe === "complete" || exe === "compgen" || exe === "mapfile" || exe === "readarray") {
        const ci = seg.argv.indexOf("-C");
        const cmd = ci > 0 ? seg.argv[ci + 1] : undefined;
        const before = out.length;
        if (cmd?.trim()) inner(cmd, `${exe} -C`);
        // The shell appends its own arguments to a callback.
        for (const cb of out.slice(before)) cb.unknownArgs = true;
        out.push(seg);
        return seg;
      }
      if (exe === "bind" && seg.argv.includes("-x")) {
        for (const a of rest) { const colon = a.indexOf(":"); if (colon >= 0) inner(a.slice(colon + 1).trim().replace(/^["']|["']$/g, ""), "bind -x"); }
        out.push(seg);
        return seg;
      }
      if (exe === "fc" && !rest.some((a) => /^-[A-Za-z]*l/.test(a))) return unread("fc re-runs commands from history");
      // `source /dev/stdin <<<…` runs the here-document as shell code.
      if ((exe === "source" || exe === ".") && rest[0] !== undefined && STDIN_PATH.test(rest[0]) && seg.stdinBody !== undefined) {
        inner(seg.stdinBody, "source <<");
        out.push(seg);
        return seg;
      }
    }
    // Exec wrappers: the command they run is what gets classified.
    if (exe === "su" || exe === "runuser" || exe === "sg") {
      const ci = seg.argv.findIndex((a, k) => k > 0 && (/^-[A-Za-z]*c$/.test(a) || a === "--command" || a.startsWith("--command=")));
      const cmd = ci < 0 ? undefined : seg.argv[ci]?.startsWith("--command=") ? seg.argv[ci]?.slice(10) : seg.argv[ci + 1];
      seg.sudo = { nonInteractive: seg.sudo?.nonInteractive ?? false, user: undefined };
      seg.via = [...seg.via, exe];
      if (cmd?.trim()) { inner(cmd, exe); return null; }
      if (exe === "runuser" && rest.some((a) => a === "-u" || a === "--user")) {
        const at = wrapperStart(seg.argv, 1, { flags: "lmpfP", withArg: "ugGsw", long: ["--login", "--preserve-environment", "--fast", "--pty"], longArg: ["--user", "--group", "--supp-group", "--shell", "--whitelist-environment"] });
        if (at === null) return unread("runuser options this parser does not know");
        if (at < seg.argv.length) { setArgv(at); continue; }
      }
      if (exe === "sg") {
        const args = seg.argv.slice(1).filter((a) => a !== "-");
        if (args.length > 1) { inner(args.slice(1).join(" "), "sg"); return null; }
      }
      seg.interactiveShell = true;
      seg.argv = ["sudo-shell"];
      seg.words = [];
      out.push(seg);
      return seg;
    }
    if (exe === "bwrap") {
      const at = bwrapStart(seg.argv);
      if (at === null) return unread("bwrap options this parser does not know");
      seg.via = [...seg.via, "bwrap"];
      if (at >= seg.argv.length) { out.push(seg); return seg; }
      setArgv(at);
      continue;
    }
    if (exe === "systemd-nspawn" || exe === "machinectl") return unread(`${exe}: the command it runs is not read`);
    if (exe === "script") {
      const ci = seg.argv.findIndex((a, k) => k > 0 && (/^-[A-Za-z]*c$/.test(a) || a === "--command" || a.startsWith("--command=")));
      const cmd = ci < 0 ? undefined : seg.argv[ci]?.startsWith("--command=") ? seg.argv[ci]?.slice(10) : seg.argv[ci + 1];
      if (cmd?.trim()) { inner(cmd, "script -c"); return null; }
      out.push(seg);
      return seg;
    }
    if (exe === "expect" && seg.argv.includes("-c")) return unread("expect -c runs Tcl commands");
    if (exe === "nix-shell") {
      const ci = seg.argv.findIndex((a) => a === "--run" || a === "--command");
      const cmd = ci > 0 ? seg.argv[ci + 1] : undefined;
      if (cmd?.trim()) { inner(cmd, "nix-shell --run"); return null; }
      out.push(seg);
      return seg;
    }
    if (exe === "nix" && (seg.argv[1] === "develop" || seg.argv[1] === "shell")) {
      const ci = seg.argv.findIndex((a) => a === "-c" || a === "--command");
      if (ci > 0 && ci + 1 < seg.argv.length) { seg.via = [...seg.via, `nix ${seg.argv[1]}`]; setArgv(ci + 1); continue; }
      out.push(seg);
      return seg;
    }
    if (exe === "pnpm" && seg.argv[1] === "exec") {
      if (seg.argv.some((a) => a === "-c" || a === "--shell-mode")) { inner(seg.argv.slice(2).filter((a) => !a.startsWith("-")).join(" "), "pnpm exec -c"); return null; }
      const at = wrapperStart(seg.argv, 2, { flags: "r", long: ["--recursive", "--parallel", "--no-bail", "--report-summary", "--workspace-root"], longArg: ["--filter", "--resume-from"] });
      if (at === null) return unread("pnpm exec options this parser does not know");
      if (at < seg.argv.length) { seg.via = [...seg.via, "pnpm exec"]; setArgv(at); continue; }
    }
    if (exe === "nodemon") {
      const xi = seg.argv.findIndex((a) => a === "--exec" || a === "-x");
      const cmd = xi > 0 ? seg.argv[xi + 1] : undefined;
      if (cmd?.trim()) { inner(cmd, "nodemon --exec"); out.push(seg); return seg; }
    }
    if (exe === "entr" && /^-[acdnprz]*s/.test(seg.argv.find((a) => a.startsWith("-")) ?? "")) {
      const cmd = seg.argv.slice(1).find((a) => !a.startsWith("-"));
      if (cmd?.trim()) { inner(cmd, "entr -s"); return null; }
    }
    if (exe === "gdb" || exe === "lldb") {
      if (seg.argv.some((a) => /^(?:-ex|--eval-command|-x|--command|-o|--one-line|-s|--source|-batch|--batch)(?:=|$)/.test(a))) return unread(`${exe} runs debugger commands, which can start programs`);
      const ai = seg.argv.findIndex((a) => a === "--args" || a === "--");
      if (ai > 0 && ai + 1 < seg.argv.length) { seg.via = [...seg.via, exe]; setArgv(ai + 1); continue; }
    }
    if (exe === "perf" && /^(?:record|stat|trace)$/.test(seg.argv[1] ?? "")) {
      const di = seg.argv.indexOf("--");
      if (di > 0 && di + 1 < seg.argv.length) { seg.via = [...seg.via, "perf"]; setArgv(di + 1); continue; }
      if (seg.argv.slice(2).some((a) => !a.startsWith("-"))) return unread("perf runs a command its options leave unclear");
    }
    if (COMMAND_STRING_TOOLS.has(exe)) {
      for (const a of rest) if (!a.startsWith("-") && /\s/.test(a)) inner(a, exe);
      out.push(seg);
      return seg;
    }
    if (TERMINALS.has(exe)) {
      const ei = seg.argv.findIndex((a, k) => k > 0 && (a === "-e" || a === "-x" || a === "--command" || a === "--execute" || a === "--"));
      const cmd = ei > 0 ? seg.argv.slice(ei + 1) : [];
      if (cmd.length === 1 && /\s/.test(cmd[0] ?? "")) { inner(cmd[0] ?? "", exe); return null; }
      if (cmd.length) { seg.via = [...seg.via, exe]; setArgv(ei + 1); continue; }
      if ((exe === "kitty" || exe === "foot" || exe === "ghostty" || exe === "wezterm") && rest.some((a) => !a.startsWith("-"))) return unread(`${exe}: the command it starts is not read`);
      out.push(seg);
      return seg;
    }
    {
      const subKey = `${exe} ${seg.argv[1] ?? ""}`;
      const key = Object.hasOwn(WRAPPERS, subKey) ? subKey : Object.hasOwn(WRAPPERS, exe) ? exe : null;
      const spec = key === null ? undefined : WRAPPERS[key];
      if (key !== null && spec) {
        const at = wrapperStart(seg.argv, spec.sub ? 2 : 1, spec);
        if (at === null) {
          // A wrapper given no command at all (`uv run --help`, `mise exec`) is classified as itself.
          if (!seg.argv.slice(spec.sub ? 2 : 1).some((a) => !a.startsWith("-"))) { out.push(seg); return seg; }
          return unread(`${key}: options this parser does not know`);
        }
        if (at < seg.argv.length) {
          if (spec.priv) seg.sudo = { nonInteractive: seg.sudo?.nonInteractive ?? false, user: undefined };
          seg.via = [...seg.via, key];
          setArgv(at);
          continue;
        }
      }
    }
    if (SHELLS.has(exe) || exe === "pwsh" || exe === "powershell") {
      const ps = exe === "pwsh" || exe === "powershell";
      const ci = seg.argv.findIndex((a, k) => k > 0 && (ps ? /^-(?:c|command)$/i.test(a) : /^-[A-Za-z]*c[A-Za-z]*$/.test(a)));
      if (exe === "busybox" && seg.argv[1] && !SHELLS.has(seg.argv[1])) { setArgv(1); continue; }
      const inline = seg.argv[ci + 1];
      if (ci >= 0 && inline !== undefined) {
        const script = ps ? seg.argv.slice(ci + 1).join(" ") : inline;
        parseInto(script, { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, `${exe} -c`], depth: seg.depth + 1, assigns: seg.assigns }, out, opaque);
        return null;
      }
      const scriptArg = seg.argv.slice(1).find((a) => !a.startsWith("-"));
      // `bash /dev/stdin <<<…` reads its script from standard input, like `bash -s`.
      const script = scriptArg !== undefined && STDIN_PATH.test(scriptArg) ? undefined : scriptArg;
      if (!script && seg.stdinBody !== undefined) {
        parseInto(seg.stdinBody, { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, `${exe} <<`], depth: seg.depth + 1, assigns: seg.assigns }, out, opaque);
        return null;
      }
      if (!script && !seg.pipeIn) seg.interactiveShell = true;
    }
    if (exe === "find") {
      out.push(seg);
      extractFindExec(seg, env, out, opaque);
      return seg;
    }
    if (exe === "tmux" || exe === "screen") {
      out.push(seg);
      extractTmux(seg, env, out, opaque);
      return seg;
    }
    out.push(seg);
    return seg;
  }
  out.push(seg);
  return seg;
}

function extractFindExec(seg: Segment, env: ParseEnv, out: Segment[], opaque: string[]): void {
  const argv = seg.argv;
  const roots: string[] = [];
  let k = 1;
  for (let a = argv[k]; a !== undefined && !/^[-(!]/.test(a); a = argv[++k]) roots.push(a);
  const filtered = argv.some((a) => /^-(?:i?name|i?path|i?regex|type|newer|mtime|mmin|size|user|perm|empty)$/.test(a));
  for (let i = k; i < argv.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(argv[i] ?? "")) continue;
    let j = i + 1;
    const cmd: string[] = [];
    for (let a = argv[j]; a !== undefined && a !== ";" && a !== "+" && a !== "\\;"; a = argv[++j]) cmd.push(a);
    i = j;
    if (!cmd.length) continue;
    const root = roots[0] ?? ".";
    const sub: Segment = {
      ...seg,
      argv: cmd.map((a) => (a === "{}" ? root : a.replace(/\{\}/g, root))),
      words: [],
      redirects: [],
      via: [...seg.via, "find -exec"],
      filtered,
      unknownArgs: false,
      pipeIn: false,
      pipeOut: false,
      prev: undefined,
      next: undefined,
    };
    sub.words = sub.argv.map((t) => ({ text: t, raw: t, dynamic: false, quoted: false, ansiC: false, fragmented: false, subs: [], procSub: false }));
    const before = out.length;
    unwrap(sub, env, out, opaque);
    for (const produced of out.slice(before)) produced.filtered = filtered;
  }
}

function extractTmux(seg: Segment, env: ParseEnv, out: Segment[], opaque: string[]): void {
  const argv = seg.argv;
  const sub = argv[1];
  const inner = (script: string) =>
    parseInto(script, { ...env, cwd: null, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, "tmux"], depth: seg.depth + 1 }, out, opaque);
  if (sub === "send-keys" || sub === "send") {
    const keys: string[] = [];
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i];
      if (a === undefined) break;
      if (a === "-t" || a === "-N") { i++; continue; }
      if (/^-[lRMHKX]+$/.test(a)) continue;
      if (/^(?:Enter|C-m|KPEnter|C-c|C-d|Escape|Tab|Space|BSpace|Up|Down|Left|Right|q)$/.test(a)) { keys.push("\n"); continue; }
      keys.push(a);
    }
    const script = keys.join(" ").replace(/ ?\n ?/g, "\n");
    if (script.trim()) inner(script);
    return;
  }
  if (sub === "new-session" || sub === "new" || sub === "new-window" || sub === "neww" || sub === "split-window" || sub === "splitw" || sub === "respawn-pane" || sub === "run-shell" || sub === "run") {
    let i = 2;
    const withArg = new Set(["-t", "-s", "-n", "-c", "-x", "-y", "-e", "-F", "-l", "-p", "-f", "-w"]);
    for (let a = argv[i]; a?.startsWith("-"); a = argv[i]) i += withArg.has(a) ? 2 : 1;
    if (i < argv.length) inner(argv.slice(i).join(" "));
  }
}

// Fork bombs are recognised structurally on the raw text: a function that pipes itself into
// itself in the background.
export function isForkBomb(src: string): boolean {
  const m = /([A-Za-z_:.][\w:.]*)\s*\(\s*\)\s*\{([^}]*)\}/g;
  for (const [, fn = "", body = ""] of src.matchAll(m)) {
    const name = fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[\\s;&|])${name}\\s*\\|\\s*&?\\s*${name}\\b[^;]*&`).test(body)) return true;
    if (new RegExp(`(?:^|[\\s;&|])${name}\\s*\\|\\s*${name}\\s*&`).test(body)) return true;
  }
  return /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(src);
}

export function decoderLike(text: string): boolean {
  return DECODER_RE.test(text);
}
