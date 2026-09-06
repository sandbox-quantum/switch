from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import BridgeMessageMap


class BridgeMessageMapStore:
    async def create(
        self, session: AsyncSession, mapping: BridgeMessageMap
    ) -> BridgeMessageMap:
        session.add(mapping)
        await session.flush()
        return mapping

    async def get_by_transport_event_id(
        self, session: AsyncSession, bridge_id: str, transport_event_id: str
    ) -> BridgeMessageMap | None:
        result = await session.execute(
            select(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_external_post_id(
        self, session: AsyncSession, bridge_id: str, external_post_id: str
    ) -> BridgeMessageMap | None:
        result = await session.execute(
            select(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.external_post_id == external_post_id,
            )
        )
        return result.scalar_one_or_none()

    async def delete_by_transport_event_id(
        self, session: AsyncSession, bridge_id: str, transport_event_id: str
    ) -> None:
        await session.execute(
            delete(BridgeMessageMap).where(
                BridgeMessageMap.bridge_id == bridge_id,
                BridgeMessageMap.transport_event_id == transport_event_id,
            )
        )
        await session.flush()
