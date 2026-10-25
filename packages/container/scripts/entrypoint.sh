#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${PI_AGENT_DATA_ROOT:-/srv/data/pi-system}"
PI_DIR="${PI_CODING_AGENT_DIR:-${DATA_ROOT}/pi-agent}"
SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-${DATA_ROOT}/sessions}"

log() { echo "[pi-entrypoint] $*"; }

# Create required directories
for d in "$DATA_ROOT" "$PI_DIR" "$SESSION_DIR" "${DATA_ROOT}/home"; do
  if [ ! -d "$d" ]; then
    mkdir -p "$d" || { log "WARN: could not create $d"; }
  fi
done

# Seed pi config from overlays. pi reads its config from PI_CODING_AGENT_DIR when that is set, so
# seed there ($PI_DIR), not $HOME/.pi/agent. settings.json and models.json are seeded once (the
# operator may tune them). mcp-adapter.json is a security control (which MCP servers exist, and the
# proxy-only, no-install, no-auto-auth settings), so the image's copy replaces the live one at EVERY
# start: an edit made in the writable agent dir never becomes the next session's baseline.
PI_CONFIG_DIR="$PI_DIR"
OVERLAY_DIR="${PI_AGENT_OVERLAY_DIR:-/opt/pi-agent/overlays/pi}"
ADAPTER_PATH="${PI_MCP_ADAPTER_PATH:-/opt/pi-agent/tools/node_modules/pi-mcp-adapter}"
mkdir -p "$PI_CONFIG_DIR"

for f in settings.json models.json; do
  src="$OVERLAY_DIR/$f"
  dst="$PI_CONFIG_DIR/$f"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    log "Seeded $dst"
  fi
done

src="$OVERLAY_DIR/mcp-adapter.json"
dst="$PI_CONFIG_DIR/mcp-adapter.json"
if [ -f "$src" ]; then
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then
    log "WARN: $dst differed from the image's overlay; replaced it (the previous copy is $dst.replaced)"
    cp "$dst" "$dst.replaced"
  fi
  cp "$src" "$dst.tmp" && mv -f "$dst.tmp" "$dst"
fi

# A settings.json seeded by an older image registers the adapter from npm, which pi then fetches at
# start with no lockfile. Point it at the copy baked into the image, and keep Pi's built-in MCP off.
if [ -f "$PI_CONFIG_DIR/settings.json" ] && ! command -v jq >/dev/null 2>&1; then
  log "WARN: jq not found; $PI_CONFIG_DIR/settings.json was not checked for an npm pi-mcp-adapter entry"
elif [ -f "$PI_CONFIG_DIR/settings.json" ]; then
  if jq -e --arg p "$ADAPTER_PATH" '(.packages // []) as $pk | ($pk | index($p)) != null and ([$pk[] | select(type == "string" and startswith("npm:pi-mcp-adapter@"))] | length) == 0 and ((.extensions // []) | index("-builtin:mcp")) != null' "$PI_CONFIG_DIR/settings.json" >/dev/null 2>&1; then
    :
  elif jq --arg p "$ADAPTER_PATH" '.packages = ([(.packages // [])[] | select(type != "string" or (startswith("npm:pi-mcp-adapter@") | not))] | if index($p) then . else . + [$p] end) | .extensions = ((.extensions // []) | if index("-builtin:mcp") then . else . + ["-builtin:mcp"] end)' "$PI_CONFIG_DIR/settings.json" >"$PI_CONFIG_DIR/settings.json.tmp" 2>/dev/null; then
    mv -f "$PI_CONFIG_DIR/settings.json.tmp" "$PI_CONFIG_DIR/settings.json"
    log "Pointed settings.json at the image's pi-mcp-adapter ($ADAPTER_PATH)"
  else
    rm -f "$PI_CONFIG_DIR/settings.json.tmp"
    log "WARN: could not update $PI_CONFIG_DIR/settings.json (not valid JSON?)"
  fi
fi

log "Data root: $DATA_ROOT"
log "Pi config: $PI_CONFIG_DIR"
log "Sessions:  $SESSION_DIR"

exec "$@"
