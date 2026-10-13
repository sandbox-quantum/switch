"""Persisting each controller connection's transitions, so any process can
tell whether the machine is connected.

Core's `ControllerPresence` decides when a controller's socket attaches to
its connection and when it goes, in the memory of the process holding it,
and tells this ledger as each happens. Heartbeats stay there: nothing here is
written per beat. The ledger writes each transition to the controller's row
once:

- connected: `connection_id`, `connection_process_id` (this process),
  `connected_at`, and the previous closing cleared;
- disconnected: `disconnected_at` and `disconnect_reason` (`socket_closed`,
  `server_shutdown`, `heartbeat_lapsed`, `taken_over`, `revoked`).

That row, and the lease of the process it names (`process_lease.py`), are
what a machine's state is read from (`placement.controller_state`).

Which write wins, across processes: a connecting comes from the process
holding the live socket, and replaces whatever the row holds. A closing is
only written while the row still names that connection, so a process closing
a connection the controller has since replaced through another process
leaves the replacement standing. (Clocks are not compared: two processes'
clocks need not agree.)

Writes are queued, latest per controller, and written by one task (`run`),
woken by each transition, so a socket attaching or going never waits on the
database. A write that fails is kept, unless something newer for the same
controller has arrived meanwhile, and retried.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerConnection,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.user_changes import MACHINE, UserChangePublisher

logger = logging.getLogger(__name__)

# How long a failed write waits before it is tried again.
RETRY_SECONDS = 2.0


@dataclass(frozen=True)
class _Transition:
    tenant_id: str
    controller_id: str
    connection_id: str
    at: datetime
    # None for a connecting; why the socket went for a closing.
    disconnect_reason: str | None


class ControllerConnectionLedger:
    """Core's `ControllerConnectionLedger`, written to `agent_controllers`."""

    def __init__(
        self,
        *,
        process_id: str,
        session_factory: async_sessionmaker[AsyncSession],
        controllers: AgentControllerStore,
        clock: Callable[[], datetime],
        user_changes: UserChangePublisher,
    ) -> None:
        self._process_id = process_id
        self._session_factory = session_factory
        self._controllers = controllers
        self._clock = clock
        self._user_changes = user_changes
        self._pending: dict[str, _Transition] = {}
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()

    def connected(self, conn: ControllerConnection) -> None:
        self._queue(conn, None)

    def disconnected(self, conn: ControllerConnection, reason: str) -> None:
        self._queue(conn, reason)

    def _queue(self, conn: ControllerConnection, reason: str | None) -> None:
        self._pending[conn.controller_id] = _Transition(
            tenant_id=conn.tenant_id,
            controller_id=conn.controller_id,
            connection_id=conn.id,
            at=self._clock(),
            disconnect_reason=reason,
        )
        self._wake.set()

    @property
    def pending(self) -> int:
        return len(self._pending)

    async def flush_all(self) -> None:
        """Write every queued transition. Raises the first failure, keeping
        what was not written."""
        async with self._lock:
            transitions = list(self._pending.values())
            self._pending.clear()
            if transitions:
                await self._write(transitions)

    async def run(self) -> None:
        """Write transitions as they are queued, until cancelled."""
        while True:
            await self._wake.wait()
            self._wake.clear()
            try:
                await self.flush_all()
            except Exception:
                logger.exception(
                    "Recording controller connection transitions failed; %d kept "
                    "and retried in %.0fs",
                    len(self._pending),
                    RETRY_SECONDS,
                )
                await asyncio.sleep(RETRY_SECONDS)
                self._wake.set()

    async def _write(self, transitions: list[_Transition]) -> None:
        by_tenant: dict[str, list[_Transition]] = {}
        for transition in transitions:
            by_tenant.setdefault(transition.tenant_id, []).append(transition)
        unwritten = list(transitions)
        try:
            for tenant_id, batch in by_tenant.items():
                owners: dict[str, str] = {}
                async with tenant_session(self._session_factory, tenant_id) as session:
                    for transition in batch:
                        owner_id = await self._write_one(session, transition)
                        if owner_id is not None:
                            owners[transition.controller_id] = owner_id
                    await session.commit()
                for transition in batch:
                    unwritten.remove(transition)
                for controller_id, owner_id in owners.items():
                    self._user_changes.publish(
                        tenant_id, owner_id, MACHINE, controller_id
                    )
        except BaseException:
            for transition in unwritten:
                self._pending.setdefault(transition.controller_id, transition)
            raise

    async def _write_one(
        self, session: AsyncSession, transition: _Transition
    ) -> str | None:
        """Write one transition. Returns the controller's owner when the row
        was written, so they can be told once it has committed."""
        if transition.disconnect_reason is None:
            owner_id = await self._controllers.record_connected(
                session,
                transition.tenant_id,
                transition.controller_id,
                connection_id=transition.connection_id,
                process_id=self._process_id,
                connected_at=transition.at,
            )
            if owner_id is None:
                logger.warning(
                    "Controller %s connected, but has no row to record it on",
                    transition.controller_id,
                )
            return owner_id
        owner_id = await self._controllers.record_disconnected(
            session,
            transition.tenant_id,
            transition.controller_id,
            connection_id=transition.connection_id,
            disconnected_at=transition.at,
            reason=transition.disconnect_reason,
        )
        if owner_id is None:
            logger.info(
                "Controller %s connection %s went (%s), but its row names a newer "
                "connection; left as it is",
                transition.controller_id,
                transition.connection_id,
                transition.disconnect_reason,
            )
        return owner_id
