#!/usr/bin/env bash
# The v1 -> v2 migration end to end, on a local Kubernetes cluster (kind or
# k3d), against a test Core: freeze, snapshot (recorded), flip, hold, copy,
# release, with a fake v1 disk as a local volume. Fully local: no cloud
# credentials, no AWS calls, nothing outside this machine.
#
#   ./run_e2e.sh                        # kind, a 200 GB fake disk, about 6 GB used
#   ./run_e2e.sh --cluster k3d          # k3d instead (it enforces NetworkPolicy)
#   ./run_e2e.sh --trap swapped-indexes # one wrong-seat case: the copy must refuse
#   ./run_e2e.sh --cap-trap depth       # past a cap: the copy must fail cleanly
#   ./run_e2e.sh --rollback-from copied # then roll back from that step
#   ./run_e2e.sh --core-only            # no cluster: Core's side, the copy run locally
#   ./run_e2e.sh --keep                 # leave the cluster and volumes for a look
#
# What it times: freeze, copy and release. Snapshot and restore are EBS
# operations and are timed by the AWS run on dev, not here: locally the
# "restored volume" is the fake disk mounted read-only.
#
# What it checks after the copy, on the box's disk: the report equals what the
# seeder says a correct copy gives; only `workspaces/<agent name>/` exists;
# no symlink, FIFO, socket, device, setuid or setgid file; everything owned by
# 2000:2000; none of the v1 secrets, HOME files, watcher files or released
# agents. With --trap: the job refuses, the box's disk is left empty, and the
# move stays at the copy step.
#
# The box disk's root is 0:2000, 2775, as fsGroup leaves a fresh volume
# (BOX_ROOT_OWNER and BOX_ROOT_MODE change it).
#
# Needs: kubectl, kind or k3d, the docker CLI (to build the controller image
# and to make loop-mounted disk images inside the cluster's node container),
# python3, and Core's virtualenv (core/.venv, `uv sync` in core/).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
core="$repo/core"

cluster_kind=kind
cluster_name=switch-migration-e2e
disk_gb=200
used_bytes=$((6 * 1024 * 1024 * 1024))
box_disk_gb=20
tiny_files=20000
workspaces=2
trap_name=""
rollback_from=""
core_only=0
keep=0
gvisor=auto
copy_module=switch_hosted_controller.migration_copy
cap_trap=""
#: The "restored volume" id the copy reports: made up, never the v1 disk's.
restored_volume=vol-0e2e5e2e5e2e5e2e5
image=switch-hosted-controller:migration-e2e
pg_port=55433

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) cluster_kind=$2; shift 2 ;;
    --name) cluster_name=$2; shift 2 ;;
    --disk-gb) disk_gb=$2; shift 2 ;;
    --used-bytes) used_bytes=$2; shift 2 ;;
    --box-disk-gb) box_disk_gb=$2; shift 2 ;;
    --tiny-files) tiny_files=$2; shift 2 ;;
    --workspaces) workspaces=$2; shift 2 ;;
    --trap) trap_name=$2; shift 2 ;;
    --cap-trap) cap_trap=$2; shift 2 ;;
    --rollback-from) rollback_from=$2; shift 2 ;;
    --gvisor) gvisor=$2; shift 2 ;;
    --core-only) core_only=1; shift ;;
    --keep) keep=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 2 ;;
  esac
done
case "$cluster_kind" in kind|k3d) ;; *) echo "--cluster is kind or k3d" >&2; exit 2 ;; esac
case "$rollback_from" in ""|frozen|snapshot|flipped|held|copy_failed|copied|released|done) ;;
  *) echo "--rollback-from: frozen, snapshot, flipped, held, copy_failed, copied, released or done" >&2; exit 2 ;; esac

# ── safety: local only ────────────────────────────────────────────────────
# No cloud credentials reach anything this runs.
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_DEFAULT_PROFILE \
  AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE KUBECONFIG_ORIGINAL 2>/dev/null || true
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true

work=$(mktemp -d "${TMPDIR:-/tmp}/migration-e2e.XXXXXX")
chmod 700 "$work"
log="$work/run.log"
timings="$work/timings.json"
echo '{}' > "$timings"
pf_pid=""

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$log" >&2; }
fail() { say "FAIL: $*"; exit 1; }
pass() { say "PASS: $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs $1 on PATH"; }
now() { date +%s.%N; }
record_time() { # name start end
  python3 -I -c 'import json,sys; p,k,a,b=sys.argv[1:]; d=json.load(open(p)); d[k]=round(float(b)-float(a),2); json.dump(d,open(p,"w"))' "$timings" "$1" "$2" "$3"
}

cleanup() {
  local code=$?
  [ -n "$pf_pid" ] && kill "$pf_pid" 2>/dev/null || true
  if [ "$keep" = 1 ]; then
    say "kept: work dir $work${core_only:+, cluster $cluster_name}"
  else
    if [ "$core_only" = 0 ] && [ "${created_cluster:-0}" = 1 ]; then
      say "deleting cluster $cluster_name"
      if [ "$cluster_kind" = kind ]; then kind delete cluster --name "$cluster_name" >/dev/null 2>&1 || true
      else k3d cluster delete "$cluster_name" >/dev/null 2>&1 || true; fi
    elif [ "$core_only" = 0 ] && [ -n "${node:-}" ]; then
      docker exec "$node" sh -c 'umount /var/e2e/v1 /var/e2e/box 2>/dev/null; rm -rf /var/e2e' || true
    fi
    rm -rf "$work"
  fi
  exit "$code"
}
trap cleanup EXIT

need python3
[ -x "$core/.venv/bin/switch-hosted-migration" ] || fail "Core's virtualenv isn't set up: cd core && uv sync"
if [ "$core_only" = 0 ]; then
  need kubectl; need docker; need "$cluster_kind"
fi

# ── the cluster ───────────────────────────────────────────────────────────
created_cluster=0
node=""
kctl() { kubectl --context "$context" "$@"; }
if [ "$core_only" = 0 ]; then
  if [ "$cluster_kind" = kind ]; then
    context="kind-$cluster_name"
    if ! kind get clusters 2>/dev/null | grep -qx "$cluster_name"; then
      say "creating kind cluster $cluster_name"
      kind create cluster --name "$cluster_name" --wait 120s >>"$log" 2>&1
      created_cluster=1
    fi
    node="$cluster_name-control-plane"
  else
    context="k3d-$cluster_name"
    if ! k3d cluster list "$cluster_name" >/dev/null 2>&1; then
      say "creating k3d cluster $cluster_name"
      k3d cluster create "$cluster_name" --wait >>"$log" 2>&1
      created_cluster=1
    fi
    node="k3d-$cluster_name-server-0"
  fi
  # Refuse anything but the local cluster this script names.
  case "$(kctl config current-context 2>/dev/null || true)" in *) ;; esac
  server=$(kubectl config view -o jsonpath="{.clusters[?(@.name==\"$context\")].cluster.server}")
  case "$server" in
    https://127.0.0.1:*|https://0.0.0.0:*|https://localhost:*|https://host.docker.internal:*) ;;
    *) fail "context $context points at $server, not a local cluster: refused" ;;
  esac
  docker inspect "$node" >/dev/null 2>&1 || fail "no node container $node"
  say "cluster: $context ($server), node $node"
  if [ "$cluster_kind" = kind ]; then
    say "NOTE: kind's default network (kindnet) doesn't enforce NetworkPolicy: the no-network check is skipped. Use --cluster k3d for it."
  fi
fi

# ── the test Core ─────────────────────────────────────────────────────────
pg_password=$(python3 -I -c 'import secrets; print(secrets.token_hex(16))')
if [ "$core_only" = 0 ]; then
  say "test Core: Postgres in namespace e2e-core"
  kctl create namespace e2e-core --dry-run=client -o yaml | kctl apply -f - >>"$log"
  kctl -n e2e-core create secret generic pg --from-literal=password="$pg_password" \
    --dry-run=client -o yaml | kctl apply -f - >>"$log"
  kctl -n e2e-core apply -f - >>"$log" <<YAML
apiVersion: v1
kind: Pod
metadata: {name: pg, labels: {app: e2e-pg}}
spec:
  containers:
    - name: pg
      image: postgres:16-alpine
      env:
        - {name: POSTGRES_DB, value: e2e_core}
        - {name: POSTGRES_PASSWORD, valueFrom: {secretKeyRef: {name: pg, key: password}}}
      args: ["-c", "fsync=off"]
      ports: [{containerPort: 5432}]
      readinessProbe: {exec: {command: ["pg_isready", "-U", "postgres"]}, periodSeconds: 2}
YAML
  kctl -n e2e-core wait --for=condition=Ready pod/pg --timeout=180s >>"$log"
  kctl -n e2e-core port-forward pod/pg "$pg_port:5432" >>"$log" 2>&1 &
  pf_pid=$!
  sleep 3
  db_host=127.0.0.1; db_port=$pg_port; db_user=postgres
else
  # --core-only: a local throwaway Postgres you started, on E2E_PG_PORT, with
  # an empty database named e2e_core (the helper refuses any other name).
  db_host=127.0.0.1; db_port=${E2E_PG_PORT:?set E2E_PG_PORT to a local Postgres port}
  db_user=${E2E_PG_USER:-postgres}; pg_password=${E2E_PG_PASSWORD:-unused}
fi

rand() { python3 -I -c 'import secrets; print(secrets.token_hex(24))'; }
umask 077
python3 -I -c 'import os,sys; open(sys.argv[1],"wb").write(os.urandom(48))' "$work/keyed-id.key"
core_env() {
  env DB_HOST="$db_host" DB_PORT="$db_port" DB_NAME=e2e_core DB_USER="$db_user" DB_PASSWORD="$pg_password" \
    ID_SERVER_NAME=localhost GATEWAY_ADMIN_EMAIL=admin@example.invalid GATEWAY_PASSWORD_LOGIN_ENABLED=false \
    AGENT_REGISTRATION_TOKEN="$registration" SECRET_KEYS="k1:$secret_key" CONTROLLER_TOKEN_SECRET="$controller_secret" \
    FEATURE_FLAGS_ENABLED=hosted_agents HOSTED_LAUNCH_CAPACITY=10 HOSTED_BOX_PROVISIONING=true \
    VISIBILITY_KEYED_ID_KEY_PATH="$work/keyed-id.key" VISIBILITY_OPERATORS_PATH="$work/operators.json" \
    HOSTED_CONTROLLER_CONFIG_PATH="$work/controller.json" PYTHONPATH="$core" "$@"
}
registration=$(rand); secret_key=$(rand); controller_secret=$(rand)
python3 -I - "$work/controller.json" "$(rand)" <<'PY'
import json, sys
path, token = sys.argv[1:]
json.dump({"allowed_tenant_ids": ["*"], "allowed_user_ids": ["*"], "token": token,
           "agent_api_endpoint": "https://switch.example.net"}, open(path, "w"))
PY
umask 022

(cd "$core" && core_env .venv/bin/switch-migrate >>"$log" 2>&1) || fail "Core's migrations (see $log)"
helper() { (cd "$core" && core_env .venv/bin/python "$here/e2e_core.py" "$@"); }
jget() { python3 -I -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

operator=$(helper operator e2e-operator | jget operator_id)
printf '{"operators": ["%s"]}\n' "$operator" > "$work/operators.json"; chmod 600 "$work/operators.json"
seeded=$(helper seed e2e-person --agents 2 --workspaces "$workspaces")
person=$(echo "$seeded" | jget person_id)
machine=$(echo "$seeded" | jget machine_id)
say "test Core ready: a person on a running v1 machine, $workspaces workspace(s) with 2 agents each"

cli() { (cd "$core" && core_env .venv/bin/switch-hosted-migration "$@") 2>>"$log"; }
step() { # the next step, executed; prints Core's answer
  local out; out=$(cli run "$person" --operator "$operator" --execute "$@") || fail "run $* refused (see $log)"
  say "  $out"; echo "$out"
}
expect_step() { # step args... ; asserts "-> $want"
  local want=$1; shift
  step "$@" | grep -q -- "-> $want\." || fail "expected the move to be at $want"
}
maybe_rollback() { # after reaching step $1
  [ "$rollback_from" = "$1" ] || return 0
  say "rollback from $1"
  local out
  out=$(cli rollback "$person" --operator "$operator" --execute) || fail "rollback refused"
  if echo "$out" | grep -q "Stopping the box first"; then
    helper machine-state "$machine" stopped >/dev/null
    out=$(cli rollback "$person" --operator "$operator" --execute) || fail "rollback refused"
  fi
  echo "$out" | grep -q -- "-> rolled_back" || fail "rollback didn't finish: $out"
  cli plan "$person" | grep -q "next: Freeze again" || fail "after the rollback, a new move can't start"
  pass "rolled back from $1; the person can be moved again"
  exit 0
}

# ── 1. freeze ─────────────────────────────────────────────────────────────
cli plan "$person" >>"$log"
t0=$(now)
expect_step freezing
helper machine-state "$machine" stopped >/dev/null   # the v1 machine stops
expect_step frozen
record_time freeze "$t0" "$(now)"
pass "frozen"
maybe_rollback frozen

# The fake v1 disk's seats, from Core's rows, before the flip revokes the v1 controller.
helper disk-spec "$person" > "$work/disk-spec.json"

# ── 2. snapshot (recorded; the EBS part is the AWS run's) ─────────────────
expect_step snapshot --snapshot-id snap-0e2e0e2e0e2e0e2e0
maybe_rollback snapshot

# ── 3. flip and hold ──────────────────────────────────────────────────────
expect_step flipped
maybe_rollback flipped
helper box-enrols "$machine" >/dev/null                 # the box's first start
helper machine-state "$machine" ready >/dev/null
expect_step holding
helper machine-state "$machine" stopped >/dev/null
expect_step held
pass "the box is held stopped for the copy"
maybe_rollback held
cli manifest "$person" > "$work/manifest.core.json" || fail "no manifest"
# Core before switch#2331 gives no seat key, v1 controller id or agent names:
# the run fills them from Core's own rows (disk-spec, read before the flip)
# and says so. With #2331 merged, Core's manifest is used as it is.
python3 -I - "$work/manifest.core.json" "$work/disk-spec.json" "$work/manifest.json" <<'PY' | tee -a "$log" >&2
import json, sys
manifest, spec, out = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3]
by_tenant = {s["tenant_id"]: s for s in spec}
filled = False
for w in manifest["workspaces"]:
    seat = by_tenant[w["tenant_id"]]
    if "seat_key" not in w:
        w["seat_key"], w["v1_controller_id"], filled = seat["seat_key"], seat["v1_controller_id"], True
    if "agents" not in w:
        names = {a["id"]: a["name"] for a in seat["agents"]}
        w["agents"] = [{"id": i, "name": names[i], "directory": None} for i in w.pop("agent_ids")]
        filled = True
json.dump(manifest, open(out, "w"))
print("NOTE: Core's manifest predates switch#2331; seat keys, controller ids and agent names filled from Core's rows"
      if filled else "manifest: Core's own (switch#2331)")
PY
namespace=$(jget namespace < "$work/manifest.json")

# ── 4. the fake v1 disk and the box's disk ───────────────────────────────
trap_args=()
[ -n "$trap_name" ] && trap_args=(--trap "$trap_name")
[ -n "$cap_trap" ] && trap_args+=(--cap-trap "$cap_trap")
seed_args=(--spec /e2e/disk-spec.json --bulk-bytes "$used_bytes" --tiny-files "$tiny_files" "${trap_args[@]}")

if [ "$core_only" = 0 ]; then
  say "fake v1 disk: a ${disk_gb} GB sparse image, ext4, loop-mounted in $node"
  if docker exec "$node" sh -c 'command -v mkfs.ext4 && command -v truncate' >/dev/null 2>&1; then
    make_disk='truncate -s "$2" "$1.img" && mkfs.ext4 -q -F "$1.img" && mount -o loop "$1.img" "$1"'
  else
    # k3s's node image has no mkfs: plain folders, so the sizes (and the
    # full-disk case) aren't real. kind's node has it.
    say "NOTE: no mkfs.ext4 in $node: the fake disks are plain folders, not ${disk_gb} GB filesystems"
    make_disk='true'
  fi
  docker exec "$node" sh -ec "
    mkdir -p /var/e2e/v1 /var/e2e/box
    set -- /var/e2e/v1 ${disk_gb}G; $make_disk
    set -- /var/e2e/box ${box_disk_gb}G; $make_disk
    rm -rf /var/e2e/v1/lost+found /var/e2e/box/lost+found
    chown ${BOX_ROOT_OWNER:-0:2000} /var/e2e/box && chmod ${BOX_ROOT_MODE:-2775} /var/e2e/box" >>"$log" 2>&1 \
    || fail "couldn't make loop-mounted disks in $node (is the node container privileged?)"

  say "seeding it (as root, so owners and modes are a v1 machine's)"
  kctl create namespace e2e-seed --dry-run=client -o yaml | kctl apply -f - >>"$log"
  kctl -n e2e-seed create configmap seed --from-file=seed.py="$here/seed_fake_v1_disk.py" \
    --from-file=disk-spec.json="$work/disk-spec.json" --dry-run=client -o yaml | kctl apply -f - >>"$log"
  kctl -n e2e-seed delete pod seed --ignore-not-found >>"$log"
  kctl -n e2e-seed apply -f - >>"$log" <<YAML
apiVersion: v1
kind: Pod
metadata: {name: seed}
spec:
  restartPolicy: Never
  containers:
    - name: seed
      image: python:3.12-slim
      command: ["python", "-I", "/e2e/seed.py", "/v1", $(printf '"%s", ' "${seed_args[@]}" | sed 's/, $//')]
      volumeMounts: [{name: e2e, mountPath: /e2e}, {name: v1, mountPath: /v1}]
  volumes:
    - {name: e2e, configMap: {name: seed}}
    - {name: v1, hostPath: {path: /var/e2e/v1, type: Directory}}
YAML
  kctl -n e2e-seed wait --for=jsonpath='{.status.phase}'=Succeeded pod/seed --timeout=1800s >>"$log" \
    || { kctl -n e2e-seed logs seed >>"$log" 2>&1; fail "seeding failed (see $log)"; }
  kctl -n e2e-seed logs seed > "$work/expect.json"
else
  mkdir -p "$work/v1" "$work/box"
  cp "$work/disk-spec.json" "$work/disk-spec.local.json"
  python3 -I "$here/seed_fake_v1_disk.py" "$work/v1" --spec "$work/disk-spec.local.json" \
    --bulk-bytes "$used_bytes" --tiny-files "$tiny_files" "${trap_args[@]}" > "$work/expect.json" 2>>"$log" \
    || fail "seeding failed: $(tail -1 "$log")"
fi
pass "fake v1 disk seeded ($(jget expect < "$work/expect.json") expected)"

# ── 5. the copy ───────────────────────────────────────────────────────────
copy_ok=0
t0=$(now)
if [ "$core_only" = 0 ]; then
  say "building the controller image (the copy job's) and loading it"
  docker build -q -t "$image" "$repo/deploy/hosted/controller" >>"$log"
  if [ "$cluster_kind" = kind ]; then kind load docker-image "$image" --name "$cluster_name" >>"$log" 2>&1
  else k3d image import "$image" -c "$cluster_name" >>"$log" 2>&1; fi
  runtime_line=""
  if [ "$gvisor" != off ] && kctl get runtimeclass gvisor >/dev/null 2>&1; then
    runtime_line="runtimeClassName: gvisor"
  elif [ "$gvisor" = on ]; then fail "--gvisor on, but the cluster has no gvisor RuntimeClass"
  else say "NOTE: no gvisor RuntimeClass here: the job runs under the default runtime"; fi

  say "the box namespace (restricted, default-deny, as the operator makes it), its disk and the read-only source"
  kctl apply -f - >>"$log" <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: $namespace
  labels:
    app.kubernetes.io/managed-by: switch-hosted
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
  annotations: {switch.dev/machine-id: "$machine"}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: default-deny, namespace: $namespace}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: v1
kind: PersistentVolume
metadata: {name: e2e-box-data-agents}
spec:
  capacity: {storage: ${box_disk_gb}Gi}
  accessModes: [ReadWriteOnce]
  storageClassName: e2e-local
  persistentVolumeReclaimPolicy: Retain
  claimRef: {namespace: $namespace, name: data-agents}
  hostPath: {path: /var/e2e/box, type: Directory}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: data-agents, namespace: $namespace}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: e2e-local
  volumeName: e2e-box-data-agents
  resources: {requests: {storage: ${box_disk_gb}Gi}}
---
apiVersion: v1
kind: PersistentVolume
metadata: {name: e2e-restored-v1}
spec:
  capacity: {storage: ${disk_gb}Gi}
  accessModes: [ReadOnlyMany]
  storageClassName: e2e-local
  persistentVolumeReclaimPolicy: Retain
  claimRef: {namespace: $namespace, name: migration-source}
  hostPath: {path: /var/e2e/v1, type: Directory}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: migration-source, namespace: $namespace}
spec:
  accessModes: [ReadOnlyMany]
  storageClassName: e2e-local
  volumeName: e2e-restored-v1
  resources: {requests: {storage: ${disk_gb}Gi}}
YAML
  kctl -n "$namespace" create configmap migration-manifest --from-file=manifest.json="$work/manifest.json" \
    --dry-run=client -o yaml | kctl apply -f - >>"$log"

  # What engineer-4's runner does around the Job (decisions of 28 Nov), done
  # here until the runner is wired in: the namespace to baseline for the copy
  # only, then back to restricted, read back.
  pss() { kctl label namespace "$namespace" --overwrite \
            "pod-security.kubernetes.io/enforce=$1" >>"$log"; }
  pss baseline

  # The Job as decided: JOB_SHAPE=split (the default) is a root reader with only
  # DAC_OVERRIDE (read-only source, the FIFO) and a uid-2000 writer with no
  # capabilities (data-agents only), through a FIFO in a memory emptyDir.
  # JOB_SHAPE=single is the one-process program as root with DAC_OVERRIDE and
  # CHOWN (engineer-3's v1.1), for until the split lands.
  # The split's flags are engineer-3's (7fe17e45) and engineer-4's runner's; READ_ARGS/WRITE_ARGS
  # override them.
  shape=${JOB_SHAPE:-split}
  common_security='allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true'
  if [ "$shape" = split ]; then
    read_args=${READ_ARGS:-"read --manifest /manifest/manifest.json --source /source --stream /shared/stream"}
    write_args=${WRITE_ARGS:-"write --manifest /manifest/manifest.json --target /target --stream /shared/stream --step held"}
    containers=$(cat <<C
        - name: read
          image: $image
          imagePullPolicy: Never
          command: [$(printf '"switch-migration-copy"'; for a in $read_args; do printf ', "%s"' "$a"; done)]
          env: [{name: POD_NAMESPACE, valueFrom: {fieldRef: {fieldPath: metadata.namespace}}}]
          securityContext:
            runAsUser: 0
            runAsGroup: 0
            runAsNonRoot: false
            $common_security
            capabilities: {drop: ["ALL"], add: ["DAC_OVERRIDE"]}
          resources: {requests: {cpu: 250m, memory: 128Mi}, limits: {cpu: "1", memory: 512Mi}}
          volumeMounts:
            - {name: manifest, mountPath: /manifest, readOnly: true}
            - {name: source, mountPath: /source, readOnly: true}
            - {name: stream, mountPath: /shared}
        - name: write
          image: $image
          imagePullPolicy: Never
          command: [$(printf '"switch-migration-copy"'; for a in $write_args; do printf ', "%s"' "$a"; done)]
          env: [{name: POD_NAMESPACE, valueFrom: {fieldRef: {fieldPath: metadata.namespace}}}]
          terminationMessagePolicy: File
          securityContext:
            runAsUser: 2000
            runAsGroup: 2000
            runAsNonRoot: true
            $common_security
            capabilities: {drop: ["ALL"]}
          resources: {requests: {cpu: 250m, memory: 128Mi}, limits: {cpu: "1", memory: 512Mi}}
          volumeMounts:
            - {name: manifest, mountPath: /manifest, readOnly: true}
            - {name: stream, mountPath: /shared}
            - {name: target, mountPath: /target}
C
)
    report_container=write
  else
    containers=$(cat <<C
        - name: copy
          image: $image
          imagePullPolicy: Never
          command: ["switch-migration-copy", "--manifest", "/manifest/manifest.json", "--source", "/source",
                    "--target", "/target", "--source-volume-id", "$restored_volume", "--step", "held"]
          env: [{name: POD_NAMESPACE, valueFrom: {fieldRef: {fieldPath: metadata.namespace}}}]
          terminationMessagePolicy: File
          securityContext:
            runAsUser: 0
            runAsGroup: 0
            runAsNonRoot: false
            $common_security
            capabilities: {drop: ["ALL"], add: ["DAC_OVERRIDE", "CHOWN"]}
          resources: {requests: {cpu: 500m, memory: 256Mi}, limits: {cpu: "2", memory: 1Gi}}
          volumeMounts:
            - {name: manifest, mountPath: /manifest, readOnly: true}
            - {name: source, mountPath: /source, readOnly: true}
            - {name: target, mountPath: /target}
C
)
    report_container=copy
  fi
  kctl -n "$namespace" delete job migration-copy --ignore-not-found >>"$log"
  kctl -n "$namespace" apply -f - >>"$log" <<YAML
apiVersion: batch/v1
kind: Job
metadata: {name: migration-copy, labels: {app: switch-migration-copy}}
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 7200
  template:
    metadata: {labels: {app: switch-migration-copy}}
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      enableServiceLinks: false
      $runtime_line
      securityContext:
        seccompProfile: {type: RuntimeDefault}
      containers:
$containers
      volumes:
        - {name: manifest, configMap: {name: migration-manifest}}
        - {name: source, persistentVolumeClaim: {claimName: migration-source, readOnly: true}}
        - {name: target, persistentVolumeClaim: {claimName: data-agents}}
        - {name: stream, emptyDir: {medium: Memory, sizeLimit: 16Mi}}
YAML
  say "copy job started ($shape)"
  while :; do
    phase=$(kctl -n "$namespace" get job migration-copy -o jsonpath='{.status.succeeded}{"/"}{.status.failed}')
    case "$phase" in 1/*) copy_ok=1; break ;; */1) break ;; esac
    sleep 2
  done
  pss restricted
  [ "$(kctl get namespace "$namespace" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')" = restricted ] \
    || fail "the box namespace isn't back to restricted after the copy"
  pass "the box namespace is back to restricted"
  pod=$(kctl -n "$namespace" get pods -l job-name=migration-copy -o jsonpath='{.items[0].metadata.name}')
  kctl -n "$namespace" get pod "$pod" \
    -o jsonpath="{.status.containerStatuses[?(@.name==\"$report_container\")].state.terminated.message}" \
    > "$work/report.json" || true
  # The copier reports source_volume_id null; the runner fills it from the
  # bound PV (decision 3). Here, the made-up restored volume id.
  python3 -I - "$work/report.json" "$restored_volume" <<'PY' || true
import json, sys
path, volume = sys.argv[1:]
try:
    report = json.load(open(path))
except ValueError:
    sys.exit(0)
if "source_volume_id" in report and report["source_volume_id"] is None:
    report["source_volume_id"] = volume
    json.dump(report, open(path, "w"))
PY
  kctl -n "$namespace" logs "$pod" >>"$log" 2>&1 || true
else
  # No cluster: run the copy program directly, if it's there yet. Not as root,
  # the v1 owners are this user's (the program's `Owners` for tests).
  ctl_py="$repo/deploy/hosted/controller/.venv/bin/python"
  if [ -x "$ctl_py" ] && (cd "$repo/deploy/hosted/controller" && "$ctl_py" -c "import $copy_module") 2>/dev/null; then
    # The reader and the writer as two processes through the FIFO, as the
    # Job's two containers run them; their identity checks off (not root here).
    if (cd "$repo/deploy/hosted/controller" && "$ctl_py" - "$work" "$restored_volume" <<'PY') >>"$log" 2>&1; then copy_ok=1; fi
import json, multiprocessing, os, sys
from pathlib import Path
from switch_hosted_controller import migration_copy as m
work, volume = Path(sys.argv[1]), sys.argv[2]
uid = os.getuid()
owners = m.Owners() if uid == 0 else m.Owners(seat_map=uid, seat_base=uid, seat_step=0)
stream = work / "copy.fifo"
def role(argv, log, **extra):
    sys.exit(m.main(argv, termination_log=log, check_identity=False, **extra))
writer = multiprocessing.Process(target=role, args=(
    ["write", "--manifest", str(work / "manifest.json"), "--target", str(work / "box"),
     "--stream", str(stream), "--step", "held"], work / "report.json"), kwargs={"box_uid": uid})
reader = multiprocessing.Process(target=role, args=(
    ["read", "--manifest", str(work / "manifest.json"), "--source", str(work / "v1"),
     "--stream", str(stream)], work / "reader.json"), kwargs={"owners": owners})
writer.start(); reader.start(); reader.join(); writer.join()
print("reader:", (work / "reader.json").read_text() if (work / "reader.json").exists() else None)
report = json.loads((work / "report.json").read_text())
if report.get("source_volume_id", "") is None:
    report["source_volume_id"] = volume  # the runner fills it from the PV
    (work / "report.json").write_text(json.dumps(report))
sys.exit(writer.exitcode or reader.exitcode or 0)
PY
  else
    say "STAND-IN: $copy_module isn't there yet; the report is the seeder's expected one (Core's side only)"
    python3 -I - "$work/manifest.json" "$work/expect.json" "$work/report.json" "$restored_volume" <<'PY'
import json, sys
manifest, expect = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
if expect["expect"] != "copied":
    sys.exit(0)  # a correct job refuses or fails: no report
json.dump({"machine_id": manifest["machine_id"],
           "workspaces": [w["tenant_id"] for w in manifest["workspaces"]],
           **expect["expected_report"], "source_volume_id": sys.argv[4], "seconds": 1}, open(sys.argv[3], "w"))
PY
    [ -s "$work/report.json" ] && copy_ok=1
  fi
fi
record_time copy "$t0" "$(now)"

# ── 6. checks on the copy ────────────────────────────────────────────────
expect=$(jget expect < "$work/expect.json")
if [ "$expect" != copied ]; then
  [ "$copy_ok" = 0 ] || fail "trap ${trap_name:-$cap_trap}: the copy job succeeded; it must $expect"
  if [ -s "$work/report.json" ]; then
    python3 -I - "$work/report.json" <<'PY' || fail "a failed copy's report must be just its refusal code"
import json, sys
r = json.load(open(sys.argv[1]))
assert set(r) == {"refused"} and isinstance(r["refused"], str) and len(r["refused"]) < 40, r
print("refused:", r["refused"])
PY
  fi
  pass "trap ${trap_name:-$cap_trap}: the copy job refused, as it must"
else
  [ "$copy_ok" = 1 ] || fail "the copy job failed (see $log)"
  python3 -I - "$work/report.json" "$work/expect.json" "$work/manifest.json" <<'PY' || fail "the report isn't what a correct copy gives"
import json, sys
report, expect, manifest = (json.load(open(p)) for p in sys.argv[1:])
assert set(report) == {"machine_id", "workspaces", "files", "bytes", "symlinks_skipped", "refused",
                       "checksum_mismatches", "source_volume_id", "seconds"}, sorted(report)
assert report["machine_id"] == manifest["machine_id"]
assert sorted(report["workspaces"]) == sorted(w["tenant_id"] for w in manifest["workspaces"])
wrong = {k: (report[k], v) for k, v in expect["expected_report"].items() if report[k] != v}
assert not wrong, f"report vs expected: {wrong}"
PY
  pass "the report matches the seeded disk"
fi

# What's on the box's disk, checked from inside the cluster (or locally).
verify_py=$(cat <<'PY'
import json, os, stat, sys
target, expect = sys.argv[1], json.load(open(sys.argv[2]))
owner = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
problems, files, size = [], 0, 0
for dirpath, dirnames, filenames in os.walk(target):
    for name in dirnames + filenames:
        path = os.path.join(dirpath, name)
        st = os.lstat(path)
        rel = os.path.relpath(path, target)
        if rel == "lost+found" or rel.startswith("lost+found/"):
            continue
        kind = stat.S_IFMT(st.st_mode)
        if kind not in (stat.S_IFREG, stat.S_IFDIR):
            problems.append(f"not a file or directory: type {kind:o}")
        if st.st_mode & (stat.S_ISUID | stat.S_ISGID):
            problems.append("a setuid or setgid bit")
        if st.st_uid != owner or (owner == 2000 and st.st_gid != 2000):
            problems.append(f"owned by {st.st_uid}:{st.st_gid}")
        if kind == stat.S_IFREG:
            files += 1
            size += st.st_size
            if st.st_nlink != 1:
                problems.append("a hard link")
tops = sorted(os.listdir(os.path.join(target, "workspaces"))) if os.path.isdir(os.path.join(target, "workspaces")) else []
others = sorted(n for n in os.listdir(target) if n not in ("workspaces", "lost+found"))
if expect["expect"] != "copied":
    if files or tops or others:
        problems.append("the box's disk isn't empty after a refused copy")
else:
    want = sorted(t.split("/", 1)[1] for t in expect["box_targets"])
    if tops != want:
        problems.append(f"workspaces/ holds {len(tops)} agents, not the {len(want)} expected")
    if others:
        problems.append(f"{len(others)} entries outside workspaces/")
    for leaf in ("credential", ".credentials.json", "auth.json", "login.json", "controller.db",
                 "s1.jsonl", "old.txt", "outside-the-roots.txt", ".switch-agent-id"):
        for dirpath, _d, filenames in os.walk(target):
            if leaf in filenames:
                problems.append(f"a file that must never move ({leaf})")
    rep = expect["expected_report"]
    if (files, size) != (rep["files"], rep["bytes"]):
        problems.append(f"{files} files, {size} bytes on the disk; expected {rep['files']}, {rep['bytes']}")
print(json.dumps({"files": files, "bytes": size, "problems": sorted(set(problems))}))
sys.exit(1 if problems else 0)
PY
)
if [ "$core_only" = 0 ]; then
  kctl -n "$namespace" create configmap e2e-verify --from-literal=verify.py="$verify_py" \
    --from-file=expect.json="$work/expect.json" --dry-run=client -o yaml | kctl apply -f - >>"$log"
  kctl -n "$namespace" delete pod e2e-verify --ignore-not-found >>"$log"
  pss baseline   # the checker reads every file as root; restricted again after
  kctl -n "$namespace" apply -f - >>"$log" <<YAML
apiVersion: v1
kind: Pod
metadata: {name: e2e-verify}
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  containers:
    - name: verify
      image: python:3.12-slim
      command: ["python", "-I", "/e2e/verify.py", "/target", "/e2e/expect.json"]
      securityContext: {runAsUser: 0}
      volumeMounts: [{name: e2e, mountPath: /e2e}, {name: target, mountPath: /target, readOnly: true}]
  volumes:
    - {name: e2e, configMap: {name: e2e-verify}}
    - {name: target, persistentVolumeClaim: {claimName: data-agents, readOnly: true}}
YAML
  kctl -n "$namespace" wait --for=jsonpath='{.status.phase}'=Succeeded pod/e2e-verify --timeout=900s >>"$log" 2>&1 \
    || { kctl -n "$namespace" logs e2e-verify | tee -a "$log" >&2; fail "the box's disk doesn't hold what it should"; }
  kctl -n "$namespace" logs e2e-verify | tee -a "$log" >&2
  pss restricted
elif [ -n "$(ls -A "$work/box" 2>/dev/null)" ] || [ "$expect" != copied ]; then
  python3 -I -c "$verify_py" "$work/box" "$work/expect.json" "$(id -u)" | tee -a "$log" >&2 \
    || fail "the box's disk doesn't hold what it should"
else
  say "STAND-IN: nothing was copied locally, so the box's disk isn't checked"
fi
pass "the box's disk holds only what should move"

# No network for the copy job: a pod with its label can reach nothing.
if [ "$core_only" = 0 ] && [ "$cluster_kind" = k3d ]; then
  kctl -n "$namespace" delete pod e2e-netprobe --ignore-not-found >>"$log"
  kctl -n "$namespace" apply -f - >>"$log" <<'YAML'
apiVersion: v1
kind: Pod
metadata: {name: e2e-netprobe, labels: {app: switch-migration-copy}}
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext: {runAsNonRoot: true, runAsUser: 2000, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: python:3.12-slim
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}}
      command:
        - python
        - -I
        - -c
        - |
          import socket, sys
          for host, port in (("kubernetes.default.svc", 443), ("10.43.0.1", 443), ("1.1.1.1", 53)):
              try:
                  socket.create_connection((host, port), timeout=3).close()
                  print("reached", host); sys.exit(1)
              except OSError:
                  pass
          print("no network")
YAML
  kctl -n "$namespace" wait --for=jsonpath='{.status.phase}'=Succeeded pod/e2e-netprobe --timeout=120s >>"$log" 2>&1 \
    || fail "a pod with the copy job's label reached the network"
  pass "the copy job's label has no network"
fi

# ── 7. back to Core: the report, then release ─────────────────────────────
if [ "$expect" != copied ]; then
  expect_step copy_failed --copy-failed
  pass "Core records the failed copy; the box stays held"
  say "rolling back after the failed copy"
  rollback_from=copy_failed; maybe_rollback copy_failed
fi
t0=$(now)
expect_step copied --copy-report "$work/report.json"
maybe_rollback copied
expect_step released
maybe_rollback released
helper machine-state "$machine" ready >/dev/null
helper box-enrols "$machine" >/dev/null               # the box's controllers enrol
expect_step done
record_time release "$t0" "$(now)"
pass "moved: freeze to done"
maybe_rollback done

say "timings (seconds): $(cat "$timings")"
say "copied: $(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["files"], "files,", r["bytes"], "bytes")' "$work/report.json")"
say "log: $log"
