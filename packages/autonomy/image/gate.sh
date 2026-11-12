#!/usr/bin/env bash
# The reference acceptance check for improving THIS kit's own repository (Luna): its offline
# checks, run as one contract check (`run: ["/opt/autonomy/gate.sh"]`). It is an example of a
# check definition, not a built-in: any contract can name other commands. It runs inside
# lib/check-runner.ts, so the working directory is already a clean clone of the accepted head
# with the held-out overlay applied, and there is no network. Exit 0 only when every step passed.
# Output: $GATE_DIR/gate.log and $GATE_DIR/result.json (per-step detail, evidence for the
# supervisor). GATE_DIR is /gate in the check container (its environment is scrubbed, so the
# default always applies there); tests/autonomy-image-scripts-smoke.ts points it at a temp dir.
# Semgrep is not run (its rules come from the network); CI runs it on the merge request.
#
# check:all runs with --jobs=<the container's CPU quota> and --check-timeout when the checked-out
# tree's check-all supports them (packages/core/check-all.ts names the flags); an older tree runs
# one check at a time. GATE_JOBS overrides the job count (clamped to 1-16).
set -uo pipefail
GATE_DIR="${GATE_DIR:-/gate}"
export HOME="$GATE_DIR/home" npm_config_cache="$GATE_DIR/npm-cache"
mkdir -p "$HOME"
exec >"$GATE_DIR/gate.log" 2>&1
git config --global safe.directory '*'
git config --global core.hooksPath /dev/null
[ -d /opt/npm-cache ] && cp -a /opt/npm-cache "$GATE_DIR/npm-cache"

steps=(); failed=0
record() { steps+=("$1"$'\t'"$2"$'\t'"$3"); [ "$2" = 0 ] || failed=1; }
step() {
  local name="$1"; shift
  local start=$SECONDS
  echo "=== $name: $*"
  "$@"; local code=$?
  echo "=== $name: exit $code ($((SECONDS - start))s)"
  record "$name" "$code" "$((SECONDS - start))"
}

# CPUs the container may use: the cgroup v2 quota, else the visible processors.
cpu_quota() {
  local quota period
  if read -r quota period 2>/dev/null </sys/fs/cgroup/cpu.max && [ "$quota" != max ] && [ "${period:-0}" -gt 0 ] 2>/dev/null; then
    echo $(( (quota + period - 1) / period ))
  else
    nproc 2>/dev/null || echo 1
  fi
}
jobs="${GATE_JOBS:-$(cpu_quota)}"
case "$jobs" in ''|*[!0-9]*) jobs=1 ;; esac
[ "$jobs" -lt 1 ] && jobs=1
[ "$jobs" -gt 16 ] && jobs=16
check_args=()
if grep -q -- '--jobs=' packages/core/check-all.ts 2>/dev/null; then check_args+=("--jobs=$jobs"); fi
if grep -q -- '--check-timeout=' packages/core/check-all.ts 2>/dev/null; then check_args+=("--check-timeout=600"); fi

step install npm ci --offline --ignore-scripts

# check-all's output goes to a file (never a pipe, so its exit code is its own), then into gate.log.
echo "=== check-all: npm run check:all ${check_args[*]:+-- ${check_args[*]}}"
start=$SECONDS
if [ "${#check_args[@]}" -gt 0 ]; then npm run check:all -- "${check_args[@]}" >"$GATE_DIR/check-all.log" 2>&1
else npm run check:all >"$GATE_DIR/check-all.log" 2>&1; fi
code=$?
cat "$GATE_DIR/check-all.log"
echo "=== check-all: exit $code ($((SECONDS - start))s)"
record check-all "$code" "$((SECONDS - start))"
# The failed checks by name (check-all's `  - <label> (<detail>)` summary lines), so a red gate
# tells the next cycle which checks failed and not only "check-all".
summary=""
if [ "$code" != 0 ]; then
  summary="$(awk '/^check-all: [0-9]+\/[0-9]+ FAILED/ { on = 1; print; next } on && /^  - / { print; next } on { on = 0 }' "$GATE_DIR/check-all.log")"
  n=0
  while IFS= read -r line; do
    case "$line" in "  - "*) ;; *) continue ;; esac
    [ "$n" -ge 12 ] && break
    record "check-all:${line#  - }" 1 0
    n=$((n + 1))
  done <<<"$summary"
fi

# test:security is a chain of smokes that check-all already runs one by one when every file has
# its own script (check-all prints that it skips the chain, or lists it as one of its runs). Run
# it separately only when check-all does not cover it.
security_list="$(npm run -s check:all -- --list 2>&1)"
if grep -qx 'test:security' <<<"$security_list" || grep -q '^check-all: skipping test:security: every file it runs is already its own check' <<<"$security_list"; then
  echo "=== security: covered by check-all (each test:security file ran as its own check)"
  record security 0 0
else
  step security npm run test:security
fi
step docs python3 -m mkdocs build --strict -d /tmp/site
step secrets gitleaks git --redact --exit-code 1 .

# Re-print the failure summary last, so the tail of gate.log the supervisor keeps still names it.
if [ -n "$summary" ]; then echo; echo "=== check-all failures (repeated from above)"; echo "$summary"; fi

printf '%s\n' "${steps[@]}" | GATE_DIR="$GATE_DIR" node -e '
  const steps = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => { const [name, code, seconds] = l.split("\t"); return { name, code: +code, seconds: +seconds }; });
  require("fs").writeFileSync(require("path").join(process.env.GATE_DIR, "result.json"), JSON.stringify({ steps, green: steps.every((s) => s.code === 0) }, null, 2));'
exit "$failed"
