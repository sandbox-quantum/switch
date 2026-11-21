"""Drain a machine when a Switch operator asks (operator side).

Core keeps the action: an operator asks Core to drain one agents machine, Core
fixes the machine's node uid at that moment and writes a run-once request, and this worker carries it out on the
cluster, one box at a time, reporting codes back.

What the worker may do is deliberately small, and it runs on its own account, `switch-drain` (rights v1.4):

- It learns of drains only from Core's `GET /gateway/hosted-controller/actions?kind=drain`. An action names a node
  and the node's uid, and nothing else: no person, reason or box.
- **Before every step it reports and every cluster write it makes, it checks the node:** the live node's uid must
  equal the uid Core fixed, and the node must still be in the agents pool. Otherwise the drain fails with
  `node_replaced` and nothing more is touched. A missing uid, on either side, is a failure, never a pass.
- Its changes to the cluster are: cordon the node (`spec.unschedulable` false to true, with the node's uid as a
  precondition, so a replaced node is refused by the API server itself); evict `box-0` in a box namespace from its
  own box map, with the pod's uid as a precondition; and, when room is short, one placeholder pod in
  `switch-drain-room`, in the admission policy's exact shape. Never an uncordon, a force delete or a retry.
- A box Core doesn't want running (paused, turned off or stopped) is never evicted: the scaler takes it to 0, and it
  counts as moved once its pod is gone. After every eviction Core's wish is read again, so a box paused in the
  moment between the read and the eviction counts as moved once the scaler has removed the new pod: Core refuses that box, so the pod can't reach Core or the AI.
- It never gets ahead of Core: no cluster write happens until every earlier step has been recorded. A failure Core
  hasn't recorded is held and re-sent first on every pass, with no cluster call until it's in; each box is asked to
  move at most once per drain; and a box with no pod never counts as moved, after a restart too.
- It never drains the machine it runs on: it claims the drain, then reports `own_node` at once, with no cluster call
  between (Core takes failures only after `claimed`). That matters for the agents pool.

Nothing is logged but the action id, machine ids from the box map, step codes and counts.
"""

from __future__ import annotations

import json
import logging
import re
import ssl
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener
from uuid import UUID

from .box_scaler import NAMESPACE_RE, RUNNING, check_core_origin
from .cluster_watch import NODE_UID_RE
from .placement import Limits
from .placer import POOL_LABEL, nodes_from_list
from .restart_actions import parse_time, pod_facts

logger = logging.getLogger(__name__)

KIND = "drain"
POD = "box-0"
ROOM_NAMESPACE = "switch-drain-room"
PLACEHOLDER_PREFIX = "drain-room-"
PLACEHOLDER_CPU, PLACEHOLDER_MEMORY = "250m", "1Gi"  # exactly the policy's one-box size
PLACEHOLDER_PRIORITY_CLASS = "switch-placeholder"  # the placer's own low class (priority <= 0)
ZONE_KEY = "topology.kubernetes.io/zone"

ROOM_WITHIN_S = 15 * 60.0  # a new machine must come within 15 minutes
BOX_WITHIN_S = (
    5 * 60.0
)  # each box Ready elsewhere (or gone, if Core doesn't want it running) within 5 minutes
EXPIRY_MARGIN_S = 30.0  # no cluster write this close to the action's expiry
MAX_BOXES = 200  # Core's bound on counts

# A drain finishes with state `done` on its last step, `moving` (Core has no separate done step).
CLAIMED, WAITING, ROOM_OK, CORDONED, MOVING = (
    "claimed",
    "waiting_for_machine",
    "room_ok",
    "cordoned",
    "moving",
)
REPEATABLE = (WAITING, MOVING)
NO_MACHINE_IN_TIME, EVICT_REFUSED, BOX_NOT_READY, STOPPED_PARTWAY, NODE_REPLACED = (
    "no_machine_in_time",
    "evict_refused",
    "box_not_ready",
    "stopped_partway",
    "node_replaced",
)
# The worker never drains the machine it runs on: it claims, then reports this at once.
OWN_NODE = "own_node"
# A 403 or 422 on the cordon: a missing right or a policy mismatch, told apart from a replaced machine.
CORDON_REFUSED = "cordon_refused"
STATE_RUNNING, STATE_DONE, STATE_FAILED = "running", "done", "failed"
FAILURES = (
    NO_MACHINE_IN_TIME,
    EVICT_REFUSED,
    BOX_NOT_READY,
    STOPPED_PARTWAY,
    NODE_REPLACED,
    OWN_NODE,
    CORDON_REFUSED,
)

# A Kubernetes node name (RFC 1123 subdomain), at most 253 characters.
NODE_NAME_RE = re.compile(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*")
PAUSE_IMAGE_RE = re.compile(r"[a-z0-9][a-z0-9._/:-]{0,250}@sha256:[0-9a-f]{64}")


class StepRefused(Exception):
    """Core answered 409: the step is no longer allowed (claimed elsewhere, finished or expired)."""


class NodeChanged(Exception):
    """The live node is not the one Core fixed: gone, a different uid, no uid, or out of the agents pool."""


class Kube(Protocol):
    def node(self, name: str) -> dict[str, Any] | None: ...
    def nodes(self) -> list[dict[str, Any]]: ...
    def cordon(self, name: str, uid: str) -> None: ...
    def box_pod(self, namespace: str) -> dict[str, Any] | None: ...
    def evict(self, namespace: str, pod_uid: str) -> None: ...
    def placeholder(self, name: str) -> dict[str, Any] | None: ...
    def create_placeholder(self, body: dict[str, Any]) -> None: ...
    def delete_placeholder(self, name: str) -> None: ...


class Core(Protocol):
    def open_actions(self) -> list[dict[str, Any]]: ...
    def step(
        self, action_id: str, step: str, state: str, counts: dict[str, int] | None = None
    ) -> None: ...
    def machines(self) -> list[dict[str, Any]]: ...


def placeholder_name(action_id: str) -> str:
    """One fixed name per drain, so a restarted worker finds its own placeholder (`drain-room-<20 hex>`)."""
    return PLACEHOLDER_PREFIX + UUID(action_id).hex[:20]


def placeholder_body(name: str, image: str, pool: str, zone: str) -> dict[str, Any]:
    """The one placeholder shape `switch-operator-placeholder-shape` allows: the pinned pause image, one box in size,
    no token, volumes, env or host access, the placer's low priority class, asking only for an agents machine in the
    zone and never naming a node. Restricted pod security on `switch-drain-room` is met too."""
    size = {"cpu": PLACEHOLDER_CPU, "memory": PLACEHOLDER_MEMORY}
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": ROOM_NAMESPACE,
            "labels": {"app": "switch-drain-room"},
        },
        "spec": {
            "containers": [
                {
                    "name": "pause",
                    "image": image,
                    "resources": {"requests": dict(size), "limits": dict(size)},
                    "securityContext": {
                        "allowPrivilegeEscalation": False,
                        "readOnlyRootFilesystem": True,
                        "capabilities": {"drop": ["ALL"]},
                        "runAsNonRoot": True,
                        "runAsUser": 65535,
                        "runAsGroup": 65535,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                }
            ],
            "restartPolicy": "Always",
            "terminationGracePeriodSeconds": 0,
            "priorityClassName": PLACEHOLDER_PRIORITY_CLASS,
            "automountServiceAccountToken": False,
            "enableServiceLinks": False,
            "nodeSelector": {POOL_LABEL: pool, ZONE_KEY: zone},
        },
    }


@dataclass
class _Drain:
    action_id: str
    node: str
    node_uid: str
    requested: float | None
    expires: float | None
    step: str | None  # the last step Core has recorded
    zone: str | None = None
    total: int | None = None
    moved: int = 0  # the last count Core has recorded
    members: set[str] = field(default_factory=set)  # box namespaces counted in `total`
    waiting_since: float | None = None
    # namespace -> when it started waiting to be moved
    since: dict[str, float] = field(default_factory=dict)
    # box namespaces this drain has asked to evict: never asked twice
    evicted: set[str] = field(default_factory=set)
    # a failure Core hasn't recorded yet: re-sent before anything else, with no cluster call until it's in
    pending: tuple[str, dict[str, int] | None] | None = None


@dataclass
class _Box:
    namespace: str
    machine_id: str
    pod: dict[str, Any] | None  # pod_facts plus "node"
    wanted: bool  # Core wants it running

    def on(self, node: str) -> bool:
        return self.pod is not None and self.pod["node"] == node

    def moved(self, node: str) -> bool:
        """Off the node and settled: Ready elsewhere if Core wants it running, gone if not."""
        if self.on(node):
            return False
        if not self.wanted:
            return self.pod is None
        return self.pod is not None and self.pod["ready"] and not self.pod["deleting"]


@dataclass
class DrainWorker:
    kube: Kube
    core: Core
    boxes: Callable[
        [], Mapping[str, str]
    ]  # machine id -> box namespace, the operator's own map, read each pass
    pause_image: str
    pool: str = "agents"
    limits: Limits = field(default_factory=Limits)
    clock: Callable[[], float] = time.time
    own_node: str = ""  # the node this worker runs on (`SWITCH_DRAIN_OWN_NODE`): never drained
    _drain: _Drain | None = None

    # ------------------------------------------------------------------ the pass

    def tick(self) -> None:
        """One pass: list Core's open drains and move the one drain on by at most one cluster write."""
        try:
            actions = self.core.open_actions()
        except Exception as exc:  # never stop the worker's loop
            logger.warning("Could not list drain actions (%s).", type(exc).__name__)
            return
        chosen = self._choose(actions)
        if self._drain is not None and (
            chosen is None or chosen["action_id"] != self._drain.action_id
        ):
            self._let_go(
                "no longer listed by Core"
            )  # finished, expired, or hidden (node left or uid changed)
        if chosen is None:
            return
        if self._drain is None:
            self._drain = _Drain(
                chosen["action_id"],
                chosen["node"],
                chosen["node_uid"],
                chosen["requested"],
                chosen["expires"],
                chosen["step"],
                total=chosen["total"],
                moved=chosen["moved"],
            )
        drain = self._drain
        if drain.pending is not None:
            self._send_pending(
                drain
            )  # nothing else, and no cluster call, until Core has the failure
            return
        try:
            if drain.expires is not None and self.clock() >= drain.expires - EXPIRY_MARGIN_S:
                self._let_go("at its expiry")  # Core marks it expired; nothing more is touched
                return
            self._advance(drain)
        except NodeChanged:
            self._fail(drain, NODE_REPLACED, counts=self._counts(drain))
        except StepRefused:
            logger.info("Drain %s: Core refused the next step; leaving it.", drain.action_id)
            self._let_go("refused by Core")
        except Exception as exc:
            logger.warning(
                "Drain %s: step failed (%s); trying again next pass.",
                drain.action_id,
                type(exc).__name__,
            )

    def _choose(self, actions: list[dict[str, Any]]) -> dict[str, Any] | None:
        """The one drain to run: our own if Core still lists it, else the oldest well-formed one. Others wait (and
        expire): one drain at a time, as Core enforces too."""
        valid = []
        for action in actions:
            parsed = _parse(action)
            if parsed is None:
                logger.warning("A drain action was out of form; skipped.")
                continue
            valid.append(parsed)
        if self._drain is not None:
            for parsed in valid:
                if parsed["action_id"] == self._drain.action_id:
                    return parsed
        valid.sort(
            key=lambda a: (
                a["requested"] if a["requested"] is not None else float("inf"),
                a["action_id"],
            )
        )
        return valid[0] if valid else None

    def _advance(self, drain: _Drain) -> None:
        if self.own_node and drain.node == self.own_node:
            # Never a cordon or eviction on the worker's own machine. Core takes failures only after `claimed`, so a
            # new drain is claimed first, with no cluster call before or between.
            if drain.step is None:
                self._report(drain, CLAIMED, STATE_RUNNING, check=False)
            self._fail(drain, OWN_NODE, counts=self._counts(drain))
            return
        if drain.step is None:
            try:
                self._check_node(drain)
            except NodeChanged:
                self._report(
                    drain, CLAIMED, STATE_RUNNING, check=False
                )  # claim, then fail: no cluster call between
                raise
            self._report(drain, CLAIMED, STATE_RUNNING)
            return
        if drain.step in (CLAIMED, WAITING):
            self._room(drain)
        elif drain.step == ROOM_OK:
            self._cordon(drain)
        elif drain.step in (CORDONED, MOVING):
            self._move(drain)

    # ------------------------------------------------------------------ steps

    def _room(self, drain: _Drain) -> None:
        self._check_node(drain)
        boxes = self._boxes()
        wanted_here = [b for b in boxes if b.on(drain.node) and b.wanted]
        room = self._free_slots(drain, boxes)
        if room >= len(wanted_here):
            self._report(drain, ROOM_OK, STATE_RUNNING)
            return
        now = self.clock()
        if drain.waiting_since is None:
            # Resumed while waiting: the 15 minutes started no later than the request, so a restart never extends them.
            resumed = drain.step == WAITING and drain.requested is not None
            drain.waiting_since = drain.requested if resumed else now
        if now - drain.waiting_since >= ROOM_WITHIN_S:
            self._fail(drain, NO_MACHINE_IN_TIME)
            return
        name = placeholder_name(drain.action_id)
        if self.kube.placeholder(name) is None:
            self._check_node(drain)
            try:
                self.kube.create_placeholder(
                    placeholder_body(name, self.pause_image, self.pool, drain.zone)
                )
            except HTTPError as exc:
                if exc.code != 409:  # already there: ours, from an earlier pass
                    raise
        self._report(drain, WAITING, STATE_RUNNING)

    def _cordon(self, drain: _Drain) -> None:
        node = self._check_node(drain)
        if not (node.get("spec") or {}).get("unschedulable", False):
            try:
                self.kube.cordon(drain.node, drain.node_uid)
            except HTTPError as exc:
                if exc.code in (
                    404,
                    409,
                ):  # gone, or the uid precondition: not the machine asked for
                    raise NodeChanged() from None
                if exc.code in (
                    403,
                    422,
                ):  # a missing right or the policy refusing: told apart in the audit
                    logger.warning(
                        "Drain %s: the cordon was refused (HTTP %s).", drain.action_id, exc.code
                    )
                    self._fail(drain, CORDON_REFUSED)
                    return
                raise
        self._report(drain, CORDONED, STATE_RUNNING)

    def _move(self, drain: _Drain) -> None:
        self._check_node(drain)
        boxes = self._boxes()
        by_ns = {b.namespace: b for b in boxes}
        now = self.clock()
        if drain.total is None:  # the first `moving`: fix total from the boxes on the node now
            members = {b.namespace for b in boxes if b.on(drain.node)}
            if len(members) > MAX_BOXES:
                raise RuntimeError("more boxes on the machine than Core accepts")
            drain.members, drain.total = members, len(members)
            self._delete_placeholder(drain)  # its room is for the boxes now
            self._report(drain, MOVING, STATE_RUNNING, counts={"moved": 0, "total": drain.total})
            return
        if not drain.members:
            # Resumed after a restart: every box not yet settled that this drain may have moved. That's one still
            # on the node, one with no pod at all (evicted, its new pod not made yet), and one whose pod was made
            # after the request. A box with no pod never counts as moved.
            drain.members = {
                b.namespace
                for b in boxes
                if not b.moved(drain.node)
                and (b.on(drain.node) or b.pod is None or _since(b, drain.requested))
            }
        members = [by_ns[ns] for ns in sorted(drain.members) if ns in by_ns]
        unsettled = [b for b in members if not b.moved(drain.node)]
        moved = max(drain.moved, drain.total - len(unsettled))
        if moved > drain.moved:
            self._report(
                drain, MOVING, STATE_RUNNING, counts={"moved": moved, "total": drain.total}
            )
            return  # one report per pass: never ahead of Core
        if not unsettled:
            self._report(
                drain, MOVING, STATE_DONE, counts={"moved": drain.total, "total": drain.total}
            )
            self._let_go("done")
            return
        # Boxes on their way: evicted (terminating, or not yet Ready elsewhere), or waiting for the scaler to stop them.
        # A box already asked to move is on its way too, even if its pod is still here (an eviction answered 409):
        # it is never asked again, so it settles or ends `box_not_ready`.
        waiting = [
            b
            for b in unsettled
            if not b.on(drain.node)
            or b.pod is None
            or b.pod["deleting"]
            or not b.wanted
            or b.namespace in drain.evicted
        ]
        for b in waiting:
            started = drain.since.setdefault(b.namespace, now)
            if now - started >= BOX_WITHIN_S:
                logger.warning(
                    "Drain %s: machine %s didn't settle in time.", drain.action_id, b.machine_id
                )
                self._fail(drain, BOX_NOT_READY, counts=self._counts(drain))
                return
        if any(
            not b.on(drain.node)
            or (b.pod is not None and b.pod["deleting"])
            or b.namespace in drain.evicted
            for b in waiting
        ):
            return  # one box at a time: wait for the moving one
        evictable = [
            b
            for b in unsettled
            if b.on(drain.node)
            and b.wanted
            and not b.pod["deleting"]
            and b.namespace not in drain.evicted
        ]
        if not evictable:
            return  # only boxes the scaler is stopping, or ones already asked to move, are left
        if self._free_slots(drain, boxes) < 1:
            self._fail(drain, STOPPED_PARTWAY, counts=self._counts(drain))
            return
        box = evictable[0]
        self._evict(drain, box)

    def _evict(self, drain: _Drain, box: _Box) -> None:
        self._check_node(drain)
        pod = pod_facts_on(self.kube.box_pod(box.namespace))
        if (
            pod is None
            or pod["node"] != drain.node
            or pod["deleting"]
            or pod["uid"] != box.pod["uid"]
        ):
            return  # it changed since this pass looked: decide again next pass
        if not self._wanted().get(box.machine_id, False):
            return  # Core no longer wants it running: the scaler stops it, never an eviction
        drain.evicted.add(box.namespace)  # one eviction per box, ever, whatever the answer
        drain.since[box.namespace] = self.clock()
        try:
            self.kube.evict(box.namespace, pod["uid"])
        except HTTPError as exc:
            if exc.code in (
                404,
                409,
            ):  # gone already, or replaced (the uid precondition): look again next pass
                return
            logger.warning(
                "Drain %s: eviction of machine %s refused (HTTP %s).",
                drain.action_id,
                box.machine_id,
                exc.code,
            )
            self._fail(drain, EVICT_REFUSED, counts=self._counts(drain))
            return
        logger.info("Drain %s: machine %s evicted.", drain.action_id, box.machine_id)

    # ------------------------------------------------------------------ helpers

    def _check_node(self, drain: _Drain) -> dict[str, Any]:
        """The live node must be the one Core fixed: same uid, and still in the agents pool."""
        node = self.kube.node(drain.node)
        if node is None:
            raise NodeChanged()
        meta = node.get("metadata") or {}
        uid = meta.get("uid")
        labels = meta.get("labels") or {}
        if not isinstance(uid, str) or not NODE_UID_RE.fullmatch(uid) or uid != drain.node_uid:
            raise NodeChanged()
        if labels.get(POOL_LABEL) != self.pool:
            raise NodeChanged()
        zone = _zone(node)
        if zone is None or (drain.zone is not None and zone != drain.zone):
            raise NodeChanged()  # an agents machine always has one zone; without it, its disks can't be matched
        drain.zone = (
            zone  # learned on every check, so a restarted worker counts room in the right zone
        )
        return node

    def _report(
        self,
        drain: _Drain,
        step: str,
        state: str,
        counts: dict[str, int] | None = None,
        check: bool = True,
    ) -> None:
        """Every step report is preceded by the node check, so Core never records progress on a replaced machine."""
        if check:
            self._check_node(drain)
        try:
            self.core.step(drain.action_id, step, state, counts)
        except StepRefused:
            if not self._already_recorded(drain, step, state, counts):
                raise
        drain.step = step
        if counts is not None:
            drain.moved = counts["moved"]
        logger.info(
            "Drain %s: %s%s.",
            drain.action_id,
            step,
            f" ({counts['moved']} of {counts['total']})" if counts is not None else "",
        )

    def _already_recorded(
        self, drain: _Drain, step: str, state: str, counts: dict[str, int] | None
    ) -> bool:
        """After a 409 on a step that doesn't repeat: whether Core had in fact recorded it, its answer lost on the
        way back. Then the drain carries on, rather than being dropped with its node cordoned. Never for `claimed`:
        Core can't say who claimed, so a lost claim lets the drain expire, with nothing touched."""
        if state != STATE_RUNNING or step in REPEATABLE or step == CLAIMED:
            return False
        for action in self.core.open_actions():
            if action.get("action_id") == drain.action_id:
                return action.get("step") == step and counts is None
        return False

    def _fail(self, drain: _Drain, code: str, counts: dict[str, int] | None = None) -> None:
        """Hold the failure until Core records it. Counts go with it once `total` is fixed: required on
        `stopped_partway`, optional on the others, so the audit says how far it got."""
        drain.pending = (code, counts if drain.total is not None else None)
        self._send_pending(drain)

    def _send_pending(self, drain: _Drain) -> None:
        if drain.pending is None:
            return
        code, counts = drain.pending
        try:
            self.core.step(drain.action_id, code, STATE_FAILED, counts)
        except StepRefused:
            logger.info("Drain %s: Core refused the failure report; leaving it.", drain.action_id)
        except Exception as exc:
            logger.warning(
                "Drain %s: failure %s not recorded yet (%s); holding it, with no cluster call.",
                drain.action_id,
                code,
                type(exc).__name__,
            )
            return
        else:
            logger.warning("Drain %s: failed (%s).", drain.action_id, code)
        self._let_go(code)

    def _counts(self, drain: _Drain) -> dict[str, int] | None:
        if drain.total is None:
            return None
        return {"moved": drain.moved, "total": drain.total}

    def _let_go(self, why: str) -> None:
        drain, self._drain = self._drain, None
        if drain is None:
            return
        try:
            self._delete_placeholder(drain)
        except Exception as exc:
            logger.warning(
                "Drain %s: placeholder not removed (%s).", drain.action_id, type(exc).__name__
            )
        logger.info("Drain %s: let go (%s).", drain.action_id, why)

    def _delete_placeholder(self, drain: _Drain) -> None:
        name = placeholder_name(drain.action_id)
        if self.kube.placeholder(name) is not None:
            try:
                self.kube.delete_placeholder(name)
            except HTTPError as exc:
                if exc.code != 404:
                    raise

    def _wanted(self) -> dict[str, bool]:
        """Machine id -> whether Core wants it running. A machine Core doesn't list is not wanted running."""
        out: dict[str, bool] = {}
        for raw in self.core.machines():
            machine_id = str(raw.get("machine_id", ""))
            out[machine_id] = raw.get("desired_state") == RUNNING
        return out

    def _boxes(self) -> list[_Box]:
        """Every box in the operator's own map, with its pod (read by name) and whether Core wants it running."""
        wanted = self._wanted()
        out = []
        for machine_id, namespace in sorted(self.boxes().items()):
            if not NAMESPACE_RE.fullmatch(namespace):
                continue
            out.append(
                _Box(
                    namespace,
                    machine_id,
                    pod_facts_on(self.kube.box_pod(namespace)),
                    wanted.get(machine_id, False),
                )
            )
        return out

    def _free_slots(self, drain: _Drain, boxes: list[_Box]) -> int:
        """Room in the zone, counted as the placer counts a failover: `ceiling` minus the boxes on each candidate
        machine (Ready, not cordoned or being removed, past the gate), leaving out the machine being drained."""
        counts: dict[str, int] = {}
        for b in boxes:
            if b.pod is not None and b.pod["node"]:
                counts[b.pod["node"]] = counts.get(b.pod["node"], 0) + 1
        free = 0
        for n in nodes_from_list(self.kube.nodes()):
            if n.name == drain.node or n.zone != drain.zone or not n.candidate:
                continue
            free += max(0, self.limits.ceiling - counts.get(n.name, 0))
        return free


def pod_facts_on(pod: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """`pod_facts`, plus the node the pod is on (empty when not yet scheduled)."""
    facts = pod_facts(pod)
    if facts is None:
        return None
    node = ((pod or {}).get("spec") or {}).get("nodeName")
    facts["node"] = node if isinstance(node, str) else ""
    return facts


def _since(box: _Box, requested: float | None) -> bool:
    """A pod made after the drain was requested: one this drain may have moved, still settling after a restart."""
    created = None if box.pod is None else box.pod["created"]
    return requested is not None and created is not None and created > requested


def _zone(node: Mapping[str, Any]) -> str | None:
    zone = ((node.get("metadata") or {}).get("labels") or {}).get(ZONE_KEY)
    return zone if isinstance(zone, str) and re.fullmatch(r"[a-z0-9-]{1,40}", zone) else None


def _parse(action: Mapping[str, Any]) -> dict[str, Any] | None:
    """A listed drain, checked strictly; None if anything is out of form."""
    if action.get("kind") != KIND:
        return None
    action_id = str(action.get("action_id") or "")
    try:
        if str(UUID(action_id)) != action_id:
            return None
    except ValueError:
        return None
    target = action.get("target")
    if not isinstance(target, dict):
        return None
    node, node_uid = target.get("node"), target.get("node_uid")
    if not isinstance(node, str) or len(node) > 253 or not NODE_NAME_RE.fullmatch(node):
        return None
    if not isinstance(node_uid, str) or not NODE_UID_RE.fullmatch(node_uid):
        return None  # no uid, no drain: never a pass
    step = action.get("step")
    if step is not None and step not in (CLAIMED, WAITING, ROOM_OK, CORDONED, MOVING):
        return None
    counts = action.get("counts")
    total, moved = None, 0
    if counts is not None:
        if not isinstance(counts, dict):
            return None
        total, moved = counts.get("total"), counts.get("moved")
        if isinstance(total, bool) or isinstance(moved, bool):
            return None
        if not (
            isinstance(total, int) and isinstance(moved, int) and 0 <= moved <= total <= MAX_BOXES
        ):
            return None
    if step == MOVING and total is None:
        return None
    requested, expires = (
        parse_time(action.get("requested_at")),
        parse_time(action.get("expires_at")),
    )
    if requested is None or expires is None:
        return None  # without its expiry, the worker couldn't stop in time
    return {
        "action_id": action_id,
        "node": node,
        "node_uid": node_uid,
        "requested": requested,
        "expires": expires,
        "step": step,
        "total": total if step == MOVING else None,
        "moved": moved if step == MOVING else 0,
    }


class _NoRedirect(HTTPRedirectHandler):
    """Refuses every redirect, so a bearer is never carried anywhere but the host it was meant for."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None  # urllib then raises HTTPError for the 3xx


class DrainKubeApi:
    """The drain worker's Kubernetes calls, on `switch-drain`'s own token (read fresh by `token`, every call)."""

    def __init__(self, server: str, token: Callable[[], str], ca_file: str, pool: str):
        self._server = server.rstrip("/")
        self._token = token
        self._ctx = ssl.create_default_context(cafile=ca_file)
        self._pool = pool

    def _call(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        content_type: str = "application/json",
    ) -> Any:
        req = Request(
            self._server + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + self._token(),
                "Accept": "application/json",
                "Content-Type": content_type,
            },
        )
        with build_opener(_NoRedirect, HTTPSHandler(context=self._ctx)).open(req, timeout=20) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    def _get(self, path: str) -> dict[str, Any] | None:
        try:
            return self._call("GET", path)
        except HTTPError as exc:
            if exc.code == 404:
                return None
            raise

    @staticmethod
    def _node_path(name: str) -> str:
        if len(name) > 253 or not NODE_NAME_RE.fullmatch(name):
            raise ValueError("not a node name")
        return f"/api/v1/nodes/{quote(name)}"

    @staticmethod
    def _pod_path(namespace: str) -> str:
        if not NAMESPACE_RE.fullmatch(namespace):
            raise ValueError("not a user box namespace")
        return f"/api/v1/namespaces/{namespace}/pods/{POD}"

    @staticmethod
    def _room_path(name: str = "") -> str:
        if name and not re.fullmatch(r"drain-room-[a-z0-9]{1,20}", name):
            raise ValueError("not a placeholder name")
        return f"/api/v1/namespaces/{ROOM_NAMESPACE}/pods" + (f"/{name}" if name else "")

    def node(self, name: str) -> dict[str, Any] | None:
        return self._get(self._node_path(name))

    def nodes(self) -> list[dict[str, Any]]:
        listed = self._call(
            "GET", "/api/v1/nodes?labelSelector=" + quote(f"{POOL_LABEL}={self._pool}")
        )
        return list((listed or {}).get("items") or [])

    def cordon(self, name: str, uid: str) -> None:
        # The uid in the patch is a precondition: the API server refuses (409) if the node now has another uid.
        body = {"metadata": {"uid": uid}, "spec": {"unschedulable": True}}
        self._call(
            "PATCH", self._node_path(name), body, content_type="application/merge-patch+json"
        )

    def box_pod(self, namespace: str) -> dict[str, Any] | None:
        return self._get(self._pod_path(namespace))

    def evict(self, namespace: str, pod_uid: str) -> None:
        body = {
            "apiVersion": "policy/v1",
            "kind": "Eviction",
            "metadata": {"name": POD, "namespace": namespace},
            "deleteOptions": {"preconditions": {"uid": pod_uid}},
        }
        self._call("POST", self._pod_path(namespace) + "/eviction", body)

    def placeholder(self, name: str) -> dict[str, Any] | None:
        return self._get(self._room_path(name))

    def create_placeholder(self, body: dict[str, Any]) -> None:
        self._room_path(body["metadata"]["name"])
        self._call("POST", self._room_path(), body)

    def delete_placeholder(self, name: str) -> None:
        self._call("DELETE", self._room_path(name), {"kind": "DeleteOptions", "apiVersion": "v1"})


class DrainCoreApi:
    """Core's drain action routes and the machine list, on the operator's bearer (never a box's credential)."""

    def __init__(self, origin: str, token: str, context: ssl.SSLContext | None = None):
        self._origin = check_core_origin(origin).rstrip("/") + "/gateway/hosted-controller"
        self._token = token
        self._handlers = (HTTPSHandler(context=context),) if context is not None else ()

    def _call(self, path: str, body: dict | None = None) -> Any:
        req = Request(
            self._origin + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + self._token,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with build_opener(*self._handlers, _NoRedirect).open(req, timeout=30) as r:
                text = r.read()
                return json.loads(text) if text else None
        except HTTPError as exc:
            if exc.code == 409:
                raise StepRefused() from None
            raise RuntimeError(f"Core call failed: HTTP {exc.code}") from None
        except (URLError, TimeoutError) as exc:
            raise RuntimeError(f"Core call failed: {type(exc).__name__}") from None

    def open_actions(self) -> list[dict[str, Any]]:
        listed = self._call(f"/actions?kind={KIND}")
        actions = listed.get("actions") if isinstance(listed, dict) else None
        return [a for a in actions or [] if isinstance(a, dict)]

    def step(
        self, action_id: str, step: str, state: str, counts: dict[str, int] | None = None
    ) -> None:
        body: dict[str, Any] = {"step": step, "state": state}
        if counts is not None:
            body["counts"] = {"moved": int(counts["moved"]), "total": int(counts["total"])}
        self._call(f"/actions/{quote(str(UUID(action_id)))}/steps", body)

    def machines(self) -> list[dict[str, Any]]:
        listed = self._call("/machines")
        machines = listed.get("machines") if isinstance(listed, dict) else None
        return [m for m in machines or [] if isinstance(m, dict)]
