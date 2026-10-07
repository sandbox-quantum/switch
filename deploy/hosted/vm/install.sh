#!/bin/sh
# Installs the controller runtime onto a hosted machine image: the accounts,
# the pinned Node.js programs, the boot step, the units, the polkit rule and
# the IMDS rules, then records every artifact digest in
# /etc/switch-hosted/runtime.json (version 2). Safe to run again on an image it
# already set up, including one that started as a worker image.
#
# usage: install.sh <runtime-build-dir> <node-sha256> <provider-sha256>
#   <runtime-build-dir>  output of deploy/hosted/build-runtime.mjs, optionally
#                        with providers.json describing /opt/switch/providers/*
#   <node-sha256>        pin for /opt/switch/node/bin/node
#   <provider-sha256>    pin for /opt/switch/claude/bin/claude
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi
if [ "$#" -ne 3 ]; then
  echo "usage: install.sh <runtime-build-dir> <node-sha256> <provider-sha256>" >&2
  exit 1
fi
runtime_build=$1
expected_node_sha=$2
expected_provider_sha=$3
if [ "${#expected_node_sha}" -ne 64 ] || [ "${#expected_provider_sha}" -ne 64 ]; then
  echo "node and provider SHA256 values must be lowercase 64-character hashes" >&2
  exit 1
fi
case "$expected_node_sha$expected_provider_sha" in
  *[!0-9a-f]*) echo "node and provider SHA256 values must be lowercase 64-character hashes" >&2; exit 1 ;;
esac

for command in python3 lsblk wipefs udevadm mkfs.ext4 mount findmnt sha256sum git systemctl systemd-mount systemd-analyze nft pkaction useradd usermod; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required AMI command: $command" >&2
    exit 1
  }
done
for executable in /usr/bin/lsblk /usr/sbin/wipefs /usr/bin/udevadm /usr/sbin/mkfs.ext4 /usr/bin/findmnt /usr/bin/git /usr/bin/systemctl /usr/bin/systemd-mount /usr/sbin/nft /usr/bin/python3 /usr/bin/unshare /usr/bin/setpriv; do
  [ -x "$executable" ] || {
    echo "the controller runtime requires $executable" >&2
    exit 1
  }
done
# Agents are started through polkit, and only rules.d JavaScript rules (polkit
# 0.106 and later) can scope that to switch-agent@ units.
polkitd_found=
for candidate in /usr/lib/polkit-1/polkitd /usr/libexec/polkitd /usr/lib/policykit-1/polkitd; do
  if [ -x "$candidate" ]; then polkitd_found=$candidate; fi
done
[ -n "$polkitd_found" ] || {
  echo "the controller runtime requires polkitd (install the polkitd package)" >&2
  exit 1
}
polkit_version=$(pkaction --version | awk '{print $NF}')
case "$polkit_version" in
  0.10[0-5]|0.10[0-5].*|0.[0-9]|0.[0-9].*|0.[0-9][0-9]|0.[0-9][0-9].*)
    echo "polkit $polkit_version has no JavaScript rules; the controller runtime needs 0.106 or later" >&2
    exit 1 ;;
esac
pkaction --action-id org.freedesktop.systemd1.manage-units >/dev/null || {
  echo "polkit does not know org.freedesktop.systemd1.manage-units" >&2
  exit 1
}
python3 -c 'import boto3' >/dev/null 2>&1 || {
  echo "missing required AMI Python module: boto3" >&2
  exit 1
}
python3 - "$runtime_build/manifest.json" "$runtime_build" <<'PY'
import hashlib
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
directory = pathlib.Path(sys.argv[2])
manifest = json.loads(manifest_path.read_text())
if (
    set(manifest) != {"version", "nodeMajor", "files"}
    or manifest["version"] != 1
    or manifest["nodeMajor"] != 24
    or set(manifest["files"])
    != {
        "hosted-bootstrap.mjs",
        "shared-host-daemon.mjs",
        "switch-agent-controller.mjs",
    }
):
    raise SystemExit("hosted runtime manifest is invalid")
for name, expected in manifest["files"].items():
    if not isinstance(expected, str) or len(expected) != 64:
        raise SystemExit("hosted runtime manifest digest is invalid")
    actual = hashlib.sha256((directory / name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"hosted runtime digest mismatch: {name}")
PY

if ! id switch-agent >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin switch-agent
fi
if ! id switch-controller >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin switch-controller
fi
usermod -aG switch-agent switch-controller
agent_uid=$(id -u switch-agent)
agent_gid=$(id -g switch-agent)
controller_uid=$(id -u switch-controller)
controller_gid=$(id -g switch-controller)
if [ "$agent_uid" -eq 0 ] || [ "$agent_gid" -eq 0 ] || [ "$(id -G switch-agent)" != "$agent_gid" ]; then
  echo "switch-agent must have one non-root primary group and no supplementary groups" >&2
  exit 1
fi
if [ "$controller_uid" -eq 0 ] || [ "$controller_gid" -eq 0 ] || [ "$controller_uid" -eq "$agent_uid" ] || [ "$controller_gid" -eq "$agent_gid" ]; then
  echo "switch-controller must be a distinct non-root account with its own primary group" >&2
  exit 1
fi
if [ "$(id -G switch-controller | tr ' ' '\n' | sort -n | tr '\n' ' ')" != "$(printf '%s\n%s\n' "$controller_gid" "$agent_gid" | sort -n | tr '\n' ' ')" ]; then
  echo "switch-controller must have switch-agent as its only supplementary group" >&2
  exit 1
fi

# A worker image carries the worker supervisor, which would fight the
# controller for the same volume and units.
if [ -e /etc/systemd/system/switch-hosted-worker.service ]; then
  systemctl disable --now switch-hosted-worker.service || true
  rm -f /etc/systemd/system/switch-hosted-worker.service
fi
rm -f /usr/local/libexec/switch-hosted-worker

install -d -o root -g root -m 0755 /usr/local/libexec
install -d -o root -g root -m 0755 /etc/switch-hosted
install -d -o root -g root -m 0755 /etc/nftables.d
install -d -o root -g root -m 0755 /opt/switch/agent-providers
install -d -o root -g root -m 0755 /opt/switch/controller
install -d -o root -g root -m 0755 /data
[ -d /etc/polkit-1/rules.d ] || install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
install -o root -g root -m 0755 "$runtime_build/shared-host-daemon.mjs" /opt/switch/agent-providers/shared-host-daemon.mjs
install -o root -g root -m 0755 "$runtime_build/hosted-bootstrap.mjs" /opt/switch/agent-providers/hosted-bootstrap.mjs
install -o root -g root -m 0444 "$runtime_build/manifest.json" /opt/switch/agent-providers/manifest.json
install -o root -g root -m 0755 "$runtime_build/switch-agent-controller.mjs" /opt/switch/controller/switch-agent-controller.mjs

node_path=/opt/switch/node/bin/node
provider_path=/opt/switch/claude/bin/claude
node_version=$("$node_path" --version)
case "$node_version" in
  v24.*) ;;
  *) echo "pinned AMI must contain Node.js 24, got $node_version" >&2; exit 1 ;;
esac
actual_node_sha=$(sha256sum "$node_path" | cut -d ' ' -f 1)
actual_provider_sha=$(sha256sum "$provider_path" | cut -d ' ' -f 1)
[ "$actual_node_sha" = "$expected_node_sha" ] || {
  echo "Node.js checksum does not match the image-build pin" >&2
  exit 1
}
[ "$actual_provider_sha" = "$expected_provider_sha" ] || {
  echo "provider checksum does not match the image-build pin" >&2
  exit 1
}
"$node_path" /opt/switch/controller/switch-agent-controller.mjs --version </dev/null >/dev/null || {
  echo "switch-agent-controller.mjs does not run on the pinned Node.js" >&2
  exit 1
}

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -o root -g root -m 0755 "$source_dir/switch_machine_boot.py" /usr/local/libexec/switch-machine-boot
install -o root -g root -m 0644 "$source_dir/switch-machine-boot.service" /etc/systemd/system/switch-machine-boot.service
install -o root -g root -m 0644 "$source_dir/switch-controller.service" /etc/systemd/system/switch-controller.service
install -o root -g root -m 0644 "$source_dir/switch-agent@.service" /etc/systemd/system/switch-agent@.service
install -o root -g root -m 0755 "$source_dir/switch-agent-init" /usr/local/libexec/switch-agent-init
install -o root -g root -m 0644 "$source_dir/switch-agents.slice" /etc/systemd/system/switch-agents.slice
install -o root -g root -m 0644 "$source_dir/50-switch-controller.rules" /etc/polkit-1/rules.d/50-switch-controller.rules
install -o root -g root -m 0644 "$source_dir/switch-imds.nft" /etc/nftables.d/switch-imds.nft
nft -c -f /etc/nftables.d/switch-imds.nft
systemd-analyze verify /etc/systemd/system/switch-machine-boot.service /etc/systemd/system/switch-controller.service /etc/systemd/system/switch-agents.slice

shared_sha=$(sha256sum /opt/switch/agent-providers/shared-host-daemon.mjs | cut -d ' ' -f 1)
bootstrap_sha=$(sha256sum /opt/switch/agent-providers/hosted-bootstrap.mjs | cut -d ' ' -f 1)
controller_sha=$(sha256sum /opt/switch/controller/switch-agent-controller.mjs | cut -d ' ' -f 1)
boot_sha=$(sha256sum /usr/local/libexec/switch-machine-boot | cut -d ' ' -f 1)
python3 - "$actual_node_sha" "$shared_sha" "$bootstrap_sha" "$controller_sha" "$boot_sha" "$actual_provider_sha" "$runtime_build" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

node_sha, shared_sha, bootstrap_sha, controller_sha, boot_sha, provider_sha, runtime_build = sys.argv[1:]
value = {
    "version": 2,
    "nodePath": "/opt/switch/node/bin/node",
    "controllerPath": "/opt/switch/controller/switch-agent-controller.mjs",
    "sharedHostDaemonPath": "/opt/switch/agent-providers/shared-host-daemon.mjs",
    "bootstrapPath": "/opt/switch/agent-providers/hosted-bootstrap.mjs",
    "bootPath": "/usr/local/libexec/switch-machine-boot",
    "providerBinaryPath": "/opt/switch/claude/bin/claude",
    "controllerUser": "switch-controller",
    "agentUser": "switch-agent",
    "agentGroup": "switch-agent",
    "path": "/opt/switch/node/bin:/opt/switch/claude/bin:/usr/local/bin:/usr/bin:/bin",
    "allowInitialFormat": True,
    "artifactSha256": {
        "node": node_sha,
        "sharedHostDaemon": shared_sha,
        "bootstrap": bootstrap_sha,
        "controller": controller_sha,
        "boot": boot_sha,
        "provider": provider_sha,
    },
}
providers_path = Path(runtime_build) / "providers.json"
if providers_path.exists():
    providers = json.loads(providers_path.read_text())
    if not isinstance(providers, dict) or not set(providers).issubset({"codex", "cursor", "opencode", "antigravity"}):
        raise SystemExit("Invalid provider manifest")
    for provider, artifact in providers.items():
        if not isinstance(artifact, dict) or set(artifact) != {"path", "sha256"} or artifact["path"] != f"/opt/switch/providers/{'antigravity-acp' if provider == 'antigravity' else provider}":
            raise SystemExit("Invalid provider artifact path")
        path = Path(artifact["path"])
        details = path.lstat()
        if not stat.S_ISREG(details.st_mode) or details.st_uid != 0 or details.st_mode & 0o022 or not details.st_mode & 0o111:
            raise SystemExit("Provider artifact must be a root-owned executable, not a symlink")
        if hashlib.sha256(path.read_bytes()).hexdigest() != artifact["sha256"]:
            raise SystemExit("Provider artifact digest mismatch")
    value["providers"] = providers
directory = "/etc/switch-hosted"
descriptor, temporary = tempfile.mkstemp(prefix=".runtime.", dir=directory)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, f"{directory}/runtime.json")
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY

if [ -x /opt/switch/provider-runtime/codex/codex-resources/bwrap ] && [ -d /sys/kernel/security/apparmor ]; then
  command -v apparmor_parser >/dev/null 2>&1 || {
    echo "Codex sandbox requires apparmor_parser on an AppArmor host" >&2
    exit 1
  }
  install -o root -g root -m 0644 "$source_dir/switch-codex-bwrap.apparmor" /etc/apparmor.d/switch-codex-bwrap
  apparmor_parser --replace /etc/apparmor.d/switch-codex-bwrap
fi

systemctl daemon-reload
systemctl enable switch-machine-boot.service switch-controller.service
