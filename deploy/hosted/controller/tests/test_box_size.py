"""A new box's size: one of three tiers (Base, the default, Plus and Max), its memory held whole in both containers.

The operator makes a box at its config's default size, with the controller's fixed resources; the cluster's box-pod
rule (P4) refuses a box of any other size. These checks keep the three in step: the config in the manifests, the
operator's code, and P4. A box made earlier at another size is still its own on re-claim through the config's kept
earlier size (`standard-before-held`), which P4 never lets the operator create.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from switch_hosted_controller.box_operator import (
    CONTROLLER_MEMORY_LIMIT,
    CONTROLLER_MEMORY_REQUEST,
    ProvisionAction,
    _bytes,
    box_objects,
    config_from,
)

HOSTED = Path(__file__).resolve().parents[2]
MANIFEST = (HOSTED / "k8s" / "40-switch-hosted.yaml").read_text()
POLICIES = (HOSTED / "k8s" / "30-admission-policies.yaml").read_text()
GiB = 1024**3


def _config_json() -> dict:
    match = re.search(r"^  config\.json: \|\n((?:    .*\n)+)", MANIFEST, re.M)
    assert match
    text = "\n".join(line[4:] for line in match.group(1).splitlines())
    text = text.replace("__DAILY_CALLS__", "500")
    return json.loads(re.sub(r'"__[A-Z0-9_]+__"', '"x"', text))


def _sizes() -> dict:
    return _config_json()["sizes"]


def _p4() -> str:
    (doc,) = [
        d
        for d in POLICIES.split("\n---\n")
        if re.search(r"^kind: ValidatingAdmissionPolicy$", d, re.M)
        and re.search(r"^  name: switch-v0-p4-box-pod$", d, re.M)
    ]
    return doc


def _p4_resources() -> tuple[dict, dict, dict, dict]:
    """P4's four pinned resource maps: controller requests and limits, agents requests and limits."""
    found = re.findall(
        r"variables\.c\[\?(\d)\]\.\?resources\.\?(requests|limits)\.orValue\(\{\}\) == (\{[^}]*\})",
        _p4(),
    )
    assert len(found) == 4, found
    out = {}
    for index, kind, body in found:
        out[(int(index), kind)] = json.loads(body.replace("'", '"'))
    return out[(0, "requests")], out[(0, "limits")], out[(1, "requests")], out[(1, "limits")]


TIERS = {"base": 11776, "plus": 24576, "max": 49152}  # MiB a box in total (11.5, 24 and 48 GiB)


def test_each_tier_holds_its_memory_whole_and_totals_its_size():
    config = _config_json()
    assert config["default_size"] == "base"
    assert CONTROLLER_MEMORY_REQUEST == CONTROLLER_MEMORY_LIMIT
    for name, total in TIERS.items():
        size = config["sizes"][name]
        assert size["memory_request"] == size["memory_limit"], name
        assert _bytes(size["memory_limit"]) + _bytes(CONTROLLER_MEMORY_LIMIT) == total * 1024**2, (
            name
        )


def _p4_tiers() -> list[tuple[dict, dict]]:
    body = re.search(r"\[\n((?:\s+\[\{.*\}\],?\n)+)\s+\]\.exists", _p4())
    assert body
    rows = re.findall(r"\[(\{[^}]*\}), (\{[^}]*\})\]", body.group(1))
    return [(json.loads(a.replace("'", '"')), json.loads(b.replace("'", '"'))) for a, b in rows]


def _p4_controller() -> tuple[dict, dict]:
    found = dict(
        (kind, json.loads(body.replace("'", '"')))
        for kind, body in re.findall(
            r"variables\.c\[\?0\]\.\?resources\.\?(requests|limits)\.orValue\(\{\}\) == (\{[^}]*\})",
            _p4(),
        )
    )
    return found["requests"], found["limits"]


def _built(size_name: str) -> dict:
    raw = _config_json()
    config = config_from(
        {
            **raw,
            "server_ip": "10.0.0.10",
            "server_url": "https://10.0.0.10",
            "image": "registry.example/box@sha256:" + "a" * 64,
            "zones": ["eu-west-3a"],
            "allowed_images": [],
            "default_size": size_name,
        },
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        "{}",
    )
    action = ProvisionAction.parse(
        {
            "action_id": "a1",
            "machine_id": "11111111-2222-4333-8444-555555555555",
            "user_keyed_id": "k1-" + "0123456789abcdef",
            "claim_token": "t" * 43,
        }
    )
    return dict(
        (o["kind"] + "/" + o["metadata"]["name"], o) for _, o in box_objects(action, config)
    )


@pytest.mark.parametrize("name", sorted(TIERS))
def test_p4_admits_each_tier_exactly_as_the_operator_makes_it(name):
    objects = _built(name)
    controller, agents = objects["StatefulSet/box"]["spec"]["template"]["spec"]["containers"]
    assert controller["resources"] == dict(
        zip(("requests", "limits"), _p4_controller(), strict=True)
    )
    assert (agents["resources"]["requests"], agents["resources"]["limits"]) in _p4_tiers()
    disk = objects["PersistentVolumeClaim/data-agents"]["spec"]["resources"]["requests"]["storage"]
    assert disk in _p3_disks() and disk == _sizes()[name]["disk"]


def test_p4_lists_exactly_the_three_tiers_and_nothing_else():
    configured = {
        (
            json.dumps({"cpu": s["cpu_request"], "memory": s["memory_request"]}, sort_keys=True),
            json.dumps({"cpu": s["cpu_limit"], "memory": s["memory_limit"]}, sort_keys=True),
        )
        for n, s in _sizes().items()
        if n in TIERS
    }
    listed = {
        (json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True)) for a, b in _p4_tiers()
    }
    assert listed == configured and len(listed) == 3


def test_p4_refuses_the_kept_earlier_size_and_an_off_list_one():
    tiers = _p4_tiers()
    old = _sizes()["standard-before-held"]
    assert (
        {"cpu": old["cpu_request"], "memory": old["memory_request"]},
        {"cpu": old["cpu_limit"], "memory": old["memory_limit"]},
    ) not in tiers
    mixed = (tiers[0][0], tiers[1][1])  # Base's requests with Plus's limits
    assert mixed not in tiers


def _p3_disks() -> list[str]:
    (listed,) = re.findall(r"\.orValue\(''\)\) in (\[[^\]]*\])\)\)", POLICIES)
    return json.loads(listed.replace("'", '"'))


def test_the_disk_rule_allows_each_tier_and_the_earlier_disk_only():
    assert sorted(_p3_disks()) == sorted({s["disk"] for s in _sizes().values()})


def test_the_earlier_size_is_the_one_boxes_were_made_at_before():
    """Boxes made before this change were made at this size; keep it exactly, or re-claiming one fails."""
    assert _sizes()["standard-before-held"] == {
        "disk": "15Gi",
        "cpu_request": "150m",
        "cpu_limit": "3",
        "memory_request": "768Mi",
        "memory_limit": "5376Mi",
    }


def test_a_placeholder_holds_exactly_one_base_box():
    """The drain worker's placeholder, the cluster's placeholder rule, and the proposed placer file all hold one
    Base box's requests (agents plus controller), so a free placeholder slot always fits a new box."""
    from switch_hosted_controller.drain_actions import PLACEHOLDER_CPU, PLACEHOLDER_MEMORY

    base = _sizes()["base"]
    cpu_m = int(base["cpu_request"].removesuffix("m")) + 100  # the controller's 100m
    memory = _bytes(base["memory_request"]) + _bytes(CONTROLLER_MEMORY_REQUEST)
    assert PLACEHOLDER_CPU == f"{cpu_m}m" and _bytes(PLACEHOLDER_MEMORY) == memory
    shape = f"{{''cpu'': ''{PLACEHOLDER_CPU}'',\n      ''memory'': ''{PLACEHOLDER_MEMORY}''}}"
    assert POLICIES.count(shape) == 1  # requests (limits are split differently by the line wrap)
    assert f"''{PLACEHOLDER_CPU}'', ''memory'': ''{PLACEHOLDER_MEMORY}''}}'" in POLICIES
    placer = (HOSTED / "placer" / "placeholders.PROPOSED.yaml").read_text()
    assert placer.count(f"{{ cpu: {PLACEHOLDER_CPU}, memory: {PLACEHOLDER_MEMORY} }}") == 2
