#!/usr/bin/env sh
set -eu

SERVER_DIR="mcp-servers/governance"

[ -f "$SERVER_DIR/package.json" ] || {
  echo "Missing governance MCP package.json" >&2
  exit 1
}

[ -f "$SERVER_DIR/package-lock.json" ] || {
  echo "Missing governance MCP package-lock.json" >&2
  exit 1
}

[ -f "$SERVER_DIR/index.ts" ] || {
  echo "Missing governance MCP server entrypoint" >&2
  exit 1
}

python3 -m json.tool "$SERVER_DIR/package.json" >/dev/null
python3 -m json.tool "$SERVER_DIR/package-lock.json" >/dev/null

# The SDK is typed by a hand-kept mirror (mcp-servers/types/mcp-sdk.d.ts) that names the version it was
# checked against. Each server must pin exactly that version, in package.json and in its lockfile, so a
# bump cannot land without the mirror being reviewed and its stated version moved with it.
SDK_MIRROR="mcp-servers/types/mcp-sdk.d.ts"
python3 -I - "$SDK_MIRROR" mcp-servers/governance mcp-servers/memory-mcp <<'PY' || exit 1
import json, re, sys
mirror, servers = sys.argv[1], sys.argv[2:]
m = re.search(r"^// This file mirrors @modelcontextprotocol/sdk (\d+\.\d+\.\d+) ", open(mirror, encoding="utf-8").read(), re.M)
if not m:
    sys.exit(f"{mirror} must state the @modelcontextprotocol/sdk version it mirrors")
want = m.group(1)
bad = []
for d in servers:
    pin = json.load(open(f"{d}/package.json", encoding="utf-8")).get("dependencies", {}).get("@modelcontextprotocol/sdk")
    lock = json.load(open(f"{d}/package-lock.json", encoding="utf-8")).get("packages", {})
    locked = lock.get("node_modules/@modelcontextprotocol/sdk", {}).get("version")
    root = lock.get("", {}).get("dependencies", {}).get("@modelcontextprotocol/sdk")
    if pin != want or root != want or locked != want:
        bad.append(f"{d}: package.json {pin!r}, lockfile root {root!r}, locked {locked!r}")
if bad:
    sys.exit(f"MCP servers must pin @modelcontextprotocol/sdk exactly {want} (the version {mirror} mirrors); update and review the mirror with the pin:\n  " + "\n  ".join(bad))
PY

grep -Fq '"zod": "4.6.7"' "$SERVER_DIR/package.json" || {
  echo "Governance MCP server must pin zod 4.6.7" >&2
  exit 1
}

grep -Fq 'new StdioServerTransport()' "$SERVER_DIR/index.ts" || {
  echo "Governance MCP server must use stdio transport" >&2
  exit 1
}

for tool in evidence_append note_append checkpoint_append task_state_read task_state_update memory_append verification_append state_summary; do
  grep -Fq "\"$tool\"" "$SERVER_DIR/index.ts" || {
    echo "Governance MCP server missing tool: $tool" >&2
    exit 1
  }
  grep -Fq "\"mcp.tool.pi_system_governance_$tool\"" engagement/tool-policy.json || {
    echo "Tool policy missing pi_system_governance mapping for: $tool" >&2
    exit 1
  }
done

grep -Fq 'withFileLock' "$SERVER_DIR/index.ts" || {
  echo "Governance MCP server must lock append paths" >&2
  exit 1
}

grep -Fq 'FIELD_LIMITS' "$SERVER_DIR/index.ts" || {
  echo "Governance MCP server must bound text fields for lightweight-model safety" >&2
  exit 1
}

if [ "${RUN_GOVERNANCE_MCP_SMOKE:-0}" = "1" ]; then
  [ -d "$SERVER_DIR/node_modules" ] || {
    echo "Governance MCP smoke requested but node_modules is absent; run npm ci in $SERVER_DIR" >&2
    exit 1
  }
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' EXIT INT TERM
  (cd "$SERVER_DIR" && PENTEST_DATA_ROOT="$tmp_root" npm run smoke --silent)
  python3 scripts/validate-ledgers.py --data-root "$tmp_root"
else
  echo "Governance MCP static checks passed; set RUN_GOVERNANCE_MCP_SMOKE=1 to run the stdio smoke test"
fi

echo "Governance MCP server checks passed"
