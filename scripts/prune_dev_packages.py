#!/usr/bin/env python3
"""Delete old dev builds from GHCR, and the dev controller releases.

Every push to main publishes the images and chart under `<owner>/dev/…`
(see .github/workflows/switch-release.yml), and the agent controller as a
GitHub prerelease tagged `switch-agent-controller-v<x.y.z>-dev.<n>.g<sha>`. Those packages hold nothing but dev
builds, so pruning them cannot touch a release. A version is deleted when it is
older than `--max-age-days` AND older than the `--keep` newest tagged builds,
so a quiet month does not empty the package and leave the dev environment
pinned to a digest that no longer exists. The version a chart's moving `main`
tag points at is never deleted, however old: development follows that tag.

A multi-arch image is an index plus one untagged manifest per platform, pushed
moments before it. The cutoff is set an hour before the oldest kept build, so a
kept index keeps its platform manifests; untagged manifests older than that
belong to builds being deleted anyway.

The dev controller releases are pruned by the same rule: a prerelease whose
tag names a `-dev.` version is deleted, with its tag, when it is older than
`--max-age-days` and outside the `--keep` newest. Nothing else in the
repository's releases is touched: a release or an RC is never a prerelease
with a dev version.

Needs `gh` authenticated with a token that may delete the packages' versions
and the repository's releases and tags (the publishing repository's
GITHUB_TOKEN with `packages: write` and `contents: write`).

Usage:
    python scripts/prune_dev_packages.py --owner <org> --repository <org>/<repo> \\
        --max-age-days 30 --keep 20 [--dry-run]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import quote


def _published() -> tuple[list[str], list[str]]:
    path = Path(__file__).with_name("pin_chart_images.py")
    spec = importlib.util.spec_from_file_location("pin_chart_images", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return list(module.IMAGES), list(module.CHARTS)


def _gh(*args: str) -> str:
    return subprocess.run(
        ["gh", "api", *args], check=True, capture_output=True, text=True
    ).stdout


def _versions(owner: str, package: str) -> list[dict]:
    pages = _gh(
        "--paginate",
        "--slurp",
        f"/orgs/{owner}/packages/container/{quote(package, safe='')}/versions",
    )
    return [version for page in json.loads(pages) for version in page]


def _created(version: dict) -> datetime:
    return datetime.fromisoformat(version["created_at"].replace("Z", "+00:00"))


FOLLOWED_TAG = "main"


def _tags(version: dict) -> list[str]:
    return version.get("metadata", {}).get("container", {}).get("tags") or []


def doomed(
    versions: list[dict], now: datetime, max_age: timedelta, keep: int
) -> list[dict]:
    tagged = sorted((v for v in versions if _tags(v)), key=_created, reverse=True)
    if len(tagged) <= keep:
        return []
    cutoff = min(now - max_age, _created(tagged[keep - 1]) - timedelta(hours=1))
    return [
        v for v in versions if _created(v) < cutoff and FOLLOWED_TAG not in _tags(v)
    ]


CONTROLLER_TAG_PREFIX = "switch-agent-controller-v"


def is_dev_controller_release(release: dict) -> bool:
    tag = release["tag_name"]
    return (
        bool(release.get("prerelease"))
        and tag.startswith(CONTROLLER_TAG_PREFIX)
        and "-dev." in tag[len(CONTROLLER_TAG_PREFIX) :]
    )


def doomed_controller_releases(
    releases: list[dict], now: datetime, max_age: timedelta, keep: int
) -> list[dict]:
    dev = sorted(
        (r for r in releases if is_dev_controller_release(r)),
        key=_created,
        reverse=True,
    )
    return [r for r in dev[keep:] if _created(r) < now - max_age]


def _prune_controller_releases(
    repository: str, now: datetime, max_age: timedelta, keep: int, dry_run: bool
) -> None:
    pages = _gh("--paginate", "--slurp", f"/repos/{repository}/releases?per_page=100")
    releases = [release for page in json.loads(pages) for release in page]
    delete = doomed_controller_releases(releases, now, max_age, keep)
    dev = sum(1 for r in releases if is_dev_controller_release(r))
    print(f"{repository} dev controller releases: {dev}, deleting {len(delete)}")
    for release in delete:
        tag = release["tag_name"]
        print(
            f"  {'would delete' if dry_run else 'delete'} {tag} {release['created_at']}"
        )
        if not dry_run:
            _gh("--method", "DELETE", f"/repos/{repository}/releases/{release['id']}")
            _gh(
                "--method",
                "DELETE",
                f"/repos/{repository}/git/refs/tags/{quote(tag, safe='')}",
            )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--owner", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--max-age-days", type=int, required=True)
    parser.add_argument("--keep", type=int, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.keep < 1:
        parser.error("--keep must be at least 1")

    now = datetime.now(UTC)
    images, charts = _published()
    packages = [f"dev/{name}" for name in images] + [
        f"dev/charts/{name}" for name in charts
    ]
    for package in packages:
        try:
            versions = _versions(args.owner, package)
        except subprocess.CalledProcessError as exc:
            if "404" in exc.stderr or "Not Found" in exc.stderr:
                print(f"{package}: not published yet")
                continue
            raise
        delete = doomed(versions, now, timedelta(days=args.max_age_days), args.keep)
        print(f"{package}: {len(versions)} versions, deleting {len(delete)}")
        for version in delete:
            tags = _tags(version) or ["<untagged>"]
            print(
                f"  {'would delete' if args.dry_run else 'delete'} {version['name']} {','.join(tags)} {version['created_at']}"
            )
            if not args.dry_run:
                _gh(
                    "--method",
                    "DELETE",
                    f"/orgs/{args.owner}/packages/container/{quote(package, safe='')}/versions/{version['id']}",
                )
    _prune_controller_releases(
        args.repository,
        now,
        timedelta(days=args.max_age_days),
        args.keep,
        args.dry_run,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
