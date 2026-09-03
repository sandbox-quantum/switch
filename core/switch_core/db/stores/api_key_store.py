from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Agent, ApiKey


class ApiKeyStore:
    async def create(self, session: AsyncSession, key: ApiKey) -> None:
        session.add(key)
        await session.flush()

    async def get(self, session: AsyncSession, key_id: str) -> ApiKey | None:
        return await session.get(ApiKey, key_id)

    async def get_by_hash(self, session: AsyncSession, key_hash: str) -> ApiKey | None:
        result = await session.execute(
            select(ApiKey).where(ApiKey.key_hash == key_hash)
        )
        return result.scalar_one_or_none()

    async def get_with_agent_by_hash(
        self, session: AsyncSession, key_hash: str
    ) -> tuple[ApiKey, Agent | None] | None:
        """The key and the agent it belongs to, in one round trip.

        `None` when no key matches. The agent is `None` for a key nothing
        claims — a registration token, or an agent key whose agent is gone.
        This pair answers every authenticated request, so it is the one query
        worth not splitting in two.
        """
        result = await session.execute(
            select(ApiKey, Agent)
            .outerjoin(Agent, Agent.api_key_id == ApiKey.id)
            .where(ApiKey.key_hash == key_hash)
        )
        row = result.one_or_none()
        if row is None:
            return None
        return row[0], row[1]

    async def get_by_user(self, session: AsyncSession, user_id: str) -> list[ApiKey]:
        result = await session.execute(select(ApiKey).where(ApiKey.user_id == user_id))
        return list(result.scalars().all())

    async def get_by_user_and_type(
        self, session: AsyncSession, user_id: str, key_type: str
    ) -> list[ApiKey]:
        result = await session.execute(
            select(ApiKey).where(ApiKey.user_id == user_id, ApiKey.type == key_type)
        )
        return list(result.scalars().all())

    async def delete(self, session: AsyncSession, key_id: str) -> None:
        key = await session.get(ApiKey, key_id)
        if key:
            await session.delete(key)
            await session.flush()
