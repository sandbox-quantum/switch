"""The box operator, without a cluster or Core: what it makes, in what order, and that it's create-only, safe to
repeat and never changes what isn't its own."""

from __future__ import annotations

import copy
import json
import logging

import pytest

from switch_hosted_controller.box_operator import (
    EXISTS_UNREAD,
    FAILURES,
    MACHINE_NAME,
    NAMESPACE_RE,
    BoxMapConflict,
    BoxOperator,
    ConfigError,
    ProvisionAction,
    ProvisionFailed,
    Refused,
    box_objects,
    config_from,
    contains,
    matches,
    namespace_for,
    with_box,
    zone_for,
)
from switch_hosted_controller.egress_lists import check_box_pod_spec

USER = "k1-0123456789abcdef"
NS = f"agents-user-{USER}"
MACHINE = "11111111-2222-3333-4444-555555555555"
TOKEN = "claim-token-0123456789abcdef"
CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
SETTINGS = '{"permissions": {}}'
RAW_CONFIG = {
    "server_ip": "10.0.0.10",
    "server_url": "https://10.0.0.10",
    "image": "registry.example/hosted-agents-box@sha256:" + "a" * 64,
    "storage_class": "gp3",
    "proxy_host": "squid.egress-proxy.svc",
    "proxy_port": 3128,
    "zones": ["eu-west-3a", "eu-west-3b", "eu-west-3c"],
    "sizes": {
        "standard": {
            "disk": "15Gi",
            "cpu_request": "250m",
            "cpu_limit": "4",
            "memory_request": "1Gi",
            "memory_limit": "6Gi",
        }
    },
    "ceiling": 50,
    "default_size": "standard",
}


def cfg(**over):  # type: ignore[no-untyped-def]
    return config_from({**RAW_CONFIG, **over}, CA, SETTINGS)


def action(**over):  # type: ignore[no-untyped-def]
    raw = {
        "action_id": "a1",
        "machine_id": MACHINE,
        "user_keyed_id": USER,
        "size": "standard",
        "claim_token": TOKEN,
        **over,
    }
    return ProvisionAction.parse(raw)


class FakeCore:
    def __init__(self, actions=None):  # type: ignore[no-untyped-def]
        self.actions = list(actions or [])
        self.calls: list[tuple] = []

    def claim(self):  # type: ignore[no-untyped-def]
        return self.actions.pop(0) if self.actions else None

    def result(self, action_id, claim_token, result, namespace, failed_at):  # type: ignore[no-untyped-def]
        assert claim_token == TOKEN
        self.calls.append(("result", action_id, result, namespace, failed_at))


class FakeKube:
    def __init__(self):  # type: ignore[no-untyped-def]
        self.objects: dict[tuple[str, str, str], dict] = {}
        self.created: list[tuple[str, str]] = []
        self.boxes: dict[str, str] = {}
        self.version = 1
        self.conflicts = 0
        self.refuse: set[str] = set()
        self.secret_reads_avoided = 0

    def create_or_get(self, obj):  # type: ignore[no-untyped-def]
        meta = obj["metadata"]
        key = (obj["kind"], meta.get("namespace", ""), meta["name"])
        if obj["kind"] in self.refuse:
            raise Refused()
        if key in self.objects:
            if obj["kind"] == "Secret":
                self.secret_reads_avoided += 1
                return EXISTS_UNREAD  # as the real client: no `get` on Secrets
            return copy.deepcopy(self.objects[key])
        stored = copy.deepcopy(obj)
        stored["metadata"]["uid"] = "u"  # the cluster adds its own fields
        self.objects[key] = stored
        self.created.append((obj["kind"], meta["name"]))
        return None

    def box_map(self):  # type: ignore[no-untyped-def]
        return dict(self.boxes), str(self.version)

    def write_box_map(self, boxes, resource_version):  # type: ignore[no-untyped-def]
        if self.conflicts:
            self.conflicts -= 1
            self.version += 1
            raise BoxMapConflict()
        assert resource_version == str(self.version)
        self.boxes = dict(boxes)
        self.version += 1


def result(core: FakeCore) -> tuple:
    (last,) = [c for c in core.calls if c[0] == "result"]
    return last


# ── What it makes ───────────────────────────────────────────────────────────


def test_a_box_is_made_in_order_and_reported_once_done():
    core, kube = (
        FakeCore(
            [
                {
                    "action_id": "a1",
                    "machine_id": MACHINE,
                    "user_keyed_id": USER,
                    "size": "standard",
                    "claim_token": TOKEN,
                }
            ]
        ),
        FakeKube(),
    )
    assert BoxOperator(core, kube, cfg()).run_once() is True
    assert core.calls == [("result", "a1", "done", NS, None)]
    assert result(core) == ("result", "a1", "done", NS, None)
    kinds = [kind for kind, _ in kube.created]
    # The namespace first, its network policies before anything that could run, the box last.
    assert kinds[0] == "Namespace"
    assert kinds[1:3] == ["NetworkPolicy", "NetworkPolicy"]
    assert kinds[-1] == "StatefulSet"
    assert kube.boxes == {MACHINE: NS}


def test_nothing_waiting_does_nothing():
    core, kube = FakeCore(), FakeKube()
    assert BoxOperator(core, kube, cfg()).run_once() is False
    assert core.calls == [] and kube.created == []


def test_every_object_is_in_the_users_namespace_with_a_fixed_name_as_template_v2_3_has_it():
    objects = [obj for _, obj in box_objects(action(), cfg())]
    names = {(o["kind"], o["metadata"]["name"]) for o in objects}
    assert names == {
        ("Namespace", NS),
        ("NetworkPolicy", "default-deny"),
        ("NetworkPolicy", "agent-egress"),
        ("ResourceQuota", "no-shared-services-priority"),
        ("ServiceAccount", "box"),
        ("ConfigMap", "switch-ca"),
        ("ConfigMap", "claude-managed-settings"),
        ("Secret", "switch-enrol"),
        ("Secret", "switch-proxy-login"),
        ("PersistentVolumeClaim", "data-controller"),
        ("PersistentVolumeClaim", "data-agents"),
        ("RoleBinding", "switch-box-watch"),
        ("RoleBinding", "switch-operator-restart"),
        ("StatefulSet", "box"),
    }
    for obj in objects:
        if obj["kind"] != "Namespace":
            assert obj["metadata"]["namespace"] == NS
    (namespace,) = [o for o in objects if o["kind"] == "Namespace"]
    # Split template v2's labels, with __USER__ as `user-<keyed id>`, and the machine-id annotation.
    assert namespace["metadata"]["labels"] == {
        "app.kubernetes.io/part-of": "hosted-agents-test",
        "app.kubernetes.io/managed-by": "switch-hosted",
        "switch.dev/user": f"user-{USER}",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
    }
    assert namespace["metadata"]["annotations"] == {"switch.dev/machine-id": MACHINE}


def test_the_secrets_are_made_empty_and_the_operator_never_holds_a_code_or_a_login():
    for obj in (o for _, o in box_objects(action(), cfg()) if o["kind"] == "Secret"):
        assert "data" not in obj and "stringData" not in obj


def test_the_box_starts_at_zero_and_its_pod_is_the_hardened_split_template():
    (box,) = [o for _, o in box_objects(action(), cfg()) if o["kind"] == "StatefulSet"]
    assert box["spec"]["replicas"] == 0
    pod = box["spec"]["template"]["spec"]
    assert pod["runtimeClassName"] == "gvisor"
    assert pod["automountServiceAccountToken"] is False and pod["serviceAccountName"] == "box"
    assert pod["securityContext"]["runAsNonRoot"] is True
    assert "hostNetwork" not in pod and all("hostPath" not in v for v in pod["volumes"])
    controller, agents = pod["containers"]
    assert (controller["name"], agents["name"]) == ("controller", "agents")
    assert (controller["securityContext"]["runAsUser"], agents["securityContext"]["runAsUser"]) == (
        2001,
        2000,
    )
    for container in (controller, agents):
        assert (
            container["image"] == RAW_CONFIG["image"]
        )  # pinned by digest, from the operator's config
        assert container["securityContext"]["allowPrivilegeEscalation"] is False
        assert container["securityContext"]["readOnlyRootFilesystem"] is True
        assert container["securityContext"]["capabilities"] == {"drop": ["ALL"]}
    ctl = {e["name"]: e for e in controller["env"]}
    box_env = {e["name"]: e for e in agents["env"]}
    assert ctl["SWITCH_MACHINE_NAME"]["value"] == MACHINE_NAME
    # Each container takes only its own proxy login, by reference, and the pod passes allow-lists' own check.
    assert ctl["SWITCH_CONTROLLER_GATEWAY_PROXY"]["valueFrom"]["secretKeyRef"] == {
        "name": "switch-proxy-login",
        "key": "ctl_https_proxy",
    }
    assert box_env["HTTPS_PROXY"]["valueFrom"]["secretKeyRef"] == {
        "name": "switch-proxy-login",
        "key": "https_proxy",
    }
    assert check_box_pod_spec(pod, split=True) == []
    # The pod's memory limit, as the controller reads it: both containers' limits together.
    assert ctl["SWITCH_BOX_MEMORY_LIMIT_BYTES"]["value"] == str(768 * 2**20 + 6 * 2**30)
    assert pod["nodeSelector"] == {
        "switch.dev/pool": "agents",
        "topology.kubernetes.io/zone": zone_for(USER, RAW_CONFIG["zones"]),
    }
    assert pod["hostname"] == f"user-{USER}"
    # The controller's own traffic uses the plain proxy URL; only its gateway takes a login.
    assert ctl["HTTPS_PROXY"] == {
        "name": "HTTPS_PROXY",
        "value": "http://squid.egress-proxy.svc:3128",
    }


def test_the_size_comes_from_the_operators_own_list():
    disks = {
        o["metadata"]["name"]: o["spec"]["resources"]["requests"]["storage"]
        for _, o in box_objects(action(), cfg())
        if o["kind"] == "PersistentVolumeClaim"
    }
    assert disks == {"data-controller": "2Gi", "data-agents": "15Gi"}
    with pytest.raises(ProvisionFailed) as failed:
        box_objects(action(size="huge"), cfg())
    assert failed.value.code == "object_refused"


# ── What it takes from Core ─────────────────────────────────────────────────


def test_the_namespace_matches_the_policys_exact_pattern():
    assert namespace_for(USER) == NS and NAMESPACE_RE.fullmatch(NS)
    assert len(NS) <= 63


@pytest.mark.parametrize(
    ("field", "bad"),
    [
        ("user_keyed_id", "k1-0123456789ABCDEF"),
        ("user_keyed_id", "k1-0123"),
        ("user_keyed_id", "ada"),
        ("user_keyed_id", "k1-0123456789abcdef/../kube-system"),
        ("machine_id", "not-a-uuid"),
        ("size", "Standard!"),
        ("action_id", ""),
        ("claim_token", "short"),
    ],
)
def test_anything_off_in_the_action_is_refused_before_any_call(field, bad):
    raw = {
        "action_id": "a1",
        "machine_id": MACHINE,
        "user_keyed_id": USER,
        "size": "standard",
        "claim_token": TOKEN,
        field: bad,
    }
    core, kube = FakeCore([raw]), FakeKube()
    BoxOperator(core, kube, cfg()).run_once()
    assert kube.created == [] and kube.boxes == {}
    # Never reported: the lease runs out and Core expires the action (it makes every action from checked ids).
    assert core.calls == []


def test_only_the_three_fields_are_used_whatever_else_core_sends():
    raw = {
        "action_id": "a1",
        "machine_id": MACHINE,
        "user_keyed_id": USER,
        "size": "standard",
        "claim_token": TOKEN,
        "namespace": "kube-system",
        "image": "evil:latest",
    }
    core, kube = FakeCore([raw]), FakeKube()
    BoxOperator(core, kube, cfg()).run_once()
    assert {ns for (_, ns, _) in kube.objects if ns} == {NS}
    text = json.dumps(list(kube.objects.values()))
    assert 'kube-system"' not in text.replace('"kubernetes.io/metadata.name": "kube-system"', "")
    assert "evil:latest" not in text


# ── Safe to repeat, create-only ─────────────────────────────────────────────


def test_a_repeat_makes_nothing_new_and_still_reports_done():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    made = list(kube.created)
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert kube.created == made
    assert result(core)[2] == "done"
    assert kube.boxes == {MACHINE: NS}


def test_a_restart_partway_through_carries_on_and_ends_with_one_box():
    kube = FakeKube()
    # Half made: the namespace, its policies and the disk, but no box and no map entry.
    for step, obj in box_objects(action(), cfg()):
        if obj["kind"] in ("Namespace", "NetworkPolicy", "PersistentVolumeClaim"):
            kube.create_or_get(obj)
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2] == "done"
    assert sum(1 for k, _ in kube.created if k == "StatefulSet") == 1
    assert kube.boxes == {MACHINE: NS}


def test_a_filled_secret_and_a_running_box_still_count_as_ours():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    kube.objects[("Secret", NS, "switch-enrol")]["data"] = {"code": "c3djZV8="}
    kube.objects[("Secret", NS, "switch-proxy-login")]["data"] = {"https_proxy": "aHR0cA=="}
    kube.objects[("StatefulSet", NS, "box")]["spec"]["replicas"] = 1
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2] == "done"


@pytest.mark.parametrize(
    ("kind", "name", "change", "code"),
    [
        (
            "Namespace",
            NS,
            lambda o: o["metadata"]["labels"].pop("app.kubernetes.io/managed-by"),
            "name_refused",
        ),
        ("NetworkPolicy", "agent-egress", lambda o: o["spec"].update(egress=[]), "policy_refused"),
        (
            "ConfigMap",
            "switch-ca",
            lambda o: o["data"].update({"ca.crt": "other"}),
            "object_refused",
        ),
        (
            "StatefulSet",
            "box",
            lambda o: o["spec"]["template"]["spec"].update(runtimeClassName="runc"),
            "object_refused",
        ),
    ],
)
def test_something_already_there_that_isnt_ours_fails_and_is_never_changed(
    kind, name, change, code
):
    kube = FakeKube()
    for _, obj in box_objects(action(), cfg()):
        if obj["kind"] == kind and obj["metadata"]["name"] == name:
            planted = copy.deepcopy(obj)
            change(planted)
            kube.objects[(kind, obj["metadata"].get("namespace", ""), name)] = planted
    before = copy.deepcopy(kube.objects)
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2:] == ("failed", NS, code)
    for key, obj in before.items():
        assert kube.objects[key] == obj
    assert kube.boxes == {}


@pytest.mark.parametrize(
    ("kind", "code"),
    [
        ("Namespace", "name_refused"),
        ("NetworkPolicy", "policy_refused"),
        ("StatefulSet", "object_refused"),
    ],
)
def test_a_create_the_cluster_refuses_fails_at_its_step(kind, code):
    kube = FakeKube()
    kube.refuse = {kind}
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2:] == ("failed", NS, code)
    assert kube.boxes == {}


# ── The box map ─────────────────────────────────────────────────────────────


def test_the_box_map_only_gains_entries_and_retries_a_conflict():
    kube = FakeKube()
    kube.boxes = {"99999999-2222-3333-4444-555555555555": "agents-user-k1-ffffffffffffffff"}
    kube.conflicts = 2
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2] == "done"
    assert kube.boxes == {
        "99999999-2222-3333-4444-555555555555": "agents-user-k1-ffffffffffffffff",
        MACHINE: NS,
    }


def test_a_machine_or_namespace_already_someone_elses_is_refused():
    with pytest.raises(ProvisionFailed) as failed:
        with_box({MACHINE: "agents-user-k1-ffffffffffffffff"}, MACHINE, NS, 50)
    assert failed.value.code == "box_map_failed"
    with pytest.raises(ProvisionFailed) as failed:
        with_box({"99999999-2222-3333-4444-555555555555": NS}, MACHINE, NS, 50)
    assert failed.value.code == "box_map_failed"
    assert with_box({MACHINE: NS}, MACHINE, NS, 50) is None


def test_the_ceiling_is_a_backstop_for_coreS_cap():
    full = {f"{i:08x}-2222-3333-4444-555555555555": f"agents-user-k1-{i:016x}" for i in range(3)}
    kube = FakeKube()
    kube.boxes = dict(full)
    core = FakeCore()
    BoxOperator(core, kube, cfg(ceiling=3)).provision(action())
    assert result(core)[2:] == ("failed", NS, "ceiling_reached")
    assert kube.boxes == full


def test_endless_conflicts_end_as_box_map_failed():
    kube = FakeKube()
    kube.conflicts = 99
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2:] == ("failed", NS, "box_map_failed")


# ── Configuration, matching, logs ───────────────────────────────────────────


@pytest.mark.parametrize(
    "over",
    [
        {"image": "registry.example/box:latest"},
        {"image": "registry.example/box@sha256:" + "a" * 12},
        {"server_url": "http://10.0.0.10"},
        {"ceiling": 0},
        {"sizes": {"standard": {"disk": "15Gi"}}},
        {"zones": []},
        {"zones": ["eu-west-3a", "eu-west-3a"]},
        {"default_size": "huge"},
        {"unexpected": True},
    ],
)
def test_a_configuration_with_anything_off_is_refused_whole(over):
    with pytest.raises(ConfigError):
        cfg(**over)


def test_matching_ignores_the_clusters_own_defaults_but_not_a_difference():
    assert contains({"a": 1, "b": {"c": 2, "d": 3}}, {"b": {"c": 2}})
    assert not contains({"a": [1, 2]}, {"a": [1]})
    assert not contains({"a": {"c": 2}}, {"a": {"c": 3}})
    (quota,) = [o for _, o in box_objects(action(), cfg()) if o["kind"] == "ResourceQuota"]
    existing = copy.deepcopy(quota)
    existing["metadata"]["resourceVersion"] = "7"
    existing["status"] = {"used": {"pods": "0"}}
    assert matches(existing, quota)


def test_every_failure_code_is_one_core_accepts():
    assert set(FAILURES) == {
        "name_refused",
        "policy_refused",
        "object_refused",
        "box_map_failed",
        "ceiling_reached",
    }


def test_log_lines_carry_ids_and_codes_only(caplog):
    caplog.set_level(logging.INFO)
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    kube2 = FakeKube()
    kube2.refuse = {"StatefulSet"}
    BoxOperator(FakeCore(), kube2, cfg()).provision(action())
    text = caplog.text
    assert NS in text and MACHINE in text
    assert CA.strip() not in text and SETTINGS not in text
    assert "BEGIN CERTIFICATE" not in text


def test_an_object_made_for_another_machine_is_never_taken_over():
    """An "already exists" answer counts only when the machine id matches. The same user's namespace, left from a
    different machine, fails rather than being adopted."""
    kube = FakeKube()
    other = action(machine_id="99999999-2222-3333-4444-555555555555")
    for _, obj in box_objects(other, cfg()):
        kube.create_or_get(obj)
    before = copy.deepcopy(kube.objects)
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2:] == ("failed", NS, "name_refused")
    assert kube.objects == before and kube.boxes == {}


def test_the_claim_token_never_reaches_a_log_line(caplog):
    caplog.set_level(logging.INFO)
    kube = FakeKube()
    kube.refuse = {"StatefulSet"}
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    assert TOKEN not in caplog.text and TOKEN not in repr(action())


def test_existing_secrets_are_never_read_and_count_as_ours_once_the_namespace_matched():
    """The operator has no `get` on Secrets. On a repeat, both Secrets answer
    "already exists" unread, which is safe because the namespace with this machine's id was checked first."""
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2] == "done"
    assert kube.secret_reads_avoided == 2


def test_the_zone_is_the_same_for_a_user_every_time_and_spreads_over_users():
    zones = RAW_CONFIG["zones"]
    assert zone_for(USER, zones) == zone_for(USER, zones)
    assert {zone_for(f"k1-{i:016x}", zones) for i in range(60)} == set(zones)


@pytest.mark.parametrize("name", ["switch-box-watch", "switch-operator-restart"])
def test_the_two_rolebindings_are_pinned_as_policy_p8_has_them(name):
    """Cluster-side v2.3: the eviction watch's binding, and from template v2.3 restart's, each with a fixed name, a
    roleRef to the admin-made ClusterRole of the same name and a single subject, made before the box. No Role is
    ever made: a namespaced binding to a ClusterRole grants its rights in this namespace only."""
    objects = box_objects(action(), cfg())
    (binding,) = [
        o for _, o in objects if o["kind"] == "RoleBinding" and o["metadata"]["name"] == name
    ]
    assert binding["metadata"] == {"name": name, "namespace": NS}
    assert binding["roleRef"] == {
        "apiGroup": "rbac.authorization.k8s.io",
        "kind": "ClusterRole",
        "name": name,
    }
    assert binding["subjects"] == [
        {"kind": "ServiceAccount", "name": "switch-hosted-controller", "namespace": "switch-hosted"}
    ]
    kinds = [o["kind"] for _, o in objects]
    names = [o["metadata"]["name"] for _, o in objects]
    assert names.index(name) < kinds.index("StatefulSet")
    assert names.index("switch-box-watch") < names.index("switch-operator-restart")
    assert kinds.count("RoleBinding") == 2
    assert not {"Role", "ClusterRole", "ClusterRoleBinding"} & set(kinds)


@pytest.mark.parametrize(
    "change",
    [
        lambda b: b["roleRef"].update(name="cluster-admin"),
        lambda b: b["roleRef"].update(kind="Role"),
        lambda b: b["subjects"].append({"kind": "ServiceAccount", "name": "x", "namespace": NS}),
        lambda b: b["subjects"][0].update(name="default"),
        lambda b: b["subjects"][0].update(namespace=NS),
        lambda b: b["subjects"].__setitem__(0, {"kind": "Group", "name": "system:authenticated"}),
    ],
)
def test_an_existing_restart_binding_of_another_shape_is_refused(change):
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    change(kube.objects[("RoleBinding", NS, "switch-operator-restart")])
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2:] == ("failed", NS, "object_refused")


def test_a_box_made_before_template_v2_3_gets_its_restart_binding_and_is_done():
    """A returning box whose namespace has no restart binding yet. Create-only, carrying on where it
    stopped: the binding is made in its pinned shape, nothing else is written, and the action is done."""
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    del kube.objects[("RoleBinding", NS, "switch-operator-restart")]
    made = list(kube.created)
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2:] == ("done", NS, None)
    assert kube.created[len(made) :] == [("RoleBinding", "switch-operator-restart")]


def test_a_machine_with_no_size_yet_gets_the_configured_default():
    """Core sends the machine's size, which is null until its first observation: the operator's
    own default applies. A size that is sent must be one the operator lists."""
    no_size = box_objects(action(size=None), cfg())
    (disk,) = [o for _, o in no_size if o["metadata"]["name"] == "data-agents"]
    assert disk["spec"]["resources"]["requests"]["storage"] == "15Gi"
    with pytest.raises(ProvisionFailed):
        box_objects(action(size="t3.large"), cfg())


def test_the_operator_builds_exactly_the_ticked_template():
    """The template is code here, so it's checked against the reviewed file. The fixture is split
    template v2.3 (93c93f78…) rendered with `kubectl create --dry-run=client -o json` and the fixed
    render values (fixture sha256 7293ce26…), with the same
    two placeholders as before swapped in: the AWS account id for 123456789012 and the server address for
    10.0.0.10. Every one of the 14 objects must be equal, field for field."""
    from pathlib import Path

    rendered = json.loads(
        (Path(__file__).parent / "fixtures" / "box-template-split-v2.3-render.json").read_text()
    )["items"]
    config = config_from(
        {
            **RAW_CONFIG,
            "image": "123456789012.dkr.ecr.eu-west-3.amazonaws.com/hosted-agents-test/box@sha256:"
            + "a" * 64,
            "zones": ["eu-west-3a"],
            # The `standard` size, as in the Deployment's config.
            "sizes": {
                "standard": {
                    "disk": "15Gi",
                    "cpu_request": "150m",
                    "cpu_limit": "3",
                    "memory_request": "768Mi",
                    "memory_limit": "5376Mi",
                }
            },
        },
        "-----BEGIN CERTIFICATE-----\nTESTCA\n-----END CERTIFICATE-----\n",
        '{"test": true}\n',
    )
    built = box_objects(
        action(machine_id="7a3e8f4c-1d2b-4c5e-9f60-718293a4b5c6", user_keyed_id=USER),
        config,
    )
    ours = {(o["kind"], o["metadata"]["name"]): o for _, o in built}
    theirs = {(o["kind"], o["metadata"]["name"]): o for o in rendered}
    assert set(ours) == set(theirs)
    for key, obj in theirs.items():
        assert ours[key] == obj, key


IMAGE_A = RAW_CONFIG["image"]
IMAGE_B = "registry.example/hosted-agents-box@sha256:" + "b" * 64
STANDARD = RAW_CONFIG["sizes"]["standard"]
LARGE = {
    "disk": "30Gi",
    "cpu_request": "500m",
    "cpu_limit": "4",
    "memory_request": "2Gi",
    "memory_limit": "8Gi",
}


def _resize(kube, size):  # type: ignore[no-untyped-def]
    """What a resize does to a box made earlier: the agents container, its memory setting and its disk."""
    box = kube.objects[("StatefulSet", NS, "box")]
    controller, agents = box["spec"]["template"]["spec"]["containers"]
    agents["resources"] = {
        "requests": {"cpu": size["cpu_request"], "memory": size["memory_request"]},
        "limits": {"cpu": size["cpu_limit"], "memory": size["memory_limit"]},
    }
    (env,) = [e for e in controller["env"] if e["name"] == "SWITCH_BOX_MEMORY_LIMIT_BYTES"]
    env["value"] = str(768 * 2**20 + int(size["memory_limit"][:-2]) * 2**30)
    kube.objects[("PersistentVolumeClaim", NS, "data-agents")]["spec"]["resources"]["requests"][
        "storage"
    ] = size["disk"]


def _set_image(kube, image, which=(0, 1)):  # type: ignore[no-untyped-def]
    containers = kube.objects[("StatefulSet", NS, "box")]["spec"]["template"]["spec"]["containers"]
    for i in which:
        containers[i]["image"] = image


def _again(kube, config):  # type: ignore[no-untyped-def]
    made = list(kube.created)
    core = FakeCore()
    BoxOperator(core, kube, config).provision(action())
    assert kube.created == made  # never writes over what's there
    return result(core)[2:]


def test_a_returning_users_box_is_still_its_own_after_a_rollout_or_a_resize():
    """Made with digest A, then config digest B with A still allowed: done, with no writes. And
    after platform resized it to another configured size."""
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    rolled = cfg(
        image=IMAGE_B, allowed_images=[IMAGE_A], sizes={"standard": STANDARD, "large": LARGE}
    )
    assert _again(kube, rolled) == ("done", NS, None)
    _resize(kube, LARGE)
    assert _again(kube, rolled) == ("done", NS, None)
    _set_image(kube, IMAGE_B)  # rolled onto the current digest
    assert _again(kube, rolled) == ("done", NS, None)


@pytest.mark.parametrize(
    "image",
    [
        "registry.example/hosted-agents-box@sha256:" + "c" * 64,  # pinned, but not on the list
        "registry.example/hosted-agents-box:latest",  # not pinned
        "registry.example/hosted-agents-box:v1",
        None,
    ],
)
@pytest.mark.parametrize("which", [(0,), (1,), (0, 1)])
def test_an_existing_box_with_an_unlisted_or_unpinned_image_is_refused_and_alerted(
    image, which, caplog
):
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    _set_image(kube, image, which)
    rolled = cfg(image=IMAGE_B, allowed_images=[IMAGE_A])
    with caplog.at_level(logging.ERROR):
        assert _again(kube, rolled) == ("failed", NS, "object_refused")
    assert any("ALERT" in r.getMessage() for r in caplog.records)
    assert not any("registry.example" in r.getMessage() for r in caplog.records)


def test_an_image_no_longer_on_the_list_is_refused():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    assert _again(kube, cfg(image=IMAGE_B)) == ("failed", NS, "object_refused")


@pytest.mark.parametrize("key", ["initContainers", "ephemeralContainers"])
def test_an_extra_container_is_refused_whatever_its_image(key):
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    pod = kube.objects[("StatefulSet", NS, "box")]["spec"]["template"]["spec"]
    pod[key] = [{"name": "x", "image": "registry.example/other:latest"}]
    assert _again(kube, cfg()) == ("failed", NS, "object_refused")
    pod[key] = [{"name": "x", "image": IMAGE_A}]  # even an allowed one: it isn't in the template
    assert _again(kube, cfg()) == ("failed", NS, "object_refused")


def test_resources_matching_no_configured_size_are_refused():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    _resize(kube, LARGE)  # resized to a size this configuration doesn't have
    assert _again(kube, cfg()) == ("failed", NS, "object_refused")


@pytest.mark.parametrize(
    "change",
    [
        # the agents container a size mix: large's cpu, standard's memory
        lambda c, d, env: c[1]["resources"]["requests"].update(cpu="500m"),
        # a resource added beyond the size
        lambda c, d, env: c[1]["resources"]["limits"].update({"ephemeral-storage": "100Gi"}),
        # the controller's fixed resources changed
        lambda c, d, env: c[0]["resources"]["limits"].update(memory="4Gi"),
        # the memory setting from another size
        lambda c, d, env: env.update(value=str(768 * 2**20 + 8 * 2**30)),
        # the memory setting dropped
        lambda c, d, env: env.pop("value"),
        # the disk from another size than the container's
        lambda c, d, env: d.update(storage="30Gi"),
        # a disk matching no size
        lambda c, d, env: d.update(storage="999Gi"),
    ],
)
def test_a_box_whose_parts_disagree_on_its_size_is_refused(change):
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    containers = kube.objects[("StatefulSet", NS, "box")]["spec"]["template"]["spec"]["containers"]
    disk = kube.objects[("PersistentVolumeClaim", NS, "data-agents")]["spec"]["resources"][
        "requests"
    ]
    (env,) = [e for e in containers[0]["env"] if e["name"] == "SWITCH_BOX_MEMORY_LIMIT_BYTES"]
    change(containers, disk, env)
    two_sizes = cfg(sizes={"standard": STANDARD, "large": LARGE})
    assert _again(kube, two_sizes) == ("failed", NS, "object_refused")


def test_the_controller_disk_stays_exact():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    kube.objects[("PersistentVolumeClaim", NS, "data-controller")]["spec"]["resources"]["requests"][
        "storage"
    ] = "15Gi"  # a configured size's disk, but this one is fixed
    assert _again(kube, cfg()) == ("failed", NS, "object_refused")


@pytest.mark.parametrize(
    "where, key, value",
    [
        ("pod", "hostNetwork", True),
        ("pod", "tolerations", [{"operator": "Exists"}]),
        ("pod", "dnsPolicy", "None"),
        ("pod", "restartPolicy", "Never"),
        ("container", "stdin", True),
        ("container", "envFrom", [{"configMapRef": {"name": "x"}}]),
        ("container", "terminationMessagePath", "/data/agents/x"),
        ("spec", "volumeClaimTemplates", [{"metadata": {"name": "data-agents"}}]),
        ("spec", "podManagementPolicy", "Parallel"),
    ],
)
def test_a_key_the_template_never_sets_is_refused(where, key, value):
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    spec = kube.objects[("StatefulSet", NS, "box")]["spec"]
    target = {
        "spec": spec,
        "pod": spec["template"]["spec"],
        "container": spec["template"]["spec"]["containers"][1],
    }[where]
    target[key] = value
    assert _again(kube, cfg()) == ("failed", NS, "object_refused")


def test_the_api_servers_own_defaults_still_count_as_ours():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    spec = kube.objects[("StatefulSet", NS, "box")]["spec"]
    spec.update(
        podManagementPolicy="OrderedReady",
        revisionHistoryLimit=10,
        updateStrategy={
            "type": "RollingUpdate",
            "rollingUpdate": {"partition": 0, "maxUnavailable": 1},
        },
        persistentVolumeClaimRetentionPolicy={"whenDeleted": "Retain", "whenScaled": "Retain"},
        minReadySeconds=0,
    )
    spec["template"]["metadata"]["creationTimestamp"] = None
    spec["template"]["metadata"]["annotations"] = {
        "kubectl.kubernetes.io/restartedAt": "2026-10-26T14:03:11+01:00"
    }  # a manual `kubectl rollout restart`
    spec["template"]["spec"].update(
        restartPolicy="Always",
        dnsPolicy="ClusterFirst",
        schedulerName="default-scheduler",
        serviceAccount="box",  # copied from serviceAccountName
    )
    for container in spec["template"]["spec"]["containers"]:
        container.update(
            terminationMessagePath="/dev/termination-log", terminationMessagePolicy="File"
        )
    for volume in spec["template"]["spec"]["volumes"]:
        for source in ("configMap", "secret"):
            if source in volume:
                volume[source]["defaultMode"] = 420
    spec["replicas"] = 1  # the scaler started it
    kube.objects[("StatefulSet", NS, "box")]["status"] = {"replicas": 1}
    kube.objects[("StatefulSet", NS, "box")]["metadata"].update(
        resourceVersion="9", generation=2, creationTimestamp="2026-10-29T10:00:00Z"
    )
    assert _again(kube, cfg()) == ("done", NS, None)


def _pod(kube):  # type: ignore[no-untyped-def]
    return kube.objects[("StatefulSet", NS, "box")]["spec"]["template"]["spec"]


@pytest.mark.parametrize(
    "change",
    [
        # cases each below the container or pod level
        lambda k: _pod(k)["containers"][1]["securityContext"].update(privileged=True),
        lambda k: _pod(k)["containers"][0]["securityContext"]["capabilities"].update(
            add=["SYS_ADMIN"]
        ),
        lambda k: _pod(k)["securityContext"].update(
            sysctls=[{"name": "kernel.shm_rmid_forced", "value": "0"}]
        ),
        lambda k: _pod(k)["securityContext"].update(supplementalGroups=[0]),
        lambda k: _pod(k)["affinity"].update(
            nodeAffinity={
                "requiredDuringSchedulingIgnoredDuringExecution": {
                    "nodeSelectorTerms": [
                        {"matchExpressions": [{"key": "x", "operator": "Exists"}]}
                    ]
                }
            }
        ),
        lambda k: _pod(k)["nodeSelector"].update({"switch.dev/pool": "system"}),
        lambda k: _pod(k)["nodeSelector"].update({"node.example/other": "yes"}),
        lambda k: kube_template_meta(k).update(
            annotations={"container.apparmor.security.beta.kubernetes.io/agents": "unconfined"}
        ),
        lambda k: kube_template_meta(k)["labels"].update(extra="x"),
        # the restart mark beside anything else, or not a timestamp
        lambda k: kube_template_meta(k).update(
            annotations={
                "kubectl.kubernetes.io/restartedAt": "2026-10-26T14:03:11Z",
                "container.apparmor.security.beta.kubernetes.io/agents": "unconfined",
            }
        ),
        lambda k: kube_template_meta(k).update(
            annotations={"kubectl.kubernetes.io/restartedAt": "soon"}
        ),
        lambda k: kube_template_meta(k).update(
            annotations={"kubectl.kubernetes.io/restartedAt": 1}
        ),
        # other depths
        lambda k: _pod(k)["volumes"][4]["configMap"].update(defaultMode=511),
        lambda k: _pod(k)["volumes"][5]["secret"].update(optional=False),
        lambda k: _pod(k)["volumes"][2]["emptyDir"].update(medium="Memory"),
        lambda k: _pod(k)["containers"][0]["volumeMounts"][2].update(readOnly=False),
        lambda k: _pod(k)["containers"][1]["volumeMounts"][0].update(subPath="x"),
        lambda k: _pod(k)["containers"][1]["env"][1].update(value="/tmp/ca.crt"),
        lambda k: _pod(k)["containers"][0]["env"][-1].update(valueFrom={"x": 1}),
        lambda k: _pod(k).update(terminationGracePeriodSeconds=60.0),
        lambda k: kube_template_meta(k).update(creationTimestamp="2026-10-29T10:00:00Z"),
        lambda k: k.objects[("StatefulSet", NS, "box")]["spec"].update(replicas=2),
        lambda k: k.objects[("StatefulSet", NS, "box")]["spec"].update(
            updateStrategy={"type": "RollingUpdate", "rollingUpdate": {"partition": 1}}
        ),
        lambda k: k.objects[("StatefulSet", NS, "box")]["spec"].update(
            updateStrategy={
                "type": "RollingUpdate",
                "rollingUpdate": {"partition": 0, "maxUnavailable": 2},
            }
        ),
        lambda k: k.objects[("StatefulSet", NS, "box")]["spec"].update(
            persistentVolumeClaimRetentionPolicy={"whenDeleted": "Delete", "whenScaled": "Retain"}
        ),
        lambda k: k.objects[("StatefulSet", NS, "box")]["spec"].update(
            persistentVolumeClaimRetentionPolicy={"whenDeleted": "Retain", "whenScaled": "Delete"}
        ),
        # the old field must name the same account as serviceAccountName
        lambda k: _pod(k).update(serviceAccount="default"),
        lambda k: _pod(k).update(serviceAccount=None),
    ],
)
def test_any_difference_at_any_depth_of_the_spec_is_refused(change):
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    change(kube)
    assert _again(kube, cfg()) == ("failed", NS, "object_refused")


def kube_template_meta(kube):  # type: ignore[no-untyped-def]
    return kube.objects[("StatefulSet", NS, "box")]["spec"]["template"]["metadata"]


@pytest.mark.parametrize("which", [(0,), (1,)])
def test_both_containers_must_run_the_same_image(which):
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    _set_image(kube, IMAGE_B, which)  # both images allowed, but not the same
    assert _again(kube, cfg(allowed_images=[IMAGE_B])) == ("failed", NS, "object_refused")


@pytest.mark.parametrize(
    "bad",
    [
        "registry.example/box:latest",
        "registry.example/box@sha256:" + "a" * 12,
        42,
    ],
)
def test_allowed_images_must_each_be_pinned(bad):
    with pytest.raises(ConfigError):
        cfg(allowed_images=[bad])


def test_allowed_images_must_be_a_short_list_of_distinct_images():
    with pytest.raises(ConfigError):
        cfg(allowed_images=IMAGE_A)
    with pytest.raises(ConfigError):
        cfg(allowed_images=[IMAGE_B, IMAGE_B])
    with pytest.raises(ConfigError):
        cfg(allowed_images=[f"registry.example/b@sha256:{i:064x}" for i in range(21)])
    assert cfg().allowed_images == frozenset(
        [IMAGE_A]
    )  # the key is optional: just the current image
    assert cfg(allowed_images=[IMAGE_B]).allowed_images == frozenset([IMAGE_A, IMAGE_B])


@pytest.mark.parametrize(
    "key, bad",
    [
        ("cpu_request", "0.5"),
        ("cpu_request", "1000m"),
        ("cpu_limit", "4000m"),
        ("cpu_limit", "1.5"),
        ("cpu_request", "0"),
        ("cpu_request", "0250m"),
        ("memory_request", "1.5Gi"),
        ("memory_request", "1024Mi"),
        ("memory_limit", "6G"),
        ("memory_limit", "6442450944"),
        ("memory_limit", "1Ti"),
        ("disk", "15360Mi"),
        ("disk", "1024Gi"),
        ("disk", "15G"),
        ("disk", "0Gi"),
    ],
)
def test_a_size_not_in_the_api_servers_own_form_is_refused(key, bad):
    with pytest.raises(ConfigError):
        cfg(sizes={"standard": {**STANDARD, key: bad}})


@pytest.mark.parametrize(
    "key, good",
    [
        ("cpu_request", "1"),
        ("cpu_request", "1500m"),
        ("memory_request", "1536Mi"),
        ("memory_limit", "6Gi"),
        ("disk", "2Ti"),
        ("disk", "1536Gi"),
    ],
)
def test_a_size_in_the_api_servers_own_form_is_accepted(key, good):
    assert cfg(sizes={"standard": {**STANDARD, key: good}})


def test_a_fresh_box_is_made_at_the_current_image_never_an_older_allowed_one():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg(image=IMAGE_B, allowed_images=[IMAGE_A])).provision(action())
    pod = kube.objects[("StatefulSet", NS, "box")]["spec"]["template"]["spec"]
    assert {c["image"] for c in pod["containers"]} == {IMAGE_B}


def test_a_rollout_never_hides_any_other_difference():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    box = kube.objects[("StatefulSet", NS, "box")]
    box["spec"]["template"]["spec"]["containers"][0]["securityContext"][
        "allowPrivilegeEscalation"
    ] = True
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(action())
    assert result(core)[2:] == ("failed", NS, "object_refused")


def _real_box_c() -> dict:
    """A real `kubectl get sts box -n agents-user-c -o json` (2026-10-29, sha256 e7a0208d…f025), with only the
    registry account and the server address swapped for placeholders (the repo is public). Box C predates box provisioning, made from
    an older template, so it's used here for the API server's real defaults only."""
    from pathlib import Path

    return json.loads(
        (Path(__file__).parent / "fixtures" / "box-sts-agents-user-c-real.json").read_text()
    )


def test_every_default_the_real_api_server_added_still_counts_as_ours():
    """The defaults list proven against a real StatefulSet, not only a hand-written one. Every key the real
    cluster added where the template sets nothing (StatefulSet spec, pod template metadata, pod spec, each
    container, each configMap and secret volume) is copied onto a box this made, with the real value. The box
    must still be its own."""
    real = _real_box_c()["spec"]
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    spec = kube.objects[("StatefulSet", NS, "box")]["spec"]

    def add_missing(ours: dict, theirs: dict) -> list[str]:
        added = [key for key in theirs if key not in ours]
        for key in added:
            ours[key] = copy.deepcopy(theirs[key])
        return added

    added = add_missing(spec, real)
    added += add_missing(spec["template"]["metadata"], real["template"]["metadata"])
    added += add_missing(spec["template"]["spec"], real["template"]["spec"])
    (real_container,) = real["template"]["spec"]["containers"]
    for container in spec["template"]["spec"]["containers"]:
        added += add_missing(container, real_container)
    real_sources = {
        source: volume[source]
        for volume in real["template"]["spec"]["volumes"]
        for source in ("configMap", "secret")
        if source in volume
    }
    for volume in spec["template"]["spec"]["volumes"]:
        for source, theirs in real_sources.items():
            if source in volume:
                added += [k for k in theirs if k == "defaultMode" and k not in volume[source]]
                volume[source].setdefault("defaultMode", theirs["defaultMode"])
    # What the real cluster added, so a change to it shows here first.
    assert set(added) >= {
        "podManagementPolicy",
        "revisionHistoryLimit",
        "updateStrategy",
        "persistentVolumeClaimRetentionPolicy",
        "annotations",
        "restartPolicy",
        "dnsPolicy",
        "schedulerName",
        "serviceAccount",
        "terminationMessagePath",
        "terminationMessagePolicy",
        "defaultMode",
    }
    assert _again(kube, cfg()) == ("done", NS, None)
