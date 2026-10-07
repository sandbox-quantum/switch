"""The database's own view of this server: its sessions and its transactions.

The pool gauges are this process's side of the connection. What they cannot
show is what the database is holding, and in particular how many sessions sit
`idle in transaction`, a connection checked out and held across work that is
not a query, which is the usual way a pool runs dry. A managed database with no
monitoring integration has nowhere else to read that from.

Sampled on a connection of its own, never one from the application pool: the
moment worth seeing is the pool exhausted, which is exactly when a pooled
connection cannot be had. One connection, held between samples and reopened
when it fails, so the sampler costs the database one idle session.

Only the server role's own sessions in its own database are counted. That is
also all `pg_stat_activity` shows in full to a role that is not a superuser,
so the numbers mean the same under the restricted runtime role as under the
owner.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from switch_core.observability.catalogue import (
    DB_SERVER_CONNECTIONS,
    DB_SERVER_TRANSACTIONS,
)
from switch_core.observability.metrics import GaugeReading, metrics

logger = logging.getLogger(__name__)

SAMPLE_INTERVAL_SECONDS = 10.0
SAMPLE_TIMEOUT_SECONDS = 2.0
# A database that stays unreachable is reported once a minute, not every sample.
FAILURE_LOG_INTERVAL_SECONDS = 60.0

STATES = ("active", "idle_in_transaction", "idle", "other")

# `pg_stat_activity.state` mapped onto STATES; anything else (fastpath, an
# aborted transaction, a null state) is `other`.
_STATE_OF = {
    "active": "active",
    "idle in transaction": "idle_in_transaction",
    "idle": "idle",
}

_SESSIONS = text(
    "SELECT state, count(*) FROM pg_stat_activity "
    "WHERE usename = current_user AND datname = current_database() "
    "AND pid <> pg_backend_pid() GROUP BY state"
)
_TRANSACTIONS = text(
    "SELECT xact_commit + xact_rollback FROM pg_stat_database "
    "WHERE datname = current_database()"
)


@dataclass(frozen=True)
class DbServerSample:
    connections: dict[str, int]
    transactions: int


class DbServerSampler:
    """Samples the database's session and transaction counters on a timer.

    Connection counts are a gauge read from the last sample, and absent once a
    sample has failed: a stale count would draw a healthy database through an
    outage. Transactions are a counter, recorded as the rise between samples.
    """

    def __init__(
        self,
        engine_factory: Callable[[], AsyncEngine],
        *,
        interval_seconds: float = SAMPLE_INTERVAL_SECONDS,
        timeout_seconds: float = SAMPLE_TIMEOUT_SECONDS,
    ) -> None:
        self._engine_factory = engine_factory
        self._interval = interval_seconds
        self._timeout = timeout_seconds
        self._engine: AsyncEngine | None = None
        self._conn: AsyncConnection | None = None
        self._latest: DbServerSample | None = None
        self._last_transactions: int | None = None
        self._last_failure_log = float("-inf")
        self.disabled = False

    def readings(self) -> Iterator[GaugeReading]:
        latest = self._latest
        if latest is None:
            return
        for state in STATES:
            yield GaugeReading(
                DB_SERVER_CONNECTIONS,
                float(latest.connections.get(state, 0)),
                {"state": state},
            )

    async def run_forever(self) -> None:
        try:
            while not self.disabled:
                await self.sample_once()
                await asyncio.sleep(self._interval)
        finally:
            await self.aclose()

    async def sample_once(self) -> DbServerSample | None:
        """Take one sample and record it. None when it could not be taken."""
        if self.disabled or not self._postgres():
            return None
        try:
            sample = await asyncio.wait_for(self._read(), self._timeout)
        except ProgrammingError:
            # The views are missing or unreadable, which no retry will change.
            logger.warning(
                "The database's activity views cannot be read, so "
                "switch.db.server.* will not be reported by this server.",
                exc_info=True,
            )
            self.disabled = True
            self._latest = None
            await self.aclose()
            return None
        except Exception as exc:
            self._latest = None
            await self._drop_connection()
            self._log_failure(exc)
            return None
        self._record(sample)
        return sample

    def _postgres(self) -> bool:
        if self._engine is None:
            self._engine = self._engine_factory()
        if self._engine.dialect.name == "postgresql":
            return True
        logger.info(
            "The database is not Postgres, so switch.db.server.* is not reported."
        )
        self.disabled = True
        return False

    async def _read(self) -> DbServerSample:
        conn = await self._connection()
        sessions = await conn.execute(_SESSIONS)
        connections = dict.fromkeys(STATES, 0)
        for state, count in sessions.all():
            connections[_STATE_OF.get(state, "other")] += int(count)
        transactions = (await conn.execute(_TRANSACTIONS)).scalar_one_or_none()
        return DbServerSample(
            connections=connections, transactions=int(transactions or 0)
        )

    async def _connection(self) -> AsyncConnection:
        if self._conn is None:
            assert self._engine is not None
            conn = await self._engine.connect()
            # Autocommit, so the sampler never sits idle in a transaction itself.
            self._conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        return self._conn

    def _record(self, sample: DbServerSample) -> None:
        self._latest = sample
        previous = self._last_transactions
        self._last_transactions = sample.transactions
        # The first sample is a baseline, and a fall is a statistics reset.
        if previous is not None and sample.transactions >= previous:
            metrics().increment(
                DB_SERVER_TRANSACTIONS, {}, float(sample.transactions - previous)
            )

    def _log_failure(self, exc: BaseException) -> None:
        now = time.monotonic()
        if now - self._last_failure_log < FAILURE_LOG_INTERVAL_SECONDS:
            return
        self._last_failure_log = now
        logger.warning(
            "Could not sample the database's own connection and transaction "
            "counts (%s: %s); retrying every %.0fs, and saying so at most once a "
            "minute.",
            type(exc).__name__,
            exc,
            self._interval,
        )

    async def _drop_connection(self) -> None:
        conn, self._conn = self._conn, None
        if conn is None:
            return
        try:
            await asyncio.wait_for(conn.close(), self._timeout)
        except Exception:
            logger.debug("Closing the database sampler's connection failed.")

    async def aclose(self) -> None:
        await self._drop_connection()
        engine, self._engine = self._engine, None
        if engine is not None:
            await engine.dispose()
