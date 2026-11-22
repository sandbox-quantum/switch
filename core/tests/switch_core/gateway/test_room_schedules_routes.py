"""The gateway's room schedule routes, exercised as coroutines against real Postgres."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.room_schedules import (
    TEXT_LIMIT,
    RoomSchedulePause,
    RoomScheduleWrite,
    create_room_schedule,
    delete_room_schedule,
    list_room_schedules,
    pause_room_schedule,
    update_room_schedule,
)

ROOMS = RoomStore()


async def _user(session: AsyncSession, name: str) -> User:
    user = User(
        name=name, email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
    )
    session.add(user)
    await session.flush()
    return user


async def _room(session: AsyncSession, owner: User, *, write: str) -> Room:
    room = Room(
        transport_room_id=f"!{uuid.uuid4().hex[:8]}:test",
        name="standup",
        description="",
        owner_id=owner.id,
        read_visibility="public",
        write_visibility=write,
    )
    session.add(room)
    await session.flush()
    return room


async def _agent_in(session: AsyncSession, room: Room, owner: User) -> Agent:
    slug = uuid.uuid4().hex[:8]
    api_key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{slug}",
        encrypted_key="enc",
        label=slug,
        type="agent",
    )
    client = Client(transport_user_id=f"@{slug}:test", display_name=slug, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=f"triage-{slug}",
        description="",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner.id,
    )
    session.add(agent)
    await session.flush()
    await ROOMS.add_agents(session, room.id, [agent.id])
    return agent


def _weekdays(agent: Agent, **overrides: object) -> RoomScheduleWrite:
    body: dict[str, object] = {
        "agent_ids": [agent.id],
        "text": "Summarise the new issues.",
        "cron": "0 9 * * 1-5",
        "run_at": None,
        "timezone": "Europe/London",
    }
    body.update(overrides)
    return RoomScheduleWrite.model_validate(body)


async def test_the_room_owner_creates_and_lists_a_schedule(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        room = await _room(session, owner, write="private")
        agent = await _agent_in(session, room, owner)

        created = await create_room_schedule(
            room.id, _weekdays(agent), session, ROOMS, owner, False
        )
        listed = await list_room_schedules(room.id, session, ROOMS, owner, False)

    assert [schedule.id for schedule in listed] == [created.id]
    assert created.author_id == owner.id
    assert created.next_run_at is not None
    assert created.next_run_at > datetime.now(UTC)


async def test_someone_who_may_read_the_room_but_not_change_it_sees_and_cannot_add(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        reader = await _user(session, "reader")
        room = await _room(session, owner, write="private")
        agent = await _agent_in(session, room, owner)
        await create_room_schedule(
            room.id, _weekdays(agent), session, ROOMS, owner, False
        )

        assert (
            len(await list_room_schedules(room.id, session, ROOMS, reader, False)) == 1
        )
        with pytest.raises(HTTPException) as refused:
            await create_room_schedule(
                room.id, _weekdays(agent), session, ROOMS, reader, False
            )

    assert refused.value.status_code == 403


@pytest.mark.parametrize(
    ("overrides", "said"),
    [
        ({"timezone": "Mars/Olympus"}, "Unknown timezone"),
        ({"cron": "every so often"}, "not a cron rule"),
        (
            {"cron": None, "run_at": datetime(2020, 1, 1, tzinfo=UTC)},
            "in the future",
        ),
    ],
)
async def test_a_timing_switch_cannot_keep_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
    overrides: dict[str, object],
    said: str,
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        room = await _room(session, owner, write="private")
        agent = await _agent_in(session, room, owner)

        with pytest.raises(HTTPException) as refused:
            await create_room_schedule(
                room.id, _weekdays(agent, **overrides), session, ROOMS, owner, False
            )

    assert refused.value.status_code == 422
    assert said in str(refused.value.detail)


async def test_a_schedule_can_only_address_agents_in_its_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        room = await _room(session, owner, write="private")
        elsewhere = await _room(session, owner, write="private")
        outsider = await _agent_in(session, elsewhere, owner)

        with pytest.raises(HTTPException) as refused:
            await create_room_schedule(
                room.id, _weekdays(outsider), session, ROOMS, owner, False
            )

    assert refused.value.status_code == 422
    assert outsider.id in str(refused.value.detail)


async def test_whoever_edits_a_schedule_becomes_who_it_speaks_for(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        admin = await _user(session, "admin")
        room = await _room(session, owner, write="private")
        agent = await _agent_in(session, room, owner)
        created = await create_room_schedule(
            room.id, _weekdays(agent), session, ROOMS, owner, False
        )

        edited = await update_room_schedule(
            room.id,
            created.id,
            _weekdays(agent, text="Post the release notes."),
            session,
            ROOMS,
            admin,
            True,
        )

    assert (edited.author_id, edited.text) == (admin.id, "Post the release notes.")


async def test_writing_in_an_open_room_is_not_enough_to_change_its_schedules(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        writer = await _user(session, "writer")
        room = await _room(session, owner, write="public")
        agent = await _agent_in(session, room, owner)
        created = await create_room_schedule(
            room.id, _weekdays(agent), session, ROOMS, owner, False
        )
        attempts = [
            create_room_schedule(
                room.id, _weekdays(agent), session, ROOMS, writer, False
            ),
            update_room_schedule(
                room.id, created.id, _weekdays(agent), session, ROOMS, writer, False
            ),
            pause_room_schedule(
                room.id,
                created.id,
                RoomSchedulePause(paused=True),
                session,
                ROOMS,
                writer,
                False,
            ),
            delete_room_schedule(room.id, created.id, session, ROOMS, writer, False),
        ]
        refusals = []
        for attempt in attempts:
            with pytest.raises(HTTPException) as refused:
                await attempt
            refusals.append(refused.value.status_code)
        kept = await list_room_schedules(room.id, session, ROOMS, writer, False)

    assert refusals == [403, 403, 403, 403]
    assert [(s.id, s.author_id, s.paused) for s in kept] == [
        (created.id, owner.id, False)
    ]


async def test_resuming_starts_again_from_now_not_from_the_runs_it_missed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        room = await _room(session, owner, write="private")
        agent = await _agent_in(session, room, owner)
        created = await create_room_schedule(
            room.id, _weekdays(agent, cron="* * * * *"), session, ROOMS, owner, False
        )
        paused = await pause_room_schedule(
            room.id,
            created.id,
            RoomSchedulePause(paused=True),
            session,
            ROOMS,
            owner,
            False,
        )
        stored = await RoomScheduleStore().get(session, created.id)
        assert stored is not None
        stored.next_run_at = datetime.now(UTC) - timedelta(days=3)
        await session.flush()

        resumed = await pause_room_schedule(
            room.id,
            created.id,
            RoomSchedulePause(paused=False),
            session,
            ROOMS,
            owner,
            False,
        )

    assert paused.paused is True
    assert resumed.paused is False
    assert resumed.next_run_at is not None
    assert resumed.next_run_at > datetime.now(UTC)


async def test_a_schedule_is_deleted_only_through_its_own_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        room = await _room(session, owner, write="private")
        other = await _room(session, owner, write="private")
        agent = await _agent_in(session, room, owner)
        created = await create_room_schedule(
            room.id, _weekdays(agent), session, ROOMS, owner, False
        )

        with pytest.raises(HTTPException) as wrong_room:
            await delete_room_schedule(
                other.id, created.id, session, ROOMS, owner, False
            )
        await delete_room_schedule(room.id, created.id, session, ROOMS, owner, False)

        assert await list_room_schedules(room.id, session, ROOMS, owner, False) == []
    assert wrong_room.value.status_code == 404


def test_a_schedule_says_at_most_one_message() -> None:
    body = {
        "agent_ids": ["agent"],
        "cron": "0 9 * * *",
        "run_at": None,
        "timezone": "Europe/London",
    }
    RoomScheduleWrite.model_validate({**body, "text": "x" * TEXT_LIMIT})
    with pytest.raises(ValidationError):
        RoomScheduleWrite.model_validate({**body, "text": "x" * (TEXT_LIMIT + 1)})


async def test_a_person_who_edits_an_agents_schedule_takes_it_over(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        room = await _room(session, owner, write="private")
        agent = await _agent_in(session, room, owner)
        created = await create_room_schedule(
            room.id, _weekdays(agent), session, ROOMS, owner, False
        )
        stored = await RoomScheduleStore().get(session, created.id)
        assert stored is not None
        stored.author_agent_id = agent.id
        await session.commit()

        edited = await update_room_schedule(
            room.id, created.id, _weekdays(agent), session, ROOMS, owner, False
        )

    assert (edited.author_id, edited.author_agent_id) == (owner.id, None)
