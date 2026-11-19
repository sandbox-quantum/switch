"""Moving resting boxes, sizing placeholders, and the switch-on flags."""

import logging

import pytest

from switch_hosted_controller.box_scaler import reconcile_once
from switch_hosted_controller.placement import (
    GATE1_TAINT,
    Limits,
    MoveLimits,
    Node,
    PlaceholderLimits,
    placeholder_counts,
)
from switch_hosted_controller.placer import PlacementKubeApi, Placer, placer_from_env

L = Limits(target=7, ceiling=12)
M1 = "11111111-1111-1111-1111-111111111111"
M2 = "22222222-2222-2222-2222-222222222222"


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


class Kube:
    def __init__(self, nodes, running, placeholders=None, fail=None):
        self._nodes, self.running, self._ph, self._fail = (
            nodes,
            dict(running),
            dict(placeholders or {}),
            fail,
        )
        self.scaled, self.ph_set, self.patches = [], [], []

    def nodes(self):
        if self._fail == "nodes":
            raise RuntimeError("api down")
        return self._nodes

    def running_boxes(self):
        return dict(self.running)

    def home_zone(self, namespace):
        return "a"

    def patch_template(self, namespace, patch):
        self.patches.append(namespace)

    def set_box_replicas(self, namespace, replicas):
        self.scaled.append((namespace, replicas))

    def placeholders(self):
        return dict(self._ph)

    def set_placeholders(self, zone, replicas):
        self.ph_set.append((zone, replicas))


def crowded(extra_on_m1=8):
    """m1 holds `extra_on_m1` other boxes plus ours (agents-user-mine); m2 is empty."""
    running = {f"agents-user-other-{i}": "m1" for i in range(extra_on_m1)}
    running["agents-user-mine"] = "m1"
    return [Node("m1", "a"), Node("m2", "a")], running


def machine(mid=M1, resting=True, desired="running", state="ready", **extra):
    raw = {"machine_id": mid, "desired_state": desired, "state": state, "revision": 1, **extra}
    if resting is not None:
        raw["resting"] = resting
    return raw


BOXES = {M1: "agents-user-mine"}


# --- moves ----------------------------------------------------------------------------------------------------------


def test_a_resting_box_on_a_machine_over_target_is_stopped_so_it_starts_elsewhere(caplog):
    nodes, running = crowded()
    kube = Kube(nodes, running)
    with caplog.at_level(logging.INFO):
        moved = Placer(kube, L, clock=Clock(), moves=True).rebalance([machine()], BOXES)
    assert moved == ["agents-user-mine"] and kube.scaled == [("agents-user-mine", 0)]
    line = [r.getMessage() for r in caplog.records if r.getMessage().startswith("Box moving")][0]
    assert "from=m1" in line and "machine_boxes=9" in line and "target=7" in line


@pytest.mark.parametrize(
    "raw",
    [
        machine(resting=None),  # today's Core: no resting field, so never moved
        machine(resting=False),
        machine(resting="true"),  # only a real true counts
        machine(desired="stopped"),
        machine(state="provisioning"),
    ],
)
def test_never_moves_a_box_that_is_not_plainly_resting_ready_and_wanted_running(raw):
    nodes, running = crowded()
    kube = Kube(nodes, running)
    assert Placer(kube, L, clock=Clock(), moves=True).rebalance([raw], BOXES) == []
    assert kube.scaled == []


def test_never_moves_a_box_this_scaler_does_not_own_but_still_counts_it():
    nodes, running = crowded(extra_on_m1=8)
    kube = Kube(nodes, running)
    # Core marks a machine resting that isn't in our box map: it isn't ours to stop.
    assert Placer(kube, L, clock=Clock(), moves=True).rebalance([machine(mid=M2)], BOXES) == []
    # Ours is one of 9 on m1 only because the others are counted: with 6 others (7 in all) there is no move.
    nodes, running = crowded(extra_on_m1=6)
    assert (
        Placer(Kube(nodes, running), L, clock=Clock(), moves=True).rebalance([machine()], BOXES)
        == []
    )


def test_never_moves_a_box_whose_start_is_still_pending():
    nodes, running = crowded()
    placer = Placer(Kube(nodes, running), L, clock=Clock(), moves=True)
    placer.ledger.pending["agents-user-mine"] = "m2"
    assert placer.rebalance([machine()], BOXES) == []


def test_the_cooldown_and_the_per_minute_budget_hold_across_passes():
    nodes = [Node("m1", "a"), Node("m2", "a"), Node("m3", "a"), Node("m4", "a")]
    running = {}
    boxes, machines = {}, []
    for node in ("m1", "m2", "m3"):
        for i in range(9):
            ns = f"agents-user-{node}-{i}"
            running[ns] = node
            mid = f"{node[-1]}{i}".rjust(8, "0") + "-0000-0000-0000-000000000000"
            boxes[mid] = ns
            machines.append(machine(mid=mid))
    clock = Clock()
    kube = Kube(nodes, running)
    placer = Placer(
        kube, L, clock=clock, move_limits=MoveLimits(per_minute=2, cooldown_s=3600), moves=True
    )
    assert len(placer.rebalance(machines, boxes)) == 2
    clock.t += 30
    assert placer.rebalance(machines, boxes) == []  # two already this minute
    clock.t += 31
    second = placer.rebalance(machines, boxes)
    assert len(second) == 2 and not set(second) & {
        ns for ns, _ in kube.scaled[:2]
    }  # cooldown: not the same boxes


def test_tick_does_nothing_unless_switched_on_and_never_raises(caplog):
    nodes, running = crowded()
    kube = Kube(nodes, running)
    Placer(kube, L, clock=Clock()).tick([machine()], BOXES)
    assert kube.scaled == [] and kube.ph_set == []
    broken = Kube(nodes, running, fail="nodes")
    with caplog.at_level(logging.WARNING):
        Placer(broken, L, clock=Clock(), moves=True, placeholders=True).tick([machine()], BOXES)
    messages = [r.getMessage() for r in caplog.records]
    assert "Moves skipped this pass (RuntimeError)." in messages
    assert "Placeholders not sized this pass (RuntimeError)." in messages


# --- the scaler's end-of-pass hook ----------------------------------------------------------------------------------


class ScalerKube:
    def __init__(self, replicas, ready):
        self.replicas, self.ready, self.calls = replicas, ready, []

    def scale(self, ns):
        return self.replicas, self.ready

    def set_replicas(self, ns, n):
        self.calls.append(("scale", ns, n))
        self.replicas = n


class Core:
    def __init__(self, raw):
        self.raw = raw

    def machines(self):
        return [self.raw]

    def observe(self, *a, **k):
        pass


def test_the_scaler_calls_rebalance_once_after_scaling_with_cores_list_and_the_box_map():
    order = []
    kube = ScalerKube(0, 0)
    kube.set_replicas = lambda ns, n: order.append(("scale", ns, n))
    raw = machine(resting=False)
    reconcile_once(
        Core(raw),
        kube,
        BOXES,
        rebalance=lambda listed, boxes: order.append(("tick", listed, boxes)),
    )
    assert order == [("scale", "agents-user-mine", 1), ("tick", [raw], BOXES)]


def test_a_failing_rebalance_never_breaks_the_pass(caplog):
    def boom(listed, boxes):
        raise RuntimeError("x")

    kube = ScalerKube(0, 0)
    with caplog.at_level(logging.WARNING):
        steps = reconcile_once(Core(machine()), kube, BOXES, rebalance=boom)
    assert kube.calls == [("scale", "agents-user-mine", 1)] and len(steps) == 1
    assert any("Placement pass failed (RuntimeError)" in r.getMessage() for r in caplog.records)


def test_a_moved_box_is_placed_and_started_again_on_the_next_pass():
    nodes, running = crowded()
    pkube = Kube(nodes, running)
    placer = Placer(pkube, L, clock=Clock(), moves=True)
    skube = ScalerKube(1, 1)
    pkube.set_box_replicas = lambda ns, n: (
        setattr(skube, "replicas", n) or setattr(skube, "ready", 0)
    )
    reconcile_once(Core(machine()), skube, BOXES, place=placer.place, rebalance=placer.tick)
    assert skube.replicas == 0 and skube.calls == []  # this pass: moved (stopped)
    pkube.running.pop("agents-user-mine")  # its pod is gone
    reconcile_once(Core(machine()), skube, BOXES, place=placer.place, rebalance=placer.tick)
    assert pkube.patches == ["agents-user-mine"] and skube.calls == [
        ("scale", "agents-user-mine", 1)
    ]
    assert placer.ledger.pending == {"agents-user-mine": "m2"}  # placed on the emptier machine


# --- placeholders ---------------------------------------------------------------------------------------------------

PL = PlaceholderLimits(max_per_zone=3)


def test_a_full_zone_or_one_with_no_ready_machine_asks_for_one_more_placeholder_up_to_the_limit():
    nodes = [
        Node("a1", "a"),
        Node("b1", "b", ready=False),
        Node("c1", "c", taints=frozenset({GATE1_TAINT})),
    ]
    got = placeholder_counts(nodes, {"a1": 7}, L, {"a": 0, "b": 3, "c": 1}, PL)
    assert got == {"a": 1, "b": 3, "c": 2}


def test_a_whole_machine_of_room_lets_one_placeholder_go_and_in_between_nothing_changes():
    nodes = [Node("a1", "a"), Node("a2", "a"), Node("b1", "b")]
    got = placeholder_counts(nodes, {"a1": 0, "a2": 3, "b1": 3}, L, {"a": 2, "b": 2}, PL)
    assert got == {"a": 1, "b": 2}  # a: 7 + 4 room; b: 4 room, under a machine's worth
    assert placeholder_counts(nodes, {}, L, {"a": 0}, PL)["a"] == 0  # never below 0


def test_placeholder_limit_is_checked():
    with pytest.raises(ValueError):
        PlaceholderLimits(max_per_zone=-1)


def test_size_placeholders_patches_only_zones_that_change_and_that_have_a_set(caplog):
    nodes = [Node("a1", "a"), Node("b1", "b")]
    kube = Kube(nodes, {f"agents-user-{i}": "a1" for i in range(7)}, placeholders={"a": 0})
    with caplog.at_level(logging.INFO):
        changed = Placer(kube, L, clock=Clock(), placeholders=True).size_placeholders()
    assert changed == {"a": 1} and kube.ph_set == [("a", 1)]
    messages = [r.getMessage() for r in caplog.records]
    assert "Placeholders: zone=a from=0 to=1" in messages
    assert not any(
        "zone=b" in m and "Placeholders:" in m for m in messages
    )  # b has room: no change wanted


# --- the Kubernetes calls -------------------------------------------------------------------------------------------


class Recorder:
    def __init__(self, reply=None):
        self.calls, self.reply = [], reply or {}

    def __call__(self, method, path, body=None, timeout=None):
        self.calls.append((method, path, body, timeout))
        return self.reply


def test_a_move_is_a_scale_to_zero_of_the_box_only_with_the_short_timeout():
    rec = Recorder()
    PlacementKubeApi(rec).set_box_replicas("agents-user-a", 0)
    assert rec.calls == [
        (
            "PATCH",
            "/apis/apps/v1/namespaces/agents-user-a/statefulsets/box/scale",
            {"spec": {"replicas": 0}},
            4.0,
        )
    ]
    with pytest.raises(ValueError):
        PlacementKubeApi(rec).set_box_replicas("kube-system", 0)


def test_placeholder_calls_stay_in_their_namespace_and_refuse_odd_zone_names():
    reply = {
        "items": [
            {
                "metadata": {
                    "name": "switch-placeholder-a",
                    "labels": {"switch.dev/placeholder-zone": "a"},
                },
                "spec": {"replicas": 2},
            },
            {
                "metadata": {
                    "name": "something-else",
                    "labels": {"switch.dev/placeholder-zone": "b"},
                },
                "spec": {"replicas": 5},
            },
        ]
    }
    rec = Recorder(reply)
    api = PlacementKubeApi(rec, "switch-placer")
    assert api.placeholders() == {"a": 2}
    api.set_placeholders("a", 3)
    assert rec.calls[-1][:3] == (
        "PATCH",
        "/apis/apps/v1/namespaces/switch-placer/deployments/switch-placeholder-a/scale",
        {"spec": {"replicas": 3}},
    )
    for bad in ("../x", "A", "a/b", ""):
        with pytest.raises(ValueError):
            api.set_placeholders(bad, 1)
    with pytest.raises(ValueError):
        PlacementKubeApi(rec).placeholders()  # no namespace set


# --- the switch-on flags --------------------------------------------------------------------------------------------


def test_everything_is_off_by_default():
    assert placer_from_env(Recorder(), {}) is None
    assert placer_from_env(Recorder(), {"SWITCH_BOX_PLACEMENT": "off"}) is None


def test_placement_on_reads_the_limits_and_leaves_moves_and_placeholders_off():
    placer = placer_from_env(
        Recorder(),
        {
            "SWITCH_BOX_PLACEMENT": "on",
            "SWITCH_PLACEMENT_TARGET": "6",
            "SWITCH_PLACEMENT_CEILING": "10",
        },
    )
    assert isinstance(placer, Placer)
    assert (placer._limits.target, placer._limits.ceiling) == (6, 10)
    assert (placer._moves_on, placer._placeholders_on) == (False, False)
    both = placer_from_env(
        Recorder(),
        {
            "SWITCH_BOX_PLACEMENT": "on",
            "SWITCH_BOX_MOVES": "on",
            "SWITCH_BOX_PLACEHOLDERS": "on",
            "SWITCH_PLACEHOLDER_NAMESPACE": "switch-placer",
        },
    )
    assert (both._moves_on, both._placeholders_on) == (True, True)


@pytest.mark.parametrize(
    "env",
    [
        {"SWITCH_BOX_PLACEMENT": "yes"},
        {"SWITCH_BOX_MOVES": "on"},  # moves need placement on
        {"SWITCH_BOX_PLACEHOLDERS": "on"},
        {"SWITCH_BOX_PLACEMENT": "on", "SWITCH_BOX_PLACEHOLDERS": "on"},  # no namespace
        {
            "SWITCH_BOX_PLACEMENT": "on",
            "SWITCH_BOX_PLACEHOLDERS": "on",
            "SWITCH_PLACEHOLDER_NAMESPACE": "Bad/ns",
        },
        {"SWITCH_BOX_PLACEMENT": "on", "SWITCH_PLACEMENT_TARGET": "seven"},
        {"SWITCH_BOX_PLACEMENT": "on", "SWITCH_PLACEMENT_TARGET": "-1"},
        {
            "SWITCH_BOX_PLACEMENT": "on",
            "SWITCH_PLACEMENT_TARGET": "13",
        },  # above the default ceiling
    ],
)
def test_a_bad_flag_refuses_to_start_rather_than_guess(env):
    with pytest.raises(ValueError):
        placer_from_env(Recorder(), env)


def test_the_machine_pool_is_read_from_the_flag_so_level_3_machines_are_seen():
    rec = Recorder({"items": []})
    placer = placer_from_env(
        rec, {"SWITCH_BOX_PLACEMENT": "on", "SWITCH_PLACEMENT_POOL": "agents-l3"}
    )
    placer._kube.nodes()
    assert rec.calls[-1][1] == "/api/v1/nodes?labelSelector=switch.dev/pool%3Dagents-l3"
    rec2 = Recorder({"items": []})
    placer_from_env(rec2, {"SWITCH_BOX_PLACEMENT": "on"})._kube.nodes()
    assert (
        rec2.calls[-1][1] == "/api/v1/nodes?labelSelector=switch.dev/pool%3Dagents"
    )  # the default
    for bad in ("Agents", "a,b", "x=y", "-a"):
        with pytest.raises(ValueError):
            placer_from_env(
                Recorder(), {"SWITCH_BOX_PLACEMENT": "on", "SWITCH_PLACEMENT_POOL": bad}
            )
