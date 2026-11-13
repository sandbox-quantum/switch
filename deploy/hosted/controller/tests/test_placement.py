import pytest

from switch_hosted_controller.placement import (
    GATE1_TAINT,
    BoxState,
    Decision,
    Ledger,
    Limits,
    MoveLimits,
    Node,
    box_counts,
    choose,
    choose_zone,
    plan_moves,
    template_patch,
)

L = Limits(target=7, ceiling=12)


def n(name, zone="a", **kw):
    return Node(name=name, zone=zone, **kw)


# --- choosing the machine -------------------------------------------------------------------------------------------


def test_fewest_boxes_wins_then_most_free_memory_then_name():
    nodes = [
        n("m1", free_memory_bytes=1),
        n("m2", free_memory_bytes=9),
        n("m3", free_memory_bytes=9),
    ]
    assert choose(nodes, {"m1": 2, "m2": 3, "m3": 3}, L, "a").first == "m1"
    assert (
        choose(nodes, {"m1": 3, "m2": 3, "m3": 3}, L, "a").first == "m2"
    )  # more memory, then name
    d = choose(nodes, {"m1": 3, "m2": 3, "m3": 3}, L, "a")
    assert (d.second, d.reason, d.count_before) == ("m3", "below_target", 3)


@pytest.mark.parametrize(
    "bad",
    [
        {"ready": False},
        {"schedulable": False},
        {"draining": True},
        {"taints": frozenset({GATE1_TAINT})},
    ],
)
def test_never_chooses_a_machine_that_is_not_ready_cordoned_draining_or_gate1_tainted(bad):
    nodes = [n("empty-but-bad", **bad), n("busy", free_memory_bytes=0)]
    d = choose(nodes, {"busy": 5}, L, "a")
    assert d.first == "busy" and d.second is None


def test_a_box_is_always_placed_in_its_home_zone_never_another():
    nodes = [n("a1", "a"), n("b1", "b")]
    assert (
        choose(nodes, {"a1": 11, "b1": 0}, L, "a").first == "a1"
    )  # even full, the disk is in zone a


def test_over_target_still_places_and_says_so():
    d = choose([n("m1"), n("m2")], {"m1": 7, "m2": 8}, L, "a")
    assert (d.first, d.reason, d.count_before) == ("m1", "over_target", 7)


def test_no_candidate_in_the_home_zone_gives_no_machine_and_the_zone_preference():
    d = choose([n("a1", "a", ready=False), n("b1", "b")], {}, L, "a")
    assert (d.zone, d.first, d.reason) == ("a", None, "no_machine_in_zone")
    terms = template_patch(d, first_start=False)["spec"]["template"]["spec"]["affinity"][
        "nodeAffinity"
    ]["preferredDuringSchedulingIgnoredDuringExecution"]
    assert terms == [
        {
            "weight": 20,
            "preference": {
                "matchExpressions": [
                    {"key": "topology.kubernetes.io/zone", "operator": "In", "values": ["a"]}
                ]
            },
        }
    ]


# --- choosing the zone for a new user -------------------------------------------------------------------------------


def test_first_start_goes_to_the_zone_with_the_most_room():
    nodes = [n("a1", "a"), n("a2", "a"), n("b1", "b"), n("b2", "b")]
    assert choose_zone(nodes, {"a1": 6, "a2": 6, "b1": 2, "b2": 3}, L) == "b"
    d = choose(nodes, {"a1": 6, "a2": 6, "b1": 2, "b2": 3}, L, None)
    assert (d.zone, d.first, d.reason) == ("b", "b1", "first_start")


def test_zone_room_counts_only_candidate_machines():
    # Zone a has two machines but one is gate-1 tainted: 7 - 3 = 4 room, against zone b's 7 - 4 = 3.
    nodes = [n("a1", "a"), n("a2", "a", taints=frozenset({GATE1_TAINT})), n("b1", "b")]
    assert choose_zone(nodes, {"a1": 3, "b1": 4}, L) == "a"


def test_no_zone_with_a_candidate_means_no_decision_on_first_start():
    assert choose([n("a1", ready=False)], {}, L, None) is None


# --- several wakes at once ------------------------------------------------------------------------------------------


def test_pending_choices_count_so_a_burst_of_wakes_spreads():
    nodes = [n("m1"), n("m2"), n("m3")]
    running = {"agents-user-x": "m1"}
    ledger = Ledger()
    for i in range(6):
        d = choose(nodes, box_counts(running, ledger), L, "a")
        ledger.pending[f"agents-user-{i}"] = d.first
    # Spread within one box of each other across the three machines, counting the one already running.
    counts = box_counts(running, ledger)
    assert max(counts.values()) - min(counts.values()) <= 1


def test_settled_choices_leave_the_ledger():
    ledger = Ledger(pending={"agents-user-a": "m1", "agents-user-b": "m2"})
    ledger.settle({"agents-user-a": "m3"})  # it landed elsewhere: what counts now is where it runs
    assert ledger.pending == {"agents-user-b": "m2"}


# --- the patch ------------------------------------------------------------------------------------------------------


def test_the_patch_sets_only_node_affinity_with_preferred_terms_never_required():
    d = Decision(zone="a", first="m1", second="m2", reason="below_target", count_before=3)
    patch = template_patch(d, first_start=False)
    affinity = patch["spec"]["template"]["spec"]["affinity"]
    assert list(affinity) == ["nodeAffinity"]  # podAntiAffinity, a sibling, is left as it is
    na = affinity["nodeAffinity"]
    assert list(na) == ["preferredDuringSchedulingIgnoredDuringExecution"]
    weights = [
        (t["weight"], t["preference"]["matchExpressions"][0]["values"][0])
        for t in na["preferredDuringSchedulingIgnoredDuringExecution"]
    ]
    assert weights == [(100, "m1"), (50, "m2")]
    assert list(patch) == ["spec"] and list(patch["spec"]) == [
        "template"
    ]  # nothing else in the StatefulSet


def test_a_first_start_also_prefers_the_chosen_zone():
    d = Decision(zone="b", first="b1", second=None, reason="first_start", count_before=0)
    terms = template_patch(d, first_start=True)["spec"]["template"]["spec"]["affinity"][
        "nodeAffinity"
    ]["preferredDuringSchedulingIgnoredDuringExecution"]
    assert [t["weight"] for t in terms] == [100, 20]


def test_limits_must_make_sense():
    with pytest.raises(ValueError):
        Limits(target=8, ceiling=7)
    with pytest.raises(ValueError):
        Limits(target=0, ceiling=7)


# --- putting things back --------------------------------------------------------------------------------------------

ML = MoveLimits(per_minute=2, cooldown_s=3600)


def boxes_on(node, k, resting=True, start=0, last_moved=None):
    return [
        BoxState(f"agents-user-{node}-{start + i}", node, resting, last_moved) for i in range(k)
    ]


def test_moves_only_resting_boxes_off_a_machine_over_target():
    nodes = [n("m1"), n("m2")]
    boxes = boxes_on("m1", 6, resting=False) + boxes_on("m1", 3, start=6) + boxes_on("m2", 2)
    moves = plan_moves(boxes, nodes, L, ML, now=10_000, moves_last_minute=0)
    assert len(moves) == 1  # one per machine per pass
    namespace, source = moves[0]
    assert source == "m1" and namespace in {
        b.namespace for b in boxes if b.resting and b.node == "m1"
    }


def test_never_moves_an_awake_box():
    nodes = [n("m1"), n("m2")]
    assert (
        plan_moves(boxes_on("m1", 9, resting=False) + boxes_on("m2", 1), nodes, L, ML, 10_000, 0)
        == []
    )


def test_nothing_moves_while_a_machine_in_the_zone_is_not_ready():
    nodes = [n("m1"), n("m2"), n("m3", ready=False)]
    assert plan_moves(boxes_on("m1", 9) + boxes_on("m2", 1), nodes, L, ML, 10_000, 0) == []


def test_the_rate_limit_and_the_cooldown_hold():
    nodes = [n("m1"), n("m2"), n("m3"), n("m4")]
    boxes = boxes_on("m1", 9) + boxes_on("m2", 9) + boxes_on("m3", 9) + boxes_on("m4", 0)
    assert len(plan_moves(boxes, nodes, L, ML, 10_000, moves_last_minute=0)) == 2
    assert len(plan_moves(boxes, nodes, L, ML, 10_000, moves_last_minute=2)) == 0
    recent = boxes_on("m1", 9, last_moved=9_000) + boxes_on("m4", 0)
    assert plan_moves(recent, nodes, L, ML, now=10_000, moves_last_minute=0) == []


def test_no_move_when_no_machine_in_the_zone_is_below_target():
    nodes = [n("m1"), n("m2"), n("b1", "b")]
    boxes = boxes_on("m1", 9) + boxes_on("m2", 7) + boxes_on("b1", 0)
    assert (
        plan_moves(boxes, nodes, L, ML, 10_000, 0) == []
    )  # zone b's room can't take zone a's boxes
