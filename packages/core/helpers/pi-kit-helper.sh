#!/usr/bin/env bash
# General install/setup/config/update helper for pi-system.
# Usage: helpers/pi-kit-helper.sh [command]
# Run with no command for an interactive menu. See helpers/README.md.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

PROFILES=(quick balanced long-horizon autonomous pentest self-improving lite)
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

c_bold() { printf '\033[1m%s\033[0m\n' "$1"; }
c_err() { printf '\033[31m%s\033[0m\n' "$1" >&2; }
c_ok() { printf '\033[32m%s\033[0m\n' "$1"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    c_err "Missing required command: $1"
    return 1
  fi
}

check_prereqs() {
  c_bold "Checking prerequisites"
  local ok=1
  if require_cmd node; then echo "  node:  $(node --version)"; else ok=0; fi
  if require_cmd git; then echo "  git:   $(git --version)"; else ok=0; fi
  if command -v pi >/dev/null 2>&1; then
    echo "  pi:    $(pi --version 2>/dev/null || echo 'installed, version unknown')"
  else
    echo "  pi:    not installed (see 'update-pi' or 'install')"
  fi
  [ "$ok" = 1 ]
}

cmd_status() {
  check_prereqs
  echo
  c_bold "Repo state"
  echo "  path:   $ROOT"
  echo "  branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  local dirty
  dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  echo "  dirty files: $dirty"
  echo
  c_bold "pi global settings"
  echo "  agent dir: $AGENT_DIR"
  if [ -f "$AGENT_DIR/settings.json" ]; then
    echo "  settings:  $AGENT_DIR/settings.json (exists)"
  else
    echo "  settings:  not found — pi has not been installed/registered yet"
  fi
}

confirm() {
  local prompt="$1"
  read -r -p "$prompt [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

pick_profile() {
  c_bold "profiles" >&2
  local i=1
  for p in "${PROFILES[@]}"; do
    echo "  $i) $p" >&2
    i=$((i + 1))
  done
  read -r -p "Choose a profile [1-${#PROFILES[@]}, default 2=balanced]: " choice
  choice="${choice:-2}"
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#PROFILES[@]}" ]; then
    echo "balanced"
    return
  fi
  echo "${PROFILES[$((choice - 1))]}"
}

cmd_install() {
  check_prereqs || { c_err "Fix the missing prerequisites above, then re-run."; return 1; }
  echo
  echo "Installs this checkout in place (editable). Pick 'lite' for small local models."
  local profile
  profile=$(pick_profile)
  read -r -p "Scope: (g)lobal or (p)roject? [g]: " scope_choice
  scope_choice="${scope_choice:-g}"
  local scope="global"
  [ "$scope_choice" = "p" ] && scope="project"
  echo "Running: node $ROOT/install.ts --profile $profile --scope $scope --dry-run"
  node "$ROOT/install.ts" --profile "$profile" --scope "$scope" --dry-run
  if confirm "Apply this install for real?"; then
    node "$ROOT/install.ts" --profile "$profile" --scope "$scope" --yes
    c_ok "Installed. Run 'pi' then '/reload' if pi was already running, or 'pi list' to confirm."
  else
    echo "Dry run only — nothing changed."
  fi
}

# The pi version this kit is tested against: the exact devDependencies pin in the kit's package.json.
kit_pi_version() {
  node -p 'require(process.argv[1]).devDependencies["@earendil-works/pi-coding-agent"] || ""' "$ROOT/../../package.json" 2>/dev/null
}

cmd_update_pi() {
  c_bold "Updating pi core (@earendil-works/pi-coding-agent)"
  local version
  version=$(kit_pi_version)
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    c_err "Could not read an exact pi version from the kit's package.json (got '${version}'); not installing."
    return 1
  fi
  # The version the kit is tested against, never "latest", and without install scripts.
  echo "Running: npm install -g --ignore-scripts @earendil-works/pi-coding-agent@$version"
  npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$version" || return 1
  pi --version
}

cmd_update_kit() {
  c_bold "Updating the kit"
  local dirty
  dirty=$(git status --porcelain | wc -l | tr -d ' ')
  if [ "$dirty" != "0" ]; then
    c_err "Working tree has $dirty uncommitted change(s). Commit or stash before updating."
    git status --short
    return 1
  fi
  git pull
  local profile
  profile=$(pick_profile)
  echo "Running: node $ROOT/install.ts --profile $profile --yes"
  node "$ROOT/install.ts" --profile "$profile" --yes
  c_ok "Kit updated. Run '/reload' inside pi, or restart pi, then 'pi list' to confirm."
}

cmd_configure() {
  c_bold "Configuring pi-kit environment"
  mkdir -p "$AGENT_DIR"
  local env_file="$AGENT_DIR/.env"
  if [ -f "$env_file" ]; then
    echo "  $env_file already exists — leaving it as is."
  else
    cp "$ROOT/.env.example" "$env_file"
    c_ok "  Created $env_file from .env.example."
  fi
  echo "  Edit $env_file directly to set MEM0_API_KEY, DUAL_REVIEW_MODEL, PI_KIT_MEMORY_BACKEND, etc."
  echo "  Full variable reference: docs/INSTALL.md (Environment variables section)."
  if confirm "Set a firewall policy override (PI_KIT_FIREWALL_POLICY) now?"; then
    read -r -p "  Path to custom policy JSON: " policy_path
    if [ -n "$policy_path" ]; then
      echo "PI_KIT_FIREWALL_POLICY=$policy_path" >> "$env_file"
      c_ok "  Appended PI_KIT_FIREWALL_POLICY to $env_file."
    fi
  fi
}

usage() {
  cat <<'EOF'
pi-kit-helper.sh — install, setup, configure, and update pi-system

Usage:
  helpers/pi-kit-helper.sh [command]

Commands:
  status        Show prerequisite versions, repo state, and current pi registration
  install       Install this checkout with a profile (lite for small local models), interactively
  configure     Scaffold ~/.pi/agent/.env and set common environment variables
  update-kit    git pull + reinstall with a profile
  update-pi     Update the pi core binary (@earendil-works/pi-coding-agent)
  help          Show this message

With no command, shows an interactive menu.
EOF
}

menu() {
  c_bold "pi-system helper"
  echo "1) status"
  echo "2) install"
  echo "3) configure"
  echo "4) update-kit"
  echo "5) update-pi"
  echo "6) help"
  echo "0) exit"
  read -r -p "Choose: " choice
  case "$choice" in
    1) cmd_status ;;
    2) cmd_install ;;
    3) cmd_configure ;;
    4) cmd_update_kit ;;
    5) cmd_update_pi ;;
    6) usage ;;
    0) exit 0 ;;
    *) c_err "Unknown choice." ;;
  esac
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    status) cmd_status ;;
    install) cmd_install ;;
    configure) cmd_configure ;;
    update-kit) cmd_update_kit ;;
    update-pi) cmd_update_pi ;;
    help|-h|--help) usage ;;
    "") menu ;;
    *) c_err "Unknown command: $cmd"; usage; exit 1 ;;
  esac
}

main "$@"
