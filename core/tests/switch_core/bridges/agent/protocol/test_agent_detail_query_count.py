"""Agent detail must not issue queries in proportion to the agent's rooms.

This is the endpoint Switch Console polls for every agent it displays, at
roughly a hundred requests a minute in the pilot — the single largest
identifiable request in a burst profile. It used to walk the agent's rooms
issuing five queries per membership, so an agent in ten rooms cost fifty
round trips, each paying SQLAlchemy's async-bridge toll.

A count rather than a timing: the cost this guards is a number of round
trips, and asserting on it is stable where asserting on microseconds is not.
The shape of the assertion matters more than the constant — what must hold is
that going from three rooms to nine does not change it.
"""

from __future__ import annotations

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_detail import assemble_agent_detail
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.db.models import Agent, ApiKey, Client, Room, User, room_agents
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore


class _QueryCounter:
    """Counts statements actually sent to the database."""

    def __init__(self, engine) -> None:
        self._sync_engine = engine.sync_engine
        self.count = 0

    def _on_execute(self, *args) -> None:
        self.count += 1

    def __enter__(self) -> _QueryCounter:
        event.listen(self._sync_engine, "before_cursor_execute", self._on_execute)
        return self

    def __exit__(self, *exc) -> None:
        event.remove(self._sync_engine, "before_cursor_execute", self._on_execute)


async def _agent_in_rooms(
    session_factory: async_sessionmaker[AsyncSession], room_count: int
) -> str:
    async with session_factory() as session:
        user = User(name=f"o{room_count}", email=f"o{room_count}@x.com", role="user")
        session.add(user)
        await session.flush()
        key = ApiKey(
            user_id=user.id,
            key_hash=f"hash-qcount-{room_count}",
            encrypted_key="x",
            label="l",
            type="agent",
        )
        session.add(key)
        await session.flush()
        client = Client(
            matrix_user_id=f"@qcount-{room_count}:test",
            display_name="a",
            type="agent",
        )
        session.add(client)
        await session.flush()
        agent = Agent(
            name=f"qcount-{room_count}",
            description="d",
            agent_type="claude-code",
            connector_type="mcp",
            integration_profile={"connection_model": "auto_session"},
            client_id=client.id,
            api_key_id=key.id,
            owner_id=user.id,
        )
        session.add(agent)
        await session.flush()
        for i in range(room_count):
            room = Room(
                matrix_room_id=f"!qcount-{room_count}-{i}:test",
                name=f"r{i}",
                description="d",
                owner_id=user.id,
            )
            session.add(room)
            await session.flush()
            await session.execute(
                room_agents.insert().values(room_id=room.id, agent_id=agent.id)
            )
        await session.commit()
        return agent.id


async def _count_for(
    session_factory: async_sessionmaker[AsyncSession], room_count: int
) -> int:
    agent_id = await _agent_in_rooms(session_factory, room_count)
    agent_store = AgentStore()
    engine = session_factory.kw["bind"]
    async with session_factory() as session:
        agent = await agent_store.get(session, agent_id)
        assert agent is not None
        with _QueryCounter(engine) as counter:
            detail = await assemble_agent_detail(
                session,
                agent=agent,
                agent_store=agent_store,
                room_store=RoomStore(),
                user_store=UserStore(),
                agent_session_store=AgentSessionStore(),
                room_role_store=RoomRoleStore(),
                connections=ConnectionRegistry(),
            )
    assert len(detail.rooms) == room_count
    return counter.count


async def test_query_count_does_not_grow_with_the_number_of_rooms(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    three = await _count_for(session_factory, 3)
    nine = await _count_for(session_factory, 9)

    assert nine == three, (
        f"agent detail issued {three} queries for 3 rooms and {nine} for 9 — "
        "it is querying per room again, which is what the Console's polling "
        "made expensive"
    )


async def test_the_count_is_small(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # A loose ceiling, to catch a new per-request query being added without
    # anyone noticing, while leaving room for honest change. Before batching
    # this was 20+ at three rooms and grew from there.
    count = await _count_for(session_factory, 3)
    assert count <= 12, f"agent detail now issues {count} queries per request"
