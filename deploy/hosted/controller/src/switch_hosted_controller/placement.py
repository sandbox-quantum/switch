"""Operator-chosen placement for users' Kubernetes boxes.

The placer decides which machine a box should start on, and says so to Kubernetes as a *preferred* node affinity on
the box's pod template, written only while the box is stopped (replicas 0), just before the box scaler starts it.
Every rule here is a preference: the scheduler may always place a box somewhere else that fits, so a failed or full
machine never stops a box from starting. The one hard rule is physics: a box's disk lives in one zone.

Everything in this module is pure (no Kubernetes or Core calls), so the rules are tested alone.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

GATE1_TAINT = "switch.dev/gate1"
HOSTNAME_KEY = "kubernetes.io/hostname"
ZONE_KEY = "topology.kubernetes.io/zone"


@dataclass(frozen=True)
class Node:
    """An agents machine as the placer sees it: read from the node list, never from Core."""

    name: str
    zone: str
    ready: bool = True
    schedulable: bool = True  # not cordoned
    taints: frozenset[str] = frozenset()
    draining: bool = False  # being removed by the autoscaler, or drained by an operator
    free_memory_bytes: int = 0  # allocatable minus what's requested; a tie-breaker only

    @property
    def candidate(self) -> bool:
        """Whether a planned placement may choose this machine at all."""
        return (
            self.ready and self.schedulable and not self.draining and GATE1_TAINT not in self.taints
        )


@dataclass(frozen=True)
class Limits:
    """`target`: the most boxes planned onto a machine in normal running. `ceiling`: the most a machine may hold in a
    failover (the scheduler may go there, the placer never plans past target unless nothing is below it)."""

    target: int = 7
    ceiling: int = 12

    def __post_init__(self) -> None:
        if not 1 <= self.target <= self.ceiling:
            raise ValueError("placement limits need 1 <= target <= ceiling")


@dataclass(frozen=True)
class Decision:
    zone: str
    first: str | None  # the chosen machine; None when the zone has no candidate machine at all
    second: (
        str | None
    )  # the next best in the same zone, for when the first is gone by the time the pod is made
    reason: str  # below_target, over_target, first_start, no_machine_in_zone
    count_before: int  # boxes on (or planned for) the chosen machine before this one


@dataclass
class Ledger:
    """Choices made but not yet seen as running pods, so several wakes at once don't all pick the same machine.
    Held in memory only; rebuilt empty at start, which at worst lets one decision be made twice."""

    pending: dict[str, str] = field(default_factory=dict)  # namespace -> machine chosen

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for node in self.pending.values():
            out[node] = out.get(node, 0) + 1
        return out

    def settle(self, running: Mapping[str, str]) -> None:
        """Forget choices whose box now runs somewhere (wherever it actually landed)."""
        for namespace in list(self.pending):
            if namespace in running:
                del self.pending[namespace]


def box_counts(running: Mapping[str, str], ledger: Ledger | None = None) -> dict[str, int]:
    """Boxes per machine: running box pods (namespace -> node) plus the ledger's pending choices."""
    counts: dict[str, int] = {}
    for node in running.values():
        counts[node] = counts.get(node, 0) + 1
    if ledger:
        for node, n in ledger.counts().items():
            counts[node] = counts.get(node, 0) + n
    return counts


def choose_zone(nodes: Iterable[Node], counts: Mapping[str, int], limits: Limits) -> str | None:
    """A new user's home zone: the zone with the most planned room left (target x candidate machines - boxes there),
    then the fewest boxes, then the zone's name. None when no zone has a candidate machine."""
    room: dict[str, int] = {}
    boxes: dict[str, int] = {}
    for node in nodes:
        boxes[node.zone] = boxes.get(node.zone, 0) + counts.get(node.name, 0)
        if node.candidate:
            room[node.zone] = room.get(node.zone, 0) + limits.target
    for zone in room:
        room[zone] -= boxes.get(zone, 0)
    if not room:
        return None
    return min(room, key=lambda z: (-room[z], boxes.get(z, 0), z))


def choose(
    nodes: Iterable[Node], counts: Mapping[str, int], limits: Limits, home_zone: str | None
) -> Decision | None:
    """Where a box should start. `home_zone` is its disk's zone, or None on a first start (then a zone is chosen).

    Candidates are the zone's ready, schedulable, untainted, not-draining machines. Fewest boxes wins, then the most
    free memory, then the name, so the result is repeatable. With every candidate at or past target, the emptiest is
    still chosen (`over_target`): placing late is better than not placing. Returns None only on a first start when
    no zone has a candidate machine.
    """
    nodes = list(nodes)
    first_start = home_zone is None
    zone = home_zone if home_zone is not None else choose_zone(nodes, counts, limits)
    if zone is None:
        return None
    ranked = sorted(
        (n for n in nodes if n.zone == zone and n.candidate),
        key=lambda n: (counts.get(n.name, 0), -n.free_memory_bytes, n.name),
    )
    if not ranked:
        return Decision(zone, None, None, "no_machine_in_zone", 0)
    best = ranked[0]
    before = counts.get(best.name, 0)
    if first_start:
        reason = "first_start"
    elif before < limits.target:
        reason = "below_target"
    else:
        reason = "over_target"
    second = ranked[1].name if len(ranked) > 1 else None
    return Decision(zone, best.name, second, reason, before)


def node_affinity(decision: Decision, first_start: bool) -> dict:
    """The preferred node affinity for the box's pod template: the first choice (100), the second (50) and, on a
    first start, the chosen zone (20). Preferred only, never required, so it never blocks a start."""
    terms = []
    if decision.first:
        terms.append(_term(100, HOSTNAME_KEY, decision.first))
    if decision.second:
        terms.append(_term(50, HOSTNAME_KEY, decision.second))
    if first_start or not decision.first:
        terms.append(_term(20, ZONE_KEY, decision.zone))
    return {"preferredDuringSchedulingIgnoredDuringExecution": terms}


def template_patch(decision: Decision, first_start: bool) -> dict:
    """A JSON merge patch for the box StatefulSet that sets only `affinity.nodeAffinity` (the pod anti-affinity term
    already in the template is a sibling key, so it's kept)."""
    return {
        "spec": {
            "template": {
                "spec": {"affinity": {"nodeAffinity": node_affinity(decision, first_start)}}
            }
        }
    }


def _term(weight: int, key: str, value: str) -> dict:
    return {
        "weight": weight,
        "preference": {"matchExpressions": [{"key": key, "operator": "In", "values": [value]}]},
    }


@dataclass(frozen=True)
class BoxState:
    """One box, for rebalancing: where it runs, whether all its agents rest, and when it was last moved."""

    namespace: str
    node: str
    resting: bool
    last_moved: float | None = None


@dataclass(frozen=True)
class MoveLimits:
    per_minute: int = 2
    cooldown_s: float = 3600.0  # never move the same box again within an hour


def plan_moves(
    boxes: Iterable[BoxState],
    nodes: Iterable[Node],
    limits: Limits,
    move_limits: MoveLimits,
    now: float,
    moves_last_minute: int,
) -> list[tuple[str, str]]:
    """Which boxes to move back under target, as (namespace, from node). Only boxes whose agents all rest, from a
    machine over target, at most one per machine per pass, within the per-minute budget, never a box moved within
    the cooldown, and nothing at all while any machine in that zone isn't ready (a failure may still be settling).
    Where each moved box goes is decided by `choose` when it starts again."""
    nodes = list(nodes)
    boxes = list(boxes)
    zone_of = {n.name: n.zone for n in nodes}
    unsettled = {n.zone for n in nodes if not n.ready}
    counts: dict[str, int] = {}
    for b in boxes:
        counts[b.node] = counts.get(b.node, 0) + 1
    budget = max(0, move_limits.per_minute - moves_last_minute)
    moves: list[tuple[str, str]] = []
    moved_from: set[str] = set()
    # The fullest machines first, so the worst overload is eased first.
    for b in sorted(boxes, key=lambda b: (-counts.get(b.node, 0), b.node, b.namespace)):
        if len(moves) >= budget:
            break
        if b.node in moved_from or counts.get(b.node, 0) <= limits.target:
            continue
        if zone_of.get(b.node) in unsettled or not b.resting:
            continue
        if b.last_moved is not None and now - b.last_moved < move_limits.cooldown_s:
            continue
        # Only worth it if some other candidate in the zone is below target to take it.
        zone = zone_of.get(b.node)
        if not any(
            n.candidate
            and n.zone == zone
            and n.name != b.node
            and counts.get(n.name, 0) < limits.target
            for n in nodes
        ):
            continue
        moves.append((b.namespace, b.node))
        moved_from.add(b.node)
    return moves


@dataclass(frozen=True)
class PlaceholderLimits:
    """Placeholders: low-priority pods the size of one box, one set per zone. A pending placeholder makes the
    autoscaler add a machine in its zone before real boxes have to wait."""

    max_per_zone: int = 3

    def __post_init__(self) -> None:
        if not 0 <= self.max_per_zone <= 20:
            raise ValueError("placeholder limit must be 0 to 20 per zone")


def placeholder_counts(
    nodes: Iterable[Node],
    counts: Mapping[str, int],
    limits: Limits,
    current: Mapping[str, int],
    placeholder_limits: PlaceholderLimits,
) -> dict[str, int]:
    """How many placeholders each zone should have next, one step at a time.

    Up by one when no candidate machine in the zone is below target (full, or none ready: either way the zone needs
    a machine). Down by one when the zone has at least a whole machine's worth of planned room. Otherwise unchanged,
    so the count doesn't swing back and forth around one box. Every zone with an agents machine gets an answer.
    """
    room: dict[str, int] = {}
    below: dict[str, bool] = {}
    for node in nodes:
        room.setdefault(node.zone, 0)
        below.setdefault(node.zone, False)
        if node.candidate:
            left = limits.target - counts.get(node.name, 0)
            room[node.zone] += max(0, left)
            below[node.zone] = below[node.zone] or left > 0
    out: dict[str, int] = {}
    for zone in room:
        now = max(0, current.get(zone, 0))
        if not below[zone]:
            out[zone] = min(now + 1, placeholder_limits.max_per_zone)
        elif room[zone] >= limits.target:
            out[zone] = max(now - 1, 0)
        else:
            out[zone] = min(now, placeholder_limits.max_per_zone)
    return out
