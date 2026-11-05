"""A firing and its routed message survive or roll back together.

These use the real PostgreSQL fixture and router. Failure injection models an
application worker dying; it does not claim to simulate loss of database power.
"""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentEventRow,
    Client,
    Message,
    Room,
    RoomSchedule,
    RoomScheduleRun,
    RoomScheduleTarget,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.scheduling.runner import RoomScheduler
from tests.conftest import RLSHarness
from tests.routing import add_member, make_agent, make_room, process_on

SessionFactory = async_sessionmaker[AsyncSession]


async def setup_schedule(factory: SessionFactory) -> str:
    room = await make_room(factory)
    agent, client = await make_agent(factory, "triage")
    await add_member(factory, room, client, agent=agent)
    async with tenant_session(factory, TENANT_ZERO_ID) as session:
        stored_room = await session.get(Room, room.id)
        assert stored_room is not None
        stored_room.owner_id = agent.owner_id
        session.add(
            TenantMember(
                tenant_id=TENANT_ZERO_ID, user_id=agent.owner_id, role="member"
            )
        )
        session.add(
            Client(
                transport_user_id="@scheduler:test", display_name="Switch", type="admin"
            )
        )
        schedule = RoomSchedule(
            room_id=room.id,
            author_id=agent.owner_id,
            body="Summarize the queue",
            timezone="UTC",
            next_run_at=datetime.now(UTC) - timedelta(minutes=1),
        )
        session.add(schedule)
        await session.flush()
        session.add(RoomScheduleTarget(schedule_id=schedule.id, agent_id=agent.id))
        await session.commit()
        return schedule.id


def scheduler(factory: SessionFactory) -> RoomScheduler:
    def no_cron(rule: str, zone: str, now: datetime) -> datetime:
        raise AssertionError("A one-off must not evaluate cron")

    return RoomScheduler(factory, process_on(factory).router, no_cron)


async def counts(factory: SessionFactory) -> tuple[int, int, int]:
    async with tenant_session(factory, TENANT_ZERO_ID) as session:
        return tuple(
            [
                int(await session.scalar(select(func.count()).select_from(model)) or 0)
                for model in (Message, RoomScheduleRun, AgentEventRow)
            ]
        )


async def test_concurrent_workers_post_once(session_factory: SessionFactory) -> None:
    await setup_schedule(session_factory)
    workers = [scheduler(session_factory), scheduler(session_factory)]
    await asyncio.gather(*(w.fire_one(TENANT_ZERO_ID) for w in workers))
    messages, runs, events = await counts(session_factory)
    assert (messages, runs) == (1, 1)
    assert events > 0
    assert not await workers[0].fire_one(TENANT_ZERO_ID)
    assert await counts(session_factory) == (messages, runs, events)


async def test_pause_lock_excludes_a_firing(session_factory: SessionFactory) -> None:
    schedule_id = await setup_schedule(session_factory)
    worker = scheduler(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        schedule = await session.get(RoomSchedule, schedule_id, with_for_update=True)
        assert schedule is not None
        assert not await worker.fire_one(TENANT_ZERO_ID)
        schedule.paused = True
        await session.commit()
    assert not await worker.fire_one(TENANT_ZERO_ID)
    assert await counts(session_factory) == (0, 0, 0)


async def test_another_tenant_cannot_read_or_fire_a_schedule(
    rls_harness: RLSHarness,
) -> None:
    schedule_id = await setup_schedule(rls_harness.owner)
    async with rls_harness.owner() as session:
        session.add(Tenant(id="schedule-other", slug="schedule-other", name="Other"))
        await session.commit()
    async with tenant_session(rls_harness.restricted, "schedule-other") as session:
        assert await session.get(RoomSchedule, schedule_id) is None
        assert list((await session.scalars(select(RoomScheduleTarget))).all()) == []
        assert list((await session.scalars(select(RoomScheduleRun))).all()) == []
    worker = scheduler(rls_harness.restricted)
    assert not await worker.fire_one("schedule-other")
    assert await counts(rls_harness.owner) == (0, 0, 0)
    assert await worker.fire_one(TENANT_ZERO_ID)
    async with tenant_session(rls_harness.restricted, "schedule-other") as session:
        assert list((await session.scalars(select(RoomScheduleRun))).all()) == []
    assert (await counts(rls_harness.owner))[0:2] == (1, 1)


async def test_failure_before_commit_leaves_run_due(
    session_factory: SessionFactory,
) -> None:
    schedule_id = await setup_schedule(session_factory)
    worker = scheduler(session_factory)
    with pytest.raises(RuntimeError, match="worker died"):
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            schedule = await session.get(
                RoomSchedule, schedule_id, with_for_update=True
            )
            assert schedule is not None
            await worker.record_firing(session, schedule)
            raise RuntimeError("worker died")
    assert await counts(session_factory) == (0, 0, 0)
    assert await worker.fire_one(TENANT_ZERO_ID)
    messages, runs, events = await counts(session_factory)
    assert (messages, runs) == (1, 1)
    assert events > 0


async def test_commit_without_notification_does_not_repeat(
    session_factory: SessionFactory,
) -> None:
    schedule_id = await setup_schedule(session_factory)
    worker = scheduler(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        schedule = await session.get(RoomSchedule, schedule_id, with_for_update=True)
        assert schedule is not None
        await worker.record_firing(session, schedule)
        await session.commit()
        # Deliberately omit Routed.committed(): the worker died at this boundary.
    before = await counts(session_factory)
    assert before[0:2] == (1, 1)
    assert before[2] > 0
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        agent_id = await session.scalar(
            select(RoomScheduleTarget.agent_id).where(
                RoomScheduleTarget.schedule_id == schedule_id
            )
        )
        assert agent_id is not None
    # A new process has no in-memory notification from the worker that died.
    # Its reader must still recover the addressed message from PostgreSQL.
    reader = process_on(session_factory).buffer
    recovered = await reader.read_from(TENANT_ZERO_ID, agent_id, 0)
    assert len(recovered) == 1
    assert recovered[0].event.type == "message"
    assert await reader.read_from(TENANT_ZERO_ID, agent_id, recovered[0].seq) == []
    restarted = scheduler(session_factory)
    assert not await restarted.fire_one(TENANT_ZERO_ID)
    assert await counts(session_factory) == before


@pytest.mark.parametrize(
    "change", ["archive", "remove_author", "remove_targets", "pause"]
)
async def test_invalidated_schedule_does_not_post(
    session_factory: SessionFactory, change: str
) -> None:
    schedule_id = await setup_schedule(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        schedule = await session.get(RoomSchedule, schedule_id)
        assert schedule is not None
        if change == "archive":
            room = await session.get(Room, schedule.room_id)
            assert room is not None
            room.archived_at = datetime.now(UTC)
        elif change == "remove_author":
            await session.execute(
                delete(TenantMember).where(TenantMember.user_id == schedule.author_id)
            )
        elif change == "remove_targets":
            await session.execute(
                delete(RoomScheduleTarget).where(
                    RoomScheduleTarget.schedule_id == schedule.id
                )
            )
        else:
            schedule.paused = True
        await session.commit()
    worker = scheduler(session_factory)
    await worker.fire_one(TENANT_ZERO_ID)
    assert await counts(session_factory) == (0, 0, 0)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        schedule = await session.get(RoomSchedule, schedule_id)
        assert schedule is not None and schedule.paused
        if change != "pause":
            assert schedule.last_error


async def test_downtime_fires_once_then_advances_after_now(
    session_factory: SessionFactory,
) -> None:
    schedule_id = await setup_schedule(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        schedule = await session.get(RoomSchedule, schedule_id)
        assert schedule is not None
        schedule.cron = "* * * * *"
        schedule.next_run_at = datetime.now(UTC) - timedelta(days=7)
        await session.commit()
    worker = RoomScheduler(session_factory, process_on(session_factory).router)
    assert await worker.fire_one(TENANT_ZERO_ID)
    assert not await worker.fire_one(TENANT_ZERO_ID)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        schedule = await session.get(RoomSchedule, schedule_id)
        assert schedule is not None and schedule.next_run_at > datetime.now(UTC)
    messages, runs, _ = await counts(session_factory)
    assert (messages, runs) == (1, 1)


@pytest.mark.parametrize("is_owner", [True, False])
async def test_schedule_respects_target_owner_policy(
    session_factory: SessionFactory, is_owner: bool
) -> None:
    schedule_id = await setup_schedule(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        agent_id = await session.scalar(
            select(RoomScheduleTarget.agent_id).where(
                RoomScheduleTarget.schedule_id == schedule_id
            )
        )
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        agent.addressing_policy = {
            "rules": [{"users": [], "agents": [], "owner": True}]
        }
        if not is_owner:
            other = User(
                name="private-owner", email="owner@example.invalid", role="user"
            )
            session.add(other)
            await session.flush()
            agent.owner_id = other.id
        await session.commit()
    assert await scheduler(session_factory).fire_one(TENANT_ZERO_ID)
    events = await process_on(session_factory).buffer.read_from(
        TENANT_ZERO_ID, agent_id, 0
    )
    assert len([event for event in events if event.event.type == "message"]) == int(
        is_owner
    )
