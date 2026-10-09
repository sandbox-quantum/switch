#!/usr/bin/env python3
"""Pin the Helm chart to the exact images it was built with, and check that it is.

The release builds the switch-core, gateway and setup images and then packages
the chart. Left alone, the chart's values name those images by a mutable tag,
so every deployment re-states which images go with which chart and gets
whatever the tag points at on the day. This writes each image's registry digest
into the chart's `values.yaml` before packaging, so pinning the chart version
pins the images with it, and what runs is reproducible from that one pin.

Two subcommands:

* `pin` rewrites `values.yaml` in place: `global.imageRegistry`, and for each
  first-party image `<name>:<version>@sha256:…` with pull policy
  `IfNotPresent` (a digest cannot change under the tag, so `Always` only costs a
  registry round trip). The edit is line-based so the file's comments, which
  are the chart's documentation under `helm show values`, survive.
* `verify` reads `helm template` output and fails unless every first-party
  image is digest-pinned and all of them are present. The release runs it on
  the chart it is about to push; PR CI runs it on a chart pinned with
  placeholder digests, so a new image value the pinner does not know about
  fails a pull request instead of shipping by tag.

Usage:
    python scripts/pin_chart_images.py pin --values <values.yaml> \\
        --registry ghcr.io/<owner> --version <version> \\
        --digest switch-core=sha256:… --digest gateway=sha256:… --digest setup=sha256:…
    helm template x <chart> | python scripts/pin_chart_images.py verify --registry ghcr.io/<owner>
"""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import yaml

# Image name as published -> the top-level values key whose `image` it fills.
IMAGES: dict[str, str] = {
    "switch-core": "switchCore",
    "gateway": "gateway",
    "setup": "setup",
}

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
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


def pin(values_text: str, registry: str, version: str, digests: dict[str, str]) -> str:
    missing = sorted(set(IMAGES) - set(digests))
    unknown = sorted(set(digests) - set(IMAGES))
    if missing or unknown:
        raise PinError(
            f"digests must cover exactly {sorted(IMAGES)}; missing {missing}, unknown {unknown}"
        )
    for name, digest in digests.items():
        if not DIGEST.match(digest):
            raise PinError(f"{name}: {digest!r} is not a sha256 digest")
    if not registry or registry.endswith("/"):
        raise PinError(
            f"registry {registry!r} must be non-empty with no trailing slash"
        )
    if not version:
        raise PinError("version must be non-empty")

    lines = values_text.splitlines(keepends=True)
    _set_child(lines, "global", "imageRegistry", f'"{registry}"')
    for name, key in IMAGES.items():
        _set_child(lines, key, "image", f"{name}:{version}@{digests[name]}")
        _set_child(lines, key, "imagePullPolicy", "IfNotPresent")
    pinned = "".join(lines)

    loaded = yaml.safe_load(pinned)
    if loaded["global"]["imageRegistry"] != registry:
        raise PinError("pinned values do not read back the registry")
    for name, key in IMAGES.items():
        if loaded[key]["image"] != f"{name}:{version}@{digests[name]}":
            raise PinError(f"pinned values do not read back {key}.image")
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


def verify(rendered: str, registry: str) -> list[str]:
    """Return every first-party image reference, or raise if any is unpinned."""
    refs = sorted(
        {ref for doc in yaml.safe_load_all(rendered) if doc for ref in _images(doc)}
    )
    prefix = f"{registry}/"
    ours = [ref for ref in refs if ref.startswith(prefix)]
    unpinned = [ref for ref in ours if not re.search(r"@sha256:[0-9a-f]{64}$", ref)]
    if unpinned:
        raise PinError(f"first-party images not pinned by digest: {unpinned}")
    seen = {ref[len(prefix) :].split("@")[0].split(":")[0] for ref in ours}
    absent = sorted(set(IMAGES) - seen)
    if absent:
        raise PinError(
            f"first-party images missing from the rendered chart: {absent}; rendered images: {refs}"
        )
    return ours


def _parse_digests(pairs: list[str]) -> dict[str, str]:
    digests: dict[str, str] = {}
    for pair in pairs:
        name, sep, digest = pair.partition("=")
        if not sep:
            raise PinError(f"--digest {pair!r} must be <image>=sha256:<hex>")
        if name in digests:
            raise PinError(f"--digest {name} given twice")
        digests[name] = digest
    return digests


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_pin = sub.add_parser("pin", help="write image digests into values.yaml")
    p_pin.add_argument("--values", required=True, type=Path)
    p_pin.add_argument("--registry", required=True)
    p_pin.add_argument("--version", required=True)
    p_pin.add_argument("--digest", required=True, action="append", default=[])

    p_verify = sub.add_parser(
        "verify", help="check rendered manifests (stdin) are digest-pinned"
    )
    p_verify.add_argument("--registry", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "pin":
            text = args.values.read_text()
            args.values.write_text(
                pin(text, args.registry, args.version, _parse_digests(args.digest))
            )
            print(f"pinned {args.values}")
        else:
            for ref in verify(sys.stdin.read(), args.registry):
                print(ref)
    except PinError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
