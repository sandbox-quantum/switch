#!/bin/bash
# Runs inside the gate container (systemd as PID 1). Turns it into a cloud
# machine on the controller runtime: a loop device stands in for the EBS data
# volume, a fake IMDS for the instance metadata service, moto for KMS and
# Secrets Manager, and a stub Core for Switch. Then installs the runtime with
# the real install.sh, lays out a per-user-v1 volume as the worker runtime left
# it, and boots the machine through the real switch-machine-boot with a v3
# bundle (its --bundle-file test hook) and the real switch-controller.
set -euo pipefail
source /src/deploy/hosted/vm/gate/container/gate.env
GATE_LIB=/usr/local/lib/cc-gate
VENV=/opt/cc-gate/venv

step() { printf '\n== %s\n' "$*"; }
admin() { curl -fsS -X POST -H 'Content-Type: application/json' --data "$2" "$STUB_ADMIN$1"; }
wait_for() {
  local what=$1 tries=$2; shift 2
  for _ in $(seq "$tries"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "timed out waiting for $what" >&2
  return 1
}

step "waiting for systemd"
for _ in $(seq 60); do
  state=$(systemctl is-system-running 2>/dev/null || true)
  case "$state" in running|degraded) break ;; esac
  sleep 1
done
echo "systemd: $state"
# Docker mounts / and the --tmpfs /run private. systemd moves each unit's
# credentials mount into /run/credentials from a child namespace, so without
# shared propagation LoadCredential= hands units an empty directory. On a real
# machine systemd makes / shared at boot.
mount --make-rshared /

# With --cgroupns=host systemd runs in /docker/<id>, but docker exec drops its
# processes into that same cgroup, and cgroup v2 refuses to enable a controller
# for children of a cgroup that holds processes. So systemd never gets the
# memory controller, and MemoryMax= is silently not enforced. Move the
# processes into init.scope (where docker exec falls back to once the root is
# closed to processes) and hand the memory and pids controllers down.
step "delegating the memory controller to systemd"
cgroup_root=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/1/cgroup | sed 's#/init.scope$##')
for _ in $(seq 10); do
  while read -r pid; do echo "$pid" >"$cgroup_root/init.scope/cgroup.procs" 2>/dev/null || true; done <"$cgroup_root/cgroup.procs"
  echo "+memory +pids" >"$cgroup_root/cgroup.subtree_control" 2>/dev/null && break
  sleep 1
done
grep -qw memory "$cgroup_root/cgroup.subtree_control" || { echo "could not enable the memory controller under $cgroup_root" >&2; exit 1; }
systemctl daemon-reload

step "gate helpers"
install -d -m 0755 "$GATE_LIB" /etc/cc-gate /var/lib/cc-gate
for file in fake_imds.py stub_core.py aws_setup.py kms_endpoint.py fake_claude.py; do
  install -m 0755 "$GATE_DIR/$file" "$GATE_LIB/$file"
done
install -d -m 0755 /opt/switch/claude/bin
install -o root -g root -m 0755 "$GATE_DIR/fake_claude.py" /opt/switch/claude/bin/claude
if [ ! -e /usr/bin/lsblk.real ]; then
  mv /usr/bin/lsblk /usr/bin/lsblk.real
fi
install -m 0755 "$GATE_DIR/lsblk-wrapper" /usr/bin/lsblk

step "data volume (loop device)"
if ! mountpoint -q /data; then
  truncate -s 1G /var/lib/cc-gate/data.img
  loop=$(losetup -f --show /var/lib/cc-gate/data.img)
  echo "$loop" >/etc/cc-gate/loop-device
  mkfs.ext4 -q -m 0 "$loop"
  install -d -m 0755 /data
  mount -o nodev,nosuid "$loop" /data
fi
loop=$(cat /etc/cc-gate/loop-device)
lsblk --json --paths --output PATH,TYPE,FSTYPE,UUID,SERIAL | python3 -c '
import json, sys
loop = sys.argv[1]
[device] = [d for d in json.load(sys.stdin)["blockdevices"] if d["path"] == loop]
assert device["type"] == "disk" and device["serial"] == "vol0123456789abcdef0", device
print("lsblk reports", device)' "$loop"

step "install.sh (controller runtime)"
node_sha=$(sha256sum /opt/switch/node/bin/node | cut -d ' ' -f 1)
claude_sha=$(sha256sum /opt/switch/claude/bin/claude | cut -d ' ' -f 1)
sh /src/deploy/hosted/vm/install.sh /gate-runtime "$node_sha" "$claude_sha"

step "per-user-v1 fixture"
if [ ! -e /var/lib/cc-gate/fixture-before.txt ]; then
  A1=$A1 A2=$A2 INSTALLATION_ID=$INSTALLATION_ID SLOT_ID=$SLOT_ID GENERATION=$GENERATION \
    bash "$GATE_DIR/make_fixture.sh"
fi

step "TLS for $API_HOST"
if [ ! -e /etc/cc-gate/ca.pem ]; then
  tls=/etc/cc-gate/tls
  install -d -m 0700 "$tls"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=cc-gate CA" \
    -keyout "$tls/ca.key" -out /etc/cc-gate/ca.pem 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$API_HOST" \
    -keyout "$tls/server.key" -out "$tls/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$API_HOST" >"$tls/ext"
  openssl x509 -req -in "$tls/server.csr" -CA /etc/cc-gate/ca.pem -CAkey "$tls/ca.key" \
    -CAcreateserial -days 2 -extfile "$tls/ext" -out "$tls/server.pem" 2>/dev/null
  chmod 0644 /etc/cc-gate/ca.pem
  cp /etc/cc-gate/ca.pem /usr/local/share/ca-certificates/cc-gate.crt
  update-ca-certificates >/dev/null
fi
grep -q " $API_HOST\$" /etc/hosts || echo "127.0.0.1 $API_HOST" >>/etc/hosts

step "fake IMDS and moto"
# Every AWS client here must go to moto, and nothing may reach GitHub. Pin the
# real endpoints to loopback, where nothing listens on 443, so a client that
# misses its override fails loudly instead of leaving the container.
for host in github.com api.github.com; do
  grep -q " $host\$" /etc/hosts || echo "127.0.0.1 $host" >>/etc/hosts
done
for service in kms secretsmanager sts ec2 iam; do
  for host in "$service.$REGION.amazonaws.com" "$service.amazonaws.com"; do
    grep -q " $host\$" /etc/hosts || echo "127.0.0.1 $host" >>/etc/hosts
  done
done
cat >/etc/systemd/system/cc-gate-imds.service <<EOF
[Unit]
Description=cc-gate fake instance metadata service
Before=switch-machine-boot.service switch-controller.service
[Service]
ExecStartPre=-/usr/sbin/ip addr add 169.254.169.254/32 dev lo
ExecStart=/usr/bin/python3 $GATE_LIB/fake_imds.py
Restart=always
EOF
cat >/etc/systemd/system/cc-gate-moto.service <<EOF
[Unit]
Description=cc-gate moto (KMS, Secrets Manager)
Before=switch-machine-boot.service switch-controller.service
[Service]
ExecStart=$VENV/bin/moto_server -H 127.0.0.1 -p 5000
Restart=always
EOF
systemctl daemon-reload
systemctl start cc-gate-imds.service cc-gate-moto.service
wait_for "moto" 60 curl -fsS http://127.0.0.1:5000/moto-api/
wait_for "IMDS" 30 curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token

step "KMS key, grant and the worker's secret (moto)"
context=$(jq -nc --arg t "$TENANT" --arg o "$OWNER" --arg c "$CONTROLLER_ID" \
  '{"switch:tenant": $t, "switch:owner_id": $o, "switch:controller_id": $c}')
assignment=$(jq -nc --arg i "$INSTALLATION_ID" --arg s "$SLOT_ID" --argjson g "$GENERATION" --arg v "$VOLUME_ID" \
  '{installationId: $i, slotId: $s, generation: $g, dataVolumeId: $v}')
if [ ! -e /etc/cc-gate/aws.json ]; then
  "$VENV/bin/python" "$GATE_LIB/aws_setup.py" "$(jq -nc --argjson context "$context" --arg m "$MACHINE_ID" \
    --argjson a "$assignment" --arg c "$MACHINE_CAPABILITY" --arg e "$API_ENDPOINT" \
    '{context: $context, machine_id: $m, assignment: $a, machine_capability: $c, api_endpoint: $e}')" \
    >/etc/cc-gate/aws.json
fi
key_arn=$(jq -r .key_arn /etc/cc-gate/aws.json)
grant_token=$(jq -r .grant_token /etc/cc-gate/aws.json)
secret_arn=$(jq -r .secret_arn /etc/cc-gate/aws.json)
echo "key $key_arn, secret $secret_arn"

step "machine assignment and v3 bundle"
jq -n --argjson a "$assignment" --arg secret "$secret_arn" --arg device "$loop" \
  '$a + {version: 2, assignmentSecretId: $secret, dataDevice: $device, mountPath: "/data"}' \
  >/etc/switch-hosted/assignment.json
jq -n --arg m "$MACHINE_ID" --argjson a "$assignment" --arg e "$API_ENDPOINT" --arg id "$CONTROLLER_ID" \
  --arg cred "$CONTROLLER_CREDENTIAL" --arg key "$key_arn" --arg region "$REGION" --arg grant "$grant_token" \
  --argjson context "$context" \
  '{version: 3, machineId: $m, assignment: $a, apiEndpoint: $e,
    controller: {id: $id, credential: $cred},
    kms: {keyArn: $key, region: $region, grantTokens: [$grant], context: $context}}' \
  >/etc/cc-gate/bundle.json
chmod 0600 /etc/cc-gate/bundle.json

step "stub Core"
definition() {
  jq -nc --arg name "$1" --arg dir "/data/worktrees/$2/acme/widgets" \
    '{name: $name, display_name: $name, icon_url: null, provider: "claude", model: null,
      advanced_config: {}, instructions: "The gate agent.", auto_approve: true,
      directory: $dir, isolation: "isolated"}'
}
controller_assignment=$(jq -nc --arg a1 "$A1" --arg a2 "$A2" \
  --argjson d1 "$(definition gate-one "$A1")" --argjson d2 "$(definition gate-two "$A2")" \
  '{revision: 1, agents: [
     {agent_id: $a1, revision: 1, desired_state: "running", definition: $d1},
     {agent_id: $a2, revision: 1, desired_state: "running", definition: $d2}]}')
jq -n --arg id "$CONTROLLER_ID" --arg cred "$CONTROLLER_CREDENTIAL" --arg inst "$INSTANCE_ID" \
  --arg key "$key_arn" --arg region "$REGION" --arg t "$TENANT" --arg o "$OWNER" --arg m "$MACHINE_ID" \
  --arg cap "$MACHINE_CAPABILITY" --argjson assignment "$controller_assignment" \
  '{controller_id: $id, credential: $cred, instance_id: $inst, key_arn: $key, region: $region,
    tenant: $t, owner: $o, machine_id: $m, machine_capability: $cap, assignment: $assignment,
    tls_cert: "/etc/cc-gate/tls/server.pem", tls_key: "/etc/cc-gate/tls/server.key"}' \
  >/etc/cc-gate/stub.json
cat >/etc/systemd/system/cc-gate-core.service <<EOF
[Unit]
Description=cc-gate STUB of Switch Core (not Core; seals with Core's sealing.py)
After=cc-gate-moto.service
Before=switch-controller.service
[Service]
Environment=PYTHONPATH=/src/core PYTHONDONTWRITEBYTECODE=1
Environment=AWS_ENDPOINT_URL_KMS=http://127.0.0.1:5000 AWS_ACCESS_KEY_ID=gate AWS_SECRET_ACCESS_KEY=gate AWS_EC2_METADATA_DISABLED=true
ExecStart=$VENV/bin/python $GATE_LIB/stub_core.py
Restart=always
EOF
systemctl daemon-reload
systemctl restart cc-gate-core.service
wait_for "stub Core" 30 curl -fsS "$STUB_ADMIN/state"
wait_for "stub Core TLS" 30 curl -fsS "$API_ENDPOINT/health"
admin /seal '{"provider": "claude", "revision": 1, "kind": "api-key", "credential": "gate-placeholder-key-rev1"}' \
  | jq -c '{revision: .envelope.revision, key_arn: .envelope.key_arn}'

step "boot and controller drop-ins (test hooks)"
install -d /etc/systemd/system/switch-machine-boot.service.d /etc/systemd/system/switch-controller.service.d
cat >/etc/systemd/system/switch-machine-boot.service.d/cc-gate.conf <<EOF
[Unit]
After=cc-gate-imds.service cc-gate-moto.service
[Service]
Environment=SWITCH_MACHINE_BOOT_TEST_HOOKS=1
ExecStart=
ExecStart=/usr/local/libexec/switch-machine-boot --config /etc/switch-hosted/assignment.json --runtime-config /etc/switch-hosted/runtime.json --bundle-file /etc/cc-gate/bundle.json
ExecStartPost=/usr/bin/python3 $GATE_LIB/kms_endpoint.py
EOF
cat >/etc/systemd/system/switch-controller.service.d/cc-gate.conf <<EOF
[Unit]
After=cc-gate-core.service cc-gate-imds.service
[Service]
Environment=NODE_EXTRA_CA_CERTS=/etc/cc-gate/ca.pem
EOF
systemctl daemon-reload

step "boot the machine"
systemctl start switch-machine-boot.service || {
  journalctl -u switch-machine-boot --no-pager -n 50
  exit 1
}
journalctl -u switch-machine-boot --no-pager -n 20 -o cat
systemctl start switch-controller.service
for _ in $(seq 90); do
  running=$(systemctl list-units --no-legend --state=active 'switch-agent@*' | wc -l)
  [ "$running" -ge 2 ] && break
  sleep 1
done
systemctl list-units --no-legend 'switch-agent@*' 'switch-controller*' 'switch-machine-boot*'
echo "setup complete"
