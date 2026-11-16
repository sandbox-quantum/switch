"""The operator's side of a box restart: fakes for Kubernetes and Core, no network."""

from __future__ import annotations

from io import BytesIO
from urllib.error import HTTPError

import pytest

from switch_hosted_controller import restart_actions as ra

MID = "7a3e8f4c-1d2b-4c5e-9f60-718293a4b5c6"
AID = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f"
NS = "agents-user-u1"
IMG = "registry.example/box@sha256:" + "a" * 64
T0 = 1_800_000_000.0  # "now" in the tests


def stamp(t: float) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def pod(uid: str, created: float, ready: bool, image: str = IMG, deleting: bool = False) -> dict:
    meta = {"uid": uid, "creationTimestamp": stamp(created)}
    if deleting:
        meta["deletionTimestamp"] = stamp(created + 1)
    return {
        "metadata": meta,
        "spec": {"containers": [{"name": "box", "image": image}]},
        "status": {"conditions": [{"type": "Ready", "status": "True" if ready else "False"}]},
    }


class FakeKube:
    def __init__(self, current=None, refuse: int | None = None):
        self.current = current
        self.deletes: list[str] = []
        self.uids: list[str | None] = []
        self.refuse = refuse

    def box_pod(self, namespace):
        assert namespace == NS
        return self.current

    def delete_box_pod(self, namespace, uid=None):
        assert namespace == NS
        self.uids.append(uid)
        if self.refuse:
            raise HTTPError("u", self.refuse, "no", {}, BytesIO(b""))
        self.deletes.append(namespace)
        self.current = None


class FakeCore:
    def __init__(self, actions, refuse_steps=()):
        self.actions = actions
        self.steps: list[tuple[str, str, str]] = []
        self.refuse_steps = set(refuse_steps)

    def open_actions(self):
        return self.actions

    def step(self, action_id, step, state):
        if step in self.refuse_steps:
            raise ra.StepRefused()
        self.steps.append((action_id, step, state))
        for a in self.actions:
            if a["action_id"] == action_id and state == "running":
                a["step"] = step
        if state in ("done", "failed"):
            self.actions = [a for a in self.actions if a["action_id"] != action_id]


def action(step=None, requested=T0 - 10, expires=T0 + 590, machine=MID, kind="restart"):
    return {
        "action_id": AID,
        "kind": kind,
        "target": {"machine_id": machine},
        "requested_at": stamp(requested),
        "expires_at": stamp(expires),
        "step": step,
    }


def worker(kube, core, now=T0, boxes=None):
    clock = {"t": now}
    w = ra.RestartWorker(
        kube, core, boxes if boxes is not None else {MID: NS}, clock=lambda: clock["t"]
    )
    return w, clock


def test_a_restart_claims_deletes_once_and_finishes_when_the_new_pod_is_ready():
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action()])
    w, clock = worker(kube, core)
    w.tick()
    assert core.steps == [(AID, "claimed", "running"), (AID, "pod_deleted", "running")]
    assert kube.deletes == [NS]
    kube.current = pod("new", T0 + 5, False)
    clock["t"] = T0 + 10
    w.tick()
    assert core.steps[-1] == (AID, "pod_deleted", "running")  # not ready yet: nothing new
    kube.current = pod("new", T0 + 5, True)
    clock["t"] = T0 + 30
    w.tick()
    assert core.steps[-1] == (AID, "box_ready", "done")
    assert kube.deletes == [NS]  # exactly one delete


def test_a_machine_not_in_the_box_map_fails_with_box_not_found_and_touches_nothing():
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action(machine="1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9")])
    w, _ = worker(kube, core)
    w.tick()
    assert core.steps == [(AID, "claimed", "running"), (AID, "box_not_found", "failed")]
    assert kube.deletes == []


def test_a_name_from_core_is_never_used_only_the_box_map():
    kube = FakeKube(pod("old", T0 - 3600, True))
    bad = action()
    bad["target"] = {"machine_id": MID, "namespace": "kube-system", "pod": "coredns"}
    core = FakeCore([bad])
    w, _ = worker(kube, core)
    w.tick()
    assert kube.deletes == [NS]


def test_a_box_map_entry_that_isnt_a_box_namespace_is_refused():
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action()])
    w, _ = worker(kube, core, boxes={MID: "kube-system"})
    w.tick()
    assert core.steps[-1] == (AID, "box_not_found", "failed")
    assert kube.deletes == []


def test_a_refused_delete_reports_delete_refused():
    kube = FakeKube(pod("old", T0 - 3600, True), refuse=403)
    core = FakeCore([action()])
    w, _ = worker(kube, core)
    w.tick()
    assert core.steps[-1] == (AID, "delete_refused", "failed")


def test_a_pod_already_gone_counts_as_deleted():
    kube = FakeKube(pod("old", T0 - 3600, True), refuse=404)
    core = FakeCore([action()])
    w, _ = worker(kube, core)
    w.tick()
    assert core.steps[-1] == (AID, "pod_deleted", "running")


def test_not_ready_within_five_minutes_fails_with_not_ready_in_time():
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action()])
    w, clock = worker(kube, core)
    w.tick()
    kube.current = pod("new", T0 + 5, False)
    clock["t"] = T0 + ra.READY_WITHIN_S + 1
    w.tick()
    assert core.steps[-1] == (AID, "not_ready_in_time", "failed")


def test_the_ready_wait_never_runs_past_the_actions_expiry():
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action(expires=T0 + 60)])
    w, clock = worker(kube, core)
    w.tick()
    kube.current = pod("new", T0 + 5, False)
    clock["t"] = T0 + 61
    w.tick()
    assert core.steps[-1] == (AID, "not_ready_in_time", "failed")


def test_after_a_worker_restart_at_pod_deleted_it_only_waits_and_never_deletes_again():
    kube = FakeKube(pod("new", T0 + 5, False))
    core = FakeCore([action(step="pod_deleted")])
    w, clock = worker(kube, core)
    w.tick()
    assert kube.deletes == []
    kube.current = pod("new", T0 + 5, True)
    clock["t"] = T0 + 40
    w.tick()
    assert kube.deletes == []
    assert core.steps[-1] == (AID, "box_ready", "done")


def test_after_a_crash_between_delete_and_report_it_doesnt_delete_twice():
    # The pod was created after the action was requested: an earlier run already deleted it.
    kube = FakeKube(pod("new", T0 - 5, True))
    core = FakeCore([action(step="claimed", requested=T0 - 10)])
    w, _ = worker(kube, core)
    w.tick()
    assert kube.deletes == []
    assert core.steps[-1] == (AID, "pod_deleted", "running")


def test_a_pod_still_terminating_isnt_counted_as_back():
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action()])
    w, clock = worker(kube, core)
    w.tick()
    kube.current = pod("new", T0 + 5, True, deleting=True)
    clock["t"] = T0 + 20
    w.tick()
    assert core.steps[-1] == (AID, "pod_deleted", "running")


def test_a_different_image_after_the_restart_isnt_counted_as_back():
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action()])
    w, clock = worker(kube, core)
    w.tick()
    kube.current = pod("new", T0 + 5, True, image="registry.example/box@sha256:" + "b" * 64)
    clock["t"] = T0 + 20
    w.tick()
    assert core.steps[-1] == (AID, "pod_deleted", "running")


def test_a_claim_lost_to_another_worker_leaves_the_action_alone():
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action()], refuse_steps={"claimed"})
    w, _ = worker(kube, core)
    w.tick()
    assert core.steps == []
    assert kube.deletes == []


def test_other_kinds_and_bad_ids_are_ignored():
    kube = FakeKube(pod("old", T0 - 3600, True))
    bad_id = action()
    bad_id["action_id"] = "not-a-uuid"
    core = FakeCore([action(kind="drain"), bad_id])
    w, _ = worker(kube, core)
    w.tick()
    assert core.steps == []
    assert kube.deletes == []


def test_a_failure_listing_actions_never_stops_the_loop():
    class Broken(FakeCore):
        def open_actions(self):
            raise RuntimeError("down")

    w, _ = worker(FakeKube(), Broken([]))
    w.tick()  # no exception


def test_the_kube_client_refuses_a_namespace_that_isnt_a_box():
    api = ra.RestartKubeApi.__new__(ra.RestartKubeApi)
    with pytest.raises(ValueError):
        api._path("kube-system")
    assert api._path(NS) == f"/api/v1/namespaces/{NS}/pods/box-0"


def test_the_core_client_sends_codes_only_to_a_uuid_path(monkeypatch):
    sent = []
    api = ra.RestartCoreApi.__new__(ra.RestartCoreApi)
    monkeypatch.setattr(api, "_call", lambda path, body=None: sent.append((path, body)))
    api.step(AID, "claimed", "running")
    assert sent == [(f"/actions/{AID}/steps", {"step": "claimed", "state": "running"})]
    with pytest.raises(ValueError):
        api.step("../x", "claimed", "running")


def test_the_delete_carries_the_uid_of_the_pod_it_looked_at():
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action()])
    w, _ = worker(kube, core)
    w.tick()
    assert kube.uids == ["old"]


def test_a_pod_replaced_between_the_read_and_the_delete_counts_as_restarted():
    kube = FakeKube(pod("old", T0 - 3600, True), refuse=409)
    core = FakeCore([action()])
    w, _ = worker(kube, core)
    w.tick()
    assert core.steps[-1] == (AID, "pod_deleted", "running")


def test_the_kube_client_sends_the_uid_precondition(monkeypatch):
    sent = []
    api = ra.RestartKubeApi.__new__(ra.RestartKubeApi)
    monkeypatch.setattr(
        api, "_call", lambda method, path, body=None: sent.append((method, path, body)) or {}
    )
    api.delete_box_pod(NS, "u-1")
    assert sent == [
        (
            "DELETE",
            f"/api/v1/namespaces/{NS}/pods/box-0",
            {"kind": "DeleteOptions", "apiVersion": "v1", "preconditions": {"uid": "u-1"}},
        )
    ]


def test_redirects_are_refused_so_the_bearer_never_follows_one():
    handler = ra._NoRedirect()
    assert (
        handler.redirect_request(None, None, 302, "Found", {}, "https://elsewhere.example/") is None
    )


def test_logs_name_the_machine_not_the_namespace(caplog):
    import logging

    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action()])
    w, _ = worker(kube, core)
    with caplog.at_level(logging.INFO):
        w.tick()
    assert NS not in caplog.text
    assert MID in caplog.text


def test_after_a_worker_restart_a_pod_older_than_the_request_isnt_counted_as_back():
    # Resuming at pod_deleted, a pod that never went away must not pass.
    kube = FakeKube(pod("old", T0 - 3600, True))
    core = FakeCore([action(step="pod_deleted", requested=T0 - 10)])
    w, clock = worker(kube, core)
    w.tick()
    assert core.steps == []
    kube.current = pod("new", T0 + 5, True)
    clock["t"] = T0 + 20
    w.tick()
    assert core.steps[-1] == (AID, "box_ready", "done")
    assert kube.deletes == []


def test_a_pod_already_newer_than_the_request_is_logged_on_its_own_line(caplog):
    # No delete by us is said plainly in the log.
    import logging

    kube = FakeKube(pod("new", T0 - 5, True))
    core = FakeCore([action(requested=T0 - 10)])
    w, _ = worker(kube, core)
    with caplog.at_level(logging.INFO):
        w.tick()
    assert kube.deletes == []
    assert "no delete by this run" in caplog.text
