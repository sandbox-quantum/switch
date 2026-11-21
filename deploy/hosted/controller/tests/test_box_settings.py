"""The two shared services kept one per zone by their add-on settings, checked against the
add-on schemas; and the one box priority class."""

import json
import re
from pathlib import Path

HERE = Path(__file__).parent
BOX = HERE.parents[1] / "box"
SCHEMAS = HERE / "fixtures" / "addon-schemas"
# Each add-on's pod labels.
LABELS = {
    "coredns.json": {"k8s-app": "kube-dns"},
    "aws-ebs-csi-driver.json": {"app": "ebs-csi-controller"},
}

# -- The add-on settings, against the add-on schemas -------------------------------


def load(path):
    return json.loads(path.read_text())


def test_coredns_settings_use_only_keys_its_schema_has():
    schema = load(SCHEMAS / "coredns-v1.14.7-eksbuild.11.json")["definitions"]["Coredns"][
        "properties"
    ]
    values = load(BOX / "addon-values" / "coredns.json")
    assert set(values) <= set(schema)
    assert {"affinity", "topologySpreadConstraints", "podDisruptionBudget", "tolerations"} <= set(
        values
    )


def test_ebs_settings_nest_under_controller_and_use_only_keys_its_schema_has():
    schema = load(SCHEMAS / "aws-ebs-csi-driver-v1.67.1-eksbuild.1.json")["properties"]
    values = load(BOX / "addon-values" / "aws-ebs-csi-driver.json")
    assert set(values) == {"controller"}
    controller = schema["controller"]["properties"]
    assert set(values["controller"]) <= set(controller)
    assert set(values["controller"]["podDisruptionBudget"]) <= set(
        controller["podDisruptionBudget"]["properties"]
    )


def test_both_add_ons_are_kept_on_separate_machines_spread_by_zone_with_one_always_up():
    for path, labels in LABELS.items():
        values = load(BOX / "addon-values" / path)
        values = values.get("controller", values)
        assert values["replicaCount"] == 2
        assert values["nodeSelector"] == {"switch.dev/pool": "system"}
        assert {
            "key": "switch.dev/system",
            "operator": "Equal",
            "value": "true",
            "effect": "NoSchedule",
        } in values["tolerations"]
        (anti,) = values["affinity"]["podAntiAffinity"][
            "requiredDuringSchedulingIgnoredDuringExecution"
        ]
        assert anti == {
            "labelSelector": {"matchLabels": labels},
            "topologyKey": "kubernetes.io/hostname",
        }
        (spread,) = values["topologySpreadConstraints"]
        # ScheduleAnyway: a zone outage must never stop a copy from starting in the zone that's up.
        assert spread == {
            "maxSkew": 1,
            "topologyKey": "topology.kubernetes.io/zone",
            "whenUnsatisfiable": "ScheduleAnyway",
            "labelSelector": {"matchLabels": labels},
        }
        assert values["podDisruptionBudget"] == {"enabled": True, "maxUnavailable": 1}


# -- The box priority class ---------------------------------------------------------


def test_every_box_gets_one_equal_priority_that_never_preempts_and_ranks_below_shared_services():
    text = (BOX / "priorityclass-switch-box.yaml").read_text()
    assert re.search(r"^  name: switch-box$", text, re.M)
    value = int(re.search(r"^value: (\d+)$", text, re.M).group(1))
    assert 0 < value < 900000
    assert re.search(r"^preemptionPolicy: Never$", text, re.M)
    assert re.search(r"^globalDefault: false$", text, re.M)
