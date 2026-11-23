"""A box's pod, as the API server makes it, can land on a box cluster's agent node.

The box template carries no toleration (P4 refuses one on the StatefulSet template). The `gvisor` and
`gvisor-tuned` RuntimeClasses carry it in `scheduling.tolerations`, and the RuntimeClass admission step merges it
into every pod that runs under them. This renders the box's pod template the way the operator makes it, applies
the class's scheduling the way the API server does, and checks the pod tolerates every NoSchedule taint an agent
node carries.

`AGENT_NODE_TAINTS` mirrors the box cluster's agent node group (its infrastructure code, which isn't in this
repo). If the agent nodes gain a NoSchedule taint, add it here: the test then fails
until the classes tolerate it. The node gate's `switch.dev/gate1` start-up taint is left out on purpose: a box
must not land before gate 1 passes, which is that taint's whole point.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from switch_hosted_controller.box_operator import ProvisionAction, box_objects, config_from

HOSTED = Path(__file__).resolve().parents[2]
CLASSES = HOSTED / "k8s" / "11-classes.yaml"

PERSON = "k1-" + "0123456789abcdef"  # a keyed id, as Core makes them (no real person)
AGENT_NODE_TAINTS = [{"key": "switch.dev/pool", "value": "agents", "effect": "NoSchedule"}]
AGENT_NODE_LABELS = {"switch.dev/pool": "agents", "topology.kubernetes.io/zone": "eu-west-3a"}


def _classes() -> dict[str, str]:
    """Each RuntimeClass document of 11-classes.yaml, by name, as text (the package has no YAML library)."""
    out = {}
    for doc in CLASSES.read_text().split("\n---\n"):
        if re.search(r"^kind: RuntimeClass$", doc, re.M):
            (name,) = re.findall(r"^  name: (\S+)$", doc, re.M)
            out[name] = doc
    return out


def _class_tolerations(doc: str) -> list[dict[str, str]]:
    """`scheduling.tolerations` of one RuntimeClass, read from its block (each item's key, operator, value and
    effect on their own lines, as kubectl writes them)."""
    if "  tolerations:\n" not in doc:
        return []
    block = doc.split("  tolerations:\n", 1)[1]
    items: list[dict[str, str]] = []
    for line in block.splitlines():
        if not line.startswith("  ") or re.match(r"^  [A-Za-z]", line):
            break  # the end of the list: another key of `scheduling`, or past the document
        m = re.match(r"^  (?:- |  )(\w+): (\S+)$", line)
        if not m:
            continue
        if line.startswith("  - "):
            items.append({})
        items[-1][m.group(1)] = m.group(2).strip("'\"")
    return items


def _tolerates(toleration: dict[str, str], taint: dict[str, str]) -> bool:
    """Kubernetes' own matching: same key (or none with Exists), same effect (or none), and Equal with the same
    value, or Exists."""
    if toleration.get("key", "") not in ("", taint["key"]):
        return False
    if toleration.get("effect", "") not in ("", taint["effect"]):
        return False
    if toleration.get("operator", "Equal") == "Exists":
        return True
    return toleration.get("value", "") == taint["value"]


def _box_pod() -> dict:
    config = config_from(
        {
            "server_ip": "10.0.0.10",
            "server_url": "https://10.0.0.10",
            "image": "registry.example/hosted-agents-box@sha256:" + "a" * 64,
            "storage_class": "gp3",
            "proxy_host": "squid.egress-proxy.svc",
            "proxy_port": 3128,
            "zones": ["eu-west-3a"],
            "sizes": {
                "standard": {
                    "disk": "15Gi",
                    "cpu_request": "150m",
                    "cpu_limit": "3",
                    "memory_request": "768Mi",
                    "memory_limit": "5376Mi",
                }
            },
            "ceiling": 20,
            "daily_calls": 500,
            "default_size": "standard",
        },
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        "{}",
    )
    action = ProvisionAction.parse(
        {
            "action_id": "a1",
            "machine_id": "11111111-2222-4333-8444-555555555555",
            "user_keyed_id": PERSON,
            "claim_token": "t" * 43,
        }
    )
    (sts,) = [o for _, o in box_objects(action, config) if o["kind"] == "StatefulSet"]
    return sts["spec"]["template"]["spec"]


@pytest.mark.parametrize("name", ["gvisor", "gvisor-tuned"])
def test_a_box_pod_after_the_class_merge_tolerates_every_agent_node_taint(name: str) -> None:
    pod = _box_pod()
    assert "tolerations" not in pod  # P4: none on the template itself
    doc = _classes()[name]
    # The RuntimeClass admission step: the class's tolerations are added to the pod's.
    merged = list(pod.get("tolerations", [])) + _class_tolerations(doc)
    for taint in AGENT_NODE_TAINTS:
        assert any(_tolerates(t, taint) for t in merged), (name, taint)
    # Only that one: the class lets a pod onto agent nodes and nowhere it otherwise couldn't go.
    assert _class_tolerations(doc) == [
        {"key": "switch.dev/pool", "operator": "Equal", "value": "agents", "effect": "NoSchedule"}
    ]


def test_the_box_pod_still_lands_only_on_agent_nodes() -> None:
    """The nodeSelector the pod and the class carry both match an agent node's labels."""
    pod = _box_pod()
    for key, value in pod["nodeSelector"].items():
        assert AGENT_NODE_LABELS.get(key) == value
    assert pod["runtimeClassName"] == "gvisor"
    assert "switch.dev/pool: agents" in _classes()["gvisor"]


def test_the_gate1_start_up_taint_is_not_tolerated() -> None:
    """A box must wait for gate 1 on a new node: nothing here tolerates `switch.dev/gate1`."""
    gate = {"key": "switch.dev/gate1", "value": "pending", "effect": "NoSchedule"}
    for name, doc in _classes().items():
        assert not any(_tolerates(t, gate) for t in _class_tolerations(doc)), name


def test_the_gvisor_scope_policy_names_exactly_the_two_box_name_shapes() -> None:
    """`switch-gvisor-class-scope` lets a pod use a gVisor class only in box namespaces (and the gate's, the
    placeholders' and the drain room). Its box patterns must be `box_names`' two exact shapes, so the code and the
    policy can't drift: a pool box under a name the policy didn't know would never start."""
    from switch_hosted_controller.box_names import BOX_KEYED_NAMESPACE_RE, USER_NAMESPACE_RE

    policies = (HOSTED / "k8s" / "30-admission-policies.yaml").read_text()
    (doc,) = [
        d
        for d in policies.split("\n---\n")
        if re.search(r"^kind: ValidatingAdmissionPolicy$", d, re.M)
        and re.search(r"^  name: switch-gvisor-class-scope$", d, re.M)
    ]
    box_patterns = {
        p
        for p in re.findall(r"matches\('([^']+)'\)", doc)
        if p.startswith("^agents-") and "check" not in p
    }
    assert box_patterns == {f"^{USER_NAMESPACE_RE.pattern}$", f"^{BOX_KEYED_NAMESPACE_RE.pattern}$"}
