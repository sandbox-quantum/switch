"""Reading an agent's turns back from the activity rows its session reported."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    AgentSessionActivityItem,
    ApiKey,
    Client,
    Room,
    User,
)
from switch_core.db.stores.session_activity_store import (
    TURN_ITEM_ID,
    AgentSessionActivityStore,
)


async def _agent(session: AsyncSession) -> Agent:
    slug = uuid.uuid4().hex[:8]
    user = User(name=slug, email=f"{slug}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{slug}",
        encrypted_key="enc",
        label=slug,
        type="agent",
    )
    client = Client(transport_user_id=f"@{slug}:test", display_name=slug, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=f"agent-{slug}",
        description="",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=user.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _room(session: AsyncSession) -> Room:
    room = Room(
        transport_room_id=f"!{uuid.uuid4().hex[:8]}:test", name="room", description=""
    )
    session.add(room)
    await session.flush()
    return room


def _step(
    agent: Agent, room: Room, turn_id: str, item_id: str
) -> AgentSessionActivityItem:
    return AgentSessionActivityItem(
        tenant_id=agent.tenant_id,
        agent_id=agent.id,
        session_id="session",
        turn_id=turn_id,
        item_id=item_id,
        kind="turn" if item_id == TURN_ITEM_ID else "user-message",
        revision=1,
        status="queued" if item_id == TURN_ITEM_ID else "completed",
        title="",
        text="",
        room_id=room.id,
        message_id="$asked",
        occurred_at=datetime.now(UTC),
    )


async def test_a_turn_is_found_by_its_id_in_the_room_it_was_asked_in(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session)
        room = await _room(session)
        session.add_all(
            [
                _step(agent, room, "turn-1", TURN_ITEM_ID),
                _step(agent, room, "turn-1", "user-1"),
            ]
        )
        await session.flush()

        found = await AgentSessionActivityStore().turn_in_room(
            session, agent.id, room.id, "turn-1"
        )

    assert found is not None
    assert (found.item_id, found.status, found.message_id) == (
        TURN_ITEM_ID,
        "queued",
        "$asked",
    )


async def test_a_turn_asked_in_another_room_is_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session)
        asked_in = await _room(session)
        elsewhere = await _room(session)
        session.add(_step(agent, asked_in, "turn-1", TURN_ITEM_ID))
        await session.flush()

        found = await AgentSessionActivityStore().turn_in_room(
            session, agent.id, elsewhere.id, "turn-1"
        )

    assert found is None


async def test_another_agents_turn_with_the_same_id_is_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        asked = await _agent(session)
        other = await _agent(session)
        room = await _room(session)
        session.add(_step(asked, room, "turn-1", TURN_ITEM_ID))
        await session.flush()

        found = await AgentSessionActivityStore().turn_in_room(
            session, other.id, room.id, "turn-1"
        )

    assert found is None


async def test_only_queued_turns_in_the_room_are_found_by_the_start_of_their_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agent = await _agent(session)
        room, elsewhere = await _room(session), await _room(session)
        running = _step(agent, room, "3f9c1a7e-run", TURN_ITEM_ID)
        running.status = "running"
        session.add_all(
            [
                _step(agent, room, "3f9c1a7e-one", TURN_ITEM_ID),
                _step(agent, room, "3f9c1a7e-two", TURN_ITEM_ID),
                running,
                _step(agent, elsewhere, "3f9c1a7e-far", TURN_ITEM_ID),
                _step(agent, room, "9d00b2c1-own", TURN_ITEM_ID),
            ]
        )
        await session.flush()
        store = AgentSessionActivityStore()

        found = await store.queued_in_room_starting(
            session, agent.id, room.id, "3f9c1a7e"
        )
        assert [row.turn_id for row in found] == ["3f9c1a7e-one", "3f9c1a7e-two"]
        # What a phone keyboard capitalised still finds them.
        capitalised = await store.queued_in_room_starting(
            session, agent.id, room.id, "3F9C1a7e"
        )
        assert [row.turn_id for row in capitalised] == [
            "3f9c1a7e-one",
            "3f9c1a7e-two",
        ]
        # A wildcard in what was typed is matched as itself.
        assert (
            await store.queued_in_room_starting(session, agent.id, room.id, "%") == []
        )
