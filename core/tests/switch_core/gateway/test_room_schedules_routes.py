from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Room, RoomSchedule, User
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.rooms import (
    create_room_schedule,
    delete_room_schedule,
    get_room_schedule,
    list_room_schedules,
    pause_room_schedule,
    resume_room_schedule,
    update_room_schedule,
)
from switch_core.gateway.schemas import (
    RoomScheduleCreateRequest,
    RoomScheduleUpdateRequest,
)


@pytest.fixture
def schedule_store():
    return RoomScheduleStore()


@pytest.fixture
def room_store():
    return RoomStore()


@pytest.mark.asyncio
async def test_schedule_crud_route_lifecycle():
    session = AsyncMock(spec=AsyncSession)
    room_store = AsyncMock(spec=RoomStore)
    schedule_store = AsyncMock(spec=RoomScheduleStore)

    owner = User(id="user-owner", name="Alice", email="alice@example.com")
    intruder = User(id="user-intruder", name="Eve", email="eve@example.com")

    room = Room(
        id="room-1",
        tenant_id="tenant-1",
        name="Engineering",
        owner_id="user-owner",
        read_visibility="public",
        write_visibility="public",
        transport_room_id="!eng:matrix.org",
    )
    room_store.get.return_value = room
    room_store.get_agent_ids.return_value = ["agent-triage", "agent-ci"]

    # 1. Non-owner trying to create schedule -> 403 Forbidden
    create_req = RoomScheduleCreateRequest(
        name="Daily Standup",
        message="Standup time!",
        target_agent_ids=["agent-triage"],
        schedule_type="recurring",
        cron_expression="0 9 * * *",
        timezone="UTC",
    )
    with pytest.raises(HTTPException) as exc_info:
        await create_room_schedule(
            room_id="room-1",
            req=create_req,
            session=session,
            room_store=room_store,
            schedule_store=schedule_store,
            user=intruder,
            is_admin=False,
        )
    assert exc_info.value.status_code == 403

    # 2. Owner creating schedule with agent not in room -> 400 Bad Request
    bad_agent_req = RoomScheduleCreateRequest(
        name="Invalid Agent Schedule",
        message="Hello",
        target_agent_ids=["agent-not-in-room"],
        schedule_type="recurring",
        cron_expression="0 9 * * *",
        timezone="UTC",
    )
    with pytest.raises(HTTPException) as exc_info:
        await create_room_schedule(
            room_id="room-1",
            req=bad_agent_req,
            session=session,
            room_store=room_store,
            schedule_store=schedule_store,
            user=owner,
            is_admin=False,
        )
    assert exc_info.value.status_code == 400
    assert "not present in room" in exc_info.value.detail

    # 3. Owner creating valid recurring schedule -> Success
    created_sched = RoomSchedule(
        id="sched-101",
        tenant_id="tenant-1",
        room_id="room-1",
        created_by_user_id="user-owner",
        name="Daily Standup",
        message="Standup time!",
        target_agent_ids=["agent-triage"],
        schedule_type="recurring",
        cron_expression="0 9 * * *",
        timezone="UTC",
        next_run_at=datetime(2026, 11, 4, 9, 0, tzinfo=UTC),
        status="active",
        missed_run_policy="run_once",
        created_at=datetime(2026, 11, 1, 0, 0, tzinfo=UTC),
        updated_at=datetime(2026, 11, 1, 0, 0, tzinfo=UTC),
    )
    schedule_store.create.return_value = created_sched

    res = await create_room_schedule(
        room_id="room-1",
        req=create_req,
        session=session,
        room_store=room_store,
        schedule_store=schedule_store,
        user=owner,
        is_admin=False,
    )
    assert res.id == "sched-101"
    assert res.name == "Daily Standup"
    assert res.status == "active"
    schedule_store.create.assert_awaited_once()

    # 4. List schedules -> Success
    schedule_store.list_for_room.return_value = [created_sched]
    listed = await list_room_schedules(
        room_id="room-1",
        session=session,
        room_store=room_store,
        schedule_store=schedule_store,
        user=intruder,  # anyone can list schedules if room is readable
        is_admin=False,
    )
    assert len(listed) == 1
    assert listed[0].id == "sched-101"

    # 5. Get schedule -> Success
    schedule_store.get.return_value = created_sched
    single = await get_room_schedule(
        room_id="room-1",
        schedule_id="sched-101",
        session=session,
        room_store=room_store,
        schedule_store=schedule_store,
        user=intruder,
        is_admin=False,
    )
    assert single.id == "sched-101"

    # 6. Pause schedule -> Owner succeeds
    paused_sched = RoomSchedule(
        id="sched-101",
        tenant_id="tenant-1",
        room_id="room-1",
        created_by_user_id="user-owner",
        name="Daily Standup",
        message="Standup time!",
        target_agent_ids=["agent-triage"],
        schedule_type="recurring",
        cron_expression="0 9 * * *",
        timezone="UTC",
        next_run_at=datetime(2026, 11, 4, 9, 0, tzinfo=UTC),
        status="paused",
        missed_run_policy="run_once",
        created_at=datetime(2026, 11, 1, 0, 0, tzinfo=UTC),
        updated_at=datetime(2026, 11, 1, 0, 0, tzinfo=UTC),
    )
    schedule_store.set_status.return_value = paused_sched
    paused_res = await pause_room_schedule(
        room_id="room-1",
        schedule_id="sched-101",
        session=session,
        room_store=room_store,
        schedule_store=schedule_store,
        user=owner,
        is_admin=False,
    )
    assert paused_res.status == "paused"

    # 7. Resume schedule -> Owner succeeds
    active_sched = RoomSchedule(
        id="sched-101",
        tenant_id="tenant-1",
        room_id="room-1",
        created_by_user_id="user-owner",
        name="Daily Standup",
        message="Standup time!",
        target_agent_ids=["agent-triage"],
        schedule_type="recurring",
        cron_expression="0 9 * * *",
        timezone="UTC",
        next_run_at=datetime(2026, 11, 4, 9, 0, tzinfo=UTC),
        status="active",
        missed_run_policy="run_once",
        created_at=datetime(2026, 11, 1, 0, 0, tzinfo=UTC),
        updated_at=datetime(2026, 11, 1, 0, 0, tzinfo=UTC),
    )
    schedule_store.set_status.return_value = active_sched
    active_res = await resume_room_schedule(
        room_id="room-1",
        schedule_id="sched-101",
        session=session,
        room_store=room_store,
        schedule_store=schedule_store,
        user=owner,
        is_admin=False,
    )
    assert active_res.status == "active"

    # 8. Update schedule -> Owner succeeds
    update_req = RoomScheduleUpdateRequest(name="Renamed Standup")
    schedule_store.update.return_value = active_sched
    await update_room_schedule(
        room_id="room-1",
        schedule_id="sched-101",
        req=update_req,
        session=session,
        room_store=room_store,
        schedule_store=schedule_store,
        user=owner,
        is_admin=False,
    )
    schedule_store.update.assert_awaited_once()

    # 9. Delete schedule -> Owner succeeds
    del_res = await delete_room_schedule(
        room_id="room-1",
        schedule_id="sched-101",
        session=session,
        room_store=room_store,
        schedule_store=schedule_store,
        user=owner,
        is_admin=False,
    )
    assert del_res.status_code == 204
    schedule_store.delete.assert_awaited_once_with(session, "sched-101")


@pytest.mark.asyncio
async def test_schedule_validation_errors():
    session = AsyncMock(spec=AsyncSession)
    room_store = AsyncMock(spec=RoomStore)
    schedule_store = AsyncMock(spec=RoomScheduleStore)

    owner = User(id="user-owner", name="Alice", email="alice@example.com")
    room = Room(
        id="room-1",
        tenant_id="tenant-1",
        name="Engineering",
        owner_id="user-owner",
        read_visibility="public",
        write_visibility="public",
        transport_room_id="!eng:matrix.org",
    )
    room_store.get.return_value = room
    room_store.get_agent_ids.return_value = ["agent-1"]

    # Invalid cron
    bad_cron_req = RoomScheduleCreateRequest(
        name="Bad Cron",
        message="Hello",
        target_agent_ids=["agent-1"],
        schedule_type="recurring",
        cron_expression="not-a-cron",
        timezone="UTC",
    )
    with pytest.raises(HTTPException) as exc:
        await create_room_schedule(
            room_id="room-1",
            req=bad_cron_req,
            session=session,
            room_store=room_store,
            schedule_store=schedule_store,
            user=owner,
            is_admin=False,
        )
    assert exc.value.status_code == 400
    assert "Invalid cron expression" in exc.value.detail

    # Invalid timezone
    bad_tz_req = RoomScheduleCreateRequest(
        name="Bad TZ",
        message="Hello",
        target_agent_ids=["agent-1"],
        schedule_type="recurring",
        cron_expression="0 9 * * *",
        timezone="Moon/Base_Alpha",
    )
    with pytest.raises(HTTPException) as exc:
        await create_room_schedule(
            room_id="room-1",
            req=bad_tz_req,
            session=session,
            room_store=room_store,
            schedule_store=schedule_store,
            user=owner,
            is_admin=False,
        )
    assert exc.value.status_code == 400
    assert "Invalid timezone" in exc.value.detail

    # One-off missing one_off_datetime
    bad_oneoff_req = RoomScheduleCreateRequest(
        name="Bad Oneoff",
        message="Hello",
        target_agent_ids=["agent-1"],
        schedule_type="one_off",
        one_off_datetime=None,
    )
    with pytest.raises(HTTPException) as exc:
        await create_room_schedule(
            room_id="room-1",
            req=bad_oneoff_req,
            session=session,
            room_store=room_store,
            schedule_store=schedule_store,
            user=owner,
            is_admin=False,
        )
    assert exc.value.status_code == 400
    assert "one_off_datetime is required" in exc.value.detail


@pytest.mark.asyncio
async def test_admin_can_manage_any_room_schedules():
    session = AsyncMock(spec=AsyncSession)
    room_store = AsyncMock(spec=RoomStore)
    schedule_store = AsyncMock(spec=RoomScheduleStore)

    admin_user = User(id="user-admin", name="Admin", email="admin@example.com")
    room = Room(
        id="room-1",
        tenant_id="tenant-1",
        name="Engineering",
        owner_id="user-other-person",
        read_visibility="private",
        write_visibility="private",
        transport_room_id="!eng:matrix.org",
    )
    room_store.get.return_value = room
    room_store.get_agent_ids.return_value = ["agent-1"]

    create_req = RoomScheduleCreateRequest(
        name="Admin Mandate",
        message="Notice from admin",
        target_agent_ids=["agent-1"],
        schedule_type="recurring",
        cron_expression="0 12 * * *",
        timezone="UTC",
    )
    created_sched = RoomSchedule(
        id="sched-admin-1",
        tenant_id="tenant-1",
        room_id="room-1",
        created_by_user_id="user-admin",
        name="Admin Mandate",
        message="Notice from admin",
        target_agent_ids=["agent-1"],
        schedule_type="recurring",
        cron_expression="0 12 * * *",
        timezone="UTC",
        next_run_at=datetime(2026, 11, 4, 12, 0, tzinfo=UTC),
        status="active",
        missed_run_policy="run_once",
        created_at=datetime(2026, 11, 1, 0, 0, tzinfo=UTC),
        updated_at=datetime(2026, 11, 1, 0, 0, tzinfo=UTC),
    )
    schedule_store.create.return_value = created_sched

    # Admin succeeds even though owner_id is user-other-person
    res = await create_room_schedule(
        room_id="room-1",
        req=create_req,
        session=session,
        room_store=room_store,
        schedule_store=schedule_store,
        user=admin_user,
        is_admin=True,
    )
    assert res.id == "sched-admin-1"
    assert res.name == "Admin Mandate"


@pytest.mark.asyncio
async def test_schedule_not_found_handling():
    session = AsyncMock(spec=AsyncSession)
    room_store = AsyncMock(spec=RoomStore)
    schedule_store = AsyncMock(spec=RoomScheduleStore)

    owner = User(id="user-owner", name="Alice", email="alice@example.com")
    room = Room(
        id="room-1",
        tenant_id="tenant-1",
        name="Engineering",
        owner_id="user-owner",
        read_visibility="public",
        write_visibility="public",
        transport_room_id="!eng:matrix.org",
    )
    room_store.get.return_value = room
    schedule_store.get.return_value = None

    with pytest.raises(HTTPException) as exc:
        await get_room_schedule(
            room_id="room-1",
            schedule_id="unknown-sched",
            session=session,
            room_store=room_store,
            schedule_store=schedule_store,
            user=owner,
            is_admin=False,
        )
    assert exc.value.status_code == 404
