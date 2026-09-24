"""Addressing a hosted agent whose cloud worker idled out wakes the worker."""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.connections import ClientDeclaration
from switch_core.clients.agent_client import _WAKING_MESSAGE, AgentClient
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.models import (
    Agent,
    ClientRoom,
    HostedLaunch,
    SdkSession,
    SdkSessionCommand,
    require_tenant_id,
)
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.events import CommandEvent, TaskDelegate
from switch_core.sessions.service import SessionAuthority, SessionError
from tests.switch_core.clients.test_agent_client_pool_checkouts import (
    _client,
    _CountingSessionFactory,
    _message,
    _room,
    _seed,
)
from tests.switch_core.sessions.test_authority import EXAMPLES

LAUNCH_ID = "launch-1"


async def _hosted_client(
    session_factory: async_sessionmaker[AsyncSession], *, sleeping: bool
) -> AgentClient:
    room_id, agents = await _seed(session_factory, names=["member"])
    agent = agents["member"]
    async with session_factory() as session:
        session.add(
            HostedLaunch(
                id=LAUNCH_ID,
                owner_id=agent.owner_id,
                name="member",
                spec={"auto_session": True},
                state="stopped",
                desired_state="stopped",
                sleeping=sleeping,
                agent_id=agent.id,
            )
        )
        row = await session.get(Agent, agent.id)
        assert row is not None
        row.metadata_ = {"hosted_launch_id": LAUNCH_ID}
        await session.commit()
    client = _client(_CountingSessionFactory(session_factory), agent, room_id)
    client._hosted_launch_store = HostedLaunchStore()
    client._waking_notice_revisions = {}
    client.enqueued = []  # type: ignore[attr-defined]
    client._event_buffer.enqueue = lambda *args: client.enqueued.append(args)  # type: ignore[attr-defined]
    return client


async def _launch(session_factory: async_sessionmaker[AsyncSession]) -> HostedLaunch:
    async with session_factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), LAUNCH_ID))
        assert launch is not None
        return launch


def _sent(client: Any) -> list[str]:
    return [body for body, _live in client.sent]


async def test_mention_wakes_a_sleeping_worker_and_says_so_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    client = await _hosted_client(session_factory, sleeping=True)

    await client.on_message(_room(), _message("@member can you look at this"))

    assert _sent(client) == ["@louisa " + _WAKING_MESSAGE]
    assert len(client.enqueued) == 1  # type: ignore[attr-defined]
    launch = await _launch(session_factory)
    assert (launch.desired_state, launch.state, launch.sleeping) == (
        "running",
        "queued",
        True,
    )

    await client.on_message(_room(), _message("@member and this too"))

    assert len(_sent(client)) == 1
    assert len(client.enqueued) == 2  # type: ignore[attr-defined]
    assert (await _launch(session_factory)).revision == launch.revision


async def test_mention_never_wakes_a_worker_its_owner_stopped(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    client = await _hosted_client(session_factory, sleeping=False)

    await client.on_message(_room(), _message("@member can you look at this"))

    assert len(_sent(client)) == 1
    assert _WAKING_MESSAGE not in _sent(client)[0]
    launch = await _launch(session_factory)
    assert (launch.desired_state, launch.revision) == ("stopped", 1)


async def test_wake_failure_does_not_drop_the_message(session_factory, caplog):
    client = await _hosted_client(session_factory, sleeping=True)
    client._hosted_launch_store.note_addressed = AsyncMock(
        side_effect=RuntimeError("wake unavailable")
    )
    await client.on_message(_room(), _message("@member please continue"))
    assert len(client.enqueued) == 1
    assert client.enqueued[0][2].payload.addressed
    assert "Could not wake cloud worker" in caplog.text


async def test_each_room_gets_one_waking_notice(session_factory):
    client = await _hosted_client(session_factory, sleeping=True)
    await client.on_message(_room(), _message("@member first room"))
    client._resolve_room_meta = AsyncMock(
        return_value=RoomMeta(room_id="another-room", name="Another")
    )
    await client.on_message(_room(), _message("@member second room"))
    await client.on_message(_room(), _message("@member second room again"))
    assert _sent(client) == ["@louisa " + _WAKING_MESSAGE] * 2


@pytest.mark.parametrize("event_type", ["task", "command"])
async def test_task_and_command_wake_sleeping_workers(session_factory, event_type):
    client = await _hosted_client(session_factory, sleeping=True)
    if event_type == "task":
        await client.on_task_delegate(
            _room(),
            TaskDelegate(
                task_id="task",
                requester_agent_id="requester",
                performer_agent_id=client.agent.id,
                summary="Review",
                description="Review this change",
            ),
        )
    else:
        client._handle_command = AsyncMock(return_value=False)
        await client.on_command(
            _room(),
            CommandEvent(
                command="custom",
                args="@member",
                user_id="@switch-slack-louisa:test",
                user_name="louisa",
            ),
        )
    assert len(client.enqueued) == 1
    assert (await _launch(session_factory)).desired_state == "running"


async def test_manual_start_does_not_send_idle_wake_notice(session_factory):
    client = await _hosted_client(session_factory, sleeping=False)
    async with session_factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), LAUNCH_ID))
        launch.state = "queued"
        launch.desired_state = "running"
        await session.commit()
    await client.on_message(_room(), _message("@member hello"))
    assert all(_WAKING_MESSAGE not in body for body in _sent(client))


@pytest.mark.parametrize("command", ["reset", "compact", "interrupt"])
async def test_unqueued_handled_command_does_not_wake_sleeping_worker(
    session_factory, command
):
    client = await _hosted_client(session_factory, sleeping=True)
    client._handle_command = AsyncMock(return_value=True)
    await client.on_command(
        _room(),
        CommandEvent(
            command=command,
            args="@member",
            user_id="@switch-slack-louisa:test",
            user_name="louisa",
        ),
    )
    assert (await _launch(session_factory)).desired_state == "stopped"
    assert not client.enqueued


async def test_reset_of_sleeping_worker_wakes_and_requests_explicit_retry(
    session_factory,
):
    client = await _hosted_client(session_factory, sleeping=True)
    client._connections = object()
    event = CommandEvent(
        command="reset",
        args="@member",
        user_id="@switch-slack-louisa:test",
        user_name="louisa",
        message_id="reset-message",
    )
    with (
        patch(
            "switch_core.bridges.agent.commands.SessionAuthority.submit_room_control",
            new=AsyncMock(side_effect=SessionError("HOST_OFFLINE", "No live session")),
        ),
        patch(
            "switch_core.bridges.agent.commands._reply", new_callable=AsyncMock
        ) as reply,
    ):
        await client.on_command(_room(), event)
    assert (await _launch(session_factory)).desired_state == "running"
    reply.assert_awaited_once()
    assert "reset was not queued" in reply.call_args.args[3]
    assert "!reset @member again" in reply.call_args.args[3]


async def test_room_reset_wakes_then_targets_the_reconnected_error_session(
    session_factory,
):
    client = await _hosted_client(session_factory, sleeping=True)
    room_id = (await client._resolve_room_meta(_room().room_id)).room_id
    snapshot = deepcopy(EXAMPLES["initialSnapshot"])
    snapshot.update(turns=[], requests=[], commandStatuses=[])
    snapshot["session"].update(
        {
            "agentId": client.agent.id,
            "sessionId": "sleeping-session",
            "hostId": "host",
            "epoch": "epoch",
            "status": "error",
            "roomIds": [room_id],
        }
    )
    snapshot["session"]["capabilities"]["reset"] = True
    async with session_factory() as db, db.begin():
        db.add(ClientRoom(client_id=client.agent.client_id, room_id=room_id))
        db.add(
            SdkSession(
                id="sleeping-session",
                agent_id=client.agent.id,
                host_id="host",
                epoch="epoch",
                connection_id="sleeping-connection",
                lease_expires_at=datetime.now(UTC) + timedelta(minutes=5),
                snapshot=snapshot,
            )
        )
    event = CommandEvent(
        command="reset",
        args="@member",
        user_id=client.agent.owner_id,
        user_name="Owner",
        message_id="first-reset",
    )
    await client.on_command(_room(), event)
    assert (await _launch(session_factory)).desired_state == "running"
    assert len(_sent(client)) == 1
    assert "reset was not queued" in _sent(client)[0]
    connection = client._connections.open(
        agent_id=client.agent.id,
        connection_id="sleeping-connection",
        scope="single",
        delivery_filter="addressed",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
    )
    client._connections.claim_room(connection, room_id)
    service = SessionAuthority(session_factory)
    await service.bind_connection(
        client.agent.id,
        "sleeping-session",
        "host",
        "epoch",
        connection.id,
        client._connections,
    )
    event.message_id = "second-reset"
    await client.on_command(_room(), event)
    assert len(_sent(client)) == 2
    assert "command: accepted" in _sent(client)[1]
    async with session_factory() as db:
        commands = list((await db.scalars(select(SdkSessionCommand))).all())
        assert len(commands) == 1
        assert commands[0].session_id == "sleeping-session"
        assert commands[0].command["body"]["type"] == "session.reset"


async def test_refused_reset_never_wakes_worker(session_factory):
    client = await _hosted_client(session_factory, sleeping=True)
    client._gate_command = AsyncMock(return_value=False)
    await client.on_command(
        _room(),
        CommandEvent(
            command="reset",
            args="@member",
            user_id="outsider",
            user_name="Outsider",
            message_id="refused",
        ),
    )
    assert (await _launch(session_factory)).desired_state == "stopped"
