"""Tests for the release step that pins the Helm chart to its images by digest.

A published chart that names its images by tag runs whatever the tag points at
on the day, so the pinner must either pin every first-party image or fail the
release. Silently pinning nothing, or the wrong line, is the failure to rule out.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import ModuleType

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
VALUES = REPO_ROOT / "deploy/remote/helm/switch/values.yaml"

HOSTED_VALUES = REPO_ROOT / "deploy/hosted/chart/values.yaml"

DIGESTS = {
    "switch-core": "sha256:" + "a" * 64,
    "gateway": "sha256:" + "b" * 64,
    "setup": "sha256:" + "c" * 64,
    "switch-hosted-controller": "sha256:" + "f" * 64,
}
SWITCH_IMAGES = ("switch-core", "gateway", "setup")


def _load(name: str) -> ModuleType:
    path = REPO_ROOT / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


pin_chart_images = _load("pin_chart_images")
prune_dev_packages = _load("prune_dev_packages")


def test_the_image_table_matches_the_dockerfiles_and_values() -> None:
    for name, image in pin_chart_images.IMAGES.items():
        chart = pin_chart_images.CHARTS[image.chart]
        values = yaml.safe_load((REPO_ROOT / chart.path / "values.yaml").read_text())
        assert (REPO_ROOT / image.dockerfile).is_file(), name
        assert (REPO_ROOT / image.context).is_dir(), name
        assert image.values_key in values, name
    assert set(pin_chart_images.images_of("switch")) == set(SWITCH_IMAGES)


def test_every_chart_has_its_render_check_values() -> None:
    for chart in pin_chart_images.CHARTS.values():
        assert (REPO_ROOT / chart.path / "Chart.yaml").is_file()
        for render in chart.renders:
            for values in render:
                assert (REPO_ROOT / values).is_file(), values


def test_pins_the_hosted_controller_chart_by_repository_and_digest() -> None:
    original = HOSTED_VALUES.read_text()
    pinned = pin_chart_images.pin(
        "switch-hosted-controller", original, "ghcr.io/acme", "1.2.3", DIGESTS
    )

    assert yaml.safe_load(pinned)["image"] == {
        "repository": "ghcr.io/acme/switch-hosted-controller",
        "digest": DIGESTS["switch-hosted-controller"],
    }
    changed = [
        a
        for a, b in zip(original.splitlines(), pinned.splitlines(), strict=True)
        if a != b
    ]
    assert len(changed) == 2


def test_verify_scopes_each_chart_to_its_own_images() -> None:
    hosted = _pod(_pinned("switch-hosted-controller"))
    assert pin_chart_images.verify(
        "switch-hosted-controller", hosted, "ghcr.io/acme"
    ) == [_pinned("switch-hosted-controller")]

    with pytest.raises(
        pin_chart_images.PinError, match="not an image of the switch chart"
    ):
        pin_chart_images.verify(
            "switch", _render(_pinned("switch-hosted-controller")), "ghcr.io/acme"
        )


def test_pins_every_first_party_image_in_the_real_values_file() -> None:
    pinned = yaml.safe_load(
        pin_chart_images.pin(
            "switch", VALUES.read_text(), "ghcr.io/acme", "1.2.3", DIGESTS
        )
    )

    assert pinned["global"]["imageRegistry"] == "ghcr.io/acme"
    assert (
        pinned["switchCore"]["image"] == f"switch-core:1.2.3@{DIGESTS['switch-core']}"
    )
    assert pinned["gateway"]["image"] == f"gateway:1.2.3@{DIGESTS['gateway']}"
    assert pinned["setup"]["image"] == f"setup:1.2.3@{DIGESTS['setup']}"


def test_changes_only_the_pinned_lines() -> None:
    original = VALUES.read_text()
    pinned = pin_chart_images.pin("switch", original, "ghcr.io/acme", "1.2.3", DIGESTS)

    changed = [
        (a, b)
        for a, b in zip(original.splitlines(), pinned.splitlines(), strict=True)
        if a != b
    ]
    assert len(changed) == 4  # the registry, then one image line per image
    # Pull policy is left to the chart, which derives it from the digest.
    assert yaml.safe_load(pinned)["switchCore"]["imagePullPolicy"] == ""


@pytest.mark.parametrize(
    "digests",
    [
        {k: v for k, v in DIGESTS.items() if k != "setup"},
        {**DIGESTS, "sidecar": "sha256:" + "d" * 64},
        {**DIGESTS, "gateway": "latest"},
        {**DIGESTS, "gateway": "sha256:" + "A" * 64},
    ],
    ids=["missing", "unknown", "not-a-digest", "uppercase"],
)
def test_refuses_digests_that_do_not_cover_exactly_the_images(
    digests: dict[str, str],
) -> None:
    with pytest.raises(pin_chart_images.PinError):
        pin_chart_images.pin(
            "switch", VALUES.read_text(), "ghcr.io/acme", "1.2.3", digests
        )


def test_reads_digests_from_a_directory_and_refuses_a_stray_file(
    tmp_path: Path,
) -> None:
    for name, digest in DIGESTS.items():
        (tmp_path / name).write_text(digest + "\n")
    assert pin_chart_images.read_digests(tmp_path) == DIGESTS

    (tmp_path / "sidecar").write_text("sha256:" + "d" * 64)
    with pytest.raises(pin_chart_images.PinError, match="sidecar"):
        pin_chart_images.read_digests(tmp_path)


def test_refuses_a_values_file_whose_shape_moved() -> None:
    values = VALUES.read_text().replace("\n  image: gateway:", "\n  img: gateway:")
    with pytest.raises(pin_chart_images.PinError, match="gateway.image"):
        pin_chart_images.pin("switch", values, "ghcr.io/acme", "1.2.3", DIGESTS)


def test_does_not_pin_a_nested_image_key() -> None:
    values = "global:\n  imageRegistry: ''\nswitchCore:\n  sidecar:\n    image: x\n"
    with pytest.raises(pin_chart_images.PinError, match="switchCore.image"):
        pin_chart_images.pin("switch", values, "r", "1", DIGESTS)


def _pod(*images: str, init: tuple[str, ...] = ()) -> str:
    return yaml.safe_dump(
        {
            "kind": "Deployment",
            "spec": {
                "template": {
                    "spec": {
                        "initContainers": [
                            {"name": f"i{n}", "image": i} for n, i in enumerate(init)
                        ],
                        "containers": [
                            {"name": f"c{n}", "image": i} for n, i in enumerate(images)
                        ],
                    }
                }
            },
        }
    )


def _pinned(name: str) -> str:
    return f"ghcr.io/acme/{name}:1.2.3@{DIGESTS[name]}"


def _render(*extra: str) -> str:
    return "---\n".join(
        [
            _pod(_pinned("switch-core"), init=(_pinned("switch-core"), "busybox:1.36")),
            _pod(_pinned("gateway")),
            _pod(_pinned("setup"), "postgres:16-alpine"),
            *(_pod(ref) for ref in extra),
        ]
    )


def test_verify_accepts_a_fully_pinned_render() -> None:
    assert len(pin_chart_images.verify("switch", _render(), "ghcr.io/acme")) == 3


@pytest.mark.parametrize(
    ("extra", "problem"),
    [
        ("ghcr.io/acme/switch-core:1.2.3", "not pinned by digest"),
        ("switch-core:latest", "not from ghcr.io/acme"),
        ("ghcr.io/other/gateway:1.2.3@" + DIGESTS["gateway"], "not from ghcr.io/acme"),
        ("registry.example:5000/setup", "not pinned by digest"),
        (
            "ghcr.io/acme/sidecar:1.2.3@" + "sha256:" + "d" * 64,
            "not an image of the switch chart",
        ),
    ],
    ids=[
        "by-tag",
        "bypasses-registry",
        "other-registry",
        "port-in-host",
        "unknown-image",
    ],
)
def test_verify_rejects_a_stray_first_party_reference(extra: str, problem: str) -> None:
    with pytest.raises(pin_chart_images.PinError, match=problem):
        pin_chart_images.verify("switch", _render(extra), "ghcr.io/acme")


def test_verify_rejects_a_render_missing_an_image() -> None:
    rendered = "---\n".join([_pod(_pinned("switch-core")), _pod(_pinned("gateway"))])
    with pytest.raises(pin_chart_images.PinError, match="setup"):
        pin_chart_images.verify("switch", rendered, "ghcr.io/acme")


def test_record_lists_every_image_and_chart() -> None:
    charts = {
        "switch": "sha256:" + "e" * 64,
        "switch-hosted-controller": "sha256:" + "d" * 64,
    }
    pins, summary = pin_chart_images.record(
        DIGESTS, "ghcr.io/acme/dev", "1.2.4-dev.7.gabc1234", "dev", "abc", charts
    )

    loaded = json.loads(pins)
    assert loaded["charts"] == {
        name: {
            "ref": f"oci://ghcr.io/acme/dev/charts/{name}",
            "version": "1.2.4-dev.7.gabc1234",
            "digest": digest,
        }
        for name, digest in charts.items()
    }
    assert {
        name: entry["digest"] for name, entry in loaded["images"].items()
    } == DIGESTS
    for name, digest in DIGESTS.items():
        assert f"ghcr.io/acme/dev/{name}@{digest}" in summary


def test_record_refuses_a_missing_chart_digest() -> None:
    with pytest.raises(pin_chart_images.PinError, match="chart digests"):
        pin_chart_images.record(
            DIGESTS, "r", "1", "dev", "abc", {"switch": "sha256:" + "e" * 64}
        )


def test_parses_chart_digest_flags_and_refuses_a_repeat() -> None:
    digest = "sha256:" + "e" * 64
    assert pin_chart_images._parse_pairs([f"switch={digest}"]) == {"switch": digest}
    with pytest.raises(pin_chart_images.PinError):
        pin_chart_images._parse_pairs([f"switch={digest}", f"switch={digest}"])
    with pytest.raises(pin_chart_images.PinError):
        pin_chart_images._parse_pairs([digest])


def _version(created: datetime, *tags: str) -> dict:
    return {
        "id": id(created),
        "name": "x",
        "created_at": created.isoformat(),
        "metadata": {"container": {"tags": list(tags)}},
    }


NOW = datetime(2026, 10, 9, tzinfo=UTC)


def test_prune_keeps_everything_young_or_among_the_newest() -> None:
    builds = [_version(NOW - timedelta(days=40 + n), f"b{n}") for n in range(5)]
    assert prune_dev_packages.doomed(builds, NOW, timedelta(days=30), keep=5) == []


def test_prune_deletes_old_builds_beyond_the_kept_ones_with_their_platform_manifests() -> (
    None
):
    builds = []
    for n in range(4):
        index = NOW - timedelta(days=40 + n)
        builds.append(_version(index, f"b{n}"))
        builds.append(
            _version(index - timedelta(seconds=30))
        )  # its untagged platform manifest

    doomed = prune_dev_packages.doomed(builds, NOW, timedelta(days=30), keep=2)

    kept = [v for v in builds if v not in doomed]
    assert {tag for v in kept for tag in v["metadata"]["container"]["tags"]} == {
        "b0",
        "b1",
    }
    assert len(kept) == 4  # two indexes and both of their platform manifests


def test_prune_never_deletes_the_build_main_points_at() -> None:
    builds = [_version(NOW - timedelta(days=40 + n), f"b{n}") for n in range(4)]
    builds.append(_version(NOW - timedelta(days=90), "b-stale", "main"))

    doomed = prune_dev_packages.doomed(builds, NOW, timedelta(days=30), keep=2)

    assert {tag for v in doomed for tag in v["metadata"]["container"]["tags"]} == {
        "b2",
        "b3",
    }


def test_the_pin_style_comes_from_the_chart() -> None:
    styles = {name: chart.pin_style for name, chart in pin_chart_images.CHARTS.items()}
    assert styles == {
        "switch": "tagged",
        "switch-hosted-controller": "repository-digest",
    }


def test_verify_ignores_a_third_party_image_sharing_a_first_party_name() -> None:
    rendered = "---\n".join(
        [
            _pod(_pinned("switch-hosted-controller")),
            _pod("docker.io/envoyproxy/gateway:v1"),
        ]
    )
    assert pin_chart_images.verify(
        "switch-hosted-controller", rendered, "ghcr.io/acme"
    ) == [_pinned("switch-hosted-controller")]
