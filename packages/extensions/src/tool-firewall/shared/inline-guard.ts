// GENERATED from packages/core/shared/inline-guard.ts by packages/core/gen-shared.ts. Do not edit this copy:
// change the source and run `npm run gen:shared` (`npm run verify` fails when a copy differs).
/**
 * A coarse, fail-closed rule for inline interpreter code that may write agent configuration.
 *
 * The firewall and protected-paths each look for the literal path an inline program writes. A program
 * can also build that path at runtime, so this rule does not try to find it: when a command runs an
 * interpreter on inline code (any option, a heredoc, piped or redirected input, or no script file at
 * all), the command text mentions an agent-configuration segment, and the code has any write- or
 * exec-capable call, the command is treated as a write to agent configuration. It is deliberately
 * broad: inline code that merely mentions agent configuration next to such a call is caught too.
 * It cannot see a path that is computed entirely at runtime with no distinctive segment or tail in the
 * text, an interpreter or wrapper not listed below, or code in a script file.
 *
 * The parser is a coarse tokenizer, and shell syntax it does not model has bypassed it before (no-space
 * redirects, reserved words, globbed command words). A parse-free backstop therefore also fires on the
 * raw command line: when it mentions an agent-configuration segment, has a write- or exec-capable word
 * and names a listed interpreter, shell or wrapper anywhere as a word, the command is treated the same
 * way. It over-blocks any one command line that combines all three, a commit message included; that is
 * intended fail-closed behaviour.
 *
 * Canonical source: packages/core/shared/inline-guard.ts. tool-firewall and protected-paths hold
 * generated, byte-checked copies (`npm run gen:shared`; `npm run verify` fails on drift).
 *
 * This file also holds the shared reading of patch writers (`git apply`, `git am`, `patch`): the files they
 * change are named inside the patch, so both hooks read the patch headers and check each target as a direct
 * write. A patch that cannot be read or parsed is treated as touching a protected path.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Interpreter basenames whose inline code this rule inspects: Python, PyPy, Node and its TypeScript and
 * loader aliases (tsx, ts-node, esno, esr, vite-node, babel-node, sucrase-node, jiti, iojs), Deno, Bun,
 * Perl, Ruby, PHP, Lua, awk, osascript, pwsh, Tcl, R, Julia, Groovy, jshell, Swift, Kotlin, Scala,
 * Elixir, Erlang, Racket, Guile and SBCL, with any version suffix.
 */
const INTERPRETER = /^(?:python[\w.-]*|pypy[\w.-]*|node[\w.-]*|nodejs|iojs|tsx|ts-node[\w-]*|esno|esr|vite-node|babel-node|sucrase-node|jiti|deno|bun|perl[\w.-]*|ruby[\w.-]*|php[\w.-]*|lua[\w.-]*|luajit|[a-z]*awk|osascript|pwsh|powershell|tclsh[\w.-]*|r|rscript|julia[\w.-]*|groovy|jshell|swift|kotlinc?|scala|elixir|iex|erl|escript|racket|guile[\w.-]*|sbcl)$/i;
/** Shells whose `-c` argument (or piped, heredoc or redirected input) is a nested command line. */
const SHELL = /^(?:sh|bash|zsh|dash|ksh|mksh|pdksh|fish|ash|yash)$/;
/** deno and bun take a subcommand; these run code from the command line or stdin. */
const RUNTIME_INLINE = /^(?:eval|repl|-|-e|-p|--eval|--print|--eval=.*|--print=.*)$/;

/**
 * Leading words that run a later word as the command. `valued` lists the options whose value is a
 * separate word; `positional` counts operands before the target (timeout's duration); `sub` names the
 * subcommands that make a package runner a wrapper (`pnpm exec`); `cmd` lists the options whose value
 * is itself a command line (`env -S`, `npx -c`).
 */
interface Wrapper {
  valued?: readonly string[];
  positional?: number;
  sub?: readonly string[];
  cmd?: readonly string[];
}
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  env: { valued: ["-u", "--unset", "-C", "--chdir", "-P"], cmd: ["-S", "--split-string"] },
  sudo: { valued: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout", "-R", "--chroot"] },
  doas: { valued: ["-u", "-C"] },
  nice: { valued: ["-n", "--adjustment"] },
  nohup: {},
  timeout: { valued: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  stdbuf: { valued: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  xargs: { valued: ["-I", "-d", "--delimiter", "-E", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "-a", "--arg-file", "--process-slot-var"] },
  command: {},
  builtin: {},
  exec: { valued: ["-a"] },
  time: { valued: ["-f", "--format", "-o", "--output"] },
  ionice: { valued: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"] },
  chrt: { positional: 1 },
  setsid: {},
  taskset: { positional: 1 },
  busybox: {},
  npx: { valued: ["-p", "--package", "--cache", "--userconfig", "-w", "--workspace"], cmd: ["-c", "--call"] },
  bunx: { valued: ["-p", "--package"] },
  uvx: { valued: ["--from", "--with", "--with-requirements", "--with-editable", "-p", "--python", "--index", "--index-url", "--extra-index-url", "--directory", "--project"] },
  pnpm: { valued: ["--filter", "-F", "-C", "--dir", "--package", "-w", "--workspace"], sub: ["exec", "dlx"], cmd: ["-c", "--shell-mode"] },
  yarn: { valued: ["-p", "--package", "--cwd"], sub: ["dlx", "exec"] },
  npm: { valued: ["-p", "--package", "-w", "--workspace", "--prefix"], sub: ["exec", "x"], cmd: ["-c", "--call"] },
  pipx: { valued: ["--spec", "--python", "--pip-args", "--index-url"], sub: ["run"] },
  uv: { valued: ["--from", "--with", "--with-requirements", "-p", "--python", "--directory", "--project", "--package", "--index", "--index-url"], sub: ["run", "tool"] },
  bun: { sub: ["x"] },
};
/** awk-family interpreters take their program as the first operand unless -f names a file. */
const AWK = /awk$/i;

/**
 * Splits a command line into simple commands: on ; & | newlines and, unless `subst` is false,
 * substitution brackets, outside quotes.
 */
function simpleCommands(command: string, subst = true): { text: string; piped: boolean }[] {
  const out: { text: string; piped: boolean }[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let piped = false;
  const push = (nextPiped: boolean): void => {
    if (cur.trim()) out.push({ text: cur, piped });
    cur = "";
    piped = nextPiped;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        cur += ch + command.charAt(++i);
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += ch + command.charAt(++i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "|") {
      const orOp = command[i + 1] === "|";
      // `|&` pipes stdout and stderr: a pipe like `|`.
      if (orOp || command[i + 1] === "&") i++;
      push(!orOp);
      continue;
    }
    // `&` inside a redirect operator (`2>&1`, `<&3`, `&>file`) does not end the command.
    if (ch === "&" && (/[<>]/.test(command[i - 1] ?? "") || command[i + 1] === ">")) {
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "&" || (subst && (ch === "(" || ch === ")" || ch === "`"))) {
      push(false);
      continue;
    }
    cur += ch;
  }
  push(false);
  return out;
}

/** A shell word with quotes removed (`w`) and its unquoted leading characters (`lead`). */
interface Word {
  w: string;
  lead: string;
}

/** Shell words of one simple command, with quotes removed (a coarse tokenizer: no expansion). */
function tokens(text: string): Word[] {
  const out: Word[] = [];
  let cur = "";
  let lead = "";
  let leading = true;
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) cur += text.charAt(++i);
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      leading = false;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      cur += text.charAt(++i);
      has = true;
      leading = false;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push({ w: cur, lead });
      cur = "";
      lead = "";
      leading = true;
      has = false;
      continue;
    }
    // An unquoted `<` or `>` starts a redirect word (`python3<<<'…'`, `bash<file`) unless the word so far is
    // its file-descriptor prefix or the operator itself (`2>&1`, `{fd}>`, `<<`, `&>`).
    if ((ch === "<" || ch === ">") && (has || cur) && !(leading && /^(?:\d+|\{[A-Za-z_]\w*\})?[<>&]*$/.test(cur))) {
      if (leading && cur.endsWith("&") && cur.length > 1) {
        // `cmd&>file`: the `&` belongs to the redirect.
        out.push({ w: cur.slice(0, -1), lead: lead.slice(0, -1) });
        cur = "&";
        lead = "&";
      } else {
        out.push({ w: cur, lead });
        cur = "";
        lead = "";
      }
      leading = true;
      has = false;
    }
    cur += ch;
    if (leading) lead += ch;
  }
  if (has || cur) out.push({ w: cur, lead });
  return out;
}

/**
 * An unquoted redirect operator at the start of a word, with an optional file-descriptor prefix:
 * `<`, `<<WORD`, `<<-WORD`, `<<<word`, `<>`, `<&`, `>`, `>>`, `>&`, `>|`, `&>`, `&>>`.
 */
const REDIRECT = /^(?:(?:\d+|\{[A-Za-z_]\w*\})?(<<<|<<-?|<>|<&|<|>>|>&|>\||>)|(&>>?))/;

interface Redirect {
  op: string;
  target: string | undefined;
}

/** Separates redirect words (and the target word that follows a bare operator) from the command's words. */
function splitRedirects(toks: Word[]): { argv: string[]; redirects: Redirect[] } {
  const argv: string[] = [];
  const redirects: Redirect[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === undefined) continue;
    const m = REDIRECT.exec(t.lead);
    if (!m) {
      argv.push(t.w);
      continue;
    }
    const op = m[1] ?? m[2] ?? "";
    const rest = t.w.slice(m[0].length);
    let target: string | undefined = rest;
    if (rest === "" && t.lead === t.w) target = toks[++k]?.w;
    redirects.push({ op, target });
  }
  return { argv, redirects };
}

/** Shell words of one simple command with redirects removed. */
function words(text: string): string[] {
  return splitRedirects(tokens(text)).argv;
}

function basename(word: string): string {
  // A package runner's target may carry a version (`tsx@4`); the executable is the name before it.
  return (word.replace(/\\/g, "/").split("/").pop() ?? word).replace(/(?<=.)@[^@]*$/, "");
}

/** An executable word that is not a literal name (a variable, a substitution, a glob) cannot be resolved. */
const UNRESOLVED = /[$`*?[{]/;
/**
 * Reserved words and grouping that may precede a command word (`{ python3 …; }`, `! python3 …`,
 * `if :; then python3 …`). `time` is a wrapper (it takes options), so it is handled there.
 */
const RESERVED = new Set(["{", "}", "!", "if", "then", "do", "else", "elif", "while", "until", "coproc"]);

/** The index of the first word after leading reserved words (and a `coproc NAME {` or `function NAME {` name). */
function skipReserved(argv: string[], from: number): number {
  let i = from;
  for (;;) {
    const w = argv[i] ?? "";
    if (RESERVED.has(w)) {
      if (w === "coproc" && /^[A-Za-z_]\w*$/.test(argv[i + 1] ?? "") && argv[i + 2] === "{") i += 2;
      i++;
      continue;
    }
    if (w === "function" && argv[i + 1] !== undefined) {
      i += 2;
      continue;
    }
    return i;
  }
}
/** A command word built by a variable or a substitution (`$PY`, `${PY}`, `$(…)`, backticks) cannot be resolved. */
const EXPANDED = /[$`]/;

/**
 * Resolves the executable after leading assignments and wrappers. Returns its index, `-1` when a
 * wrapper's target cannot be resolved (fail closed), and calls `nested` for an option whose value is a
 * command line.
 */
function resolveExecutable(argv: string[], nested: (commandLine: string) => boolean): number {
  let i = 0;
  while (argv[i] !== undefined) {
    i = skipReserved(argv, i);
    const w = argv[i];
    if (w === undefined) break;
    if (/^[A-Za-z_]\w*=/.test(w)) {
      i++;
      continue;
    }
    // Fail closed: a command word that is a variable or a substitution may run any interpreter.
    if (EXPANDED.test(w)) return -1;
    const spec = WRAPPERS[basename(w)];
    if (spec === undefined) {
      // Fail closed: a globbed command word (`pytho?`, `python[3]`) may name any interpreter. `[` and `[[`
      // are the test commands.
      if (w !== "[" && w !== "[[" && UNRESOLVED.test(w)) return -1;
      return i;
    }
    let j = i + 1;
    if (spec.sub) {
      // A package runner is a wrapper only with a running subcommand (`pnpm exec`, `pipx run`).
      while (argv[j] !== undefined && /^-/.test(argv[j] ?? "")) j += spec.valued?.includes(argv[j] ?? "") ? 2 : 1;
      if (!spec.sub.includes(argv[j] ?? "")) return i;
      j++;
      if (basename(w) === "uv" && argv[j - 1] === "tool") {
        if (argv[j] !== "run") return i;
        j++;
      }
    }
    let positional = spec.positional ?? 0;
    for (let a = argv[j]; a !== undefined; a = argv[j]) {
      if (a === "--") {
        j++;
        break;
      }
      if (/^-/.test(a)) {
        const name = a.replace(/=.*$/, "");
        if (spec.cmd?.includes(name)) {
          const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[j + 1];
          if (value === undefined || nested([value, ...argv.slice(j + 2)].join(" "))) return -1;
          return -2;
        }
        if (/^-[A-Za-z0-9]{2,}$/.test(a)) {
          // A cluster of short options (`-iu root`, `-Eu root`, `-uroot`): the first letter that takes a value
          // takes the rest of the cluster, or the next word when it ends the cluster.
          const letters = a.slice(1);
          let step = 1;
          for (let p = 0; p < letters.length; p++) {
            const opt = `-${letters.charAt(p)}`;
            const rest = letters.slice(p + 1);
            if (spec.cmd?.includes(opt)) {
              const value = rest !== "" ? rest : argv[j + 1];
              if (value === undefined || nested([value, ...argv.slice(rest !== "" ? j + 1 : j + 2)].join(" "))) return -1;
              return -2;
            }
            if (spec.valued?.includes(opt)) {
              step = rest === "" ? 2 : 1;
              break;
            }
          }
          j += step;
          continue;
        }
        j += !a.includes("=") && spec.valued?.includes(a) ? 2 : 1;
        continue;
      }
      if (/^[A-Za-z_]\w*=/.test(a) && basename(w) === "env") {
        j++;
        continue;
      }
      if (positional > 0) {
        positional--;
        j++;
        continue;
      }
      break;
    }
    // Fail closed: a wrapper with no literal target may run anything that follows.
    if (argv[j] === undefined || UNRESOLVED.test(argv[j] ?? "")) return -1;
    i = j;
  }
  return i;
}

/** True when this simple command (or a nested shell command line inside it) runs an interpreter on inline code. */
function inlineIn(text: string, piped: boolean, depth: number): boolean {
  const { argv, redirects } = splitRedirects(tokens(text));
  const nested = (commandLine: string): boolean => depth >= 4 || isInlineInterpreterCallAt(commandLine, depth + 1);
  const i = resolveExecutable(argv, nested);
  if (i === -1) return true;
  if (i === -2) return false;
  const exe = argv[i];
  if (exe === undefined) return false;
  const name = basename(exe);
  const args = argv.slice(i + 1);
  const stdin = piped || redirects.some((r) => r.op.includes("<")) || /<</.test(text) || /(?:^|\s)\d?<(?!\()/.test(text);
  // The eval builtin runs its operands as a command line.
  if (name === "eval") return args.length > 0 && nested(args.join(" "));
  if (SHELL.test(name)) {
    // A here-string fed to a shell is a command line, read like `-c`.
    if (redirects.some((r) => r.op === "<<<" && r.target !== undefined && nested(r.target))) return true;
    const at = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a) || a === "--command");
    if (at >= 0) {
      const inner = args[at + 1];
      return inner !== undefined && nested(inner);
    }
    const long = args.find((a) => a.startsWith("--command="));
    if (long !== undefined) return nested(long.slice("--command=".length));
    // A shell with no script operand reading from a pipe, heredoc, here-string or any redirect: fail closed.
    return (stdin || redirects.length > 0) && shellScript(args) === undefined;
  }
  if (!INTERPRETER.test(name)) return false;
  // Input from a pipe, a heredoc or here-string, or a redirect is inline code.
  if (stdin) return true;
  if (AWK.test(name)) return !args.some((a) => a.startsWith("-f") || a.startsWith("--file"));
  if (/^(?:deno|bun)$/i.test(name)) {
    // `deno eval`, `deno run -`, `bun -e`, `bun eval`: a subcommand followed by inline code or stdin.
    if (args.some((a) => RUNTIME_INLINE.test(a))) return true;
    const sub = args[0];
    if (sub !== undefined && !sub.startsWith("-")) {
      // A script, or a subcommand with a file operand, runs a file; a run-like subcommand with no file
      // operand may read inline code.
      return /^(?:run|x|exec)$/.test(sub) && !args.slice(1).some((a) => !a.startsWith("-"));
    }
  }
  // Fail closed: any option, or no script file operand, means the code may be inline.
  const first = args.find((a) => !a.startsWith("-"));
  if (first === undefined) return true;
  return args.indexOf(first) > 0 && args.slice(0, args.indexOf(first)).some((a) => a.startsWith("-"));
}

/** Shell options whose value is a separate word (`bash -o pipefail`, `bash --rcfile f`). */
const SHELL_VALUED = /^(?:[-+][A-Za-z]*[oO]|--rcfile|--init-file)$/;

/** The script operand of a shell, or undefined when it reads its commands from stdin (`-s`, or no operand). */
function shellScript(args: string[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a === "--") return args[k + 1];
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(a)) return undefined;
    if (/^[-+]/.test(a)) {
      if (SHELL_VALUED.test(a)) k++;
      continue;
    }
    return a;
  }
  return undefined;
}

/** True when a simple command's first word (after assignments and redirects) is a variable or substitution. */
function expandedCommandWord(text: string): boolean {
  const argv = words(text);
  const first = argv.slice(skipReserved(argv, 0)).find((w) => !/^[A-Za-z_]\w*=/.test(w));
  return first !== undefined && EXPANDED.test(first);
}

function isInlineInterpreterCallAt(command: string, depth: number): boolean {
  // The second pass keeps substitutions whole, so a backtick command word (`` `which python3` -c … ``) is seen.
  return simpleCommands(command).some((c) => inlineIn(c.text, c.piped, depth)) ||
    simpleCommands(command, false).some((c) => expandedCommandWord(c.text));
}

/** True when the command (or a nested shell `-c` or `eval` command line) runs an interpreter on inline code. */
export function isInlineInterpreterCall(command: string): boolean {
  return isInlineInterpreterCallAt(command, 0);
}

/** Agent-configuration words that, next to `.pi`, mark a control surface. */
const NEAR_PI = ["agent", "settings", "extensions", "auth", "remote-control", "devices", "audit", "mcp-adapter", ".pi-kit", "console"];

/** The text with quotes, whitespace and string-concatenation operators between literals removed, lowercased. */
function squash(text: string): string {
  return text
    .toLowerCase()
    // A concatenation operator between two literals: 'a' + 'b', "a" . "b", "a" .. "b", 'a', 'b'.
    .replace(/(['"`])\s*(?:\+|\.\.?|,)\s*(['"`])/g, "")
    .replace(/['"`\s]/g, "")
    .replace(/[+,]/g, "");
}

/**
 * Distinctive tails of agent-configuration paths, compared with path separators removed so a joined
 * spelling (`os.path.join(d, "agent", "settings.json")`) matches too. They count without `.pi`.
 */
const TAILS = ["agent/settings.json", "agent/extensions", "remote-control/devices.json", "remote-control/audit.jsonl", "mcp-adapter.json", "pi-kit.json", "auth.json"]
  .map((t) => t.replace(/\//g, ""));

/**
 * True when the text names an agent-configuration segment in literals split by quotes, whitespace,
 * concatenation operators or path separators.
 */
export function mentionsProtectedSegment(text: string): boolean {
  if (/pi_coding_agent_dir/i.test(text)) return true;
  const s = squash(text);
  if (s.includes(".pi-kit") || s.includes("mcp-adapter")) return true;
  const joined = s.replace(/[/\\]/g, "");
  if (TAILS.some((t) => joined.includes(t))) return true;
  return s.includes(".pi") && NEAR_PI.some((w) => s.includes(w));
}

/**
 * Write- or exec-capable calls, matched as words (`write` anywhere in an identifier, so
 * `createWriteStream` and `writeFileSync` count; any `link`, `rmdir`, `rmtree`, `mkfifo`, `mknod`,
 * `utime`, `setxattr`, `cpSync`, FileUtils). `open` counts with a write, append or exclusive mode
 * anywhere in the text (a mode literal, an O_ flag, or a Perl/shell redirect mode), so reading a file
 * with `open(path)` stays a read; pathlib counts through its mutating methods (write_text, touch, …).
 */
const CAPABILITY = /\b(?:\w*write\w*|\w*append\w*|copy\w*|cp(?:Sync)?|\w*move\w*|rename\w*|remove\w*|rm(?:Sync|dir\w*|tree)?|\w*link\w*|\w*delete\w*|touch|utimes?\w*|chmod\w*|chown\w*|truncate\w*|mkfifo\w*|mknod\w*|\w*setxattr\w*|system|exec\w*|spawn\w*|popen\w*|subprocess|child_process|file_put_contents|fputs|fwrite|shutil|fileutils|file::copy|replace|mkdirs?\w*|makedirs|mkpath|io\.open)\b|\b(?:deno|bun|fs)\.|`|\bprint\b[^;\n]*>/i;
const OPEN = /\b(?:f?open\w*)\b/i;
const WRITE_MODE = /(['"])[rbt]*[wax+][rbt+]*\1|\bO_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)\b|(['"])\s*(?:\+?[<>]{1,2}|\|)/;

/** True when the text holds any write- or exec-capable call. */
export function hasWriteOrExecCapability(text: string): boolean {
  return CAPABILITY.test(text) || (OPEN.test(text) && WRITE_MODE.test(text));
}

/** True when a word is a listed interpreter, shell or wrapper name, or `eval`. */
function isListedName(word: string): boolean {
  return INTERPRETER.test(word) || SHELL.test(word) || Object.hasOwn(WRAPPERS, word) || word === "eval";
}

/**
 * True when the text holds a listed name as a whole word: a run of word characters, dots and hyphens
 * (trailing ones dropped), so a name next to any shell metacharacter or path separator counts
 * (`python3<<<`, `{python3`, `|&bash`, `"sh"`, `/usr/bin/python3`) but an option (`-r`), a file name
 * (`x.sh`) or a longer word (`cpython`) does not.
 */
function namesListedWord(text: string): boolean {
  for (const m of text.matchAll(/[\w.-]+/g)) {
    const word = m[0].replace(/[.-]+$/, "");
    if (word !== "" && !word.startsWith("-") && isListedName(word)) return true;
  }
  return false;
}

/** Concrete spellings a globbed word (`pytho?`, `py*3`, `python[3]`) is matched against. */
const SAMPLE_NAMES = [
  "python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "iojs", "tsx", "ts-node", "esno", "esr", "vite-node",
  "babel-node", "sucrase-node", "jiti", "deno", "bun", "perl", "perl5", "ruby", "php", "lua", "luajit", "awk", "gawk",
  "mawk", "nawk", "osascript", "pwsh", "powershell", "tclsh", "r", "rscript", "julia", "groovy", "jshell", "swift",
  "kotlin", "kotlinc", "scala", "elixir", "iex", "erl", "escript", "racket", "guile", "sbcl", "sh", "bash", "zsh", "dash",
  "ksh", "mksh", "pdksh", "fish", "ash", "yash", "eval", ...Object.keys(WRAPPERS),
];

/**
 * True when the shell glob (`?`, `*`, `[…]`, `[!…]`, `[a-z]`) matches the whole name, ignoring case.
 * `failed` remembers positions already tried after a `*`, so the work is bounded by glob × name length.
 */
function globMatches(glob: string, name: string, g = 0, n = 0, failed = new Set<number>()): boolean {
  while (g < glob.length) {
    const ch = glob.charAt(g);
    if (ch === "*") {
      for (let k = n; k <= name.length; k++) {
        const key = (g + 1) * (name.length + 1) + k;
        if (failed.has(key)) continue;
        if (globMatches(glob, name, g + 1, k, failed)) return true;
        failed.add(key);
      }
      return false;
    }
    if (n >= name.length) return false;
    const c = name.charAt(n).toLowerCase();
    if (ch === "?") {
      g++;
      n++;
      continue;
    }
    const end = ch === "[" ? glob.indexOf("]", g + 2) : -1;
    if (end > 0) {
      let body = glob.slice(g + 1, end).toLowerCase();
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      let hit = false;
      for (let k = 0; k < body.length; k++) {
        const lo = body.charAt(k);
        const hi = body.charAt(k + 1) === "-" && k + 2 < body.length ? body.charAt(k + 2) : lo;
        if (hi !== lo) k += 2;
        if (c >= lo && c <= hi) hit = true;
      }
      if (hit === negate) return false;
      g = end + 1;
      n++;
      continue;
    }
    if (ch.toLowerCase() !== c) return false;
    g++;
    n++;
  }
  return n === name.length;
}

/**
 * True when the raw command text names a listed interpreter, shell or wrapper as a word, read three
 * ways: as written, with glob characters (`[ ] ? *`) removed, and with quotes and backslashes removed
 * (`py''thon3`, `p\\ython3`); or when a globbed word could expand to one of their names.
 */
export function mentionsInterpreterOrShell(command: string): boolean {
  if (namesListedWord(command) || namesListedWord(command.replace(/[[\]?*]/g, "")) || namesListedWord(command.replace(/['"\\]/g, ""))) return true;
  // Plain runs, filtered after the match: a pattern that must contain a glob character backtracks
  // quadratically on a long run without one.
  for (const m of command.matchAll(/[\w./[\]!?*-]+/g)) {
    if (!/[?*[]/.test(m[0])) continue;
    const base = m[0].split("/").pop() ?? "";
    if (/[A-Za-z]/.test(base) && base.length <= 64 && SAMPLE_NAMES.some((n) => globMatches(base, n))) return true;
  }
  return false;
}

/** The reason to block, or null: inline interpreter code that mentions agent configuration and can write or exec. */
export function inlineAgentConfigWrite(raw: string): string | null {
  // The shell deletes a backslash-newline before splitting words, so `pyth\<newline>on3` runs python3.
  const command = raw.replace(/\\\r?\n/g, "");
  if (!mentionsProtectedSegment(command) || !hasWriteOrExecCapability(command)) return null;
  if (isInlineInterpreterCall(command)) {
    return "inline interpreter code that mentions agent configuration and has a write- or exec-capable call (fail closed: the target may be built at runtime)";
  }
  // The parse-free backstop: shell syntax the parser misses cannot hide an interpreter named in the text.
  if (mentionsInterpreterOrShell(command)) {
    return "a command line that names an interpreter, shell or wrapper, mentions agent configuration and has a write- or exec-capable word (fail closed: parse-free backstop)";
  }
  return null;
}

/** The tools whose write targets are named inside a patch. */
export type PatchTool = "git-apply" | "git-am" | "patch";

/** One patch invocation, read from its arguments. */
export interface PatchCall {
  tool: PatchTool;
  /** False for a form with no patch of its own to check: `--check`, `--stat`, `--dry-run`, and a `git am` continuation, whose patches were checked when the `git am` that queued them ran. */
  writes: boolean;
  /** Patch files named on the command line. */
  sources: string[];
  /** True when a patch comes from standard input. */
  stdin: boolean;
  /** Why the command line alone cannot place this call's targets, or null. */
  unresolved: string | null;
  /** `--directory` for git, `-d` for patch. */
  directory: string | null;
  /** Files named on the command line that the tool writes (`patch <file>`, `-o`, `-r`). */
  namedWrites: string[];
}

const GIT_PATCH_VALUED_SHORT = "pC";
const GIT_PATCH_VALUED_LONG = new Set(["--directory", "--exclude", "--include", "--whitespace", "--build-fake-ancestor", "--patch-format", "--resolvemsg"]);
const GIT_APPLY_READ_ONLY = new Set(["--check", "--stat", "--numstat", "--summary"]);
const GIT_AM_CONTROL = new Set(["--continue", "-r", "--resolved", "--skip", "--abort", "--quit", "--show-current-patch", "--retry"]);
const PATCH_VALUED_SHORT = "pidorBDFVYzgx";
const PATCH_VALUED_LONG = new Set(["--strip", "--input", "--directory", "--output", "--reject-file", "--prefix", "--ifdef", "--fuzz", "--version-control", "--basename-prefix", "--suffix", "--get", "--quoting-style", "--reject-format", "--debug"]);
const PATCH_BACKUP_NAMING = new Set(["B", "Y", "z", "--prefix", "--basename-prefix", "--suffix"]);
const GIT_AM_ARCHIVE_FORMATS = new Set(["mbox", "mboxrd", "stgit", "hg"]);
// Every long option of each tool, because git's parse-options and GNU getopt_long accept any unique prefix.
const GIT_APPLY_LONG = ["--exclude", "--include", "--no-add", "--stat", "--no-stat", "--numstat", "--no-numstat", "--summary", "--no-summary", "--check", "--no-check", "--index", "--no-index", "--intent-to-add", "--cached", "--no-cached", "--apply", "--no-apply", "--3way", "--no-3way", "--build-fake-ancestor", "--whitespace", "--ignore-space-change", "--ignore-whitespace", "--reverse", "--no-reverse", "--unidiff-zero", "--no-unidiff-zero", "--reject", "--no-reject", "--allow-overlap", "--no-allow-overlap", "--verbose", "--no-verbose", "--quiet", "--no-quiet", "--inaccurate-eof", "--no-inaccurate-eof", "--recount", "--no-recount", "--directory", "--allow-empty", "--no-allow-empty", "--unsafe-paths", "--no-unsafe-paths"];
const GIT_AM_LONG = ["--interactive", "--binary", "--3way", "--no-3way", "--rerere-autoupdate", "--no-rerere-autoupdate", "--quiet", "--signoff", "--no-signoff", "--utf8", "--no-utf8", "--keep", "--keep-non-patch", "--no-keep", "--message-id", "--no-message-id", "--keep-cr", "--no-keep-cr", "--scissors", "--no-scissors", "--quoted-cr", "--whitespace", "--ignore-space-change", "--ignore-whitespace", "--directory", "--exclude", "--include", "--patch-format", "--reject", "--resolvemsg", "--continue", "--resolved", "--skip", "--abort", "--quit", "--show-current-patch", "--retry", "--allow-empty", "--committer-date-is-author-date", "--ignore-date", "--rebasing", "--gpg-sign", "--no-gpg-sign", "--verify", "--no-verify", "--empty"];
const PATCH_LONG = ["--strip", "--input", "--directory", "--output", "--reject-file", "--prefix", "--ifdef", "--fuzz", "--version-control", "--basename-prefix", "--suffix", "--get", "--quoting-style", "--reject-format", "--dry-run", "--check", "--backup", "--backup-if-mismatch", "--no-backup-if-mismatch", "--batch", "--binary", "--context", "--ed", "--force", "--forward", "--ignore-whitespace", "--merge", "--normal", "--posix", "--quiet", "--silent", "--read-only", "--remove-empty-files", "--reverse", "--set-time", "--set-utc", "--unified", "--verbose", "--version", "--help", "--follow-symlinks", "--debug"];
const GIT_APPLY_UNDO_READ_ONLY = new Set(["--apply", "--no-stat", "--no-numstat", "--no-summary", "--no-check"]);

/** A long option's canonical name: unchanged when exact or unknown, null when the prefix fits several options. */
function canonicalLong(all: readonly string[], name: string): string | null {
  if (name.length <= 2 || all.includes(name)) return name;
  const fits = all.filter((option) => option.startsWith(name));
  if (fits.length > 1) return null;
  return fits[0] ?? name;
}

/** Read one patch command's arguments (everything after `git apply`, `git am` or `patch`). */
export function parsePatchArgs(tool: PatchTool, args: readonly string[]): PatchCall {
  const call: PatchCall = { tool, writes: true, sources: [], stdin: false, unresolved: null, directory: null, namedWrites: [] };
  const valuedShort = tool === "patch" ? PATCH_VALUED_SHORT : GIT_PATCH_VALUED_SHORT;
  const valuedLong = tool === "patch" ? PATCH_VALUED_LONG : GIT_PATCH_VALUED_LONG;
  const operands: string[] = [];
  let readOnly = false;
  let applyAnyway = false;
  let control = false;
  let ambiguous = false;
  let input: string | null = null;
  const longOptions = tool === "patch" ? PATCH_LONG : tool === "git-am" ? GIT_AM_LONG : GIT_APPLY_LONG;
  const take = (flag: string, value: string): void => {
    if (flag === "--directory" || (tool === "patch" && flag === "d")) {
      if (call.directory !== null) call.unresolved = "the patch names more than one directory";
      call.directory = value;
    }
    else if (tool === "patch" && (flag === "i" || flag === "--input")) input = value;
    // A backup written under a chosen prefix or suffix can land on a name no header mentions.
    else if (tool === "patch" && PATCH_BACKUP_NAMING.has(flag)) call.unresolved = "the patch names a backup file pattern";
    // A format the patch cannot be read as here, such as a series file that lists other patches.
    else if (tool === "git-am" && flag === "--patch-format" && !GIT_AM_ARCHIVE_FORMATS.has(value)) call.unresolved = "the patch format cannot be read";
    else if (tool === "patch" && (flag === "o" || flag === "--output" || flag === "r" || flag === "--reject-file")) call.namedWrites.push(value);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") { operands.push(...args.slice(i + 1)); break; }
    if (a === "-" || !a.startsWith("-")) { operands.push(a); continue; }
    // Only the exact spelling marks a form read-only: a guess about an abbreviation must lean towards a write.
    if (tool === "git-am" && GIT_AM_CONTROL.has(a)) { control = true; continue; }
    if (tool === "git-apply" && GIT_APPLY_READ_ONLY.has(a)) { readOnly = true; continue; }
    if (tool === "patch" && a === "--dry-run") { readOnly = true; continue; }
    // Each tool prints and exits during option parsing, without applying anything.
    if (a === "--help" || a === "-h" || (tool === "patch" && (a === "--version" || a === "-v"))) { call.writes = false; return call; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = canonicalLong(longOptions, eq > 0 ? a.slice(0, eq) : a);
      if (name === null) { ambiguous = true; continue; }
      if (tool === "git-apply" && GIT_APPLY_UNDO_READ_ONLY.has(name)) { applyAnyway = true; continue; }
      if (eq > 0) { take(name, a.slice(eq + 1)); continue; }
      if (valuedLong.has(name)) { take(name, args[i + 1] ?? ""); i++; }
      continue;
    }
    // A short-option cluster: `-Np1`, `-ifile`, `-p 2`.
    for (let k = 1; k < a.length; k++) {
      const letter = a.charAt(k);
      // `git am -S[<key>]`: whatever is attached is the key, never more options.
      if (tool === "git-am" && letter === "S") break;
      if (!valuedShort.includes(letter)) continue;
      const attached = a.slice(k + 1);
      if (attached) take(letter, attached);
      else { take(letter, args[i + 1] ?? ""); i++; }
      break;
    }
  }
  // A prefix of several options hides what it set, so nothing read from this command line can be trusted.
  if (ambiguous) call.stdin = true;
  else if (control || (readOnly && !applyAnyway)) {
    // Nothing is written, but the names still say which file this call only reads.
    call.writes = false;
    const named: string | null = input;
    call.sources = [...operands.filter((o) => o !== "-"), ...(named === null ? [] : [named])];
    return call;
  }
  if (tool === "patch") {
    const [original, patchFile] = operands;
    if (original !== undefined) call.namedWrites.push(original);
    const source: string | null | undefined = input ?? patchFile;
    if (source === undefined || source === null || source === "-") call.stdin = true;
    else call.sources.push(source);
    return call;
  }
  for (const operand of operands) {
    if (operand === "-") call.stdin = true;
    else call.sources.push(operand);
  }
  if (!operands.length) call.stdin = true;
  return call;
}

/** Undo git's C-style quoting of a path: `"a/\160olicy"`. */
function unquotePatchPath(name: string): string {
  if (!/^".*"$/.test(name)) return name;
  const bytes: number[] = [];
  const body = name.slice(1, -1);
  const simple = new Map([["a", 7], ["b", 8], ["t", 9], ["n", 10], ["v", 11], ["f", 12], ["r", 13], ["\"", 34], ["\\", 92]]);
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch !== "\\") { bytes.push(...Buffer.from(ch, "utf8")); continue; }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8) & 255); i += octal[0].length; continue; }
    const escaped = simple.get(body.charAt(i + 1));
    if (escaped !== undefined) { bytes.push(escaped); i++; }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The file names a patch's headers mention: `---`, `+++`, `***`, `Index:`, `diff --git`, and rename and copy
 * lines, with GNU patch's tolerance for headers indented by spaces, tabs or `X` and prefixed with `- `. Over-extraction is safe, since each
 * name is only checked against the protected list. Null when the patch is binary, names nothing, or names a
 * path that is still to be expanded by the shell.
 */
export function patchHeaderPaths(text: string): string[] | null {
  if (text.includes("\0") || /^[ \t]*(?:GIT binary patch|Binary files )/m.test(text)) return null;
  const names = new Set<string>();
  const add = (raw: string): void => {
    const name = raw.trim();
    if (!name) return;
    if (name.startsWith("\"")) { names.add(unquotePatchPath(/^"(?:[^"\\]|\\.)*"/.exec(name)?.[0] ?? name)); return; }
    // Text after a tab, or after a space in a header with a timestamp, is not part of the name.
    const toTab = name.split("\t")[0] ?? name;
    names.add(toTab);
    names.add(toTab.split(" ")[0] ?? toTab);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[ \tX]*(?:- )*/, "");
    const header = /^(?:---|\+\+\+|\*\*\*)[ \t]+(.+)$/.exec(line) ?? /^Index:[ \t]+(.+)$/.exec(line) ?? /^(?:rename[ \t]+(?:from|to|old|new)|copy[ \t]+(?:from|to))[ \t]+(.+)$/.exec(line);
    if (header?.[1] !== undefined) {
      // A context-diff hunk range (`--- 1,5 ----`, `*** 1 ****`) is not a name.
      if (!/^\d+(?:,\d+)?[ \t]+[-*]+\s*$/.test(header[1])) add(header[1]);
      continue;
    }
    const git = /^diff --git (.{1,4096})$/.exec(line);
    if (!git?.[1]) continue;
    if (git[1].includes("\"")) {
      for (const token of git[1].match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []) add(token);
      continue;
    }
    // Unquoted names may hold spaces, so every split into two names is a candidate.
    const words = git[1].split(" ");
    for (let i = 1; i < words.length; i++) {
      names.add(words.slice(0, i).join(" "));
      names.add(words.slice(i).join(" "));
    }
  }
  names.delete("/dev/null");
  if (!names.size || [...names].some((n) => /[$`]/.test(n))) return null;
  return [...names];
}

/**
 * Where each header name could land relative to the directory the tool works in. Every strip level is a
 * candidate whatever -p says: the tools disagree on how a leading slash, a rename line or a missing -p counts,
 * and a wrong extra candidate is only checked against the protected list.
 */
export function patchTargets(call: PatchCall, names: readonly string[]): string[] {
  const out = new Set<string>();
  const place = (name: string): void => {
    if (name) out.add(call.directory ? `${call.directory.replace(/\/+$/, "")}/${name}` : name);
  };
  for (const name of names) {
    place(name);
    const segments = name.split("/").filter(Boolean);
    for (let k = 0; k < segments.length; k++) place(segments.slice(k).join("/"));
  }
  return [...out];
}

const PATCH_READ_LIMIT = 8 * 1024 * 1024;

/** A regular patch file's text, or null when it is missing, not a file, too large or binary. */
export function readPatchFile(absolutePath: string): string | null {
  // Check and read through one descriptor, so the file checked is the file read.
  let fd: number | undefined;
  try {
    fd = fs.openSync(absolutePath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > PATCH_READ_LIMIT) return null;
    return fs.readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The piece's own command word, behind the shells and plain wrappers that leave the rest of the line as it is.
// A wrapper's own argument never starts with `-`, so each token has one reading and the match stays linear.
const PATCH_READER = /^[\s'"({]*(?:(?:(?:ba|da|z|k)?sh\s+-[a-z]*c|eval|sudo|env|command|builtin|exec|nohup|time|(?:setsid|fakeroot)(?:\s+-\S+)*|flock(?:\s+-[wE]\s+\S+|\s+-(?![wE]\s)\S+)*\s+(?!-)\S+|(?:taskset|chrt)(?:\s+-\S+)*\s+(?!-)\S+|script\s+(?:-[a-z]*c|--c[a-z]*))\s+['"]*)*(?:git(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+(?:apply|am|add|commit|status|diff|log|show|rm)|git-apply|git-am|g?patch|cat|less|head|tail|wc|grep|rg|diff|ls|stat|rm)\s/;
// A `case` arm's pattern before its command: `case x in x) cmd`, or `x) cmd` when the line starts at the arm.
const CASE_ARM = /^\s*(?:case\b.*?\bin\s+)?[^\s()]+\s*\)\s*/;
const PATCH_OUTPUT_OPERAND = /(?:>\s*|(?:^|\s)(?:-[A-Za-z]*[or]\s*|--(?:o[a-z]*|reject-fi[a-z]*)(?:=|\s+)))["']?$/;

/** True when the walk reads this piece as a patch call taking the file as its patch. A substitution beside it runs first, so it does not count. */
function pieceOnlyReadsPatch(piece: string, base: string): boolean {
  if (/\$\(|`|[<>]\(/.test(piece)) return false;
  return patchCallsInText(piece).some((c) => c.call.sources.some((s) => s.split("/").filter(Boolean).pop() === base));
}

/**
 * True when the command line may replace a patch file before it is applied: the file is read when the command
 * is checked, so a command that also writes it could apply something else. Any mention of the file's basename
 * outside a known reader or a patch call reading it counts, so `./x`, `x` and `dir/../x` are one file.
 */
export function patchFileMayChange(command: string, file: string): boolean {
  const base = file.split("/").filter(Boolean).pop();
  if (!base) return false;
  for (const raw of command.split(/[;|&\n]/)) {
    const piece = raw.replace(CASE_ARM, "");
    if (piece.includes(base) && !PATCH_READER.test(piece) && !pieceOnlyReadsPatch(piece, base)) return true;
    for (let at = piece.indexOf(base); at >= 0; at = piece.indexOf(base, at + base.length)) {
      const before = piece.slice(0, at);
      if ([before, before.replace(/\.\/$/, ""), before.replace(/(?:[\w.~-]*\/)+$/, "")].some((text) => PATCH_OUTPUT_OPERAND.test(text))) return true;
    }
  }
  return false;
}

const COMPUTED_PATH = /[$`*?[{]/;
const STGIT_SERIES = /^#[ \t]*This series applies on GIT commit/m;
const MAIL_ENCODED = /^content-transfer-encoding[ \t]*:[ \t]*(?![ \t]|7bit\b|8bit\b|binary\b)/im;

/** The outcome of reading one call's patches: the targets, or why they cannot be known. */
export type PatchResolution = { targets: string[]; unreadable: string | null };

/**
 * Resolve a patch call to the files it writes. `read` returns a source's text, `stdin` the text on standard
 * input when it is known (a heredoc, a `<` redirect) and null when it is not, and `mayChange` reports a source
 * the same command rewrites. Any patch that cannot be read fails the whole call closed.
 */
export function resolvePatchCall(call: PatchCall, read: (source: string) => string | null, stdin: () => string | null, mayChange: (source: string) => boolean): PatchResolution {
  // `patch -d` changes directory before it opens anything, so a relative patch file or output is under it.
  const located = (source: string): string => (call.tool === "patch" && call.directory && !source.startsWith("/") ? `${call.directory.replace(/\/+$/, "")}/${source}` : source);
  const targets = new Set(call.namedWrites.map(located));
  const texts: string[] = [];
  if (call.unresolved !== null) return { targets: [...targets], unreadable: call.unresolved };
  for (const place of [call.directory ?? "", ...call.namedWrites]) {
    if (COMPUTED_PATH.test(place)) return { targets: [...targets], unreadable: `the path ${place} is computed at runtime` };
  }
  for (const source of call.sources) {
    if (/[$`*?[{]|<\(|^\/dev\/|^\/proc\//.test(source)) return { targets: [...targets], unreadable: `the patch ${source} is computed at runtime` };
    if (mayChange(source)) return { targets: [...targets], unreadable: `the patch ${source} is rewritten by the same command` };
    const text = read(located(source));
    if (text === null) return { targets: [...targets], unreadable: `the patch ${source} cannot be read` };
    texts.push(text);
  }
  if (call.stdin) {
    const text = stdin();
    if (text === null) return { targets: [...targets], unreadable: "the patch arrives on standard input" };
    texts.push(text);
  }
  for (const text of texts) {
    // git am decodes the mail first, so the raw text would not be the names it applies.
    // A series file lists other patches, and those are what git am applies.
    if (call.tool === "git-am" && STGIT_SERIES.test(text)) return { targets: [...targets], unreadable: "the patch is a series file" };
    if (call.tool === "git-am" && MAIL_ENCODED.test(text)) return { targets: [...targets], unreadable: "the patch is transfer-encoded" };
    const names = patchHeaderPaths(text);
    if (names === null) return { targets: [...targets], unreadable: "the patch is binary or has no readable file headers" };
    for (const target of patchTargets(call, names)) targets.add(target);
  }
  return { targets: [...targets], unreadable: null };
}

/** A patch invocation found in shell text, for a hook with no shell parser of its own. */
export interface TextPatchCall {
  call: PatchCall;
  /** The `git -C` values, in order. */
  chdirs: string[];
  /** The text on standard input when a heredoc supplies it. */
  stdinText: string | null;
  /** A file redirected to standard input. */
  stdinFile: string | null;
  /** True when the arguments are not all visible: xargs and find -exec append their own. */
  unseen: boolean;
  /**
   * True when no call was read and only the walk says a patch writer is here: the catch-all, or a shell reading
   * its commands from a pipe. The firewall parses the line its own way and fails closed on these too.
   */
  guessed?: boolean;
}

const COMMAND_WRAPPERS = new Set(["sudo", "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "stdbuf", "timeout", "eval", "xargs", "parallel", "setsid", "flock", "taskset", "fakeroot", "chrt", "bash", "sh", "zsh", "dash", "ksh", "fish", "ash", "mksh", "pdksh", "yash", "busybox", "coproc", "doas", "unshare", "nsenter", "chroot", "watch", "setpriv", "strace", "su", "runuser", "systemd-run", "then", "do", "else", "elif", "if", "while", "until", "!", "{"]);
const WRAPPER_VALUED_SHORT = new Map([["sudo", "ugUhpCDTrtR"], ["env", "uC"], ["nice", "n"], ["ionice", "cnp"], ["stdbuf", "ioe"], ["timeout", "ks"], ["xargs", "IPLnsdEa"], ["parallel", "jIPLnsda"], ["time", "fo"], ["exec", "a"], ["flock", "wE"], ["fakeroot", "lsib"], ["chrt", "TPD"], ["sh", "oO"], ["bash", "oO"], ["dash", "oO"], ["zsh", "oO"], ["ksh", "oO"], ["doas", "uC"], ["unshare", "SGRw"], ["nsenter", "tSG"], ["watch", "n"], ["strace", "abeEIoOpPsSuUX"], ["su", "gGsw"], ["runuser", "ugGslw"], ["systemd-run", "upEMH"]]);
const WRAPPER_VALUED_LONG = new Set(["--user", "--group", "--host", "--prompt", "--chdir", "--unset", "--signal", "--kill-after", "--adjustment", "--class", "--classdata", "--input", "--output", "--error", "--arg-file", "--delimiter", "--max-args", "--max-chars", "--max-lines", "--max-procs", "--replace", "--format", "--other-user", "--role", "--type", "--command-timeout", "--close-from", "--lib", "--faked", "--conflict-exit-code", "--sched-runtime", "--sched-period", "--sched-deadline", "--rcfile", "--init-file", "--reuid", "--regid", "--groups", "--inh-caps", "--ambient-caps", "--bounding-set", "--securebits", "--selinux-label", "--apparmor-profile", "--userspec"]);
// Wrappers whose first operand is not the command: a lock file, a CPU mask.
const WRAPPER_FIRST_OPERAND = new Set(["flock", "taskset", "chroot"]);
const PIPE_SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish", "ash", "mksh", "pdksh", "yash"]);
const STDIN_PATH = /^\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/;
const GIT_GLOBAL_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--attr-source"]);
// `script -c <text>`, spelt as a cluster, a long option, or either with the text attached.
const SCRIPT_COMMAND = /(?:^|\s)(?:-[a-zA-Z]*c|--c[a-z]*)(?:=|\s*)("[^"]*"|'[^']*'|\S+)/;
const SHELL_DELIMITER = /\|\|?&?|&&|(?<!>)&(?!>)|;|\n|`|\$\(|(?<![<$])\(|\)/g;

// The `$` of `$'git'` or `$"git"`. A segment holding an escape keeps it, so the word is still read as computed.
const ANSI_QUOTE_DOLLAR = /\$(?='[^'\\]*'|"[^"\\]*")/g;

function shellWords(piece: string): string[] {
  // Quotes and backslashes inside a word are removed as the shell removes them; a wholly quoted word stays one word.
  return (piece.match(/[A-Za-z_]\w*=(?:[^\s"']|"(?:[^"\\]|\\.)*"|'[^']*')*|"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map((w) => (/^["']/.test(w) ? w : w.replace(ANSI_QUOTE_DOLLAR, "").replace(/['"\\]/g, "")).replace(/^[\s"'(]+|[\s"')]+$/g, "")).filter(Boolean);
}

/** True when a wrapper's option takes the next word as its value, so that word is not the command. */
function wrapperFlagTakesNext(wrapper: string, flag: string): boolean {
  // One name, two meanings: flock's takes a value, setsid's does not.
  if (flag === "--wait" || flag === "--timeout") return wrapper === "flock";
  if (flag.startsWith("--")) return WRAPPER_VALUED_LONG.has(flag);
  const valued = WRAPPER_VALUED_SHORT.get(wrapper) ?? "";
  for (let k = 1; k < flag.length; k++) if (valued.includes(flag.charAt(k))) return k === flag.length - 1;
  return false;
}

// A wrapper option that moves the command elsewhere or hides its words: `env -C`, `env -S<text>`, `sudo -D`.
function wrapperFlagHidesCall(wrapper: string, flag: string): boolean {
  if (wrapper === "env") return /^(?:-[a-zA-Z0]*C|--c|-[a-zA-Z0]*S.|--s[^=]*=)/.test(flag);
  // These move the root or the working directory the targets would be read against.
  if (wrapper === "unshare" || wrapper === "nsenter") return /^(?:-[a-zA-Z]*[Rw]|--root|--wd)/.test(flag);
  return wrapper === "sudo" && /^(?:-[a-zA-Z]*D|--chd)/.test(flag);
}

/**
 * What a piece of shell text puts on standard input. Bash uses the last of several sources, and a later file beats
 * a heredoc, so a piece with more than one is reported as unknown, as is a heredoc whose body the shell expands.
 */
function pieceStdin(command: string, text: string, from: number): { stdinText: string | null; stdinFile: string | null } {
  const unknown = { stdinText: null, stdinFile: null };
  if (text.includes("<<<")) return unknown;
  const heredocs = text.match(/(?<!<)<<(?!<)/g)?.length ?? 0;
  const files = text.match(/(?<!<)<(?!<)/g)?.length ?? 0;
  if (heredocs + files !== 1) return unknown;
  if (files === 1) {
    const m = /(?<!\d)<\s*(?:"([^"]*)"|'([^']*)'|([^\s<>|;&()"'$`\\]+))(?=[\s;|&<>)]|$)/.exec(text);
    return { stdinText: null, stdinFile: m?.[1] ?? m?.[2] ?? m?.[3] ?? null };
  }
  // Bodies follow in the order their operators appear on the line, so another heredoc on it owns the first body.
  const lineEnd = command.indexOf("\n", from);
  const line = command.slice(command.lastIndexOf("\n", from) + 1, lineEnd < 0 ? undefined : lineEnd);
  if ((line.match(/(?<!<)<<(?!<)/g)?.length ?? 0) > 1) return unknown;
  const m = /<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|([\w.-]+))(?=[\s;|&<>)]|$)/.exec(text);
  const delim = m?.[2] ?? m?.[3] ?? m?.[4];
  if (delim === undefined) return unknown;
  const stripTabs = m?.[1] === "-";
  const rest = command.slice(from).split("\n").slice(1);
  const end = rest.findIndex((l) => (stripTabs ? l.replace(/^\t+/, "") : l) === delim);
  if (end < 0) return unknown;
  const body = `${rest.slice(0, end).join("\n")}\n`;
  if (m?.[4] !== undefined && /[$`]|\\\r?\n/.test(body)) return unknown;
  return { stdinText: body, stdinFile: null };
}

/** The index of git's subcommand in `words`, past its global options from `start`. */
function gitSubcommandIndex(words: readonly string[], start: number): number {
  let k = start;
  for (; k < words.length && (words[k] ?? "").startsWith("-"); k++) if (GIT_GLOBAL_VALUED.has(words[k] ?? "")) k++;
  return k;
}

/** The `git -C` values before the subcommand, in order, for git's cumulative reading of them. */
export function gitChdirs(words: readonly string[], start: number): string[] {
  const out: string[] = [];
  const end = gitSubcommandIndex(words, start);
  for (let k = start; k < end; k++) {
    if (words[k] === "-C") out.push(words[k + 1] ?? "");
    if (GIT_GLOBAL_VALUED.has(words[k] ?? "")) k++;
  }
  return out;
}

const CDPATH_SET = /(?:^|[\s;&|(])(?:export\s+)?CDPATH=/;
const DIRECTORY_CHANGE = /(?<![\w./-])(cd|pushd|popd)(?![\w./=-])/g;
const DIRECTORY_OPERAND = /^[ \t]+(?:"([^"]*)"|'([^']*)'|([^\s;&|()<>'"]+))[ \t]*(?=$|[\s;&|)'"])/;
const MAX_DIRECTORY_CHANGES = 6;

/**
 * Every directory a command's later words could run in. A `cd` may fail or sit in a subshell, so each one adds
 * to the set and replaces nothing. Null when a change cannot be read: a variable, `~`, a flag, `popd`, a bare
 * `cd`, more of them than is worth following, or a `CDPATH` set in the command, which moves where a `cd` lands.
 */
function patchShellDirs(command: string, cwd: string): string[] | null {
  if (CDPATH_SET.test(command)) return null;
  let dirs = [cwd];
  const changes = [...command.matchAll(DIRECTORY_CHANGE)];
  if (changes.length > MAX_DIRECTORY_CHANGES) return null;
  for (const change of changes) {
    if (change[1] === "popd") return null;
    const m = DIRECTORY_OPERAND.exec(command.slice(change.index + change[0].length));
    const to = m?.[1] ?? m?.[2] ?? m?.[3];
    if (to === undefined || to.startsWith("-") || to.startsWith("~") || COMPUTED_PATH.test(to)) return null;
    dirs = [...new Set([...dirs, ...dirs.map((d) => path.resolve(d, to))])];
  }
  return dirs;
}

/** The top of the repository holding `start`, or null outside one. */
function repositoryTop(start: string): string | null {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (dir === path.dirname(dir)) return null;
  }
}

// Each of these points git at a tree other than the one the directory walk finds. Over-matching only fails closed.
const GIT_TREE_MOVED = /(?:^|[\s'"(;&|])(?:--git-dir\b|--work-tree\b|GIT_DIR=|GIT_WORK_TREE=)/;

const BACKUP_SUFFIX_SET = /(?:^|[\s'"(;&|])SIMPLE_BACKUP_SUFFIX=/;

/** What a shell gives the call on standard input: a heredoc's text or a redirected file. */
export type PatchStdin = { text: string | null; file: string | null };

/**
 * The absolute candidates a patch call could write, or why they cannot be known. Both hooks decide through this,
 * so they cannot disagree: every target is placed at every directory the command may run in (each `cd`
 * candidate with all `git -C` applied), and for git also at the repository top, which is what `diff --git`
 * names and all of `git am` are relative to. A patch is read at every place it could be read from.
 */
export function patchCallTargets(command: string, cwd: string, call: PatchCall, chdirs: readonly string[], toAbsolute: (dir: string, file: string) => string | null, stdin: PatchStdin): PatchResolution {
  const fail = (unreadable: string): PatchResolution => ({ targets: [], unreadable });
  if (call.tool !== "patch" && GIT_TREE_MOVED.test(command)) return fail("the command points git at another tree");
  if (call.tool === "patch" && BACKUP_SUFFIX_SET.test(command)) return fail("the patch names a backup file pattern");
  const shellDirs = patchShellDirs(command, cwd);
  if (shellDirs === null) return fail("the directory it runs in cannot be determined");
  let workDirs = shellDirs;
  for (const chdir of chdirs) {
    if (chdir.startsWith("~") || COMPUTED_PATH.test(chdir)) return fail("the directory it runs in cannot be determined");
    workDirs = workDirs.map((d) => path.resolve(d, chdir));
  }
  const readAcross = (dirs: readonly string[], file: string): string | null => {
    const texts: string[] = [];
    for (const absolute of new Set(dirs.map((d) => toAbsolute(d, file)))) {
      if (absolute === null || !fs.existsSync(absolute)) continue;
      const text = readPatchFile(absolute);
      if (text === null) return null;
      texts.push(text);
    }
    return texts.length ? texts.join("\n") : null;
  };
  const resolved = resolvePatchCall(call, (source) => readAcross(workDirs, source), () => stdin.text ?? (stdin.file === null ? null : readAcross(shellDirs, stdin.file)), (source) => patchFileMayChange(command, source));
  const out = new Set<string>();
  for (const target of resolved.targets) {
    if (target.startsWith("/") || target.startsWith("~")) { out.add(target); continue; }
    for (const dir of workDirs) {
      out.add(path.join(dir, target));
      const top = call.tool === "patch" ? null : repositoryTop(dir);
      if (top !== null) out.add(path.join(top, target));
    }
  }
  return { targets: [...out], unreadable: resolved.unreadable };
}

/** True when the text names a patch writer, for a shell whose commands arrive on a pipe. Deliberately coarse. */
export function mentionsPatchWriter(text: string): boolean {
  return /\b(?:git-apply|git-am|g?patch)\b/.test(text) || (/\bgit\b/.test(text) && /\b(?:apply|am)\b/.test(text));
}

/** A call whose arguments and tool cannot be read from the text, so it fails closed in the hook. */
function unseenPatchCall(guessed = false): TextPatchCall {
  return { call: parsePatchArgs("git-apply", []), chdirs: [], stdinText: null, stdinFile: null, unseen: true, guessed };
}

// Commands whose words are data: a patch tool's name after one of these is an argument, not a program it runs.
const PATCH_NAME_HARMLESS = new Set(["cat", "head", "tail", "less", "more", "wc", "nl", "tac", "grep", "egrep", "fgrep", "rg", "ag", "ack", "echo", "printf", "ls", "stat", "file", "diff", "cmp", "sort", "uniq", "cut", "tr", "tee", "basename", "dirname", "realpath", "readlink", "which", "type", "man", "true", "false", "test", "[", "cd", "pushd", "mkdir", "rmdir", "touch", "cp", "mv", "rm", "ln", "chmod", "chown", "export", "make", "npm", "pnpm", "yarn", "find", "for", "case", "select", "gh", "glab", "kubectl", "oc", "curl", "wget"]);
const PACKAGE_RUNNER_EXEC = /^(?:exec|x|dlx)$/;
// git subcommands that do not run a command or take a patch, so a later `apply` or `am` is one of their arguments.
const GIT_APPLY_WORD_HARMLESS = new Set(["log", "show", "diff", "status", "grep", "blame", "shortlog", "stash", "add", "commit", "rev-parse", "rev-list", "ls-files", "branch", "tag", "fetch", "push", "checkout", "restore", "switch", "merge", "clone", "worktree", "remote"]);

/** True when the command at this index treats the rest of its words as data. */
function commandWordsAreData(words: readonly string[], command: number): boolean {
  const word = words[command] ?? "";
  const base = word.split("/").pop() ?? word;
  if (base === "git") {
    const k = gitSubcommandIndex(words, command + 1);
    return GIT_APPLY_WORD_HARMLESS.has(words[k] ?? "") && !words.slice(command + 1, k).some((w) => /alias\./i.test(w));
  }
  return PATCH_NAME_HARMLESS.has(base) && !words.some((w) => PACKAGE_RUNNER_EXEC.test(w));
}

/** True when a walked piece that gave no call still names a patch writer somewhere it could execute. */
function pieceNamesPatchWriter(words: readonly string[], command: number, fed: boolean): boolean {
  if ((words[command] ?? "").startsWith("#") || commandWordsAreData(words, command)) return false;
  const tokens = words.flatMap((w) => w.split(/[\s"'`=(){};|&!]+/)).filter(Boolean).map((t) => t.split("/").pop() ?? t);
  // `patch` only counts with what a patch run takes next, so a bare word such as `cargo release patch` does not.
  const patchRun = (next: string | undefined): boolean => (next === undefined ? fed : /^[-<]|\.(?:patch|diff)$/.test(next));
  const applyWord = (t: string | undefined): boolean => t === "apply" || t === "am";
  return tokens.some((t, n) => t === "git-apply" || t === "git-am" || ((t === "patch" || t === "gpatch") && patchRun(tokens[n + 1])) || (t === "git" && (applyWord(tokens[gitSubcommandIndex(tokens, n + 1)]) || (words.some((w) => /alias\./i.test(w)) && tokens.slice(n + 1).some(applyWord)))));
}

// The quoted strings of a command that span more than one line, as [opening quote, closing quote].
function multilineQuotes(command: string): [number, number][] {
  const out: [number, number][] = [];
  let open = -1;
  let mark = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (ch === "\\" && mark !== "'") { i++; continue; }
    if (open < 0) { if (ch === '"' || ch === "'") { open = i; mark = ch; } continue; }
    if (ch !== mark) continue;
    if (command.slice(open, i).includes("\n")) out.push([open, i]);
    open = -1;
  }
  return out;
}

// Where the heredoc bodies of a command lie, since those lines are text and not commands.
function heredocBodies(command: string): [number, number][] {
  const out: [number, number][] = [];
  const lines = command.split("\n");
  let offset = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? "";
    let at = offset + line.length + 1;
    let row = n;
    for (const m of line.matchAll(/(?<!<)<<(-?)\s*["']?([\w.-]+)["']?/g)) {
      const start = at;
      for (row++; row < lines.length; row++) {
        const body = lines[row] ?? "";
        at += body.length + 1;
        if ((m[1] === "-" ? body.replace(/^\t+/, "") : body) === m[2]) break;
      }
      out.push([start, at]);
    }
    n = row;
    offset = at;
  }
  return out;
}

/** Text the shell does not run, with the position of what opened it and of each substitution around it. */
interface InertSpan {
  from: number;
  to: number;
  heredoc: boolean;
  opener: number;
  within: number[];
}

// A plain `${name}` form. Anything richer can hold quotes the shell and this reader would pair differently.
const PLAIN_PARAMETER = /^\$\{[^}"'`$()\s]*\}/;
const HEREDOC_DELIMITER = /^<<(-?)[ \t]*((?:[^\s;&|()<>"'\\]|\\.|"[^"\n]*"|'[^'\n]*')+)/;

/**
 * Where a command's literal quoted text and quoted-delimiter heredoc bodies lie, read with nesting: a `$(` or
 * backtick inside double quotes starts commands again, and a comment hides any quote or `<<` in it. Empty when
 * the text holds a form this cannot pair as the shell would, so everything is walked as commands.
 */
function inertSpans(command: string): InertSpan[] {
  const spans: InertSpan[] = [];
  type Frame = { kind: "top" | "paren" | "tick" | "dq"; open: number; depth: number; start: number };
  const stack: Frame[] = [{ kind: "top", open: -1, depth: 0, start: 0 }];
  const pending: { delimiter: string; strip: boolean; quoted: boolean; opener: number; within: number[] }[] = [];
  const within = (): number[] => stack.filter((f) => f.kind === "paren" || f.kind === "tick").map((f) => f.open);
  for (let i = 0; i < command.length; i++) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) return [];
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    if (ch === "$" && next === "{") {
      const plain = PLAIN_PARAMETER.exec(command.slice(i, i + 4096));
      if (plain === null) return [];
      i += plain[0].length - 1;
      continue;
    }
    if (frame.kind === "dq") {
      if (ch === "\\") i++;
      else if (ch === '"') { spans.push({ from: frame.start, to: i, heredoc: false, opener: frame.open, within: within() }); stack.pop(); }
      else if (ch === "`" || (ch === "$" && next === "(")) {
        if (next === "(" && command.charAt(i + 2) === "(") return [];
        spans.push({ from: frame.start, to: i, heredoc: false, opener: frame.open, within: within() });
        stack.push({ kind: ch === "`" ? "tick" : "paren", open: i, depth: 0, start: 0 });
        if (ch === "$") i++;
      }
      continue;
    }
    if (ch === "\\") {
      if (frame.kind === "tick") return [];
      i++;
      continue;
    }
    if (ch === "\n" && pending.length > 0) {
      let at = i + 1;
      for (const doc of pending.splice(0)) {
        const start = at;
        for (;;) {
          if (at >= command.length) break;
          const lineEnd = command.indexOf("\n", at);
          const line = command.slice(at, lineEnd < 0 ? undefined : lineEnd);
          at = lineEnd < 0 ? command.length : lineEnd + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
        }
        if (doc.quoted) spans.push({ from: start, to: at - 1, heredoc: true, opener: doc.opener, within: doc.within });
      }
      i = at - 1;
      continue;
    }
    if (ch === "#" && /^$|[\s;&|()`]/.test(command.charAt(i - 1))) {
      const end = command.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (ch === "$" && next === "'") return [];
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return [];
      spans.push({ from: i + 1, to: close, heredoc: false, opener: i, within: within() });
      i = close;
      continue;
    }
    if (ch === '"') { stack.push({ kind: "dq", open: i, depth: 0, start: i + 1 }); continue; }
    if (ch === "`") {
      if (frame.kind === "tick") {
        stack.pop();
        const outer = stack[stack.length - 1];
        if (outer?.kind === "dq") outer.start = i + 1;
      } else stack.push({ kind: "tick", open: i, depth: 0, start: 0 });
      continue;
    }
    if (ch === "$" && next === "(") {
      if (command.charAt(i + 2) === "(") return [];
      stack.push({ kind: "paren", open: i, depth: 0, start: 0 });
      i++;
      continue;
    }
    if (ch === "(") {
      if (next === "(") return [];
      if (frame.kind === "paren") frame.depth++;
      continue;
    }
    if (ch === ")" && frame.kind === "paren") {
      if (frame.depth > 0) { frame.depth--; continue; }
      stack.pop();
      const outer = stack[stack.length - 1];
      if (outer?.kind === "dq") outer.start = i + 1;
      continue;
    }
    // A `case` pattern's `)` would close the substitution too early.
    if (frame.kind === "paren" && ch === "c" && /^case\s/.test(command.slice(i, i + 5)) && !/[\w.-]/.test(command.charAt(i - 1))) return [];
    if (ch === "<" && next === "<" && command.charAt(i + 2) !== "<") {
      const m = HEREDOC_DELIMITER.exec(command.slice(i, i + 4096));
      if (m === null) return [];
      const word = m[2] ?? "";
      pending.push({ delimiter: word.replace(/\\(.)/g, "$1").replace(/["']/g, ""), strip: m[1] === "-", quoted: /["'\\]/.test(word), opener: i, within: within() });
      i += m[0].length - 1;
    }
  }
  return stack.length === 1 ? spans : [];
}

/** Every `git apply`, `git am` and `patch` call in a command line, including those behind wrappers and `-c`. */
export function patchCallsInText(command: string): TextPatchCall[] {
  const out: TextPatchCall[] = [];
  let at = 0;
  const pieces: { text: string; from: number; piped: boolean; substituted: boolean; rest: string }[] = [];
  let piped = false;
  for (const m of command.matchAll(SHELL_DELIMITER)) {
    pieces.push({ text: command.slice(at, m.index), from: at, piped, substituted: m[0] === "$(" || m[0] === "`", rest: command.slice(m.index + m[0].length) });
    piped = m[0] === "|" || m[0] === "|&";
    at = m.index + m[0].length;
  }
  pieces.push({ text: command.slice(at), from: at, piped, substituted: false, rest: "" });
  const bodies = heredocBodies(command);
  type Piece = (typeof pieces)[number];
  type Walked = { words: string[]; command: number; fed: boolean };
  // Reads one piece into `out`. Returns the words and the index of the command word when none was read from them.
  const walkPiece = (piece: Piece): Walked | null => {
    // A lookahead, so that a substitution nested in another is matched from its own opener too.
    for (const m of piece.text.matchAll(/(?<![<\d])<\((?=((?:(?!<\()[^()])*))/g)) out.push(...patchCallsInText(m[1] ?? ""));
    let text = piece.text.replace(CASE_ARM, "");
    const hereString = /<<<\s*("[^"]*"|'[^']*'|\S+)/.exec(text)?.[1]?.replace(/^["']|["']$/g, "");
    const fed = piece.piped || /<(?!\()/.test(text);
    const { stdinText, stdinFile } = pieceStdin(command, text, piece.from);
    text = text.replace(/\d*(?:&>|>{1,2})\s*\S+/g, " ").replace(/<<<\s*(?:"[^"]*"|'[^']*'|\S+)/g, " ").replace(/<<-?\s*\S+/g, " ").replace(/(?<![<])<\s*(?!\()\S+/g, " ");
    const words = shellWords(text);
    const first = words[0] ?? "";
    let i = 0;
    let unseen = false;
    if (first.split("/").pop() === "find") {
      const exec = words.findIndex((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w));
      if (exec < 0) return { words, command: 0, fed };
      i = exec + 1;
      unseen = true;
    }
    let wrapped = false;
    let wrapper = "";
    let skipOperand = false;
    let shellReadsArgs = false;
    for (; i < words.length; i++) {
      const w = words[i] ?? "";
      const base = w.split("/").pop() ?? w;
      if (w === "function" && !skipOperand) { i++; continue; } // The keyword and its name, so the body is read as a call.
      if (COMMAND_WRAPPERS.has(base) && !skipOperand) { wrapped = true; wrapper = base; skipOperand = WRAPPER_FIRST_OPERAND.has(base); if (base === "xargs" || base === "parallel" || base === "systemd-run") unseen = true; continue; }
      if (/^[A-Za-z_]\w*=/.test(w)) continue;
      if (wrapped && (w.startsWith("-") || (PIPE_SHELLS.has(wrapper) && w.startsWith("+")))) { if (PIPE_SHELLS.has(wrapper) && /^-[a-zA-Z]*s/.test(w)) shellReadsArgs = true; if (wrapperFlagHidesCall(wrapper, w)) unseen = true; if (wrapperFlagTakesNext(wrapper, w)) i++; continue; }
      if (skipOperand) { skipOperand = false; if (wrapper === "chroot" && w !== "/") unseen = true; continue; }
      if (wrapped && /^\d+[smhd]?$/.test(w)) continue;
      break;
    }
    const word = words[i] ?? "";
    // A shell given no script reads its commands from the pipe, which only the text before it can show.
    const shellOnPipe = (PIPE_SHELLS.has(wrapper) && (word === "" || word === "-" || shellReadsArgs || STDIN_PATH.test(word))) || (wrapper === "parallel" && word === "") || (word.split("/").pop() === "script" && !SCRIPT_COMMAND.test(text)) || ((word === "source" || word === ".") && STDIN_PATH.test(words[i + 1] ?? ""));
    // A pipe earlier on the line still feeds a shell inside a subshell or compound: `| (cd .; sh)`, `| if x; then sh; fi`.
    if ((piece.piped || /\|/.test(command.slice(0, piece.from))) && shellOnPipe && mentionsPatchWriter(command)) { out.push(unseenPatchCall(true)); return null; }
    // A here-string is the shell's script. Text it would expand cannot be placed, so it fails closed.
    if (shellOnPipe && hereString !== undefined) {
      if (/[$`]/.test(hereString) && mentionsPatchWriter(hereString)) out.push(unseenPatchCall());
      else out.push(...patchCallsInText(hereString).map((c) => ({ ...c, unseen: c.unseen || unseen })));
      return null;
    }
    if (word.split("/").pop() === "script") {
      const inner = SCRIPT_COMMAND.exec(text)?.[1]?.replace(/^["']|["']$/g, "");
      if (inner !== undefined) out.push(...patchCallsInText(inner).map((c) => ({ ...c, unseen: c.unseen || unseen })));
      return null;
    }
    if (/\s/.test(word)) { out.push(...patchCallsInText(word).map((c) => ({ ...c, unseen: c.unseen || unseen }))); return null; }
    const base = word.split("/").pop() ?? word;
    let tool: PatchTool | null = null;
    let args: string[] = [];
    let chdirs: string[] = [];
    if (base === "patch" || base === "gpatch") { tool = "patch"; args = words.slice(i + 1); }
    else if (base === "git-apply") { tool = "git-apply"; args = words.slice(i + 1); }
    else if (base === "git-am") { tool = "git-am"; args = words.slice(i + 1); }
    else if (base === "git") {
      const k = gitSubcommandIndex(words, i + 1);
      chdirs = gitChdirs(words, i + 1);
      // The subcommand, or a global option's value before it, is computed by the shell: `git $x`, `git $(echo apply)`,
      // and `git -C $(pwd) apply`, which the substitution cuts off here so only the text after it shows the subcommand.
      const cutOff = k >= words.length && piece.substituted && (k === words.length ? true : /\b(?:apply|am)\b|[$`]/.test(piece.rest));
      if (cutOff || /[$`]/.test(words[k] ?? "")) { out.push(unseenPatchCall()); return null; }
      if (words[k] === "apply") tool = "git-apply";
      else if (words[k] === "am") tool = "git-am";
      args = words.slice(k + 1);
    }
    if (tool === null) return { words, command: i, fed };
    out.push({ call: parsePatchArgs(tool, args), chdirs, stdinText: piece.piped ? null : stdinText, stdinFile: piece.piped ? null : stdinFile, unseen });
    return null;
  };
  const quoted = multilineQuotes(command);
  const seen: { from: number; end: number; walked: Walked | null }[] = [];
  const spans = inertSpans(command);
  const walkedAt = (position: number): Walked | null => seen.find((p) => p.from <= position && position <= p.end)?.walked ?? null;
  const readsAsData = (w: Walked | null): boolean => w !== null && w.command === 0 && commandWordsAreData(w.words, 0);
  // The command whose inert text this piece is, or null when the piece must be walked. Text in a quoted heredoc or in
  // quotes is inert only to a command that treats its words as data; make reads a heredoc as a makefile.
  const inertOpener = (piece: Piece): Walked | null => {
    const span = spans.find((s) => piece.from >= s.from && piece.from <= s.to);
    if (span === undefined || (piece.from + piece.text.length > span.to && piece.text.includes("<("))) return null;
    const opener = walkedAt(span.opener);
    if (opener === null || !span.within.every((position) => readsAsData(walkedAt(position)))) return null;
    if (!readsAsData(opener)) return null;
    const base = opener.words[0]?.split("/").pop() ?? "";
    return span.heredoc && (base === "make" || base === "gmake") ? null : opener;
  };
  for (const piece of pieces) {
    const inert = inertOpener(piece);
    if (inert !== null) { seen.push({ from: piece.from, end: piece.from + piece.text.length, walked: inert }); continue; }
    const before = out.length;
    const walked = walkPiece(piece);
    seen.push({ from: piece.from, end: piece.from + piece.text.length, walked });
    if (walked === null || out.length !== before || bodies.some(([from, to]) => piece.from >= from && piece.from < to)) continue;
    // A line inside a multi-line quote belongs to the command that opened the quote, as in a long commit message.
    const quote = quoted.find(([from, to]) => piece.from > from && piece.from < to);
    const opener = quote === undefined ? undefined : seen.find((p) => p.from <= quote[0] && quote[0] <= p.end)?.walked;
    const words = opener ? [...opener.words, ...walked.words] : walked.words;
    // The catch-all: a patch writer the walk could not place, because the wrapper or spelling is not one it knows.
    if (pieceNamesPatchWriter(words, opener ? opener.command : walked.command, walked.fed)) out.push(unseenPatchCall(true));
  }
  return out;
}
