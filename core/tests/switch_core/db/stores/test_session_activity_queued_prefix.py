"""`!cancel` with the first characters of a turn ID: the store finds the
agent's queued turns in the room whose ID starts with them, and no others."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import AgentSessionActivityItem, Room, User
from switch_core.db.stores.session_activity_store import AgentSessionActivityStore
from tests.switch_core.gateway.agent_route_harness import add_agent

QUEUED = "3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f"
# Same first eight characters as QUEUED.
TWIN = "3f2b8c1e-0000-4000-8000-000000000001"
OTHER = "9a8b7c6d-5d4a-4b6c-9e7f-0a1b2c3d4e5f"


def _turn(
    agent_id: str, room_id: str, turn_id: str, status: str, session_id: str = "s1"
) -> AgentSessionActivityItem:
    return AgentSessionActivityItem(
        agent_id=agent_id,
        session_id=session_id,
        turn_id=turn_id,
        item_id="turn",
        kind="turn",
        revision=1,
        status=status,
        title="Turn",
        text="",
        room_id=room_id,
        message_id=f"$m-{turn_id}",
        occurred_at=datetime.now(UTC),
    )


async def _room(session: AsyncSession, owner: User, name: str) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test", name=name, description="", owner_id=owner.id
    )
    session.add(room)
    await session.flush()
    return room


async def test_only_this_agents_queued_turns_in_this_room_match(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = User(name="owner", email="owner@example.invalid", role="user")
        session.add(owner)
        await session.flush()
        helper = await add_agent(session, name="helper", owner_id=owner.id)
        other_agent = await add_agent(session, name="other", owner_id=owner.id)
        room = await _room(session, owner, "here")
        elsewhere = await _room(session, owner, "elsewhere")
        session.add_all(
            [
                _turn(helper.id, room.id, QUEUED, "queued"),
                _turn(helper.id, room.id, OTHER, "queued"),
                # Same prefix, but started, in another room, or another agent's.
                _turn(helper.id, room.id, TWIN, "running"),
                _turn(helper.id, elsewhere.id, TWIN, "queued", session_id="s2"),
                _turn(other_agent.id, room.id, TWIN, "queued", session_id="s3"),
            ]
        )
        await session.commit()

    store = AgentSessionActivityStore()
    async with session_factory() as session:
        found = await store.queued_turns_starting_with(
            session, helper.id, room.id, "3F2B8C1E"
        )
        longer = await store.queued_turns_starting_with(
            session, helper.id, room.id, QUEUED[:13]
        )
        none = await store.queued_turns_starting_with(
            session, helper.id, room.id, "0f2b8c1e"
        )
        # `%` and `_` are no wildcards.
        wild = await store.queued_turns_starting_with(
            session, helper.id, room.id, "3f2b%"
        )
        underscore = await store.queued_turns_starting_with(
            session, helper.id, room.id, "3f2b8c1_"
        )

    assert [row.turn_id for row in found] == [QUEUED]
    assert [row.turn_id for row in longer] == [QUEUED]
    assert none == []
    assert wild == []
    assert underscore == []


async def test_several_queued_turns_with_the_prefix_are_all_returned(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = User(name="owner", email="owner@example.invalid", role="user")
        session.add(owner)
        await session.flush()
        helper = await add_agent(session, name="helper", owner_id=owner.id)
        room = await _room(session, owner, "here")
        session.add_all(
            [
                _turn(helper.id, room.id, QUEUED, "queued"),
                _turn(helper.id, room.id, TWIN, "queued"),
                _turn(helper.id, room.id, OTHER, "queued"),
            ]
        )
        await session.commit()

    async with session_factory() as session:
        found = await AgentSessionActivityStore().queued_turns_starting_with(
            session, helper.id, room.id, QUEUED[:8]
        )

    assert sorted(row.turn_id for row in found) == sorted([QUEUED, TWIN])


async def test_a_stored_upper_case_id_matches_and_only_turn_rows_count(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = User(name="owner", email="owner@example.invalid", role="user")
        session.add(owner)
        await session.flush()
        helper = await add_agent(session, name="helper", owner_id=owner.id)
        room = await _room(session, owner, "here")
        # A step of a turn shares the turn's ID but is no turn itself.
        step = _turn(helper.id, room.id, TWIN, "queued")
        step.item_id = "tool-1"
        step.kind = "tool-activity"
        session.add_all([_turn(helper.id, room.id, OTHER.upper(), "queued"), step])
        await session.commit()

    store = AgentSessionActivityStore()
    async with session_factory() as session:
        found = await store.queued_turns_starting_with(
            session, helper.id, room.id, OTHER[:8]
        )
        steps = await store.queued_turns_starting_with(
            session, helper.id, room.id, TWIN[:8]
        )

    # Stored as the host sent it; matched case aside.
    assert [row.turn_id for row in found] == [OTHER.upper()]
    assert steps == []
