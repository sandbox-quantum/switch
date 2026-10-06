from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, Tenant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore


async def _make_agent(session: AsyncSession, name: str, *, unique: str = "") -> Agent:
    """Minimal User → ApiKey → Client → Agent chain.

    `unique` disambiguates the user email / api-key hash / client matrix id —
    each globally unique columns — when two agents share `name` across
    tenants, since `name` itself is only unique per tenant.
    """
    slug = f"{name}-{unique}" if unique else name
    user = User(name=name, email=f"{slug}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{slug}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        transport_user_id=f"@{slug}:test",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


class TestGetByNameMultiTenant:
    """`Agent.name` is unique per tenant (`uq_agents_tenant_name`), not
    globally — two tenants may each have an agent of the same name. Before
    scoping the read, an unfiltered `get_by_name`/`get_by_name_insensitive`
    matched both rows and raised `MultipleResultsFound` out of every caller
    that resolves an agent by name (mention routing, registration, the
    gateway).

    Each tenant gets its own session, opened inside its own binding with
    `tenant_session`, for both the arrangement and the read back. A session's
    transaction is stamped with whatever tenant was bound when it began —
    `set_config` rides `after_begin`, issued once — so entering
    `tenant_scope(other_tenant)` around statements on the session already open
    for tenant zero would rebind the contextvar without moving what Postgres
    was told, and the two would disagree from that statement on.
    """

    async def test_get_by_name_returns_the_bound_tenants_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = AgentStore()
        other_tenant = f"tenant-{uuid.uuid4().hex[:8]}"

        async with session_factory() as session:
            session.add(Tenant(id=other_tenant, slug=other_tenant, name=other_tenant))
            await session.flush()
            own_id = (await _make_agent(session, "shared-name")).id
            await session.commit()

        async with tenant_session(session_factory, other_tenant) as other_session:
            other_id = (
                await _make_agent(other_session, "shared-name", unique="other")
            ).id
            await other_session.commit()

        async with session_factory() as verify:
            result = await store.get_by_name(verify, "shared-name")
            assert result is not None
            assert result.id == own_id

        async with tenant_session(session_factory, other_tenant) as verify:
            result = await store.get_by_name(verify, "shared-name")
            assert result is not None
            assert result.id == other_id

    async def test_get_by_name_insensitive_returns_the_bound_tenants_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = AgentStore()
        other_tenant = f"tenant-{uuid.uuid4().hex[:8]}"

        async with session_factory() as session:
            session.add(Tenant(id=other_tenant, slug=other_tenant, name=other_tenant))
            await session.flush()
            own_id = (await _make_agent(session, "SharedName")).id
            await session.commit()

        async with tenant_session(session_factory, other_tenant) as other_session:
            other_id = (
                await _make_agent(other_session, "sharedname", unique="other")
            ).id
            await other_session.commit()

        async with session_factory() as verify:
            result = await store.get_by_name_insensitive(verify, "sharedname")
            assert result is not None
            assert result.id == own_id

        async with tenant_session(session_factory, other_tenant) as verify:
            result = await store.get_by_name_insensitive(verify, "sharedname")
            assert result is not None
            assert result.id == other_id
