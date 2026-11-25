"""The cluster's own services never ask for an agent node, and so never wait for one.

Agent nodes carry the taint `switch.dev/pool=agents:NoSchedule`, and only pods under a gVisor class tolerate it (the
class adds the toleration; see `test_agent_node_toleration`). A service that selected agent nodes without that class
could never be placed on a tainted agents group: it would sit Pending. And the cluster's rules refuse both ways out
for a service in its own namespace (a written toleration, or a gVisor class outside the box namespaces). So:

- no workload in `k8s/` selects agent nodes unless it runs under a gVisor class;
- the cluster's services (drain worker, controller, operator, provisioner, egress lists, remover) carry no node selector and a
  *preferred* affinity for `switch.dev/pool=system`: on a cluster whose agent nodes are tainted they land on the
  system nodes, and on a cluster with no system nodes yet they still start (never a required pin);
- and a *required* anti-affinity to any box's pod (`app=switch-box`, in any namespace) per node: the services that
  hold the operator's, the provisioner's and Core's credentials never share a node with a box, whatever the taints
  say (a cluster with no system nodes, or an agents group without its taint).

The manifests are read as text (the package has no YAML library), one document at a time.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

K8S = Path(__file__).resolve().parents[2] / "k8s"
WORKLOADS = ("Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob")
GVISOR = {"gvisor", "gvisor-tuned"}
SERVICES = {
    ("switch-hosted", "switch-drain"),
    ("switch-hosted", "switch-hosted-controller"),
    ("switch-hosted", "switch-hosted-operator"),
    ("switch-hosted", "switch-hosted-provisioner"),
    ("egress-lists", "switch-egress-lists"),
    ("switch-hosted", "switch-hosted-remover"),
}
PREFER_SYSTEM = """      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - preference:
              matchExpressions:
              - key: switch.dev/pool
                operator: In
                values:
                - system
            weight: 100
"""
NEVER_BESIDE_A_BOX = """        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: switch-box
            namespaceSelector: {}
            topologyKey: kubernetes.io/hostname
"""


def _workloads() -> dict[tuple[str, str], str]:
    out = {}
    for path in sorted(K8S.glob("*.yaml")):
        for doc in path.read_text().split("\n---\n"):
            kind = re.search(r"^kind: (\S+)$", doc, re.M)
            if not kind or kind.group(1) not in WORKLOADS:
                continue
            name = re.search(r"^  name: (\S+)$", doc, re.M)
            namespace = re.search(r"^  namespace: (\S+)$", doc, re.M)
            assert name and namespace, path.name
            out[(namespace.group(1), name.group(1))] = doc
    return out


def _asks_for_agent_nodes(doc: str) -> bool:
    """A node selector, or a required node affinity, naming the agents pool."""
    if re.search(r"^\s+nodeSelector:\n(?:\s+\S+: \S+\n)*?\s+switch\.dev/pool: agents$", doc, re.M):
        return True
    required = doc.split("requiredDuringSchedulingIgnoredDuringExecution:", 1)
    return (
        len(required) == 2
        and re.search(r"key: switch\.dev/pool\n(?:.*\n){0,3}?.*- agents\n", required[1]) is not None
    )


def test_every_service_is_found():
    assert SERVICES <= set(_workloads())


@pytest.mark.parametrize("key", sorted(_workloads()))
def test_no_workload_asks_for_agent_nodes_without_gvisor(key):
    doc = _workloads()[key]
    if _asks_for_agent_nodes(doc):
        assert set(re.findall(r"runtimeClassName: (\S+)", doc)) <= GVISOR, key
        assert re.search(r"runtimeClassName: (\S+)", doc), key


@pytest.mark.parametrize("key", sorted(SERVICES))
def test_each_service_prefers_system_nodes_and_never_requires_them(key):
    doc = _workloads()[key]
    assert "nodeSelector:" not in doc, key
    assert doc.count(PREFER_SYSTEM) == 1, key
    node_affinity = doc.split("        nodeAffinity:\n", 1)[1].split(
        "        podAntiAffinity:\n", 1
    )[0]
    assert "requiredDuringScheduling" not in node_affinity, key  # never a required node pin
    assert "podAffinity:" not in doc, key


@pytest.mark.parametrize("key", sorted(SERVICES))
def test_each_service_never_shares_a_node_with_a_box(key):
    doc = _workloads()[key]
    assert doc.count(NEVER_BESIDE_A_BOX) == 1, key
    assert doc.count("podAntiAffinity:") == 1 and doc.count("requiredDuringScheduling") == 1, key
    assert "tolerations:" not in doc and "runtimeClassName" not in doc, (
        key
    )  # no way onto an agent node


def test_the_check_catches_a_service_that_selects_agent_nodes():
    doc = _workloads()[("switch-hosted", "switch-drain")]
    bad = doc.replace(
        "      affinity:\n",
        "      nodeSelector:\n        switch.dev/pool: agents\n      affinity:\n",
        1,
    )
    assert _asks_for_agent_nodes(bad)
    required = doc.replace("preferredDuringScheduling", "requiredDuringScheduling", 1).replace(
        "- system", "- agents", 1
    )
    assert _asks_for_agent_nodes(required)
