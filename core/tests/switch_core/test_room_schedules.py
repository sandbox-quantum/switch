from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import delete, update
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
    room_agents,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.delivery.addressing import named_agents
from switch_core.room_schedules import (
    MAX_SCHEDULES_PER_ROOM,
    MISSED_RUN_GRACE,
    RoomScheduleService,
)

NOW = datetime(2026, 11, 6, 10, 0, tzinfo=UTC)


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class RecordingAdmin(SystemActor):
    """The admin client, minus a transport: records what it is asked to post."""

    def __init__(self) -> None:  # noqa: D107 - test double, no super().__init__
        self.sent: list[tuple[str, str, OnBehalfOf | None]] = []
        self.event_id: str | None = "$event"
        self.error: Exception | None = None

    async def send_platform_message(  # type: ignore[override]
        self,
        room_id: str,
        body: str,
        *,
        thread_root_id: str | None = None,
        on_behalf_of: OnBehalfOf | None = None,
        reply_in_channel: bool = False,
    ) -> str | None:
        if self.error is not None:
            raise self.error
        self.sent.append((room_id, body, on_behalf_of))
        return self.event_id


class FakeLifecycle:
    def __init__(self, admins: list[Any]) -> None:
        self.admins = admins

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return self.admins if client_type == "admin" else []


@dataclass
class World:
    service: RoomScheduleService
    clock: Clock
    admin: RecordingAdmin
    lifecycle: FakeLifecycle
    session_factory: async_sessionmaker[AsyncSession]
    user_id: str
    alice_id: str
    bob_id: str
    room_id: str


async def _make_agent(session: AsyncSession, name: str, owner_id: str) -> Agent:
    api_key = ApiKey(
        user_id=owner_id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(transport_user_id=f"@{name}:test", display_name=name, type="agent")
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
        owner_id=owner_id,
    )
    session.add(agent)
    await session.flush()
    return agent


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> World:
    async with session_factory() as session:
        user = User(name="Dana", email="dana@example.com", role="user")
        session.add(user)
        await session.flush()
        alice = await _make_agent(session, "alice", user.id)
        bob = await _make_agent(session, "bob", user.id)
        room = Room(
            transport_room_id="!room:test",
            name="triage",
            description="triage room",
            owner_id=user.id,
        )
        session.add(room)
        await session.flush()
        for agent in (alice, bob):
            await session.execute(
                room_agents.insert().values(room_id=room.id, agent_id=agent.id)
            )
        await session.commit()
        ids = (user.id, alice.id, bob.id, room.id)

    clock = Clock(NOW)
    admin = RecordingAdmin()
    lifecycle = FakeLifecycle([admin])
    service = RoomScheduleService(
        schedule_store=RoomScheduleStore(),
        room_store=RoomStore(),
        agent_store=AgentStore(),
        user_store=UserStore(),
        client_lifecycle=lifecycle,  # type: ignore[arg-type]
        session_factory=session_factory,
        clock=clock,
    )
    return World(service, clock, admin, lifecycle, session_factory, *ids)


async def _create(world: World, **overrides: Any) -> RoomSchedule:
    fields: dict[str, Any] = {
        "agent_ids": [world.alice_id],
        "message": "summarise new issues",
        "schedule_type": "cron",
        "cron_expression": "0 9 * * 1-5",
        "run_at": None,
        "timezone": "UTC",
        "acting_user_id": world.user_id,
    }
    fields.update(overrides)
    async with world.session_factory() as session:
        room = await RoomStore().get(session, world.room_id)
        assert room is not None
        schedule = await world.service.create(session, room, **fields)
        await session.commit()
        return schedule


async def _update(world: World, schedule_id: str, **changes: Any) -> RoomSchedule:
    fields: dict[str, Any] = {
        "agent_ids": None,
        "message": None,
        "schedule_type": None,
        "cron_expression": None,
        "run_at": None,
        "timezone": None,
        "enabled": None,
        "acting_user_id": world.user_id,
    }
    fields.update(changes)
    async with world.session_factory() as session:
        room = await RoomStore().get(session, world.room_id)
        assert room is not None
        schedule = await world.service.update(session, room, schedule_id, **fields)
        await session.commit()
        return schedule


async def _load(world: World, schedule_id: str) -> RoomSchedule:
    async with world.session_factory() as session:
        schedule = await RoomScheduleStore().get(session, world.room_id, schedule_id)
        assert schedule is not None
        return schedule


async def _make_due(world: World, schedule_id: str, ago: timedelta) -> None:
    async with world.session_factory() as session:
        await session.execute(
            update(RoomSchedule)
            .where(RoomSchedule.id == schedule_id)
            .values(next_run_at=world.clock.now - ago)
        )
        await session.commit()


async def _remove_agent(world: World, agent_id: str) -> None:
    async with world.session_factory() as session:
        await session.execute(
            delete(room_agents).where(
                room_agents.c.room_id == world.room_id,
                room_agents.c.agent_id == agent_id,
            )
        )
        await session.commit()


class TestCreate:
    async def test_cron_schedule_reads_its_expression_in_its_timezone(
        self, world: World
    ) -> None:
        schedule = await _create(world, timezone="Europe/Berlin")

        # 10:00 UTC on Friday 6 November is 11:00 in Berlin, so the next 09:00
        # Berlin weekday is Monday, 08:00 UTC.
        assert schedule.next_run_at == datetime(2026, 11, 9, 8, 0, tzinfo=UTC)
        assert schedule.enabled is True
        assert schedule.created_by_user_id == world.user_id
        assert schedule.updated_by_user_id == world.user_id

    async def test_one_off_time_without_an_offset_is_wall_clock_in_its_timezone(
        self, world: World
    ) -> None:
        schedule = await _create(
            world,
            schedule_type="once",
            cron_expression=None,
            run_at=datetime(2026, 12, 1, 9, 0),
            timezone="America/New_York",
        )

        assert schedule.run_at == datetime(2026, 12, 1, 14, 0, tzinfo=UTC)
        assert schedule.next_run_at == schedule.run_at
        assert schedule.cron_expression is None

    async def test_repeated_agents_are_addressed_once(self, world: World) -> None:
        schedule = await _create(
            world, agent_ids=[world.bob_id, world.alice_id, world.bob_id]
        )

        assert schedule.agent_ids == [world.bob_id, world.alice_id]

    @pytest.mark.parametrize(
        ("overrides", "message"),
        [
            ({"agent_ids": []}, "at least one agent"),
            ({"agent_ids": ["not-in-the-room"]}, "must be in the room"),
            ({"message": "   "}, "empty"),
            ({"message": "x" * 4001}, "over 4000"),
            ({"cron_expression": "nonsense"}, "five fields"),
            ({"cron_expression": None}, "needs a cron expression"),
            ({"cron_expression": "0 0 31 2 *"}, "never matches"),
            ({"timezone": "Mars/Olympus"}, "Unknown timezone"),
            ({"schedule_type": "weekly"}, "Unknown schedule type"),
            (
                {
                    "schedule_type": "once",
                    "cron_expression": None,
                    "run_at": datetime(2026, 11, 6, 9, 0, tzinfo=UTC),
                },
                "in the past",
            ),
            (
                {"schedule_type": "once", "cron_expression": None, "run_at": None},
                "needs a date and time",
            ),
        ],
    )
    async def test_refuses_what_could_not_fire(
        self, world: World, overrides: dict[str, Any], message: str
    ) -> None:
        with pytest.raises(ValueError, match=message):
            await _create(world, **overrides)

    async def test_a_room_holds_a_bounded_number(self, world: World) -> None:
        for _ in range(MAX_SCHEDULES_PER_ROOM):
            await _create(world)

        with pytest.raises(ValueError, match="at most"):
            await _create(world)


class TestUpdate:
    async def test_pausing_clears_the_next_run_and_resuming_works_it_out_afresh(
        self, world: World
    ) -> None:
        schedule = await _create(world)
        due = schedule.next_run_at

        paused = await _update(world, schedule.id, enabled=False)
        assert paused.enabled is False
        assert paused.next_run_at is None

        world.clock.now += timedelta(days=10)
        resumed = await _update(world, schedule.id, enabled=True)
        assert resumed.enabled is True
        assert due is not None
        assert resumed.next_run_at is not None
        assert resumed.next_run_at > world.clock.now

    async def test_changing_the_message_makes_the_editor_the_speaker(
        self, world: World
    ) -> None:
        schedule = await _create(world)
        async with world.session_factory() as session:
            other = User(name="Eli", email="eli@example.com", role="user")
            session.add(other)
            await session.commit()
            other_id = other.id

        paused = await _update(
            world, schedule.id, enabled=False, acting_user_id=other_id
        )
        assert paused.updated_by_user_id == world.user_id

        edited = await _update(
            world, schedule.id, message="new text", acting_user_id=other_id
        )
        assert edited.updated_by_user_id == other_id
        assert edited.created_by_user_id == world.user_id

    async def test_switching_to_a_one_off_drops_the_expression(
        self, world: World
    ) -> None:
        schedule = await _create(world)

        changed = await _update(
            world,
            schedule.id,
            schedule_type="once",
            run_at=datetime(2026, 12, 1, 9, 0, tzinfo=UTC),
        )

        assert changed.schedule_type == "once"
        assert changed.cron_expression is None
        assert changed.next_run_at == datetime(2026, 12, 1, 9, 0, tzinfo=UTC)

    async def test_switching_to_cron_needs_an_expression_and_drops_the_time(
        self, world: World
    ) -> None:
        schedule = await _create(
            world,
            schedule_type="once",
            cron_expression=None,
            run_at=datetime(2026, 12, 1, 9, 0, tzinfo=UTC),
        )

        with pytest.raises(ValueError, match="needs a cron expression"):
            await _update(world, schedule.id, schedule_type="cron")
        changed = await _update(
            world, schedule.id, schedule_type="cron", cron_expression="*/5 * * * *"
        )

        assert changed.run_at is None
        assert changed.next_run_at == NOW + timedelta(minutes=5)

    async def test_changing_the_timezone_moves_the_next_run(self, world: World) -> None:
        schedule = await _create(world)

        changed = await _update(world, schedule.id, timezone="Asia/Tokyo")

        # Monday 09:00 Tokyo is Sunday 00:00 UTC; the next weekday morning.
        assert changed.next_run_at == datetime(2026, 11, 9, 0, 0, tzinfo=UTC)

    async def test_agents_must_still_be_in_the_room(self, world: World) -> None:
        schedule = await _create(world)
        await _remove_agent(world, world.bob_id)

        with pytest.raises(ValueError, match="must be in the room"):
            await _update(world, schedule.id, agent_ids=[world.bob_id])

    async def test_a_finished_one_off_cannot_be_resumed_without_a_new_time(
        self, world: World
    ) -> None:
        schedule = await _create(
            world,
            schedule_type="once",
            cron_expression=None,
            run_at=NOW + timedelta(minutes=5),
        )
        world.clock.now += timedelta(minutes=6)
        await world.service.run_due(TENANT_ZERO_ID)

        with pytest.raises(ValueError, match="in the past"):
            await _update(world, schedule.id, enabled=True)
        again = await _update(
            world,
            schedule.id,
            enabled=True,
            run_at=world.clock.now + timedelta(hours=1),
        )
        assert again.next_run_at == world.clock.now + timedelta(hours=1)

    async def test_unknown_schedule(self, world: World) -> None:
        with pytest.raises(LookupError):
            await _update(world, "missing", enabled=False)

    async def test_delete(self, world: World) -> None:
        schedule = await _create(world)
        async with world.session_factory() as session:
            room = await RoomStore().get(session, world.room_id)
            assert room is not None
            await world.service.delete(session, room, schedule.id)
            await session.commit()
            with pytest.raises(LookupError):
                await world.service.delete(session, room, schedule.id)
            assert await world.service.list_for_room(session, world.room_id) == []


class TestFiring:
    async def test_nothing_is_posted_before_the_time(self, world: World) -> None:
        await _create(world)

        assert await world.service.run_due(TENANT_ZERO_ID) == 0
        assert world.admin.sent == []

    async def test_a_firing_addresses_the_agents_as_the_person_who_wrote_it(
        self, world: World
    ) -> None:
        schedule = await _create(
            world, agent_ids=[world.bob_id, world.alice_id], cron_expression="* * * * *"
        )
        world.clock.now += timedelta(minutes=1)

        assert await world.service.run_due(TENANT_ZERO_ID) == 1

        assert world.admin.sent == [
            (
                "!room:test",
                "@alice @bob summarise new issues",
                OnBehalfOf(world.user_id, "Dana"),
            )
        ]
        stored = await _load(world, schedule.id)
        assert stored.last_outcome == "posted"
        assert stored.last_error is None
        assert stored.last_run_at == world.clock.now

    async def test_the_posted_text_names_exactly_the_addressed_agents(
        self, world: World
    ) -> None:
        await _create(world, agent_ids=[world.alice_id], cron_expression="* * * * *")
        world.clock.now += timedelta(minutes=1)

        await world.service.run_due(TENANT_ZERO_ID)

        body = world.admin.sent[0][1]
        names = {world.alice_id: "alice", world.bob_id: "bob"}
        assert named_agents(names, {}, body) == [world.alice_id]

    async def test_a_recurring_schedule_moves_to_the_next_occurrence(
        self, world: World
    ) -> None:
        schedule = await _create(world, cron_expression="0 12 * * *")
        world.clock.now = datetime(2026, 11, 6, 12, 0, 5, tzinfo=UTC)

        await world.service.run_due(TENANT_ZERO_ID)
        await world.service.run_due(TENANT_ZERO_ID)

        assert len(world.admin.sent) == 1
        stored = await _load(world, schedule.id)
        assert stored.enabled is True
        assert stored.next_run_at == datetime(2026, 11, 7, 12, 0, tzinfo=UTC)

    async def test_a_one_off_fires_once_and_finishes(self, world: World) -> None:
        schedule = await _create(
            world,
            schedule_type="once",
            cron_expression=None,
            run_at=NOW + timedelta(minutes=5),
        )
        world.clock.now += timedelta(minutes=5)

        await world.service.run_due(TENANT_ZERO_ID)
        await world.service.run_due(TENANT_ZERO_ID)

        assert len(world.admin.sent) == 1
        stored = await _load(world, schedule.id)
        assert stored.enabled is False
        assert stored.next_run_at is None
        assert stored.last_outcome == "posted"

    async def test_a_paused_schedule_does_not_fire(self, world: World) -> None:
        schedule = await _create(world, cron_expression="* * * * *")
        await _update(world, schedule.id, enabled=False)
        world.clock.now += timedelta(hours=1)

        await world.service.run_due(TENANT_ZERO_ID)

        assert world.admin.sent == []

    async def test_a_downtime_of_many_ticks_posts_one_late_run(
        self, world: World
    ) -> None:
        schedule = await _create(world, cron_expression="* * * * *")
        world.clock.now += timedelta(hours=3)

        await world.service.run_due(TENANT_ZERO_ID)

        assert len(world.admin.sent) == 1
        stored = await _load(world, schedule.id)
        assert stored.next_run_at == world.clock.now + timedelta(minutes=1)
        assert stored.last_outcome == "posted"

    async def test_a_run_missed_by_more_than_the_grace_is_skipped(
        self, world: World
    ) -> None:
        schedule = await _create(world)
        await _make_due(world, schedule.id, MISSED_RUN_GRACE + timedelta(minutes=1))

        await world.service.run_due(TENANT_ZERO_ID)

        assert world.admin.sent == []
        stored = await _load(world, schedule.id)
        assert stored.last_outcome == "missed"
        assert stored.last_error is not None
        assert stored.enabled is True
        assert stored.next_run_at is not None
        assert stored.next_run_at > world.clock.now

    async def test_a_run_inside_the_grace_is_posted_late(self, world: World) -> None:
        schedule = await _create(world)
        await _make_due(world, schedule.id, MISSED_RUN_GRACE - timedelta(minutes=1))

        await world.service.run_due(TENANT_ZERO_ID)

        assert len(world.admin.sent) == 1
        assert (await _load(world, schedule.id)).last_outcome == "posted"

    async def test_a_one_off_missed_by_more_than_the_grace_is_finished_unposted(
        self, world: World
    ) -> None:
        schedule = await _create(
            world,
            schedule_type="once",
            cron_expression=None,
            run_at=NOW + timedelta(minutes=5),
        )
        world.clock.now += MISSED_RUN_GRACE + timedelta(hours=1)

        await world.service.run_due(TENANT_ZERO_ID)

        assert world.admin.sent == []
        stored = await _load(world, schedule.id)
        assert stored.last_outcome == "missed"
        assert stored.enabled is False
        assert stored.next_run_at is None

    async def test_an_agent_removed_from_the_room_is_left_out(
        self, world: World
    ) -> None:
        schedule = await _create(
            world, agent_ids=[world.alice_id, world.bob_id], cron_expression="* * * * *"
        )
        await _remove_agent(world, world.bob_id)
        world.clock.now += timedelta(minutes=1)

        await world.service.run_due(TENANT_ZERO_ID)

        assert [body for _, body, _ in world.admin.sent] == [
            "@alice summarise new issues"
        ]
        stored = await _load(world, schedule.id)
        assert stored.last_outcome == "partial"
        assert stored.last_error is not None
        assert stored.enabled is True
        assert stored.agent_ids == [world.alice_id, world.bob_id]

    async def test_with_no_addressed_agent_left_nothing_is_posted_and_it_pauses(
        self, world: World
    ) -> None:
        schedule = await _create(world, cron_expression="* * * * *")
        await _remove_agent(world, world.alice_id)
        world.clock.now += timedelta(minutes=1)

        assert await world.service.run_due(TENANT_ZERO_ID) == 0

        assert world.admin.sent == []
        stored = await _load(world, schedule.id)
        assert stored.last_outcome == "skipped"
        assert stored.enabled is False
        assert stored.next_run_at is None

    async def test_an_archived_room_is_skipped_but_the_schedule_goes_on(
        self, world: World
    ) -> None:
        schedule = await _create(world, cron_expression="* * * * *")
        async with world.session_factory() as session:
            await RoomStore().set_archived(session, world.room_id, True)
            await session.commit()
        world.clock.now += timedelta(minutes=1)

        await world.service.run_due(TENANT_ZERO_ID)

        assert world.admin.sent == []
        stored = await _load(world, schedule.id)
        assert stored.last_outcome == "skipped"
        assert stored.enabled is True
        assert stored.next_run_at == world.clock.now + timedelta(minutes=1)

    async def test_a_deleted_author_leaves_the_platforms_own_message(
        self, world: World
    ) -> None:
        await _create(world, cron_expression="* * * * *")
        async with world.session_factory() as session:
            await session.execute(update(RoomSchedule).values(updated_by_user_id=None))
            await session.commit()
        world.clock.now += timedelta(minutes=1)

        await world.service.run_due(TENANT_ZERO_ID)

        assert world.admin.sent[0][2] is None

    async def test_no_admin_client_is_recorded_as_a_failure(self, world: World) -> None:
        schedule = await _create(world, cron_expression="* * * * *")
        world.lifecycle.admins = []
        world.clock.now += timedelta(minutes=1)

        assert await world.service.run_due(TENANT_ZERO_ID) == 0

        stored = await _load(world, schedule.id)
        assert stored.last_outcome == "failed"
        assert stored.last_error is not None
        assert stored.enabled is True

    @pytest.mark.parametrize("failure", ["raises", "returns_none"])
    async def test_a_post_that_fails_is_recorded(
        self, world: World, failure: str
    ) -> None:
        schedule = await _create(world, cron_expression="* * * * *")
        if failure == "raises":
            world.admin.error = RuntimeError("transport down")
        else:
            world.admin.event_id = None
        world.clock.now += timedelta(minutes=1)

        assert await world.service.run_due(TENANT_ZERO_ID) == 0

        stored = await _load(world, schedule.id)
        assert stored.last_outcome == "failed"
        assert stored.last_error
        assert stored.next_run_at == world.clock.now + timedelta(minutes=1)

    async def test_concurrent_polls_post_a_run_once(self, world: World) -> None:
        await _create(world, cron_expression="* * * * *")
        world.clock.now += timedelta(minutes=1)

        counts = await asyncio.gather(
            *(world.service.run_due(TENANT_ZERO_ID) for _ in range(4))
        )

        assert sum(counts) == 1
        assert len(world.admin.sent) == 1

    async def test_each_due_schedule_posts_on_its_own(self, world: World) -> None:
        await _create(world, cron_expression="* * * * *", message="first")
        await _create(
            world,
            agent_ids=[world.bob_id],
            cron_expression="* * * * *",
            message="second",
        )
        world.clock.now += timedelta(minutes=1)

        assert await world.service.run_due(TENANT_ZERO_ID) == 2

        assert sorted(body for _, body, _ in world.admin.sent) == [
            "@alice first",
            "@bob second",
        ]
