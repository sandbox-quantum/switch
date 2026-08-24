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

    async def get_default(self, session: AsyncSession) -> CollaborationBridge | None:
        """The bridge new rooms land on when none is named, or None when the
        instance has not nominated one."""
        result = await session.execute(
            select(CollaborationBridge).where(CollaborationBridge.is_default.is_(True))
        )
        return result.scalars().one_or_none()

    async def set_default(
        self, session: AsyncSession, bridge_id: str
    ) -> CollaborationBridge:
        """Nominate ``bridge_id`` as the instance default, demoting whichever
        bridge held it before. The demotion is flushed first because a partial
        unique index enforces a single default — writing the new one while the
        old is still set would collide."""
        bridge = await session.get(CollaborationBridge, bridge_id)
        if bridge is None:
            raise ValueError(f"Bridge not found: {bridge_id}")

        current = await self.get_default(session)
        if current is not None and current.id == bridge_id:
            return bridge
        if current is not None:
            current.is_default = False
            await session.flush()

        bridge.is_default = True
        await session.flush()
        return bridge

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

    async def set_channel_creation_enabled(
        self, session: AsyncSession, bridge_id: str, enabled: bool
    ) -> CollaborationBridge:
        bridge = await session.get(CollaborationBridge, bridge_id)
        if bridge is None:
            raise ValueError(f"Bridge not found: {bridge_id}")
        bridge.channel_creation_enabled = enabled
        await session.flush()
        return bridge

    async def merge_connection_config(
        self, session: AsyncSession, bridge_id: str, changes: dict[str, object]
    ) -> CollaborationBridge:
        """Merge `changes` into ``connection_config``, keeping untouched keys.

        Merging rather than replacing means an operator can flip one setting
        without re-sending the platform's tokens. Reassigns the dict so
        SQLAlchemy tracks the change."""
        bridge = await session.get(CollaborationBridge, bridge_id)
        if bridge is None:
            raise ValueError(f"Bridge not found: {bridge_id}")
        bridge.connection_config = {**(bridge.connection_config or {}), **changes}
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

    async def set_channel_team(
        self, session: AsyncSession, bridge_id: str, channel_id: str, team_id: str
    ) -> None:
        """Persist which team a channel belongs to into ``connection_config``.

        Merged into the existing map rather than replacing it, so learning one
        channel does not forget the rest. Reassigns the dicts so SQLAlchemy
        tracks the change (a mutated JSONB value is not detected)."""
        bridge = await session.get(CollaborationBridge, bridge_id)
        if bridge is None:
            raise ValueError(f"Bridge not found: {bridge_id}")
        config = dict(bridge.connection_config or {})
        known = dict(config.get("channel_teams") or {})
        known[channel_id] = team_id
        config["channel_teams"] = known
        bridge.connection_config = config
        await session.flush()

    async def delete(self, session: AsyncSession, bridge_id: str) -> None:
        bridge = await session.get(CollaborationBridge, bridge_id)
        if bridge:
            await session.delete(bridge)
            await session.flush()
