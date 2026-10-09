#!/usr/bin/env python3
"""Pin the Helm charts to the exact images they were built with, and check that they are.

The release builds the images and then packages the charts. Left alone, a
chart's values name its images by a mutable tag (or not at all), so every
deployment re-states which images go with which chart and gets whatever the tag
points at on the day. This writes each image's registry digest into its chart's
`values.yaml` before packaging, so pinning a chart version pins its images with
it, and what runs is reproducible from that one pin.

Two charts are published:

* `switch` (deploy/remote/helm/switch): switch-core, gateway and setup.
* `switch-hosted-controller` (deploy/hosted/chart): the controller that runs
  Switch cloud machines, and its one image.

`IMAGES` and `CHARTS` below are the only lists. The release workflow builds its
image matrix from `images` and packages the charts `charts` names, and every
other subcommand refuses a set of digests that is not exactly `IMAGES`, so
adding an image or a chart here is the whole change and forgetting one anywhere
fails loudly.

Subcommands:

* `images` prints the image build matrix as JSON; `charts` prints the charts.
* `pin --chart <name>` rewrites that chart's `values.yaml` in place. The switch
  chart gets `global.imageRegistry` and `<name>:<version>@sha256:…` per image
  (it pulls a digest-pinned image `IfNotPresent` on its own); the hosted
  controller chart gets `image.repository` and `image.digest`. The edit is
  line-based so the file's comments, which are the chart's documentation under
  `helm show values`, survive.
* `verify --chart <name>` reads `helm template` output and fails unless every
  image of that chart — recognised by repository name, whatever registry it
  names — renders from the pinning registry and by digest, all of them are
  present, and the pinning registry serves no image the chart should not have.
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
from typing import Any

import yaml


@dataclass(frozen=True)
class Image:
    chart: str
    # Top-level values key holding the image: `<key>.image` in the switch
    # chart, `<key>.repository` / `<key>.digest` in the hosted controller's.
    values_key: str
    dockerfile: str
    context: str


@dataclass(frozen=True)
class Chart:
    path: str
    # Each inner list is one `helm template` render (its -f files) that
    # `verify` checks: placeholder secrets, and the optional workloads on.
    renders: tuple[tuple[str, ...], ...]


CHARTS: dict[str, Chart] = {
    "switch": Chart(
        "deploy/remote/helm/switch",
        (
            ("deploy/remote/helm/render-check-values.yaml",),
            (
                "deploy/remote/helm/render-check-values.yaml",
                "deploy/remote/helm/render-check-optional-values.yaml",
            ),
        ),
    ),
    "switch-hosted-controller": Chart(
        "deploy/hosted/chart", (("deploy/hosted/render-check-values.yaml",),)
    ),
}

# Image name as published -> its chart, which values key it fills, and how it
# is built.
IMAGES: dict[str, Image] = {
    "switch-core": Image(
        "switch", "switchCore", "deploy/shared_resources/images/Dockerfile.switch", "."
    ),
    "gateway": Image(
        "switch", "gateway", "deploy/shared_resources/images/Dockerfile.gateway", "."
    ),
    "setup": Image(
        "switch", "setup", "deploy/shared_resources/images/Dockerfile.setup", "."
    ),
    "switch-hosted-controller": Image(
        "switch-hosted-controller",
        "image",
        "deploy/hosted/controller/Dockerfile",
        "deploy/hosted/controller",
    ),
}


def images_of(chart: str) -> dict[str, Image]:
    if chart not in CHARTS:
        raise PinError(f"unknown chart {chart!r}; known: {sorted(CHARTS)}")
    return {name: image for name, image in IMAGES.items() if image.chart == chart}


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
PLACEHOLDER_DIGEST = "sha256:" + "0" * 64
TOP_LEVEL_KEY = re.compile(r"^([A-Za-z0-9_]+):\s*(#.*)?$")


class PinError(Exception):
    pass


def _set_child(lines: list[str], parent: str, child: str, value: str) -> None:
    """Set `parent.child` to `value`, where `parent` is a top-level mapping key.

    Exactly one `child` line at two-space indent must sit inside `parent`'s
    block; anything else means the values file changed shape under the pinner,
    which must fail rather than pin the wrong line or nothing at all.
    """
    start = None
    for i, line in enumerate(lines):
        m = TOP_LEVEL_KEY.match(line)
        if m and m.group(1) == parent:
            if start is not None:
                raise PinError(f"top-level key {parent!r} appears more than once")
            start = i
    if start is None:
        raise PinError(f"no top-level key {parent!r}")

    end = len(lines)
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line and not line[0].isspace() and not line.startswith("#"):
            end = i
            break

    pattern = re.compile(rf"^  {re.escape(child)}:(\s.*)?$")
    hits = [i for i in range(start + 1, end) if pattern.match(lines[i].rstrip("\n"))]
    if len(hits) != 1:
        raise PinError(f"expected one {parent}.{child} line, found {len(hits)}")
    newline = "\n" if lines[hits[0]].endswith("\n") else ""
    lines[hits[0]] = f"  {child}: {value}{newline}"


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
    if chart == "switch":
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
        if loaded[parent][child] != value:
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
        elif ref.startswith(prefix) or name in IMAGES:
            problems.append(
                f"{ref}: not an image of the {chart} chart; add it to IMAGES if it should be"
            )
    absent = sorted(set(images) - seen)
    if absent:
        problems.append(f"missing from the rendered chart: {absent}")
    if problems:
        raise PinError(
            "chart is not pinned:\n  "
            + "\n  ".join(problems)
            + f"\nrendered images: {refs}"
        )
    return ours


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
                        }
                        for name, image in IMAGES.items()
                    ]
                )
            )
        elif args.command == "charts":
            print(
                json.dumps(
                    [
                        {"chart": name, "path": chart.path, "renders": chart.renders}
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
