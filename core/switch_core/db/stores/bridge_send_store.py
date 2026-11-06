from __future__ import annotations

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import BridgeHourlySend

# On the database's clock, so every process agrees which hour it is.
_THIS_HOUR = func.date_trunc("hour", func.now())


class BridgeSendStore:
    """What each bridge has sent each recipient this clock hour.

    Every change is one statement, so processes sending to the same recipient
    at once each see the others' sends.
    """

    async def spent(
        self, session: AsyncSession, *, bridge_id: str, recipient: str
    ) -> int:
        units = await session.scalar(
            select(BridgeHourlySend.units).where(
                BridgeHourlySend.bridge_id == bridge_id,
                BridgeHourlySend.recipient == recipient,
                BridgeHourlySend.hour == _THIS_HOUR,
            )
        )
        return units or 0

    async def spend(
        self, session: AsyncSession, *, bridge_id: str, recipient: str, units: int
    ) -> int:
        """Add `units` to this hour and return the hour's total, these included."""
        await session.execute(
            delete(BridgeHourlySend).where(
                BridgeHourlySend.bridge_id == bridge_id,
                BridgeHourlySend.recipient == recipient,
                BridgeHourlySend.hour < _THIS_HOUR,
            )
        )
        row = insert(BridgeHourlySend).values(
            bridge_id=bridge_id, recipient=recipient, hour=_THIS_HOUR, units=units
        )
        total = await session.scalar(
            row.on_conflict_do_update(
                index_elements=["tenant_id", "bridge_id", "recipient", "hour"],
                set_={"units": BridgeHourlySend.units + row.excluded.units},
            ).returning(BridgeHourlySend.units)
        )
        assert total is not None  # an upsert always returns its row
        return total

    async def claim_limit_notice(
        self, session: AsyncSession, *, bridge_id: str, recipient: str
    ) -> bool:
        """True for the one caller this hour that should tell the recipient the
        limit is reached; False for everyone after it, or if nothing was spent
        this hour (the limit can't be reached then)."""
        claimed = await session.scalar(
            update(BridgeHourlySend)
            .where(
                BridgeHourlySend.bridge_id == bridge_id,
                BridgeHourlySend.recipient == recipient,
                BridgeHourlySend.hour == _THIS_HOUR,
                BridgeHourlySend.told_limit.is_(False),
            )
            .values(told_limit=True)
            .returning(BridgeHourlySend.recipient)
        )
        return claimed is not None

    async def release_limit_notice(
        self, session: AsyncSession, *, bridge_id: str, recipient: str
    ) -> None:
        """Undo a claim whose notice could not be sent, so the next try sends it."""
        await session.execute(
            update(BridgeHourlySend)
            .where(
                BridgeHourlySend.bridge_id == bridge_id,
                BridgeHourlySend.recipient == recipient,
                BridgeHourlySend.hour == _THIS_HOUR,
            )
            .values(told_limit=False)
        )
