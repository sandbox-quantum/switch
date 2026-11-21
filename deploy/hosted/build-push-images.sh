#!/bin/sh
# Builds the two v2 images from this checkout, pushes them, and prints their digests for fill-placeholders.py.
#
#   deploy/hosted/build-push-images.sh <registry> <tag>
#   DRY_RUN=1 deploy/hosted/build-push-images.sh <registry> <tag>   prints what it would run, and runs nothing
#
#   <registry>  where to push, e.g. <registry host>/<path>. The images go to <registry>/switch-agent-box:<tag>
#               and <registry>/switch-hosted-controller:<tag>. Log in to it first (docker login, or your
#               registry's own login command). There is no default.
#   <tag>       the tag for both, e.g. 2026-11-03
#
# The box image is built by box/image/build.sh --from-source (which packs the box controller from this checkout,
# checks the package and labels the image with the commit). The hosted controller image is built from
# controller/Dockerfile; the egress-lists generator uses the same image. The checkout must be clean, so both
# images record the commit they were built from.
#
# Both images are built for this machine's architecture only, so build on a machine of the same architecture
# as the gVisor node group (arm64 for Graviton machines, amd64 for Intel and AMD).
set -eu
usage='usage: deploy/hosted/build-push-images.sh <registry> <tag>'
registry=${1:?$usage}
tag=${2:?$usage}
case $registry in
  */ | *:* | *@*) echo "give the registry without a trailing slash, tag or digest: <host>/<path>" >&2; exit 2 ;;
esac
printf '%s' "$tag" | grep -qE '^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$' || { echo "not a valid image tag: $tag" >&2; exit 2; }
[ "$tag" != latest ] || { echo "give a dated tag, not latest: the images are used by digest" >&2; exit 2; }
hosted=$(cd "$(dirname "$0")" && pwd)
if [ "${DRY_RUN:-}" = 1 ]; then
  echo "would build from commit $(git -C "$hosted" rev-parse HEAD) for $(uname -m), then run:"
  echo "  PUSH_REPO=$registry/switch-agent-box $hosted/box/image/build.sh --from-source $tag"
  echo "  docker build --label switch.built-from=<commit> -t $registry/switch-hosted-controller:$tag $hosted/controller"
  echo "  docker push $registry/switch-hosted-controller:$tag"
  echo "and print --box-image <repo@sha256:...> and --controller-image <repo@sha256:...> for fill-placeholders.py"
  exit 0
fi
[ -z "$(git -C "$hosted" status --porcelain)" ] || { echo "the checkout has uncommitted changes" >&2; exit 2; }
commit=$(git -C "$hosted" rev-parse HEAD)
echo "building from commit $commit for $(uname -m)"

out=$(mktemp)
trap 'rm -f "$out"' EXIT
PUSH_REPO="$registry/switch-agent-box" "$hosted/box/image/build.sh" --from-source "$tag" | tee "$out"
box=$(sed -n 's/^push by digest: //p' "$out")
printf '%s' "$box" | grep -qE '@sha256:[0-9a-f]{64}$' || { echo "FAILED: no digest for the box image" >&2; exit 1; }

ctl_repo="$registry/switch-hosted-controller"
docker build --label "switch.built-from=$commit" -t "$ctl_repo:$tag" "$hosted/controller"
docker push "$ctl_repo:$tag" | tail -1
ctl=$(docker image inspect "$ctl_repo:$tag" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -F "$ctl_repo@" | head -1)
printf '%s' "$ctl" | grep -qE '@sha256:[0-9a-f]{64}$' || { echo "FAILED: no digest for the controller image" >&2; exit 1; }

echo
echo "Pushed. For fill-placeholders.py:"
echo "  --box-image $box"
echo "  --controller-image $ctl"
