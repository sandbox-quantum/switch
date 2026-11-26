"""Whether the data retention and erasure sweeps are getting their work done.

The sweeps catch and log their failures so one workspace cannot stop the
others, which leaves a sweep that fails every pass looking, from outside, like
one with nothing to do. So each pass reports, per job, whether it completed
with no failure (`SweepHealth.record`), and this process reports two metrics:

- `switch.retention.last_success_age`, a gauge read when the metrics are
  collected, so a sweep stuck mid-pass keeps it growing: seconds since the job
  last completed a pass with no failure, or since its loop started if none has
  yet;
- `switch.retention.failures`, a counter of passes that failed, by job.

Only while a loop runs here (`start` to `stop`): a process that does not run
the sweeps reports no age, so its absence means nobody does.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from typing import Literal

from switch_core.observability.catalogue import (
    RETENTION_FAILURES,
    RETENTION_LAST_SUCCESS_AGE,
)
from switch_core.observability.metrics import GaugeReading, metrics

#: The retention pass's steps (`retention/service.py`), each over every
#: workspace, then the purge of deleted workspaces' audit history, and the
#: erasure queue (`retention/erasure.py`).
RetentionJob = Literal["messages", "media", "leftovers", "audit_history", "erasure"]

RETENTION_PASS_JOBS: tuple[RetentionJob, ...] = (
    "messages",
    "media",
    "leftovers",
    "audit_history",
)
#: The jobs `RetentionService.apply` runs over each workspace.
TENANT_JOBS: tuple[RetentionJob, ...] = ("messages", "media", "leftovers")


class SweepHealth:
    def __init__(self, clock: Callable[[], float]) -> None:
        self._clock = clock
        # For each job whose loop runs here: since when, and when a pass of it
        # last completed with no failure.
        self._running_since: dict[RetentionJob, float] = {}
        self._last_success: dict[RetentionJob, float] = {}

    def start(self, jobs: Iterable[RetentionJob]) -> None:
        now = self._clock()
        for job in jobs:
            self._running_since[job] = now
            self._last_success.pop(job, None)

    def stop(self, jobs: Iterable[RetentionJob]) -> None:
        for job in jobs:
            self._running_since.pop(job, None)
            self._last_success.pop(job, None)

    def record(self, job: RetentionJob, *, failed: bool) -> None:
        """One pass of `job` completed: with no failure, or with one."""
        if failed:
            metrics().increment(RETENTION_FAILURES, {"job": job})
        else:
            self._last_success[job] = self._clock()

    def readings(self) -> Iterator[GaugeReading]:
        now = self._clock()
        for job, since in self._running_since.items():
            yield GaugeReading(
                RETENTION_LAST_SUCCESS_AGE,
                now - self._last_success.get(job, since),
                {"job": job},
            )
