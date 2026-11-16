"""Notice when a user's box is pushed off its machine, and say so.

A box can lose its machine without anyone asking: the kubelet evicts it under
node pressure, the scheduler preempts it for a higher-priority pod, the taint
manager evicts it from a machine gone NotReady, a drain or a scale-down evicts
it through the Eviction API, or the machine disappears and the pod is
collected. Each of those is a box restart the user didn't ask for, so each is
alerted, with no Datadog in the path:

- one WARN log line per eviction, with ids and a fixed reason code only;
- a Kubernetes Warning event on the user's `box` StatefulSet;
- a running count per box, in the scaler's status file;
- the count since Core's last accepted observation, in the next observation,
  behind a setting (switched on only once Core accepts the field).

It reads two things in each box namespace: the box's pod, `box-0`, by name
(its `DisruptionTarget` condition and status reason), and the namespace's
events (`Evicted`, `Preempted`, `TaintManagerEviction`), because a StatefulSet
replaces a failed pod at once and the pod alone can be gone by the next pass.
Each pod is alerted once, whichever source saw it first. If the events can't
be read (no right to list them in that namespace), the pod is still checked,
and one WARN per box says the events weren't read.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger(__name__)

BOX_APP = "switch-box"

# The fixed reason codes, and what each means. Nothing from the cluster's own
# messages is ever logged or sent: only these.
NODE_PRESSURE = "node_pressure"  # the kubelet evicted it (memory, disk or pid pressure)
PREEMPTED = "preempted"  # the scheduler made room for a higher-priority pod
TAINT_EVICTION = "taint_eviction"  # its machine went NotReady/unreachable, or got a NoExecute taint
EVICTION_API = "eviction_api"  # a drain or an autoscaler scale-down evicted it
NODE_LOST = "node_lost"  # its machine is gone, and the pod was collected
NODE_SHUTDOWN = "node_shutdown"  # its machine shut down
OTHER = "other"  # a disruption of a kind not listed here

REASONS = (NODE_PRESSURE, PREEMPTED, TAINT_EVICTION, EVICTION_API, NODE_LOST, NODE_SHUTDOWN, OTHER)

# The pod's DisruptionTarget condition reasons (Kubernetes 1.26+).
_CONDITION_REASONS = {
    "PreemptionByScheduler": PREEMPTED,
    "PreemptionByKubeScheduler": PREEMPTED,
    "DeletionByTaintManager": TAINT_EVICTION,
    "EvictionByEvictionAPI": EVICTION_API,
    "DeletionByPodGC": NODE_LOST,
    "TerminationByKubelet": NODE_PRESSURE,
}
# Event reasons, on the pod as involved object.
_EVENT_REASONS = {
    "Evicted": NODE_PRESSURE,
    "Preempted": PREEMPTED,
    "TaintManagerEviction": TAINT_EVICTION,
}

# How long a pod already alerted is remembered: past the cluster's event TTL (1 h).
REMEMBER_S = 2 * 3600.0


@dataclass(frozen=True)
class Eviction:
    pod_uid: str
    pod_name: str
    node: str | None
    reason: str


def _safe(value: Any, limit: int = 253) -> str | None:
    """A Kubernetes name or uid, as we will log it: plain characters only, bounded."""
    if not isinstance(value, str) or not value or len(value) > limit:
        return None
    if not all(c.isalnum() or c in "-._" for c in value):
        return None
    return value


def _is_box(pod: Mapping[str, Any]) -> bool:
    labels = (pod.get("metadata") or {}).get("labels") or {}
    return labels.get("app") == BOX_APP


def from_pod(pod: Mapping[str, Any]) -> Eviction | None:
    """The eviction a box pod shows, if any: its DisruptionTarget, or a kubelet status reason."""
    if not _is_box(pod):
        return None
    meta = pod.get("metadata") or {}
    uid, name = _safe(meta.get("uid")), _safe(meta.get("name"))
    if uid is None or name is None:
        return None
    spec = pod.get("spec") or {}
    status = pod.get("status") or {}
    node = _safe(spec.get("nodeName"))
    for condition in status.get("conditions") or []:
        if condition.get("type") == "DisruptionTarget" and condition.get("status") == "True":
            return Eviction(uid, name, node, _CONDITION_REASONS.get(condition.get("reason"), OTHER))
    reason = status.get("reason")
    if reason == "Evicted":
        return Eviction(uid, name, node, NODE_PRESSURE)
    if reason in ("Terminated", "NodeShutdown", "Shutdown"):
        return Eviction(uid, name, node, NODE_SHUTDOWN)
    if reason == "Preempting":
        return Eviction(uid, name, node, PREEMPTED)
    return None


def from_event(event: Mapping[str, Any], box_pod_names: set[str]) -> Eviction | None:
    """The eviction an event reports for a box pod; an event about any other pod is ignored."""
    reason = _EVENT_REASONS.get(event.get("reason"))
    if reason is None:
        return None
    involved = event.get("involvedObject") or event.get("regarding") or {}
    if involved.get("kind") != "Pod":
        return None
    uid, name = _safe(involved.get("uid")), _safe(involved.get("name"))
    if uid is None or name is None or name not in box_pod_names:
        return None
    node = _safe((event.get("source") or {}).get("host")) or _safe(event.get("reportingInstance"))
    return Eviction(uid, name, node, reason)


class EvictionKube(Protocol):
    def box_pods(self, namespace: str) -> list[dict[str, Any]]: ...
    def events(self, namespace: str) -> list[dict[str, Any]]: ...
    def warn_box(self, namespace: str, reason: str, message: str) -> None: ...


class EvictionWatch:
    """Remembers which box pods were already alerted, and counts evictions per box."""

    def __init__(
        self,
        kube: EvictionKube,
        now: Callable[[], float] = time.monotonic,
        report_to_core: bool = False,
    ):
        self._kube = kube
        self._now = now
        self.report_to_core = report_to_core
        self._seen: dict[str, float] = {}  # pod uid -> when alerted
        self._counts: dict[str, int] = {}  # machine id -> evictions since start
        self._unreported: dict[str, int] = {}  # machine id -> evictions Core hasn't accepted yet
        self._events_warned: set[str] = set()  # namespaces whose events couldn't be read
        # The box pods each machine's last look found, for the restart count and
        # node in the observation, so they aren't listed twice a pass.
        self.last_pods: dict[str, list[dict[str, Any]]] = {}

    def counts(self) -> dict[str, int]:
        return dict(self._counts)

    def unreported(self, machine_id: str) -> int:
        """Evictions since the last observation Core accepted: what the next one carries."""
        return self._unreported.get(machine_id, 0)

    def reported(self, machine_id: str, count: int) -> None:
        """Core accepted an observation carrying `count`: only later evictions remain."""
        left = self._unreported.get(machine_id, 0) - count
        if left > 0:
            self._unreported[machine_id] = left
        else:
            self._unreported.pop(machine_id, None)

    def check(self, machine_id: str, namespace: str) -> list[Eviction]:
        """One look at a box: alerts each new eviction, and returns them. Never raises."""
        try:
            pods = self._kube.box_pods(namespace)
            self.last_pods[machine_id] = pods
            found = [e for e in (from_pod(p) for p in pods) if e is not None]
            # The box StatefulSet's one pod, under its fixed name even after it is replaced.
            names = {"box-0"} | {
                n
                for p in pods
                if _is_box(p) and (n := _safe((p.get("metadata") or {}).get("name")))
            }
            try:
                events = self._kube.events(namespace)
            except Exception as exc:  # the pod's own reason still counts
                if namespace not in self._events_warned:
                    self._events_warned.add(namespace)
                    logger.warning(
                        "Machine %s: could not read box events (%s); checking the pod only.",
                        machine_id,
                        type(exc).__name__,
                    )
                events = []
            found += [e for e in (from_event(ev, names) for ev in events) if e]
        except Exception as exc:  # the scaler goes on; the next pass looks again
            logger.warning(
                "Machine %s: could not look for box evictions (%s).", machine_id, type(exc).__name__
            )
            return []
        self._forget_old()
        fresh: list[Eviction] = []
        for eviction in found:
            if eviction.pod_uid in self._seen:
                continue
            self._seen[eviction.pod_uid] = self._now()
            fresh.append(eviction)
            self._alert(machine_id, namespace, eviction)
        return fresh

    def _alert(self, machine_id: str, namespace: str, eviction: Eviction) -> None:
        self._counts[machine_id] = self._counts.get(machine_id, 0) + 1
        self._unreported[machine_id] = min(self._unreported.get(machine_id, 0) + 1, 1_000_000)
        logger.warning(
            "Machine %s: box %s/%s was pushed off machine %s (%s); evictions since start: %d.",
            machine_id,
            namespace,
            eviction.pod_name,
            eviction.node or "unknown",
            eviction.reason,
            self._counts[machine_id],
        )
        try:
            self._kube.warn_box(
                namespace,
                "BoxPushedOff",
                f"The box was pushed off its machine ({eviction.reason}); it restarts elsewhere.",
            )
        except Exception as exc:
            logger.warning(
                "Machine %s: could not record the eviction event (%s).",
                machine_id,
                type(exc).__name__,
            )

    def _forget_old(self) -> None:
        cutoff = self._now() - REMEMBER_S
        for uid in [u for u, at in self._seen.items() if at < cutoff]:
            del self._seen[uid]


def status_document(watch: EvictionWatch, machines: Iterable[str]) -> dict[str, Any]:
    """What the scaler's status file says about evictions: a count per machine it serves."""
    counts = watch.counts()
    return {"version": 1, "evictions": {m: counts.get(m, 0) for m in sorted(set(machines))}}


def watch_from_env(kube: EvictionKube, env: Mapping[str, str]) -> EvictionWatch:
    """The scaler's eviction watch: always on; the count goes to Core only with
    `SWITCH_SCALER_REPORT_EVICTIONS=1`, once Core accepts it."""
    return EvictionWatch(kube, report_to_core=env.get("SWITCH_SCALER_REPORT_EVICTIONS") == "1")
