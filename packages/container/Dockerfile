FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

# pi and pi-mcp-adapter come from tools/package-lock.json (npm ci, below); these two pins must match
# it, and the build fails when they do not (scripts/validate-pentest-env.sh checks the same).
ARG PI_CODING_AGENT_VERSION=1.4.0
ARG PI_MCP_ADAPTER_VERSION=6.0.0
# The npm the base image bundles carries known advisories in its own dependencies (brace-expansion,
# undici, http-cache-semantics); this release does not.
ARG NPM_VERSION=12.2.1
# dev: kit is mounted / installed at runtime via PI_KIT_PATH
# release: kit is baked into the image from git at build time, at PI_KIT_REF, and the build fails
# unless the checked-out commit is exactly PI_KIT_SHA (a full 40-character commit id)
ARG BUILD_MODE=dev
ARG PI_KIT_REPO
ARG PI_KIT_REF=main
ARG PI_KIT_SHA

RUN apk add --no-cache \
    bash \
    ca-certificates \
    coreutils \
    curl \
    fd \
    findutils \
    gawk \
    git \
    grep \
    jq \
    openssh-client \
    py3-pip \
    python3 \
    ripgrep \
    sed \
    tini \
    tmux \
    util-linux \
    yq \
  && update-ca-certificates \
  && npm install -g --ignore-scripts "npm@${NPM_VERSION}" \
  && addgroup -S piagent \
  && adduser -S -D -h /home/piagent -s /bin/bash -G piagent piagent \
  && mkdir -p \
      /workspace \
      /opt/pi-agent \
      /opt/pi-system \
      /srv/data/pi-system \
  && chown -R piagent:piagent \
      /workspace \
      /opt/pi-system \
      /srv/data/pi-system

# pi-mcp-adapter (overlays/pi/mcp-adapter.json) reads only its own config file, never the shared,
# .agents, Pi mcp.json or project MCP files, and registers no `mcp__*` tools beside the `mcp` proxy,
# so every MCP call reaches pentest-governance-domain as an `mcp` call.
ENV PI_MCP_CONFIG_MODE=exclusive \
    MCP_DIRECT_TOOLS=__none__

WORKDIR /workspace

# Both MCP servers commit a package-lock.json, so `npm ci` installs exactly the reviewed tree and
# fails if the lockfile and package.json disagree.
# pi and pi-mcp-adapter: exactly the reviewed tree in tools/package-lock.json, no install scripts,
# owned by root (the agent cannot change them). The adapter is registered in overlays/pi/settings.json
# by this local path, so pi never fetches it from npm at start.
COPY tools/ /opt/pi-agent/tools/
RUN cd /opt/pi-agent/tools \
  && npm ci --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund \
  && test "$(node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version")" = "$PI_CODING_AGENT_VERSION" \
  && test "$(node -p "require('./node_modules/pi-mcp-adapter/package.json').version")" = "$PI_MCP_ADAPTER_VERSION" \
  && ln -s /opt/pi-agent/tools/node_modules/.bin/pi /usr/local/bin/pi \
  && npm cache clean --force

COPY --chown=piagent:piagent mcp-servers/ /opt/pi-agent/mcp-servers/
COPY --chown=piagent:piagent overlays/     /opt/pi-agent/overlays/
COPY --chown=piagent:piagent engagement/   /opt/pi-agent/engagement/
COPY scripts/entrypoint.sh  /usr/local/bin/pi-entrypoint
COPY scripts/pi-agent        /usr/local/bin/pi-agent
COPY scripts/pi-agent-idle   /usr/local/bin/pi-agent-idle
COPY scripts/healthcheck.py  /opt/pi-agent/healthcheck.py

RUN chmod +x /usr/local/bin/pi-entrypoint \
              /usr/local/bin/pi-agent \
              /usr/local/bin/pi-agent-idle \
  && cd /opt/pi-agent/mcp-servers/governance \
  && npm ci --omit=dev --ignore-scripts \
  && cd /opt/pi-agent/mcp-servers/memory-mcp \
  && npm ci --omit=dev --ignore-scripts

USER piagent

# Release mode: bake the kit into the image so no runtime mount is needed.
# Dev mode: kit is installed at container start via PI_KIT_PATH (no-op here).
RUN if [ "$BUILD_MODE" = "release" ]; then \
      set -e; \
      test -n "$PI_KIT_REPO" || { echo "PI_KIT_REPO is required for release builds"; exit 1; }; \
      echo "$PI_KIT_SHA" | grep -Eq '^[0-9a-f]{40}$' || { echo "PI_KIT_SHA (the full commit id of PI_KIT_REF) is required for release builds"; exit 1; }; \
      git clone --depth 1 --branch "$PI_KIT_REF" "$PI_KIT_REPO" /opt/pi-system; \
      test "$(git -C /opt/pi-system rev-parse HEAD)" = "$PI_KIT_SHA" || { echo "PI_KIT_REF $PI_KIT_REF is not PI_KIT_SHA $PI_KIT_SHA"; exit 1; }; \
      cd /opt/pi-system/packages/container/mcp-servers/memory-mcp && npm ci --omit=dev --ignore-scripts; \
      pi install /opt/pi-system; \
      pi list | grep -q "pi-system" || { echo "Kit install verification failed"; exit 1; }; \
    fi

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/pi-entrypoint"]
CMD ["/usr/local/bin/pi-agent-idle"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD python3 /opt/pi-agent/healthcheck.py --check
