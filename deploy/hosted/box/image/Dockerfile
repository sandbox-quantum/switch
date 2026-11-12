# The agent box base image: one container per user with the Switch agent controller, its agent and session hosts, and
# the provider CLIs. Built for linux/arm64 and linux/amd64 by build.sh (stage 1). Dockerfile.controller-update (stage 2)
# then puts the controller package and the entrypoint in, so a controller update never changes anything else.
# Public bases are pinned by digest; CONTROLLER_TGZ is required (the packed switch-agent-controller).
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

ARG CLAUDE_CODE_VERSION=2.1.308
ARG CODEX_VERSION=0.163.0
ARG CONTROLLER_TGZ

# Tools agents expect on a dev box, plus tini as PID 1 to reap the detached
# agent and session hosts. No sudo, no compilers beyond what git needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini ca-certificates git gh openssh-client curl jq ripgrep less procps python3 \
 && rm -rf /var/lib/apt/lists/*

# Provider CLIs and the controller live under /opt, owned by root and
# read-only to the agents. Nothing installs into a home directory.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
RUN test -n "${CONTROLLER_TGZ}" || { echo "CONTROLLER_TGZ is required" >&2; exit 1; }
COPY ${CONTROLLER_TGZ} /tmp/controller.tgz
# The saved-pid code reads start times with `ps -o etime=`. Without procps every saved id reads "unknown"
# and each adopt waits out its 60 s. Fail the build if ps is missing or broken.
RUN ps -o etime= -p 1 >/dev/null && echo "ps check ok"
RUN npm install --global --prefix /opt/switch/providers \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm install --global --prefix /opt/switch/controller /tmp/controller.tgz \
 && rm -f /tmp/controller.tgz \
 && npm cache clean --force \
 && /opt/switch/controller/bin/switch-agent-controller --version \
 && /opt/switch/providers/bin/claude --version \
 && /opt/switch/providers/bin/codex --version

# One unprivileged user for the controller and its agents. Per-agent
# users inside the pod would be a later step (they need CAP_SETUID for the
# controller only). Fixed ids so the volume's files keep their owner.
RUN groupadd --gid 2000 switch \
 && useradd --uid 2000 --gid 2000 --home-dir /data/home --no-create-home \
      --shell /usr/sbin/nologin --comment "Switch agents" switch

COPY --chown=0:0 --chmod=0755 entrypoint.sh /usr/local/bin/switch-box

ENV PATH=/opt/switch/controller/bin:/opt/switch/providers/bin:/usr/local/bin:/usr/bin:/bin \
    HOME=/data/home \
    SWITCH_CONTROLLER_DATA_DIR=/data/controller \
    SWITCH_SESSION_PARK_AFTER_MS=900000 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

USER 2000:2000
# Not /data/home: the runtime would create it as root inside the user's
# volume before the entrypoint runs. The entrypoint makes it and cds there.
WORKDIR /
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/switch-box"]
