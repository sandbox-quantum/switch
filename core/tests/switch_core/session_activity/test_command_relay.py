from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI

from switch_core.bridges.agent.protocol.connections import (
    SESSION_COMMAND_PROTOCOL_REVISION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.hosted_workers import WorkerBinding
from switch_core.bridges.agent.protocol.stream import event_stream
from switch_core.db.models import User
from switch_core.gateway.agent_sessions import router
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_protocol, get_session_factory
from switch_core.sessions.errors import SessionError
from switch_core.sessions.http import session_error_response

from .conftest import make_agent

AGENT = "relay-agent"
FRAME = {"sessionId": "session-1", "commandId": "command-1"}


class _Protocol:
    def __init__(self, registry: ConnectionRegistry) -> None:
        self.connections = registry


def _watcher(registry: ConnectionRegistry, *, speaks: int, scope: str = "all"):
    conn = registry.open(
        agent_id=AGENT,
        connection_id=f"conn-{scope}-{speaks}",
        scope=scope,
        delivery_filter="addressed",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=speaks),
        expected_generation=None,
    )
    stream = event_stream(
        conn=conn,
        registry=registry,
        buffer=EventBuffer(sequence_base=0),
        approvals=None,
    )
    return conn, stream


def _client(session_factory, registry, user_id: str) -> httpx.AsyncClient:
    app = FastAPI()
    app.include_router(router, prefix="/agent-sessions")
    app.add_exception_handler(SessionError, session_error_response)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_protocol] = lambda: _Protocol(registry)
    app.dependency_overrides[get_current_user] = lambda: User(
        id=user_id, name="Someone", email=f"{user_id}@example.test", role="user"
    )
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


@pytest.fixture
async def owner(session_factory, people) -> str:
    async with session_factory() as db, db.begin():
        return await make_agent(db, AGENT)


async def test_a_relayed_session_command_reaches_the_watcher_stream() -> None:
    registry = ConnectionRegistry()
    _, stream = _watcher(registry, speaks=SESSION_COMMAND_PROTOCOL_REVISION)
    try:
        await anext(stream)  # connection_state
        waiting = asyncio.create_task(anext(stream))
        await asyncio.sleep(0.05)
        assert registry.relay_session_command(AGENT, FRAME, worker_only=False) is True
        text = (await asyncio.wait_for(waiting, 5)).decode()
        assert "event: session_command\n" in text
        assert json.loads(text.split("data: ", 1)[1]) == FRAME
    finally:
        await stream.aclose()


@pytest.mark.parametrize(
    ("speaks", "scope"),
    [
        (SESSION_COMMAND_PROTOCOL_REVISION - 1, "all"),
        (SESSION_COMMAND_PROTOCOL_REVISION, "single"),
    ],
)
async def test_a_command_nobody_can_take_is_not_relayed(speaks, scope) -> None:
    registry = ConnectionRegistry()
    conn, stream = _watcher(registry, speaks=speaks, scope=scope)
    conn.stream_attached = True
    assert registry.relay_session_command(AGENT, FRAME, worker_only=False) is False
    assert conn.session_commands == []
    await stream.aclose()


async def test_switch_does_not_answer_where_an_agents_sessions_are(
    session_factory, owner
) -> None:
    """The agent's room watcher owns its connection and placements; Console asks it."""
    registry = ConnectionRegistry()
    _watcher(registry, speaks=SESSION_COMMAND_PROTOCOL_REVISION)
    registry.place_session(
        AGENT, "session-1", "room-1", f"conn-all-{SESSION_COMMAND_PROTOCOL_REVISION}"
    )
    async with _client(session_factory, registry, owner) as client:
        assert (await client.get("/agent-sessions/room-health")).status_code == 404


async def test_a_worker_only_command_skips_every_connection_but_the_worker() -> None:
    registry = ConnectionRegistry()
    plain, plain_stream = _watcher(registry, speaks=SESSION_COMMAND_PROTOCOL_REVISION)
    plain.stream_attached = True
    assert registry.relay_session_command(AGENT, FRAME, worker_only=True) is False
    worker, worker_stream = _watcher(
        registry, speaks=SESSION_COMMAND_PROTOCOL_REVISION, scope="single"
    )
    worker.stream_attached = True
    registry.bind_worker(
        worker, WorkerBinding("launch-1", 1, "boot-a", "instance-a"), {}
    )
    assert registry.relay_session_command(AGENT, FRAME, worker_only=True) is True
    assert worker.session_commands == [FRAME]
    assert plain.session_commands == []
    await plain_stream.aclose()
    await worker_stream.aclose()
