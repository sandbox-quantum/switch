#!/usr/bin/env python3
"""Pin the Helm charts to the exact images they were built with, and check that they are.

The release builds the images and then packages the charts. Left alone, a
chart's values name its images by a mutable tag (or not at all), so every
deployment re-states which images go with which chart and gets whatever the tag
points at on the day. This writes each image's registry digest into its chart's
`values.yaml` before packaging, so pinning a chart version pins its images with
it, and what runs is reproducible from that one pin.

Two charts are published:

* `switch` (deploy/remote/helm/switch): switch-core, gateway, setup and the
  optional decision service (switch-decision), with its Strands Decider model
  server (switch-decision-strands).
* `switch-hosted-controller` (deploy/hosted/chart): the controller that runs
  Switch cloud machines, and its one image.

Packaging and publishing them is scripts/release_charts.sh, which reads `charts`.

`IMAGES` and `CHARTS` below are the only lists. The release workflow builds its
image matrix from `images` and packages the charts `charts` names, and every
other subcommand refuses a set of digests that is not exactly `IMAGES`, so
adding an image or a chart here is the whole change and forgetting one anywhere
fails loudly.

Subcommands:

* `images` prints the image build matrix as JSON; `charts` prints the charts.
* `pin --chart <name>` rewrites that chart's `values.yaml` in place, in the
  chart's `pin_style`. The switch chart gets `global.imageRegistry` and
  `<name>:<version>@sha256:…` per image, at `<values_key>.image`, where
  `values_key` may be a dotted path to a nested mapping (it pulls a
  digest-pinned image `IfNotPresent` on its own); the hosted controller chart gets
  `image.repository` and `image.digest`, so its image renders as
  `<registry>/<name>@sha256:…`, with no tag. The edit is
  line-based so the file's comments, which are the chart's documentation under
  `helm show values`, survive.
* `verify --chart <name>` reads `helm template` output and fails unless every
  image of that chart — recognised by repository name, whatever registry it
  names — renders from the pinning registry and by digest, all of them are
  present, and the chart renders nothing else from the pinning registry.
  An image marked `optional` (rendered only with an optional workload on) may
  be missing from a render.
* `covered --chart <name>` reads the image references `verify` printed for all
  of the chart's renders and fails unless every image of the chart is among
  them, so an optional image is still checked in some render.
* `record` writes the pins (images and charts) as JSON for whatever promotes the
  build next, and as a Markdown table for the run summary.

Usage:
    python scripts/pin_chart_images.py images
    python scripts/pin_chart_images.py charts
    python scripts/pin_chart_images.py pin --chart switch --registry ghcr.io/<owner> \\
        --version <version> --digests-dir <dir>
    python scripts/pin_chart_images.py pin ... --placeholder-digests
    helm template x <chart> | python scripts/pin_chart_images.py verify --chart switch \\
        --registry ghcr.io/<owner>
    cat <refs of every render> | python scripts/pin_chart_images.py covered --chart switch
    python scripts/pin_chart_images.py record --digests-dir <dir> --registry ghcr.io/<owner> \\
        --version <version> --channel <channel> --commit <sha> \\
        --chart-digest switch=sha256:… --chart-digest switch-hosted-controller=sha256:… \\
        --json <out.json> --summary <out.md>

`--digests-dir` holds one file per image, named by the image, containing its
`sha256:` digest: what the release's image jobs upload.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml

MULTI_ARCH = "linux/amd64,linux/arm64"


@dataclass(frozen=True)
class Image:
    chart: str
    # Values key holding the image: a top-level key, or a dotted path to a
    # nested mapping ("decision.modelServer.strands"). What goes under it is
    # the chart's `pin_style`.
    values_key: str
    dockerfile: str
    context: str
    # Rendered only when an optional workload is switched on (decision.enabled,
    # say), so a render may leave it out; `covered` still requires it in at
    # least one of the chart's renders.
    optional: bool
    # What the release builds it for.
    platforms: str = MULTI_ARCH
    # A multi-GB image (CUDA and PyTorch): the release frees the runner's disk
    # before building it and keeps it out of the GitHub Actions layer cache,
    # whose 10 GB per repository it would fill on its own.
    large: bool = False


@dataclass(frozen=True)
class Chart:
    path: str
    # "tagged": `global.imageRegistry`, and `<key>.image: <name>:<version>@<digest>`.
    # "repository-digest": `<key>.repository: <registry>/<name>`, `<key>.digest`.
    pin_style: Literal["tagged", "repository-digest"]
    # Whether `helm lint` passes on the defaults alone; a chart whose values
    # schema requires values is linted only with its renders' values.
    lint_defaults: bool
    # Each inner list is one `helm template` render (its -f files) that
    # `verify` checks: placeholder secrets, and the optional workloads on.
    renders: tuple[tuple[str, ...], ...]


CHARTS: dict[str, Chart] = {
    "switch": Chart(
        "deploy/remote/helm/switch",
        "tagged",
        True,
        (
            ("deploy/remote/helm/render-check-values.yaml",),
            (
                "deploy/remote/helm/render-check-values.yaml",
                "deploy/remote/helm/render-check-optional-values.yaml",
            ),
        ),
    ),
    "switch-hosted-controller": Chart(
        "deploy/hosted/chart",
        "repository-digest",
        False,
        (("deploy/hosted/render-check-values.yaml",),),
    ),
}

# Image name as published -> its chart, which values key it fills, and how it
# is built.
IMAGES: dict[str, Image] = {
    "switch-core": Image(
        "switch",
        "switchCore",
        "deploy/shared_resources/images/Dockerfile.switch",
        ".",
        False,
    ),
    "gateway": Image(
        "switch",
        "gateway",
        "deploy/shared_resources/images/Dockerfile.gateway",
        ".",
        False,
    ),
    "setup": Image(
        "switch", "setup", "deploy/shared_resources/images/Dockerfile.setup", ".", False
    ),
    # The decision service behind auto-route; the chart runs it with
    # decision.enabled.
    "switch-decision": Image(
        "switch", "decision", "decision/Dockerfile", "decision", True
    ),
    # Strands Decider's model server, beside the decision service when
    # decision.modelServer.kind is strands (the default). NVIDIA GPUs on x86
    # only, so amd64 alone.
    "switch-decision-strands": Image(
        "switch",
        "decision.modelServer.strands",
        "decision/model-servers/strands/Dockerfile",
        "decision/model-servers/strands",
        True,
        platforms="linux/amd64",
        large=True,
    ),
    "switch-hosted-controller": Image(
        "switch-hosted-controller",
        "image",
        "deploy/hosted/controller/Dockerfile",
        "deploy/hosted/controller",
        False,
    ),
}


def images_of(chart: str) -> dict[str, Image]:
    if chart not in CHARTS:
        raise PinError(f"unknown chart {chart!r}; known: {sorted(CHARTS)}")
    return {name: image for name, image in IMAGES.items() if image.chart == chart}


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
PLACEHOLDER_DIGEST = "sha256:" + "0" * 64


class PinError(Exception):
    pass


def _block_end(lines: list[str], start: int, indent: int) -> int:
    """The line after the block opened by `lines[start]`, a key at `indent`."""
    for i in range(start + 1, len(lines)):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith("#"):
            continue
        if len(lines[i]) - len(lines[i].lstrip(" ")) <= indent:
            return i
    return len(lines)


def _set_child(lines: list[str], parent: str, child: str, value: str) -> None:
    """Set `parent.child` to `value`; `parent` is a top-level mapping key or a
    dotted path to a nested mapping (two-space indent per level).

    Each key on the path, and the `child` line, must appear exactly once at its
    indent inside its parent's block; anything else means the values file
    changed shape under the pinner, which must fail rather than pin the wrong
    line or nothing at all.
    """
    start, end = -1, len(lines)
    for depth, key in enumerate(parent.split(".")):
        pattern = re.compile(rf"^{' ' * (2 * depth)}{re.escape(key)}:\s*(#.*)?$")
        hits = [
            i for i in range(start + 1, end) if pattern.match(lines[i].rstrip("\n"))
        ]
        where = ".".join(parent.split(".")[:depth]) or "the top level"
        if not hits:
            raise PinError(f"no key {key!r} in {where}")
        if len(hits) > 1:
            raise PinError(f"key {key!r} appears more than once in {where}")
        start, end = hits[0], _block_end(lines, hits[0], 2 * depth)

    indent = " " * (2 * len(parent.split(".")))
    pattern = re.compile(rf"^{indent}{re.escape(child)}:(\s.*)?$")
    hits = [i for i in range(start + 1, end) if pattern.match(lines[i].rstrip("\n"))]
    if len(hits) != 1:
        raise PinError(f"expected one {parent}.{child} line, found {len(hits)}")
    newline = "\n" if lines[hits[0]].endswith("\n") else ""
    lines[hits[0]] = f"{indent}{child}: {value}{newline}"


def _lookup(values: Any, path: str) -> Any:
    for key in path.split("."):
        values = values[key]
    return values


def _check_digests(digests: dict[str, str]) -> None:
    missing = sorted(set(IMAGES) - set(digests))
    unknown = sorted(set(digests) - set(IMAGES))
    if missing or unknown:
        raise PinError(
            f"digests must cover exactly {sorted(IMAGES)}; missing {missing}, unknown {unknown}"
        )
    for name, digest in digests.items():
        if not DIGEST.match(digest):
            raise PinError(f"{name}: {digest!r} is not a sha256 digest")


def _check_registry(registry: str) -> None:
    if not registry or registry.endswith("/"):
        raise PinError(
            f"registry {registry!r} must be non-empty with no trailing slash"
        )


def read_digests(directory: Path) -> dict[str, str]:
    if not directory.is_dir():
        raise PinError(f"digests directory {directory} does not exist")
    digests = {
        path.name: path.read_text().strip()
        for path in directory.iterdir()
        if path.is_file()
    }
    _check_digests(digests)
    return digests


def pin(
    chart: str, values_text: str, registry: str, version: str, digests: dict[str, str]
) -> str:
    _check_digests(digests)
    _check_registry(registry)
    if not version:
        raise PinError("version must be non-empty")
    images = images_of(chart)

    lines = values_text.splitlines(keepends=True)
    expected: dict[tuple[str, str], str] = {}
    if CHARTS[chart].pin_style == "tagged":
        expected[("global", "imageRegistry")] = registry
        for name, image in images.items():
            expected[(image.values_key, "image")] = f"{name}:{version}@{digests[name]}"
    else:
        for name, image in images.items():
            expected[(image.values_key, "repository")] = f"{registry}/{name}"
            expected[(image.values_key, "digest")] = digests[name]
    for (parent, child), value in expected.items():
        _set_child(lines, parent, child, f'"{value}"')
    pinned = "".join(lines)

    loaded = yaml.safe_load(pinned)
    for (parent, child), value in expected.items():
        if _lookup(loaded, parent)[child] != value:
            raise PinError(f"pinned values do not read back {parent}.{child}")
    return pinned


def _images(node: Any) -> Iterator[str]:
    if isinstance(node, dict):
        for key in ("containers", "initContainers"):
            for container in node.get(key) or []:
                if isinstance(container, dict) and "image" in container:
                    yield container["image"]
        for value in node.values():
            yield from _images(value)
    elif isinstance(node, list):
        for item in node:
            yield from _images(item)


def _repository(ref: str) -> str:
    """`reg/ns/name:tag@sha256:…` -> `reg/ns/name`."""
    ref = ref.split("@", 1)[0]
    slash = ref.rfind("/")
    colon = ref.rfind(":")
    return ref[:colon] if colon > slash else ref


def verify(chart: str, rendered: str, registry: str) -> list[str]:
    """Return the chart's image references, or raise if any is unpinned."""
    _check_registry(registry)
    images = images_of(chart)
    refs = sorted(
        {ref for doc in yaml.safe_load_all(rendered) if doc for ref in _images(doc)}
    )
    prefix = f"{registry}/"
    problems: list[str] = []
    ours: list[str] = []
    seen: set[str] = set()
    for ref in refs:
        repository = _repository(ref)
        name = repository.rsplit("/", 1)[-1]
        if name in images:
            ours.append(ref)
            seen.add(name)
            if repository != f"{registry}/{name}":
                problems.append(f"{ref}: not from {registry}")
            if not re.search(r"@sha256:[0-9a-f]{64}$", ref):
                problems.append(f"{ref}: not pinned by digest")
        elif ref.startswith(prefix):
            problems.append(
                f"{ref}: not an image of the {chart} chart; add it to IMAGES if it should be"
            )
    absent = sorted(
        name
        for name, image in images.items()
        if name not in seen and not image.optional
    )
    if absent:
        problems.append(f"missing from the rendered chart: {absent}")
    if problems:
        raise PinError(
            "chart is not pinned:\n  "
            + "\n  ".join(problems)
            + f"\nrendered images: {refs}"
        )
    return ours


def covered(chart: str, refs: str) -> None:
    """Raise unless every image of the chart is among `refs`, one per line.

    `refs` is what `verify` printed for all of the chart's renders together, so
    an optional image left out of one render must still be in another.
    """
    images = images_of(chart)
    seen = {_repository(ref).rsplit("/", 1)[-1] for ref in refs.split()}
    absent = sorted(set(images) - seen)
    if absent:
        raise PinError(
            f"no render of the {chart} chart has {absent}; switch on the workload "
            "that runs it in a render's values (Chart.renders)"
        )


def record(
    digests: dict[str, str],
    registry: str,
    version: str,
    channel: str,
    commit: str,
    chart_digests: dict[str, str],
) -> tuple[str, str]:
    _check_digests(digests)
    _check_registry(registry)
    if set(chart_digests) != set(CHARTS):
        raise PinError(
            f"chart digests must cover exactly {sorted(CHARTS)}; got {sorted(chart_digests)}"
        )
    for name, digest in chart_digests.items():
        if not DIGEST.match(digest):
            raise PinError(f"chart {name}: {digest!r} is not a sha256 digest")
    pins = {
        "version": version,
        "channel": channel,
        "commit": commit,
        "charts": {
            name: {
                "ref": f"oci://{registry}/charts/{name}",
                "version": version,
                "digest": chart_digests[name],
            }
            for name in CHARTS
        },
        "images": {
            name: {"ref": f"{registry}/{name}", "digest": digests[name]}
            for name in IMAGES
        },
    }
    rows = [
        f"| chart {name} | `oci://{registry}/charts/{name}:{version}@{chart_digests[name]}` |"
        for name in CHARTS
    ]
    rows += [f"| {name} | `{registry}/{name}@{digests[name]}` |" for name in IMAGES]
    summary = "\n".join(
        [
            f"## switch {version} ({channel})",
            "",
            "| Artifact | Pinned reference |",
            "| --- | --- |",
            *rows,
            "",
        ]
    )
    return json.dumps(pins, indent=2) + "\n", summary


def _parse_pairs(pairs: list[str]) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for pair in pairs:
        name, sep, value = pair.partition("=")
        if not sep or name in parsed:
            raise PinError(f"{pair!r}: expected <chart>=sha256:…, each chart once")
        parsed[name] = value
    return parsed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("images", help="print the image build matrix as JSON")
    sub.add_parser("charts", help="print the published charts as JSON")

    p_pin = sub.add_parser("pin", help="write image digests into a chart's values.yaml")
    p_pin.add_argument("--chart", required=True, choices=sorted(CHARTS))
    p_pin.add_argument("--registry", required=True)
    p_pin.add_argument("--version", required=True)
    source = p_pin.add_mutually_exclusive_group(required=True)
    source.add_argument("--digests-dir", type=Path)
    source.add_argument(
        "--placeholder-digests",
        action="store_true",
        help="for a dry run that pushed nothing",
    )

    p_verify = sub.add_parser(
        "verify", help="check rendered manifests (stdin) are digest-pinned"
    )
    p_verify.add_argument("--chart", required=True, choices=sorted(CHARTS))
    p_verify.add_argument("--registry", required=True)

    p_covered = sub.add_parser(
        "covered",
        help="check the image refs `verify` printed for every render (stdin) cover the chart",
    )
    p_covered.add_argument("--chart", required=True, choices=sorted(CHARTS))

    p_record = sub.add_parser(
        "record", help="write the pins as JSON and a Markdown summary"
    )
    p_record.add_argument("--digests-dir", required=True, type=Path)
    p_record.add_argument("--registry", required=True)
    p_record.add_argument("--version", required=True)
    p_record.add_argument("--channel", required=True)
    p_record.add_argument("--commit", required=True)
    p_record.add_argument(
        "--chart-digest", required=True, action="append", help="<chart>=sha256:…"
    )
    p_record.add_argument("--json", required=True, type=Path)
    p_record.add_argument("--summary", required=True, type=Path)

    args = parser.parse_args(argv)
    try:
        if args.command == "images":
            print(
                json.dumps(
                    [
                        {
                            "image": name,
                            "dockerfile": image.dockerfile,
                            "context": image.context,
                            "platforms": image.platforms,
                            "large": image.large,
                        }
                        for name, image in IMAGES.items()
                    ]
                )
            )
        elif args.command == "charts":
            print(
                json.dumps(
                    [
                        {
                            "chart": name,
                            "path": chart.path,
                            "lint_defaults": chart.lint_defaults,
                            "renders": chart.renders,
                        }
                        for name, chart in CHARTS.items()
                    ]
                )
            )
        elif args.command == "pin":
            digests = (
                dict.fromkeys(IMAGES, PLACEHOLDER_DIGEST)
                if args.placeholder_digests
                else read_digests(args.digests_dir)
            )
            values = Path(CHARTS[args.chart].path) / "values.yaml"
            values.write_text(
                pin(
                    args.chart, values.read_text(), args.registry, args.version, digests
                )
            )
            print(f"pinned {values}")
        elif args.command == "verify":
            for ref in verify(args.chart, sys.stdin.read(), args.registry):
                print(ref)
        elif args.command == "covered":
            covered(args.chart, sys.stdin.read())
        else:
            pins, summary = record(
                read_digests(args.digests_dir),
                args.registry,
                args.version,
                args.channel,
                args.commit,
                _parse_pairs(args.chart_digest),
            )
            args.json.write_text(pins)
            with args.summary.open("a") as out:
                out.write(summary)
            print(pins, end="")
    except PinError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
