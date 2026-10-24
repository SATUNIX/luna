#!/usr/bin/env bash
# The reference acceptance check for improving THIS kit's own repository (pi-system): its offline
# checks, run as one contract check (`run: ["/opt/autonomy/gate.sh"]`). It is an example of a
# check definition, not a built-in: any contract can name other commands. It runs inside
# lib/check-runner.ts, so the working directory is already a clean clone of the accepted head
# with the held-out overlay applied, and there is no network. Exit 0 only when every step passed.
# Output: /gate/gate.log and /gate/result.json (per-step detail, evidence for the supervisor).
# Semgrep is not run (its rules come from the network); CI runs it on the merge request.
set -uo pipefail
export HOME=/gate/home npm_config_cache=/gate/npm-cache
mkdir -p "$HOME"
exec >/gate/gate.log 2>&1
git config --global safe.directory '*'
git config --global core.hooksPath /dev/null
[ -d /opt/npm-cache ] && cp -a /opt/npm-cache /gate/npm-cache

steps=(); failed=0
step() {
  local name="$1"; shift
  local start=$SECONDS
  echo "=== $name: $*"
  "$@"; local code=$?
  echo "=== $name: exit $code ($((SECONDS - start))s)"
  steps+=("$name $code $((SECONDS - start))")
  [ "$code" = 0 ] || failed=1
}

step install npm ci --offline --ignore-scripts
step check-all npm run check:all
step security npm run test:security
step docs python3 -m mkdocs build --strict -d /tmp/site
step secrets gitleaks git --redact --exit-code 1 .

printf '%s\n' "${steps[@]}" | node -e '
  const steps = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => { const [name, code, seconds] = l.split(" "); return { name, code: +code, seconds: +seconds }; });
  require("fs").writeFileSync("/gate/result.json", JSON.stringify({ steps, green: steps.every((s) => s.code === 0) }, null, 2));'
exit "$failed"
