#!/usr/bin/env bash
# Package, check and publish the charts scripts/pin_chart_images.py names.
#
# One script for the release and PR CI, so PR CI checks exactly what the
# release builds.
#
#   refuse-published <oci-base> <version>
#       Fail if any chart already has <version>. The release runs this before
#       building anything.
#   build <registry> <version> <out-dir> (--digests-dir <dir> | --placeholder-digests)
#       For each chart: pin values.yaml, package it into <out-dir>, lint the
#       package (defaults where the chart allows, then each render's values),
#       and render the package for each render through `verify`. The image refs
#       the renders produce go to <out-dir>/<chart>.refs.
#   publish <oci-base> <version> <out-dir>
#       Push what `build` packaged and print `--chart-digest <chart>=<digest>`
#       for each chart. Every chart is checked before any is pushed. A chart
#       already at <version> is accepted only if it renders exactly the images
#       this build pinned, which is what a re-run after a failed push sees; its
#       registry digest is used. Anything else at that version fails the run.
#
# <oci-base> is oci://<registry>/<namespace>; charts live under <oci-base>/charts.
# Whether a version exists is decided only by helm's plain "not found"; an auth
# or network error fails rather than reading as permission to push. GHCR
# answers "not found" for a package that does not exist yet as well. Needs
# `helm registry login` done first, for refuse-published and publish.
set -euo pipefail

charts_json() { python3 scripts/pin_chart_images.py charts; }
field() { jq -r --arg c "$1" ".[] | select(.chart == \$c) | $2" <<<"$CHARTS"; }

# Prints "published" or "absent"; exits 1 when it cannot tell.
status() {
    local ref="$1" version="$2" out
    if out="$(helm show chart "$ref" --version "$version" 2>&1)"; then
        echo published
    elif grep -q ': not found$' <<<"$out"; then
        echo absent
    else
        echo "::error::Could not tell whether $ref:$version exists: $out" >&2
        return 1
    fi
}

# Renders <chart-ref> once per render of <chart> and prints the sorted image
# refs `verify` accepts.
rendered_refs() {
    local chart="$1" ref="$2" registry="$3" files args
    while read -r files; do
        args=()
        for f in $(jq -r '.[]' <<<"$files"); do args+=(-f "$f"); done
        helm template switch "$ref" "${args[@]}" \
            | python3 scripts/pin_chart_images.py verify --chart "$chart" --registry "$registry"
    done < <(field "$chart" '.renders[] | tojson') | sort -u
}

CHARTS="$(charts_json)"
command="${1:?usage: release_charts.sh refuse-published|build|publish ...}"
shift

case "$command" in
refuse-published)
    base="${1:?oci base required}" version="${2:?version required}"
    for chart in $(jq -r '.[].chart' <<<"$CHARTS"); do
        state="$(status "$base/charts/$chart" "$version")"
        if [ "$state" = published ]; then
            echo "::error::$base/charts/$chart:$version is already published. A version is published once; cut a new one."
            exit 1
        fi
        echo "$base/charts/$chart:$version is not published yet"
    done
    ;;

build)
    registry="${1:?registry required}" version="${2:?version required}" out="${3:?out dir required}"
    shift 3
    mkdir -p "$out"
    for chart in $(jq -r '.[].chart' <<<"$CHARTS"); do
        path="$(field "$chart" .path)"
        python3 scripts/pin_chart_images.py pin --chart "$chart" \
            --registry "$registry" --version "$version" "$@"
        git --no-pager diff -- "$path/values.yaml"
        helm package "$path" --version "$version" --app-version "$version" --destination "$out"
        tgz="$out/$chart-$version.tgz"
        if [ "$(field "$chart" .lint_defaults)" = true ]; then
            helm lint "$tgz"
        fi
        while read -r files; do
            args=()
            for f in $(jq -r '.[]' <<<"$files"); do args+=(-f "$f"); done
            helm lint "$tgz" "${args[@]}"
        done < <(field "$chart" '.renders[] | tojson')
        rendered_refs "$chart" "$tgz" "$registry" | tee "$out/$chart.refs"
    done
    ;;

publish)
    base="${1:?oci base required}" version="${2:?version required}" out="${3:?out dir required}"
    registry="${base#oci://}"
    to_push=()
    flags=()
    for chart in $(jq -r '.[].chart' <<<"$CHARTS"); do
        ref="$base/charts/$chart"
        state="$(status "$ref" "$version")"
        case "$state" in
        absent) to_push+=("$chart") ;;
        published)
            pulled="$(mktemp -d)"
            log="$(helm pull "$ref" --version "$version" --destination "$pulled" 2>&1)"
            digest="$(sed -n 's/^Digest: *//p' <<<"$log")"
            rendered_refs "$chart" "$pulled/$chart-$version.tgz" "$registry" >"$pulled/refs"
            if ! diff "$pulled/refs" "$out/$chart.refs" >&2; then
                echo "::error::$ref:$version is already published with other images than this build's. A version is published once; cut a new one." >&2
                exit 1
            fi
            echo "$ref:$version is already published with this build's images; keeping it." >&2
            flags+=(--chart-digest "$chart=$digest")
            ;;
        esac
    done
    for chart in ${to_push[@]+"${to_push[@]}"}; do
        log="$(helm push "$out/$chart-$version.tgz" "$base/charts" 2>&1)"
        echo "$log" >&2
        digest="$(sed -n 's/^Digest: *//p' <<<"$log")"
        flags+=(--chart-digest "$chart=$digest")
    done
    for ((i = 1; i < ${#flags[@]}; i += 2)); do
        if [[ ! "${flags[i]#*=}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
            echo "::error::no chart digest for ${flags[i]%%=*}; got '${flags[i]#*=}'" >&2
            exit 1
        fi
    done
    echo "${flags[*]}"
    ;;

*)
    echo "unknown command $command" >&2
    exit 2
    ;;
esac
