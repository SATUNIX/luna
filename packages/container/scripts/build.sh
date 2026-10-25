#!/usr/bin/env bash
set -euo pipefail
# build.sh — build the pi-agent container image.
#
# Usage:
#   scripts/build.sh --dev                     # dev image (no kit baked in; mount at runtime)
#   scripts/build.sh --release --ref <tag> --sha <commit>   # release image (bakes that kit commit in)
#   scripts/build.sh --release --ref v0.1.0 --sha <40-character commit id of v0.1.0>
#
# Environment:
#   PI_AGENT_IMAGE       image tag (default: pi-system:local)
#   PI_KIT_REPO          kit repo path for pi install git: required for release builds

MODE=""
KIT_REF="main"
KIT_SHA=""
TAG="${PI_AGENT_IMAGE:-pi-system:local}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[build] $*"; }
die() { echo "[build] ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)     MODE=dev; shift ;;
    --release) MODE=release; shift ;;
    --ref)     KIT_REF="$2"; shift 2 ;;
    --sha)     KIT_SHA="$2"; shift 2 ;;
    --tag)     TAG="$2"; shift 2 ;;
    *) die "Unknown arg: $1" ;;
  esac
done

[[ -z "$MODE" ]] && die "Pass --dev or --release"

if [[ "$MODE" == "release" ]]; then
  [[ -n "${PI_KIT_REPO:-}" ]] && KIT_REPO="$PI_KIT_REPO" || die "PI_KIT_REPO is required for release builds"
  [[ "$KIT_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--sha <full commit id of --ref> is required for release builds; the image build checks the clone against it"
  log "Building RELEASE image — kit baked in at ref: ${KIT_REF}"
  docker build \
    --build-arg "BUILD_MODE=release" \
    --build-arg "PI_KIT_REF=${KIT_REF}" \
    --build-arg "PI_KIT_REPO=${KIT_REPO}" \
    --build-arg "PI_KIT_SHA=${KIT_SHA}" \
    -t "$TAG" \
    "$REPO_ROOT"
else
  log "Building DEV image — kit installed at runtime via PI_KIT_PATH"
  docker build \
    --build-arg "BUILD_MODE=dev" \
    -t "$TAG" \
    "$REPO_ROOT"
fi

log "Built: $TAG (mode=$MODE)"
