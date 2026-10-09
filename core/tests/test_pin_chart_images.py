"""Tests for the release step that pins the Helm chart to its images by digest.

A published chart that names its images by tag runs whatever the tag points at
on the day, so the pinner must either pin every first-party image or fail the
release. Silently pinning nothing, or the wrong line, is the failure to rule out.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
VALUES = REPO_ROOT / "deploy/remote/helm/switch/values.yaml"

DIGESTS = {
    "switch-core": "sha256:" + "a" * 64,
    "gateway": "sha256:" + "b" * 64,
    "setup": "sha256:" + "c" * 64,
}


def _load() -> ModuleType:
    path = REPO_ROOT / "scripts" / "pin_chart_images.py"
    spec = importlib.util.spec_from_file_location("pin_chart_images", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


pin_chart_images = _load()


def test_pins_every_first_party_image_in_the_real_values_file() -> None:
    original = VALUES.read_text()
    pinned = yaml.safe_load(
        pin_chart_images.pin(original, "ghcr.io/acme", "1.2.3", DIGESTS)
    )

    assert pinned["global"]["imageRegistry"] == "ghcr.io/acme"
    assert (
        pinned["switchCore"]["image"] == f"switch-core:1.2.3@{DIGESTS['switch-core']}"
    )
    assert pinned["gateway"]["image"] == f"gateway:1.2.3@{DIGESTS['gateway']}"
    assert pinned["setup"]["image"] == f"setup:1.2.3@{DIGESTS['setup']}"
    for key in ("switchCore", "gateway", "setup"):
        assert pinned[key]["imagePullPolicy"] == "IfNotPresent"


def test_changes_only_the_pinned_lines() -> None:
    original = VALUES.read_text()
    pinned = pin_chart_images.pin(original, "ghcr.io/acme", "1.2.3", DIGESTS)

    changed = [
        (a, b)
        for a, b in zip(original.splitlines(), pinned.splitlines(), strict=True)
        if a != b
    ]
    assert len(changed) == 7  # the registry, then an image and a pull policy per image
    assert (
        yaml.safe_load(original)["mattermost"] == yaml.safe_load(pinned)["mattermost"]
    )


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
        pin_chart_images.pin(VALUES.read_text(), "ghcr.io/acme", "1.2.3", digests)


def test_refuses_a_values_file_whose_shape_moved() -> None:
    values = VALUES.read_text().replace("\n  image: gateway:", "\n  img: gateway:")
    with pytest.raises(pin_chart_images.PinError, match="gateway.image"):
        pin_chart_images.pin(values, "ghcr.io/acme", "1.2.3", DIGESTS)


def test_does_not_pin_a_nested_image_key() -> None:
    values = "global:\n  imageRegistry: ''\nswitchCore:\n  sidecar:\n    image: x\n"
    with pytest.raises(pin_chart_images.PinError, match="switchCore.image"):
        pin_chart_images.pin(values, "r", "1", DIGESTS)


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


def test_verify_accepts_a_fully_pinned_render() -> None:
    rendered = "---\n".join(
        [
            _pod(_pinned("switch-core"), init=(_pinned("switch-core"), "busybox:1.36")),
            _pod(_pinned("gateway")),
            _pod(_pinned("setup"), "postgres:16-alpine"),
        ]
    )
    assert len(pin_chart_images.verify(rendered, "ghcr.io/acme")) == 3


def test_verify_rejects_a_first_party_image_by_tag() -> None:
    rendered = "---\n".join(
        [
            _pod(_pinned("switch-core"), init=("ghcr.io/acme/switch-core:1.2.3",)),
            _pod(_pinned("gateway")),
            _pod(_pinned("setup")),
        ]
    )
    with pytest.raises(pin_chart_images.PinError, match="not pinned"):
        pin_chart_images.verify(rendered, "ghcr.io/acme")


def test_verify_rejects_a_render_missing_an_image() -> None:
    rendered = "---\n".join([_pod(_pinned("switch-core")), _pod(_pinned("gateway"))])
    with pytest.raises(pin_chart_images.PinError, match="setup"):
        pin_chart_images.verify(rendered, "ghcr.io/acme")
