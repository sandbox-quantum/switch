"""`MessageRouter.post_as_agent`: Core posting the restart line as an agent,
from any process, once per key. Two `Process`es are two
switch-core processes on one database (tests/routing.py)."""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.admin_messages import AUTO_REPLY_FLAG
from switch_core.db.models import TENANT_ZERO_ID
from tests.routing import add_member, make_agent, make_room, process_on, said_by

LINE = "I was restarted while working on this and lost my reply. Please send it again."


async def test_two_processes_posting_one_key_say_it_once_as_the_agent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room = await make_room(session_factory)
    agent, client = await make_agent(session_factory, "user-a-lead")
    await add_member(session_factory, room, client, agent=agent)
    first, second = process_on(session_factory), process_on(session_factory)

    posted = await asyncio.gather(
        *(
            process.router.post_as_agent(
                TENANT_ZERO_ID,
                agent.id,
                room.id,
                LINE,
                thread_root_id=None,
                client_txn_id="restart:cmd-cut-off",
            )
            for process in (first, second, first)
        )
    )

    said = await said_by(session_factory, room, client)
    assert [m.body for m in said] == [LINE]
    assert len(set(posted)) == 1 and posted[0] == said[0].transport_event_id
    # Switch spoke for the agent: flagged so another agent doesn't answer it,
    # and not counted as the agent's own message.
    assert said[0].content.get(AUTO_REPLY_FLAG) is True


async def test_an_agent_not_in_the_room_says_nothing_there(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room = await make_room(session_factory)
    agent, client = await make_agent(session_factory, "left-the-room")
    posted = await process_on(session_factory).router.post_as_agent(
        TENANT_ZERO_ID,
        agent.id,
        room.id,
        LINE,
        thread_root_id=None,
        client_txn_id="restart:cmd",
    )
    assert posted is None
    assert await said_by(session_factory, room, client) == []


@pytest.mark.usefixtures("hosted_v2_on")
async def test_two_processes_sweeping_a_gone_box_close_its_turn_and_say_the_line_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """End to end: box A in the 26 Oct flood, killed at 11:43:52Z and never back."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from switch_core.db.models import (
        AgentController,
        AgentDefinition,
        AgentSessionActivityItem,
        ApiKey,
        MachineWorkspace,
    )
    from switch_core.session_activity.maintenance import sweep_once
    from tests.switch_core.hosted_machine_helpers import seed_machine

    killed = datetime(2026, 10, 26, 11, 43, 52, tzinfo=UTC)
    room = await make_room(session_factory)
    agent, client = await make_agent(session_factory, "user-a-engineer")
    await add_member(session_factory, room, client, agent=agent)
    async with session_factory() as db:
        key = ApiKey(
            type="controller",
            key_hash="h-box",
            encrypted_key="e",
            label="box",
            user_id=agent.owner_id,
        )
        db.add(key)
        await db.flush()
        box = AgentController(
            owner_id=agent.owner_id,
            name="box",
            kind="ec2",
            api_key_id=key.id,
            connected_at=killed - timedelta(hours=1),
            disconnected_at=killed,
            disconnect_reason="heartbeat_lapsed",
        )
        db.add(box)
        await db.flush()
        # On a v2 box: the restart sweep reads only controllers on one.
        machine = await seed_machine(
            db,
            owner_id=agent.owner_id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        machine.backend = "box"
        workspace = await db.scalar(
            select(MachineWorkspace).where(MachineWorkspace.machine_id == machine.id)
        )
        assert workspace is not None
        workspace.controller_id = box.id
        await db.flush()
        db.add(
            AgentDefinition(
                agent_id=agent.id,
                owner_id=agent.owner_id,
                controller_id=box.id,
                revision=1,
                desired_state="running",
                definition={"provider": "claude"},
            )
        )
        db.add(
            AgentSessionActivityItem(
                tenant_id=TENANT_ZERO_ID,
                agent_id=agent.id,
                session_id="session-1",
                turn_id="cmd-cut-off",
                item_id="turn",
                kind="turn",
                revision=3,
                status="running",
                title="",
                text="",
                command_id="cmd-cut-off",
                room_id=room.id,
                thread_id="sw_ask",
                message_id="sw_ask",
                occurred_at=killed - timedelta(seconds=13),
            )
        )
        await db.commit()
    first, second = process_on(session_factory), process_on(session_factory)
    at = killed + timedelta(minutes=10)

    await asyncio.gather(
        sweep_once(session_factory, first.router.post_as_agent, now=at),
        sweep_once(session_factory, second.router.post_as_agent, now=at),
    )
    # The box's own line, if it ever came back, is the same key: still once.
    await first.router.post_as_agent(
        TENANT_ZERO_ID,
        agent.id,
        room.id,
        LINE,
        thread_root_id=None,
        client_txn_id="restart:cmd-cut-off",
    )

    assert [m.body for m in await said_by(session_factory, room, client)] == [LINE]
    async with session_factory() as db:
        status = await db.scalar(
            select(AgentSessionActivityItem.status).where(
                AgentSessionActivityItem.agent_id == agent.id
            )
        )
    assert status == "interrupted"
