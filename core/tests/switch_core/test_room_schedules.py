from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, Room, RoomSchedule, room_agents
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.room_schedules import (
    ScheduleTimingError,
    check_cron,
    first_run,
    next_cron_run,
    scheduled_text,
)
from tests.switch_core.room_schedule_helpers import (
    FakeAdmin,
    add_agent,
    add_room,
    add_user,
    make_scheduler,
    put_in_room,
    reload_schedule,
)

STORE = RoomScheduleStore()


class TestTiming:
    def test_cron_must_have_five_valid_fields(self) -> None:
        assert check_cron(" 0  9 * * 1-5 ") == "0 9 * * 1-5"
        for rule in ("0 9 * *", "0 0 9 * * 1-5", "61 * * * *", "every day"):
            with pytest.raises(ScheduleTimingError):
                check_cron(rule)

    def test_rule_keeps_wall_time_across_daylight_saving(self) -> None:
        # New York moved its clocks forward on 8 March 2026: 9:00 is 14:00 UTC
        # on the Friday before and 13:00 UTC on the Monday after.
        friday = next_cron_run(
            "0 9 * * 1-5",
            "America/New_York",
            datetime(2026, 3, 6, 12, 0, tzinfo=UTC),
        )
        monday = next_cron_run("0 9 * * 1-5", "America/New_York", friday)
        assert friday == datetime(2026, 3, 6, 14, 0, tzinfo=UTC)
        assert monday == datetime(2026, 3, 9, 13, 0, tzinfo=UTC)

    def test_first_run(self) -> None:
        now = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)
        soon = now + timedelta(hours=1)
        assert first_run(run_at=soon, cron=None, timezone="UTC", now=now) == soon
        assert first_run(
            run_at=None, cron="30 12 * * *", timezone="UTC", now=now
        ) == datetime(2026, 10, 28, 12, 30, tzinfo=UTC)

    @pytest.mark.parametrize(
        ("run_at", "cron", "timezone"),
        [
            (None, None, "UTC"),
            (datetime(2026, 10, 29, tzinfo=UTC), "0 9 * * *", "UTC"),
            (datetime(2026, 10, 27, tzinfo=UTC), None, "UTC"),
            (datetime(2026, 10, 29), None, "UTC"),
            (None, "0 9 * * *", "Mars/Olympus_Mons"),
        ],
    )
    def test_first_run_refuses(
        self, run_at: datetime | None, cron: str | None, timezone: str
    ) -> None:
        with pytest.raises(ScheduleTimingError):
            first_run(
                run_at=run_at,
                cron=cron,
                timezone=timezone,
                now=datetime(2026, 10, 28, tzinfo=UTC),
            )

    def test_text_mentions_each_agent_and_names_the_author(self) -> None:
        assert scheduled_text("Standup time", ["triage", "scribe"], "Ada") == (
            "@triage @scribe Standup time\n\n_Scheduled by Ada_"
        )


async def _room_with_schedule(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    cron: str | None,
    due_ago: timedelta,
) -> tuple[Room, str, list[str]]:
    """A room with agents `triage` and `scribe` in it and a schedule for both
    that fell due `due_ago`."""
    async with session_factory() as session:
        author = await add_user(session, "Ada")
        room = await add_room(session, "standup", owner_id=author.id)
        agents = [
            await add_agent(session, name, owner=author)
            for name in ("triage", "scribe")
        ]
        for agent in agents:
            await put_in_room(session, room, agent)
        due = datetime.now(UTC) - due_ago
        schedule = await STORE.create(
            session,
            room_id=room.id,
            author_id=author.id,
            author_agent_id=None,
            body="Summarise new issues",
            run_at=None if cron else due,
            cron=cron,
            timezone="UTC",
            next_run_at=due,
            agent_ids=[a.id for a in agents],
        )
        await session.commit()
        return room, schedule.id, [a.id for a in agents]


class TestRoomScheduler:
    async def test_fires_a_due_rule_once_and_moves_it_on(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room, schedule_id, _ = await _room_with_schedule(
            session_factory, cron="*/5 * * * *", due_ago=timedelta(seconds=30)
        )
        admin = FakeAdmin()
        scheduler = make_scheduler(session_factory, admin)

        assert await scheduler.fire_due(TENANT_ZERO_ID) == 1
        assert await scheduler.fire_due(TENANT_ZERO_ID) == 0

        [post] = admin.posted
        assert post["room"] == room.transport_room_id
        assert post["body"] == (
            "@scribe @triage Summarise new issues\n\n_Scheduled by Ada_"
        )
        assert post["for"].name == "Ada"
        row = await reload_schedule(session_factory, schedule_id)
        assert row.next_run_at is not None and row.next_run_at > datetime.now(UTC)
        assert row.last_run_at is not None and row.last_error is None

    async def test_a_one_off_fires_and_is_done(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, schedule_id, _ = await _room_with_schedule(
            session_factory, cron=None, due_ago=timedelta(seconds=5)
        )
        admin = FakeAdmin()

        assert (
            await make_scheduler(session_factory, admin).fire_due(TENANT_ZERO_ID) == 1
        )

        assert len(admin.posted) == 1
        assert (await reload_schedule(session_factory, schedule_id)).next_run_at is None

    async def test_runs_missed_while_down_fire_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, schedule_id, _ = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(days=3)
        )
        admin = FakeAdmin()
        scheduler = make_scheduler(session_factory, admin)

        assert await scheduler.fire_due(TENANT_ZERO_ID) == 1
        assert await scheduler.fire_due(TENANT_ZERO_ID) == 0
        assert len(admin.posted) == 1
        row = await reload_schedule(session_factory, schedule_id)
        assert row.next_run_at is not None and row.next_run_at > datetime.now(UTC)

    async def test_an_agent_that_left_is_dropped_with_a_notice(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room, schedule_id, (triage_id, scribe_id) = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(seconds=5)
        )
        async with session_factory() as session:
            await session.execute(
                delete(room_agents).where(room_agents.c.agent_id == scribe_id)
            )
            await session.commit()
        admin = FakeAdmin()

        await make_scheduler(session_factory, admin).fire_due(TENANT_ZERO_ID)

        [post] = admin.posted
        assert post["body"].startswith("@triage Summarise")
        assert admin.notices == [
            "A scheduled message no longer addresses scribe, who left this room."
        ]
        async with session_factory() as session:
            assert await STORE.agent_ids(session, [schedule_id]) == {
                schedule_id: [triage_id]
            }

    async def test_a_schedule_left_with_no_agents_is_paused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, schedule_id, _ = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(seconds=5)
        )
        async with session_factory() as session:
            await session.execute(delete(room_agents))
            await session.commit()
        admin = FakeAdmin()

        await make_scheduler(session_factory, admin).fire_due(TENANT_ZERO_ID)

        assert admin.posted == []
        assert admin.notices[-1] == (
            "A scheduled message was paused. "
            "None of the agents it addresses is in the room any more."
        )
        row = await reload_schedule(session_factory, schedule_id)
        assert row.paused is True
        assert row.last_error is not None

    async def test_a_schedule_in_an_archived_room_is_paused_quietly(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room, schedule_id, _ = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(seconds=5)
        )
        async with session_factory() as session:
            await session.execute(
                update(Room)
                .where(Room.id == room.id)
                .values(archived_at=datetime.now(UTC))
            )
            await session.commit()
        admin = FakeAdmin()

        await make_scheduler(session_factory, admin).fire_due(TENANT_ZERO_ID)

        assert admin.posted == [] and admin.notices == []
        row = await reload_schedule(session_factory, schedule_id)
        assert row.paused is True and row.last_error == "The room is archived."

    async def test_a_post_that_fails_is_recorded(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, schedule_id, _ = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(seconds=5)
        )

        await make_scheduler(session_factory, FakeAdmin(fail=True)).fire_due(
            TENANT_ZERO_ID
        )

        row = await reload_schedule(session_factory, schedule_id)
        assert row.last_error == "Switch could not post the message."
        assert row.next_run_at is not None and row.next_run_at > datetime.now(UTC)

    async def test_a_process_without_the_admin_client_leaves_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, schedule_id, _ = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(seconds=5)
        )

        assert await make_scheduler(session_factory, None).fire_due(TENANT_ZERO_ID) == 0
        assert (await reload_schedule(session_factory, schedule_id)).last_run_at is None

    async def test_a_rule_that_cannot_be_read_pauses_rather_than_blocking(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, broken_id, _ = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(hours=1)
        )
        async with session_factory() as session:
            await session.execute(
                update(RoomSchedule)
                .where(RoomSchedule.id == broken_id)
                .values(timezone="Gone/Away")
            )
            await session.commit()
        admin = FakeAdmin()

        await make_scheduler(session_factory, admin).fire_due(TENANT_ZERO_ID)

        row = await reload_schedule(session_factory, broken_id)
        assert row.paused is True and row.last_error is not None
        assert admin.posted == []
