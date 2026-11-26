"""An agent managing a room's schedules through its Switch tools.

A schedule an agent sets up is posted as that agent, under its owner's
authority, so the tools ask the owner's right to manage the room, ask that the
agent be in it, and let an agent change only the schedules it set up itself.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_and_owner_agents_policy
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import Agent, ApiKey, Client, Room, RoomSchedule, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore

ROOMS = RoomStore()
SCHEDULES = RoomScheduleStore()
WEEKDAYS = {"cron": "0 9 * * 1-5", "run_at": None, "timezone": "Europe/London"}


def _core(session_factory: async_sessionmaker[AsyncSession]) -> AgentCore:
    core = object.__new__(AgentCore)
    core.session_factory = session_factory
    core.agent_store = AgentStore()
    core.room_store = ROOMS
    core.user_store = UserStore()
    return core


async def _user(session: AsyncSession, name: str) -> User:
    user = User(
        name=name, email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
    )
    session.add(user)
    await session.flush()
    return user


async def _room(session: AsyncSession, owner: User) -> Room:
    room = Room(
        transport_room_id=f"!{uuid.uuid4().hex[:8]}:test",
        name="standup",
        description="",
        owner_id=owner.id,
        read_visibility="public",
        write_visibility="public",
    )
    session.add(room)
    await session.flush()
    return room


async def _agent(session: AsyncSession, owner: User, name: str) -> Agent:
    slug = uuid.uuid4().hex[:8]
    api_key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{slug}",
        encrypted_key="enc",
        label=slug,
        type="agent",
    )
    client = Client(transport_user_id=f"@{slug}:test", display_name=name, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=f"{name}-{slug}",
        description="",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner.id,
        # Takes requests from its owner and their agents, so it acts with its
        # owner's rights on the room (`room_policy`).
        addressing_policy=owner_and_owner_agents_policy().model_dump(),
    )
    session.add(agent)
    await session.flush()
    return agent


async def _room_with(
    session_factory: async_sessionmaker[AsyncSession], *, caller_owns_room: bool
) -> tuple[Room, User, Agent, Agent]:
    """A room holding the calling agent and a second one, and who owns the caller."""
    async with session_factory() as session:
        owner = await _user(session, "ada")
        room_owner = owner if caller_owns_room else await _user(session, "grace")
        room = await _room(session, room_owner)
        caller = await _agent(session, owner, "triage")
        other = await _agent(session, owner, "repro")
        await ROOMS.add_agents(session, room.id, [caller.id, other.id])
        await session.commit()
        return room, owner, caller, other


async def test_an_agent_sets_up_a_schedule_that_speaks_as_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room, owner, caller, other = await _room_with(
        session_factory, caller_owns_room=True
    )

    view = await _core(session_factory).create_room_schedule(
        caller.id,
        room.id,
        agents=[caller.name, f"@{other.name}"],
        text="Summarise the new issues.",
        **WEEKDAYS,
    )

    assert view["agents"] == [caller.name, other.name]
    assert view["set_up_by_you"] is True and view["next_run_at"] is not None
    async with session_factory() as session:
        stored = await SCHEDULES.get(session, view["id"])
    assert stored is not None
    assert (stored.author_id, stored.author_agent_id) == (owner.id, caller.id)


async def test_an_agent_whose_owner_may_not_manage_the_room_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room, _, caller, _ = await _room_with(session_factory, caller_owns_room=False)

    with pytest.raises(PermissionError, match="manage the room"):
        await _core(session_factory).create_room_schedule(
            caller.id, room.id, agents=[caller.name], text="Hello.", **WEEKDAYS
        )


async def test_an_agent_others_may_address_is_refused_in_its_owners_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A schedule carries its owner's authority, so an agent anyone may ask
    can't set one up with the room owner's rights (`room_policy`)."""
    room, _, caller, _ = await _room_with(session_factory, caller_owns_room=True)
    async with session_factory() as session:
        agent = await session.get(Agent, caller.id)
        assert agent is not None
        agent.addressing_policy = None
        await session.commit()

    with pytest.raises(PermissionError, match="manage the room"):
        await _core(session_factory).create_room_schedule(
            caller.id, room.id, agents=[caller.name], text="Hello.", **WEEKDAYS
        )


async def test_an_agent_cannot_schedule_into_a_room_it_is_not_in(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room, owner, _, _ = await _room_with(session_factory, caller_owns_room=True)
    async with session_factory() as session:
        outsider = await _agent(session, owner, "outsider")
        await session.commit()

    with pytest.raises(PermissionError, match="room you are in"):
        await _core(session_factory).create_room_schedule(
            outsider.id, room.id, agents=[], text="Hello.", **WEEKDAYS
        )


async def test_a_name_not_in_the_room_is_refused_and_named(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room, _, caller, _ = await _room_with(session_factory, caller_owns_room=True)

    with pytest.raises(ValueError, match="Not here: nobody"):
        await _core(session_factory).create_room_schedule(
            caller.id, room.id, agents=["nobody"], text="Hello.", **WEEKDAYS
        )


async def test_an_agent_changes_its_own_schedules_and_not_a_persons(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room, owner, caller, _ = await _room_with(session_factory, caller_owns_room=True)
    core = _core(session_factory)
    own = await core.create_room_schedule(
        caller.id, room.id, agents=[caller.name], text="Check CI.", **WEEKDAYS
    )
    async with session_factory() as session:
        persons = await SCHEDULES.create(
            session,
            RoomSchedule(
                room_id=room.id,
                author_id=owner.id,
                agent_ids=[caller.id],
                text="A person's.",
                cron="0 9 * * *",
                run_at=None,
                timezone="Europe/London",
                paused=False,
                next_run_at=datetime.now(UTC) + timedelta(days=1),
            ),
        )
        await session.commit()

    for attempt in (
        core.update_room_schedule(
            caller.id,
            room.id,
            persons.id,
            agents=[caller.name],
            text="Mine now.",
            **WEEKDAYS,
        ),
        core.pause_room_schedule(caller.id, room.id, persons.id, paused=True),
        core.delete_room_schedule(caller.id, room.id, persons.id),
    ):
        with pytest.raises(PermissionError, match="you set up yourself"):
            await attempt

    paused = await core.pause_room_schedule(caller.id, room.id, own["id"], paused=True)
    edited = await core.update_room_schedule(
        caller.id,
        room.id,
        own["id"],
        agents=[caller.name],
        text="Check CI twice.",
        **WEEKDAYS,
    )
    await core.delete_room_schedule(caller.id, room.id, own["id"])

    assert paused["paused"] is True and edited["text"] == "Check CI twice."
    listed = await core.list_room_schedules(caller.id, room.id)
    assert [(s["id"], s["text"], s["set_up_by_you"]) for s in listed] == [
        (persons.id, "A person's.", False)
    ]
