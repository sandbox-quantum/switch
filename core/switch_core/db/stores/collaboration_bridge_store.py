from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import CollaborationBridge


class CollaborationBridgeStore:
    async def create(
        self, session: AsyncSession, bridge: CollaborationBridge
    ) -> CollaborationBridge:
        session.add(bridge)
        await session.flush()
        return bridge

    async def get(
        self, session: AsyncSession, bridge_id: str
    ) -> CollaborationBridge | None:
        return await session.get(CollaborationBridge, bridge_id)

    async def get_all(self, session: AsyncSession) -> list[CollaborationBridge]:
        result = await session.execute(select(CollaborationBridge))
        return list(result.scalars().all())

    async def get_active(self, session: AsyncSession) -> list[CollaborationBridge]:
        result = await session.execute(
            select(CollaborationBridge).where(CollaborationBridge.status == "active")
        )
        return list(result.scalars().all())

    async def update_status(
        self, session: AsyncSession, bridge_id: str, status: str
    ) -> None:
        bridge = await session.get(CollaborationBridge, bridge_id)
        if bridge is None:
            raise ValueError(f"Bridge not found: {bridge_id}")
        bridge.status = status
        await session.flush()

    async def set_agent_greetings_enabled(
        self, session: AsyncSession, bridge_id: str, enabled: bool
    ) -> CollaborationBridge:
        bridge = await session.get(CollaborationBridge, bridge_id)
        if bridge is None:
            raise ValueError(f"Bridge not found: {bridge_id}")
        bridge.agent_greetings_enabled = enabled
        await session.flush()
        return bridge

    async def set_service_url(
        self, session: AsyncSession, bridge_id: str, service_url: str
    ) -> None:
        """Persist a learned outbound serviceUrl into ``connection_config`` so it
        survives a restart. Reassigns the dict so SQLAlchemy tracks the change."""
        bridge = await session.get(CollaborationBridge, bridge_id)
        if bridge is None:
            raise ValueError(f"Bridge not found: {bridge_id}")
        bridge.connection_config = {
            **(bridge.connection_config or {}),
            "service_url": service_url,
        }
        await session.flush()

    async def delete(self, session: AsyncSession, bridge_id: str) -> None:
        bridge = await session.get(CollaborationBridge, bridge_id)
        if bridge:
            await session.delete(bridge)
            await session.flush()
