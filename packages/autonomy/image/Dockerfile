# Image for autonomous runs (docs/autonomy.md). Built on the host by packages/autonomy/build-image.sh,
# which has network; the containers made from it have none (the worker reaches only the inference
# relay, and the egress proxy for hosts the run contract lists). Everything a run needs offline is
# baked in: pi, the kit at a release tag with the long-horizon profile, and, when a base ref is
# given, that repository's npm dependencies (as an npm cache) plus mkdocs and gitleaks.
# Add the toolchains your tasks need (a compiler, python packages, ...) in a derived image and
# name it in the contract's runtime.image.
#
# Build context (assembled by build-image.sh):
#   kit/    `git archive` of the kit release tag the harness runs (read-only at runtime)
#   base/   OPTIONAL: `git archive` of the base ref's package.json, lockfile and docs requirements
#           (dependency prebake only; empty when no base ref is given)
#   image/  this directory
# Base images are pinned by digest in the FROM lines themselves, where Dependabot can see and update
# them; the tag beside each digest says what it is.

# gitleaks is built from its release source rather than copied from the upstream image: the
# v8.30.1 release binary was built with Go 1.24.13 and carries known stdlib, x/crypto, x/text and
# klauspost/compress advisories. The build uses the pinned Go toolchain and moves only those three
# modules to their newest releases; every module is checked against the Go checksum database.
FROM docker.io/library/golang:1.27-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS gitleaks
ARG GITLEAKS_VERSION=v8.30.1
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-trimpath
RUN go mod download -json "github.com/zricethezav/gitleaks/v8@${GITLEAKS_VERSION}" > /tmp/mod.json \
  && src="$(sed -n 's/^[[:space:]]*"Dir": "\(.*\)",$/\1/p' /tmp/mod.json)" \
  && cp -r "$src" /src && chmod -R u+w /src && cd /src \
  && go get golang.org/x/crypto@v0.58.0 golang.org/x/text@v0.43.0 github.com/klauspost/compress@v1.20.3 \
  && go build -ldflags "-s -w -X github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_VERSION}" -o /usr/bin/gitleaks . \
  && /usr/bin/gitleaks version

FROM docker.io/library/node:26-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec
ARG PI_VERSION=1.4.0
# The npm the base image bundles carries known advisories in its own dependencies (brace-expansion,
# undici, http-cache-semantics); this release does not.
ARG NPM_VERSION=12.2.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl fd-find git jq procps python3 python3-venv ripgrep shellcheck tini \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && npm install -g --ignore-scripts "npm@${NPM_VERSION}" \
  && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && npm cache clean --force

COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks

# pi-lens (in the long-horizon profile) installs its linters and language servers with npm the
# first time a file type is touched. Offline, npm retries and stalls the tool call, so the ones
# common file types use are installed here, on PATH, where pi-lens finds them.
# Each tool is pinned exactly. TypeScript stays on 6.x: the 7.x package ships no tsserver, which
# typescript-language-server needs.
RUN npm install -g --ignore-scripts typescript@6.0.3 typescript-language-server@6.0.2 markdownlint-cli2@0.24.0 \
      bash-language-server@5.8.1 yaml-language-server@2.0.0 vscode-langservers-extracted@4.10.0 \
      @biomejs/biome@2.6.2 prettier@3.9.10 knip@6.42.1 madge@8.0.0 jscpd@5.4.2 \
  && npm cache clean --force

# The harness: the kit release, installed locally into a template agent dir with the
# long-horizon profile. The entrypoint copies the template to the run's writable state once.
COPY kit/ /opt/pi-kit/
RUN cd /opt/pi-kit && npm ci --ignore-scripts --no-audit --no-fund \
  && HOME=/opt/pi-home PI_CODING_AGENT_DIR=/opt/pi-agent PI_KIT_UPDATE_CHECK=0 \
     node packages/core/install.ts --profile long-horizon --mode local --yes \
  && chmod -R a+rX /opt/pi-kit /opt/pi-agent /opt/pi-home

# Optional prebake of one repository's dependencies, from the base ref's lockfile: `npm ci --offline`
# in the workspace and in a check resolves from it. A branch that changes dependencies fails its
# offline install, which the charter asks workers to avoid. No base ref, no prebake.
COPY base/ /opt/base/
RUN if [ -f /opt/base/package-lock.json ]; then cd /opt/base && npm ci --ignore-scripts --no-audit --no-fund --cache /opt/npm-cache; fi \
  && if [ -f /opt/base/requirements-docs.txt ]; then python3 -m venv /opt/docs-venv && /opt/docs-venv/bin/pip install --no-cache-dir -r /opt/base/requirements-docs.txt; fi \
  && rm -rf /opt/base && if [ -d /opt/npm-cache ]; then chmod -R a+rX /opt/npm-cache; fi
ENV PATH=/opt/docs-venv/bin:$PATH

COPY image/entrypoint.sh /opt/autonomy/entrypoint.sh
COPY image/gate.sh /opt/autonomy/gate.sh
RUN chmod 0555 /opt/autonomy/*.sh

ENV PI_OFFLINE=1 PI_TELEMETRY=0 PI_KIT_UPDATE_CHECK=0 NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# Non-root by default; the supervisor also sets --user explicitly (the operator's uid:gid, so
# bind-mounted run files stay theirs).
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/autonomy/entrypoint.sh"]
CMD ["agent"]
