# The cloud machine the gate runs on: Ubuntu 24.04 with systemd as PID 1, the
# packages the controller runtime's install.sh requires, Node 24 from the
# official tarball, and a Python environment with Core's dependencies (for the
# stub Core, which seals with Core's own code) and moto (KMS and Secrets
# Manager). The repository is mounted at /src at run time, not copied in.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus polkitd nftables \
      python3 python3-boto3 python3-venv \
      git gh curl ca-certificates openssl iproute2 util-linux e2fsprogs udev \
      xz-utils procps jq openssh-server \
 && rm -rf /var/lib/apt/lists/*

# Node 24, checked against the release's SHASUMS256.txt.
RUN set -eu; \
    arch=$(dpkg --print-architecture | sed -e 's/amd64/x64/'); \
    base=https://nodejs.org/dist/latest-v24.x; \
    cd /tmp; \
    curl -fsSLO "$base/SHASUMS256.txt"; \
    tarball=$(grep -o "node-v24\.[0-9.]*-linux-$arch\.tar\.xz" SHASUMS256.txt | head -1); \
    curl -fsSLO "$base/$tarball"; \
    grep " $tarball\$" SHASUMS256.txt | sha256sum -c -; \
    mkdir -p /opt/switch/node; \
    tar -xJf "$tarball" -C /opt/switch/node --strip-components=1 --no-same-owner; \
    rm -f "$tarball" SHASUMS256.txt; \
    /opt/switch/node/bin/node --version

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock /opt/cc-gate/core/
RUN cd /opt/cc-gate/core \
 && UV_PROJECT_ENVIRONMENT=/opt/cc-gate/venv uv sync --frozen --no-install-project --no-dev --python /usr/bin/python3 \
 && uv pip install --python /opt/cc-gate/venv/bin/python 'moto[server]>=5,<6'

# The image boots to systemd; nothing of Switch is installed until the gate runs.
# Mask systemd-binfmt and proc-sys-fs-binfmt_misc mounts to prevent the container
# from clearing the host VM's binfmt_misc registrations (which breaks amd64
# emulation for all other docker builds on Mac).
RUN systemctl mask systemd-firstboot.service getty.target console-getty.service \
 && systemctl mask systemd-binfmt.service \
 && systemctl mask proc-sys-fs-binfmt_misc.automount \
 && systemctl mask proc-sys-fs-binfmt_misc.mount \
 && systemctl disable ssh.service ssh.socket 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
