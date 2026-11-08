from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, select

from switch_core.bridges.agent.operations import room_schedules as tools
from switch_core.bridges.agent.operations.callctx import CallContext, call_context
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    Room,
    RoomSchedule,
    RoomScheduleTarget,
    TenantMember,
    User,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.room_schedules import edit_schedule
from switch_core.scheduling.service import ScheduleInput
from tests.routing import add_member, make_agent, make_room, process_on
from tests.switch_core.test_room_scheduler_atomic import (
    SessionFactory,
    scheduler,
    setup_schedule,
)


async def caller(factory, monkeypatch):
    base_id = await setup_schedule(factory)
    async with tenant_session(factory, TENANT_ZERO_ID) as session:
        base = await session.get(RoomSchedule, base_id)
        agent_id = await session.scalar(
            select(RoomScheduleTarget.agent_id).where(
                RoomScheduleTarget.schedule_id == base_id
            )
        )
        room_id, owner_id = base.room_id, base.author_id
        base.paused = True
        await session.commit()
    protocol = SimpleNamespace(
        session_factory=factory, agent_store=AgentStore(), room_store=RoomStore()
    )
    monkeypatch.setattr(tools, "get_protocol", lambda: protocol)
    return room_id, owner_id, agent_id


async def test_agent_schedule_lifecycle_and_human_adoption(
    session_factory: SessionFactory, monkeypatch
):
    room_id, owner_id, agent_id = await caller(session_factory, monkeypatch)
    future = datetime.now(UTC) + timedelta(hours=1)
    with call_context(CallContext(agent_id, None, None)):
        created = await tools.schedule_room_message(
            room_id, "Check the queue", [agent_id], run_at=future
        )
        assert created["id"] in [
            row["id"] for row in await tools.list_room_schedules(room_id)
        ]
        assert (await tools.pause_room_schedule(room_id, created["id"], True))["paused"]
        assert not (await tools.pause_room_schedule(room_id, created["id"], False))[
            "paused"
        ]
        await tools.edit_room_schedule(
            room_id, created["id"], "Updated task", [agent_id], cron="0 9 * * 1-5"
        )
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(RoomSchedule, created["id"])
        assert row.author_agent_id == agent_id
        user = await session.get(User, owner_id)
        await edit_schedule(
            room_id,
            row.id,
            ScheduleInput(body="Human reviewed", agent_ids=[agent_id], run_at=future),
            session,
            RoomStore(),
            user,
            False,
        )
        assert row.author_agent_id is None
    with call_context(CallContext(agent_id, None, None)):
        assert (
            await tools.delete_room_schedule(room_id, created["id"])
            == "Schedule deleted."
        )


async def test_an_agent_receives_its_own_scheduled_task(
    session_factory: SessionFactory, monkeypatch
):
    room_id, _owner_id, agent_id = await caller(session_factory, monkeypatch)
    with call_context(CallContext(agent_id, None, None)):
        created = await tools.schedule_room_message(
            room_id,
            "Check my queue later",
            [agent_id],
            run_at=datetime.now(UTC) + timedelta(hours=1),
        )
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(RoomSchedule, created["id"])
        row.next_run_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    assert await scheduler(session_factory).fire_one(TENANT_ZERO_ID)
    events = await process_on(session_factory).buffer.read_from(
        TENANT_ZERO_ID, agent_id, 0
    )
    assert len([event for event in events if event.event.type == "message"]) == 1
    assert not await scheduler(session_factory).fire_one(TENANT_ZERO_ID)


@pytest.mark.parametrize(
    "change", ["not_member", "not_owner", "admin_owner", "owner_left"]
)
async def test_agents_cannot_borrow_owner_admin_reach_or_removed_access(
    session_factory: SessionFactory, monkeypatch, change
):
    room_id, owner_id, agent_id = await caller(session_factory, monkeypatch)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        if change == "not_member":
            await session.execute(
                delete(room_agents).where(
                    room_agents.c.room_id == room_id, room_agents.c.agent_id == agent_id
                )
            )
        elif change in ("not_owner", "admin_owner"):
            room = await session.get(Room, room_id)
            room.owner_id = None
            if change == "admin_owner":
                user = await session.get(User, owner_id)
                user.role = "admin"
        else:
            await session.execute(
                delete(TenantMember).where(TenantMember.user_id == owner_id)
            )
        await session.commit()
    with call_context(CallContext(agent_id, None, None)), pytest.raises(ValueError):
        await tools.schedule_room_message(
            room_id, "Task", [agent_id], run_at=datetime.now(UTC) + timedelta(hours=1)
        )


async def test_schedule_id_cannot_be_used_through_another_owned_room(
    session_factory: SessionFactory, monkeypatch
):
    room_id, owner_id, agent_id = await caller(session_factory, monkeypatch)
    other = await make_room(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        room = await session.get(Room, other.id)
        room.owner_id = owner_id
        await session.execute(
            room_agents.insert().values(
                tenant_id=TENANT_ZERO_ID, room_id=other.id, agent_id=agent_id
            )
        )
        await session.commit()
    with call_context(CallContext(agent_id, None, None)):
        row = await tools.schedule_room_message(
            room_id, "Task", [agent_id], run_at=datetime.now(UTC) + timedelta(hours=1)
        )
        with pytest.raises(ValueError, match="Schedule not found"):
            await tools.delete_room_schedule(other.id, row["id"])


@pytest.mark.parametrize("owner_only", [False, True])
async def test_agent_firing_uses_agent_addressing_identity(
    session_factory: SessionFactory, monkeypatch, owner_only
):
    room_id, owner_id, agent_id = await caller(session_factory, monkeypatch)
    target, client = await make_agent(session_factory, "recipient")
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        target_row = await session.get(Agent, target.id)
        target_row.owner_id = owner_id
        if owner_only:
            target_row.addressing_policy = {
                "rules": [{"users": [], "agents": [], "owner": True}]
            }
        room = await session.get(Room, room_id)
        await session.commit()
    await add_member(session_factory, room, client, agent=target)
    with call_context(CallContext(agent_id, None, None)):
        created = await tools.schedule_room_message(
            room_id,
            "Review this task",
            [target.id],
            run_at=datetime.now(UTC) + timedelta(hours=1),
        )
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(RoomSchedule, created["id"])
        row.next_run_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    assert await scheduler(session_factory).fire_one(TENANT_ZERO_ID)
    events = await process_on(session_factory).buffer.read_from(
        TENANT_ZERO_ID, target.id, 0
    )
    assert len([event for event in events if event.event.type == "message"]) == int(
        not owner_only
    )


@pytest.mark.parametrize(
    "change", ["creator_left", "creator_owner_changed", "room_owner_changed"]
)
async def test_agent_authority_is_rechecked_at_firing(
    session_factory: SessionFactory, monkeypatch, change
):
    room_id, owner_id, agent_id = await caller(session_factory, monkeypatch)
    with call_context(CallContext(agent_id, None, None)):
        created = await tools.schedule_room_message(
            room_id, "Task", [agent_id], run_at=datetime.now(UTC) + timedelta(hours=1)
        )
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(RoomSchedule, created["id"])
        row.next_run_at = datetime.now(UTC) - timedelta(seconds=1)
        if change == "creator_left":
            await session.execute(
                delete(room_agents).where(
                    room_agents.c.room_id == room_id, room_agents.c.agent_id == agent_id
                )
            )
        elif change == "creator_owner_changed":
            agent = await session.get(Agent, agent_id)
            agent.owner_id = None
        else:
            room = await session.get(Room, room_id)
            room.owner_id = None
        await session.commit()
    assert await scheduler(session_factory).fire_one(TENANT_ZERO_ID)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(RoomSchedule, created["id"])
        assert row.paused and row.last_error
