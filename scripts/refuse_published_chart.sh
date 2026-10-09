#!/usr/bin/env bash
# Fail unless a chart version is NOT yet in the registry.
#
# A version is published once: a re-run of the release rebuilds the images
# (builds are not bit-for-bit reproducible) and would push the chart again
# under the same version, pointing at new digests, so a version pin would no
# longer mean what it meant. Only helm's plain "not found" counts as
# unpublished; an auth or network error fails rather than reading as
# permission to push. Needs `helm registry login` done first.
#
# Usage: refuse_published_chart.sh oci://<registry>/<namespace>/charts/<name> <version>
set -euo pipefail

chart="${1:?chart reference required}"
version="${2:?version required}"

if out="$(helm show chart "$chart" --version "$version" 2>&1)"; then
    echo "::error::$chart:$version is already published. A version is published once; cut a new one."
    exit 1
fi
if ! grep -q ': not found$' <<<"$out"; then
    echo "::error::Could not tell whether $chart:$version exists: $out"
    exit 1
fi
echo "$chart:$version is not published yet"
