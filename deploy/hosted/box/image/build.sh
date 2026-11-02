#!/bin/sh
# Builds the agent box image in two stages, then optionally pushes it by digest.
#
#   ./build.sh <controller.tgz> <tag>
#
#   <controller.tgz>  the packed switch-agent-controller (npm pack of console/packages/agent-controller), required
#   <tag>             the local tag for the result, e.g. 2026-11-02, required
#   PUSH_REPO         optional: a registry repository to push to, e.g. <registry>/<repo>. Not set: nothing is pushed.
#
# Stage 1 (Dockerfile) builds the base with the provider CLIs; stage 2 (Dockerfile.controller-update) puts the
# controller package and the entrypoint into it. Builds for the local machine's architecture only. There are no
# defaults for the registry, the account or any image digest: pass PUSH_REPO, or nothing is pushed.
set -eu
cd "$(dirname "$0")"
tgz=${1:?usage: ./build.sh <controller.tgz> <tag>}
tag=${2:?usage: ./build.sh <controller.tgz> <tag>}
[ -f "$tgz" ] || { echo "no such file: $tgz" >&2; exit 2; }
cp "$tgz" ./controller.tgz
trap 'rm -f ./controller.tgz' EXIT
docker build --build-arg CONTROLLER_TGZ=controller.tgz -t "switch-agent-box-base:$tag" -f Dockerfile .
docker build --build-arg BASE_IMAGE="switch-agent-box-base:$tag" --build-arg CONTROLLER_TGZ=controller.tgz \
  -t "switch-agent-box:$tag" -f Dockerfile.controller-update .
docker image inspect "switch-agent-box:$tag" --format 'built {{.Id}} {{.Architecture}} {{.Size}}'
if [ -n "${PUSH_REPO:-}" ]; then
  docker tag "switch-agent-box:$tag" "$PUSH_REPO:$tag"
  docker push "$PUSH_REPO:$tag" | tail -1
  echo "push by digest: $(docker image inspect "$PUSH_REPO:$tag" --format '{{index .RepoDigests 0}}')"
fi
