from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.mentions import mention_regex, strip_emphasis
from switch_core.db.models import TENANT_ZERO_ID, Room, RoomSchedule, room_agents
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.room_schedules import (
    ZERO_WIDTH_SPACE,
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

    def test_a_time_the_clocks_skip_fires_once_just_after_the_gap(self) -> None:
        # 02:30 did not happen in New York on 8 March 2026: it fires at 03:00
        # EDT that day, then at 02:30 EDT the next.
        on_the_day = next_cron_run(
            "30 2 * * *", "America/New_York", datetime(2026, 3, 7, 12, tzinfo=UTC)
        )
        after = next_cron_run("30 2 * * *", "America/New_York", on_the_day)
        assert on_the_day == datetime(2026, 3, 8, 7, 0, tzinfo=UTC)
        assert after == datetime(2026, 3, 9, 6, 30, tzinfo=UTC)

    def test_a_time_the_clocks_repeat_fires_only_the_first_time(self) -> None:
        # 01:30 happened twice in New York on 1 November 2026, at 05:30 UTC
        # (EDT) and 06:30 UTC (EST). A daily rule fires at the first only.
        first = next_cron_run(
            "30 1 * * *", "America/New_York", datetime(2026, 10, 31, 12, tzinfo=UTC)
        )
        assert first == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)
        assert next_cron_run("30 1 * * *", "America/New_York", first) == datetime(
            2026, 11, 2, 6, 30, tzinfo=UTC
        )
        # Swept a few seconds late, it still does not fire again an hour on.
        late = first + timedelta(seconds=7)
        assert next_cron_run("30 1 * * *", "America/New_York", late) == datetime(
            2026, 11, 2, 6, 30, tzinfo=UTC
        )

    def test_a_repeated_hour_is_not_run_twice_by_a_frequent_rule(self) -> None:
        # Every 15 minutes through the repeated hour: 01:00-01:45 EDT run, the
        # second 01:00-01:45 (EST) is passed over, and 02:00 EST comes next.
        after = datetime(2026, 11, 1, 5, 45, tzinfo=UTC)  # 01:45 EDT
        assert next_cron_run("*/15 * * * *", "America/New_York", after) == datetime(
            2026, 11, 1, 7, 0, tzinfo=UTC
        )

    def test_a_weekday_rule_in_india_skips_the_weekend(self) -> None:
        # Asia/Kolkata has no daylight saving: 09:00 IST is 03:30 UTC. From
        # Friday 6 November 2026 after 09:00, the next weekday is Monday.
        assert next_cron_run(
            "0 9 * * 1-5", "Asia/Kolkata", datetime(2026, 11, 6, 4, tzinfo=UTC)
        ) == datetime(2026, 11, 9, 3, 30, tzinfo=UTC)

    def test_the_next_run_is_strictly_after_the_time_given(self) -> None:
        exactly = datetime(2026, 11, 6, 9, 0, tzinfo=UTC)
        assert next_cron_run("0 9 * * *", "UTC", exactly) == exactly + timedelta(days=1)

    def test_a_one_off_with_an_offset_is_kept_as_the_same_instant(self) -> None:
        ist = timezone(timedelta(hours=5, minutes=30))
        run_at = datetime(2026, 11, 8, 9, 0, tzinfo=ist)
        stored = first_run(
            run_at=run_at,
            cron=None,
            timezone="Asia/Kolkata",
            now=datetime(2026, 11, 7, tzinfo=UTC),
        )
        assert stored == datetime(2026, 11, 8, 3, 30, tzinfo=UTC)
        assert stored.tzinfo == UTC

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

    @pytest.mark.parametrize(
        "body",
        [
            "ask @drift",
            "ask @Drift now",
            "ask @*drift*",
            "ask @~drift~",
            "ask x@drift",
            "@drift@jetfire",
            "ask @claude-code.fix.ada",
        ],
    )
    def test_text_never_mentions_an_agent_the_body_names(self, body: str) -> None:
        text = scheduled_text(body, ["triage"], "Ada")
        plain = strip_emphasis(text)
        assert mention_regex("triage").search(plain) is not None
        for name in ("drift", "jetfire", "claude-code.fix.ada"):
            assert mention_regex(name).search(plain) is None

    def test_text_keeps_the_words_of_the_body(self) -> None:
        text = scheduled_text("email a@b.com about @drift", ["triage"], "Ada")
        assert text.replace(ZERO_WIDTH_SPACE, "") == (
            "@triage email a@b.com about @drift\n\n_Scheduled by Ada_"
        )

    def test_text_mentions_each_agent_and_names_the_author(self) -> None:
        assert scheduled_text("Standup time", ["triage", "scribe"], "Ada") == (
            "@triage @scribe Standup time\n\n_Scheduled by Ada_"
        )

    @pytest.mark.parametrize(
        "body",
        ["Standup time", "50% done @ noon", "a lone @ and @@", "trailing @"],
    )
    def test_text_with_no_mention_is_posted_as_written(self, body: str) -> None:
        assert scheduled_text(body, ["triage"], "Ada") == (
            f"@triage {body}\n\n_Scheduled by Ada_"
        )


async def _room_with_schedule(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    cron: str | None,
    due_ago: timedelta,
    body: str = "Summarise new issues",
    bystanders: tuple[str, ...] = (),
) -> tuple[Room, str, list[str]]:
    """A room with agents `triage` and `scribe` in it and a schedule for both
    that fell due `due_ago`. `bystanders` are agents in the room that the
    schedule does not address."""
    async with session_factory() as session:
        author = await add_user(session, "Ada")
        room = await add_room(session, "standup", owner_id=author.id)
        agents = [
            await add_agent(session, name, owner=author)
            for name in ("triage", "scribe")
        ]
        for agent in agents:
            await put_in_room(session, room, agent)
        for name in bystanders:
            await put_in_room(
                session, room, await add_agent(session, name, owner=author)
            )
        due = datetime.now(UTC) - due_ago
        schedule = await STORE.create(
            session,
            room_id=room.id,
            author_id=author.id,
            author_agent_id=None,
            body=body,
            run_at=None if cron else due,
            cron=cron,
            timezone="UTC",
            next_run_at=due,
            agent_ids=[a.id for a in agents],
        )
        await session.commit()
        return room, schedule.id, [a.id for a in agents]


async def _room_with_many_due(
    session_factory: async_sessionmaker[AsyncSession],
    count: int,
    *,
    author_name: str = "Ada",
    agent_name: str = "triage",
) -> list[str]:
    """A room with one agent and `count` one-offs for it, all due, each with
    its own text so a post can be told apart."""
    async with session_factory() as session:
        author = await add_user(session, author_name)
        room = await add_room(session, f"busy-{agent_name}", owner_id=author.id)
        agent = await add_agent(session, agent_name, owner=author)
        await put_in_room(session, room, agent)
        due = datetime.now(UTC) - timedelta(seconds=30)
        ids = []
        for n in range(count):
            schedule = await STORE.create(
                session,
                room_id=room.id,
                author_id=author.id,
                author_agent_id=None,
                body=f"Run {n}",
                run_at=due,
                cron=None,
                timezone="UTC",
                next_run_at=due,
                agent_ids=[agent.id],
            )
            ids.append(schedule.id)
        await session.commit()
        return ids


class _AdminThatCannotNotify(FakeAdmin):
    """Posts messages, but every notice fails."""

    async def send_admin(self, room_id: str, body: str, **_: Any) -> None:
        raise RuntimeError("notice channel is down")


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

    async def test_a_body_that_names_another_agent_does_not_address_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The router reads every mention in a post, so an `@name` left in the
        # text would wake an agent the schedule does not name.
        await _room_with_schedule(
            session_factory,
            cron=None,
            due_ago=timedelta(seconds=30),
            body="Ask @intruder, @*intruder* and @INTRUDER about it",
            bystanders=("intruder",),
        )
        admin = FakeAdmin()
        scheduler = make_scheduler(session_factory, admin)

        assert await scheduler.fire_due(TENANT_ZERO_ID) == 1

        [post] = admin.posted
        plain = strip_emphasis(post["body"])
        assert mention_regex("intruder").search(plain) is None
        for name in ("triage", "scribe"):
            assert mention_regex(name).search(plain) is not None

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

    async def test_processes_sweeping_at_once_post_each_run_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Several pods share one database (#1307): each claims with SKIP
        # LOCKED and moves the run on before it posts, so none is posted twice.
        ids = await _room_with_many_due(session_factory, 6)
        admins = [FakeAdmin() for _ in range(3)]
        schedulers = [make_scheduler(session_factory, a) for a in admins]

        claimed = await asyncio.gather(
            *(s.fire_due(TENANT_ZERO_ID) for s in schedulers)
        )

        assert sum(claimed) == len(ids)
        bodies = [p["body"] for a in admins for p in a.posted]
        assert len(bodies) == len(ids)
        assert len(set(bodies)) == len(ids)
        assert await asyncio.gather(
            *(s.fire_due(TENANT_ZERO_ID) for s in schedulers)
        ) == [0, 0, 0]
        for schedule_id in ids:
            row = await reload_schedule(session_factory, schedule_id)
            assert row.next_run_at is None and row.last_run_at is not None

    async def test_a_paused_or_not_yet_due_schedule_does_not_fire(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, paused_id, _ = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(minutes=5)
        )
        async with session_factory() as session:
            await session.execute(
                update(RoomSchedule)
                .where(RoomSchedule.id == paused_id)
                .values(paused=True)
            )
            grace = await add_user(session, "Grace")
            room = await add_room(session, "later", owner_id=grace.id)
            agent = await add_agent(session, "scout", owner=grace)
            await put_in_room(session, room, agent)
            await STORE.create(
                session,
                room_id=room.id,
                author_id=grace.id,
                author_agent_id=None,
                body="Not yet",
                run_at=None,
                cron="0 * * * *",
                timezone="UTC",
                next_run_at=datetime.now(UTC) + timedelta(hours=1),
                agent_ids=[agent.id],
            )
            await session.commit()
        admin = FakeAdmin()

        assert (
            await make_scheduler(session_factory, admin).fire_due(TENANT_ZERO_ID) == 0
        )
        assert admin.posted == [] and admin.notices == []
        assert (await reload_schedule(session_factory, paused_id)).last_run_at is None

    async def test_a_one_off_whose_post_fails_is_not_posted_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The run is moved on and committed before the post, so a post that
        # fails is recorded, never repeated: at most once, not at least once.
        _, schedule_id, _ = await _room_with_schedule(
            session_factory, cron=None, due_ago=timedelta(seconds=5)
        )
        failing = make_scheduler(session_factory, FakeAdmin(fail=True))

        assert await failing.fire_due(TENANT_ZERO_ID) == 1
        assert await failing.fire_due(TENANT_ZERO_ID) == 0

        row = await reload_schedule(session_factory, schedule_id)
        assert row.next_run_at is None
        assert row.last_error == "Switch could not post the message."

    async def test_a_schedule_that_cannot_run_does_not_hold_up_the_others(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, broken_id, _ = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(hours=2)
        )
        async with session_factory() as session:
            await session.execute(
                update(RoomSchedule)
                .where(RoomSchedule.id == broken_id)
                .values(timezone="Gone/Away")
            )
            await session.commit()
        [healthy_id] = await _room_with_many_due(
            session_factory, 1, author_name="Grace", agent_name="scout"
        )
        admin = FakeAdmin()

        assert (
            await make_scheduler(session_factory, admin).fire_due(TENANT_ZERO_ID) == 2
        )

        [post] = admin.posted
        assert "Run 0" in post["body"]
        assert (await reload_schedule(session_factory, broken_id)).paused is True
        assert (await reload_schedule(session_factory, healthy_id)).next_run_at is None

    async def test_a_notice_that_cannot_be_posted_does_not_stop_the_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, schedule_id, (triage_id, scribe_id) = await _room_with_schedule(
            session_factory, cron="0 * * * *", due_ago=timedelta(seconds=5)
        )
        async with session_factory() as session:
            await session.execute(
                delete(room_agents).where(room_agents.c.agent_id == scribe_id)
            )
            await session.commit()
        admin = _AdminThatCannotNotify()

        assert (
            await make_scheduler(session_factory, admin).fire_due(TENANT_ZERO_ID) == 1
        )

        [post] = admin.posted
        assert post["body"].startswith("@triage Summarise")
        async with session_factory() as session:
            assert await STORE.agent_ids(session, [schedule_id]) == {
                schedule_id: [triage_id]
            }
