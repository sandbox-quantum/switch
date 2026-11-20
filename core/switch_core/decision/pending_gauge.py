"""The queue of messages waiting for a decision, as the operator's metrics see
it (`switch.decision.pending`, `switch.decision.pending.oldest_age`).

A gauge is read synchronously at collection time and cannot query the
database, so the decision sweep samples the queue every few seconds and this
keeps the last sample. The sweep already lists the workspaces with a message
waiting (`tenants_with_pending_decisions`); each of those is read in a session
bound to it, so the sample needs nothing beyond what row-level security
already allows, and a server where nothing waits costs no query at all.

Every replica runs the sweep and samples the same rows, so every replica
reports the same server-wide value: read these with max, not sum. A sample
nobody has refreshed for several sweeps reports nothing rather than a number
that has stopped being true.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import TYPE_CHECKING

from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.pending_decision_store import PendingDecisionStore
from switch_core.observability.catalogue import (
    DECISION_PENDING,
    DECISION_PENDING_OLDEST_AGE,
)
from switch_core.observability.metrics import GaugeReading

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# Sweeps a sample may be behind before it is no longer reported.
_STALE_AFTER_SWEEPS = 4


@dataclass(frozen=True)
class _Sample:
    count: int
    oldest_age_seconds: float | None
    taken_at: float


class PendingDecisionGauge:
    def __init__(
        self,
        *,
        sweep_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._stale_after = sweep_seconds * _STALE_AFTER_SWEEPS
        self._clock = clock
        self._store = PendingDecisionStore()
        self._sample: _Sample | None = None

    async def sample(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        tenant_ids: list[str],
    ) -> None:
        """Read the waiting queue of each of `tenant_ids`, the workspaces with
        a message waiting, and keep the total and the oldest age."""
        count = 0
        oldest: float | None = None
        for tenant_id in tenant_ids:
            async with tenant_session(session_factory, tenant_id) as session:
                summary = await self._store.summary(session, tenant_id=tenant_id)
            count += summary.count
            if summary.oldest_age_seconds is not None and (
                oldest is None or summary.oldest_age_seconds > oldest
            ):
                oldest = summary.oldest_age_seconds
        self._sample = _Sample(count, oldest, self._clock())

    def readings(self) -> Iterator[GaugeReading]:
        sample = self._sample
        if sample is None or self._clock() - sample.taken_at > self._stale_after:
            return
        yield GaugeReading(DECISION_PENDING, float(sample.count), {})
        yield GaugeReading(
            DECISION_PENDING_OLDEST_AGE, sample.oldest_age_seconds or 0.0, {}
        )
