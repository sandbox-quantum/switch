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

That row, and the lease of the process it names (`switch_core/process_lease.py`), are
what a machine's state is read from (`placement.controller_state`).

Which write wins, across processes: each is written only while the row
still names its connection, a connecting while that is the connection the
controller opened last and this process holds it, a closing while this
process holds its socket. So a write about a connection the controller has
since replaced, or reattached through another process, leaves the newer one
standing however late it lands. (Clocks are not compared: two processes'
clocks need not agree.) A closing also keeps where the connection's stream
resumes each agent, for a socket that reattaches through another process.

Each transition that took effect is announced (`announce`), so every other
process reads the row again and knows which process holds the socket now.

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
    resume_cursors: dict[str, int | None]


class ControllerConnectionLedger:
    """Core's `ControllerConnectionLedger`, written to `agent_controllers`."""

    def __init__(
        self,
        *,
        process_id: str,
        session_factory: async_sessionmaker[AsyncSession],
        controllers: AgentControllerStore,
        clock: Callable[[], datetime],
        announce: Callable[[str, str], None],
    ) -> None:
        self._process_id = process_id
        # Called with the tenant and the controller of each transition that
        # took effect, once it has committed.
        self._announce = announce
        self._session_factory = session_factory
        self._controllers = controllers
        self._clock = clock
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
            resume_cursors=dict(conn.resume_cursors),
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
                written: list[_Transition] = []
                async with tenant_session(self._session_factory, tenant_id) as session:
                    for transition in batch:
                        if await self._write_one(session, transition):
                            written.append(transition)
                    await session.commit()
                for transition in batch:
                    unwritten.remove(transition)
                for transition in written:
                    self._announce(transition.tenant_id, transition.controller_id)
        except BaseException:
            for transition in unwritten:
                self._pending.setdefault(transition.controller_id, transition)
            raise

    async def _write_one(self, session: AsyncSession, transition: _Transition) -> bool:
        """Write one transition. Returns whether it took effect."""
        if transition.disconnect_reason is None:
            written = await self._controllers.record_connected(
                session,
                transition.tenant_id,
                transition.controller_id,
                connection_id=transition.connection_id,
                process_id=self._process_id,
                connected_at=transition.at,
            )
            if not written:
                logger.info(
                    "Controller %s connection %s attached, but its row names a "
                    "newer connection or another process; left as it is",
                    transition.controller_id,
                    transition.connection_id,
                )
            return written
        written = await self._controllers.record_disconnected(
            session,
            transition.tenant_id,
            transition.controller_id,
            connection_id=transition.connection_id,
            process_id=self._process_id,
            disconnected_at=transition.at,
            reason=transition.disconnect_reason,
            resume_cursors=transition.resume_cursors,
        )
        if not written:
            logger.info(
                "Controller %s connection %s went (%s), but its row names a newer "
                "connection or another process; left as it is",
                transition.controller_id,
                transition.connection_id,
                transition.disconnect_reason,
            )
        return written
