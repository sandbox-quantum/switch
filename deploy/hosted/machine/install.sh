#!/bin/sh
# Bakes a Switch cloud machine image that runs the agents controller.
#
#   install.sh <switch-agent-controller .tgz> <node-sha256> [agent-users]
#
# Run as root while the AMI is built, after Node.js 24 is at /opt/switch/node
# and the provider CLIs are under /opt/switch (never under a home directory:
# agents run as users of their own and cannot reach one). It installs the
# controller at /opt/switch/controller, makes the controller's user and the
# agents' users and group with fixed ids (the data volume outlives the root
# volume, so its files must keep meaning the same users on every instance),
# and installs the boot service that mounts the data volume and starts the
# controller (switch_machine_boot.py).
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: install.sh <switch-agent-controller .tgz> <node-sha256> [agent-users]" >&2
  exit 1
fi
controller_package=$1
expected_node_sha=$2
agent_users=${3:-16}
case "$agent_users" in
  ''|*[!0-9]*) echo "agent-users must be a number from 1 to 99" >&2; exit 1 ;;
esac
if [ "$agent_users" -lt 1 ] || [ "$agent_users" -gt 99 ]; then
  echo "agent-users must be a number from 1 to 99" >&2
  exit 1
fi
case "$expected_node_sha" in
  *[!0-9a-f]*|'') echo "node-sha256 must be a lowercase SHA-256" >&2; exit 1 ;;
esac
[ "${#expected_node_sha}" -eq 64 ] || { echo "node-sha256 must be a lowercase SHA-256" >&2; exit 1; }

for command in python3 lsblk wipefs udevadm mkfs.ext4 findmnt systemd-mount systemctl runuser useradd groupadd getent find chown pkaction; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required image command: $command" >&2
    exit 1
  }
done
[ -d /etc/polkit-1/rules.d ] || { echo "polkit (polkitd) must be installed" >&2; exit 1; }
python3 -c 'import boto3' >/dev/null 2>&1 || {
  echo "missing required image Python module: boto3" >&2
  exit 1
}

node=/opt/switch/node/bin/node
case "$("$node" --version)" in
  v24.*) ;;
  *) echo "the image must carry Node.js 24 at $node" >&2; exit 1 ;;
esac
[ "$(sha256sum "$node" | cut -d ' ' -f 1)" = "$expected_node_sha" ] || {
  echo "Node.js does not match the image-build pin" >&2
  exit 1
}

# The ids every instance of this image uses: see the header.
controller_uid=2000
agents_gid=2001
first_agent_uid=2101
controller_user=switch-controller
agents_group="switch-agents-$controller_uid"
if ! getent passwd "$controller_user" >/dev/null; then
  groupadd --system --gid "$controller_uid" "$controller_user"
  useradd --system --uid "$controller_uid" --gid "$controller_uid" \
    --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
    --comment "Switch agents controller" "$controller_user"
fi
[ "$(id -u "$controller_user")" -eq "$controller_uid" ] || {
  echo "$controller_user exists with another uid than $controller_uid" >&2
  exit 1
}
if ! getent group "$agents_group" >/dev/null; then
  groupadd --system --gid "$agents_gid" "$agents_group"
fi
slot=1
while [ "$slot" -le "$agent_users" ]; do
  name=$(printf 'sa%s-%02d' "$controller_uid" "$slot")
  if ! getent passwd "$name" >/dev/null; then
    useradd --system --uid "$((first_agent_uid + slot - 1))" --gid "$agents_group" \
      --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
      --comment "Switch agent" "$name"
  fi
  slot=$((slot + 1))
done

install -d -o root -g root -m 0755 /opt/switch/controller /usr/local/libexec /etc/switch-hosted /data
PATH="/opt/switch/node/bin:$PATH" npm install --global --prefix /opt/switch/controller "$controller_package"
cli=/opt/switch/controller/bin/switch-agent-controller
"$cli" --version >/dev/null

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -o root -g root -m 0755 "$source_dir/switch_machine_boot.py" /usr/local/libexec/switch-machine-boot
install -o root -g root -m 0644 "$source_dir/switch-machine-boot.service" /etc/systemd/system/switch-machine-boot.service
install -d -o root -g root -m 0755 "/etc/systemd/system/switch-agent-controller-$controller_uid.service.d"
install -o root -g root -m 0644 "$source_dir/controller-after-boot.conf" \
  "/etc/systemd/system/switch-agent-controller-$controller_uid.service.d/after-boot.conf"

provider_path=$(find /opt/switch -mindepth 2 -maxdepth 3 -type d -name bin ! -path '/opt/switch/controller/*' | sort | tr '\n' ':')
cat > /etc/switch-hosted/machine.json <<EOF
{
  "version": 1,
  "controllerUser": "$controller_user",
  "cli": "$cli",
  "path": "${provider_path}/usr/local/bin:/usr/bin:/bin",
  "agentUsers": $agent_users
}
EOF
chmod 0644 /etc/switch-hosted/machine.json

systemctl daemon-reload
systemctl enable switch-machine-boot.service
echo "Baked: the controller $("$cli" --version), $agent_users agent users, the boot service."
