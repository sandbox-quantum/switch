#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi
if [ "$#" -ne 4 ]; then
  echo "usage: install.sh <runtime-build-dir> <node-sha256> <provider-sha256> <pinned-mcp-runtime>" >&2
  exit 1
fi
runtime_build=$1
expected_node_sha=$2
expected_provider_sha=$3
pinned_mcp_runtime=$4
if [ "${#expected_node_sha}" -ne 64 ] || [ "${#expected_provider_sha}" -ne 64 ]; then
  echo "node and provider SHA256 values must be lowercase 64-character hashes" >&2
  exit 1
fi
case "$expected_node_sha$expected_provider_sha" in
  *[!0-9a-f]*) echo "node and provider SHA256 values must be lowercase 64-character hashes" >&2; exit 1 ;;
esac
python3 - "$pinned_mcp_runtime" <<'PY'
import re
import sys
package = chr(64) + "sandboxaq/switch-agent-runtime" + chr(64)
if not re.fullmatch(re.escape(package) + r"[0-9]+[.][0-9]+[.][0-9]+", sys.argv[1]):
    raise SystemExit("MCP runtime must be an exact stable published version")
PY

for command in python3 setpriv lsblk wipefs mkfs.ext4 mount findmnt sha256sum git gh; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required AMI command: $command" >&2
    exit 1
  }
done
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
    or set(manifest["files"]) != {"hosted-bootstrap.mjs", "shared-host-daemon.mjs"}
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
agent_uid=$(id -u switch-agent)
agent_gid=$(id -g switch-agent)
if [ "$agent_uid" -eq 0 ] || [ "$agent_gid" -eq 0 ] || [ "$(id -G switch-agent)" != "$agent_gid" ]; then
  echo "switch-agent must have one non-root primary group and no supplementary groups" >&2
  exit 1
fi
install -d -o root -g root -m 0755 /usr/local/libexec
install -d -o root -g root -m 0755 /etc/switch-hosted
install -d -o root -g root -m 0755 /opt/switch/agent-providers
install -d -o root -g root -m 0755 /data
install -o root -g root -m 0755 "$runtime_build/hosted-bootstrap.mjs" /opt/switch/agent-providers/hosted-bootstrap.mjs
install -o root -g root -m 0755 "$runtime_build/shared-host-daemon.mjs" /opt/switch/agent-providers/shared-host-daemon.mjs
install -o root -g root -m 0444 "$runtime_build/manifest.json" /opt/switch/agent-providers/manifest.json

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
bootstrap_sha=$(sha256sum /opt/switch/agent-providers/hosted-bootstrap.mjs | cut -d ' ' -f 1)
shared_sha=$(sha256sum /opt/switch/agent-providers/shared-host-daemon.mjs | cut -d ' ' -f 1)

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -o root -g root -m 0755 "$source_dir/switch_hosted_worker.py" /usr/local/libexec/switch-hosted-worker
install -o root -g root -m 0644 "$source_dir/switch-hosted-worker.service" /etc/systemd/system/switch-hosted-worker.service
python3 - "$actual_node_sha" "$bootstrap_sha" "$shared_sha" "$actual_provider_sha" "$pinned_mcp_runtime" <<'PY'
import json
import os
import sys
import tempfile

node_sha, bootstrap_sha, shared_sha, provider_sha, mcp_runtime = sys.argv[1:]
value = {
    "version": 1,
    "nodePath": "/opt/switch/node/bin/node",
    "bootstrapPath": "/opt/switch/agent-providers/hosted-bootstrap.mjs",
    "sharedHostDaemonPath": "/opt/switch/agent-providers/shared-host-daemon.mjs",
    "providerBinaryPath": "/opt/switch/claude/bin/claude",
    "agentUser": "switch-agent",
    "agentGroup": "switch-agent",
    "path": "/opt/switch/node/bin:/opt/switch/claude/bin:/usr/local/bin:/usr/bin:/bin",
    "mcpRuntime": mcp_runtime,
    "allowInitialFormat": True,
    "artifactSha256": {
        "node": node_sha,
        "bootstrap": bootstrap_sha,
        "sharedHostDaemon": shared_sha,
        "provider": provider_sha,
    },
}
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

systemctl daemon-reload
systemctl enable switch-hosted-worker.service
