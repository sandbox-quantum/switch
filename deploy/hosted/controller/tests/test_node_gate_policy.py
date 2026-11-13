"""The node gate's RBAC and admission policy must match the code that relies on them.

These are drift checks: the names, patterns and taint keys in deploy/hosted/gate/node-gate.PROPOSED.yaml must be
the ones the gate's code uses, every policy must deny and fail closed, and the gate's own role must stay narrow.

What only the cluster can show (CEL cost limits, and the refusals themselves). Before applying, a server-side dry run
(run by platform outside the repo) of each, as the gate's service account where it applies:
  1. patch a gate-tainted node to remove the gate taint: allowed;
  2. patch it to remove the level taint, add a taint, change a label, or touch nodes/status: refused;
  3. patch a node without the gate taint: refused;
  4. create agents-check-x-abcdef-g1 with the label, restricted and the check-node annotation: allowed;
     create kube-system2, agents-user-x, or a check name without the label: refused; update a check namespace: refused;
  5. delete a check namespace not labelled as the gate's: refused;
  6. a RoleBinding in a check namespace to switch-node-gate-check for the gate: allowed; to another role, another
     subject, or in agents-user-x: refused;
  7. in a check namespace, by any user: a pod of another image, without gVisor, without nodeName or pinned to another
     machine, tolerating another taint or with operator Exists, with hostNetwork, a volume, a token, privilege, or an
     init or ephemeral container: refused; the gate's own Jobs' pods: allowed.
"""

import json
import re
from pathlib import Path

import pytest

from switch_hosted_controller.node_gate import CHECK_NAMESPACE_RE
from switch_hosted_controller.node_gate_jobs import (
    CHECK_CLUSTER_ROLE,
    GATE1_TAINT,
    LEVEL_TAINT,
    MANAGED_BY,
    NODE_ANNOTATION,
)

GATE_DIR = Path(__file__).parents[2] / "gate"
MANIFEST = (GATE_DIR / "node-gate.PROPOSED.yaml").read_text()
DOCS = [d for d in MANIFEST.split("\n---\n") if "\nkind: " in "\n" + d]
GATE_USER = "system:serviceaccount:switch-node-gate:switch-node-gate"


def doc(kind: str, name: str) -> str:
    (found,) = [
        d
        for d in DOCS
        if f"\nkind: {kind}\n" in "\n" + d + "\n" and f"\n  name: {name}\n" in d + "\n"
    ]
    return found


def rules(role: str) -> list[dict]:
    """A ClusterRole's rules, read from its flow-style lists."""
    out = []
    for block in doc("ClusterRole", role).split("\n  - ")[1:]:
        rule = {}
        for key in ("apiGroups", "resources", "verbs", "resourceNames"):
            m = re.search(rf"{key}: \[([^\]]*)\]", block)
            if m:
                rule[key] = [v.strip().strip('"') for v in m.group(1).split(",")]
        out.append(rule)
    return out


POLICIES = [
    "switch-node-gate-only-untaint",
    "switch-node-gate-only-check-namespaces",
    "switch-node-gate-only-check-objects",
    "switch-node-gate-check-pods",
]


def test_the_policy_uses_the_codes_namespace_pattern_and_names():
    anchored = f"^{CHECK_NAMESPACE_RE.pattern}$"
    patterns = set(re.findall(r"matches\('([^']*)'\)", MANIFEST))
    assert patterns == {anchored}
    assert MANIFEST.count(anchored) == 3  # namespaces, objects, and the pods' match condition
    assert f"'{GATE1_TAINT}'" in MANIFEST and f"'{LEVEL_TAINT}'" in MANIFEST
    assert f"'{NODE_ANNOTATION}'" in MANIFEST
    assert f"== '{MANAGED_BY}'" in MANIFEST
    assert f"object.roleRef.name == '{CHECK_CLUSTER_ROLE}'" in MANIFEST


@pytest.mark.parametrize("name", POLICIES)
def test_every_policy_fails_closed_and_is_bound_to_deny(name):
    policy = doc("ValidatingAdmissionPolicy", name)
    assert "failurePolicy: Fail" in policy
    binding = doc("ValidatingAdmissionPolicyBinding", name)
    assert f"policyName: {name}" in binding and 'validationActions: ["Deny"]' in binding
    if name == "switch-node-gate-check-pods":
        assert (
            "is-the-gate" not in policy
        )  # pods in check namespaces are checked whoever creates them
    else:
        assert f"request.userInfo.username == '{GATE_USER}'" in policy


def test_the_gates_cluster_role_stays_narrow():
    granted = rules("switch-node-gate")
    verbs = {v for r in granted for v in r["verbs"]}
    assert "escalate" not in verbs and "impersonate" not in verbs and "*" not in verbs
    resources = {res for r in granted for res in r["resources"]}
    assert resources == {"nodes", "namespaces", "pods", "rolebindings", "clusterroles"}
    (bind,) = [r for r in granted if "bind" in r["verbs"]]
    assert bind == {
        "apiGroups": ["rbac.authorization.k8s.io"],
        "resources": ["clusterroles"],
        "verbs": ["bind"],
        "resourceNames": [CHECK_CLUSTER_ROLE],
    }
    (pods,) = [r for r in granted if r["resources"] == ["pods"]]
    assert pods["verbs"] == ["list"]


def test_the_check_role_covers_what_the_client_does_in_a_check_namespace_and_no_more():
    granted = {
        (res, v) for r in rules(CHECK_CLUSTER_ROLE) for res in r["resources"] for v in r["verbs"]
    }
    needed = {
        ("jobs", "create"),
        ("jobs", "get"),
        ("pods", "list"),
        ("pods/log", "get"),
        ("resourcequotas", "create"),
        ("networkpolicies", "create"),
    }
    assert needed <= granted
    assert {res for res, _ in granted} == {
        "jobs",
        "pods",
        "pods/log",
        "resourcequotas",
        "networkpolicies",
    }
    assert f"name: {CHECK_CLUSTER_ROLE}" not in doc("ClusterRoleBinding", "switch-node-gate")


def test_the_gates_aws_identity_reads_only():
    iam = json.loads((GATE_DIR / "node-gate-iam.PROPOSED.json").read_text())
    actions = {a for s in iam["Statement"] for a in s["Action"]}
    assert actions == {"ec2:DescribeInstances", "ec2:DescribeSubnets"}
    assert all(s["Effect"] == "Allow" for s in iam["Statement"])


def test_check_pods_allow_only_the_two_pinned_images_and_gvisor():
    pods = doc("ValidatingAdmissionPolicy", "switch-node-gate-check-pods")
    assert "c.image in ['__PYTHON_IMAGE__', '__ALPINE_IMAGE__']" in pods
    assert "object.spec.runtimeClassName == 'gvisor'" in pods
    assert "t.operator == 'Equal'" in pods
    # the API server's own defaults, exactly: those two keys, Exists, NoExecute
    assert (
        "t.key in ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable'] && t.operator == 'Exists'"
        in pods
    )
    assert "t.effect == 'NoExecute'" in pods
    assert "has(t.tolerationSeconds) && t.tolerationSeconds <= 300" in pods
    assert "!object.spec.automountServiceAccountToken" in pods


def test_check_pods_allow_metadata_updates_but_not_spec_changes_or_ephemeral_containers():
    pods = doc("ValidatingAdmissionPolicy", "switch-node-gate-check-pods")
    assert "request.operation == 'CREATE' || object.spec == oldObject.spec" in pods
    assert "request.subResource == ''" in pods and "pods/ephemeralcontainers" in pods


def test_the_gate_can_reach_the_pod_identity_agent_and_the_responder_is_read_only():
    policy = doc("NetworkPolicy", "switch-node-gate")
    assert "cidr: 169.254.170.23/32" in policy and "port: 80}" in policy
    responder = doc("Deployment", "gate-responder")
    assert "readOnlyRootFilesystem: true" in responder and '--directory", "/srv/empty"' in responder
