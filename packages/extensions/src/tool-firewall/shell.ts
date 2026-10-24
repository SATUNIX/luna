// A conservative shell parser for the tool firewall.
//
// It turns a command string into the simple commands that would actually run ("segments"),
// looking through wrappers (`bash -c '…'`, `ssh host '…'`, `sudo`, `env`, `timeout`, `xargs`,
// `find -exec`, `eval`, `$( … )`, heredocs fed to a shell) so a classifier sees the real
// executable, its arguments, where it runs (locally, remotely, privileged) and in which
// directory. It is not a full shell: anything it cannot follow is reported in `opaque`, and
// callers treat opaque input as needing a closer look rather than as safe.

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

function scanBrace(src: string, i: number): number {
  // i points after "${"
  let depth = 1;
  let j = i;
  while (j < src.length && depth > 0) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") depth--;
    j++;
  }
  return j;
}

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
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op && (op !== "(" || !cur) && !(op === "&" && src[i + 1] === ">")) {
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
        if (d === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
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
      const e = src.indexOf("))", i + 3);
      const end = e < 0 ? n : e + 2;
      w.text += src.slice(i, end); w.raw += src.slice(i, end); w.dynamic = true;
      i = end;
      continue;
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
      const end = scanBrace(src, i + 2);
      w.text += src.slice(i, end); w.raw += src.slice(i, end); w.dynamic = true;
      i = end;
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
  parseInto(src, env, segments, opaque);
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
          raw.words = [];
          t++;
          continue;
        }
        if (raw.words.length) finish(";");
        cwdStack.push(cwd);
        continue;
      }
      if (tok.v === ")") {
        if (caseMode > 0 && raw.words.length) { raw = { ...raw, words: [], redirects: [] }; continue; }
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
  while (words.length) {
    const w = words[0];
    if (w === undefined) break;
    if (!w.quoted && RESERVED_SKIP.has(w.text)) { words.shift(); continue; }
    if (!w.quoted && RESERVED_END.has(w.text)) { words.shift(); continue; }
    if (ASSIGN_RE.test(w.raw)) { assigns.push(w.text); words.shift(); continue; }
    break;
  }
  const lead = words[0];
  if (lead && !lead.quoted && ["for", "select", "case", "in", "function"].includes(lead.text)) {
    if (lead.text === "function") words.splice(0, 2);
    else words.length = 0;
  }
  const head = words[0];
  if (head && !head.quoted && (head.text === "[[" || head.text === "[" || head.text === "((")) {
    // Tests only read.
    words.splice(0, words.length, { ...head, text: "test" });
  }
  const seg: Segment = {
    argv: words.map((w) => w.text),
    words,
    redirects: r.redirects,
    assigns,
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
  if (!seg.argv.length) {
    if (!assigns.length && !r.redirects.length) return null;
    seg.argv = [];
    out.push(seg);
    return seg;
  }
  return unwrap(seg, env, out, opaque);
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
              parseInto(seg.argv.slice(i + 1).join(" "), { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, "env -S"], depth: seg.depth + 1 }, out, opaque);
              return null;
            }
            i += 2;
            continue;
          }
          if (a.startsWith("-")) { i++; continue; }
          if (ASSIGN_RE.test(a)) { seg.assigns.push(a); i++; continue; }
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
          parseInto(command, { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, "flock"], depth: seg.depth + 1 }, out, opaque);
          return null;
        }
        if (i + 1 >= seg.argv.length) break;
        setArgv(i + 1);
        continue;
      }
      case "watch": {
        const i = takeOptions(seg.argv, 1, new Set(["n", "d", "g"]), new Set(["--interval", "--differences"]));
        if (i >= seg.argv.length) break;
        parseInto(seg.argv.slice(i).join(" "), { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, "watch"], depth: seg.depth + 1 }, out, opaque);
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
    if (SHELLS.has(exe) || exe === "pwsh" || exe === "powershell") {
      const ps = exe === "pwsh" || exe === "powershell";
      const ci = seg.argv.findIndex((a, k) => k > 0 && (ps ? /^-(?:c|command)$/i.test(a) : /^-[A-Za-z]*c[A-Za-z]*$/.test(a)));
      if (exe === "busybox" && seg.argv[1] && !SHELLS.has(seg.argv[1])) { setArgv(1); continue; }
      const inline = seg.argv[ci + 1];
      if (ci >= 0 && inline !== undefined) {
        const script = ps ? seg.argv.slice(ci + 1).join(" ") : inline;
        parseInto(script, { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, `${exe} -c`], depth: seg.depth + 1 }, out, opaque);
        return null;
      }
      const script = seg.argv.slice(1).find((a) => !a.startsWith("-"));
      if (!script && seg.stdinBody !== undefined) {
        parseInto(seg.stdinBody, { ...env, cwd: seg.cwd, remote: seg.remote, sudo: seg.sudo, via: [...seg.via, `${exe} <<`], depth: seg.depth + 1 }, out, opaque);
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
