"""The box operator, without a cluster or Core: what it makes, in what order, and that it's create-only, safe to
repeat and never changes what isn't its own."""

from __future__ import annotations

import copy
import json
import logging
import re
from email.message import Message
from pathlib import Path
from urllib.error import HTTPError

import pytest

from switch_hosted_controller.box_operator import (
    EXISTS_UNREAD,
    FAILURES,
    MACHINE_NAME,
    NAMESPACE_RE,
    ActionError,
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
    "daily_calls": 500,
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
        self.reports: list = []  # what each claim told Core (revision and capabilities)

    def claim(self, report=None):  # type: ignore[no-untyped-def]
        self.reports.append(report)
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


def test_only_the_checked_fields_are_used_whatever_else_core_sends():
    raw = {
        "action_id": "a1",
        "machine_id": MACHINE,
        "user_keyed_id": USER,
        "size": "standard",
        "claim_token": TOKEN,
        "image": "evil:latest",
        "lease_seconds": 120,
    }
    core, kube = FakeCore([raw]), FakeKube()
    BoxOperator(core, kube, cfg()).run_once()
    assert {ns for (_, ns, _) in kube.objects if ns} == {NS}
    assert "evil:latest" not in json.dumps(list(kube.objects.values()))


def test_a_namespace_core_names_outside_this_actions_two_is_refused_and_nothing_made(caplog):  # type: ignore[no-untyped-def]
    """Core names the namespace now; the operator still makes only one of the two this action may have (the
    person-keyed one, or the box-keyed one of the box Core names), so a bad name from Core is never made."""
    for bad in (
        "kube-system",
        "switch-hosted",
        "agents-user-k1-ffffffffffffffff",
        "agents-box-k1-0000000000000001",
    ):
        raw = {
            "action_id": "a1",
            "machine_id": MACHINE,
            "user_keyed_id": USER,
            "claim_token": TOKEN,
            "box_keyed_id": "k1-00000000000000aa",
            "namespace": bad,
        }
        core, kube = FakeCore([raw]), FakeKube()
        BoxOperator(core, kube, cfg()).run_once()
        assert kube.objects == {} and core.calls == [], bad
    assert "bad namespace" in caplog.text and "kube-system" not in caplog.text


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


class ExpiredCore(FakeCore):
    """Core that has already expired the request: the result is refused (409),
    as the real client raises it."""

    def result(self, action_id, claim_token, result, namespace, failed_at):  # type: ignore[no-untyped-def]
        super().result(action_id, claim_token, result, namespace, failed_at)
        raise HTTPError(f"/actions/{action_id}/result", 409, "Conflict", Message(), None)


def test_a_retry_after_a_box_built_past_its_expiry_reuses_that_box():
    """A box finished after Core expired its request is left made, mapped and at
    zero, since nothing deletes a box. The owner's retry is a new request for the
    same machine: it reuses that box (nothing new made, one map entry) and is
    reported done."""
    kube = FakeKube()
    late = ExpiredCore()
    with pytest.raises(HTTPError):
        BoxOperator(late, kube, cfg()).provision(action(action_id="late"))
    assert result(late)[1:3] == ("late", "done")
    made = list(kube.created)
    assert ("StatefulSet", "box") in made
    assert kube.boxes == {MACHINE: NS}

    retry = FakeCore()
    BoxOperator(retry, kube, cfg()).provision(action(action_id="retry"))
    assert kube.created == made
    assert result(retry) == ("result", "retry", "done", NS, None)
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
    # One addition to the ticked template since: the controller's daily AI call cap, checked here
    # and then taken out, so every other field still has to equal the reviewed render.
    controller = next(
        c
        for _, o in built
        if o["kind"] == "StatefulSet"
        for c in o["spec"]["template"]["spec"]["containers"]
        if c["name"] == "controller"
    )
    cap = {"name": "SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS", "value": "500"}
    assert controller["env"].count(cap) == 1
    controller["env"].remove(cap)
    # And template t2's three (warm pool), checked exactly and taken out the same way: the starter
    # container, the code Secret readable by the pod's group only (0440) with the starter's one-key login check, and
    # the autoscaler's safe-to-evict mark.
    from switch_hosted_controller.box_operator import _before_starter

    (sts,) = [o for _, o in built if o["kind"] == "StatefulSet"]
    pod = sts["spec"]["template"]["spec"]
    (starter,) = pod["initContainers"]
    assert starter["name"] == "starter" and starter["image"] == config.image
    assert sts["spec"]["template"]["metadata"]["annotations"] == {
        "cluster-autoscaler.kubernetes.io/safe-to-evict": "false"
    }
    assert [v for v in pod["volumes"] if v["name"] == "enrol"][0]["secret"]["defaultMode"] == 0o440
    assert [v["name"] for v in pod["volumes"]][-1] == "login-check"
    sts["spec"] = _before_starter(sts["spec"])
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
    spec["template"]["metadata"]["annotations"]["kubectl.kubernetes.io/restartedAt"] = (
        "2026-10-26T14:03:11+01:00"  # a manual `kubectl rollout restart`, beside the box's own annotation
    )
    spec["template"]["spec"].update(
        restartPolicy="Always",
        dnsPolicy="ClusterFirst",
        schedulerName="default-scheduler",
        serviceAccount="box",  # copied from serviceAccountName
    )
    for container in (
        spec["template"]["spec"]["containers"] + spec["template"]["spec"]["initContainers"]
    ):
        container.update(
            terminationMessagePath="/dev/termination-log", terminationMessagePolicy="File"
        )
    for volume in spec["template"]["spec"]["volumes"]:
        for source in ("configMap", "secret"):
            if source in volume:
                volume[source].setdefault(
                    "defaultMode", 420
                )  # where this set none (enrol's is 0440)
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
    # Our template sets an annotation now (safe-to-evict); the real cluster's (a restart mark) goes beside it.
    real_marks = real["template"]["metadata"].get("annotations") or {}
    ours_marks = spec["template"]["metadata"].setdefault("annotations", {})
    if any(k not in ours_marks for k in real_marks):
        added.append("annotations")
        ours_marks.update({k: v for k, v in real_marks.items() if k not in ours_marks})
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


@pytest.mark.parametrize("value", [None, 0, -1, True, 2.5, "500", 1_000_000_001])
def test_the_daily_call_cap_is_required_and_finite(value):  # type: ignore[no-untyped-def]
    """Every box gets a finite daily cap on AI calls through its gateway: a config without one, or
    with anything but a whole number from 1 to the gateway's bound, is refused whole."""
    raw = {**RAW_CONFIG, "daily_calls": value}
    if value is None:
        del raw["daily_calls"]
    with pytest.raises(ConfigError, match="daily_calls"):
        config_from(raw, CA, SETTINGS)


def test_every_box_controller_gets_the_daily_call_cap():  # type: ignore[no-untyped-def]
    """The cap goes to the box controller's gateway as SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS, a plain value
    (admission policy P8 admits plain values), and to no other container."""
    built = box_objects(action(), cfg(daily_calls=1234))
    (box,) = [o for _, o in built if o["kind"] == "StatefulSet"]
    envs = {c["name"]: c.get("env", []) for c in box["spec"]["template"]["spec"]["containers"]}
    cap = {"name": "SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS", "value": "1234"}
    assert envs["controller"].count(cap) == 1
    assert all(
        e["name"] != cap["name"] for name, env in envs.items() if name != "controller" for e in env
    )


def _without_daily_calls(kube):  # type: ignore[no-untyped-def]
    """The box as the template made it before the daily call cap: also before the starter container
    (t2), which came later, and minus that one env entry."""
    from switch_hosted_controller.box_operator import _before_starter

    box = kube.objects[("StatefulSet", NS, "box")]
    box["spec"] = _before_starter(box["spec"])
    controller = box["spec"]["template"]["spec"]["containers"][0]
    before = len(controller["env"])
    controller["env"] = [
        e for e in controller["env"] if e["name"] != "SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS"
    ]
    assert len(controller["env"]) == before - 1


def test_a_box_made_before_the_daily_call_cap_is_still_reused(caplog):  # type: ignore[no-untyped-def]
    """A box made by the template before the daily call cap has no SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS. Core asking
    for its machine's box again (a retry, a re-claim) re-uses it, as before the upgrade, rather than refusing it,
    writes nothing, and says it re-used an older shape."""
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    _without_daily_calls(kube)
    made = list(kube.created)
    caplog.set_level("WARNING", logger="switch_hosted_controller.box_operator")
    assert _again(kube, cfg()) == ("done", NS, None)
    assert kube.created == made
    assert any(
        "earlier template (before the daily call cap)" in r.getMessage() and NS in r.getMessage()
        for r in caplog.records
    )


def test_the_ceiling_changed_the_box_is_still_reused(caplog):  # type: ignore[no-untyped-def]
    """The operator changes daily_calls (500 to 5000): a box made with 500 is still this box's own on its next
    re-claim, keeps the cap it was made with (no writes), and the difference is logged with both values."""
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg(daily_calls=500)).provision(action())
    made = list(kube.created)
    caplog.set_level("INFO", logger="switch_hosted_controller.box_operator")
    assert _again(kube, cfg(daily_calls=5000)) == ("done", NS, None)
    assert kube.created == made
    assert any(
        NS in r.getMessage() and "made with (500), not the configured 5000" in r.getMessage()
        for r in caplog.records
    )


def test_todays_box_is_reused_without_a_warning(caplog):  # type: ignore[no-untyped-def]
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    caplog.set_level("WARNING", logger="switch_hosted_controller.box_operator")
    assert _again(kube, cfg()) == ("done", NS, None)
    assert not any("earlier template" in r.getMessage() for r in caplog.records)


def test_an_earlier_box_shape_is_accepted_only_exactly():
    """Only the earlier template's exact shape: a pre-cap box with anything else changed is still refused, and a
    cap env holding anything but a valid cap (ASCII digits, no leading zero, 1 to 1e9) is refused, never taken as
    missing."""
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    _without_daily_calls(kube)
    kube.objects[("StatefulSet", NS, "box")]["spec"]["template"]["spec"]["hostNetwork"] = True
    assert _again(kube, cfg()) == ("failed", NS, "object_refused")

    for invalid in ("0", "-5", "ten", "1000000001", "", "007", "1e3"):
        kube = FakeKube()
        BoxOperator(FakeCore(), kube, cfg()).provision(action())
        pod = kube.objects[("StatefulSet", NS, "box")]["spec"]["template"]["spec"]
        (cap,) = [
            e
            for e in pod["containers"][0]["env"]
            if e["name"] == "SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS"
        ]
        cap["value"] = invalid
        assert _again(kube, cfg()) == ("failed", NS, "object_refused"), invalid


# The box template's fields as of the daily call cap (see the test below).
PINNED_TEMPLATE_FIELDS = {
    "pod": [
        "affinity",
        "automountServiceAccountToken",
        "containers",
        "enableServiceLinks",
        "hostname",
        "initContainers",
        "nodeSelector",
        "runtimeClassName",
        "securityContext",
        "serviceAccountName",
        "terminationGracePeriodSeconds",
        "volumes",
    ],
    "containers": {
        "controller": [
            "args",
            "env",
            "image",
            "imagePullPolicy",
            "name",
            "resources",
            "securityContext",
            "volumeMounts",
        ],
        "agents": [
            "command",
            "env",
            "image",
            "imagePullPolicy",
            "name",
            "resources",
            "securityContext",
            "volumeMounts",
        ],
    },
    "env": {
        "controller": [
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
            "HOME",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NODE_EXTRA_CA_CERTS",
            "NO_PROXY",
            "SWITCH_BOX_MEMORY_LIMIT_BYTES",
            "SWITCH_CONTROLLER_DATA_DIR",
            "SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS",
            "SWITCH_CONTROLLER_GATEWAY_PROXY",
            "SWITCH_CONTROLLER_PROVIDER_GATEWAY",
            "SWITCH_CONTROLLER_RESERVE_BYTES",
            "SWITCH_CONTROLLER_REST_AFTER_MS",
            "SWITCH_MACHINE_DESCRIPTION",
            "SWITCH_MACHINE_NAME",
            "SWITCH_SERVER",
            "SWITCH_SESSION_PARK_AFTER_MS",
            "SWITCH_SESSION_START_CONCURRENCY",
            "SWITCH_SESSION_START_RESERVE_BYTES",
            "http_proxy",
            "https_proxy",
            "no_proxy",
        ],
        "agents": [
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
            "HOME",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NODE_EXTRA_CA_CERTS",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "no_proxy",
        ],
    },
}


def _template_fields():  # type: ignore[no-untyped-def]
    objs = box_objects(action(), cfg())
    (box,) = [o for _, o in objs if o["kind"] == "StatefulSet"]
    pod = box["spec"]["template"]["spec"]
    return {
        "pod": sorted(pod),
        "containers": {c["name"]: sorted(c) for c in pod["containers"]},
        "env": {c["name"]: sorted(e["name"] for e in c.get("env", [])) for c in pod["containers"]},
    }


def test_the_template_fields_have_their_earlier_shapes():
    """A field added to the box template (a pod key, a container key, an env entry) makes every box made before it
    a mismatch, refused on re-use, unless box_operator._earlier_templates lists the shape without it. So this fails
    on any change to the template's fields: add the earlier shape and a test that it is re-used, then this list."""
    assert _template_fields() == PINNED_TEMPLATE_FIELDS, (
        "The box template's fields changed: boxes made before would be refused on re-use. Add the earlier shape to "
        "box_operator._earlier_templates, with a test that it is re-used, then update PINNED_TEMPLATE_FIELDS."
    )


# ---- switch-ca after a CA renewal: earlier bundles, listed exactly ----

CA_OLD = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
CA_BUNDLE = CA_OLD + "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n"
CA_NEW = "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n"


def _ca_cfg(ca, **over):  # type: ignore[no-untyped-def]
    return config_from({**RAW_CONFIG, **over}, ca, SETTINGS)


def test_a_box_made_before_a_ca_renewal_is_reused_when_its_bundle_is_listed(caplog):  # type: ignore[no-untyped-def]
    """Made with the 2-cert bundle; the operator now has only the new CA, and lists the bundle as earlier: done,
    nothing written, the box keeps its bundle, and the log names which earlier bundle, never its content."""
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, _ca_cfg(CA_BUNDLE)).provision(action())
    caplog.set_level("WARNING", logger="switch_hosted_controller.box_operator")
    config = _ca_cfg(CA_NEW, earlier_box_cas=[CA_BUNDLE])
    assert _again(kube, config) == ("done", NS, None)
    assert kube.objects[("ConfigMap", NS, "switch-ca")]["data"] == {"ca.crt": CA_BUNDLE}
    assert any(
        "earlier CA bundle 1" in r.getMessage() and NS in r.getMessage() for r in caplog.records
    )
    assert "MIIB" not in caplog.text and "MIIC" not in caplog.text


def test_a_box_made_before_a_ca_renewal_is_refused_when_its_bundle_isnt_listed():  # type: ignore[no-untyped-def]
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, _ca_cfg(CA_BUNDLE)).provision(action())
    assert _again(kube, _ca_cfg(CA_NEW))[0] == "failed"
    assert (
        _again(kube, _ca_cfg(CA_NEW, earlier_box_cas=[CA_OLD]))[0] == "failed"
    )  # only exact bundles


def test_todays_ca_is_reused_without_a_warning(caplog):  # type: ignore[no-untyped-def]
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, _ca_cfg(CA_NEW, earlier_box_cas=[CA_BUNDLE])).provision(action())
    caplog.set_level("WARNING", logger="switch_hosted_controller.box_operator")
    assert _again(kube, _ca_cfg(CA_NEW, earlier_box_cas=[CA_BUNDLE])) == ("done", NS, None)
    assert "earlier CA bundle" not in caplog.text


@pytest.mark.parametrize(
    "change",
    [
        lambda cm: cm["data"].update({"extra.crt": CA_NEW}),  # a key beside ca.crt
        lambda cm: cm["data"].update({"ca.crt": CA_BUNDLE + "\n"}),  # not exactly the bundle
    ],
)
def test_a_switch_ca_with_anything_else_changed_is_refused(change):  # type: ignore[no-untyped-def]
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, _ca_cfg(CA_BUNDLE)).provision(action())
    change(kube.objects[("ConfigMap", NS, "switch-ca")])
    assert _again(kube, _ca_cfg(CA_NEW, earlier_box_cas=[CA_BUNDLE]))[0] == "failed"


@pytest.mark.parametrize(
    "earlier",
    [
        "not a list",
        [CA_NEW],  # the current one
        [CA_BUNDLE, CA_BUNDLE],  # twice
        [CA_OLD, CA_BUNDLE, CA_OLD + CA_OLD, CA_BUNDLE + CA_OLD, CA_OLD * 3],  # more than 4
        ["-----BEGIN CERTIFICATE-----\nMIIB\n"],  # not a whole PEM
        ["-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n"],  # not a certificate
        [CA_OLD + "trailing text"],
        [CA_OLD * 2000],  # over 64 KB
        [5],
    ],
)
def test_earlier_box_cas_is_refused_whole_if_anything_is_off(earlier):  # type: ignore[no-untyped-def]
    with pytest.raises(ConfigError) as refused:
        _ca_cfg(CA_NEW, earlier_box_cas=earlier)
    assert "MIIB" not in str(refused.value)


def test_the_switch_ca_object_is_pinned():  # type: ignore[no-untyped-def]
    """The pinned-content guard: an existing box's switch-ca is compared exactly, so any change to what the
    operator writes there (a key, a label, how the bundle is built) refuses every box made before it on re-claim.
    If this fails, list the earlier shape (as `_earlier_cas` does for bundles), with a test that it is re-used,
    then update this pin."""
    (ca,) = [
        o
        for _, o in box_objects(action(), _ca_cfg(CA_BUNDLE))
        if o["metadata"]["name"] == "switch-ca"
    ]
    assert ca == {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "switch-ca", "namespace": NS},
        "data": {"ca.crt": CA_BUNDLE},  # box-ca.crt exactly, nothing added or trimmed
    }


def test_the_documented_ca_change_loads_in_one_step():  # type: ignore[no-untyped-def]
    """DEPLOY.md's order: the new box-ca.crt and the old bundle in earlier_box_cas, in one change. That loads; the
    current bundle listed as earlier is refused, so the operator would not start (which is why it's one step)."""
    config = _ca_cfg(CA_NEW, earlier_box_cas=[CA_BUNDLE])
    assert config.ca_cert == CA_NEW and config.earlier_box_cas == (CA_BUNDLE,)
    with pytest.raises(ConfigError):
        _ca_cfg(CA_BUNDLE, earlier_box_cas=[CA_BUNDLE])
    deploy = (Path(__file__).resolve().parents[2] / "DEPLOY.md").read_text()
    assert "in one apply and one roll" in deploy and "Don't list the current bundle there" in deploy


# ---- box-keyed names (warm pool, `box_names`) ----

BOX_ID = "k1-00000000000000aa"
BOX_NS = f"agents-box-{BOX_ID}"


def box_action(**over):  # type: ignore[no-untyped-def]
    return action(box_keyed_id=BOX_ID, namespace=BOX_NS, **over)


def test_a_box_keyed_action_makes_the_box_under_the_name_core_gave():
    """Core names the box after the box: every object goes in that namespace, the one name label is
    `switch.dev/box` (never `switch.dev/user`), the hostname is `box-k1-…`, the box map holds that name, and the
    result reports it. Nothing carries the person's keyed id."""
    kube, core = FakeKube(), FakeCore()
    BoxOperator(core, kube, cfg()).provision(box_action())
    assert {ns for (_, ns, _) in kube.objects if ns} == {BOX_NS}
    namespace = kube.objects[("Namespace", "", BOX_NS)]
    assert namespace["metadata"]["labels"]["switch.dev/box"] == f"box-{BOX_ID}"
    assert "switch.dev/user" not in namespace["metadata"]["labels"]
    box = kube.objects[("StatefulSet", BOX_NS, "box")]
    pod = box["spec"]["template"]
    assert pod["metadata"]["labels"] == {"app": "switch-box", "switch.dev/box": f"box-{BOX_ID}"}
    assert pod["spec"]["hostname"] == f"box-{BOX_ID}"
    assert USER not in json.dumps(list(kube.objects.values()))
    assert kube.boxes == {MACHINE: BOX_NS}
    assert result(core)[2:] == ("done", BOX_NS, None)


def test_a_person_keyed_box_is_made_exactly_as_before():
    """A Core from before names no namespace, and one that names the person-keyed one gets the same objects."""
    before, named = FakeKube(), FakeKube()
    BoxOperator(FakeCore(), before, cfg()).provision(action())
    BoxOperator(FakeCore(), named, cfg()).provision(action(namespace=NS, box_keyed_id=BOX_ID))
    assert before.objects == named.objects
    assert (
        before.objects[("Namespace", "", NS)]["metadata"]["labels"]["switch.dev/user"]
        == f"user-{USER}"
    )


@pytest.mark.parametrize("make", [action, box_action])
def test_an_existing_box_is_reused_for_both_name_shapes(make):  # type: ignore[no-untyped-def]
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(make())
    ns = BOX_NS if make is box_action else NS
    assert _again_with(kube, cfg(), make()) == ("done", ns, None)


def _again_with(kube, config, act):  # type: ignore[no-untyped-def]
    made = list(kube.created)
    core = FakeCore()
    BoxOperator(core, kube, config).provision(act)
    assert kube.created == made
    return result(core)[2:]


def test_a_box_keyed_namespace_made_for_another_machine_is_not_this_boxs():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(box_action())
    other = "22222222-2222-4222-8222-222222222222"
    core = FakeCore()
    BoxOperator(core, kube, cfg()).provision(box_action(machine_id=other))
    assert result(core)[2] == "failed"


def test_an_unknown_kind_is_refused(caplog):  # type: ignore[no-untyped-def]
    raw = {
        "action_id": "a1",
        "machine_id": MACHINE,
        "user_keyed_id": USER,
        "claim_token": TOKEN,
        "kind": "x",
    }
    core, kube = FakeCore([raw]), FakeKube()
    BoxOperator(core, kube, cfg()).run_once()
    assert kube.objects == {} and "bad kind" in caplog.text


# ---- what each claim tells Core: template revision, and box-keyed names only once the cluster admits them ----


class ProbeKube(FakeKube):
    def __init__(self, answers):  # type: ignore[no-untyped-def]
        super().__init__()
        self.answers = list(answers)
        self.probes: list[dict] = []

    def admits(self, obj):  # type: ignore[no-untyped-def]
        self.probes.append(obj)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def test_box_keyed_names_are_never_listed_before_egress_reads_box_owners():
    """In this build a box-keyed box gets no egress login, so even a passing dry run lists nothing: otherwise every
    new box would be made box-keyed and have no egress."""
    from switch_hosted_controller import box_operator

    assert box_operator.BOX_KEYED_EGRESS_READY is False
    core = FakeCore()
    BoxOperator(core, ProbeKube([True]), cfg()).run_once()
    assert core.reports[0]["capabilities"] == []


def test_box_keyed_names_are_listed_only_while_the_cluster_admits_them(monkeypatch):  # type: ignore[no-untyped-def]
    from switch_hosted_controller import box_operator

    monkeypatch.setattr(
        box_operator, "BOX_KEYED_EGRESS_READY", True
    )  # as in the build whose egress reads box-owners
    clock = {"now": 0.0}
    kube = ProbeKube([False, True, None, RuntimeError("x"), False])
    core = FakeCore()
    op = BoxOperator(core, kube, cfg(), clock=lambda: clock["now"])
    seen = []
    for step in range(6):
        op.run_once()
        seen.append(core.reports[-1]["capabilities"])
        clock["now"] += 3600.0 if step != 2 else 10.0  # one claim within the hour: no new probe
    assert seen == [
        [],
        ["box_keyed_names"],
        ["box_keyed_names"],
        ["box_keyed_names"],
        ["box_keyed_names"],
        [],
    ]
    # Refused, admitted, (no probe within the hour), unknown keeps it, error keeps it, refused drops it.
    assert len(kube.probes) == 5
    probe = kube.probes[0]
    assert (
        probe["kind"] == "Namespace"
        and probe["metadata"]["name"] == "agents-box-k1-0000000000000000"
    )
    assert probe["metadata"]["labels"]["switch.dev/box"] == "box-k1-0000000000000000"
    assert probe["metadata"]["annotations"] == {
        "switch.dev/machine-id": "00000000-0000-4000-8000-000000000000"
    }


def test_every_claim_carries_this_builds_template_revision():
    core = FakeCore()
    op = BoxOperator(core, ProbeKube([False]), cfg())
    op.run_once()
    revision = core.reports[0]["template_revision"]
    assert re.fullmatch(r"t2-[0-9a-f]{12}", revision)
    from switch_hosted_controller.box_operator import template_revision

    other = cfg(image="registry.example/hosted-agents-box@sha256:" + "b" * 64)
    assert (
        template_revision(other) != revision
    )  # a new image is a new revision: Core retires older pool boxes
    assert template_revision(cfg()) == revision


# ---- template t2: the starter container (warm pool) ----


def _sts_pod(kube, ns=NS):  # type: ignore[no-untyped-def]
    return kube.objects[("StatefulSet", ns, "box")]["spec"]["template"]["spec"]


def test_the_code_and_the_login_check_are_mounted_exactly_where_agreed():
    """`switch-enrol` by exactly the controller and the starter; the one login key by the starter alone. The main
    containers keep reading the login from their environment, as before."""
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    pod = _sts_pod(kube)
    everyone = pod["initContainers"] + pod["containers"]
    mounts = {c["name"]: {m["name"] for m in c.get("volumeMounts", [])} for c in everyone}
    assert {n for n, m in mounts.items() if "enrol" in m} == {"controller", "starter"}
    assert {n for n, m in mounts.items() if "login-check" in m} == {"starter"}
    for c in pod["containers"]:
        refs = [e["valueFrom"]["secretKeyRef"]["name"] for e in c["env"] if "valueFrom" in e]
        assert "switch-proxy-login" in refs, c["name"]
    volumes = {v["name"]: v for v in pod["volumes"]}
    assert volumes["enrol"]["secret"]["defaultMode"] == 0o440
    assert volumes["login-check"]["secret"]["items"] == [
        {"key": "https_proxy", "path": "https_proxy"}
    ]
    assert volumes["login-check"]["secret"]["defaultMode"] == 0o440
    assert all(m.get("readOnly") is True for m in pod["initContainers"][0]["volumeMounts"])


def test_the_starter_is_the_box_image_hardened_small_and_prints_no_content():
    from switch_hosted_controller.box_operator import STARTER_SCRIPT

    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    (starter,) = _sts_pod(kube)["initContainers"]
    assert starter["image"] == RAW_CONFIG["image"]
    assert starter["securityContext"] == {
        "runAsUser": 2001,
        "runAsGroup": 2000,
        "allowPrivilegeEscalation": False,
        "readOnlyRootFilesystem": True,
        "capabilities": {"drop": ["ALL"]},
    }
    assert starter["resources"]["limits"] == {"cpu": "100m", "memory": "32Mi"}
    assert (
        "cat " not in STARTER_SCRIPT and "$(" not in STARTER_SCRIPT
    )  # it tests the files, never reads them out
    assert kube.objects[("StatefulSet", NS, "box")]["spec"]["template"]["metadata"][
        "annotations"
    ] == {"cluster-autoscaler.kubernetes.io/safe-to-evict": "false"}
    assert _sts_pod(kube)["automountServiceAccountToken"] is False


@pytest.mark.parametrize("order", ["code first", "login first"])
def test_the_starter_waits_for_both_files_then_exits_once(tmp_path, order):  # type: ignore[no-untyped-def]
    """The starter's own script, run with sh: it keeps waiting with one file or none, exits once both are there,
    in either order, and prints a fixed line only."""
    import subprocess
    import time

    from switch_hosted_controller.box_operator import STARTER_SCRIPT

    enrol, login = tmp_path / "enrol", tmp_path / "login"
    enrol.mkdir()
    login.mkdir()
    script = STARTER_SCRIPT.replace("/etc/switch/enrol", str(enrol)).replace(
        "/etc/switch/login", str(login)
    )
    proc = subprocess.Popen(["sh", "-c", script], stdout=subprocess.PIPE, text=True)
    first, second = (enrol / "code", login / "https_proxy")
    if order == "login first":
        first, second = second, first
    time.sleep(0.8)
    assert proc.poll() is None  # neither yet
    first.write_text("SECRET-CANARY-1")
    time.sleep(1.2)
    assert proc.poll() is None  # one only
    second.write_text("SECRET-CANARY-2")
    out, _ = proc.communicate(timeout=5)
    assert proc.returncode == 0
    assert out == "switch-box: code and login present\n"


@pytest.mark.parametrize("make", [action, box_action])
def test_a_box_made_before_the_starter_is_still_reused(make, caplog):  # type: ignore[no-untyped-def]
    """A box made by template t1 (no starter, the code at the default mode, no annotation) is still its own on
    re-claim, for both name shapes, writes nothing, and says it re-used an earlier shape."""
    from switch_hosted_controller.box_operator import _before_starter

    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(make())
    ns = BOX_NS if make is box_action else NS
    box = kube.objects[("StatefulSet", ns, "box")]
    box["spec"] = _before_starter(box["spec"])
    caplog.set_level("WARNING", logger="switch_hosted_controller.box_operator")
    assert _again_with(kube, cfg(), make()) == ("done", ns, None)
    assert any("before the starter container" in r.getMessage() for r in caplog.records)


def test_a_box_with_a_changed_starter_is_refused():
    kube = FakeKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    _sts_pod(kube)["initContainers"][0]["command"] = ["sh", "-c", "cat /etc/switch/enrol/code"]
    assert _again(kube, cfg())[0] == "failed"


# ---- t2 refused by admission (P4 not updated yet): make t1, keep pool and bind off for an hour ----


class P4OldKube(ProbeKube):
    """A cluster whose admission refuses a StatefulSet with an init container (P4 from before t2), or fails on the
    network, as told."""

    def __init__(self, network_error=False):  # type: ignore[no-untyped-def]
        super().__init__([False] * 10)
        self.network_error = network_error
        self.t2_attempts = 0

    def create_or_get(self, obj):  # type: ignore[no-untyped-def]
        if obj["kind"] == "StatefulSet" and obj["spec"]["template"]["spec"].get("initContainers"):
            self.t2_attempts += 1
            if self.network_error:
                raise OSError("connection reset")
            raise Refused(422)
        return super().create_or_get(obj)


def test_t2_refused_makes_the_box_as_t1_and_keeps_pool_and_bind_off(monkeypatch, caplog):  # type: ignore[no-untyped-def]
    from switch_hosted_controller import box_operator

    monkeypatch.setattr(
        box_operator, "POOL_BIND_READY", True
    )  # as in the build that makes pool boxes
    clock = {"now": 0.0}
    kube, core = P4OldKube(), FakeCore()
    op = BoxOperator(core, kube, cfg(), clock=lambda: clock["now"])
    caplog.set_level("WARNING", logger="switch_hosted_controller.box_operator")
    op.provision(action())
    assert result(core)[2:] == ("done", NS, None)
    pod = _sts_pod(kube)
    assert "initContainers" not in pod and "login-check" not in {v["name"] for v in pod["volumes"]}
    assert any(
        "Template t2 refused" in r.getMessage() and "422" in r.getMessage() for r in caplog.records
    )
    assert op.report()["capabilities"] == []  # no pool or bind: Core makes no pool boxes
    # Within the hour, the next box goes straight to t1 without trying t2 again.
    op.provision(
        action(
            machine_id="22222222-2222-4222-8222-222222222222", user_keyed_id="k1-1111111111111111"
        )
    )
    assert kube.t2_attempts == 1
    # After the hour, t2 is tried again.
    clock["now"] += 3601
    assert op.report()["capabilities"] == ["pool", "bind"]


def test_t2_admitted_makes_t2_and_lists_pool_and_bind(monkeypatch):  # type: ignore[no-untyped-def]
    from switch_hosted_controller import box_operator

    monkeypatch.setattr(box_operator, "POOL_BIND_READY", True)
    kube, core = ProbeKube([False] * 3), FakeCore()
    op = BoxOperator(core, kube, cfg())
    op.provision(action())
    assert _sts_pod(kube)["initContainers"][0]["name"] == "starter"
    assert op.report()["capabilities"] == ["pool", "bind"]


def test_pool_and_bind_are_not_listed_in_this_build():
    op = BoxOperator(FakeCore(), ProbeKube([False]), cfg())
    assert "pool" not in op.report()["capabilities"] and "bind" not in op.report()["capabilities"]


def test_a_network_error_on_t2_is_a_failure_to_retry_never_a_fallback():
    kube, core = P4OldKube(network_error=True), FakeCore()
    op = BoxOperator(core, kube, cfg())
    with pytest.raises(OSError):
        op.provision(action())
    assert ("StatefulSet", NS, "box") not in kube.objects
    assert op.t2_admitted()  # nothing remembered: the next claim tries t2 again


def test_a_t1_box_made_by_the_fallback_is_reused_later(caplog):  # type: ignore[no-untyped-def]
    kube = P4OldKube()
    BoxOperator(FakeCore(), kube, cfg()).provision(action())
    # P4 is updated meanwhile: the same box is claimed again by an operator for which t2 is fine.
    plain = FakeKube()
    plain.objects, plain.boxes, plain.created = kube.objects, kube.boxes, kube.created
    caplog.set_level("WARNING", logger="switch_hosted_controller.box_operator")
    assert _again(plain, cfg()) == ("done", NS, None)
    assert any("before the starter container" in r.getMessage() for r in caplog.records)


# ---- warm pool: pool create and bind (B1-B4) ----

POOL_ID = "33333333-3333-4333-8333-333333333333"
POOL_BOX = "k1-00000000000000bb"
POOL_NS = f"agents-box-{POOL_BOX}"


class PoolKube(ProbeKube):
    """FakeKube plus the two add-only lists and a namespace read."""

    def __init__(self):  # type: ignore[no-untyped-def]
        super().__init__([False] * 50)
        self.lists: dict[str, dict[str, str]] = {"pool-map": {}, "box-owners": {}}
        self.list_writes: list[str] = []

    def read_list(self, name):  # type: ignore[no-untyped-def]
        if name == "box-map":
            return dict(self.boxes), str(self.version)
        return dict(self.lists[name]), "1"

    def write_list(self, name, data, resource_version):  # type: ignore[no-untyped-def]
        current = self.boxes if name == "box-map" else self.lists[name]
        for key, value in current.items():  # what the cluster's add-only policy enforces
            assert data.get(key) == value, "an existing entry changed or went"
        self.list_writes.append(name)
        if name == "box-map":
            self.boxes = dict(data)
        else:
            self.lists[name] = dict(data)

    def get_namespace(self, name):  # type: ignore[no-untyped-def]
        return copy.deepcopy(self.objects.get(("Namespace", "", name)))


class PoolCore(FakeCore):
    def __init__(self, actions=None, step_ok=True, open_=True):  # type: ignore[no-untyped-def]
        super().__init__(actions)
        self.step_ok, self.open_ = step_ok, open_
        self.steps: list[str] = []

    def step(self, action_id, claim_token, step):  # type: ignore[no-untyped-def]
        assert claim_token == TOKEN
        self.steps.append(step)
        return self.step_ok

    def is_open(self, action_id, claim_token):  # type: ignore[no-untyped-def]
        assert claim_token == TOKEN
        self.steps.append("recheck")
        return self.open_


def pool_action(**over):  # type: ignore[no-untyped-def]
    raw = {
        "action_id": "p1",
        "machine_id": POOL_ID,
        "user_keyed_id": None,
        "claim_token": TOKEN,
        "kind": "pool",
        "box_keyed_id": POOL_BOX,
        "namespace": POOL_NS,
        **over,
    }
    return ProvisionAction.parse(raw)


def bind_action(**over):  # type: ignore[no-untyped-def]
    return pool_action(action_id="b1", kind="bind", user_keyed_id=USER, **over)


def _pooled():  # type: ignore[no-untyped-def]
    kube, core = PoolKube(), PoolCore()
    BoxOperator(core, kube, cfg()).pool(pool_action())
    return kube, core


def test_a_pool_box_has_no_egress_rule_no_box_map_entry_and_no_person():
    kube, core = _pooled()
    assert ("NetworkPolicy", POOL_NS, "agent-egress") not in kube.objects
    assert ("NetworkPolicy", POOL_NS, "default-deny") in kube.objects
    assert kube.boxes == {} and kube.lists["pool-map"] == {POOL_ID: POOL_NS}
    assert kube.lists["box-owners"] == {}
    assert USER not in json.dumps(list(kube.objects.values()))
    assert result(core)[2:] == ("done", POOL_NS, None)
    assert kube.objects[("StatefulSet", POOL_NS, "box")]["spec"]["replicas"] == 0


def test_a_bind_adds_owner_then_egress_then_the_box_map_in_that_order():
    kube, _ = _pooled()
    core = PoolCore()
    order: list[str] = []
    BoxOperator(core, kube, cfg()).bind(bind_action(), stop_after=order.append)
    assert order == ["B1", "owner_writing", "B2", "B3", "B4"]
    assert core.steps == ["owner_writing", "recheck"]
    assert kube.lists["box-owners"] == {POOL_NS: USER}
    assert ("NetworkPolicy", POOL_NS, "agent-egress") in kube.objects
    assert kube.boxes == {POOL_ID: POOL_NS}
    assert kube.list_writes == [
        "pool-map",
        "box-owners",
    ]  # the box map goes through write_box_map, last
    assert result(core)[2:] == ("done", POOL_NS, None)


def test_a_bind_for_another_machine_is_refused_before_anything_is_written():
    kube, _ = _pooled()
    core = PoolCore()
    BoxOperator(core, kube, cfg()).bind(
        bind_action(machine_id="44444444-4444-4444-8444-444444444444")
    )
    assert result(core)[2:] == ("failed", POOL_NS, "bind_machine_mismatch")
    assert core.steps == [] and kube.lists["box-owners"] == {} and kube.boxes == {}


def test_core_refusing_owner_writing_writes_nothing_and_reports_bind_closed():
    kube, _ = _pooled()
    core = PoolCore(step_ok=False)
    BoxOperator(core, kube, cfg()).bind(bind_action())
    assert result(core)[2:] == ("failed", POOL_NS, "bind_closed")
    assert kube.lists["box-owners"] == {} and kube.boxes == {}
    assert ("NetworkPolicy", POOL_NS, "agent-egress") not in kube.objects


def test_a_closed_bind_at_the_recheck_never_reaches_the_box_map():
    kube, _ = _pooled()
    core = PoolCore(open_=False)
    BoxOperator(core, kube, cfg()).bind(bind_action())
    assert result(core)[2:] == ("failed", POOL_NS, "bind_closed")
    assert kube.lists["box-owners"] == {
        POOL_NS: USER
    }  # Core already counts it as the person's (owner_writing)
    assert kube.boxes == {}


def test_another_owner_already_there_is_bind_owner_taken_and_an_alert(caplog):  # type: ignore[no-untyped-def]
    kube, _ = _pooled()
    kube.lists["box-owners"] = {POOL_NS: "k1-ffffffffffffffff"}
    core = PoolCore()
    caplog.set_level("ERROR", logger="switch_hosted_controller.box_operator")
    BoxOperator(core, kube, cfg()).bind(bind_action())
    assert result(core)[2:] == ("failed", POOL_NS, "bind_owner_taken")
    assert kube.boxes == {} and "ALERT" in caplog.text and "k1-ffffffffffffffff" not in caplog.text


def test_a_retried_bind_after_a_crash_at_each_step_ends_bound_once():
    """Stop after each step, then bind again (the lease ran out and the action came back): it carries on, writes
    nothing twice, and ends bound."""
    for stop in ("B1", "owner_writing", "B2", "B3"):
        kube, _ = _pooled()

        def crash(step, stop=stop):  # type: ignore[no-untyped-def]
            if step == stop:
                raise RuntimeError("crash")

        with pytest.raises(RuntimeError):
            BoxOperator(PoolCore(), kube, cfg()).bind(bind_action(), stop_after=crash)
        core = PoolCore()
        BoxOperator(core, kube, cfg()).bind(bind_action())
        assert result(core)[2:] == ("done", POOL_NS, None), stop
        assert kube.lists["box-owners"] == {POOL_NS: USER} and kube.boxes == {POOL_ID: POOL_NS}


def test_pool_and_bind_actions_only_ever_name_the_box_keyed_namespace():
    for bad in (
        {"namespace": f"agents-user-{USER}"},
        {"namespace": "agents-box-k1-0000000000000001"},
        {"box_keyed_id": None},
    ):
        with pytest.raises(ActionError):
            pool_action(**bad)
        with pytest.raises(ActionError):
            bind_action(**bad)
    with pytest.raises(ActionError):
        pool_action(kind="anything")


def test_the_claim_token_never_reaches_a_log_on_any_bind_path(caplog):  # type: ignore[no-untyped-def]
    caplog.set_level("DEBUG")
    for core in (PoolCore(), PoolCore(step_ok=False), PoolCore(open_=False)):
        kube, _ = _pooled()
        BoxOperator(core, kube, cfg()).bind(bind_action())
    kube, _ = _pooled()
    BoxOperator(PoolCore(), kube, cfg()).bind(
        bind_action(machine_id="44444444-4444-4444-8444-444444444444")
    )
    assert caplog.records and TOKEN not in caplog.text
    assert TOKEN not in repr(bind_action())


def test_pool_and_bind_wait_for_the_build_whose_egress_reads_box_owners():
    """A bound pool box is box-keyed, and a box-keyed box gets no egress login until egress reads `box-owners`: so
    pool and bind are listed in the same build as box-keyed names, never before."""
    from switch_hosted_controller import box_operator

    assert box_operator.POOL_BIND_READY is False and box_operator.BOX_KEYED_EGRESS_READY is False
