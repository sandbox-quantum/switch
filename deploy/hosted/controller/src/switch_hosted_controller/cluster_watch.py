"""The operator's cluster report to Core, and each box's restarts.

Every 30 s the box scaler tells Core what the cluster looks like, for the
operator's Machines tab and its alerts (`POST /hosted-controller/cluster`):

- for each agents machine: its zone, memory **used** (from metrics-server) and
  **booked** (box pods' requests) as a share of what it can hold, and whether
  its safety check (the node gate) has passed, is still holding it, or failed;
- for each shared service on a fixed list: how many copies are ready, how many
  it wants, and for how long it has had too few.

It also works out how many times each box restarted since Core last accepted
an observation, and the node it runs on, for that observation.

**Only names, numbers and fixed words leave.** Node names pass the Kubernetes
name rule, zones a zone pattern, and services come from the list here. No pod
spec, environment, label value or event text is sent.

**Its rights** (`placer/cluster-report-rbac.PROPOSED.yaml`), for the hosted
controller's account: `get` and `list` on nodes (names, zones, taints,
allocatable), `get` on `nodes` in `metrics.k8s.io` (node totals only, never
pods), and `get` on each listed Deployment by name, through one Role per
namespace. No `list` on Deployments, no cluster-wide pod read (booked memory
uses the box pods the eviction watch already lists, per box namespace), and
nothing written.

Off unless `SWITCH_CLUSTER_REPORT=on`, since an older Core has no route for
the report. A failed read or post is logged and tried again on the next round;
it never stops the scaler.
"""

from __future__ import annotations

import calendar
import logging
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.error import HTTPError
from urllib.parse import quote

from .placement import GATE1_TAINT, ZONE_KEY
from .placer import DEFAULT_POOL, POOL_LABEL, POOL_RE

logger = logging.getLogger(__name__)

REPORT_INTERVAL_S = 30.0
CALL_TIMEOUT_S = 10.0
FAILED_ANNOTATION = "switch.dev/gate-result"
MAX_NODES = 200

ENV_SWITCH = "SWITCH_CLUSTER_REPORT"
ENV_PROXY_NS = "SWITCH_CLUSTER_PROXY_NAMESPACE"
ENV_OPERATOR_NS = "SWITCH_CLUSTER_OPERATOR_NAMESPACE"
ENV_DATADOG_NS = "SWITCH_CLUSTER_DATADOG_NAMESPACE"
# The operator's Deployment is named by its Helm release, so the run script says
# which it is; the report still calls it `hosted-controller`.
ENV_OPERATOR_DEPLOYMENT = "SWITCH_CLUSTER_OPERATOR_DEPLOYMENT"
ENV_POOL = "SWITCH_PLACEMENT_POOL"

NODE_NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")
ZONE_RE = re.compile(r"^[a-z0-9-]{1,40}$")
# A Kubernetes object uid: lowercase 8-4-4-4-12, the form ClusterNode.uid accepts. A drain
# uses it to tell a replaced node from the one it was asked to drain.
NODE_UID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
NAMESPACE_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")

# The deployment's list (Core keeps the same one and refuses any other name). The
# namespace of each is fixed here or set by the run script.
KUBE_SYSTEM_SERVICES = ("coredns", "ebs-csi-controller", "cluster-autoscaler", "metrics-server")
# How many copies each wants, when its Deployment can't be read.
WANTED = {
    "coredns": 2,
    "ebs-csi-controller": 2,
    "cluster-autoscaler": 1,
    "squid": 2,
    "hosted-controller": 1,
    "kube-state-metrics": 1,
    "metrics-server": 1,
}
# Services that are only deployed in some clusters (the autoscaler in the l3
# pool, kube-state-metrics with Datadog on). A 404 on one of these means "not
# deployed here", and it's left out of the report rather than reported short.
OPTIONAL_SERVICES = frozenset({"cluster-autoscaler", "kube-state-metrics"})


class NotDeployed(Exception):
    """The Deployment doesn't exist (404)."""


_QUANTITY = re.compile(r"^([0-9]+(?:\.[0-9]+)?)([KMGTPE]i?|[mkMGTPE])?$")
_FACTOR = {
    None: 1,
    "Ki": 2**10,
    "Mi": 2**20,
    "Gi": 2**30,
    "Ti": 2**40,
    "Pi": 2**50,
    "Ei": 2**60,
    "k": 10**3,
    "K": 10**3,
    "M": 10**6,
    "G": 10**9,
    "T": 10**12,
    "P": 10**15,
    "E": 10**18,
    "m": 0.001,
}


def memory_bytes(quantity: Any) -> int | None:
    """A Kubernetes memory quantity in bytes (`16Gi`, `512Mi`, `1000000k`, `1e9`
    excluded), or None when it isn't one."""
    if not isinstance(quantity, str):
        return None
    match = _QUANTITY.fullmatch(quantity.strip())
    if match is None:
        return None
    number, suffix = match.groups()
    return int(float(number) * _FACTOR[suffix])


def _pct(part: int | None, whole: int | None) -> float | None:
    if part is None or not whole or whole <= 0:
        return None
    return round(max(0.0, min(100.0, 100.0 * part / whole)), 1)


def gate_state(node: Mapping[str, Any]) -> str:
    """`held` while the node gate's taint is on, `failed` when the gate also
    marked it failed, `passed` once the taint is gone."""
    spec = node.get("spec") or {}
    tainted = any((t or {}).get("key") == GATE1_TAINT for t in spec.get("taints") or [])
    if not tainted:
        return "passed"
    annotations = (node.get("metadata") or {}).get("annotations") or {}
    return "failed" if FAILED_ANNOTATION in annotations else "held"


def held_minutes(node: Mapping[str, Any], now: float) -> int:
    """How long a held node has been Ready and still in its safety check: from
    its Ready condition's last change, which the gate's own ALERT also uses."""
    if gate_state(node) == "passed":
        return 0
    for condition in (node.get("status") or {}).get("conditions") or []:
        if (condition or {}).get("type") != "Ready" or condition.get("status") != "True":
            continue
        since = _epoch((condition or {}).get("lastTransitionTime"))
        if since is not None:
            return max(0, min(int((now - since) // 60), 100_000))
    return 0


def _epoch(stamp: Any) -> float | None:
    if not isinstance(stamp, str):
        return None
    try:
        return float(calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ")))
    except ValueError:
        return None


def booked_bytes(pods: list[Mapping[str, Any]]) -> dict[str, int]:
    """Node name -> the memory box pods scheduled there have requested."""
    out: dict[str, int] = {}
    for pod in pods:
        spec = pod.get("spec") or {}
        status = pod.get("status") or {}
        node = spec.get("nodeName")
        if not isinstance(node, str) or status.get("phase") in ("Succeeded", "Failed"):
            continue
        if (pod.get("metadata") or {}).get("deletionTimestamp"):
            continue
        total = 0
        for container in spec.get("containers") or []:
            requests = ((container or {}).get("resources") or {}).get("requests") or {}
            total += memory_bytes(requests.get("memory")) or 0
        out[node] = out.get(node, 0) + total
    return out


def node_entries(
    nodes: list[Mapping[str, Any]],
    used: Mapping[str, int | None],
    booked: Mapping[str, int],
    now: float,
) -> list[dict[str, Any]]:
    """The report's `nodes`: names and zones checked, figures as shares."""
    out: list[dict[str, Any]] = []
    for node in nodes[:MAX_NODES]:
        meta = node.get("metadata") or {}
        name = meta.get("name")
        zone = (meta.get("labels") or {}).get(ZONE_KEY)
        if not isinstance(name, str) or not NODE_NAME_RE.fullmatch(name):
            continue
        if not isinstance(zone, str) or not ZONE_RE.fullmatch(zone):
            continue
        allocatable = memory_bytes(
            ((node.get("status") or {}).get("allocatable") or {}).get("memory")
        )
        entry: dict[str, Any] = {
            "name": name,
            "zone": zone,
            "memory_used_pct": _pct(used.get(name), allocatable),
            "memory_booked_pct": _pct(booked.get(name, 0), allocatable),
            "gate": gate_state(node),
            "held_minutes": held_minutes(node, now),
        }
        uid = meta.get("uid")
        if isinstance(uid, str) and NODE_UID_RE.fullmatch(uid):
            entry["uid"] = uid  # left out, never guessed, when the API gives anything else
        out.append(entry)
    return out


@dataclass
class ServiceTracker:
    """For how long each service has had fewer ready copies than it wants,
    kept here so Core needs no state for A6's 2 minutes."""

    short_since: dict[str, float] = field(default_factory=dict)

    def entry(self, name: str, ready: int, wanted: int, now: float) -> dict[str, Any]:
        ready = max(0, min(ready, 1000))
        wanted = max(0, min(wanted, 1000))
        if ready < wanted:
            since = self.short_since.setdefault(name, now)
            short = max(0, min(int(now - since), 1_000_000))
        else:
            self.short_since.pop(name, None)
            short = 0
        return {"name": name, "ready": ready, "wanted": wanted, "short_seconds": short}


class ClusterKube(Protocol):
    def nodes(self) -> list[dict[str, Any]]: ...
    def node_memory_used(self, name: str) -> int | None: ...
    def deployment(self, namespace: str, name: str) -> tuple[int, int] | None: ...


class ClusterCore(Protocol):
    def report_cluster(self, report: dict[str, Any]) -> None: ...


class ClusterWatch:
    """Builds and posts the cluster report, at most every 30 s."""

    def __init__(
        self,
        kube: ClusterKube,
        core: ClusterCore,
        services: Mapping[str, tuple[str, str]],
        *,
        box_pods: Callable[[], list[dict[str, Any]]] = lambda: [],
        interval: float = REPORT_INTERVAL_S,
        monotonic: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self._kube = kube
        self._core = core
        self._services = dict(services)  # name -> (namespace, Deployment name)
        # The box pods the eviction watch already listed this pass, one box
        # namespace at a time: no cluster-wide pod read is needed for booked memory.
        self._box_pods = box_pods
        self._interval = interval
        self._monotonic = monotonic
        self._wall = wall
        self._last: float | None = None
        self._tracker = ServiceTracker()

    def tick(self) -> bool:
        """Post a report if one is due. True when one was posted. Never raises."""
        now = self._monotonic()
        if self._last is not None and now - self._last < self._interval:
            return False
        self._last = now
        try:
            report = self.build()
            self._core.report_cluster(report)
            return True
        except Exception as exc:
            logger.warning(
                "Cluster report failed (%s); trying again next round.", type(exc).__name__
            )
            return False

    def build(self) -> dict[str, Any]:
        nodes = self._kube.nodes()
        used: dict[str, int | None] = {}
        for node in nodes[:MAX_NODES]:
            name = (node.get("metadata") or {}).get("name")
            if isinstance(name, str) and NODE_NAME_RE.fullmatch(name):
                try:
                    used[name] = self._kube.node_memory_used(name)
                except Exception:
                    # metrics-server is down or restarting: Core says "can't be read".
                    used[name] = None
        booked = booked_bytes(self._box_pods())
        services = []
        now = self._monotonic()
        for name, (namespace, deployment) in sorted(self._services.items()):
            try:
                found = self._kube.deployment(namespace, deployment)
            except NotDeployed:
                if name in OPTIONAL_SERVICES:
                    self._tracker.short_since.pop(name, None)
                    continue
                found = None
            except Exception:
                found = None
            # A service that can't be read counts as having no ready copies.
            ready, wanted = found if found is not None else (0, WANTED[name])
            services.append(self._tracker.entry(name, ready, wanted, now))
        return {"nodes": node_entries(nodes, used, booked, self._wall()), "services": services}


class ClusterKubeApi:
    """The reads the report needs, over the scaler's own Kubernetes client."""

    def __init__(self, call, pool: str = DEFAULT_POOL):
        if not POOL_RE.fullmatch(pool):
            raise ValueError("not a machine pool name")
        self._raw = call
        self._pool = f"{POOL_LABEL}={pool}"

    def _call(self, method: str, path: str) -> dict:
        return self._raw(method, path, None, timeout=CALL_TIMEOUT_S)

    def nodes(self) -> list[dict[str, Any]]:
        return list(
            self._call("GET", f"/api/v1/nodes?labelSelector={quote(self._pool)}").get("items") or []
        )

    def node_memory_used(self, name: str) -> int | None:
        if not NODE_NAME_RE.fullmatch(name):
            raise ValueError("not a node name")
        usage = self._call("GET", f"/apis/metrics.k8s.io/v1beta1/nodes/{name}").get("usage") or {}
        return memory_bytes(usage.get("memory"))

    def deployment(self, namespace: str, name: str) -> tuple[int, int] | None:
        if not NAMESPACE_RE.fullmatch(namespace) or not NAMESPACE_RE.fullmatch(name):
            raise ValueError("not a namespace or Deployment name")
        try:
            found = self._call("GET", f"/apis/apps/v1/namespaces/{namespace}/deployments/{name}")
        except HTTPError as exc:
            if exc.code == 404:
                raise NotDeployed(name) from None
            raise
        wanted = int((found.get("spec") or {}).get("replicas") or 0)
        ready = int((found.get("status") or {}).get("readyReplicas") or 0)
        return ready, wanted


def services_from_env(env: Mapping[str, str]) -> dict[str, tuple[str, str]]:
    """Each listed service, its namespace and its Deployment's name.
    kube-system's four are fixed; the proxy's and operator's namespaces (and
    the operator's Deployment name) come from the run script, and
    kube-state-metrics is listed only when Datadog's namespace is set."""
    services = {name: ("kube-system", name) for name in KUBE_SYSTEM_SERVICES}
    operator_deployment = env.get(ENV_OPERATOR_DEPLOYMENT, "").strip() or "hosted-controller"
    if not NAMESPACE_RE.fullmatch(operator_deployment):
        raise ValueError(f"{ENV_OPERATOR_DEPLOYMENT} must be a Deployment name")
    for key, name, deployment, required in (
        (ENV_PROXY_NS, "squid", "squid", True),
        (ENV_OPERATOR_NS, "hosted-controller", operator_deployment, True),
        (ENV_DATADOG_NS, "kube-state-metrics", "kube-state-metrics", False),
    ):
        namespace = env.get(key, "").strip()
        if not namespace:
            if required:
                raise ValueError(f"{ENV_SWITCH}=on needs {key} set to a namespace name")
            continue
        if not NAMESPACE_RE.fullmatch(namespace):
            raise ValueError(f"{key} must be a namespace name")
        services[name] = (namespace, deployment)
    return services


def cluster_watch_from_env(
    kube_call,
    core: ClusterCore,
    env: Mapping[str, str],
    box_pods: Callable[[], list[dict[str, Any]]] = lambda: [],
) -> ClusterWatch | None:
    """`SWITCH_CLUSTER_REPORT=on` turns the report on; off by default. A bad
    value refuses to start rather than guessing. The run script passes the
    result to `box_scaler.run(cluster=...)`, and `box_pods` as
    `lambda: [p for pods in watch.last_pods.values() for p in pods]`, so booked
    memory comes from the pods the eviction watch already lists."""
    value = env.get(ENV_SWITCH, "off").strip()
    if value not in ("on", "off"):
        raise ValueError(f"{ENV_SWITCH} must be on or off")
    if value == "off":
        return None
    pool = env.get(ENV_POOL, "").strip() or DEFAULT_POOL
    services = services_from_env(env)
    logger.info("Cluster report on: pool=%s services=%d", pool, len(services))
    return ClusterWatch(ClusterKubeApi(kube_call, pool), core, services, box_pods=box_pods)


# ── Box restarts, for the observation ────────────────────────────────────────


@dataclass
class RestartCounter:
    """Each box's container restarts since Core last accepted an observation.

    It remembers each box pod's restart count by pod uid. A new pod (after an
    eviction or a scale-up) counts from 0, and the first look at a box after
    the scaler starts is only a baseline, so old restarts aren't reported as new.
    """

    _last: dict[str, dict[str, int]] = field(default_factory=dict)  # machine -> uid -> count
    _unreported: dict[str, int] = field(default_factory=dict)

    def see(self, machine_id: str, pods: list[Mapping[str, Any]]) -> None:
        counts: dict[str, int] = {}
        for pod in pods:
            uid = (pod.get("metadata") or {}).get("uid")
            if not isinstance(uid, str):
                continue
            statuses = (pod.get("status") or {}).get("containerStatuses") or []
            counts[uid] = sum(
                int(s.get("restartCount") or 0) for s in statuses if isinstance(s, Mapping)
            )
        before = self._last.get(machine_id)
        self._last[machine_id] = counts
        if before is None:
            return
        rise = sum(max(0, n - before.get(uid, 0)) for uid, n in counts.items())
        if rise:
            self._unreported[machine_id] = min(
                self._unreported.get(machine_id, 0) + rise, 1_000_000
            )

    def unreported(self, machine_id: str) -> int:
        return self._unreported.get(machine_id, 0)

    def reported(self, machine_id: str, count: int) -> None:
        left = self._unreported.get(machine_id, 0) - count
        if left > 0:
            self._unreported[machine_id] = left
        else:
            self._unreported.pop(machine_id, None)


def box_node(pods: list[Mapping[str, Any]]) -> str | None:
    """The node the box's live pod runs on, or None."""
    for pod in pods:
        spec = pod.get("spec") or {}
        status = pod.get("status") or {}
        node = spec.get("nodeName")
        if (
            isinstance(node, str)
            and NODE_NAME_RE.fullmatch(node)
            and status.get("phase") not in ("Succeeded", "Failed")
            and not (pod.get("metadata") or {}).get("deletionTimestamp")
        ):
            return node
    return None


ENV_BOX_FACTS = "SWITCH_SCALER_REPORT_BOX_FACTS"


def restart_counter_from_env(env: Mapping[str, str]) -> RestartCounter | None:
    """`SWITCH_SCALER_REPORT_BOX_FACTS=1` once Core accepts `restarts` and
    `node` on the observation. The run script passes the result to
    `box_scaler.run(box_facts=...)`, with the eviction watch on."""
    return RestartCounter() if env.get(ENV_BOX_FACTS) == "1" else None
