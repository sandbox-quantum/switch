"""The warm pool's admission policies and RBAC must match what the operator, scaler, egress lists and reaper make.

These are drift checks (the policies' own text, read from the files) plus Python copies of the parts a policy decides,
run against the objects the operator really builds. What only the cluster can show (CEL cost, and the refusals
themselves), a server-side dry run checks before applying (platform, outside the repo):
  1. the provisioner: create agents-box-k1-<16 hex> with label switch.dev/box: allowed; with switch.dev/user, or as
     agents-box-x: refused. A t2 StatefulSet as the operator makes it: allowed; with a second init container, another
     command, or the login-check volume without the starter: refused. pool-map and box-owners: an added entry of the
     right shape: allowed; a changed or removed entry, a wrong shape, or deleting the Secret: refused.
  2. anyone: changing a box namespace's switch.dev/machine-id or name label: refused.
  3. the reaper: deleting an agents-box-k1-… namespace with no box-owners entry: allowed; with one, an agents-user-…
     namespace, or anything that isn't a namespace delete: refused.
"""

import base64
import json
import random
import re
import sys
from pathlib import Path

import pytest

from switch_hosted_controller import box_operator
from switch_hosted_controller.box_names import BOX_LABEL, USER_LABEL

sys.path.insert(0, str(Path(__file__).parent))
from test_box_operator import action, cfg  # noqa: E402

K8S = Path(__file__).parents[2] / "k8s"
POLICIES = (K8S / "30-admission-policies.yaml").read_text()
HOSTED = (K8S / "40-switch-hosted.yaml").read_text()
REAPER = (K8S / "45-switch-hosted-reaper.yaml").read_text()
SQUID_NP = (Path(__file__).parents[2] / "egress" / "egress-proxy-networkpolicy.yaml").read_text()
HEX16 = "0123456789abcdef"
BOX_NS = "agents-box-k1-" + HEX16
USER_NS = "agents-user-k1-" + HEX16


def docs(text: str) -> list[str]:
    return [d for d in ("\n" + text).split("\n---\n") if "\nkind: " in "\n" + d]


def doc(text: str, kind: str, name: str) -> str:
    (found,) = [
        d
        for d in docs(text)
        if f"\nkind: {kind}\n" in "\n" + d + "\n" and f"\n  name: {name}\n" in d + "\n"
    ]
    return found


def policy(name: str) -> str:
    return doc(POLICIES, "ValidatingAdmissionPolicy", name)


def binding(name: str) -> str:
    return doc(POLICIES, "ValidatingAdmissionPolicyBinding", name)


def regexes(text: str) -> list[str]:
    return re.findall(r"\.matches\('([^']*)'\)", text)


def b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


def hexes(n: int, seed: int) -> list[str]:
    rnd = random.Random(seed)
    return ["".join(rnd.choice(HEX16) for _ in range(16)) for _ in range(n)]


BAD_TAILS = [HEX16.upper(), HEX16[:-1], HEX16 + "0", HEX16[:-1] + "g", HEX16[:-1] + "-", ""]


# ---------------------------------------------------------------- what the operator makes, the policies admit


@pytest.fixture(scope="module")
def made() -> dict[str, dict]:
    out = {}
    for ns_kw in ({}, {"box_keyed_id": "k1-" + HEX16, "namespace": BOX_NS}):
        objs = box_operator.box_objects(action(**ns_kw), cfg())
        ns = next(o for _, o in objs if o["kind"] == "Namespace")
        sts = next(o for _, o in objs if o["kind"] == "StatefulSet")
        out[ns["metadata"]["name"]] = {"ns": ns, "sts": sts}
    return out


def test_p1_takes_both_name_shapes_each_with_its_own_label(made):
    p1 = policy("switch-v0-p1-namespaces")
    (pattern,) = [r for r in regexes(p1) if r.startswith("^agents-")]
    assert pattern == "^agents-(user|box)-k1-[0-9a-f]{16}$"
    assert (
        f"(object.metadata.name.startsWith('agents-box-') ? '{BOX_LABEL}' : '{USER_LABEL}')" in p1
    )
    for name, objs in made.items():
        assert re.fullmatch(pattern, name)
        labels = objs["ns"]["metadata"]["labels"]
        want_key = BOX_LABEL if name.startswith("agents-box-") else USER_LABEL
        assert labels[want_key] == name.removeprefix("agents-")
        assert (BOX_LABEL in labels) != (USER_LABEL in labels)
    for bad in ("agents-box-x", "agents-box-k1-" + HEX16.upper(), "agents-pool-k1-" + HEX16):
        assert not re.fullmatch(pattern, bad)


def test_p4_starter_line_is_the_operators_exactly(made):
    p4 = policy("switch-v0-p4-box-pod")
    assert (
        f"""variables.s.?command.orValue([]) == ['sh', '-c', "{box_operator.STARTER_SCRIPT}"]"""
        in p4
    )
    for objs in made.values():
        (starter,) = objs["sts"]["spec"]["template"]["spec"]["initContainers"]
        assert starter["command"] == ["sh", "-c", box_operator.STARTER_SCRIPT]


def test_p4_starter_settings_match_the_operators(made):
    p4 = policy("switch-v0-p4-box-pod")
    starter = made[BOX_NS]["sts"]["spec"]["template"]["spec"]["initContainers"][0]
    sc, res = starter["securityContext"], starter["resources"]
    assert sc["runAsUser"] == 2001 and sc["runAsGroup"] == 2000
    assert "variables.s.?securityContext.?runAsUser.orValue(-1) == 2001" in p4
    assert "variables.s.?securityContext.?runAsGroup.orValue(-1) == 2000" in p4
    req = ", ".join(f"'{k}': '{v}'" for k, v in res["requests"].items())
    lim = ", ".join(f"'{k}': '{v}'" for k, v in res["limits"].items())
    assert f"variables.s.?resources.?requests.orValue({{}}) == {{{req}}}" in p4
    assert f"variables.s.?resources.?limits.orValue({{}}) == {{{lim}}}" in p4
    mounts = {(m["name"], m["mountPath"], m.get("readOnly")) for m in starter["volumeMounts"]}
    assert mounts == {
        ("enrol", "/etc/switch/enrol", True),
        ("login-check", "/etc/switch/login", True),
    }
    for name, path, _ in mounts:
        assert f"m.name == '{name}' && m.mountPath == '{path}'" in p4
    assert "variables.t.initContainers.size() == 1" in p4
    assert "!has(variables.t.initContainers) ||" in p4  # template t1 still passes


def test_p4_login_check_volume_matches_the_operators(made):
    p4 = policy("switch-v0-p4-box-pod")
    vols = {v["name"]: v for v in made[BOX_NS]["sts"]["spec"]["template"]["spec"]["volumes"]}
    lc = vols["login-check"]["secret"]
    assert lc["defaultMode"] == box_operator.SECRET_MODE == 288 and lc["optional"] is True
    assert lc["items"] == [
        {"key": box_operator.LOGIN_CHECK_KEY, "path": box_operator.LOGIN_CHECK_KEY}
    ]
    assert f"v.?secret.?defaultMode.orValue(-1) == {box_operator.SECRET_MODE}" in p4
    assert f"v.secret.items[0].?key.orValue('') == '{box_operator.LOGIN_CHECK_KEY}'" in p4
    assert "size() == (has(variables.t.initContainers) ? 8 : 7)" in p4
    assert "v.name == 'login-check' ? (has(variables.t.initContainers) &&" in p4
    assert len(vols) == 8


def test_p4_template_labels_follow_the_name_shape(made):
    p4 = policy("switch-v0-p4-box-pod")
    assert (
        f"(request.?namespace.orValue('').startsWith('agents-box-') ? '{BOX_LABEL}' : '{USER_LABEL}')"
        in p4
    )
    for name, objs in made.items():
        labels = objs["sts"]["spec"]["template"]["metadata"]["labels"]
        key = BOX_LABEL if name.startswith("agents-box-") else USER_LABEL
        assert labels == {"app": "switch-box", key: name.removeprefix("agents-")}


def test_p4_checks_the_starters_image_too():
    p4 = policy("switch-v0-p4-box-pod")
    assert "(variables.c + variables.t.?initContainers.orValue([])).all(x, x.?image" in p4


# ---------------------------------------------------------------- the three add-only lists


def value_regex(name: str) -> str:
    rule = [b for b in policy(name).split("- expression:") if "variables.new.all(k" in b][0]
    return rule


@pytest.mark.parametrize("name", ["switch-v0-p5-pool-map", "switch-v0-p5-box-owners"])
def test_new_lists_are_add_only_like_the_box_map(name):
    p = policy(name)
    list_name = name.removeprefix("switch-v0-p5-")
    assert f"request.?name.orValue('') == '{list_name}'" in p
    assert (
        "request.userInfo.username == 'system:serviceaccount:switch-hosted:switch-hosted-provisioner'"
        in p
    )
    assert "      - DELETE\n" in p  # matched, and refused by the UPDATE-only rule below
    assert f"request.operation == 'UPDATE' && object.metadata.name == '{list_name}'" in p
    assert (
        "variables.old.all(k, k in variables.new\n      && variables.new[k] == variables.old[k])"
        in p
    )
    assert "failurePolicy: Fail" in p
    assert "  - Deny" in binding(name)


def test_pool_map_entries_are_a_uuid_to_a_box_keyed_namespace():
    key_re, val_re = regexes(value_regex("switch-v0-p5-pool-map"))
    assert re.fullmatch(key_re, "11111111-2222-3333-4444-555555555555")
    assert not re.fullmatch(key_re, BOX_NS)
    for h in hexes(500, 1):
        assert re.fullmatch(val_re, b64("agents-box-k1-" + h))
        assert not re.fullmatch(val_re, b64("agents-user-k1-" + h))
    for t in BAD_TAILS:
        assert not re.fullmatch(val_re, b64("agents-box-k1-" + t))


def test_box_owners_entries_are_a_box_keyed_namespace_to_a_keyed_id():
    key_re, val_re = regexes(value_regex("switch-v0-p5-box-owners"))
    assert re.fullmatch(key_re, BOX_NS) and not re.fullmatch(key_re, USER_NS)
    for h in hexes(500, 2):
        assert re.fullmatch(val_re, b64("k1-" + h))
        assert not re.fullmatch(val_re, b64("user-k1-" + h))
    for t in BAD_TAILS:
        assert not re.fullmatch(val_re, b64("k1-" + t))


def test_the_box_map_takes_both_name_shapes():
    rule = value_regex("switch-v0-p5-box-map")
    key_re, user_re, box_re = regexes(rule)
    for h in hexes(500, 3):
        assert re.fullmatch(user_re, b64("agents-user-k1-" + h))
        assert re.fullmatch(box_re, b64("agents-box-k1-" + h))
    for t in BAD_TAILS:
        for prefix in ("agents-user-k1-", "agents-box-k1-"):
            enc = b64(prefix + t)
            assert not (re.fullmatch(user_re, enc) or re.fullmatch(box_re, enc))


def test_the_provisioner_may_write_exactly_the_four_lists():
    role = doc(HOSTED, "Role", "switch-hosted-provisioner-box-map")
    assert "  - box-map\n  - pool-map\n  - box-owners\n  - box-removals\n" in role
    assert role.rstrip().endswith("verbs:\n  - get\n  - update")
    p6 = policy("switch-v0-p6-provisioner-catch-all")
    assert "in ['box-map', 'box-templates', 'pool-map', 'box-owners', 'box-removals']" in p6
    assert "matches('^agents-(user|box)-k1-[0-9a-f]{16}$')" in p6


def test_egress_lists_may_only_read_box_owners_by_name():
    role = doc(HOSTED, "Role", "switch-egress-lists-box-map")
    assert (
        "  resourceNames:\n  - box-map\n  - box-owners\n  - box-removals\n  resources:\n  - secrets\n"
        "  verbs:\n  - get\n" in role
    )
    # and the held list, by name, read only
    assert role.rstrip().endswith(
        "- apiGroups:\n  - ''\n  resourceNames:\n  - egress-held\n  resources:\n  - configmaps\n  verbs:\n  - get"
    )
    assert role.count("- apiGroups:") == 2
    assert set(re.findall(r"^  - (\w+)$", role.split("verbs:")[-1], re.M)) == {"get"}


def test_only_the_scaler_may_write_the_held_list_by_name():
    """The scaler's account (`switch-hosted-controller`) reads and replaces `egress-held` by name, and nothing more:
    no create, delete or list. The ConfigMap itself is made empty by the manifests."""
    role = doc(HOSTED, "Role", "switch-hosted-controller-egress-held")
    assert role.rstrip().endswith(
        "rules:\n- apiGroups:\n  - ''\n  resourceNames:\n  - egress-held\n  resources:\n  - configmaps\n"
        "  verbs:\n  - get\n  - update"
    )
    binding = doc(HOSTED, "RoleBinding", "switch-hosted-controller-egress-held")
    assert "  name: switch-hosted-controller-egress-held\nsubjects:" in binding
    assert binding.rstrip().endswith(
        "- kind: ServiceAccount\n  name: switch-hosted-controller\n  namespace: switch-hosted"
    )
    cm = doc(HOSTED, "ConfigMap", "egress-held")
    assert "namespace: switch-hosted" in cm and not re.search(r"^data:", cm, re.M)
    # No other Role in the manifests names it.
    for text in (HOSTED, REAPER):
        named = [
            d for d in docs(text) if "egress-held" in d and "\nkind: Role\n" in "\n" + d + "\n"
        ]
        assert {re.search(r"\n  name: (\S+)", d).group(1) for d in named} <= {
            "switch-egress-lists-box-map",
            "switch-hosted-controller-egress-held",
        }


# ---------------------------------------------------------------- the reaper


REAPER_POLICY = "switch-reaper-deletes-unclaimed-pool-boxes"


def reaper_allows(op: str, resource: str, name: str, owners: dict[str, str]) -> bool:
    """The reaper policy's three checks, from its own patterns."""
    p = policy(REAPER_POLICY)
    (box_re,) = regexes(p)
    return (
        op == "DELETE"
        and resource == "namespaces"
        and re.fullmatch(box_re, name) is not None
        and name not in owners
    )


def test_the_reaper_policy_and_binding():
    p, b = policy(REAPER_POLICY), binding(REAPER_POLICY)
    assert "system:serviceaccount:switch-hosted:switch-hosted-reaper" in p
    assert "failurePolicy: Fail" in p and "paramKind:\n    apiVersion: v1\n    kind: Secret" in p
    assert "request.operation == 'DELETE'" in p and "request.resource.resource == 'namespaces'" in p
    assert "!(request.?name.orValue('') in params.?data.orValue({}))" in p
    assert "name: box-owners\n    namespace: switch-hosted\n    parameterNotFoundAction: Deny" in b
    assert "  - Deny" in b


def test_the_reaper_deletes_only_an_unowned_pool_box():
    owned = {"agents-box-k1-" + "f" * 16: b64("k1-" + HEX16)}
    assert reaper_allows("DELETE", "namespaces", BOX_NS, owned)
    assert not reaper_allows("DELETE", "namespaces", "agents-box-k1-" + "f" * 16, owned)
    assert not reaper_allows("DELETE", "namespaces", USER_NS, {})
    assert not reaper_allows("DELETE", "namespaces", "switch-hosted", {})
    assert not reaper_allows("DELETE", "secrets", BOX_NS, {})
    assert not reaper_allows("UPDATE", "namespaces", BOX_NS, {})


def test_the_reapers_rights_are_exactly_these():
    role = doc(REAPER, "Role", "switch-hosted-reaper-lists")
    assert "  - pool-map\n  - box-map\n  - box-owners\n" in role
    assert role.rstrip().endswith("verbs:\n  - get")
    cr = doc(REAPER, "ClusterRole", "switch-hosted-reaper")
    rules = cr.split("rules:\n", 1)[1]
    assert rules.strip() == (
        "- apiGroups:\n  - ''\n  resources:\n  - namespaces\n  verbs:\n  - get\n  - delete\n"
        "- apiGroups:\n  - ''\n  resources:\n  - persistentvolumes\n  verbs:\n  - list"
    )


def test_the_reaper_deployment_matches_its_program():
    from switch_hosted_controller import reaper_main

    dep = doc(REAPER, "Deployment", "switch-hosted-reaper")
    assert "serviceAccountName: switch-hosted-reaper" in dep
    assert "      automountServiceAccountToken: false" in dep
    assert "        - switch-hosted-reaper\n" in dep
    for key in ("CORE_URL", "TOKEN_FILE", "CORE_CA"):
        assert f"name: {reaper_main.PREFIX}{key}" in dep
    assert "runtimeClassName" not in dep and "tolerations" not in dep
    assert "secretName: switch-hosted-reaper-core" in dep
    np = doc(REAPER, "NetworkPolicy", "switch-hosted-reaper-egress")
    assert "app: switch-hosted-reaper" in np and "- Egress" in np


# ---------------------------------------------------------------- everyone else


def test_a_box_namespaces_identity_never_changes():
    p = policy("switch-box-namespace-identity")
    assert (
        "matchConditions:\n  - expression: object.metadata.name.matches('^agents-(user|box)-k1-[0-9a-f]{16}$')"
        in p
    )
    assert "request.userInfo" not in p  # every account
    assert "== oldObject.metadata.?annotations[?'switch.dev/machine-id']" in p
    assert f"[?'{USER_LABEL}']" in p and f"[?'{BOX_LABEL}']" in p
    assert "  - Deny" in binding("switch-box-namespace-identity")


def test_the_scalers_writes_and_the_watch_binding_cover_box_keyed_boxes():
    p7 = policy("switch-v0-p7-box-writes")
    assert "request.?namespace.orValue('').matches('^agents-box-k1-[0-9a-f]{16}$')" in p7
    assert "['code', 'registered']" in p7
    p8 = policy("switch-v0-p8-box-watch-binding")
    assert "matches('^agents-(user|box)-k1-[0-9a-f]{16}$')" in p8


def test_squid_lets_in_both_name_labels_and_nothing_else():
    ingress = SQUID_NP.split("ingress:", 1)[1].split("podSelector:", 1)[0]
    keys = re.findall(r'key: "([^"]+)"', ingress)
    assert keys == [USER_LABEL, BOX_LABEL]
    assert ingress.count('operator: "Exists"') == 2


def test_no_policy_still_assumes_only_person_keyed_names():
    for d in docs(POLICIES):
        if "kind: ValidatingAdmissionPolicy\n" not in d:
            continue
        for r in regexes(d):
            if r.startswith("^agents-user-"):
                assert "agents-box-k1-" in d, json.dumps(r)


def every_account_allows(op: str, old: dict, new: dict | None) -> bool:
    """switch-pool-lists-add-only's one rule, for any account."""
    if op == "UPDATE":
        return all(k in (new or {}) and new[k] == v for k, v in old.items())
    return len(old) == 0


def test_the_add_only_rule_holds_for_every_account():
    p = policy("switch-pool-lists-add-only")
    assert "request.userInfo" not in p  # no account condition: admins too
    assert "request.?name.orValue('') in ['pool-map', 'box-owners', 'box-removals']" in p
    assert "      - UPDATE\n      - DELETE\n" in p
    assert (
        "oldObject.?data.orValue({}).all(k, k in object.?data.orValue({}) && object.data[k] == oldObject.data[k])"
        in p
    )
    assert ":\n        oldObject.?data.orValue({}).size() == 0" in p
    assert "failurePolicy: Fail" in p and "  - Deny" in binding("switch-pool-lists-add-only")


@pytest.mark.parametrize(
    ("op", "old", "new", "allowed"),
    [
        ("UPDATE", {"a": "1"}, {"a": "1", "b": "2"}, True),  # an added entry
        ("UPDATE", {"a": "1"}, {"a": "1"}, True),  # a no-op write
        ("UPDATE", {"a": "1"}, {"a": "9"}, False),  # an admin's edit
        ("UPDATE", {"a": "1"}, {}, False),  # an admin's removal
        ("DELETE", {"a": "1"}, None, False),  # deleting a list with entries
        ("DELETE", {}, None, True),  # deleting an empty list (teardown)
    ],
)
def test_add_only_cases(op, old, new, allowed):
    assert every_account_allows(op, old, new) is allowed


def test_the_workers_read_the_removals_list_by_name_only():
    role = doc(HOSTED, "Role", "switch-hosted-controller-box-map")
    assert (
        "  resourceNames:\n  - box-map\n  - box-removals\n  resources:\n  - secrets\n  verbs:\n  - get"
        in role
    )


def test_the_provisioner_may_list_volumes_to_see_a_removed_boxs_disks_are_gone():
    rbac = (K8S / "20-cluster-rbac.yaml").read_text()
    role = doc(rbac, "ClusterRole", "switch-hosted-provisioner")
    assert role.rstrip().endswith(
        "- apiGroups:\n  - ''\n  resources:\n  - persistentvolumes\n  verbs:\n  - list"
    )
