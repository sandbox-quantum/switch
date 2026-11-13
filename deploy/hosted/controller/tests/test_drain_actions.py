"""The operator's side of a drain: a fake cluster and a fake Core, no network.

The must-pass cases: a node uid mismatch at claim and before every later
step and write fails with `node_replaced` and touches nothing more; a node with no uid is refused; the cordon carries
the node uid as a precondition; a paused or turned-off box is never evicted, and counts as moved only once its pod is
gone; the worker acts only on box-map namespaces.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from io import BytesIO
from urllib.error import HTTPError

import pytest

from switch_hosted_controller import drain_actions as da
from switch_hosted_controller.box_scaler import decide
from switch_hosted_controller.placement import Limits

AID = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f"
AID2 = "1f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f"
N1, N2, N3 = (
    "ip-10-0-2-86.marker.internal",
    "ip-10-0-2-87.eu-west-3.compute.internal",
    "ip-10-0-5-1.eu-west-3.compute.internal",
)
U1, U2, U3 = (f"{c * 8}-1111-4111-8111-{c * 12}" for c in "abc")
UNEW = "dddddddd-1111-4111-8111-dddddddddddd"
IMAGE = "registry.example/pause@sha256:" + "e" * 64
T0 = 1_800_000_000.0


def stamp(t: float) -> str:
    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def http_error(code: int) -> HTTPError:
    return HTTPError("https://kube.example/x", code, "refused", {}, BytesIO(b""))  # type: ignore[arg-type]


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def __call__(self) -> float:
        return self.now


class Cluster:
    """Nodes, box pods and the drain room, with the API server's preconditions."""

    def __init__(self, clock: Clock):
        self.clock = clock
        self.nodes: dict[str, dict] = {}
        self.pods: dict[str, dict | None] = {}
        self.placeholders: dict[str, dict] = {}
        self.writes: list[tuple] = []
        self.reads: list[str] = []
        self.cordon_error: int | None = None
        self.evict_error: int | None = None
        self._n = 0

    def add_node(
        self,
        name,
        uid,
        zone="eu-west-3a",
        pool="agents",
        ready=True,
        unschedulable=False,
        taints=(),
    ):
        self.nodes[name] = {
            "uid": uid,
            "zone": zone,
            "pool": pool,
            "ready": ready,
            "unschedulable": unschedulable,
            "taints": list(taints),
        }

    def add_pod(self, namespace, node, ready=True, created=None):
        self._n += 1
        self.pods[namespace] = {
            "uid": f"{self._n:08x}-2222-4222-8222-{self._n:012x}",
            "node": node,
            "ready": ready,
            "created": T0 - 3600 if created is None else created,
            "deleting": False,
        }

    def settle(self, namespace, to):
        """Finish an eviction: the StatefulSet's new pod on `to`, Ready (or no pod, when `to` is None)."""
        if to is None:
            self.pods[namespace] = None
        else:
            self.add_pod(namespace, to, created=self.clock.now)

    # the Kube protocol
    def node(self, name):
        self.reads.append(name)
        n = self.nodes.get(name)
        if n is None:
            return None
        meta = {
            "name": name,
            "labels": {"switch.dev/pool": n["pool"], "topology.kubernetes.io/zone": n["zone"]},
        }
        if n["uid"] is not None:
            meta["uid"] = n["uid"]
        return {
            "metadata": meta,
            "spec": {
                "unschedulable": n["unschedulable"],
                "taints": [{"key": k} for k in n["taints"]],
            },
            "status": {
                "conditions": [{"type": "Ready", "status": "True" if n["ready"] else "False"}]
            },
        }

    def nodes_list(self):
        return [self.node(name) for name, n in self.nodes.items() if n["pool"] == "agents"]

    def cordon(self, name, uid):
        self.writes.append(("cordon", name, uid))
        if self.cordon_error:
            raise http_error(self.cordon_error)
        if self.nodes[name]["uid"] != uid:
            raise http_error(409)
        self.nodes[name]["unschedulable"] = True

    def box_pod(self, namespace):
        p = self.pods.get(namespace)
        if p is None:
            return None
        meta = {"uid": p["uid"], "creationTimestamp": stamp(p["created"])}
        if p["deleting"]:
            meta["deletionTimestamp"] = stamp(self.clock.now)
        return {
            "metadata": meta,
            "spec": {
                "nodeName": p["node"],
                "containers": [{"name": "agents", "image": "box@sha256:" + "a" * 64}],
            },
            "status": {
                "conditions": [{"type": "Ready", "status": "True" if p["ready"] else "False"}]
            },
        }

    def evict(self, namespace, pod_uid):
        self.writes.append(("evict", namespace, pod_uid))
        if self.evict_error:
            raise http_error(self.evict_error)
        p = self.pods.get(namespace)
        if p is None:
            raise http_error(404)
        if p["uid"] != pod_uid:
            raise http_error(409)
        p["deleting"] = True

    def placeholder(self, name):
        return self.placeholders.get(name)

    def create_placeholder(self, body):
        self.writes.append(("placeholder", body["metadata"]["name"]))
        if body["metadata"]["name"] in self.placeholders:
            raise http_error(409)
        self.placeholders[body["metadata"]["name"]] = body

    def delete_placeholder(self, name):
        self.writes.append(("delete_placeholder", name))
        self.placeholders.pop(name)


class KubeView:
    """The cluster as the worker's `Kube`: `nodes` is the pool's list."""

    def __init__(self, cluster: Cluster):
        self.c = cluster

    def __getattr__(self, name):
        return getattr(self.c, name)

    def nodes(self):
        return self.c.nodes_list()


class FakeCore:
    """Core's drain list and steps, with its rules: the first `claimed` wins, a finished drain leaves the list."""

    def __init__(self, cluster: Cluster, boxes: dict[str, str]):
        self.cluster = cluster
        self.boxes = boxes
        self.actions: list[dict] = []
        self.steps: list[tuple] = []
        self.wanted: dict[str, bool] = {}
        self.fail_steps = False
        self.lose_next_reply = False
        self.claimed: set[str] = set()

    def add(
        self,
        action_id=AID,
        node=N1,
        node_uid=U1,
        requested=T0 - 10,
        expires=T0 + 3600,
        step=None,
        counts=None,
    ):
        action = {
            "action_id": action_id,
            "kind": "drain",
            "target": {"node": node, "node_uid": node_uid},
            "requested_at": stamp(requested),
            "expires_at": stamp(expires),
            "step": step,
            "counts": counts,
        }
        self.actions.append(action)
        if step is not None:
            self.claimed.add(action_id)
        return action

    def open_actions(self):
        return [dict(a) for a in self.actions]

    STEPS = ("claimed", "waiting_for_machine", "room_ok", "cordoned", "moving")
    NEEDS = {"room_ok": "claimed"}
    REPEATS = ("waiting_for_machine", "moving")
    COUNTED = ("moving", "stopped_partway")

    def step(self, action_id, step, state, counts=None):
        """Core's drain rules, so the worker is tested against what Core accepts."""
        if self.fail_steps:
            raise RuntimeError("Core call failed: HTTP 503")
        assert state in ("running", "done", "failed")
        reached = [s[1] for s in self.steps if s[0] == action_id]
        if step == da.CLAIMED and action_id in self.claimed and state != "failed":
            raise da.StepRefused()
        if state == "failed":
            assert step in da.FAILURES or step == da.CLAIMED, step
            if action_id not in self.claimed:
                raise da.StepRefused()  # every drain failure only after `claimed`
        else:
            assert step in self.STEPS, step  # 422 in Core
            position = self.STEPS.index(step)
            needs = self.NEEDS.get(step, self.STEPS[position - 1] if position else None)
            if needs is not None and needs not in reached:
                raise da.StepRefused()
            if any(self.STEPS.index(r) > position for r in reached if r in self.STEPS):
                raise da.StepRefused()
            if step in reached and step not in self.REPEATS:
                raise da.StepRefused()
            if state == "done":
                assert step == "moving"
        if step in self.COUNTED or (state == "failed" and counts is not None):
            # required on moving and stopped_partway; optional on drain's other failures
            assert counts is not None and 0 <= counts["moved"] <= counts["total"] <= 200
            last = next((s[3] for s in reversed(self.steps) if s[0] == action_id and s[3]), None)
            if last is not None:
                assert counts["total"] == last["total"] and counts["moved"] >= last["moved"]
            if state == "done":
                assert counts["moved"] == counts["total"]
        else:
            assert counts is None, step  # 422 in Core: counts aren't taken on this step
        if step == da.CLAIMED:
            self.claimed.add(action_id)
        self.steps.append((action_id, step, state, counts))
        for a in self.actions:
            if a["action_id"] == action_id:
                a["step"], a["counts"] = step, counts if counts is not None else a["counts"]
        if state in (da.STATE_DONE, da.STATE_FAILED):
            self.actions = [a for a in self.actions if a["action_id"] != action_id]
        if self.lose_next_reply:
            self.lose_next_reply = False
            raise RuntimeError(
                "Core call failed: TimeoutError"
            )  # recorded, but the answer never came back

    def finished(self):
        return bool(self.steps) and self.steps[-1][1:3] == ("moving", "done")

    def machines(self):
        return [
            {
                "machine_id": m,
                "desired_state": "running" if self.wanted.get(m, True) else "stopped",
                "revision": 1,
            }
            for m in self.boxes
        ]

    def codes(self):
        return [s[1] for s in self.steps]


def setup(boxes_on_n1=2, ceiling=3, n2=True, limits=None):
    """N1 (zone a) to drain, N2 (zone a) with room, N3 in another zone. Box map: m1.. -> agents-user-b1.."""
    clock = Clock()
    cluster = Cluster(clock)
    cluster.add_node(N1, U1)
    if n2:
        cluster.add_node(N2, U2)
    cluster.add_node(N3, U3, zone="eu-west-3b")
    boxes = {}
    for i in range(1, boxes_on_n1 + 1):
        mid = f"{i:08x}-0000-4000-8000-{i:012x}"
        ns = f"agents-user-b{i}"
        boxes[mid] = ns
        cluster.add_pod(ns, N1)
    core = FakeCore(cluster, boxes)
    worker = da.DrainWorker(
        KubeView(cluster),
        core,
        lambda: boxes,
        IMAGE,
        limits=limits or Limits(target=1, ceiling=ceiling),
        clock=clock,
    )
    return clock, cluster, core, worker, boxes


def run_until(worker, core, cluster, settle_to=N2, passes=40):
    """Ticks, finishing each eviction onto `settle_to` as the StatefulSet would."""
    for _ in range(passes):
        worker.tick()
        for ns, p in list(cluster.pods.items()):
            if p is not None and p["deleting"]:
                cluster.settle(ns, settle_to)
        if not core.actions:
            return


# ---------------------------------------------------------------- the whole drain


def test_a_drain_claims_cordons_with_the_uid_and_moves_each_box_one_at_a_time():
    clock, cluster, core, worker, boxes = setup()
    core.add()
    run_until(worker, core, cluster)
    assert core.codes() == [
        "claimed",
        "room_ok",
        "cordoned",
        "moving",
        "moving",
        "moving",
        "moving",
    ]
    assert core.finished()
    assert [s[3] for s in core.steps if s[1] == "moving"] == [
        {"moved": 0, "total": 2},
        {"moved": 1, "total": 2},
        {"moved": 2, "total": 2},
        {"moved": 2, "total": 2},
    ]
    assert cluster.writes[0] == (
        "cordon",
        N1,
        U1,
    )  # the node uid rides on the patch as a precondition
    evictions = [w for w in cluster.writes if w[0] == "evict"]
    assert [w[1] for w in evictions] == ["agents-user-b1", "agents-user-b2"]
    assert cluster.nodes[N1]["unschedulable"]  # it stays cordoned: a person uncordons it
    assert all(p["node"] == N2 for p in cluster.pods.values())


def test_one_eviction_waits_for_the_box_before_it_to_be_ready_elsewhere():
    clock, cluster, core, worker, boxes = setup()
    core.add()
    for _ in range(4):  # claimed, room_ok, cordoned, moving 0/2
        worker.tick()
    worker.tick()  # evicts b1
    assert [w[1] for w in cluster.writes if w[0] == "evict"] == ["agents-user-b1"]
    cluster.pods["agents-user-b1"]["deleting"] = False
    cluster.pods["agents-user-b1"]["node"] = ""  # replaced, pending, not yet Ready
    cluster.pods["agents-user-b1"]["ready"] = False
    for _ in range(3):
        worker.tick()
    assert [w[1] for w in cluster.writes if w[0] == "evict"] == ["agents-user-b1"]  # b2 waits


# ---------------------------------------------------------------- the node uid (must-pass)


def test_a_uid_mismatch_at_claim_claims_then_fails_with_node_replaced_and_touches_nothing():
    clock, cluster, core, worker, boxes = setup()
    core.add(node_uid=UNEW)
    run_until(worker, core, cluster)
    assert core.codes() == ["claimed", "node_replaced"]
    assert core.steps[-1][3] is None
    assert cluster.writes == []


@pytest.mark.parametrize("after", [1, 2, 3, 4, 5, 6])
def test_a_node_replaced_before_any_later_step_or_write_fails_with_node_replaced(after):
    """`after` passes run normally, then the node is replaced (same name, new uid): the very next pass fails."""
    clock, cluster, core, worker, boxes = setup()
    core.add()
    for _ in range(after):
        worker.tick()
        for ns, p in list(cluster.pods.items()):
            if p is not None and p["deleting"]:
                cluster.settle(ns, N2)
    writes_before = list(cluster.writes)
    cluster.nodes[N1]["uid"] = UNEW
    worker.tick()
    assert core.codes()[-1] == "node_replaced"
    moving = [s[3] for s in core.steps if s[1] == "moving"]
    assert core.steps[-1][3] == (
        moving[-1] if moving else None
    )  # how far it got, once total is fixed
    assert [w for w in cluster.writes if w[0] != "delete_placeholder"] == writes_before


def test_a_node_whose_uid_changes_between_the_check_and_the_cordon_is_refused_by_the_api_server():
    clock, cluster, core, worker, boxes = setup()
    core.add()
    worker.tick()
    worker.tick()  # claimed, room_ok
    real_node = cluster.node

    def swapped(name):  # the check sees the old node; the patch lands on its replacement
        answer = real_node(name)
        cluster.nodes[N1]["uid"] = UNEW
        return answer

    cluster.node = swapped
    worker.tick()
    assert cluster.writes == [("cordon", N1, U1)]
    assert not cluster.nodes[N1][
        "unschedulable"
    ]  # the API server refused it: 409 on the uid precondition
    assert core.codes()[-1] == "node_replaced"


def test_a_listed_drain_with_no_uid_is_never_claimed_or_acted_on():
    clock, cluster, core, worker, boxes = setup()
    action = core.add()
    del action["target"]["node_uid"]
    run_until(worker, core, cluster, passes=3)
    assert core.steps == [] and cluster.writes == []


def test_a_live_node_with_no_uid_fails_with_node_replaced():
    clock, cluster, core, worker, boxes = setup()
    cluster.nodes[N1]["uid"] = None
    core.add()
    run_until(worker, core, cluster)
    assert core.codes() == ["claimed", "node_replaced"] and cluster.writes == []


def test_a_node_gone_or_out_of_the_agents_pool_fails_with_node_replaced():
    clock, cluster, core, worker, boxes = setup()
    core.add()
    worker.tick()
    cluster.nodes[N1]["pool"] = "shared-services"
    worker.tick()
    assert core.codes() == ["claimed", "node_replaced"] and cluster.writes == []
    clock2, cluster2, core2, worker2, _ = setup()
    core2.add()
    worker2.tick()
    del cluster2.nodes[N1]
    worker2.tick()
    assert core2.codes() == ["claimed", "node_replaced"] and cluster2.writes == []


@pytest.mark.parametrize("code", [403, 422])
def test_a_cordon_the_policy_refuses_fails_with_cordon_refused(code):
    clock, cluster, core, worker, boxes = setup()
    cluster.cordon_error = code
    core.add()
    run_until(worker, core, cluster)
    assert core.codes() == ["claimed", "room_ok", "cordon_refused"]
    assert core.steps[-1][3] is None
    assert [w[0] for w in cluster.writes] == ["cordon"]


def test_a_cordon_answered_404_fails_with_node_replaced():
    clock, cluster, core, worker, boxes = setup()
    cluster.cordon_error = 404
    core.add()
    run_until(worker, core, cluster)
    assert core.codes() == ["claimed", "room_ok", "node_replaced"]


def test_a_node_already_cordoned_is_not_patched_again():
    clock, cluster, core, worker, boxes = setup()
    cluster.nodes[N1]["unschedulable"] = True
    core.add()
    run_until(worker, core, cluster)
    assert core.finished()
    assert not [w for w in cluster.writes if w[0] == "cordon"]


# ---------------------------------------------------------------- paused and turned-off boxes (must-pass)


def test_a_box_core_doesnt_want_running_is_never_evicted_and_counts_once_its_pod_is_gone():
    clock, cluster, core, worker, boxes = setup()
    paused = next(m for m, ns in boxes.items() if ns == "agents-user-b1")
    core.wanted[paused] = False
    core.add()
    for _ in range(8):
        worker.tick()
        for ns, p in list(cluster.pods.items()):
            if p is not None and p["deleting"]:
                cluster.settle(ns, N2)
    assert [w[1] for w in cluster.writes if w[0] == "evict"] == ["agents-user-b2"]
    assert core.actions  # not done: the paused box's pod is still on the node
    cluster.pods["agents-user-b1"] = None  # the scaler takes it to 0
    run_until(worker, core, cluster)
    assert core.finished()
    assert [w[1] for w in cluster.writes if w[0] == "evict"] == ["agents-user-b2"]


def test_a_paused_box_whose_pod_is_still_there_after_five_minutes_fails_and_never_counts_as_moved():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    core.wanted[next(iter(boxes))] = False
    core.add()
    for _ in range(5):
        worker.tick()
    clock.now += da.BOX_WITHIN_S + 1
    worker.tick()
    assert core.codes()[-1] == "box_not_ready"
    assert all(s[3] in (None, {"moved": 0, "total": 1}) for s in core.steps)
    assert not [w for w in cluster.writes if w[0] == "evict"]


def test_a_box_paused_just_after_its_eviction_counts_only_once_the_scaler_has_removed_the_new_pod():
    """The race: Core's wish is read again after each eviction; a box no longer wanted running
    isn't waited on for Ready, and counts as moved once its pod is gone."""
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    mid = next(iter(boxes))
    core.add()
    for _ in range(5):  # claimed, room_ok, cordoned, moving 0/1, evict
        worker.tick()
    assert [w[0] for w in cluster.writes] == ["cordon", "evict"]
    core.wanted[mid] = False  # paused in that second
    cluster.settle(
        "agents-user-b1", N2
    )  # the StatefulSet made the new pod before the scaler's next pass
    worker.tick()
    assert core.codes()[-1] == "moving" and core.steps[-1][3] == {"moved": 0, "total": 1}
    cluster.pods["agents-user-b1"] = None  # the scaler's pass
    run_until(worker, core, cluster)
    assert core.steps[-2][3] == {"moved": 1, "total": 1} and core.finished()


def test_the_scaler_takes_a_box_core_wants_stopped_to_zero():
    """The other half of the race: the scaler scales a running box Core wants stopped to 0 on its next pass."""
    action, _ = decide("stopped", 1, 1)
    assert action == "scale_down"


def test_a_box_paused_between_the_read_and_the_eviction_is_not_evicted():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    mid = next(iter(boxes))
    core.add()
    for _ in range(4):
        worker.tick()
    real = core.machines
    calls = {"n": 0}

    def paused_on_second_read():
        calls["n"] += 1
        if calls["n"] >= 2:
            core.wanted[mid] = False
        return real()

    core.machines = paused_on_second_read
    worker.tick()
    assert not [w for w in cluster.writes if w[0] == "evict"]


# ---------------------------------------------------------------- room


def test_short_of_room_it_asks_for_a_machine_with_one_placeholder_in_the_policy_shape():
    clock, cluster, core, worker, boxes = setup(n2=False)
    core.add()
    worker.tick()
    worker.tick()
    assert core.codes() == ["claimed", "waiting_for_machine"]
    name = da.placeholder_name(AID)
    body = cluster.placeholders[name]
    assert_policy_shape(body, zone="eu-west-3a")
    worker.tick()
    assert [w for w in cluster.writes if w[0] == "placeholder"] == [
        ("placeholder", name)
    ]  # one, not one a pass
    cluster.add_node(N2, U2)  # the autoscaler's machine, past the gate
    worker.tick()
    assert core.codes()[-1] == "room_ok"
    run_until(worker, core, cluster)
    assert core.finished()
    assert name not in cluster.placeholders
    first_evict = next(i for i, w in enumerate(cluster.writes) if w[0] == "evict")
    deleted = cluster.writes.index(("delete_placeholder", name))
    assert deleted < first_evict  # its room is for the boxes


def test_a_new_machine_still_behind_the_gate_is_not_room():
    clock, cluster, core, worker, boxes = setup(n2=False)
    core.add()
    worker.tick()
    cluster.add_node(N2, U2, taints=["switch.dev/gate1"])
    worker.tick()
    worker.tick()
    assert core.codes()[-1] == "waiting_for_machine"


def test_no_machine_in_fifteen_minutes_fails_with_nothing_cordoned_and_the_placeholder_gone():
    clock, cluster, core, worker, boxes = setup(n2=False)
    core.add()
    worker.tick()
    worker.tick()
    clock.now += da.ROOM_WITHIN_S + 1
    worker.tick()
    assert core.codes() == ["claimed", "waiting_for_machine", "no_machine_in_time"]
    assert core.steps[-1][3] is None
    assert cluster.placeholders == {}
    assert not [w for w in cluster.writes if w[0] in ("cordon", "evict")]


def test_a_restart_while_waiting_never_extends_the_fifteen_minutes():
    clock, cluster, core, worker, boxes = setup(n2=False)
    core.add(requested=T0, step="waiting_for_machine")
    clock.now = T0 + da.ROOM_WITHIN_S + 1
    worker.tick()
    assert core.codes() == ["no_machine_in_time"]


def test_expiry_while_waiting_lets_go_with_the_placeholder_deleted_and_nothing_cordoned():
    clock, cluster, core, worker, boxes = setup(n2=False)
    core.add(expires=T0 + 120)
    worker.tick()
    worker.tick()
    assert da.placeholder_name(AID) in cluster.placeholders
    clock.now = T0 + 120 - da.EXPIRY_MARGIN_S
    worker.tick()
    assert cluster.placeholders == {}
    assert not [w for w in cluster.writes if w[0] in ("cordon", "evict")]
    assert core.codes() == ["claimed", "waiting_for_machine"]  # Core marks it expired


def test_room_running_out_partway_stops_with_honest_counts_and_leaves_the_rest():
    clock, cluster, core, worker, boxes = setup(
        boxes_on_n1=2, ceiling=2
    )  # N2 has room for both, at first
    core.add()
    for _ in range(5):  # claimed, room_ok, cordoned, moving 0/2, evict b1
        worker.tick()
    cluster.settle("agents-user-b1", N2)
    boxes["99999999-0000-4000-8000-999999999999"] = (
        "agents-user-late"  # another box starts on N2 meanwhile
    )
    cluster.add_pod("agents-user-late", N2)
    run_until(worker, core, cluster)
    assert core.codes()[-1] == "stopped_partway"
    assert core.steps[-1][3] == {"moved": 1, "total": 2}
    assert cluster.pods["agents-user-b2"]["node"] == N1
    assert len([w for w in cluster.writes if w[0] == "evict"]) == 1


# ---------------------------------------------------------------- failures


@pytest.mark.parametrize("code", [429, 403, 500])
def test_a_refused_eviction_fails_with_evict_refused_and_is_never_retried(code):
    clock, cluster, core, worker, boxes = setup()
    cluster.evict_error = code
    core.add()
    run_until(worker, core, cluster)
    assert core.codes()[-1] == "evict_refused" and core.steps[-1][3] == {"moved": 0, "total": 2}
    assert len([w for w in cluster.writes if w[0] == "evict"]) == 1


def test_a_box_not_ready_elsewhere_in_five_minutes_fails_with_box_not_ready():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    core.add()
    for _ in range(5):
        worker.tick()
    cluster.pods["agents-user-b1"] = None  # evicted, and nothing has come back
    worker.tick()
    clock.now += da.BOX_WITHIN_S + 1
    worker.tick()
    assert core.codes()[-1] == "box_not_ready"


# ---------------------------------------------------------------- never ahead of Core


def test_while_core_refuses_step_reports_no_further_cluster_write_happens():
    clock, cluster, core, worker, boxes = setup()
    core.add()
    worker.tick()
    worker.tick()  # claimed, room_ok
    core.fail_steps = True
    for _ in range(5):
        worker.tick()
    assert [w[0] for w in cluster.writes] == [
        "cordon"
    ]  # the cordon happened; its report didn't get through
    core.fail_steps = False
    worker.tick()
    assert core.codes()[-1] == "cordoned"
    assert [w[0] for w in cluster.writes] == ["cordon"]  # not patched a second time


def test_a_cordoned_report_core_recorded_but_whose_answer_was_lost_carries_on():
    clock, cluster, core, worker, boxes = setup()
    core.add()
    worker.tick()
    worker.tick()  # claimed, room_ok
    core.lose_next_reply = True
    worker.tick()  # cordons; Core records `cordoned`, the answer is lost
    run_until(worker, core, cluster)
    assert core.finished()
    assert [w[0] for w in cluster.writes].count("cordon") == 1


def test_a_lost_claim_answer_lets_go_then_the_one_worker_picks_the_claimed_drain_up_again():
    """With one replica, the only worker that sees a claimed drain is its claimer, so it carries on. The 409 on its
    second `claimed` isn't taken as "recorded": that's the case of two workers starting together (test below)."""
    clock, cluster, core, worker, boxes = setup()
    core.add()
    core.lose_next_reply = True
    worker.tick()  # Core records `claimed`; the answer is lost
    worker.tick()  # claims again: 409, so it lets go, with nothing touched
    assert cluster.writes == [] and worker._drain is None
    run_until(worker, core, cluster)
    assert core.finished()


def test_core_unreachable_for_the_machine_list_means_no_eviction():
    clock, cluster, core, worker, boxes = setup()
    core.add()
    for _ in range(4):
        worker.tick()

    def down():
        raise RuntimeError("Core call failed: URLError")

    core.machines = down
    for _ in range(3):
        worker.tick()
    assert not [w for w in cluster.writes if w[0] == "evict"]


def test_a_worker_killed_between_an_eviction_and_its_report_recounts_without_a_second_eviction():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=2)
    core.add()
    for _ in range(5):  # ... moving 0/2, then b1 evicted
        worker.tick()
    cluster.settle("agents-user-b1", N2)  # Ready elsewhere, but this worker dies before reporting
    fresh = da.DrainWorker(
        KubeView(cluster), core, lambda: boxes, IMAGE, limits=Limits(1, 3), clock=clock
    )
    run_until(fresh, core, cluster)
    counts = [s[3]["moved"] for s in core.steps if s[1] == "moving"]
    assert counts == sorted(counts)  # never down
    assert core.finished() and core.steps[-1][3] == {"moved": 2, "total": 2}
    assert [w[1] for w in cluster.writes if w[0] == "evict"] == ["agents-user-b1", "agents-user-b2"]


def test_a_restarted_worker_never_evicts_a_pod_already_being_evicted():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    core.add()
    for _ in range(5):
        worker.tick()
    fresh = da.DrainWorker(
        KubeView(cluster), core, lambda: boxes, IMAGE, limits=Limits(1, 3), clock=clock
    )
    for _ in range(3):
        fresh.tick()  # the pod is still terminating
    assert len([w for w in cluster.writes if w[0] == "evict"]) == 1


# ---------------------------------------------------------------- one drain at a time


def test_two_workers_the_first_claimed_wins_and_the_other_touches_nothing():
    clock, cluster, core, worker, boxes = setup()
    core.add()
    other_cluster_writes = []
    other = da.DrainWorker(
        KubeView(cluster), core, lambda: boxes, IMAGE, limits=Limits(1, 3), clock=clock
    )
    core.open_actions_snapshot = core.open_actions()
    worker.tick()  # claims
    real_open = core.open_actions
    core.open_actions = lambda: [
        dict(a, step=None) for a in real_open()
    ]  # the other saw it before the claim
    other.tick()
    core.open_actions = real_open
    assert core.codes() == ["claimed"]
    assert cluster.writes == other_cluster_writes
    assert other._drain is None


def test_when_core_lists_two_drains_only_the_oldest_runs():
    clock, cluster, core, worker, boxes = setup()
    core.add(action_id=AID2, requested=T0 - 5)
    core.add(action_id=AID, requested=T0 - 50)
    worker.tick()
    assert core.steps == [(AID, "claimed", "running", None)]


# ---------------------------------------------------------------- input and the box map


@pytest.mark.parametrize(
    "change",
    [
        {"action_id": "not-a-uuid"},
        {"action_id": AID.upper()},
        {"kind": "restart"},
        {"target": {"node": "Bad_Node", "node_uid": U1}},
        {"target": {"node": N1, "node_uid": U1.upper()}},
        {"target": {"node": N1, "node_uid": U1 + "x"}},
        {"target": "nope"},
        {"step": "uncordoned"},
        {"step": "moving", "counts": None},
        {"step": "moving", "counts": {"moved": 3, "total": 2}},
        {"step": "moving", "counts": {"moved": True, "total": 2}},
        {"step": "moving", "counts": {"moved": 0, "total": 201}},
        {"expires_at": None},
        {"requested_at": "yesterday"},
    ],
)
def test_an_action_out_of_form_is_skipped(change):
    clock, cluster, core, worker, boxes = setup()
    action = core.add()
    action.update(change)
    core.claimed.clear()
    worker.tick()
    assert core.steps == [] and cluster.writes == []


def test_only_box_map_namespaces_are_read_counted_or_evicted():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    cluster.add_pod("agents-user-stranger", N1)  # on the node, but not in the operator's map
    core.add()
    run_until(worker, core, cluster)
    assert core.steps[-1][1:] == ("moving", "done", {"moved": 1, "total": 1})
    assert ("evict", "agents-user-stranger") not in [w[:2] for w in cluster.writes]


def test_logs_and_steps_carry_ids_and_codes_only(caplog):
    clock, cluster, core, worker, boxes = setup()
    core.add()
    with caplog.at_level(logging.DEBUG):
        run_until(worker, core, cluster)
        cluster.nodes[N1]["uid"] = UNEW
        core.add(action_id=AID2)
        run_until(worker, core, cluster)
    assert "marker" not in caplog.text  # the node's name never appears
    assert U1 not in caplog.text and UNEW not in caplog.text
    for _, step, state, counts in core.steps:
        assert step in (
            da.CLAIMED,
            da.WAITING,
            da.ROOM_OK,
            da.CORDONED,
            da.MOVING,
            *da.FAILURES,
        )
        assert state in (da.STATE_RUNNING, da.STATE_DONE, da.STATE_FAILED)


# ---------------------------------------------------------------- the placeholder shape


def assert_policy_shape(body, zone):
    """`switch-operator-placeholder-shape` (rights v1.2 onwards), clause by clause."""
    meta, spec = body["metadata"], body["spec"]
    assert meta["namespace"] == "switch-drain-room"
    import re

    assert re.fullmatch(r"drain-room-[a-z0-9]{1,20}", meta["name"])
    assert (
        len(spec["containers"]) == 1
        and "initContainers" not in spec
        and "ephemeralContainers" not in spec
    )
    c = spec["containers"][0]
    assert c["image"] == IMAGE
    for absent in ("command", "args", "env", "envFrom", "volumeMounts"):
        assert absent not in c
    assert c["resources"] == {
        "requests": {"cpu": "250m", "memory": "1Gi"},
        "limits": {"cpu": "250m", "memory": "1Gi"},
    }
    assert set(spec) <= {
        "containers",
        "restartPolicy",
        "terminationGracePeriodSeconds",
        "dnsPolicy",
        "securityContext",
        "schedulerName",
        "tolerations",
        "priority",
        "priorityClassName",
        "preemptionPolicy",
        "enableServiceLinks",
        "serviceAccountName",
        "serviceAccount",
        "nodeSelector",
        "automountServiceAccountToken",
    }
    assert set(c) <= {
        "name",
        "image",
        "resources",
        "securityContext",
        "terminationMessagePath",
        "terminationMessagePolicy",
        "imagePullPolicy",
    }
    assert set(c["securityContext"]) <= {
        "allowPrivilegeEscalation",
        "readOnlyRootFilesystem",
        "capabilities",
        "runAsNonRoot",
        "runAsUser",
        "runAsGroup",
        "seccompProfile",
    }
    assert c["securityContext"]["capabilities"].get("add", []) == []
    assert (
        spec.get("priority", 0) <= 0
        and spec.get("priorityClassName", "switch-placeholder") == "switch-placeholder"
    )
    assert spec.get("schedulerName", "default-scheduler") == "default-scheduler"
    assert spec.get("serviceAccountName", "default") == "default"
    assert spec.get("tolerations", []) == []
    assert spec["automountServiceAccountToken"] is False and "volumes" not in spec
    for host in ("hostNetwork", "hostPID", "hostIPC"):
        assert not spec.get(host, False)
    assert spec["nodeSelector"] == {
        "switch.dev/pool": "agents",
        "topology.kubernetes.io/zone": zone,
    }
    assert "nodeName" not in spec
    # restricted pod security
    assert c["securityContext"]["allowPrivilegeEscalation"] is False
    assert c["securityContext"]["runAsNonRoot"] is True
    assert c["securityContext"]["capabilities"]["drop"] == ["ALL"]
    assert c["securityContext"]["seccompProfile"] == {"type": "RuntimeDefault"}


def test_the_placeholder_name_is_fixed_per_drain():
    assert da.placeholder_name(AID) == "drain-room-0f1e2d3c4b5a49688776"
    assert da.placeholder_name(AID) != da.placeholder_name(AID2)


# ---------------------------------------------------------------- the HTTP clients


class Recorder:
    def __init__(self, answer=b"{}", error=None):
        self.answer, self.error, self.requests = answer, error, []

    def open(self, req, timeout=None):
        self.requests.append(req)
        if self.error:
            raise self.error
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self.answer


def kube_api(monkeypatch, recorder):
    monkeypatch.setattr(da, "build_opener", lambda *a: recorder)
    monkeypatch.setattr(da.ssl, "create_default_context", lambda cafile=None: None)
    return da.DrainKubeApi("https://kube.example", lambda: "drain-token", "/ca.crt", "agents")


def test_the_cordon_is_a_merge_patch_carrying_the_node_uid(monkeypatch):
    rec = Recorder()
    kube_api(monkeypatch, rec).cordon(N1, U1)
    req = rec.requests[0]
    import json

    assert req.get_method() == "PATCH" and req.full_url == f"https://kube.example/api/v1/nodes/{N1}"
    assert req.get_header("Content-type") == "application/merge-patch+json"
    assert json.loads(req.data) == {"metadata": {"uid": U1}, "spec": {"unschedulable": True}}
    assert req.get_header("Authorization") == "Bearer drain-token"


def test_an_eviction_goes_through_the_eviction_api_with_the_pod_uid(monkeypatch):
    rec = Recorder()
    kube_api(monkeypatch, rec).evict("agents-user-b1", "pod-uid")
    req = rec.requests[0]
    import json

    assert req.get_method() == "POST"
    assert (
        req.full_url == "https://kube.example/api/v1/namespaces/agents-user-b1/pods/box-0/eviction"
    )
    body = json.loads(req.data)
    assert body["kind"] == "Eviction" and body["deleteOptions"] == {
        "preconditions": {"uid": "pod-uid"}
    }


@pytest.mark.parametrize(
    "call",
    [
        lambda k: k.box_pod("kube-system"),
        lambda k: k.evict("egress-proxy", "u"),
        lambda k: k.node("Bad/Name"),
        lambda k: k.placeholder("other-pod"),
        lambda k: k.delete_placeholder("../x"),
    ],
)
def test_the_kube_client_refuses_names_outside_its_narrow_set(monkeypatch, call):
    rec = Recorder()
    with pytest.raises(ValueError):
        call(kube_api(monkeypatch, rec))
    assert rec.requests == []


def test_core_steps_carry_counts_only_when_given_and_a_409_is_refused(monkeypatch):
    import json

    rec = Recorder(answer=b"")
    monkeypatch.setattr(da, "build_opener", lambda *a: rec)
    core = da.DrainCoreApi("https://core.example", "op-token")
    core.step(AID, "claimed", "running")
    core.step(AID, "moving", "running", {"moved": 1, "total": 2})
    assert json.loads(rec.requests[0].data) == {"step": "claimed", "state": "running"}
    assert json.loads(rec.requests[1].data) == {
        "step": "moving",
        "state": "running",
        "counts": {"moved": 1, "total": 2},
    }
    assert (
        rec.requests[0].full_url
        == f"https://core.example/gateway/hosted-controller/actions/{AID}/steps"
    )
    rec.error = http_error(409)
    with pytest.raises(da.StepRefused):
        core.step(AID, "cordoned", "running")


def test_core_lists_drains_only(monkeypatch):
    rec = Recorder(answer=b'{"actions": [{"action_id": "x"}, "junk"]}')
    monkeypatch.setattr(da, "build_opener", lambda *a: rec)
    assert da.DrainCoreApi("https://core.example", "t").open_actions() == [{"action_id": "x"}]
    assert rec.requests[0].full_url.endswith("/gateway/hosted-controller/actions?kind=drain")


# ---------------------------------------------------------------- edge-case probes


def test_qa_a_refused_eviction_whose_failure_report_fails_is_never_retried():
    clock, cluster, core, worker, boxes = setup()
    cluster.evict_error = 429
    core.add()
    for _ in range(4):  # claimed, room_ok, cordoned, moving 0/2
        worker.tick()
    core.fail_steps = True
    worker.tick()  # eviction refused; the evict_refused report fails
    calls_while_down = len(cluster.writes)
    for _ in range(3):
        worker.tick()  # still down: the failure is held, with no cluster call
    assert len(cluster.writes) == calls_while_down
    core.fail_steps = False
    for _ in range(5):
        worker.tick()
    assert len([w for w in cluster.writes if w[0] == "evict"]) == 1
    assert core.codes()[-1] == "evict_refused" and not core.actions


def test_qa_a_lost_box_not_ready_report_is_sent_again_not_turned_into_progress():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    core.add()
    for _ in range(5):
        worker.tick()
    cluster.pods["agents-user-b1"] = None
    worker.tick()
    clock.now += da.BOX_WITHIN_S + 1
    core.fail_steps = True
    worker.tick()
    core.fail_steps = False
    worker.tick()
    assert core.codes()[-1] == "box_not_ready"
    assert not core.finished()


def test_qa_a_restarted_worker_never_counts_an_evicted_box_with_no_pod_as_moved():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    core.add()
    for _ in range(5):  # ... moving 0/1, b1 evicted
        worker.tick()
    cluster.pods["agents-user-b1"] = None  # old pod gone, new one not made yet
    fresh = da.DrainWorker(
        KubeView(cluster), core, lambda: boxes, IMAGE, limits=Limits(1, 3), clock=clock
    )
    for _ in range(3):
        fresh.tick()
    assert not core.finished()
    assert all(s[3] in (None, {"moved": 0, "total": 1}) for s in core.steps)
    clock.now += da.BOX_WITHIN_S + 1
    fresh.tick()
    assert core.codes()[-1] == "box_not_ready"  # it never came back: told so, never "done"


def test_a_restarted_worker_counts_the_evicted_box_once_it_is_ready_elsewhere():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    core.add()
    for _ in range(5):
        worker.tick()
    cluster.pods["agents-user-b1"] = None
    fresh = da.DrainWorker(
        KubeView(cluster), core, lambda: boxes, IMAGE, limits=Limits(1, 3), clock=clock
    )
    fresh.tick()
    cluster.settle("agents-user-b1", N2)
    run_until(fresh, core, cluster)
    assert core.finished() and core.steps[-1][3] == {"moved": 1, "total": 1}
    assert len([w for w in cluster.writes if w[0] == "evict"]) == 1


# ---------------------------------------------------------------- v1.2: one eviction per box, own node


def test_a_box_whose_eviction_was_answered_409_is_never_asked_again():
    clock, cluster, core, worker, boxes = setup(boxes_on_n1=1)
    core.add()
    for _ in range(4):
        worker.tick()
    real_evict = cluster.evict

    def replaced_meanwhile(namespace, pod_uid):
        cluster.writes.append(("evict", namespace, pod_uid))
        raise http_error(
            409
        )  # the uid precondition: the pod changed under us, and stays on the node

    cluster.evict = replaced_meanwhile
    for _ in range(4):
        worker.tick()
    cluster.evict = real_evict
    assert len([w for w in cluster.writes if w[0] == "evict"]) == 1
    clock.now += da.BOX_WITHIN_S + 1
    worker.tick()
    assert core.codes()[-1] == "box_not_ready"
    assert len([w for w in cluster.writes if w[0] == "evict"]) == 1


def test_the_workers_own_node_is_claimed_then_refused_with_no_cluster_call():
    clock, cluster, core, worker, boxes = setup()
    worker.own_node = N1
    core.add()
    worker.tick()
    assert core.steps == [(AID, "claimed", "running", None), (AID, "own_node", "failed", None)]
    assert cluster.writes == [] and cluster.reads == []  # not even a read before or between


def test_a_failure_on_a_drain_nobody_claimed_is_refused_by_the_fake_core():
    """The fake Core holds Core's claim rule, so the loop is tested against it."""
    clock, cluster, core, worker, boxes = setup()
    core.add()
    with pytest.raises(da.StepRefused):
        core.step(AID, "own_node", "failed")


def test_a_resumed_drain_of_the_workers_own_node_is_refused_with_how_far_it_got():
    clock, cluster, core, worker, boxes = setup()
    core.add(step="moving", counts={"moved": 1, "total": 2})
    worker.own_node = N1  # rescheduled onto the machine being drained
    worker.tick()
    assert core.steps == [(AID, "own_node", "failed", {"moved": 1, "total": 2})]
    assert cluster.writes == []


def test_another_node_is_drained_as_usual_with_own_node_set():
    clock, cluster, core, worker, boxes = setup()
    worker.own_node = N3
    core.add()
    run_until(worker, core, cluster)
    assert core.finished()
