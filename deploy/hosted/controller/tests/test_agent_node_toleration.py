"""Agent nodes carry the taint `switch.dev/pool=agents:NoSchedule`, and only sandboxed pods may tolerate it.

The toleration lives on the `gvisor` and `gvisor-tuned` RuntimeClasses, never in a pod template: the API server's
RuntimeClass admission adds it to each pod that names a class, before any validating policy runs. So:
  - both classes add exactly that one toleration, beside their `switch.dev/pool: agents` node selector;
  - `switch-gvisor-class-scope` limits who may name a gVisor class, for every account, to box namespaces, the node
    gate's check namespaces, `switch-placeholders` and `switch-drain-room`;
  - the pod-level rules that see gVisor pods after that merge (the drain placeholders' and the node gate's check
    pods') allow exactly that toleration, and nothing wider;
  - P4 still refuses any toleration in the box template, so a box gets it only from its class.

What only the cluster can show (CEL cost, and the refusals themselves). Before applying, a server-side dry run (run by
platform outside the repo):
  1. a pod naming `gvisor` in a box namespace, `switch-placeholders` or `switch-drain-room`: allowed, and the created
     pod carries the agents toleration;
  2. a pod naming `gvisor` or `gvisor-tuned` in `default`, `switch-hosted` or `agents-user-x`: refused;
  3. a pod with no RuntimeClass anywhere: not touched by the scope rule.
"""

import re
from pathlib import Path

import pytest

K8S = Path(__file__).parents[2] / "k8s"
GATE = Path(__file__).parents[2] / "gate" / "node-gate.PROPOSED.yaml"
CLASSES = (K8S / "11-classes.yaml").read_text()
POLICIES = (K8S / "30-admission-policies.yaml").read_text()
AGENTS_TOLERATION = (
    "- effect: NoSchedule\n    key: switch.dev/pool\n    operator: Equal\n    value: agents\n"
)


def docs(text: str) -> list[str]:
    return [d for d in ("\n" + text).split("\n---\n") if "\nkind: " in "\n" + d]


def doc(text: str, kind: str, name: str) -> str:
    (found,) = [
        d
        for d in docs(text)
        if f"\nkind: {kind}\n" in "\n" + d + "\n" and f"\n  name: {name}\n" in d + "\n"
    ]
    return found


def expressions(policy: str) -> str:
    """Only the CEL: the validations block less message lines, so wording in a message never counts as a check."""
    block = policy.split("\n  validations:\n", 1)[1]
    return "\n".join(
        line for line in block.splitlines() if not line.lstrip().startswith(("#", "message:"))
    )


@pytest.mark.parametrize("name", ["gvisor", "gvisor-tuned"])
def test_each_gvisor_class_adds_exactly_the_agents_toleration(name):
    rc = doc(CLASSES, "RuntimeClass", name)
    scheduling = rc.split("\nscheduling:\n", 1)[1]
    assert "  nodeSelector:\n    switch.dev/pool: agents\n" in scheduling
    tolerations = scheduling.split("  tolerations:\n", 1)[1]
    assert tolerations.strip("\n") == "  " + AGENTS_TOLERATION.strip("\n")


def test_no_other_class_or_object_in_the_file_tolerates_anything():
    assert CLASSES.count("tolerations:") == 2


SCOPE = doc(POLICIES, "ValidatingAdmissionPolicy", "switch-gvisor-class-scope")
SCOPE_CEL = expressions(SCOPE)


def test_the_scope_rule_covers_every_account_and_fails_closed():
    assert "failurePolicy: Fail" in SCOPE
    assert "matchConditions" not in SCOPE  # every account, admins and controllers alike
    assert "      - CREATE\n      - UPDATE\n      resources:\n      - pods\n" in SCOPE
    binding = doc(POLICIES, "ValidatingAdmissionPolicyBinding", "switch-gvisor-class-scope")
    assert "policyName: switch-gvisor-class-scope" in binding and "  - Deny" in binding
    assert "Audit" not in binding and "Warn" not in binding


def scope_allows(
    namespace: str, runtime_class: str | None, service_account: str = "default"
) -> bool:
    """The scope rule's class check, evaluated in Python from the patterns, names and exceptions read out of the
    policy itself."""
    rule = SCOPE_CEL.split("- expression:")[1]
    classes = re.search(r"orValue\(''\) in \[([^\]]*)\]", rule).group(1)
    named = re.search(r"request\.namespace in \[([^\]]*)\]", rule).group(1)
    patterns = re.findall(r"request\.namespace\.matches\('([^']*)'\)", rule)
    pairs = re.findall(
        r"\(request\.namespace == '([^']+)' && object\.spec\.\?serviceAccountName\.orValue\('default'\) == '([^']+)'\)",
        rule,
    )
    if runtime_class not in [c.strip(" '") for c in classes.split(",")]:
        return True
    return (
        namespace in [n.strip(" '") for n in named.split(",")]
        or any(re.search(p, namespace) for p in patterns)
        or (namespace, service_account) in pairs
    )


@pytest.mark.parametrize(
    "namespace",
    [
        "agents-user-k1-0123456789abcdef",
        "agents-box-k1-0123456789abcdef",
        "agents-check-ip-10-0-1-2-g1",
        "agents-check-n1-px",
        "switch-placeholders",
        "switch-drain-room",
    ],
)
@pytest.mark.parametrize("runtime_class", ["gvisor", "gvisor-tuned"])
def test_the_scope_rule_allows_box_gate_and_placeholder_namespaces(namespace, runtime_class):
    assert scope_allows(namespace, runtime_class)


@pytest.mark.parametrize(
    "namespace",
    [
        "default",
        "kube-system",
        "switch-hosted",
        "egress-proxy",
        "agents-user-x",
        "agents-user-k1-0123456789ABCDEF",
        "agents-user-k1-0123456789abcdef0",
        "xagents-user-k1-0123456789abcdef",
        "agents-check-n1-zz",
        "agents-box-k1-0123456789abcde",
        "agents-box-k1-0123456789ABCDEF",
        "agents-box-x",
        "agents-box-k2-0123456789abcdef",
        "switch-placeholders-2",
    ],
)
@pytest.mark.parametrize("runtime_class", ["gvisor", "gvisor-tuned"])
def test_the_scope_rule_refuses_every_other_namespace(namespace, runtime_class):
    assert not scope_allows(namespace, runtime_class)


@pytest.mark.parametrize("runtime_class", [None, "runc", "gvisorx"])
def test_the_scope_rule_leaves_pods_without_a_gvisor_class_alone(runtime_class):
    assert scope_allows("default", runtime_class)


def test_the_scope_rule_box_pattern_is_p1s():
    """P1 accepts exactly the two shapes the scope rule lets use gVisor, and no third."""
    p1 = doc(POLICIES, "ValidatingAdmissionPolicy", "switch-v0-p1-namespaces")
    assert "matches('^agents-(user|box)-k1-[0-9a-f]{16}$')" in p1
    assert "matches('^agents-user-k1-[0-9a-f]{16}$')" in SCOPE_CEL
    assert "matches('^agents-box-k1-[0-9a-f]{16}$')" in SCOPE_CEL


def test_the_scope_rule_allows_the_warm_pools_box_namespaces_exactly():
    # Inert until P1 accepts agents-box-k1-<16 hex> (the warm pool stack), and then matching its BOX_NAMESPACE_RE.
    assert "matches('^agents-box-k1-[0-9a-f]{16}$')" in SCOPE_CEL
    assert len(re.findall(r"request\.namespace\.matches\(", SCOPE_CEL)) == 3


def test_the_scope_rule_gate_pattern_is_the_gates():
    from switch_hosted_controller.node_gate import CHECK_NAMESPACE_RE

    assert f"matches('^{CHECK_NAMESPACE_RE.pattern}$')" in SCOPE_CEL


def test_drain_placeholders_must_run_under_gvisor_and_may_carry_only_the_merged_toleration():
    cel = expressions(
        doc(POLICIES, "ValidatingAdmissionPolicy", "switch-operator-placeholder-shape")
    )
    assert "'runtimeClassName'])" in cel
    assert "object.spec.?runtimeClassName.orValue('') == 'gvisor'" in cel
    assert (
        "(t.?key.orValue('') == 'switch.dev/pool' && t.?operator.orValue('') == 'Equal' &&\n"
        "         t.?value.orValue('') == 'agents' && t.?effect.orValue('') == 'NoSchedule')"
    ) in cel
    assert (
        "Exists' && t.?effect.orValue('') == 'NoSchedule'" not in cel
    )  # no wildcard on the pool key
    assert "switch.dev/gate1" not in cel


def test_gate_check_pods_may_carry_the_merged_toleration_exactly():
    gate = GATE.read_text()
    pods = doc(gate, "ValidatingAdmissionPolicy", "switch-node-gate-check-pods")
    assert (
        "(t.key == 'switch.dev/pool' && t.operator == 'Equal' && has(t.value) && t.value == 'agents' &&\n"
        "           has(t.effect) && t.effect == 'NoSchedule')"
    ) in pods


def test_p4_still_refuses_tolerations_in_the_box_template():
    p4 = expressions(doc(POLICIES, "ValidatingAdmissionPolicy", "switch-v0-p4-box-pod"))
    assert "!has(variables.t.tolerations)" in p4
    assert "variables.t.?runtimeClassName.orValue('') == 'gvisor'" in p4


# ---------------------------------------------------------------- hand-written agents tolerations

HAND_RULE = """      request.namespace == 'kube-system' ||
      (request.namespace == 'amazon-guardduty' && object.spec.?serviceAccountName.orValue('default') == 'aws-guardduty-agent') ||
      object.spec.?runtimeClassName.orValue('') in ['gvisor', 'gvisor-tuned'] ||
      (request.operation == 'UPDATE' &&
       object.spec.?tolerations.orValue([]) == oldObject.spec.?tolerations.orValue([])) ||
      !object.spec.?tolerations.orValue([]).exists(t,
        ((t.?key.orValue('') == '' && t.?operator.orValue('') == 'Exists') ||
         (t.?key.orValue('') == 'switch.dev/pool' &&
          (t.?operator.orValue('Equal') == 'Exists' || t.?value.orValue('') == 'agents'))) &&
        t.?effect.orValue('') in ['', 'NoSchedule'])"""


def test_the_hand_written_toleration_rule_is_pinned():
    """The Python below mirrors this CEL; pinning the text keeps the two from drifting apart."""
    assert HAND_RULE in SCOPE_CEL


def covers_agents_taint(t: dict) -> bool:
    key, op = t.get("key", ""), t.get("operator", "Equal")
    keyless_exists = key == "" and t.get("operator", "") == "Exists"
    pool = key == "switch.dev/pool" and (op == "Exists" or t.get("value", "") == "agents")
    return (keyless_exists or pool) and t.get("effect", "") in ("", "NoSchedule")


def hand_rule_allows(
    namespace, tolerations, runtime_class=None, old_tolerations=None, service_account="default"
):
    if namespace == "kube-system" or runtime_class in ("gvisor", "gvisor-tuned"):
        return True
    if (namespace, service_account) == ("amazon-guardduty", "aws-guardduty-agent"):
        return True
    if old_tolerations is not None and tolerations == old_tolerations:
        return True
    return not any(covers_agents_taint(t) for t in tolerations)


AGENTS = {"key": "switch.dev/pool", "operator": "Equal", "value": "agents", "effect": "NoSchedule"}
DEFAULTS = [
    {"key": k, "operator": "Exists", "effect": "NoExecute", "tolerationSeconds": 300}
    for k in ("node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable")
]


@pytest.mark.parametrize(
    "toleration",
    [
        AGENTS,
        {
            "key": "switch.dev/pool",
            "value": "agents",
            "effect": "NoSchedule",
        },  # operator defaults to Equal
        {"key": "switch.dev/pool", "value": "agents"},  # no effect: every effect
        {"key": "switch.dev/pool", "operator": "Exists"},
        {"operator": "Exists"},  # key-less: every taint
        {"operator": "Exists", "effect": "NoSchedule"},
    ],
)
def test_a_hand_written_agents_toleration_outside_kube_system_is_refused(toleration):
    assert not hand_rule_allows("default", [*DEFAULTS, toleration])
    assert not hand_rule_allows("switch-hosted", [toleration])


@pytest.mark.parametrize(
    "tolerations",
    [
        [],
        DEFAULTS,
        [
            {
                "key": "switch.dev/pool",
                "operator": "Equal",
                "value": "system",
                "effect": "NoSchedule",
            }
        ],
        [
            {
                "key": "switch.dev/system",
                "operator": "Equal",
                "value": "true",
                "effect": "NoSchedule",
            }
        ],
        [{"operator": "Exists", "effect": "NoExecute"}],  # covers NoExecute taints only
    ],
)
def test_tolerations_that_dont_cover_the_agents_taint_are_left_alone(tolerations):
    assert hand_rule_allows("default", tolerations)


def test_kube_system_is_untouched():
    assert hand_rule_allows("kube-system", [{"operator": "Exists"}])


def test_a_gvisor_pod_may_carry_the_toleration_the_class_merges():
    assert hand_rule_allows("switch-placeholders", [*DEFAULTS, AGENTS], runtime_class="gvisor")
    assert not hand_rule_allows("switch-placeholders", [*DEFAULTS, AGENTS], runtime_class="runc")


def test_on_update_only_a_change_of_tolerations_is_checked():
    assert hand_rule_allows(
        "default", [AGENTS], old_tolerations=[AGENTS]
    )  # unchanged: metadata updates pass
    assert not hand_rule_allows("default", [*DEFAULTS, AGENTS], old_tolerations=DEFAULTS)


def test_the_class_rule_checks_create_only_and_the_datadog_follow_on_is_noted():
    assert "request.operation != 'CREATE' ||" in SCOPE_CEL
    assert "the Datadog agent's DaemonSet will live in its own namespace" in SCOPE


def test_squid_may_use_gvisor_with_its_own_service_account_only():
    assert scope_allows("egress-proxy", "gvisor", "squid")
    assert not scope_allows("egress-proxy", "gvisor", "default")
    assert not scope_allows("egress-proxy", "gvisor", "someone-else")
    assert not scope_allows("egress-lists", "gvisor", "default")


def test_every_gvisor_pod_template_in_these_files_is_admitted_by_the_scope_rule():
    """Every Deployment, DaemonSet, StatefulSet or Job here that runs under gVisor must pass the scope rule, so the
    policy can never refuse our own services' next pod."""
    found = 0
    for path in sorted(K8S.glob("*.yaml")):
        for d in docs(path.read_text()):
            kind = re.search(r"(?m)^kind: (\S+)", d)
            if not kind or kind.group(1) not in ("Deployment", "DaemonSet", "StatefulSet", "Job"):
                continue
            rc = re.search(r"(?m)^      runtimeClassName: (\S+)", d)
            if not rc:
                continue
            ns = re.search(r"(?m)^  namespace: (\S+)", d).group(1)
            sa = re.search(r"(?m)^      serviceAccountName: (\S+)", d)
            found += 1
            assert scope_allows(ns, rc.group(1), sa.group(1) if sa else "default"), (
                f"{path.name}: {ns}"
            )
    assert found >= 1


def test_the_threat_detection_agent_may_tolerate_everything_with_its_own_account_only():
    everything = [{"operator": "Exists"}]
    assert hand_rule_allows("amazon-guardduty", everything, service_account="aws-guardduty-agent")
    assert not hand_rule_allows("amazon-guardduty", everything, service_account="default")
    assert not hand_rule_allows("default", everything, service_account="aws-guardduty-agent")


def test_squid_has_its_own_service_account_with_no_token():
    text = (K8S / "50-egress-proxy.yaml").read_text()
    sa = doc(text, "ServiceAccount", "squid")
    assert "automountServiceAccountToken: false" in sa and "  namespace: egress-proxy" in sa
    dep = doc(text, "Deployment", "squid")
    assert (
        "      serviceAccountName: squid\n" in dep and "automountServiceAccountToken: false" in dep
    )
    assert not re.search(
        r"(?m)^kind: (Role|RoleBinding|ClusterRoleBinding)$", text.split("kind: ServiceAccount")[0]
    )
