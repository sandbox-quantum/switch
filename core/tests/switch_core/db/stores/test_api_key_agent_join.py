"""`ApiKeyStore.get_with_agent_by_hash` resolves a bearer token and its agent in
one statement — the query that runs before every authenticated request."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore


async def _make_user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    return user


async def _make_key(
    session: AsyncSession, user: User, name: str, key_type: str
) -> ApiKey:
    key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type=key_type,
    )
    session.add(key)
    await session.flush()
    return key


async def _make_agent(session: AsyncSession, name: str, api_key: ApiKey) -> Agent:
    client = Client(
        matrix_user_id=f"@{name}:test",
        display_name=name,
        type="agent",
    )
    session.add(client)
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="session_addressable",
        connector_type="claude_code",
        integration_profile={},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


class TestGetWithAgentByHash:
    async def test_agent_key_returns_both_rows(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ApiKeyStore()
        async with session_factory() as session:
            user = await _make_user(session, "owner")
            key = await _make_key(session, user, "bot", "agent")
            agent = await _make_agent(session, "bot", key)
            await session.commit()

            found = await store.get_with_agent_by_hash(session, "hash-bot")

        assert found is not None
        loaded_key, loaded_agent = found
        assert loaded_key.id == key.id
        assert loaded_agent is not None
        assert loaded_agent.id == agent.id

    async def test_registration_key_has_no_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ApiKeyStore()
        async with session_factory() as session:
            user = await _make_user(session, "owner")
            key = await _make_key(session, user, "reg", "registration")
            await session.commit()

            found = await store.get_with_agent_by_hash(session, "hash-reg")

        assert found is not None
        loaded_key, loaded_agent = found
        assert loaded_key.id == key.id
        assert loaded_agent is None

    async def test_agent_key_with_no_agent_still_returns_the_key(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # An outer join, not an inner one: the caller decides what a key with
        # nothing behind it means, rather than seeing "no such token".
        store = ApiKeyStore()
        async with session_factory() as session:
            user = await _make_user(session, "owner")
            await _make_key(session, user, "orphan", "agent")
            await session.commit()

            found = await store.get_with_agent_by_hash(session, "hash-orphan")

        assert found is not None
        assert found[1] is None

    async def test_unknown_hash_is_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ApiKeyStore()
        async with session_factory() as session:
            assert await store.get_with_agent_by_hash(session, "nope") is None

    async def test_matches_the_two_query_resolution_it_replaces(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = ApiKeyStore()
        agents = AgentStore()
        async with session_factory() as session:
            user = await _make_user(session, "owner")
            key = await _make_key(session, user, "bot", "agent")
            await _make_agent(session, "bot", key)
            await session.commit()

            joined = await store.get_with_agent_by_hash(session, "hash-bot")
            separate_key = await store.get_by_hash(session, "hash-bot")
            assert separate_key is not None
            separate_agent = await agents.get_by_api_key_id(session, separate_key.id)

        assert joined is not None
        assert joined[0].id == separate_key.id
        assert separate_agent is not None
        assert joined[1] is not None
        assert joined[1].id == separate_agent.id
