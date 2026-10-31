from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from switch_core.clients.actor import SystemActor
from switch_core.db.models import Agent, Room, RoomSchedule, User
from switch_core.scheduler.runner import (
    RoomScheduleRunner,
    format_scheduled_message,
)


def test_format_scheduled_message():
    # If no mentions present, prefix them
    res = format_scheduled_message("Please give a daily update", ["alice", "bob"])
    assert res == "@alice @bob Please give a daily update"

    # If one mention is already present, only add the missing one
    res2 = format_scheduled_message("Hey @alice, status check please", ["alice", "bob"])
    assert res2 == "@bob Hey @alice, status check please"

    # If all mentions are present, keep message as is
    res3 = format_scheduled_message("@alice @bob here is the standup", ["alice", "bob"])
    assert res3 == "@alice @bob here is the standup"


@pytest.mark.asyncio
async def test_runner_tick_one_off_execution():
    session_factory = MagicMock()
    session = AsyncMock()
    session_factory.return_value.__aenter__.return_value = session

    room_store = AsyncMock()
    schedule_store = AsyncMock()
    client_lifecycle = MagicMock()

    # Mock room
    test_room = Room(
        id="room-123",
        tenant_id="tenant-1",
        name="Test Room",
        transport_room_id="!t:matrix.org",
    )
    room_store.get.return_value = test_room
    room_store.get_agent_ids.return_value = ["agent-1", "agent-2"]

    # Mock admin SystemActor
    admin_actor = AsyncMock(spec=SystemActor)
    client_lifecycle.get_by_type.return_value = [admin_actor]

    # Mock agent and user in session
    async def mock_session_get(model, pk):
        if model == Agent:
            return Agent(
                id=pk, name=f"agent_{pk}", tenant_id="tenant-1", client_id="c-1"
            )
        if model == User:
            return User(id=pk, email="user@example.com")
        return None

    session.get.side_effect = mock_session_get

    now = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)
    schedule = RoomSchedule(
        id="sched-1",
        tenant_id="tenant-1",
        room_id="room-123",
        created_by_user_id="user-1",
        name="Morning Standup",
        message="Standup time!",
        target_agent_ids=["agent-1"],
        schedule_type="one_off",
        timezone="UTC",
        status="active",
        next_run_at=now,
    )
    schedule_store.fetch_due_schedules.return_value = [schedule]

    runner = RoomScheduleRunner(
        session_factory=session_factory,
        client_lifecycle=client_lifecycle,
        room_store=room_store,
        room_schedule_store=schedule_store,
    )

    executed = await runner.tick(now=now)
    assert executed == 1

    # Verify admin dispatch was called
    admin_actor.send_platform_message.assert_awaited_once()
    call_args = admin_actor.send_platform_message.call_args
    assert call_args[0][0] == "!t:matrix.org"
    assert "@agent_agent-1 Standup time!" in call_args[0][1]

    # Verify schedule marked completed
    schedule_store.record_run.assert_awaited_once_with(
        session,
        "sched-1",
        executed_at=now,
        next_run_at=None,
        mark_completed=True,
    )


@pytest.mark.asyncio
async def test_runner_tick_recurring_advances():
    session_factory = MagicMock()
    session = AsyncMock()
    session_factory.return_value.__aenter__.return_value = session

    room_store = AsyncMock()
    schedule_store = AsyncMock()
    client_lifecycle = MagicMock()

    test_room = Room(
        id="room-123",
        tenant_id="tenant-1",
        name="Test Room",
        transport_room_id="!t:matrix.org",
    )
    room_store.get.return_value = test_room
    room_store.get_agent_ids.return_value = ["agent-1"]

    admin_actor = AsyncMock(spec=SystemActor)
    client_lifecycle.get_by_type.return_value = [admin_actor]

    async def mock_session_get(model, pk):
        if model == Agent:
            return Agent(
                id=pk, name="triage_agent", tenant_id="tenant-1", client_id="c-1"
            )
        return None

    session.get.side_effect = mock_session_get

    now = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)
    schedule = RoomSchedule(
        id="sched-rec",
        tenant_id="tenant-1",
        room_id="room-123",
        created_by_user_id=None,
        name="Daily Triage",
        message="Review open issues",
        target_agent_ids=["agent-1"],
        schedule_type="recurring",
        cron_expression="0 9 * * *",
        timezone="UTC",
        status="active",
        next_run_at=now,
    )
    schedule_store.fetch_due_schedules.return_value = [schedule]

    runner = RoomScheduleRunner(
        session_factory=session_factory,
        client_lifecycle=client_lifecycle,
        room_store=room_store,
        room_schedule_store=schedule_store,
    )

    executed = await runner.tick(now=now)
    assert executed == 1

    # Verify next_run was calculated for the next day 9:00 UTC
    schedule_store.record_run.assert_awaited_once()
    call_kwargs = schedule_store.record_run.call_args[1]
    assert call_kwargs["executed_at"] == now
    assert call_kwargs["next_run_at"] == datetime(2026, 11, 5, 9, 0, tzinfo=UTC)
    assert call_kwargs["mark_completed"] is False


@pytest.mark.asyncio
async def test_runner_tick_all_agents_removed_posts_notice():
    session_factory = MagicMock()
    session = AsyncMock()
    session_factory.return_value.__aenter__.return_value = session

    room_store = AsyncMock()
    schedule_store = AsyncMock()
    client_lifecycle = MagicMock()

    test_room = Room(
        id="room-123",
        tenant_id="tenant-1",
        name="Test Room",
        transport_room_id="!t:matrix.org",
    )
    room_store.get.return_value = test_room
    # Room currently has NO agents matching target_agent_ids
    room_store.get_agent_ids.return_value = ["other-agent-9"]

    admin_actor = AsyncMock(spec=SystemActor)
    client_lifecycle.get_by_type.return_value = [admin_actor]

    now = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)
    schedule = RoomSchedule(
        id="sched-1",
        tenant_id="tenant-1",
        room_id="room-123",
        created_by_user_id="user-1",
        name="Missing Agent Routine",
        message="Hello",
        target_agent_ids=["agent-left-room"],
        schedule_type="one_off",
        timezone="UTC",
        status="active",
        next_run_at=now,
    )
    schedule_store.fetch_due_schedules.return_value = [schedule]

    runner = RoomScheduleRunner(
        session_factory=session_factory,
        client_lifecycle=client_lifecycle,
        room_store=room_store,
        room_schedule_store=schedule_store,
    )

    executed = await runner.tick(now=now)
    assert executed == 1

    # Admin should NOT post platform message, but should post notice
    admin_actor.send_platform_message.assert_not_called()
    admin_actor.send_notice.assert_awaited_once()
    assert "none are present" in admin_actor.send_notice.call_args[0][1]


@pytest.mark.asyncio
async def test_runner_tick_missed_run_policy_skip():
    session_factory = MagicMock()
    session = AsyncMock()
    session_factory.return_value.__aenter__.return_value = session

    room_store = AsyncMock()
    schedule_store = AsyncMock()
    client_lifecycle = MagicMock()

    test_room = Room(
        id="room-123",
        tenant_id="tenant-1",
        name="Test Room",
        transport_room_id="!t:matrix.org",
    )
    room_store.get.return_value = test_room
    room_store.get_agent_ids.return_value = ["agent-1"]

    admin_actor = AsyncMock(spec=SystemActor)
    client_lifecycle.get_by_type.return_value = [admin_actor]

    # Schedule was due 2 hours ago (server was down)
    scheduled_time = datetime(2026, 11, 4, 7, 0, tzinfo=UTC)
    now = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)

    schedule = RoomSchedule(
        id="sched-skip",
        tenant_id="tenant-1",
        room_id="room-123",
        created_by_user_id=None,
        name="Skipped Routine",
        message="Important announcement",
        target_agent_ids=["agent-1"],
        schedule_type="recurring",
        cron_expression="0 7 * * *",
        timezone="UTC",
        status="active",
        next_run_at=scheduled_time,
        missed_run_policy="skip",
    )
    schedule_store.fetch_due_schedules.return_value = [schedule]

    runner = RoomScheduleRunner(
        session_factory=session_factory,
        client_lifecycle=client_lifecycle,
        room_store=room_store,
        room_schedule_store=schedule_store,
        late_threshold_minutes=15,
    )

    executed = await runner.tick(now=now)
    assert executed == 1

    # Message delivery was SKIPPED because policy is 'skip'
    admin_actor.send_platform_message.assert_not_called()
    # But next_run is advanced to next occurrence (next day 7:00 UTC)
    schedule_store.record_run.assert_awaited_once_with(
        session,
        "sched-skip",
        executed_at=now,
        next_run_at=datetime(2026, 11, 5, 7, 0, tzinfo=UTC),
        mark_completed=False,
    )
