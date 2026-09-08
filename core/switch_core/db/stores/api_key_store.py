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

    async def get_by_type(self, session: AsyncSession, key_type: str) -> list[ApiKey]:
        """Every key of a given type, regardless of which user owns it.

        Used where a type is meant to be a deployment-wide singleton (the
        agent-registration bootstrap key) and existence must not depend on
        which user currently holds it.
        """
        result = await session.execute(select(ApiKey).where(ApiKey.type == key_type))
        return list(result.scalars().all())

    async def get_by_label(self, session: AsyncSession, label: str) -> list[ApiKey]:
        """Every key carrying a given label, regardless of type or owner.

        Labels are free text, so this is a discovery aid, not an identity
        lookup — a caller matching against a known auto-generated label
        (never one a user is expected to type) still has to check the type
        and, ideally, the hash, before treating a match as authoritative.
        """
        result = await session.execute(select(ApiKey).where(ApiKey.label == label))
        return list(result.scalars().all())

    async def delete(self, session: AsyncSession, key_id: str) -> None:
        key = await session.get(ApiKey, key_id)
        if key:
            await session.delete(key)
            await session.flush()
