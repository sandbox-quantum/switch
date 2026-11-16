"""The placer: chooses where a stopped box starts, just before the box scaler starts it.

It reads the agents machines, where the box pods run, and the box's disk zone, asks `placement.choose`, and writes
the answer as a preferred node affinity on the box's StatefulSet template. It runs only for a box at replicas 0, so
changing the template never restarts a running box. Any failure here is logged and the box starts anyway: placement
is a preference, never a gate on starting.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable, Mapping
from typing import Protocol
from urllib.parse import quote

from .placement import (
    GATE1_TAINT,
    ZONE_KEY,
    BoxState,
    Ledger,
    Limits,
    MoveLimits,
    Node,
    PlaceholderLimits,
    box_counts,
    choose,
    placeholder_counts,
    plan_moves,
    template_patch,
)

logger = logging.getLogger(__name__)

BOX_LABEL = "app=switch-box"
NAMESPACE_RE = re.compile(r"agents-user-[a-z0-9-]+")  # the box scaler's own pattern
CALL_TIMEOUT_S = 4.0  # a slow API must not hold up every box's start
SNAPSHOT_MAX_AGE_S = 5.0  # a burst of wakes in one scaler pass shares one read of nodes and pods
POOL_LABEL = "switch.dev/pool"
DEFAULT_POOL = "agents"  # l3 pool machines are "agents-l3" (SWITCH_PLACEMENT_POOL)
POOL_RE = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
ZONE_RE = re.compile(r"[a-z0-9-]{1,40}")  # zone names go into placeholder Deployment names
PLACEHOLDER_PREFIX = "switch-placeholder-"
PLACEHOLDER_LABEL = "app=switch-placeholder"
PLACEHOLDER_ZONE_LABEL = "switch.dev/placeholder-zone"


class PlacementKube(Protocol):
    def nodes(self) -> list[Node]: ...
    def running_boxes(
        self,
    ) -> dict[str, str]: ...  # box namespace -> node, for box pods scheduled on a node
    def home_zone(
        self, namespace: str
    ) -> str | None: ...  # the zone of the box's bound disk; None if unbound
    def patch_template(self, namespace: str, patch: dict) -> None: ...
    def set_box_replicas(
        self, namespace: str, replicas: int
    ) -> None: ...  # a move: stop it so it starts elsewhere
    def placeholders(self) -> dict[str, int]: ...  # zone -> placeholder replicas now
    def set_placeholders(self, zone: str, replicas: int) -> None: ...


class Placer:
    """`place` runs for each box start. `tick` runs once at the end of each scaler pass and does the two optional
    jobs: moving resting boxes back under target (`moves`) and sizing the per-zone placeholders (`placeholders`).
    Both are off unless switched on (`placer_from_env`)."""

    def __init__(
        self,
        kube: PlacementKube,
        limits: Limits | None = None,
        clock: Callable[[], float] = time.monotonic,
        move_limits: MoveLimits | None = None,
        placeholder_limits: PlaceholderLimits | None = None,
        moves: bool = False,
        placeholders: bool = False,
    ):
        self._kube = kube
        self._limits = limits or Limits()
        self._clock = clock
        self._move_limits = move_limits or MoveLimits()
        self._placeholder_limits = placeholder_limits or PlaceholderLimits()
        self._moves_on = moves
        self._placeholders_on = placeholders
        self._snapshot: tuple[float, list[Node], dict[str, str]] | None = None
        self._recent_moves: list[float] = []  # when each move in the last minute was made
        self._moved_at: dict[str, float] = {}  # namespace -> when it was last moved (the cooldown)
        self.ledger = Ledger()

    def _cluster(self) -> tuple[list[Node], dict[str, str]]:
        """Nodes and running boxes, read once and shared by every placement within a few seconds (one scaler pass):
        the ledger counts what was chosen since, so a shared read can't put a burst on one machine."""
        now = self._clock()
        if self._snapshot is None or now - self._snapshot[0] > SNAPSHOT_MAX_AGE_S:
            self._snapshot = (now, self._kube.nodes(), self._kube.running_boxes())
        return self._snapshot[1], self._snapshot[2]

    def place(self, namespace: str) -> None:
        """Writes the box's preferred machine. Never raises: a failure means the scheduler alone decides."""
        try:
            if not NAMESPACE_RE.fullmatch(namespace):
                logger.warning("Box %r: not placed, not a user box namespace.", namespace)
                return
            nodes, running = self._cluster()
            self.ledger.settle(running)
            zone = self._kube.home_zone(namespace)
            decision = choose(nodes, box_counts(running, self.ledger), self._limits, zone)
            if decision is None:
                logger.warning(
                    "Box %s: not placed, no zone has a machine that can take it (scheduler decides).",
                    namespace,
                )
                return
            self._kube.patch_template(namespace, template_patch(decision, first_start=zone is None))
            if decision.first:
                self.ledger.pending[namespace] = decision.first
            zone_boxes = sum(
                box_counts(running, self.ledger).get(n.name, 0)
                for n in nodes
                if n.zone == decision.zone
            )
            logger.info(
                "Box placed: %s zone=%s machine=%s second=%s reason=%s machine_boxes_before=%d zone_boxes=%d",
                namespace,
                decision.zone,
                decision.first,
                decision.second,
                decision.reason,
                decision.count_before,
                zone_boxes,
            )
        except Exception as exc:  # placement is a preference: never stop a start over it
            logger.warning(
                "Box %s: not placed (%s); the scheduler decides.", namespace, type(exc).__name__
            )

    def tick(self, machines: list[dict], boxes: Mapping[str, str]) -> None:
        """The end-of-pass jobs. Never raises: each job's failure is logged and the next pass tries again."""
        if self._moves_on:
            try:
                self.rebalance(machines, boxes)
            except Exception as exc:
                logger.warning("Moves skipped this pass (%s).", type(exc).__name__)
        if self._placeholders_on:
            try:
                self.size_placeholders()
            except Exception as exc:
                logger.warning("Placeholders not sized this pass (%s).", type(exc).__name__)

    def rebalance(self, machines: list[dict], boxes: Mapping[str, str]) -> list[str]:
        """Stops resting boxes on machines over target, within the limits in `plan_moves`; the box scaler starts
        each one again on its next pass, and `place` chooses where. Returns the namespaces moved.

        Resting comes from Core's machine list (`resting: true`). A machine without that field counts as awake, so
        with a Core that doesn't send it, nothing ever moves. Only a box Core wants running and sees ready, and that
        isn't still waiting to start, can move. Every running box pod counts toward its machine, ours or not."""
        nodes, running = self._cluster()
        now = self._clock()
        self._recent_moves = [t for t in self._recent_moves if now - t < 60]
        states = {
            ns: BoxState(ns, node, False, self._moved_at.get(ns)) for ns, node in running.items()
        }
        for raw in machines:
            namespace = boxes.get(str(raw.get("machine_id", "")))
            if namespace is None or namespace not in running or namespace in self.ledger.pending:
                continue
            resting = (
                raw.get("resting") is True
                and raw.get("desired_state") == "running"
                and raw.get("state") == "ready"
            )
            states[namespace] = BoxState(
                namespace, running[namespace], resting, self._moved_at.get(namespace)
            )
        moves = plan_moves(
            states.values(), nodes, self._limits, self._move_limits, now, len(self._recent_moves)
        )
        counts = box_counts(running)
        moved = []
        for namespace, source in moves:
            if not NAMESPACE_RE.fullmatch(namespace) or namespace not in boxes.values():
                continue  # only boxes this scaler owns, and so will start again
            self._kube.set_box_replicas(namespace, 0)
            self._recent_moves.append(now)
            self._moved_at[namespace] = now
            moved.append(namespace)
            logger.info(
                "Box moving: %s from=%s machine_boxes=%d target=%d (resting; it starts again next pass)",
                namespace,
                source,
                counts.get(source, 0),
                self._limits.target,
            )
        if moved:
            self._snapshot = None  # the next placement reads the cluster again
        return moved

    def size_placeholders(self) -> dict[str, int]:
        """Moves each zone's placeholder count one step towards what `placeholder_counts` asks. Returns the changes."""
        nodes, running = self._cluster()
        current = self._kube.placeholders()
        wanted = placeholder_counts(
            nodes, box_counts(running, self.ledger), self._limits, current, self._placeholder_limits
        )
        changed = {}
        for zone, n in sorted(wanted.items()):
            if n == current.get(zone, 0) or not ZONE_RE.fullmatch(zone):
                continue
            if zone not in current:
                logger.warning("Zone %s: no placeholder set exists; wanted %d.", zone, n)
                continue
            self._kube.set_placeholders(zone, n)
            changed[zone] = n
            logger.info("Placeholders: zone=%s from=%d to=%d", zone, current[zone], n)
        return changed


def nodes_from_list(items: list[dict]) -> list[Node]:
    """Agents machines from a node list (`GET /api/v1/nodes?labelSelector=switch.dev/pool=agents`)."""
    out = []
    for item in items:
        meta, spec, status = item.get("metadata", {}), item.get("spec", {}), item.get("status", {})
        labels = meta.get("labels", {}) or {}
        zone = labels.get(ZONE_KEY)
        if not zone:
            continue  # a machine with no zone can't be matched to a disk: never planned onto
        conditions = {c.get("type"): c.get("status") for c in status.get("conditions", []) or []}
        taints = frozenset(t.get("key", "") for t in spec.get("taints", []) or [])
        out.append(
            Node(
                name=meta.get("name", ""),
                zone=zone,
                ready=conditions.get("Ready") == "True",
                schedulable=not spec.get("unschedulable", False),
                taints=taints,
                draining=any(
                    k.startswith(("karpenter.sh/disrupt", "ToBeDeletedByClusterAutoscaler"))
                    for k in taints
                ),
            )
        )
    return out


def running_from_pods(items: list[dict]) -> dict[str, str]:
    """Box namespace -> node, from the box pods (`app=switch-box`) that are scheduled and not finished."""
    out: dict[str, str] = {}
    for item in items:
        meta, spec, status = item.get("metadata", {}), item.get("spec", {}), item.get("status", {})
        node = spec.get("nodeName")
        if (
            node
            and status.get("phase") not in ("Succeeded", "Failed")
            and not meta.get("deletionTimestamp")
        ):
            out[meta.get("namespace", "")] = node
    return out


def zone_from_pv(pv: Mapping) -> str | None:
    """The zone a bound EBS volume lives in, from its required node affinity."""
    terms = (((pv.get("spec") or {}).get("nodeAffinity") or {}).get("required") or {}).get(
        "nodeSelectorTerms"
    ) or []
    for term in terms:
        for expr in term.get("matchExpressions", []) or []:
            if expr.get("key") in (ZONE_KEY, "topology.ebs.csi.aws.com/zone") and expr.get(
                "values"
            ):
                return expr["values"][0]
    return None


class PlacementKubeApi:
    """The reads and the one patch the placer needs, over the scaler's own Kubernetes client (`KubeApi._call`), each
    with a short timeout. Its PATCH is a JSON merge patch (`application/merge-patch+json`), which merges maps, so the
    template's `podAntiAffinity` beside the `nodeAffinity` it sets is kept."""

    def __init__(self, call, placeholder_namespace: str | None = None, pool: str = DEFAULT_POOL):
        if not POOL_RE.fullmatch(pool):
            raise ValueError("not a machine pool name")
        self._raw = call
        self._placeholder_ns = placeholder_namespace
        self._pool = f"{POOL_LABEL}={pool}"

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        return self._raw(method, path, body, timeout=CALL_TIMEOUT_S)

    @staticmethod
    def _box(namespace: str) -> str:
        if not NAMESPACE_RE.fullmatch(namespace):
            raise ValueError("not a user box namespace")
        return namespace

    def nodes(self) -> list[Node]:
        return nodes_from_list(
            self._call("GET", f"/api/v1/nodes?labelSelector={quote(self._pool)}").get("items", [])
        )

    def running_boxes(self) -> dict[str, str]:
        return running_from_pods(
            self._call("GET", f"/api/v1/pods?labelSelector={quote(BOX_LABEL)}").get("items", [])
        )

    def home_zone(self, namespace: str) -> str | None:
        pvc = self._call(
            "GET", f"/api/v1/namespaces/{self._box(namespace)}/persistentvolumeclaims/data"
        )
        volume = (pvc.get("spec") or {}).get("volumeName")
        if not volume:
            return None  # not bound yet: a first start
        return zone_from_pv(self._call("GET", f"/api/v1/persistentvolumes/{volume}"))

    def patch_template(self, namespace: str, patch: dict) -> None:
        self._call(
            "PATCH", f"/apis/apps/v1/namespaces/{self._box(namespace)}/statefulsets/box", patch
        )

    def set_box_replicas(self, namespace: str, replicas: int) -> None:
        self._call(
            "PATCH",
            f"/apis/apps/v1/namespaces/{self._box(namespace)}/statefulsets/box/scale",
            {"spec": {"replicas": int(replicas)}},
        )

    def _placeholder_path(self) -> str:
        if not self._placeholder_ns:
            raise ValueError("no placeholder namespace set")
        return f"/apis/apps/v1/namespaces/{self._placeholder_ns}/deployments"

    def placeholders(self) -> dict[str, int]:
        listed = self._call(
            "GET", f"{self._placeholder_path()}?labelSelector={quote(PLACEHOLDER_LABEL)}"
        )
        out: dict[str, int] = {}
        for item in listed.get("items", []):
            meta = item.get("metadata", {})
            zone = (meta.get("labels") or {}).get(PLACEHOLDER_ZONE_LABEL, "")
            if meta.get("name") == PLACEHOLDER_PREFIX + zone and ZONE_RE.fullmatch(zone):
                out[zone] = int((item.get("spec") or {}).get("replicas") or 0)
        return out

    def set_placeholders(self, zone: str, replicas: int) -> None:
        if not ZONE_RE.fullmatch(zone):
            raise ValueError("not a zone name")
        self._call(
            "PATCH",
            f"{self._placeholder_path()}/{PLACEHOLDER_PREFIX}{zone}/scale",
            {"spec": {"replicas": int(replicas)}},
        )


def make_placer(
    kube_call, enabled: bool = False, limits: Limits | None = None
) -> Callable[[str], None] | None:
    """The `place` the box scaler takes, or None (the default): placement stays off unless switched on, e.g.
    `run(core, kube, boxes, place=make_placer(kube._call, enabled=True))`."""
    if not enabled:
        return None
    return Placer(PlacementKubeApi(kube_call), limits).place


ENV_PLACEMENT = "SWITCH_BOX_PLACEMENT"
ENV_MOVES = "SWITCH_BOX_MOVES"
ENV_PLACEHOLDERS = "SWITCH_BOX_PLACEHOLDERS"
ENV_PLACEHOLDER_NS = "SWITCH_PLACEHOLDER_NAMESPACE"
ENV_TARGET = "SWITCH_PLACEMENT_TARGET"
ENV_CEILING = "SWITCH_PLACEMENT_CEILING"
ENV_POOL = "SWITCH_PLACEMENT_POOL"
K8S_NAME_RE = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")


def _switch(env: Mapping[str, str], key: str) -> bool:
    value = env.get(key, "off").strip().lower()
    if value not in ("on", "off"):
        raise ValueError(f"{key} must be on or off")
    return value == "on"


def _number(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    if not raw.isdigit():
        raise ValueError(f"{key} must be a whole number")
    return int(raw)


def placer_from_env(kube_call, env: Mapping[str, str]) -> Placer | None:
    """The switch-on flags, all off by default. Placement (`SWITCH_BOX_PLACEMENT=on`) must be on for moves or
    placeholders to be. A value other than on or off, or a bad number, refuses to start rather than guessing.

    The scaler's run script then passes `place=placer.place, rebalance=placer.tick` to `box_scaler.run`, or
    nothing at all when this returns None."""
    placing = _switch(env, ENV_PLACEMENT)
    moves = _switch(env, ENV_MOVES)
    placeholders = _switch(env, ENV_PLACEHOLDERS)
    if (moves or placeholders) and not placing:
        raise ValueError(f"{ENV_MOVES} and {ENV_PLACEHOLDERS} need {ENV_PLACEMENT}=on")
    if not placing:
        return None
    namespace = env.get(ENV_PLACEHOLDER_NS, "").strip() or None
    if placeholders and (namespace is None or not K8S_NAME_RE.fullmatch(namespace)):
        raise ValueError(
            f"{ENV_PLACEHOLDERS}=on needs {ENV_PLACEHOLDER_NS} set to a namespace name"
        )
    limits = Limits(
        _number(env, ENV_TARGET, Limits.target), _number(env, ENV_CEILING, Limits.ceiling)
    )
    pool = env.get(ENV_POOL, "").strip() or DEFAULT_POOL
    if not POOL_RE.fullmatch(pool):
        raise ValueError(f"{ENV_POOL} must be a machine pool name")
    logger.info(
        "Placement on: pool=%s target=%d ceiling=%d moves=%s placeholders=%s",
        pool,
        limits.target,
        limits.ceiling,
        "on" if moves else "off",
        "on" if placeholders else "off",
    )
    return Placer(
        PlacementKubeApi(kube_call, namespace, pool), limits, moves=moves, placeholders=placeholders
    )


__all__ = [
    "GATE1_TAINT",
    "Placer",
    "PlacementKube",
    "PlacementKubeApi",
    "make_placer",
    "placer_from_env",
    "nodes_from_list",
    "running_from_pods",
    "zone_from_pv",
]
