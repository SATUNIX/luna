#!/usr/bin/env bash
# Build the autonomy image from local git objects (no clone, no credentials in the image):
#   packages/autonomy/build-image.sh [--kit-ref v<version>] [--base-ref origin/main] [--tag pi-autonomy:local] [--engine podman|docker] [--print-kit-ref]
# The kit ref is the harness the worker runs. It defaults to the release tag of this checkout's
# package.json version (v<version>), so a build without the flag never ships an older firewall and
# containment than the checkout it was started from; --print-kit-ref prints the ref and builds
# nothing (tests/autonomy-build-image-smoke.ts). The base ref is OPTIONAL: when given, its lockfile's
# dependencies (and docs requirements) are prebaked for offline installs; without it the image
# carries no repository-specific dependencies. Fetch the refs first (git fetch --tags origin).
set -euo pipefail
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
version="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$repo/package.json" | head -n 1)"
[ -n "$version" ] || { echo "cannot read the version from $repo/package.json" >&2; exit 2; }
kit_ref="v$version"; base_ref=""; tag=pi-autonomy:local; engine=podman; print_ref=0
while [ $# -gt 0 ]; do
  case "$1" in
    --kit-ref) kit_ref="$2"; shift 2 ;;
    --print-kit-ref) print_ref=1; shift ;;
    --base-ref) base_ref="$2"; shift 2 ;;
    --tag) tag="$2"; shift 2 ;;
    --engine) engine="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if [ "$print_ref" = 1 ]; then echo "$kit_ref"; exit 0; fi
git -C "$repo" rev-parse --verify --quiet "$kit_ref^{commit}" >/dev/null \
  || { echo "kit ref $kit_ref is not in this clone: fetch the release tags (git fetch --tags origin) or pass --kit-ref" >&2; exit 2; }
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
mkdir -p "$ctx/kit" "$ctx/base"
git -C "$repo" archive --format=tar "$kit_ref" | tar -x -C "$ctx/kit"
labels=(--label "pi-autonomy.kit-ref=$kit_ref" --label "pi-autonomy.kit-sha=$(git -C "$repo" rev-parse "$kit_ref^{commit}")")
if [ -n "$base_ref" ]; then
  # Only the dependency manifests that exist at that ref (a repository need not have every one).
  paths="$(git -C "$repo" ls-tree -r --name-only "$base_ref" | grep -E '^(package\.json|package-lock\.json|requirements-docs\.txt|packages/[^/]+/package\.json)$' || true)"
  # shellcheck disable=SC2086
  [ -z "$paths" ] || git -C "$repo" archive --format=tar "$base_ref" -- $paths | tar -x -C "$ctx/base"
  labels+=(--label "pi-autonomy.base-sha=$(git -C "$repo" rev-parse "$base_ref^{commit}")")
fi
cp -r "$repo/packages/autonomy/image" "$ctx/image"
"$engine" build -f "$ctx/image/Dockerfile" -t "$tag" "${labels[@]}" "$ctx"
echo "built $tag with $engine (kit $kit_ref${base_ref:+, dependencies from $base_ref})"
