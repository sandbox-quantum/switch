"""`deploy/hosted/fill-placeholders.py`: fills every placeholder in the cluster files into a new folder, in the
shape the provisioner accepts, or refuses and writes nothing."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from switch_hosted_controller.box_operator import config_from

HOSTED = Path(__file__).resolve().parents[2]
SCRIPT = HOSTED / "fill-placeholders.py"
BOX = "reg.example/box@sha256:" + "a" * 64
OLDER = "reg.example/box@sha256:" + "b" * 64
OLDEST = "reg.example/box@sha256:" + "e" * 64
THIRD = "reg.example/box@sha256:" + "f" * 64
CONTROLLER = "reg.example/controller@sha256:" + "c" * 64
PAUSE = "reg.example/pause@sha256:" + "d" * 64
CA = "-----BEGIN CERTIFICATE-----\nMIIBexample\n-----END CERTIFICATE-----\n"


def _run(
    tmp_path: Path,
    *extra: str,
    out: str = "out",
    zones: tuple[str, ...] = ("xx-test-1a",),
    **overrides: str,
) -> subprocess.CompletedProcess[str]:
    ca = tmp_path / "ca.pem"
    ca.write_text(overrides.pop("ca", CA))
    values = {
        "--server-ip": "10.1.2.3",
        "--agents-subnet": "10.1.32.0/20",
        "--box-image": BOX,
        "--controller-image": CONTROLLER,
        "--pause-image": PAUSE,
        "--ca-cert": str(ca),
        "--kubernetes-service-ip": "10.100.0.1",
        **{f"--{k.replace('_', '-')}": v for k, v in overrides.items()},
    }
    argv = [sys.executable, str(SCRIPT), "--out", str(tmp_path / out)]
    for flag, value in values.items():
        argv += [flag, value]
    argv += [
        "--api-server-ip",
        "10.1.0.10",
        "--api-server-ip",
        "10.1.1.10",
        *[arg for zone in zones for arg in ("--zone", zone)],
        *extra,
    ]
    return subprocess.run(argv, capture_output=True, text=True, check=False)


def _block(text: str, key: str, indent: int) -> str:
    """A `key: |` block scalar's content, as the files lay ConfigMap data out."""
    match = re.search(rf"^ *{re.escape(key)}: \|\n((?:(?: {{{indent}}}.*)?\n)+)", text, re.M)
    assert match, key
    return "\n".join(line[indent:] for line in match.group(1).splitlines()).strip() + "\n"


def test_fills_every_placeholder_in_the_provisioners_shape(tmp_path: Path) -> None:
    result = _run(
        tmp_path,
        "--previous-box-image",
        OLDEST,
        "--previous-box-image",
        OLDER,
        "--zone",
        "xx-test-1b",
    )
    assert result.returncode == 0, result.stderr
    out = tmp_path / "out"
    names = sorted(p.name for p in out.iterdir())
    assert names == sorted(
        [p.name for p in (HOSTED / "k8s").glob("*.yaml")]
        + ["70-priorityclass-switch-box.yaml", "71-egress-proxy-networkpolicy.yaml"]
    )
    for path in out.iterdir():
        assert not re.search(r"__[A-Z0-9_]+__", path.read_text()), path.name

    hosted = (out / "40-switch-hosted.yaml").read_text()
    config = json.loads(_block(hosted, "config.json", 4))
    assert config["zones"] == ["xx-test-1a", "xx-test-1b"]
    assert config["allowed_images"] == [OLDEST, OLDER]
    loaded = config_from(
        config, _block(hosted, "box-ca.crt", 4), _block(hosted, "managed-settings.json", 4)
    )
    assert loaded.image == BOX
    assert loaded.allowed_images == {BOX, OLDER, OLDEST}

    policies = (out / "30-admission-policies.yaml").read_text()
    assert "matches('^(xx-test-1a|xx-test-1b)$')" in policies
    assert "eu-west-3" not in policies
    # P8 admits the current image and the two most recent earlier ones.
    assert f"in ['{BOX}', '{OLDEST}', '{OLDER}']" in policies
    assert CONTROLLER in hosted and PAUSE in hosted
    assert "10.1.32.0/20" in (out / "50-egress-proxy.yaml").read_text()
    # The cluster services may reach this cluster's `kubernetes` Service, not the test cluster's.
    assert hosted.count("cidr: 10.100.0.1/32") == 4
    assert "cidr: 10.100.0.1/32" in (out / "51-egress-lists.yaml").read_text()
    assert not any("172.20.0.1" in p.read_text() for p in out.iterdir())


def test_no_earlier_images_leaves_an_empty_allowed_list(tmp_path: Path) -> None:
    assert _run(tmp_path).returncode == 0
    hosted = (tmp_path / "out" / "40-switch-hosted.yaml").read_text()
    assert json.loads(_block(hosted, "config.json", 4))["allowed_images"] == []
    assert f"in ['{BOX}']" in (tmp_path / "out" / "30-admission-policies.yaml").read_text()


@pytest.mark.parametrize(
    ("extra", "overrides", "said"),
    [
        ((), {"box_image": "reg.example/box:latest"}, "pinned by digest"),
        (("--previous-box-image", BOX), {}, "must all differ"),
        ((), {"server_ip": "server.internal"}, "IPv4 address"),
        ((), {"agents_subnet": "10.1.32.1/20"}, "IPv4 network"),
        ((), {"agents_subnet": "0.0.0.0/0"}, "private range"),
        ((), {"agents_subnet": "8.8.8.0/24"}, "private range"),
        ((), {"agents_subnet": "10.0.0.0/8"}, "no wider than /16"),
        ((), {"ca": "not a certificate\n"}, "PEM certificate"),
        (("--zone", "eu west"), {}, "look like a zone"),
        (("--api-server-ip", "10.1.2.10"), {}, "exactly twice"),
        (
            (
                "--previous-box-image",
                OLDEST,
                "--previous-box-image",
                OLDER,
                "--previous-box-image",
                THIRD,
            ),
            {},
            "at most 2",
        ),
        ((), {"kubernetes_service_ip": "kubernetes.default"}, "IPv4 address"),
        (
            (),
            {"ca": CA + "-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----\n"},
            "private key",
        ),
    ],
)
def test_refuses_a_bad_value_and_writes_nothing(
    tmp_path: Path, extra: tuple[str, ...], overrides: dict[str, str], said: str
) -> None:
    result = _run(tmp_path, *extra, **overrides)
    assert result.returncode == 1
    assert "REFUSED" in result.stderr and said in result.stderr
    assert not (tmp_path / "out").exists()


def test_refuses_an_existing_folder(tmp_path: Path) -> None:
    (tmp_path / "out").mkdir()
    result = _run(tmp_path)
    assert result.returncode == 1 and "already exists" in result.stderr
    assert list((tmp_path / "out").iterdir()) == []


def test_refuses_a_folder_inside_the_repo(tmp_path: Path) -> None:
    inside = HOSTED / "filled-test-output-not-for-git"
    result = _run(tmp_path, out=str(inside))
    assert result.returncode == 1 and "inside this repo" in result.stderr
    assert not inside.exists()


def test_fills_zones_in_the_test_clusters_own_region(tmp_path: Path) -> None:
    """The files carry the test cluster's region in P4; a cluster in that region still fills."""
    result = _run(tmp_path, zones=("eu-west-3a", "eu-west-3b"))
    assert result.returncode == 0, result.stderr
    policies = (tmp_path / "out" / "30-admission-policies.yaml").read_text()
    assert "matches('^(eu-west-3a|eu-west-3b)$')" in policies
    assert "eu-west-3[abc]" not in policies


def test_takes_one_agents_subnet_per_zone(tmp_path: Path) -> None:
    """A node group across zones has a subnet in each; squid must accept them all."""
    result = _run(tmp_path, "--agents-subnet", "10.1.64.0/20")
    assert result.returncode == 0, result.stderr
    squid = (tmp_path / "out" / "50-egress-proxy.yaml").read_text()
    assert "acl agents src 10.1.32.0/20 10.1.64.0/20" in squid
