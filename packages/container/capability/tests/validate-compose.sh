#!/usr/bin/env sh
# Validate that canonical and root compose files are equivalent and well-formed.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CANONICAL="$REPO_ROOT/capability/compose/compose.yaml"
COMPAT="$REPO_ROOT/docker-compose.yml"
ENV_FILE="$REPO_ROOT/capability/env/defaults.env"

pass() { printf "  PASS: %s\n" "$1"; }
fail() { printf "  FAIL: %s\n" "$1"; FAILURES=$((FAILURES+1)); }
FAILURES=0

echo "[validate-compose] Checking compose files..."

# Both files exist
[ -f "$CANONICAL" ] && pass "canonical compose exists" || fail "canonical compose missing"
[ -f "$COMPAT" ]    && pass "compat compose exists"    || fail "compat compose missing"
[ -f "$ENV_FILE" ]  && pass "defaults.env exists"      || fail "defaults.env missing"

# Compose name
for f in "$CANONICAL" "$COMPAT"; do
  name=$(grep -E "^name:" "$f" | head -1 | sed 's/name: //')
  if [ "$name" = "pi-system" ]; then
    pass "$(basename "$f"): compose name is the expected project name"
  else
    fail "$(basename "$f"): compose name is '$name' (expected the historical project name)"
  fi
done

# capability.yaml id matches
cap_id=$(grep "^id:" "$REPO_ROOT/capability.yaml" | sed 's/id: //')
if [ "$cap_id" = "pi-system" ]; then
  pass "capability.yaml id matches"
else
  fail "capability.yaml id is '$cap_id'"
fi

# Both reference the same service
for f in "$CANONICAL" "$COMPAT"; do
  if grep -q "pi-agent:" "$f"; then
    pass "$(basename "$f"): pi-agent service defined"
  else
    fail "$(basename "$f"): pi-agent service not found"
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  echo "[validate-compose] FAILED ($FAILURES errors)"
  exit 1
else
  echo "[validate-compose] All checks passed."
fi
