#!/bin/sh
# Builds the agent box image in two stages, then optionally pushes it by digest.
#
#   ./build.sh --from-source <tag>     packs the box controller from this checkout, then builds
#   ./build.sh <controller.tgz> <tag>  builds from a controller package packed earlier
#
#   <tag>                  the local tag for the result, e.g. 2026-11-02, required
#   CONTROLLER_TGZ_SHA256  optional: the expected sha256 of the controller package. Set: a different package is refused.
#   PUSH_REPO              optional: a registry repository to push to, e.g. <registry>/<repo>. Not set: nothing is pushed.
#   BUILT_FROM             optional, <controller.tgz> mode only: the full commit id the package was packed from (40 hex),
#                          written to the switch.built-from label. Needs CONTROLLER_TGZ_SHA256 too. --from-source refuses it,
#                          because there the checkout's own commit is always the label.
#
# The box runs the box copy of the controller, @switch-console/agent-controller-box, never the upstream
# console/packages/agent-controller that Switch Console and the v1 controller release use. --from-source packs it
# the same way the controller release does: install with the frozen lockfile (with no dependency install scripts run
# on the build machine; the package is the same byte for byte without them), build the box package and the
# workspace packages it depends on, then run its `package` script, which bundles the CLI and the shared host
# (workspace dependencies included) into one switch-agent-controller-<version>.tgz with no dependencies to install.
# The checkout must be clean, so the commit it records is the commit the image was built from.
#
# Either way the package is checked before the image is built: it must be named switch-agent-controller with the
# switch-agent-controller command, so it installs where the entrypoint expects it, and it must install and report
# its version, and both bundles must carry strings only the box copy has. Its sha256 and the source commit
# (--from-source only) are printed and kept as image labels.
#
# Stage 1 (Dockerfile) builds the base with the provider CLIs; stage 2 (Dockerfile.controller-update) puts the
# controller package and the entrypoint into it. Builds for the local machine's architecture only. There are no
# defaults for the registry, the account or any image digest: pass PUSH_REPO, or nothing is pushed.
set -eu
cd "$(dirname "$0")"
usage='usage: ./build.sh --from-source <tag> | ./build.sh <controller.tgz> <tag>'
src=${1:?$usage}
tag=${2:?$usage}
work=$(mktemp -d)
trap 'rm -rf "$work" ./controller.tgz' EXIT
commit=none

if [ "$src" = --from-source ]; then
  [ -z "${BUILT_FROM:-}" ] || { echo "BUILT_FROM is for <controller.tgz> mode only; --from-source labels the checkout's commit" >&2; exit 2; }
  console=$(cd ../../../../console && pwd)
  [ -z "$(git -C "$console" status --porcelain)" ] || { echo "the checkout has uncommitted changes" >&2; exit 2; }
  commit=$(git -C "$console" rev-parse HEAD)
  (
    cd "$console"
    pnpm install --frozen-lockfile --ignore-scripts
    pnpm --filter '@switch-console/agent-controller-box...' run build
    pnpm --filter @switch-console/agent-controller-box run package
  )
  version=$(node -p "require('$console/packages/agent-controller-box/package.json').version")
  tgz=$console/packages/agent-controller-box/dist-package/switch-agent-controller-$version.tgz
else
  tgz=$src
  if [ -n "${BUILT_FROM:-}" ]; then
    printf '%s' "$BUILT_FROM" | grep -qE '^[0-9a-f]{40}$' || { echo "BUILT_FROM must be a full 40-character commit id" >&2; exit 2; }
    [ -n "${CONTROLLER_TGZ_SHA256:-}" ] || { echo "BUILT_FROM needs CONTROLLER_TGZ_SHA256, so the label names a known package" >&2; exit 2; }
    commit=$BUILT_FROM
  fi
fi
[ -f "$tgz" ] || { echo "no such file: $tgz" >&2; exit 2; }

sha=$(shasum -a 256 "$tgz" | cut -d' ' -f1)
echo "controller package $(basename "$tgz") sha256 $sha"
if [ -n "${CONTROLLER_TGZ_SHA256:-}" ] && [ "$sha" != "$CONTROLLER_TGZ_SHA256" ]; then
  echo "REFUSE: sha256 $sha is not the expected $CONTROLLER_TGZ_SHA256" >&2; exit 1
fi

tar -xzf "$tgz" -C "$work" package/package.json package/cli.mjs package/shared-host.mjs
name=$(node -p "require('$work/package/package.json').name")
bin=$(node -p "Object.keys(require('$work/package/package.json').bin || {}).join(' ')")
deps=$(node -p "Object.keys(require('$work/package/package.json').dependencies || {}).length")
[ "$name" = switch-agent-controller ] || { echo "REFUSE: package name is '$name', not switch-agent-controller" >&2; exit 1; }
[ "$bin" = switch-agent-controller ] || { echo "REFUSE: package commands are '$bin', not switch-agent-controller" >&2; exit 1; }
[ "$deps" = 0 ] || { echo "REFUSE: the package lists $deps dependencies; it must be bundled whole" >&2; exit 1; }
# The box copy's own code must be inside the bundles, so a box is never built from upstream's controller or providers
# by mistake (a wrong path in the package script would otherwise go unnoticed). Each string is only in the box copy.
has() { grep -qF "$2" "$work/package/$1" || { echo "REFUSE: $1 lacks '$2', so it wasn't built from the box copy" >&2; exit 1; }; }
has cli.mjs pushTicketUntilTaken
has cli.mjs 'kept your message'
has shared-host.mjs 'kept your message'
echo "controller package carries the box copy's controller and providers"
npm install --global --ignore-scripts --prefix "$work/smoke" "$tgz" >/dev/null
echo "controller package installs and reports version $("$work/smoke/bin/switch-agent-controller" --version)"

cp "$tgz" ./controller.tgz
docker build --build-arg CONTROLLER_TGZ=controller.tgz -t "switch-agent-box-base:$tag" -f Dockerfile .
docker build --build-arg BASE_IMAGE="switch-agent-box-base:$tag" --build-arg CONTROLLER_TGZ=controller.tgz \
  --label "switch.controller-tgz-sha256=$sha" --label "switch.built-from=$commit" \
  -t "switch-agent-box:$tag" -f Dockerfile.controller-update .
docker image inspect "switch-agent-box:$tag" --format 'built {{.Id}} {{.Architecture}} {{.Size}}'
echo "built from commit $commit, controller package sha256 $sha"
if [ -n "${PUSH_REPO:-}" ]; then
  docker tag "switch-agent-box:$tag" "$PUSH_REPO:$tag"
  docker push "$PUSH_REPO:$tag" | tail -1
  echo "push by digest: $(docker image inspect "$PUSH_REPO:$tag" --format '{{index .RepoDigests 0}}')"
fi
