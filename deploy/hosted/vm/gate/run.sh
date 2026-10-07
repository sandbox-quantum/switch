#!/bin/bash
# The controller runtime's local Linux gate, in one command:
#
#   deploy/hosted/vm/gate/run.sh            every assertion
#   deploy/hosted/vm/gate/run.sh 1 4        only those (see container/checks.sh)
#   KEEP=1 deploy/hosted/vm/gate/run.sh     leave the container up afterwards
#
# Builds the runtime bundles from this checkout, builds the gate image, boots
# a privileged Ubuntu 24.04 container with systemd as PID 1, turns it into a
# cloud machine (container/setup.sh) and runs the checks (container/checks.sh).
# Everything it creates is named cc-gate-* and is removed on exit unless KEEP=1.
set -euo pipefail

gate=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$gate" rev-parse --show-toplevel)
name=cc-gate-machine
network=cc-gate-net
image=cc-gate-image
work=$(mktemp -d "${TMPDIR:-/tmp}/cc-gate.XXXXXX")
# Docker Desktop shares /tmp but not every TMPDIR.
case "$work" in
  /var/folders/*) rm -rf "$work"; work=$(mktemp -d /tmp/cc-gate.XXXXXX) ;;
esac

cleanup() {
  status=$?
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: left $name, $network, $image and $work in place."
    echo "  docker exec -it $name bash      # look around"
    echo "  docker rm -f $name && docker network rm $network && docker image rm $image && rm -rf $work"
    exit "$status"
  fi
  if docker container inspect "$name" >/dev/null 2>&1; then
    # The loop device belongs to the Docker VM's kernel, not the container:
    # detach it or it outlives the container.
    docker exec "$name" sh -c '
      systemctl stop "switch-agent@*" switch-controller switch-machine-boot 2>/dev/null
      umount -l /data 2>/dev/null
      [ -e /etc/cc-gate/loop-device ] && losetup -d "$(cat /etc/cc-gate/loop-device)"
      true' || true
    docker rm -f "$name" >/dev/null
  fi
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

if docker container inspect "$name" >/dev/null 2>&1; then
  echo "removing a previous $name"
  docker exec "$name" sh -c 'umount -l /data 2>/dev/null; [ -e /etc/cc-gate/loop-device ] && losetup -d "$(cat /etc/cc-gate/loop-device)"; true' || true
  docker rm -f "$name" >/dev/null
fi

echo "== building the runtime bundles"
(cd "$repo" && node deploy/hosted/build-runtime.mjs "$work/runtime")

echo "== building $image"
mkdir -p "$work/context"
cp "$gate/Dockerfile" "$repo/core/pyproject.toml" "$repo/core/uv.lock" "$work/context/"
docker build -q -t "$image" "$work/context"

echo "== booting $name"
docker network inspect "$network" >/dev/null 2>&1 || docker network create "$network" >/dev/null

# Capture host binfmt_misc state before the container starts.
binfmt_before=$(docker run --rm --privileged alpine ls /proc/sys/fs/binfmt_misc 2>/dev/null | sort || true)

docker run -d --name "$name" --hostname "$name" --network "$network" \
  --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  -v "$repo:/src:ro" -v "$work/runtime:/gate-runtime:ro" \
  "$image" >/dev/null

docker exec "$name" bash /src/deploy/hosted/vm/gate/container/setup.sh
docker exec "$name" bash /src/deploy/hosted/vm/gate/container/checks.sh "$@"

# Verify host binfmt_misc is unchanged after the container runs.
binfmt_after=$(docker run --rm --privileged alpine ls /proc/sys/fs/binfmt_misc 2>/dev/null | sort || true)
if [ "$binfmt_before" != "$binfmt_after" ]; then
  echo "FATAL: the gate cleared the host VM's binfmt_misc registrations!" >&2
  echo "before:" >&2
  echo "$binfmt_before" >&2
  echo "after:" >&2
  echo "$binfmt_after" >&2
  exit 1
fi
