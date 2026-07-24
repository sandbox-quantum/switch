from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Client


class ClientStore:
    async def get_all(self, session: AsyncSession) -> list[Client]:
        result = await session.execute(select(Client))
        return list(result.scalars().all())

    async def get(self, session: AsyncSession, client_id: str) -> Client | None:
        return await session.get(Client, client_id)

    async def get_by_matrix_user_id(
        self, session: AsyncSession, matrix_user_id: str
    ) -> Client | None:
        result = await session.execute(
            select(Client).where(Client.matrix_user_id == matrix_user_id)
        )
        return result.scalar_one_or_none()

    async def get_by_type(
        self, session: AsyncSession, client_type: str
    ) -> list[Client]:
        result = await session.execute(select(Client).where(Client.type == client_type))
        return list(result.scalars().all())

    async def create(self, session: AsyncSession, client: Client) -> Client:
        session.add(client)
        await session.flush()
        return client

    async def delete(self, session: AsyncSession, client_id: str) -> None:
        client = await session.get(Client, client_id)
        if client:
            await session.delete(client)
            await session.flush()

    async def update_state(
        self,
        session: AsyncSession,
        client_id: str,
        *,
        access_token: str | None = None,
        device_id: str | None = None,
        next_batch_token: str | None = None,
    ) -> None:
        client = await session.get(Client, client_id)
        if client is None:
            return
        if access_token is not None:
            client.access_token = access_token
        if device_id is not None:
            client.device_id = device_id
        if next_batch_token is not None:
            client.next_batch_token = next_batch_token
        await session.flush()
