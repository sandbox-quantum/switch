from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_runtime_state_store import AgentRuntimeStateStore


async def _make_agent(session: AsyncSession, name: str) -> Agent:
    """Minimal User → ApiKey → Client → Agent chain (agent_runtime_states FK)."""
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{name}:test",
        display_name=name,
        type="agent",
        password="x",
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


async def _make_room(session: AsyncSession, name: str) -> Room:
    room = Room(
        matrix_room_id=f"!{name}:test",
        name=name,
        description=f"{name} desc",
    )
    session.add(room)
    await session.flush()
    return room


SUBAGENTS = [
    {
        "agent_id": "sub-1",
        "agent_name": "Explore",
        "state": "working",
        "detail": "reading models.py",
    }
]


async def test_active_subagents_round_trip(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = AgentRuntimeStateStore()
    async with session_factory() as session:
        agent = await _make_agent(session, "worker")
        room = await _make_room(session, "room")

        await store.upsert(
            session, agent.id, room.id, "working", active_subagents=SUBAGENTS
        )
        await session.commit()

        row = await store.get(session, agent.id, room.id)
        assert row is not None
        assert row.active_subagents == SUBAGENTS


async def test_a_report_without_subagents_preserves_the_last_list(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Null means "unchanged", the same rule the deeplink and the control
    # capabilities follow: a report that carries no list must not wipe one.
    store = AgentRuntimeStateStore()
    async with session_factory() as session:
        agent = await _make_agent(session, "worker")
        room = await _make_room(session, "room")

        await store.upsert(
            session, agent.id, room.id, "working", active_subagents=SUBAGENTS
        )
        await store.upsert(session, agent.id, room.id, "working")
        await session.commit()

        row = await store.get(session, agent.id, room.id)
        assert row is not None
        assert row.active_subagents == SUBAGENTS


async def test_an_empty_list_clears_the_subagents(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # The last subagent finishing is reported as an empty list, not as null,
    # so the indicator loses its subagent lines.
    store = AgentRuntimeStateStore()
    async with session_factory() as session:
        agent = await _make_agent(session, "worker")
        room = await _make_room(session, "room")

        await store.upsert(
            session, agent.id, room.id, "working", active_subagents=SUBAGENTS
        )
        await store.upsert(session, agent.id, room.id, "working", active_subagents=[])
        await session.commit()

        row = await store.get(session, agent.id, room.id)
        assert row is not None
        assert row.active_subagents == []
