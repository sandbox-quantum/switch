"""The schedule tools an agent calls: it acts on the room as its owner, and a
schedule it sets is judged as the agent speaking, never with its owner's
authority."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import TENANT_ZERO_ID, Agent, Room
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.room_schedules import RoomSchedules
from tests.switch_core.room_schedule_helpers import (
    FakeAdmin,
    add_agent,
    add_room,
    add_user,
    make_scheduler,
    put_in_room,
    reload_schedule,
)


def _core(session_factory: async_sessionmaker[AsyncSession]) -> AgentCore:
    core = object.__new__(AgentCore)
    core.session_factory = session_factory  # type: ignore[misc]
    core.agent_store = AgentStore()
    core.room_store = RoomStore()
    core.user_store = UserStore()
    core.room_schedules = RoomSchedules(RoomScheduleStore(), core.room_store)
    return core


async def _setup(
    session_factory: async_sessionmaker[AsyncSession], *, owns_room: bool
) -> tuple[Room, Agent, Agent]:
    """A room with `planner` (the calling agent) and `triage` in it. The
    planner's owner owns the room when `owns_room`."""
    async with session_factory() as session:
        owner = await add_user(session, "owner")
        stranger = await add_user(session, "stranger")
        room = await add_room(
            session, "standup", owner_id=owner.id if owns_room else stranger.id
        )
        planner = await add_agent(session, "planner", owner=owner)
        planner.owner_id = owner.id
        triage = await add_agent(session, "triage", owner=owner)
        for agent in (planner, triage):
            await put_in_room(session, room, agent)
        await session.commit()
        return room, planner, triage


class TestAgentScheduleTools:
    async def test_an_agent_schedules_by_name_and_is_its_author(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room, planner, _ = await _setup(session_factory, owns_room=True)
        core = _core(session_factory)

        created = await core.create_room_schedule(
            planner.id,
            room.id,
            agents=["@Triage"],
            message="Summarise new issues",
            run_at=None,
            cron="0 9 * * 1-5",
            timezone="Europe/London",
        )

        assert created["agents"] == ["triage"]
        assert created["set_by"] == "planner"
        assert created["next_run_at"] is not None
        row = await reload_schedule(session_factory, created["id"])
        assert row.author_agent_id == planner.id
        assert [
            s["id"] for s in await core.list_room_schedules(planner.id, room.id)
        ] == [created["id"]]

    async def test_an_agent_whose_owner_cannot_write_the_room_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room, planner, _ = await _setup(session_factory, owns_room=False)

        with pytest.raises(PermissionError):
            await _core(session_factory).create_room_schedule(
                planner.id,
                room.id,
                agents=["triage"],
                message="Hi",
                run_at=None,
                cron="0 9 * * *",
                timezone="UTC",
            )

    async def test_a_name_that_is_not_in_the_room_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room, planner, _ = await _setup(session_factory, owns_room=True)

        with pytest.raises(ValueError, match="nobody"):
            await _core(session_factory).create_room_schedule(
                planner.id,
                room.id,
                agents=["triage", "nobody"],
                message="Hi",
                run_at=None,
                cron="0 9 * * *",
                timezone="UTC",
            )

    async def test_pausing_keeps_the_author_and_editing_takes_it_over(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room, planner, triage = await _setup(session_factory, owns_room=True)
        async with session_factory() as session:
            owner = await add_user(session, "person")
            schedule = await RoomScheduleStore().create(
                session,
                room_id=room.id,
                author_id=owner.id,
                author_agent_id=None,
                body="From a person",
                run_at=None,
                cron="0 9 * * *",
                timezone="UTC",
                next_run_at=datetime.now(UTC) + timedelta(hours=1),
                agent_ids=[triage.id],
            )
            await session.commit()
        core = _core(session_factory)

        paused = await core.update_room_schedule(
            planner.id,
            room.id,
            schedule.id,
            agents=None,
            message=None,
            timing=None,
            timezone=None,
            paused=True,
        )
        assert paused["paused"] is True and paused["set_by"] == "person"

        edited = await core.update_room_schedule(
            planner.id,
            room.id,
            schedule.id,
            agents=None,
            message="From the planner now",
            timing=None,
            timezone=None,
            paused=None,
        )
        assert edited["set_by"] == "planner"

    async def test_a_schedule_it_set_fires_as_the_agent_speaking(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room, planner, _ = await _setup(session_factory, owns_room=True)
        created = await _core(session_factory).create_room_schedule(
            planner.id,
            room.id,
            agents=["triage"],
            message="Standup",
            run_at=datetime.now(UTC) + timedelta(minutes=5),
            cron=None,
            timezone="UTC",
        )
        async with session_factory() as session:
            row = await RoomScheduleStore().get(session, room.id, created["id"])
            assert row is not None
            row.next_run_at = datetime.now(UTC) - timedelta(seconds=1)
            await session.commit()
        admin = FakeAdmin()

        await make_scheduler(session_factory, admin).fire_due(TENANT_ZERO_ID)

        [post] = admin.posted
        assert post["for"].agent_id == planner.id
        assert post["for"].name == "planner"
        assert post["body"].endswith("_Scheduled by planner_")

    async def test_deleting_a_schedule_that_is_not_there_says_so(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room, planner, _ = await _setup(session_factory, owns_room=True)

        with pytest.raises(ValueError, match="No schedule"):
            await _core(session_factory).delete_room_schedule(
                planner.id, room.id, "missing"
            )
