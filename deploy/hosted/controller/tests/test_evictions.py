import json
import logging

from switch_hosted_controller.box_scaler import reconcile_once, write_status
from switch_hosted_controller.evictions import (
    EVICTION_API,
    NODE_LOST,
    NODE_PRESSURE,
    NODE_SHUTDOWN,
    OTHER,
    PREEMPTED,
    REMEMBER_S,
    TAINT_EVICTION,
    EvictionWatch,
    from_event,
    from_pod,
    status_document,
    watch_from_env,
)

M = "11111111-1111-1111-1111-111111111111"
NS = "agents-user-b"
BOXES = {M: NS}


def pod(uid="u1", name="box-0", node="ip-10-0-2-107", conditions=(), reason=None, app="switch-box"):
    status = {"conditions": list(conditions)}
    if reason:
        status["reason"] = reason
    return {
        "metadata": {"uid": uid, "name": name, "labels": {"app": app}},
        "spec": {"nodeName": node},
        "status": status,
    }


def disruption(reason):
    return {"type": "DisruptionTarget", "status": "True", "reason": reason}


def event(reason, uid="u1", name="box-0", kind="Pod", host="ip-10-0-2-96"):
    return {
        "reason": reason,
        "involvedObject": {"kind": kind, "uid": uid, "name": name},
        "source": {"host": host},
        "message": "The node was low on resource: memory. secret-looking text",
    }


class FakeKube:
    def __init__(self, pods=(), events=()):
        self.pods, self.evs, self.warned = list(pods), list(events), []
        self.replicas, self.ready, self.calls = 1, 1, []

    def scale(self, ns):
        return self.replicas, self.ready

    def set_replicas(self, ns, n):
        self.calls.append((ns, n))

    def box_pods(self, ns):
        return self.pods

    def events(self, ns):
        return self.evs

    def warn_box(self, ns, reason, message):
        self.warned.append((ns, reason, message))


class FakeCore:
    def __init__(self):
        self.seen = []

    def machines(self):
        return [{"machine_id": M, "desired_state": "running", "revision": 3}]

    def observe(self, machine_id, state, revision, error=None, **extra):
        self.seen.append((machine_id, state, revision, extra))


def test_each_disruption_reason_on_the_pod_maps_to_a_fixed_code():
    table = {
        "PreemptionByScheduler": PREEMPTED,
        "PreemptionByKubeScheduler": PREEMPTED,
        "DeletionByTaintManager": TAINT_EVICTION,
        "EvictionByEvictionAPI": EVICTION_API,
        "DeletionByPodGC": NODE_LOST,
        "TerminationByKubelet": NODE_PRESSURE,
        "SomethingNew": OTHER,
    }
    for condition, code in table.items():
        assert from_pod(pod(conditions=[disruption(condition)])).reason == code


def test_kubelet_status_reasons_node_pressure_and_shutdown():
    assert from_pod(pod(reason="Evicted")).reason == NODE_PRESSURE
    assert from_pod(pod(reason="Terminated")).reason == NODE_SHUTDOWN
    assert from_pod(pod(reason="Preempting")).reason == PREEMPTED


def test_a_healthy_pod_another_app_or_a_false_condition_is_no_eviction():
    assert from_pod(pod()) is None
    assert from_pod(pod(app="placeholder", reason="Evicted")) is None
    false = {"type": "DisruptionTarget", "status": "False", "reason": "EvictionByEvictionAPI"}
    assert from_pod(pod(conditions=[false])) is None


def test_events_name_the_box_pod_only():
    names = {"box-0"}
    assert from_event(event("Evicted"), names).reason == NODE_PRESSURE
    assert from_event(event("Preempted"), names).reason == PREEMPTED
    assert from_event(event("TaintManagerEviction"), names).reason == TAINT_EVICTION
    assert from_event(event("Evicted", name="placeholder-x"), names) is None
    assert from_event(event("Evicted", kind="Node"), names) is None
    assert from_event(event("Scheduled"), names) is None


def test_a_name_with_odd_characters_is_never_trusted():
    assert from_pod(pod(name="box-0\nINJECTED", reason="Evicted")) is None


def test_one_alert_per_pod_whichever_source_saw_it_with_a_warn_event_and_a_count(caplog):
    kube = FakeKube(pods=[pod(reason="Evicted")], events=[event("Evicted")])
    watch = EvictionWatch(kube)
    with caplog.at_level(logging.WARNING):
        assert len(watch.check(M, NS)) == 1
        assert watch.check(M, NS) == []  # seen already
    assert watch.counts() == {M: 1}
    assert kube.warned == [
        (
            NS,
            "BoxPushedOff",
            "The box was pushed off its machine (node_pressure); it restarts elsewhere.",
        )
    ]
    lines = [r.getMessage() for r in caplog.records if "pushed off" in r.getMessage()]
    assert lines == [
        f"Machine {M}: box {NS}/box-0 was pushed off machine ip-10-0-2-107 (node_pressure); evictions since start: 1."
    ]
    # Nothing from the cluster's own message text is ever logged.
    assert not any("secret-looking" in r.getMessage() for r in caplog.records)


def test_an_event_for_a_pod_already_replaced_is_still_alerted_once():
    # The StatefulSet replaced the evicted pod at once: only the event remains, with the old uid.
    kube = FakeKube(pods=[pod(uid="new")], events=[event("Evicted", uid="old")])
    watch = EvictionWatch(kube)
    assert [e.pod_uid for e in watch.check(M, NS)] == ["old"]
    kube.pods = [pod(uid="newer", conditions=[disruption("EvictionByEvictionAPI")])]
    assert [e.reason for e in watch.check(M, NS)] == [EVICTION_API]
    assert watch.counts() == {M: 2}


def test_a_failing_look_or_event_write_never_stops_the_scaler(caplog):
    class Broken(FakeKube):
        def box_pods(self, ns):
            raise RuntimeError("forbidden")

    assert EvictionWatch(Broken()).check(M, NS) == []

    class NoEvents(FakeKube):
        def warn_box(self, ns, reason, message):
            raise RuntimeError("forbidden")

    watch = EvictionWatch(NoEvents(pods=[pod(reason="Evicted")]))
    assert len(watch.check(M, NS)) == 1 and watch.counts() == {M: 1}


def test_pods_are_forgotten_after_two_hours():
    clock = [0.0]
    kube = FakeKube(pods=[pod(reason="Evicted")])
    watch = EvictionWatch(kube, now=lambda: clock[0])
    watch.check(M, NS)
    clock[0] = REMEMBER_S + 1
    kube.pods = []
    watch.check(M, NS)
    assert watch._seen == {}


def test_the_count_goes_to_core_only_when_set_to_report_it():
    kube, core = FakeKube(pods=[pod(reason="Evicted")]), FakeCore()
    reconcile_once(core, kube, BOXES, watch=watch_from_env(kube, {}))
    assert core.seen == [(M, "running", 3, {})]
    kube2, core2 = FakeKube(pods=[pod(reason="Evicted")]), FakeCore()
    reconcile_once(
        core2, kube2, BOXES, watch=watch_from_env(kube2, {"SWITCH_SCALER_REPORT_EVICTIONS": "1"})
    )
    assert core2.seen == [(M, "running", 3, {"evictions": 1})]
    assert watch_from_env(kube2, {}).report_to_core is False


def test_status_file_holds_counts_only_and_is_owner_only(tmp_path):
    kube = FakeKube(pods=[pod(reason="Evicted")])
    watch = EvictionWatch(kube)
    watch.check(M, NS)
    path = tmp_path / "status.json"
    write_status(path, status_document(watch, BOXES.keys()))
    assert json.loads(path.read_text()) == {"version": 1, "evictions": {M: 1}}
    assert path.stat().st_mode & 0o777 == 0o600


def test_core_gets_the_count_since_its_last_accepted_observation_and_a_refusal_keeps_it():
    kube, core = FakeKube(pods=[pod(reason="Evicted")]), FakeCore()
    watch = watch_from_env(kube, {"SWITCH_SCALER_REPORT_EVICTIONS": "1"})
    reconcile_once(core, kube, BOXES, watch=watch)
    reconcile_once(core, kube, BOXES, watch=watch)  # nothing new: 0, not a running total
    assert [extra for *_, extra in core.seen] == [{"evictions": 1}, {"evictions": 0}]

    class Refusing(FakeCore):
        def observe(self, *args, **extra):
            raise RuntimeError("Core call failed")

    kube.pods = [pod(uid="u2", reason="Evicted")]
    try:
        reconcile_once(Refusing(), kube, BOXES, watch=watch)
    except RuntimeError:
        pass
    # Refused: still owed, and carried by the next accepted observation.
    assert watch.unreported(M) == 1
    reconcile_once(core, kube, BOXES, watch=watch)
    assert core.seen[-1][-1] == {"evictions": 1}
    assert watch.unreported(M) == 0 and watch.counts() == {M: 2}


def test_unreadable_events_still_leave_the_pods_own_reason(caplog):
    """With no right to list events in a box namespace, the pod read by name
    still catches the eviction, and one WARN per box says the events weren't read."""

    class NoEventRight(FakeKube):
        def events(self, ns):
            raise RuntimeError("forbidden")

    kube = NoEventRight(pods=[pod(conditions=[disruption("EvictionByEvictionAPI")])])
    watch = EvictionWatch(kube)
    with caplog.at_level("WARNING"):
        assert [e.reason for e in watch.check(M, NS)] == [EVICTION_API]
        watch.check(M, NS)
    assert sum("could not read box events" in r.getMessage() for r in caplog.records) == 1


def test_the_kube_api_reads_box_0_by_name_and_never_lists_pods():
    """`get` on the one pod name is the only right the read needs."""
    from io import BytesIO
    from urllib.error import HTTPError

    from switch_hosted_controller.box_scaler import KubeApi

    api = KubeApi.__new__(KubeApi)
    seen = []

    def call(method, path, body=None, timeout=20):
        seen.append((method, path))
        if path.endswith("agents-user-gone/pods/box-0"):
            raise HTTPError(path, 404, "Not Found", {}, BytesIO(b""))
        return {"metadata": {"name": "box-0", "uid": "u1"}}

    api._call = call
    assert api.box_pods("agents-user-b") == [{"metadata": {"name": "box-0", "uid": "u1"}}]
    assert api.box_pods("agents-user-gone") == []
    assert seen == [
        ("GET", "/api/v1/namespaces/agents-user-b/pods/box-0"),
        ("GET", "/api/v1/namespaces/agents-user-gone/pods/box-0"),
    ]
    import pytest

    with pytest.raises(ValueError):
        api.box_pods("kube-system")


def test_events_and_the_warning_name_a_user_box_namespace_only():
    """Every call the eviction watch makes names a user box
    namespace, checked before anything is sent."""
    import pytest

    from switch_hosted_controller.box_scaler import KubeApi

    api = KubeApi.__new__(KubeApi)
    seen = []

    def call(method, path, body=None, timeout=20):
        seen.append((method, path))
        return {"items": []}

    api._call = call
    assert api.events("agents-user-b") == []
    api.warn_box("agents-user-b", "BoxPushedOff", "fixed text")
    for namespace in ("kube-system", "agents-user-b/../kube-system", "agents-user-B", ""):
        with pytest.raises(ValueError):
            api.events(namespace)
        with pytest.raises(ValueError):
            api.warn_box(namespace, "BoxPushedOff", "fixed text")
    assert [m for m, _ in seen] == ["GET", "POST"]
    assert all(p.startswith("/api/v1/namespaces/agents-user-b/") for _, p in seen)
