import logging

from switch_hosted_controller.box_scaler import reconcile_once
from switch_hosted_controller.placement import Limits, Node, choose, template_patch
from switch_hosted_controller.placer import (
    PlacementKubeApi,
    Placer,
    make_placer,
    nodes_from_list,
    running_from_pods,
    zone_from_pv,
)

M = "11111111-1111-1111-1111-111111111111"


class FakePlacementKube:
    def __init__(self, nodes, running=None, zones=None, fail=False):
        self._nodes, self._running, self._zones, self._fail = (
            nodes,
            running or {},
            zones or {},
            fail,
        )
        self.patches = []

    def nodes(self):
        if self._fail:
            raise RuntimeError("api down")
        return self._nodes

    def running_boxes(self):
        return dict(self._running)

    def home_zone(self, namespace):
        return self._zones.get(namespace)

    def patch_template(self, namespace, patch):
        self.patches.append((namespace, patch))


def first_choice(patch):
    terms = patch["spec"]["template"]["spec"]["affinity"]["nodeAffinity"][
        "preferredDuringSchedulingIgnoredDuringExecution"
    ]
    return terms[0]["preference"]["matchExpressions"][0]["values"][0]


def test_placer_writes_the_emptiest_machine_in_the_home_zone_and_logs_ids_and_counts(caplog):
    kube = FakePlacementKube(
        [Node("a1", "a"), Node("a2", "a"), Node("b1", "b")],
        running={"agents-user-x": "a1", "agents-user-y": "a1"},
        zones={"agents-user-c": "a"},
    )
    with caplog.at_level(logging.INFO):
        Placer(kube, Limits(7, 12)).place("agents-user-c")
    assert [(ns, first_choice(p)) for ns, p in kube.patches] == [("agents-user-c", "a2")]
    line = [r.getMessage() for r in caplog.records if r.getMessage().startswith("Box placed")][0]
    assert "machine=a2" in line and "reason=below_target" in line and "zone=a" in line


def test_a_burst_of_starts_spreads_through_the_ledger():
    kube = FakePlacementKube(
        [Node("a1", "a"), Node("a2", "a")], zones={f"agents-user-{i}": "a" for i in range(4)}
    )
    placer = Placer(kube)
    for i in range(4):
        placer.place(f"agents-user-{i}")
    chosen = [first_choice(p) for _, p in kube.patches]
    assert chosen.count("a1") == 2 and chosen.count("a2") == 2


def test_a_placer_failure_never_stops_the_start(caplog):
    kube = FakePlacementKube([], fail=True)
    with caplog.at_level(logging.WARNING):
        Placer(kube).place("agents-user-c")
    assert kube.patches == []
    assert any("not placed (RuntimeError)" in r.getMessage() for r in caplog.records)


class FakeKube:
    def __init__(self, replicas=0, ready=0):
        self.replicas, self.ready, self.calls = replicas, ready, []

    def scale(self, ns):
        return self.replicas, self.ready

    def set_replicas(self, ns, n):
        self.calls.append(("scale", ns, n))
        self.replicas = n


class FakeCore:
    def __init__(self, desired):
        self.desired, self.seen = desired, []

    def machines(self):
        return [{"machine_id": M, "desired_state": self.desired, "revision": 1}]

    def observe(self, machine_id, state, revision, error=None):
        self.seen.append(state)


def test_the_scaler_places_a_stopped_box_just_before_starting_it_and_never_a_running_one():
    order = []
    kube = FakeKube(0, 0)
    kube.set_replicas = lambda ns, n: order.append(("scale", ns, n))
    reconcile_once(
        FakeCore("running"),
        kube,
        {M: "agents-user-b"},
        place=lambda ns: order.append(("place", ns)),
    )
    assert order == [("place", "agents-user-b"), ("scale", "agents-user-b", 1)]
    # Already running, or stopping: no placement call (a template change would restart a running pod).
    order.clear()
    reconcile_once(
        FakeCore("running"), FakeKube(1, 1), {M: "agents-user-b"}, place=lambda ns: order.append(ns)
    )
    reconcile_once(
        FakeCore("stopped"), FakeKube(1, 1), {M: "agents-user-b"}, place=lambda ns: order.append(ns)
    )
    assert order == []


def test_the_scaler_without_a_placer_is_unchanged():
    kube = FakeKube(0, 0)
    reconcile_once(FakeCore("running"), kube, {M: "agents-user-b"})
    assert kube.calls == [("scale", "agents-user-b", 1)]


# --- reading the cluster ------------------------------------------------------------------------------------------


def test_nodes_are_read_with_readiness_cordon_taints_and_zone():
    items = [
        {
            "metadata": {"name": "m1", "labels": {"topology.kubernetes.io/zone": "a"}},
            "spec": {"taints": [{"key": "switch.dev/gate1", "effect": "NoSchedule"}]},
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        },
        {
            "metadata": {"name": "m2", "labels": {"topology.kubernetes.io/zone": "b"}},
            "spec": {"unschedulable": True},
            "status": {"conditions": [{"type": "Ready", "status": "False"}]},
        },
        {"metadata": {"name": "no-zone", "labels": {}}, "spec": {}, "status": {}},
    ]
    m1, m2 = nodes_from_list(items)
    assert (m1.name, m1.zone, m1.ready, m1.candidate) == ("m1", "a", True, False)  # gate-1 tainted
    assert (m2.ready, m2.schedulable, m2.candidate) == (False, False, False)


def test_running_boxes_skip_unscheduled_finished_and_terminating_pods():
    items = [
        {
            "metadata": {"namespace": "agents-user-a"},
            "spec": {"nodeName": "m1"},
            "status": {"phase": "Running"},
        },
        {"metadata": {"namespace": "agents-user-b"}, "spec": {}, "status": {"phase": "Pending"}},
        {
            "metadata": {"namespace": "agents-user-c", "deletionTimestamp": "x"},
            "spec": {"nodeName": "m1"},
            "status": {},
        },
        {
            "metadata": {"namespace": "agents-user-d"},
            "spec": {"nodeName": "m2"},
            "status": {"phase": "Failed"},
        },
    ]
    assert running_from_pods(items) == {"agents-user-a": "m1"}


def test_the_disk_zone_is_read_from_the_volumes_node_affinity():
    pv = {
        "spec": {
            "nodeAffinity": {
                "required": {
                    "nodeSelectorTerms": [
                        {
                            "matchExpressions": [
                                {"key": "topology.ebs.csi.aws.com/zone", "values": ["eu-west-3b"]}
                            ]
                        }
                    ]
                }
            }
        }
    }
    assert zone_from_pv(pv) == "eu-west-3b"
    assert zone_from_pv({"spec": {}}) is None


# --- edge cases -----------------------------------------------------------------------------


class CountingKube(FakePlacementKube):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.lists = 0

    def nodes(self):
        self.lists += 1
        return super().nodes()


def test_a_burst_in_one_pass_reads_nodes_and_pods_once():
    now = [100.0]
    kube = CountingKube(
        [Node("a1", "a"), Node("a2", "a")], zones={f"agents-user-{i}": "a" for i in range(5)}
    )
    placer = Placer(kube, clock=lambda: now[0])
    for i in range(4):
        placer.place(f"agents-user-{i}")
    assert kube.lists == 1
    now[0] += 6  # the next scaler pass reads afresh
    placer.place("agents-user-4")
    assert kube.lists == 2


def test_a_placer_that_raises_still_cannot_stop_the_start(caplog):
    def broken(namespace):
        raise RuntimeError("boom")

    kube = FakeKube(0, 0)
    with caplog.at_level(logging.WARNING):
        reconcile_once(FakeCore("running"), kube, {M: "agents-user-b"}, place=broken)
    assert kube.calls == [("scale", "agents-user-b", 1)]
    assert any("placement failed (RuntimeError)" in r.getMessage() for r in caplog.records)


def test_only_user_box_namespaces_are_placed_or_called():
    kube = FakePlacementKube([Node("a1", "a")])
    Placer(kube).place("kube-system")
    assert kube.patches == []
    api = PlacementKubeApi(lambda *a, **kw: {})
    for bad in ("kube-system", "agents-user-a/../x", "agents-user-A"):
        try:
            api.home_zone(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"{bad!r} was not refused")


def test_every_placer_call_uses_a_short_timeout():
    seen = []
    api = PlacementKubeApi(
        lambda method, path, body=None, timeout=None: seen.append(timeout) or {"items": []}
    )
    api.nodes()
    api.running_boxes()
    api.home_zone("agents-user-a")
    api.patch_template("agents-user-a", {})
    assert seen and all(t is not None and t <= 5 for t in seen)


def merge_patch(target, patch):
    """RFC 7386 JSON merge patch, as the API server applies `application/merge-patch+json`."""
    if not isinstance(patch, dict):
        return patch
    out = dict(target) if isinstance(target, dict) else {}
    for key, value in patch.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = merge_patch(out.get(key), value)
    return out


def test_the_merge_patch_keeps_the_templates_pod_anti_affinity():
    anti = {
        "preferredDuringSchedulingIgnoredDuringExecution": [
            {"weight": 100, "podAffinityTerm": {"topologyKey": "h"}}
        ]
    }
    sts = {
        "spec": {
            "replicas": 0,
            "template": {
                "spec": {"runtimeClassName": "gvisor", "affinity": {"podAntiAffinity": anti}}
            },
        }
    }
    d = choose([Node("a1", "a")], {}, Limits(), "a")
    after = merge_patch(sts, template_patch(d, first_start=False))
    affinity = after["spec"]["template"]["spec"]["affinity"]
    assert affinity["podAntiAffinity"] == anti
    assert "nodeAffinity" in affinity
    assert (
        after["spec"]["template"]["spec"]["runtimeClassName"] == "gvisor"
        and after["spec"]["replicas"] == 0
    )


def test_placement_is_off_unless_switched_on():
    assert make_placer(lambda *a, **kw: {}) is None
    assert callable(make_placer(lambda *a, **kw: {}, enabled=True))
