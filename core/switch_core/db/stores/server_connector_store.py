from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import ServerConnector


class ServerConnectorStore:
    async def create(
        self, session: AsyncSession, connector: ServerConnector
    ) -> ServerConnector:
        session.add(connector)
        await session.flush()
        return connector

    async def get(
        self, session: AsyncSession, connector_id: str
    ) -> ServerConnector | None:
        return await session.get(ServerConnector, connector_id)

    async def get_all(self, session: AsyncSession) -> list[ServerConnector]:
        result = await session.execute(select(ServerConnector))
        return list(result.scalars().all())

    async def get_active(self, session: AsyncSession) -> list[ServerConnector]:
        result = await session.execute(
            select(ServerConnector).where(ServerConnector.status == "active")
        )
        return list(result.scalars().all())

    async def update_status(
        self, session: AsyncSession, connector_id: str, status: str
    ) -> None:
        connector = await session.get(ServerConnector, connector_id)
        if connector is None:
            raise ValueError(f"Connector not found: {connector_id}")
        connector.status = status
        await session.flush()

    async def delete(self, session: AsyncSession, connector_id: str) -> None:
        """Delete the connector, raising when this session cannot see it.

        Matching `update_status` above rather than the silent no-op this used
        to be. Row-level security makes "no such connector" and "not this
        tenant's connector" the same empty lookup, so returning quietly is not
        a harmless idempotent delete — it is the shape a cross-tenant delete
        takes, and the caller went on to log a removal that had not happened.
        """
        connector = await session.get(ServerConnector, connector_id)
        if connector is None:
            raise ValueError(f"Connector not found: {connector_id}")
        await session.delete(connector)
        await session.flush()
