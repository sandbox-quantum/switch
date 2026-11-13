"""Turns cut off by a box that never comes back.

Timeline from the flood on 26 Oct: box A's
last pressure line at 11:43:39Z with every session busy, then the box killed
at 11:43:52Z. Here the box never returns: ten minutes on, its turns are
closed and the room is told, once, as the agent.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    AgentSessionActivityItem,
    ApiKey,
    AuditEvent,
    Room,
    SwitchCoreProcess,
    TenantMember,
    User,
)
from switch_core.session_activity.maintenance import sweep_once
from switch_core.session_activity.service import AgentSessionActivityService
from switch_core.tenant_context import tenant_scope
from tests.switch_core.hosted_machine_helpers import (
    place_managed_agent,
    seed_machine,
    workspace_on,
)

TURN_STARTED = datetime(2026, 10, 26, 11, 43, 39, tzinfo=UTC)
BOX_KILLED = datetime(2026, 10, 26, 11, 43, 52, tzinfo=UTC)
LINE = "I was restarted while working on this and lost my reply. Please send it again."


class Posts:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __call__(self, tenant_id, agent_id, room_id, body, **kwargs) -> str:
        self.calls.append(
            {
                "tenant_id": tenant_id,
                "agent_id": agent_id,
                "room_id": room_id,
                "body": body,
                **kwargs,
            }
        )
        return "$notice"


async def _box_with_a_running_turn(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    thread_id: str = "sw_ask",
    disconnected_at: datetime | None = BOX_KILLED,
    process_id: str | None = None,
    command_id: str | None = "cmd-cut-off",
    backend: str | None = "box",
) -> tuple[str, str]:
    async with session_factory() as db:
        room = Room(
            transport_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="",
        )
        db.add(room)
        await db.flush()
        owner = User(
            name="ada", email=f"ada-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
        )
        db.add(owner)
        await db.flush()
        db.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=owner.id, role="member"))
        key = ApiKey(
            type="controller",
            key_hash=f"h-{uuid.uuid4()}",
            encrypted_key="e",
            label="box",
            user_id=owner.id,
        )
        db.add(key)
        await db.flush()
        controller = AgentController(
            owner_id=owner.id,
            name="box",
            kind="ec2",
            api_key_id=key.id,
            connected_at=TURN_STARTED - timedelta(hours=1),
            disconnected_at=disconnected_at,
            disconnect_reason="heartbeat_lapsed" if disconnected_at else None,
            connection_process_id=process_id,
        )
        db.add(controller)
        await db.flush()
        if backend is not None:
            # The cloud machine the controller enrolled as (none: a person's
            # own computer).
            machine = await seed_machine(
                db,
                owner_id=owner.id,
                state="ready",
                desired_state="running",
                stop_reason=None,
                revision=1,
            )
            machine.backend = backend
            workspace = await workspace_on(db, machine.id)
            workspace.controller_id = controller.id
            await db.flush()
        definition = await place_managed_agent(
            db,
            owner_id=owner.id,
            controller_id=controller.id,
            name=f"user-a-{uuid.uuid4().hex[:4]}",
        )
        db.add(
            AgentSessionActivityItem(
                tenant_id=TENANT_ZERO_ID,
                agent_id=definition.agent_id,
                session_id="session-1",
                turn_id="cmd-cut-off",
                item_id="turn",
                kind="turn",
                revision=7,
                status="running",
                title="",
                text="",
                command_id=command_id,
                room_id=room.id,
                thread_id=thread_id,
                message_id="sw_ask",
                occurred_at=TURN_STARTED,
            )
        )
        await db.commit()
        return definition.agent_id, room.id


async def _turn(session_factory, agent_id: str) -> AgentSessionActivityItem:
    async with session_factory() as db:
        return (
            await db.execute(
                select(AgentSessionActivityItem).where(
                    AgentSessionActivityItem.agent_id == agent_id
                )
            )
        ).scalar_one()


async def test_ten_minutes_after_the_box_went_its_turn_is_closed_and_the_room_told_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    agent_id, room_id = await _box_with_a_running_turn(session_factory)
    posts = Posts()

    early = await sweep_once(
        session_factory,
        posts,
        now=BOX_KILLED + timedelta(minutes=10) - timedelta(seconds=1),
    )
    assert early == []
    assert (await _turn(session_factory, agent_id)).status == "running"

    swept = await sweep_once(
        session_factory, posts, now=BOX_KILLED + timedelta(minutes=10)
    )
    again = await sweep_once(
        session_factory, posts, now=BOX_KILLED + timedelta(minutes=11)
    )

    assert [t.turn_id for t in swept] == ["cmd-cut-off"]
    assert again == []
    turn = await _turn(session_factory, agent_id)
    assert (turn.status, turn.revision) == ("interrupted", 8)
    # The message was asked at the room's top level (its row names the message
    # itself as the thread), so the line goes there, as the box would post it.
    assert posts.calls == [
        {
            "tenant_id": TENANT_ZERO_ID,
            "agent_id": agent_id,
            "room_id": room_id,
            "body": LINE,
            "thread_root_id": None,
            "client_txn_id": "restart:cmd-cut-off",
        }
    ]


async def test_a_turn_asked_in_a_thread_is_answered_in_that_thread(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _box_with_a_running_turn(session_factory, thread_id="sw_thread_root")
    posts = Posts()
    await sweep_once(session_factory, posts, now=BOX_KILLED + timedelta(minutes=10))
    assert posts.calls[0]["thread_root_id"] == "sw_thread_root"


async def test_a_box_still_online_is_left_alone(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Connected through a Core process whose lease is held: online, however
    # long its turn has run.
    async with session_factory() as db:
        db.add(
            SwitchCoreProcess(
                id="process-live", started_at=func.now(), beat_at=func.now()
            )
        )
        await db.commit()
    agent_id, _ = await _box_with_a_running_turn(
        session_factory, disconnected_at=None, process_id="process-live"
    )
    posts = Posts()
    swept = await sweep_once(session_factory, posts, offline_after=timedelta(0))
    assert swept == []
    assert posts.calls == []
    assert (await _turn(session_factory, agent_id)).status == "running"


async def test_a_box_whose_core_process_went_without_writing_the_disconnect_is_swept(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Core restarted under it (the lease was never renewed and has since been
    # pruned): offline from at least when it connected.
    agent_id, _ = await _box_with_a_running_turn(
        session_factory, disconnected_at=None, process_id="process-gone"
    )
    swept = await sweep_once(
        session_factory, Posts(), now=BOX_KILLED + timedelta(minutes=10)
    )
    assert [t.agent_id for t in swept] == [agent_id]


async def test_two_sweepers_at_once_close_the_turn_and_post_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _box_with_a_running_turn(session_factory)
    posts = Posts()
    at = BOX_KILLED + timedelta(minutes=10)
    results = await asyncio.gather(
        sweep_once(session_factory, posts, now=at),
        sweep_once(session_factory, posts, now=at),
    )
    assert sorted(len(r) for r in results) == [0, 1]
    assert len(posts.calls) == 1


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_box_coming_back_late_cannot_reopen_the_turn(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    agent_id, _ = await _box_with_a_running_turn(session_factory)
    await sweep_once(session_factory, Posts(), now=BOX_KILLED + timedelta(minutes=10))
    service = AgentSessionActivityService(session_factory)
    with tenant_scope(TENANT_ZERO_ID):
        moved = await service.report_item(
            agent_id,
            "session-1",
            turn_id="cmd-cut-off",
            item_id="turn",
            kind="turn",
            revision=50,
            status="running",
            title="",
            text="",
            command_id="cmd-cut-off",
            room_id=None,
            thread_id=None,
            message_id=None,
            occurred_at=BOX_KILLED,
            usage=[],
        )
    assert moved is False
    assert (await _turn(session_factory, agent_id)).status == "interrupted"


async def test_a_turn_with_no_command_is_closed_but_its_room_is_not_told_here(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # The box keys its line on the command; with none, Core's line could be a
    # second one, so Core leaves the telling to the box.
    agent_id, _ = await _box_with_a_running_turn(session_factory, command_id=None)
    posts = Posts()
    swept = await sweep_once(
        session_factory, posts, now=BOX_KILLED + timedelta(minutes=10)
    )
    assert [t.turn_id for t in swept] == ["cmd-cut-off"]
    assert (await _turn(session_factory, agent_id)).status == "interrupted"
    assert posts.calls == []


async def test_each_line_core_posts_is_on_the_tenants_record(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    agent_id, room_id = await _box_with_a_running_turn(session_factory)
    await sweep_once(session_factory, Posts(), now=BOX_KILLED + timedelta(minutes=10))
    async with session_factory() as db:
        events = (
            (
                await db.execute(
                    select(AuditEvent).where(AuditEvent.target_id == agent_id)
                )
            )
            .scalars()
            .all()
        )
    assert [(e.action, e.actor_user_id, e.target_type) for e in events] == [
        ("agent.restart_notice_posted", None, "agent")
    ]
    assert events[0].details == {
        "by": "core_sweep",
        "room_id": room_id,
        "thread_id": None,
        "turn_id": "cmd-cut-off",
        "command_id": "cmd-cut-off",
        "event_id": "$notice",
    }


@pytest.mark.parametrize("backend", [None, "vm"])
async def test_only_a_v2_boxs_turns_are_swept(
    session_factory: async_sessionmaker[AsyncSession], backend: str | None
) -> None:
    """The v1/v2 switch (sweep row 4): a person's own computer that sleeps
    mid-turn, or a v1 machine, is never told it was restarted, as upstream."""
    agent_id, _ = await _box_with_a_running_turn(session_factory, backend=backend)
    posts = Posts()
    swept = await sweep_once(session_factory, posts, offline_after=timedelta(0))
    assert swept == []
    assert posts.calls == []
    assert (await _turn(session_factory, agent_id)).status == "running"
