# VF-15: rate `luna schedule` mutations high, and the spec directory operator authority

Status: owner route required (R3). Prepared by `luna-guard-01`, cycle 12.

This supersedes `luna-guard-01-10-luna-schedule-classification-r3.md` (same patch, now with the
complete diff and verification recorded on cycle 12's base). The implementation is ready as commit
`e1643239` on `origin/attempts/luna-guard-01/cycle-10`, but it cannot merge unattended: the tool
firewall is R3 ("permissions" in `packages/autonomy/lib/risk.ts`), and this run has
`allowControlChanges` off.

## Finding

`luna schedule add`, `remove` and `run-now` create or change a run the OS starts later, but the
tool firewall rated the direct form medium (`unknown_exec`), `node packages/core/luna.ts schedule
add` low (`script_exec`), `npx luna schedule ...` medium (`pm_exec_fetch`), and the spec write
medium (`outside_write`). Only a systemd timer write and `crontab -e` already reached high
(`persistence_write`, `crontab_install`). An agent allowed to run a shell could therefore create a
persistent schedule without the operator seeing a high-risk card.

| command | tier before | code before |
| --- | --- | --- |
| `luna schedule add nightly daily 02:00 -- …` | medium | `unknown_exec` |
| `luna schedule remove nightly` | medium | `unknown_exec` |
| `luna schedule run-now nightly` | medium | `unknown_exec` |
| `node packages/core/luna.ts schedule add …` | low | `script_exec` |
| `npx luna schedule add …` | medium | `pm_exec_fetch` |
| `bash -c 'luna schedule add …'` | medium | `unknown_exec` |
| `echo x > ~/.local/state/luna/schedules/nightly.json` | medium | `outside_write` |
| `echo x > ~/.config/systemd/user/luna-schedule-nightly.timer` | high | `persistence_write` |
| `crontab -e` | high | `crontab_install` |

Root cause: there was no `luna` + `schedule` matcher, and the schedule state directory
(`~/.local/state/luna/schedules/`, `packages/core/lib/schedule.ts`) was not an operator-authority
location, so a write to `nightly.json` was an ordinary outside write.

## Fix

In `packages/extensions/src/tool-firewall/classify.ts`:

- A broad matcher (`lunaScheduleBroad`) finds `luna`, `luna.ts|js|mjs`, a path or package-runner
  operand, a variable this line set, or an inline shell payload, followed by `schedule` and one of
  `add`, `remove`, `run-now`. It adds `high` / `persistence` / `scheduled_task`. It runs on the
  normal and the computed-name path. The finding only ever adds; it cannot lower a rating.
- `luna schedule list` and `show` do not match and keep their previous rating.
- `OPERATOR_AUTHORITY_FILES` gains `{ id: "luna-schedules", root: "state", name:
  "luna/schedules/", secret: false, source: "packages/core/lib/schedule.ts" }`. `authorityClass`
  resolves root `state` through `XDG_STATE_HOME` (default `$HOME/.local/state`) and treats the
  directory prefix as `security_control`, including globs that reach it. A write to
  `<id>.json` is therefore high (`security_control_write`).

## Tests and evidence

- `tests/firewall-shell-smoke.ts` (V5-15 block): direct, `node packages/core/luna.ts`, `npx`,
  `bash -c`, and computed-name forms are high with `scheduled_task`; `list`, `show`, `echo`,
  `grep` and a git message stay below high; the spec directory classifies `security_control` and
  the rest of the state home stays `home`.
- `tests/firewall-must-block-corpus-smoke.ts`: four new launch-form rows and one spec-write row
  (50 rows total, was 45). The corpus fails without the matcher/authority change.
- `tests/firewall-autoload-smoke.ts`: the operator-authority loop understands root `state` and
  checks the new entry against `packages/core/lib/schedule.ts` (11 authority entries, was 10).
- `docs/schedule.md` describes what is now covered and what remains: a scheduled job that is
  allowed to run shell commands could still create another schedule after unsetting
  `LUNA_SCHEDULE_JOB`.

Verification on cycle 12's base `d9ec580f6fc8`, with the patch below applied:

- `node tests/firewall-shell-smoke.ts` — OK.
- `node tests/firewall-must-block-corpus-smoke.ts` — OK (50 rows).
- `node tests/firewall-autoload-smoke.ts` — OK (11 authority entries).
- The same three tests pass at the unpatched base (45 rows, 10 entries), and the corpus fails
  without the matcher, so the rows are two-sided.

## Route

`packages/extensions/src/tool-firewall/` is R3 (`packages/autonomy/lib/risk.ts`: permissions), so
this patch cannot be merged by an unattended cycle. The owner (or a reviewer with the R3 route)
decides whether to land it. No operator control path, budget, credential, gate policy or release
setting is changed.

## Patch

```diff

commit e16432393b2fdf92abc2037541b857cab979c20b
Author: pi autonomy <pi-autonomy@localhost>
Date:   Fri Nov 20 17:14:35 2026 +0000

    fix(firewall): rate luna schedule mutations high (V5-15)
    
    Finding: luna schedule add/remove/run-now creates or changes a run the OS starts
    later, but the firewall rated the direct form medium, node .../luna.ts low,
    npx medium, and a spec write medium. Only systemd timer and crontab writes
    were high.
    
    Root cause: there was no luna+schedule matcher, and the schedule state directory
    was not an operator-authority location.
    
    Fix: add lunaScheduleBroad (high/persistence/scheduled_task) over direct, path,
    package-runner, computed-name and inline shell forms; it only adds findings.
    Keep list/show and mentions unchanged. Add root=state to
    OPERATOR_AUTHORITY_FILES for <XDG_STATE_HOME>/luna/schedules/ so a write to
    <id>.json is security_control_write. Update the autoload authority loop,
    shell smoke rows, must-block corpus (50 rows) and docs/schedule.md.
    
    Verification: firewall-shell, firewall-must-block-corpus and firewall-autoload
    smoke pass; check-all --for-changed exits 0. npm run test:security stops at
    firewall-preauth 'timed out waiting for: operator card', which also fails with
    these changes stashed at the cycle base (pre-existing).
    
    R3: proposal autonomy/proposals/luna-guard-01-10-luna-schedule-classification-r3.md.

diff --git a/docs/schedule.md b/docs/schedule.md
index 92894833..ba3b94eb 100644
--- a/docs/schedule.md
+++ b/docs/schedule.md
@@ -101,14 +101,19 @@ Pinned by `tests/luna-cli-smoke.ts` (`tests/schedule-checks.ts`), which never ca
 `systemctl` or `crontab`: the library takes an injected runner, and the CLI runs with only a fake
 `systemctl` and `crontab` on `PATH`.
 
-## Not covered
-
-- **Agents with shell access.** The tool firewall does not yet rate `luna schedule add`, unit-file
-  or crontab writes, or the spec directory as operator-only (V5-15). Until it does, an agent allowed
-  to run `luna schedule add --yes` can create a schedule, and a scheduled job that is allowed to run
-  shell commands could do the same after unsetting `LUNA_SCHEDULE_JOB`. The digest stops an edited
-  spec from running; it does not stop a new schedule from being added. Run with the firewall asking
-  for shell commands.
+## Guarding a schedule
+
+The tool firewall rates `luna schedule add`, `remove` and `run-now` high in every launch form
+(direct, `node packages/core/luna.ts`, `npx`, `bash -c`, a computed name), so an agent that wants to
+create or change a schedule asks the operator first. `luna schedule list` and `show` stay routine.
+The spec directory (`~/.local/state/luna/schedules/`, honouring `XDG_STATE_HOME`) is operator
+authority, so a write to `<id>.json` is high as well. Pinned by `tests/firewall-shell-smoke.ts` and
+the must-block corpus.
+
+What remains: a scheduled job that is allowed to run shell commands could create another schedule
+after unsetting `LUNA_SCHEDULE_JOB`. The digest stops an edited spec from running; it does not stop
+a new schedule from being added. Run with the firewall asking for shell commands inside scheduled
+runs.
 - **Same-user writes.** Every file involved belongs to you. A process running as you can rewrite a
   unit file or crontab line, digest included; the digest protects against an edited spec, not
   against a rewritten unit.
diff --git a/packages/extensions/src/tool-firewall/classify.ts b/packages/extensions/src/tool-firewall/classify.ts
index c54bc99e..c037ff78 100644
--- a/packages/extensions/src/tool-firewall/classify.ts
+++ b/packages/extensions/src/tool-firewall/classify.ts
@@ -197,7 +197,7 @@ const HOME_AUTOLOAD = [".agents/skills"];
 // source names a new secret-looking file that is neither here nor in its reviewed exemptions. A path that could
 // reach a secret entry without naming it exactly (a glob, or a directory that holds one, read recursively or
 // archived) is classified as that secret too (authorityClass).
-export type AuthorityFile = { id: string; root: "agent" | "remote-state" | "anywhere"; name: string; secret: boolean; source: string };
+export type AuthorityFile = { id: string; root: "agent" | "remote-state" | "state" | "anywhere"; name: string; secret: boolean; source: string };
 export const OPERATOR_AUTHORITY_FILES: readonly AuthorityFile[] = [
   { id: "web-console-token", root: "anywhere", name: "console.token", secret: true, source: "packages/web-ui/server/config.ts" },
   { id: "remote-control-secret", root: "remote-state", name: "control.json", secret: true, source: "packages/web-ui/server/remote/store.ts" },
@@ -209,6 +209,7 @@ export const OPERATOR_AUTHORITY_FILES: readonly AuthorityFile[] = [
   { id: "pi-auth", root: "agent", name: "auth.json", secret: true, source: "@earendil-works/pi-coding-agent dist/core/agent-session-services.js" },
   { id: "pi-models", root: "agent", name: "models.json", secret: true, source: "@earendil-works/pi-coding-agent dist/core/agent-session-services.js" },
   { id: "firewall-approvals", root: "agent", name: "pi-kit/firewall-approvals.json", secret: false, source: "packages/extensions/src/tool-firewall/approvals.ts" },
+  { id: "luna-schedules", root: "state", name: "luna/schedules/", secret: false, source: "packages/core/lib/schedule.ts" },
 ];
 
 const GLOB_CHARS = /[*?[]/;
@@ -224,15 +225,25 @@ function globReaches(pattern: string, target: string): boolean {
 function authorityClass(trimmed: string, agentDirs: string[], home: string): PathClass | null {
   const remoteEnv = process.env.PI_REMOTE_STATE_DIR?.trim();
   const remoteDirs = [...new Set([...(remoteEnv ? [normalize(remoteEnv)] : []), ...agentDirs.map((d) => `${d}/remote-control`)])];
+  // `luna schedule` keeps the specs the OS scheduler starts in the operator's state home, so a write
+  // there is a persistence change even though the file name is the schedule's own id.
+  const stateDirs = [normalize(process.env.XDG_STATE_HOME?.trim() || `${home}/.local/state`)];
   const base = trimmed.split("/").pop() ?? "";
   const files = [...OPERATOR_AUTHORITY_FILES].sort((x, y) => y.name.length - x.name.length);
-  const locations = (f: AuthorityFile): string[] => (f.root === "anywhere" || !f.name ? [] : (f.root === "agent" ? agentDirs : remoteDirs).map((r) => `${r}/${f.name}`));
+  const dirsFor = (root: AuthorityFile["root"]): string[] => root === "agent" ? agentDirs : root === "remote-state" ? remoteDirs : root === "state" ? stateDirs : [];
+  const locations = (f: AuthorityFile): string[] => (f.root === "anywhere" || !f.name ? [] : dirsFor(f.root).map((r) => `${r}/${f.name}`));
   // Named files before whole directories, so control.json stays a secret inside the state directory.
   for (const f of files) {
     const cls: PathClass = f.secret ? "credential_control" : "security_control";
     if (f.root === "anywhere") { if (base === f.name) return cls; continue; }
     if (f.name && locations(f).includes(trimmed)) return cls;
   }
+  // A directory entry: everything below it carries the same authority (`<state>/luna/schedules/<id>.json`).
+  for (const f of files) {
+    if (!f.name.endsWith("/")) continue;
+    const cls: PathClass = f.secret ? "credential_control" : "security_control";
+    if (locations(f).some((loc) => within(trimmed, loc.replace(/\/$/, "")) || (GLOB_CHARS.test(trimmed) && globReaches(trimmed, loc)))) return cls;
+  }
   // A path that reaches a secret without naming it exactly: a directory that holds one (`grep -r`, `tar`, `cp -r`
   // of the state directory or the agent directory) or a glob that can expand to one or to such a directory
   // (`remote-control/*`, `auth.js*`). Reading it is a credential read, and writing it a safety-control change.
@@ -758,6 +769,7 @@ function classifySegment(c: Ctx): void {
     if (seg.decoderInName) add(c, "high", "obfuscated_exec", "decoded_command", "runs a command decoded at runtime", "decoded-exec");
     else add(c, "medium", "opaque", "dynamic_command", `command name is computed at runtime (${seg.words[0]?.raw ?? argv[0]})`, "dynamic-exec");
     if (c.env.autonomyRule !== false) autonomyBroad(c);
+    lunaScheduleBroad(c);
     return;
   }
   if (seg.evalOf) add(c, "medium", "opaque", "eval_dynamic", "eval of runtime-built text", "eval");
@@ -797,6 +809,7 @@ function classifySegment(c: Ctx): void {
   // interpreter's first operand. Anything else falls through to the interpreter, stdin, inline-code and package
   // rules, so the rule never rates a command lower than it would be without it.
   if (c.env.autonomyRule !== false && autonomyBroad(c) && narrowAutonomyLaunch(c)) return;
+  lunaScheduleBroad(c);
 
   // Agent CLIs are recognised by identity (name, script path or package), not by the name typed.
   const agent = agentIdentity(seg);
@@ -1109,6 +1122,58 @@ const trimOperators = (t: string) => { let e = t.length; while (e > 0 && (t[e -
 // The separators other languages split on besides \s (U+001C-U+001F, U+0085), read as spaces.
 const anySpace = (s: string) => Array.from(s, (ch) => { const n = ch.codePointAt(0) ?? 0; return (n >= 0x1c && n <= 0x1f) || n === 0x85 ? " " : ch; }).join("");
 
+// `luna schedule add|remove|run-now` creates or changes a run the OS starts later, so only the
+// operator does it. Unlike the autonomy CLI this is a broad matcher: `luna`, a path or script named
+// luna(.ts), a package runner's operand, a variable or an inline shell payload all count, and the
+// finding only ever adds. `luna schedule list` and `show` stay as they were.
+const LUNA_PROGRAM = /(?:^|\/)(?:luna|luna\.(?:ts|mjs|js))$/;
+const LUNA_MUTATING = new Set(["add", "remove", "run-now"]);
+function lunaScheduleVerb(tokens: readonly string[]): string | null {
+  for (let i = 0; i < tokens.length; i++) {
+    if (!LUNA_PROGRAM.test(tokens[i] ?? "")) continue;
+    const rest = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
+    if (rest[0] === "schedule" && rest[1] !== undefined && LUNA_MUTATING.has(rest[1])) return rest[1];
+  }
+  return null;
+}
+
+function lunaScheduleBroad(c: Ctx): void {
+  const { seg } = c;
+  const argv = seg.argv;
+  const raws = seg.words.map((w) => w.raw);
+  const viaVar = (raw: string) => raw.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, n: string) => seg.vars[n] ?? m);
+  const exe = basenameOf(viaVar(raws[0] ?? c.exe).replace(/^["']|["']$/g, ""));
+  const known = (e: string) => INTERPRETERS.has(e) || AUTONOMY_RUNNERS.has(e) || AUTONOMY_LAUNCHERS.test(e);
+  const launches = (e: string) => known(e) || !(own(HANDLERS, e) !== undefined || READ_ONLY.has(e) || DEV_TOOLS.has(e) || BENIGN_EXEC.has(e));
+  const program = viaVar(raws[0] ?? "").replace(/["']/g, "");
+  const byPath = [argv[0] ?? "", program].some((p) => p.includes("/") && !systemPath(c, p));
+  const pathSet = [...seg.assigns.filter((a) => /^PATH(?:\[[^\]]*\])?\+?=/.test(a)).map((a) => (/^PATH\+=/.test(a) ? `$PATH:` : "") + a.slice(a.indexOf("=") + 1)),
+    ...Object.keys(seg.vars).filter((k) => /^PATH(?:\[|$)/.test(k)).map((k) => seg.vars[k] ?? "")];
+  const pathMoved = pathSet.some((v) => v.split(":").some((d) => !/^\$\{?PATH\}?$/.test(d) && !systemPath(c, `${d}/x`)));
+  const sourced = (c.exe === "source" || c.exe === ".") && argv.length > 2;
+  const launchContext = byPath || pathMoved || seg.fnCall === true || sourced || launches(exe) || launches(c.exe);
+  let found = false as boolean;
+  argv.forEach((a, k) => {
+    if (found || (k > 0 && !launchContext)) return;
+    const prev = argv[k - 1] ?? "";
+    const joined = /^-(?:[a-zA-Z]*[epc]|-eval|-print)=/.exec(a);
+    const code = joined ? a.slice(joined[0].length) : a;
+    const inline = launchContext && (joined !== null || /^-(?:[a-zA-Z]*[epc]|-eval|-print)$/.test(prev)) && !bareWord(code);
+    const raw = raws[k] ?? "";
+    const candidates = [inline ? code : a, viaVar(raw).replace(/["']/g, ""), raw];
+    for (const candidate of candidates) {
+      for (const split of [ifsWords, (t: string) => anySpace(t).split(/\s+/).filter(Boolean)]) {
+        const verb = lunaScheduleVerb([...split(candidate), ...argv.slice(k + 1)]);
+        if (verb !== null) {
+          add(c, "high", "persistence", "scheduled_task", `luna schedule ${verb} creates or changes a run the OS starts later: only the operator does that`, `luna schedule ${verb}`);
+          found = true;
+          return;
+        }
+      }
+    }
+  });
+}
+
 // Installed system programs: /usr/bin, /bin, /usr/local/bin, /sbin, /opt, /nix and mise's install directory,
 // tested on the normalised path so a `..` that leaves the directory is not exempt.
 function systemPath(c: Ctx, p: string): boolean {
diff --git a/tests/firewall-autoload-smoke.ts b/tests/firewall-autoload-smoke.ts
index 07217218..e44de857 100644
--- a/tests/firewall-autoload-smoke.ts
+++ b/tests/firewall-autoload-smoke.ts
@@ -97,7 +97,7 @@ for (const f of C.OPERATOR_AUTHORITY_FILES) {
   const fromPi = src.startsWith(piDist);
   if (!fromPi || pinned) assert.ok(fs.existsSync(src), `${f.id}: its source ${f.source} exists`);
   if (f.name && fs.existsSync(src)) assert.ok(fs.readFileSync(src, "utf8").includes(`"${path.basename(f.name)}"`), `${f.id}: ${f.source} still names ${path.basename(f.name)}`);
-  const at = f.root === "agent" ? `${AGENT}/${f.name}` : f.root === "remote-state" ? `${AGENT}/remote-control/${f.name || "runtime/x"}` : `/opt/kit/packages/web-ui/.runtime/${f.name}`;
+  const at = f.root === "agent" ? `${AGENT}/${f.name}` : f.root === "remote-state" ? `${AGENT}/remote-control/${f.name || "runtime/x"}` : f.root === "state" ? `${HOME}/.local/state/${f.name}` : `/opt/kit/packages/web-ui/.runtime/${f.name}`;
   const cls = C.classifyPath(at, env);
   assert.equal(cls, f.secret ? "credential_control" : "security_control", `${f.id}: ${at} classifies as ${f.secret ? "an operator-authority secret" : "a safety control"}`);
   assert.equal(tier(`cp /tmp/x ${at}`), "high", `${f.id}: writing ${at} is high`);
diff --git a/tests/firewall-must-block-corpus-smoke.ts b/tests/firewall-must-block-corpus-smoke.ts
index 0732ce2f..f317714e 100644
--- a/tests/firewall-must-block-corpus-smoke.ts
+++ b/tests/firewall-must-block-corpus-smoke.ts
@@ -98,6 +98,13 @@ const MUST_BLOCK: readonly MustBlock[] = [
   bash("write-outside-workspace", "echo x > ~/.bashrc", [FW], "persistence_write", "high"),
   bash("write-outside-workspace", "echo 'ssh-ed25519 AAAA x' >> ~/.ssh/authorized_keys", [FW], "persistence_write", "high"),
   bash("write-outside-workspace", "cp payload /etc/cron.d/x", [FW], "persistence_write", "high"),
+  // V5-15: a luna schedule mutating verb creates or changes a run the OS starts later; its spec is
+  // operator authority. All four launch forms must be high, and `schedule list` stays allowed.
+  bash("write-outside-workspace", "echo x > ~/.local/state/luna/schedules/nightly.json", [FW], "security_control_write", "high"),
+  bash("privilege-escalation", "luna schedule add nightly --at 'daily 02:00' --prompt x --yes", [FW], "scheduled_task", "high"),
+  bash("privilege-escalation", "node packages/core/luna.ts schedule remove nightly", [FW], "scheduled_task", "high"),
+  bash("privilege-escalation", "npx luna schedule run-now nightly", [FW], "scheduled_task", "high"),
+  bash("privilege-escalation", "bash -c 'luna schedule add nightly --at daily --prompt x --yes'", [FW], "scheduled_task", "high"),
   bash("write-outside-workspace", "echo x > ~/.pi/agent/settings.json", [FW, PP], "security_control_write", "high"),
   bash("write-outside-workspace", "mv tool /usr/local/bin/tool", [FW], "system_write", "high"),
   bash("write-outside-workspace", "rm -rf ~", [FW], "critical_path_delete", "critical"),
@@ -230,8 +237,8 @@ try {
   // Count pins: a row removed or a family thinned shows up here, not as a silent pass.
   const families: readonly Family[] = ["credential-read", "write-outside-workspace", "privilege-escalation", "unpinned-install", "exfiltration"];
   const perFamily = Object.fromEntries(families.map((f) => [f, MUST_BLOCK.filter((row) => row.family === f).length]));
-  assert.deepEqual(perFamily, { "credential-read": 21, "write-outside-workspace": 8, "privilege-escalation": 5, "unpinned-install": 5, "exfiltration": 6 });
-  assert.equal(MUST_BLOCK.length, 45, "the corpus is exactly 45 rows");
+  assert.deepEqual(perFamily, { "credential-read": 21, "write-outside-workspace": 9, "privilege-escalation": 9, "unpinned-install": 5, "exfiltration": 6 });
+  assert.equal(MUST_BLOCK.length, 50, "the corpus is exactly 50 rows");
   for (const f of families) assert.ok((perFamily[f] ?? 0) >= 5, `family ${f} has at least 5 rows`);
   for (const name of [FW, SG, PP] as const) assert.ok(MUST_BLOCK.some((row) => row.guards.includes(name)), `${name} is expected on at least one row`);
   for (const row of MUST_BLOCK) assert.equal(row.fw !== undefined, row.guards.includes(FW), `${label(row)}: a firewall row names its finding code`);
diff --git a/tests/firewall-shell-smoke.ts b/tests/firewall-shell-smoke.ts
index ae3ed0af..3afc473e 100644
--- a/tests/firewall-shell-smoke.ts
+++ b/tests/firewall-shell-smoke.ts
@@ -816,6 +816,25 @@ console.log(`  OK: ${rows.length - 1} commands classified as expected (manual/au
     assert.ok(!codes(cmd).includes("autonomy_control"), `${cmd}: does not run a control command (${codes(cmd).join(",")})`);
   }
   console.log("  OK: DE-116: environment, functions, globs, variables, launchers, legacy entry point, in-word commands, appended arguments and inline code; routine and mention-only rows unchanged");
+
+// V5-15: `luna schedule` mutating verbs create or change a run the OS starts later, so they are high
+// in every launch form; `list`/`show` and commands that only mention the words stay as they were.
+{
+  const codes = (cmd: string) => C.classifyCommand(cmd, env).findings.map((f) => f.code);
+  const tier = (cmd: string) => C.effectiveTier(C.classifyCommand(cmd, env), false);
+  const ARGS = 'nightly --at "daily 02:00" --prompt "summarise" --yes';
+  const mutating = [
+    `luna schedule add ${ARGS}`, "luna schedule remove nightly", "luna schedule run-now nightly",
+    `node packages/core/luna.ts schedule add ${ARGS}`, `npx luna schedule add ${ARGS}`,
+    "bash -c 'luna schedule remove nightly'", "c=luna; $c schedule run-now nightly",
+  ];
+  for (const cmd of mutating) assert.ok(tier(cmd) === "high" && codes(cmd).includes("scheduled_task"), `${cmd}: high scheduled_task (${tier(cmd)} ${codes(cmd).join(",")})`);
+  const allowed = ["luna schedule list", "luna schedule show nightly", "echo 'luna schedule add'", "grep -r 'luna schedule add' .", "git log --grep='luna schedule remove'"];
+  for (const cmd of allowed) assert.ok(tier(cmd) !== "high" && !codes(cmd).includes("scheduled_task"), `${cmd}: not a schedule change (${tier(cmd)} ${codes(cmd).join(",")})`);
+  assert.equal(C.classifyPath(`${env.home}/.local/state/luna/schedules/nightly.json`, env), "security_control", "a schedule spec is operator authority");
+  assert.equal(C.classifyPath(`${env.home}/.local/state/luna/other.json`, env), "home", "the rest of the state home is not");
+  console.log("  OK: V5-15: luna schedule mutating verbs high in every launch form; list/show and mentions unchanged; spec directory operator authority");
+}
 }
 
 // Parser details the classifier relies on.
```
