"""Room schedules: when each run falls, and how it is posted when it does."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import OnBehalfOf
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    Room,
    RoomSchedule,
    User,
)
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_schedules import (
    RoomScheduler,
    ScheduleError,
    first_run,
    next_cron_run,
    scheduled_text,
)

LONDON = "Europe/London"


def _utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


# ── When a run falls ─────────────────────────────────────────────────────────


def test_a_weekday_rule_skips_the_weekend_in_its_own_timezone() -> None:
    # Friday 27 March 2026, 10:00 in London (still GMT).
    after = _utc(2026, 3, 27, 10, 0)
    assert next_cron_run("0 9 * * 1-5", LONDON, after) == _utc(2026, 3, 30, 8, 0)


def test_a_time_the_clocks_skip_runs_once_they_have_gone_forward() -> None:
    # 01:30 does not exist in London on 29 March 2026.
    after = _utc(2026, 3, 28, 12, 0)
    assert next_cron_run("30 1 * * *", LONDON, after) == _utc(2026, 3, 29, 1, 0)


def test_a_time_the_clocks_repeat_runs_once() -> None:
    # 01:30 happens twice in London on 25 October 2026.
    first = next_cron_run("30 1 * * *", LONDON, _utc(2026, 10, 24, 12, 0))
    after_it = next_cron_run("30 1 * * *", LONDON, first)
    assert first == _utc(2026, 10, 25, 0, 30)
    assert after_it == _utc(2026, 10, 26, 1, 30)


@pytest.mark.parametrize(
    ("timing", "said"),
    [
        (
            {"cron": "0 9 * * *", "run_at": None, "timezone": "Mars/Olympus"},
            "Unknown timezone",
        ),
        ({"cron": "not a rule", "run_at": None, "timezone": LONDON}, "not a cron rule"),
        ({"cron": None, "run_at": None, "timezone": LONDON}, "either a cron rule"),
        (
            {
                "cron": "0 9 * * *",
                "run_at": _utc(2026, 12, 1, 9, 0),
                "timezone": LONDON,
            },
            "either a cron rule",
        ),
        (
            {"cron": None, "run_at": datetime(2026, 12, 1, 9, 0), "timezone": LONDON},
            "timezone offset",
        ),
        (
            {"cron": None, "run_at": _utc(2026, 1, 1, 9, 0), "timezone": LONDON},
            "in the future",
        ),
    ],
)
def test_a_timing_switch_cannot_keep_is_refused_in_words_its_author_can_fix(
    timing: dict[str, Any], said: str
) -> None:
    with pytest.raises(ScheduleError, match=said):
        first_run(**timing, now=_utc(2026, 11, 4, 9, 0))


def test_a_one_off_first_runs_at_its_own_moment() -> None:
    at = datetime.fromisoformat("2026-12-01T09:00:00+01:00")
    assert first_run(
        cron=None, run_at=at, timezone=LONDON, now=_utc(2026, 11, 4, 9, 0)
    ) == (_utc(2026, 12, 1, 8, 0))


def test_a_run_on_time_is_just_its_text_addressed() -> None:
    schedule = RoomSchedule(text="Summarise new issues.", timezone=LONDON)
    due = _utc(2026, 11, 4, 9, 0)
    assert (
        scheduled_text(schedule, ["triage"], due_at=due, now=due + timedelta(seconds=9))
        == "@triage Summarise new issues."
    )


def test_a_late_run_says_when_it_was_for() -> None:
    schedule = RoomSchedule(text="Summarise new issues.", timezone=LONDON)
    due = _utc(2026, 11, 4, 9, 0)
    text = scheduled_text(
        schedule, ["triage", "repro"], due_at=due, now=due + timedelta(hours=3)
    )
    assert text.startswith("@triage @repro Summarise new issues.")
    assert "Scheduled for 2026-11-04 09:00 Europe/London; sent late" in text


# ── Posting a run ────────────────────────────────────────────────────────────


class _Admin(SystemActor):
    """The platform's poster, recording what it was asked to send."""

    def __init__(self) -> None:
        self.posts: list[tuple[str, str, OnBehalfOf | None]] = []
        self.notices: list[tuple[str, str]] = []

    async def send_platform_message(  # type: ignore[override]
        self,
        room_id: str,
        body: str,
        *,
        on_behalf_of: OnBehalfOf | None = None,
        **_: Any,
    ) -> str:
        self.posts.append((room_id, body, on_behalf_of))
        return f"$posted-{len(self.posts)}"

    async def send_notice(self, room_id: str, body: str) -> None:
        self.notices.append((room_id, body))


class _Lifecycle:
    def __init__(self, admin: _Admin | None) -> None:
        self._admin = admin

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        if client_type == "admin" and tenant_id == TENANT_ZERO_ID and self._admin:
            return [self._admin]
        return []


def _scheduler(
    session_factory: async_sessionmaker[AsyncSession], admin: _Admin | None
) -> RoomScheduler:
    return RoomScheduler(session_factory, _Lifecycle(admin))  # type: ignore[arg-type]


async def _agent_in(session: AsyncSession, room: Room, name: str) -> Agent:
    slug = uuid.uuid4().hex[:8]
    owner = User(name=slug, email=f"{slug}@test", role="user", password_hash="x")
    session.add(owner)
    await session.flush()
    api_key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{slug}",
        encrypted_key="enc",
        label=slug,
        type="agent",
    )
    client = Client(transport_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
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
    await RoomStore().add_agents(session, room.id, [agent.id])
    return agent


async def _schedule(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    agents: tuple[str, ...] = ("triage",),
    in_room: tuple[str, ...] = ("triage",),
    cron: str | None = "0 9 * * *",
    due_at: datetime,
    author_owns_room: bool = True,
    setter: str | None = None,
) -> tuple[str, str, str]:
    """A room holding `in_room`, and a schedule in it for `agents`, set by
    the room's owner unless `author_owns_room` is false.

    The room's transport id, the schedule's id and its author's id."""
    async with session_factory() as session:
        author = User(name="Priya", email="priya@test", role="user", password_hash="x")
        session.add(author)
        await session.flush()
        room = Room(
            transport_room_id="!standup:test",
            name="standup",
            description="",
            owner_id=author.id if author_owns_room else None,
        )
        session.add(room)
        await session.flush()
        ids = {name: (await _agent_in(session, room, name)).id for name in in_room}
        if setter is not None and setter not in ids:
            # An agent that set it up and has since left: it is in another room.
            elsewhere = Room(
                transport_room_id="!elsewhere:test", name="elsewhere", description=""
            )
            session.add(elsewhere)
            await session.flush()
            ids[setter] = (await _agent_in(session, elsewhere, setter)).id
        schedule = await RoomScheduleStore().create(
            session,
            RoomSchedule(
                room_id=room.id,
                author_id=author.id,
                author_agent_id=ids[setter] if setter is not None else None,
                agent_ids=[ids.get(name, f"gone-{name}") for name in agents],
                text="Summarise the new issues.",
                cron=cron,
                run_at=None if cron else due_at,
                timezone=LONDON,
                paused=False,
                next_run_at=due_at,
            ),
        )
        await session.commit()
        return room.transport_room_id, schedule.id, author.id


async def _stored(
    session_factory: async_sessionmaker[AsyncSession], schedule_id: str
) -> RoomSchedule:
    async with session_factory() as session:
        schedule = await RoomScheduleStore().get(session, schedule_id)
    assert schedule is not None
    return schedule


async def test_a_due_run_is_posted_to_its_agents_on_behalf_of_its_author(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 4, 9, 0)
    room, schedule_id, author = await _schedule(session_factory, due_at=due)
    admin = _Admin()

    await _scheduler(session_factory, admin).fire_due(due + timedelta(seconds=5))

    assert admin.posts == [
        (room, "@triage Summarise the new issues.", OnBehalfOf(author, "Priya"))
    ]
    stored = await _stored(session_factory, schedule_id)
    assert stored.next_run_at == _utc(2026, 11, 5, 9, 0)
    assert stored.last_run_at == due + timedelta(seconds=5)


async def test_two_processes_firing_at_once_post_a_run_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 4, 9, 0)
    await _schedule(session_factory, due_at=due)
    first, second = _Admin(), _Admin()

    await asyncio.gather(
        _scheduler(session_factory, first).fire_due(due),
        _scheduler(session_factory, second).fire_due(due),
    )

    assert len(first.posts) + len(second.posts) == 1


async def test_a_one_off_is_posted_once_and_not_again(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 4, 9, 0)
    _, schedule_id, _ = await _schedule(session_factory, cron=None, due_at=due)
    admin = _Admin()
    scheduler = _scheduler(session_factory, admin)

    await scheduler.fire_due(due)
    await scheduler.fire_due(due + timedelta(days=1))

    assert len(admin.posts) == 1
    assert (await _stored(session_factory, schedule_id)).next_run_at is None


async def test_a_run_missed_while_switch_was_down_is_sent_once_late(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 2, 9, 0)
    back = _utc(2026, 11, 4, 14, 0)
    _, schedule_id, _ = await _schedule(session_factory, due_at=due)
    admin = _Admin()

    await _scheduler(session_factory, admin).fire_due(back)

    [(_, body, _)] = admin.posts
    assert "Scheduled for 2026-11-02 09:00 Europe/London; sent late" in body
    assert (await _stored(session_factory, schedule_id)).next_run_at == _utc(
        2026, 11, 5, 9, 0
    )


async def test_an_agent_that_left_the_room_is_no_longer_addressed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 4, 9, 0)
    await _schedule(
        session_factory, agents=("triage", "repro"), in_room=("triage",), due_at=due
    )
    admin = _Admin()

    await _scheduler(session_factory, admin).fire_due(due)

    [(_, body, _)] = admin.posts
    assert body == "@triage Summarise the new issues."


async def test_a_schedule_with_none_of_its_agents_left_is_paused_and_the_room_told(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 4, 9, 0)
    room, schedule_id, _ = await _schedule(
        session_factory, agents=("repro",), in_room=("triage",), due_at=due
    )
    admin = _Admin()

    await _scheduler(session_factory, admin).fire_due(due)

    assert admin.posts == []
    [(told, notice)] = admin.notices
    assert told == room and "Paused a schedule" in notice
    assert (await _stored(session_factory, schedule_id)).paused is True


async def test_a_schedule_whose_author_lost_the_room_is_paused_and_the_room_told(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 4, 9, 0)
    room, schedule_id, _ = await _schedule(
        session_factory, due_at=due, author_owns_room=False
    )
    admin = _Admin()

    await _scheduler(session_factory, admin).fire_due(due)

    assert admin.posts == []
    [(told, notice)] = admin.notices
    assert told == room and "Priya, who it speaks for, may no longer manage" in notice
    assert (await _stored(session_factory, schedule_id)).paused is True


async def test_a_schedule_an_agent_set_up_is_posted_as_that_agent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 4, 9, 0)
    room, _, author = await _schedule(
        session_factory, in_room=("triage", "minder"), setter="minder", due_at=due
    )
    admin = _Admin()

    await _scheduler(session_factory, admin).fire_due(due)

    [(posted_in, body, speaker)] = admin.posts
    assert (posted_in, body) == (room, "@triage Summarise the new issues.")
    assert speaker is not None
    assert (speaker.user_id, speaker.name) == (author, "minder")
    assert speaker.agent_id is not None


async def test_a_schedule_whose_agent_left_the_room_is_paused_and_the_room_told(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 4, 9, 0)
    room, schedule_id, _ = await _schedule(session_factory, setter="minder", due_at=due)
    admin = _Admin()

    await _scheduler(session_factory, admin).fire_due(due)

    assert admin.posts == []
    [(told, notice)] = admin.notices
    assert told == room and "the agent that set it up is no longer" in notice
    assert (await _stored(session_factory, schedule_id)).paused is True


async def test_a_process_that_cannot_post_leaves_the_run_for_one_that_can(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    due = _utc(2026, 11, 4, 9, 0)
    _, schedule_id, _ = await _schedule(session_factory, due_at=due)

    await _scheduler(session_factory, None).fire_due(due)

    assert (await _stored(session_factory, schedule_id)).next_run_at == due


async def test_the_loop_reads_the_time_off_the_database_every_pod_shares(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        before = (await session.execute(select(func.now()))).scalar_one()

    read = await _scheduler(session_factory, _Admin())._database_now()

    assert read.tzinfo is not None
    assert read >= before
