import asyncio
import json

from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.stream import event_stream
from switch_core.db.models import require_tenant_id
from switch_core.sessions.command_notifications import schedule, subscribe

from .test_authority import command, setup


async def test_committed_console_command_wakes_agent_stream_without_a_room(
    session_factory,
):
    authority, epoch = await setup(session_factory)
    registry = ConnectionRegistry()
    conn = registry.open(
        agent_id="agent-demo",
        connection_id="controller",
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    stream = event_stream(
        conn=conn, registry=registry, buffer=EventBuffer(), approvals=None
    )
    await anext(stream)
    try:
        waiting = asyncio.create_task(anext(stream))
        await asyncio.sleep(0)
        result = await authority.submit(
            command(epoch, "stop", {"type": "session.stop"}),
            user_id="owner",
            bridge_id=None,
        )
        assert result.status == "accepted"
        frame = (await asyncio.wait_for(waiting, 1)).decode()
        assert "event: session_commands\n" in frame
        assert json.loads(frame.split("data: ")[1]) == {"session_ids": ["session-demo"]}
        assert conn.cursor == 0
        assert conn.rooms == set()
    finally:
        await stream.aclose()


async def test_notifications_wait_for_commit_and_isolate_tenants_and_agents(
    session_factory,
):
    own, other_tenant, other_agent = [], [], []
    tenant = require_tenant_id()
    with (
        subscribe(tenant, "agent", own.append),
        subscribe("other", "agent", other_tenant.append),
        subscribe(tenant, "other", other_agent.append),
    ):
        async with session_factory() as db:
            async with db.begin():
                schedule(db.sync_session, tenant, "agent", "session")
                schedule(db.sync_session, tenant, "agent", "session")
                assert own == []
            assert own == ["session"]
            async with db.begin():
                schedule(db.sync_session, tenant, "agent", "rolled-back")
                await db.rollback()
            async with db.begin():
                pass
            assert own == ["session"]
            assert other_tenant == other_agent == []
