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
 */

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
