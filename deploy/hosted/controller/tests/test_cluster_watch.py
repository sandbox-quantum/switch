"""The operator's cluster report and each box's restarts.

Only names, numbers and fixed words leave. A canary goes in every text field
a node, pod or Deployment has, and must reach neither the report nor the
observation.
"""

import json

import pytest

from switch_hosted_controller.box_scaler import reconcile_once
from switch_hosted_controller.cluster_watch import (
    ClusterWatch,
    NotDeployed,
    RestartCounter,
    ServiceTracker,
    booked_bytes,
    box_node,
    cluster_watch_from_env,
    gate_state,
    held_minutes,
    memory_bytes,
    node_entries,
    restart_counter_from_env,
    services_from_env,
)
from switch_hosted_controller.evictions import EvictionWatch

CANARY = "CANARY-2f9d-do-not-report"
M = "11111111-1111-1111-1111-111111111111"
NS = "agents-user-b"
GIB = 2**30
NOW = 1_793_270_000.0  # 2026-10-29T...Z, a wall-clock second


def node(
    name="ip-10-0-1-7", zone="eu-west-2a", alloc="16Gi", taints=(), annotations=None, ready_at=None
):
    conditions = [
        {
            "type": "Ready",
            "status": "True",
            "lastTransitionTime": ready_at or "2026-10-29T03:00:00Z",
            "message": CANARY,
        }
    ]
    return {
        "metadata": {
            "name": name,
            "labels": {"topology.kubernetes.io/zone": zone, "note": CANARY},
            "annotations": {**(annotations or {}), "comment": CANARY},
        },
        "spec": {"taints": list(taints)},
        "status": {
            "allocatable": {"memory": alloc},
            "conditions": conditions,
            "nodeInfo": {"osImage": CANARY},
        },
    }


def box_pod(node_name="ip-10-0-1-7", request="1Gi", uid="u1", restarts=0, phase="Running"):
    return {
        "metadata": {
            "uid": uid,
            "name": "box-0",
            "labels": {"app": "switch-box"},
            "annotations": {"x": CANARY},
        },
        "spec": {
            "nodeName": node_name,
            "containers": [
                {
                    "name": "agents",
                    "resources": {"requests": {"memory": request}},
                    "env": [{"value": CANARY}],
                }
            ],
        },
        "status": {
            "phase": phase,
            "containerStatuses": [{"restartCount": restarts, "message": CANARY}],
        },
    }


class TestPieces:
    @pytest.mark.parametrize(
        ("quantity", "expected"),
        [
            ("16Gi", 16 * GIB),
            ("512Mi", 512 * 2**20),
            ("1000k", 10**6),
            ("12345", 12345),
            ("1.5Gi", int(1.5 * GIB)),
        ],
    )
    def test_memory_quantities(self, quantity, expected):
        assert memory_bytes(quantity) == expected

    @pytest.mark.parametrize("bad", [None, "", "lots", "1e9", "-1Gi", 7])
    def test_bad_quantities_are_none(self, bad):
        assert memory_bytes(bad) is None

    def test_gate_states(self):
        assert gate_state(node()) == "passed"
        taint = {"key": "switch.dev/gate1", "effect": "NoSchedule"}
        assert gate_state(node(taints=[taint])) == "held"
        assert (
            gate_state(node(taints=[taint], annotations={"switch.dev/gate-result": "fail"}))
            == "failed"
        )

    def test_held_minutes_count_from_ready(self):
        taint = {"key": "switch.dev/gate1"}
        held = node(taints=[taint], ready_at="2026-10-29T11:00:00Z")
        from calendar import timegm
        from time import strptime

        now = timegm(strptime("2026-10-29T11:14:30Z", "%Y-%m-%dT%H:%M:%SZ"))
        assert held_minutes(held, now) == 14
        assert held_minutes(node(ready_at="2026-10-29T11:00:00Z"), now) == 0

    def test_booked_counts_live_box_pods_only(self):
        pods = [
            box_pod(request="1Gi"),
            box_pod(request="2Gi", uid="u2"),
            box_pod(request="4Gi", uid="u3", phase="Succeeded"),
            box_pod(node_name="ip-10-0-1-8", request="1Gi", uid="u4"),
        ]
        assert booked_bytes(pods) == {"ip-10-0-1-7": 3 * GIB, "ip-10-0-1-8": GIB}

    def test_node_entries_are_names_shares_and_fixed_words(self):
        entries = node_entries(
            [node(), node(name=f"Bad {CANARY}"), node(name="ip-10-0-1-9", zone=CANARY)],
            {"ip-10-0-1-7": 14 * GIB},
            {"ip-10-0-1-7": 12 * GIB},
            NOW,
        )
        assert entries == [
            {
                "name": "ip-10-0-1-7",
                "zone": "eu-west-2a",
                "memory_used_pct": 87.5,
                "memory_booked_pct": 75.0,
                "gate": "passed",
                "held_minutes": 0,
            }
        ]

    def test_a_node_uid_is_sent_only_in_kubernetes_form(self):
        good = "3f2b6c1e-8a4d-4e2f-9b1c-0d7e6a5f4c3b"
        nodes = [
            node(),
            node(name="ip-10-0-1-8"),
            node(name="ip-10-0-1-9"),
            node(name="ip-10-0-2-1"),
        ]
        nodes[0]["metadata"]["uid"] = good
        nodes[1]["metadata"]["uid"] = good.upper()
        nodes[2]["metadata"]["uid"] = f"{good}-{CANARY}"
        entries = node_entries(nodes, {}, {}, NOW)
        assert [e.get("uid") for e in entries] == [good, None, None, None]
        assert CANARY not in str(entries)

    def test_unreadable_used_memory_is_null(self):
        [entry] = node_entries([node()], {"ip-10-0-1-7": None}, {}, NOW)
        assert entry["memory_used_pct"] is None
        assert entry["memory_booked_pct"] == 0.0

    def test_a_service_counts_how_long_it_has_been_short(self):
        tracker = ServiceTracker()
        assert tracker.entry("coredns", 2, 2, 100.0)["short_seconds"] == 0
        assert tracker.entry("coredns", 1, 2, 100.0)["short_seconds"] == 0
        assert tracker.entry("coredns", 1, 2, 230.0)["short_seconds"] == 130
        assert tracker.entry("coredns", 2, 2, 240.0)["short_seconds"] == 0
        assert tracker.entry("coredns", 1, 2, 250.0)["short_seconds"] == 0


class FakeKube:
    def __init__(self):
        self.metrics_down = False
        self.missing = set()

    def nodes(self):
        return [node()]

    def node_memory_used(self, name):
        if self.metrics_down:
            raise RuntimeError("metrics-server is restarting")
        return 8 * GIB

    def deployment(self, namespace, name):
        if name in self.missing:
            raise RuntimeError("404")
        return (2, 2) if name in ("coredns", "ebs-csi-controller") else (1, 1)


class FakeCore:
    def __init__(self):
        self.reports = []

    def report_cluster(self, report):
        self.reports.append(report)


SERVICES = services_from_env(
    {
        "SWITCH_CLUSTER_PROXY_NAMESPACE": "egress-proxy",
        "SWITCH_CLUSTER_OPERATOR_NAMESPACE": "switch-hosted",
    }
)


class TestClusterWatch:
    def test_a_report_every_30_seconds_with_the_listed_services(self):
        clock = [0.0]
        core = FakeCore()
        watch = ClusterWatch(
            FakeKube(), core, SERVICES, monotonic=lambda: clock[0], wall=lambda: NOW
        )
        assert watch.tick()
        clock[0] = 10.0
        assert not watch.tick()
        clock[0] = 31.0
        assert watch.tick()
        report = core.reports[0]
        assert [s["name"] for s in report["services"]] == sorted(
            [
                "coredns",
                "ebs-csi-controller",
                "cluster-autoscaler",
                "metrics-server",
                "squid",
                "hosted-controller",
            ]
        )
        assert report["nodes"][0]["memory_used_pct"] == 50.0
        assert CANARY not in json.dumps(core.reports)

    def test_metrics_down_and_a_missing_service_are_reported_not_fatal(self):
        kube, core = FakeKube(), FakeCore()
        kube.metrics_down = True
        kube.missing = {"squid"}
        watch = ClusterWatch(kube, core, SERVICES, monotonic=lambda: 0.0, wall=lambda: NOW)
        assert watch.tick()
        report = core.reports[0]
        assert report["nodes"][0]["memory_used_pct"] is None
        squid = next(s for s in report["services"] if s["name"] == "squid")
        assert (squid["ready"], squid["wanted"]) == (0, 2)

    def test_a_404_on_an_optional_service_leaves_it_out(self):
        class Partial(FakeKube):
            def deployment(self, namespace, name):
                if name in ("cluster-autoscaler", "coredns"):
                    raise NotDeployed(name)
                return super().deployment(namespace, name)

        core = FakeCore()
        ClusterWatch(Partial(), core, SERVICES, monotonic=lambda: 0.0, wall=lambda: NOW).tick()
        names = {s["name"]: s for s in core.reports[0]["services"]}
        # The autoscaler only exists in some clusters: absent, not short.
        assert "cluster-autoscaler" not in names
        # coredns always should: a 404 there is a real problem, reported short.
        assert (names["coredns"]["ready"], names["coredns"]["wanted"]) == (0, 2)

    def test_a_failed_post_never_raises(self):
        class Broken(FakeCore):
            def report_cluster(self, report):
                raise RuntimeError("Core is down")

        assert not ClusterWatch(FakeKube(), Broken(), SERVICES, monotonic=lambda: 0.0).tick()

    def test_off_by_default_and_strict_settings(self):
        assert cluster_watch_from_env(lambda *a, **k: {}, FakeCore(), {}) is None
        with pytest.raises(ValueError):
            cluster_watch_from_env(lambda *a, **k: {}, FakeCore(), {"SWITCH_CLUSTER_REPORT": "yes"})
        with pytest.raises(ValueError):
            cluster_watch_from_env(lambda *a, **k: {}, FakeCore(), {"SWITCH_CLUSTER_REPORT": "on"})
        with pytest.raises(ValueError):
            services_from_env(
                {
                    "SWITCH_CLUSTER_PROXY_NAMESPACE": "Bad NS",
                    "SWITCH_CLUSTER_OPERATOR_NAMESPACE": "switch-hosted",
                }
            )
        with_datadog = services_from_env(
            {
                "SWITCH_CLUSTER_PROXY_NAMESPACE": "egress-proxy",
                "SWITCH_CLUSTER_OPERATOR_NAMESPACE": "switch-hosted",
                "SWITCH_CLUSTER_OPERATOR_DEPLOYMENT": "switch-operator",
                "SWITCH_CLUSTER_DATADOG_NAMESPACE": "datadog",
            }
        )
        assert with_datadog["kube-state-metrics"] == ("datadog", "kube-state-metrics")
        assert with_datadog["hosted-controller"] == ("switch-hosted", "switch-operator")


class TestRestarts:
    def test_the_first_look_is_a_baseline_then_rises_count(self):
        counter = RestartCounter()
        counter.see(M, [box_pod(restarts=5)])
        assert counter.unreported(M) == 0
        counter.see(M, [box_pod(restarts=7)])
        assert counter.unreported(M) == 2
        # Replaced after an eviction: the new pod counts from 0.
        counter.see(M, [box_pod(uid="u2", restarts=1)])
        assert counter.unreported(M) == 3
        counter.reported(M, 3)
        assert counter.unreported(M) == 0

    def test_box_node_is_the_live_pod(self):
        assert (
            box_node([box_pod(phase="Failed"), box_pod(node_name="ip-10-0-1-8")]) == "ip-10-0-1-8"
        )
        assert box_node([box_pod(node_name=f"Bad {CANARY}")]) is None

    def test_off_unless_switched_on(self):
        assert restart_counter_from_env({}) is None
        assert isinstance(
            restart_counter_from_env({"SWITCH_SCALER_REPORT_BOX_FACTS": "1"}), RestartCounter
        )


class ScalerKube:
    def __init__(self, pods):
        self.pods = pods

    def scale(self, ns):
        return 1, 1

    def set_replicas(self, ns, n):
        pass

    def box_pods(self, ns):
        return self.pods

    def events(self, ns):
        return []

    def warn_box(self, ns, reason, message):
        pass


class ScalerCore:
    def __init__(self):
        self.seen = []

    def machines(self):
        return [{"machine_id": M, "desired_state": "running", "revision": 3}]

    def observe(self, machine_id, state, revision, error=None, **extra):
        self.seen.append(extra)


def test_the_observation_carries_restarts_and_node_only_when_switched_on():
    kube = ScalerKube([box_pod(restarts=1)])
    core = ScalerCore()
    watch = EvictionWatch(kube)
    counter = RestartCounter()
    reconcile_once(core, kube, {M: NS}, watch=watch, box_facts=counter)
    kube.pods = [box_pod(restarts=3)]
    reconcile_once(core, kube, {M: NS}, watch=watch, box_facts=counter)
    assert core.seen == [
        {"restarts": 0, "node": "ip-10-0-1-7"},
        {"restarts": 2, "node": "ip-10-0-1-7"},
    ]
    assert counter.unreported(M) == 0
    assert CANARY not in json.dumps(core.seen)
    # Off: nothing extra is sent, so an older Core never sees the fields.
    plain = ScalerCore()
    reconcile_once(plain, kube, {M: NS}, watch=EvictionWatch(kube))
    assert plain.seen == [{}]
