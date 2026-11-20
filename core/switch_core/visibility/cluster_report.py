"""The operator's latest cluster report, as the Machines tab shows it.

The operator sends a cluster report every 30 s (`POST
/hosted-controller/cluster`): each node's zone, memory used and booked,
and safety-check state, and each shared service's copies. The alerts are
evaluated on it as it arrives; the Machines tab needs the latest one kept.

**Known limit:** it is kept in this process's memory only.
Core runs one process today, so every screen reads the one copy. Nothing
existing fits as a shared home (signals never carry state, and the audit log
isn't a state store), so before Core runs a second process the report needs a
database home. Until a report arrives, or once it is old, the screen says so:
a stale view is never shown as current.

Only fixed fields are kept: names that match the Kubernetes rule, bounded
numbers and fixed states. No free text from the cluster reaches a screen.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# A Kubernetes node name (RFC 1123 subdomain, as the cluster uses it).
NODE_NAME = r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$"
ZONE = r"^[a-z0-9-]{1,40}$"
SERVICE_NAME = r"^[a-z0-9-]{1,40}$"
NODE_NAME_RE = re.compile(NODE_NAME)
# A Kubernetes object uid (RFC 4122 form, lower case), as the API server
# writes `metadata.uid`.
NODE_UID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

# The shared services the operator reports on, and how many copies each wants
# The cluster route refuses a report
# naming any other; the Machines tab can use the list too.
SHARED_SERVICES: dict[str, int] = {
    "coredns": 2,
    "ebs-csi-controller": 2,
    "cluster-autoscaler": 1,
    "squid": 2,
    "hosted-controller": 1,
    "kube-state-metrics": 1,
    "metrics-server": 1,
}


class ClusterNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=NODE_NAME, max_length=253)
    zone: str = Field(pattern=ZONE)
    # Of the node's allocatable memory. Used is read from metrics-server; null
    # when it can't be read, which the screen shows as "can't be read".
    memory_used_pct: float | None = Field(default=None, ge=0, le=100)
    # Boxes' memory requests against allocatable: a planning figure.
    memory_booked_pct: float | None = Field(default=None, ge=0, le=100)
    gate: Literal["passed", "held", "failed"]
    held_minutes: int | None = Field(default=None, ge=0, le=100_000)
    # The node's `metadata.uid`: a drain is
    # pinned to the node it was asked for, so a replaced node that reuses the
    # name is never drained. Optional here, so an operator that doesn't send
    # it yet keeps reporting (alerts and the Machines tab need the report);
    # a drain refuses any node that has none.
    uid: str | None = Field(default=None, pattern=NODE_UID, max_length=36)


class ClusterService(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=SERVICE_NAME)
    ready: int = Field(ge=0, le=1000)
    wanted: int = Field(ge=0, le=1000)
    # How long it has had fewer ready copies than it wants, kept by the
    # operator: A6 fires at 2 minutes, so Core keeps no state for it.
    short_seconds: int = Field(default=0, ge=0, le=1_000_000)


class ClusterReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nodes: list[ClusterNode] = Field(max_length=200)
    services: list[ClusterService] = Field(max_length=50)


@dataclass(frozen=True)
class HeldReport:
    report: ClusterReport
    received_at: datetime


_lock = threading.Lock()
_latest: HeldReport | None = None


def keep_cluster_report(report: ClusterReport, now: datetime | None = None) -> None:
    """Keep `report` as the latest. The cluster route calls this once it has
    validated the report."""
    global _latest
    with _lock:
        _latest = HeldReport(report=report, received_at=now or datetime.now(UTC))


def latest_cluster_report() -> HeldReport | None:
    with _lock:
        return _latest


def forget_cluster_report() -> None:
    """Only for tests."""
    global _latest
    with _lock:
        _latest = None
