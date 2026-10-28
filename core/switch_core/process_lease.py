"""This switch-core process's lease, and reading every process's.

Every process holds one, under its process id (`process_identity.py`): it is
how one process knows another is alive. An agent's or a controller's socket
lives in the memory of the one process holding it, and that process writes the
connection's transitions to a row (`bridges/agent/protocol/connection_rows.py`
for agents, `management/connection_ledger.py` for controllers). A process that
dies writes no closing, so each process also holds a lease in
`switch_core_processes`: it claims it at startup, renews it every
`RENEW_EVERY_SECONDS`, and marks it stopped as it shuts down. A connection
reads as online only while its holding process's lease is held: renewed
within `LEASE_TTL` and not stopped. One write per process per renewal, however
many connections it holds.

The work that must run once (a client's consumer, a bridge's platform
connection) is owned through `ownership.py`, whose leases are valid only while
their holder's process lease is held, and which stops its work when this
process can no longer be sure its own is (`surely_held`).

The lease also records the ids of the keys the process can read, which a
process starting with a new front key checks (`db/key_rotation.py`).

Leases are written and compared on the database's clock, never a host's.
Leases not renewed for `PRUNE_AFTER` are deleted by whichever process renews
next; a connection naming a process with no lease reads as lost.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.switch_core_process_store import (
    ProcessLeaseRow,
    SwitchCoreProcessStore,
)

logger = logging.getLogger(__name__)

# The unit the lease's lifetime is counted in, and how often the other
# processes look at the leases (`ownership.BALANCE_INTERVAL_SECONDS`).
RENEW_INTERVAL_SECONDS = 5.0

# Several renewals: one missed write, or a slow one, does not put every
# machine the process holds offline.
LEASE_TTL = timedelta(seconds=3 * RENEW_INTERVAL_SECONDS)

# How long after the last good renewal was sent the next is sent: a third of
# the half lease `ProcessLease.surely_held` counts from. A renewal may then
# take twice this, or fail once and be retried, before this process has to
# stop its owned work (`ownership.py`).
RENEW_EVERY_SECONDS = LEASE_TTL.total_seconds() / 6

# How long after a failed renewal the next is tried.
RETRY_RENEWAL_SECONDS = 1.0

PRUNE_AFTER = timedelta(hours=1)

# Why a connection the row still shows open is not, when its process is the
# reason: the process shut down without writing it, or stopped renewing.
SERVER_SHUTDOWN = "server_shutdown"
SERVER_LOST = "server_lost"


@dataclass(frozen=True)
class ProcessLeases:
    """Every process's lease as the database held it at `read_at`, its own
    clock."""

    read_at: datetime
    leases: dict[str, ProcessLeaseRow]

    def holds(self, process_id: str | None) -> bool:
        """Whether the process is alive and holding its sockets."""
        lease = self.leases.get(process_id) if process_id is not None else None
        return (
            lease is not None
            and lease.stopped_at is None
            and self.read_at - lease.beat_at < LEASE_TTL
        )

    def ended(self, process_id: str | None) -> tuple[datetime | None, str]:
        """When and why a process not holding stopped: shut down at
        `stopped_at`, or lost after its last renewal (when not known once its
        lease is pruned)."""
        lease = self.leases.get(process_id) if process_id is not None else None
        if lease is None:
            return None, SERVER_LOST
        if lease.stopped_at is not None:
            return lease.stopped_at, SERVER_SHUTDOWN
        return lease.beat_at, SERVER_LOST


async def read_leases(
    session: AsyncSession, processes: SwitchCoreProcessStore
) -> ProcessLeases:
    """Every lease, in the caller's session; the table has no tenant policy,
    so any session reads it."""
    read_at, leases = await processes.read(session)
    return ProcessLeases(read_at=read_at, leases=leases)


class ProcessLease:
    """This process's lease. The sessions are opened with no tenant bound:
    the table carries none."""

    def __init__(
        self,
        *,
        process_id: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: SwitchCoreProcessStore,
        key_ids: list[str],
    ) -> None:
        self.process_id = process_id
        self._session_factory = session_factory
        self._processes = processes
        # The ids of the keys this process can read, recorded on its row so a
        # process starting with a new front key can check them
        # (`db/key_rotation.py`).
        self._key_ids = key_ids
        # Set by `stop`. A renewal clears `stopped_at`, so once the process
        # has released its lease (as it starts draining, while it still runs)
        # no renewal may claim it back.
        self._stopped = False
        # This process's monotonic clock when the last renewal that succeeded
        # was sent, or None before the first and after `stop`. Sent, not
        # answered: the database stamped the lease at some moment after this,
        # so a deadline counted from here can only be early.
        self._renewed_at: float | None = None

    def surely_held(self) -> bool:
        """Whether no other process can yet read this lease as lapsed.

        Another process takes over this one's owned work once the lease is
        `LEASE_TTL` old by the database's clock. This answers from half that,
        on this process's own clock and from when the last good renewal was
        sent, so the work stops here well before anyone else may start it,
        however far the two clocks have drifted.
        """
        held_until = self.held_until()
        return held_until is not None and time.monotonic() < held_until

    def held_until(self) -> float | None:
        """On this process's monotonic clock, when `surely_held` turns false
        unless the lease is renewed first. None before the first renewal and
        after `stop`."""
        if self._renewed_at is None:
            return None
        return self._renewed_at + LEASE_TTL.total_seconds() / 2

    async def renew(self) -> None:
        """Claim or renew the lease, and prune leases long dead. Does nothing
        once the lease is stopped: a draining process stays released."""
        if self._stopped:
            return
        sent_at = time.monotonic()
        async with self._session_factory() as session:
            await self._processes.renew(session, self.process_id, self._key_ids)
            pruned = await self._processes.prune(session, PRUNE_AFTER)
            await session.commit()
        self._renewed_at = sent_at
        if pruned:
            logger.info("Pruned %d switch-core process lease(s) long stale", pruned)

    async def read_all(self) -> ProcessLeases:
        """Every process's lease, as the database holds it now."""
        async with self._session_factory() as session:
            return await read_leases(session, self._processes)

    async def stop(self) -> None:
        """Mark the lease stopped: every connection this process still shows
        open reads as offline from now. Only the first call writes."""
        if self._stopped:
            return
        self._stopped = True
        self._renewed_at = None
        async with self._session_factory() as session:
            await self._processes.stop(session, self.process_id)
            await session.commit()
        logger.info("Released switch-core process lease %s", self.process_id)

    async def run(self) -> None:
        """Renew `RENEW_EVERY_SECONDS` after the last good renewal was sent,
        until cancelled. A failed renewal is logged and retried after
        `RETRY_RENEWAL_SECONDS`; once the lease is `LEASE_TTL` old this
        process's connections read offline elsewhere.

        Counted from the last renewal, wherever it was made, so a loop started
        late (after a slow boot, whose renewal came from `Ownership.start`)
        renews at once rather than an interval after it starts."""
        while True:
            await asyncio.sleep(self._until_next_renewal())
            try:
                await self.renew()
            except Exception:
                logger.exception(
                    "Renewing switch-core process lease %s failed; the "
                    "connections it holds read offline once it is %s old",
                    self.process_id,
                    LEASE_TTL,
                )
                await asyncio.sleep(RETRY_RENEWAL_SECONDS)

    def _until_next_renewal(self) -> float:
        if self._renewed_at is None:
            return 0.0 if not self._stopped else RENEW_EVERY_SECONDS
        return max(0.0, self._renewed_at + RENEW_EVERY_SECONDS - time.monotonic())
