"""A bridge's per-recipient hourly send count, shared by every switch-core process.

A bridge's platform connection runs in one process, but a webhook reaches
whichever process the load balancer picks, and replies to it go out from
there. A limit counted in memory would let each process send its own limit,
start again after a restart, and tell the recipient once per process. The
count lives in `bridge_hourly_sends` instead.

The hour is a clock hour on the database's clock, not a rolling sixty minutes,
so a recipient can be sent up to twice the limit across the turn of an hour.
"""

from __future__ import annotations

from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.bridge_send_store import BridgeSendStore


class SendLedger(Protocol):
    async def spent(self, recipient: str) -> int: ...

    async def spend(self, recipient: str, units: int) -> int:
        """Count `units` against this hour and return the hour's total."""
        ...

    async def refund(self, recipient: str, units: int) -> None:
        """Take back `units` spent on a send that did not go out."""
        ...

    async def claim_limit_notice(self, recipient: str) -> bool:
        """True for the one caller this hour that should say the limit is reached."""
        ...

    async def release_limit_notice(self, recipient: str) -> None: ...


class StoredSendLedger:
    """One bridge's `SendLedger`, kept in the database."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        tenant_id: str,
        bridge_id: str,
    ) -> None:
        self._session_factory = session_factory
        self._tenant_id = tenant_id
        self._bridge_id = bridge_id
        self._store = BridgeSendStore()

    async def spent(self, recipient: str) -> int:
        async with tenant_session(self._session_factory, self._tenant_id) as session:
            return await self._store.spent(
                session, bridge_id=self._bridge_id, recipient=recipient
            )

    async def spend(self, recipient: str, units: int) -> int:
        async with tenant_session(self._session_factory, self._tenant_id) as session:
            total = await self._store.spend(
                session, bridge_id=self._bridge_id, recipient=recipient, units=units
            )
            await session.commit()
            return total

    async def refund(self, recipient: str, units: int) -> None:
        async with tenant_session(self._session_factory, self._tenant_id) as session:
            await self._store.refund(
                session, bridge_id=self._bridge_id, recipient=recipient, units=units
            )
            await session.commit()

    async def claim_limit_notice(self, recipient: str) -> bool:
        async with tenant_session(self._session_factory, self._tenant_id) as session:
            claimed = await self._store.claim_limit_notice(
                session, bridge_id=self._bridge_id, recipient=recipient
            )
            await session.commit()
            return claimed

    async def release_limit_notice(self, recipient: str) -> None:
        async with tenant_session(self._session_factory, self._tenant_id) as session:
            await self._store.release_limit_notice(
                session, bridge_id=self._bridge_id, recipient=recipient
            )
            await session.commit()
