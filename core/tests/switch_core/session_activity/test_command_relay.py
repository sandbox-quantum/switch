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
from switch_core.bridges.agent.protocol.stream import event_stream
from switch_core.db.models import User
from switch_core.gateway.agent_sessions import router
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_protocol, get_session_factory
from switch_core.sessions.errors import SessionError
from switch_core.sessions.http import session_error_response

from .conftest import make_agent

AGENT = "relay-agent"
COMMAND = {
    "commandId": "command-1",
    "epoch": "epoch-1",
    "body": {"type": "turn.interrupt", "turnId": "turn-1"},
}


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
        conn=conn, registry=registry, buffer=EventBuffer(), approvals=None
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


async def test_the_owners_command_reaches_the_watcher_with_its_origin_set(
    session_factory, owner
):
    registry = ConnectionRegistry()
    _, stream = _watcher(registry, speaks=SESSION_COMMAND_PROTOCOL_REVISION)
    try:
        await anext(stream)  # connection_state
        waiting = asyncio.create_task(anext(stream))
        async with _client(session_factory, registry, owner) as client:
            sent = await client.post(
                f"/agent-sessions/{AGENT}/session-1/commands", json=COMMAND
            )
        assert sent.status_code == 200, sent.text
        assert sent.json() == {"commandId": "command-1", "relayed": True}
        text = (await asyncio.wait_for(waiting, 5)).decode()
        assert "event: session_command\n" in text
        frame = json.loads(text.split("data: ", 1)[1])
        assert frame == {
            "contractVersion": 1,
            "commandId": "command-1",
            "sessionId": "session-1",
            "epoch": "epoch-1",
            "origin": {
                "surface": "console",
                "actorId": owner,
                "roomId": None,
                "threadId": None,
                "messageId": None,
            },
            "body": {"type": "turn.interrupt", "turnId": "turn-1"},
        }
    finally:
        await stream.aclose()


async def test_someone_else_cannot_drive_the_agent(session_factory, owner):
    registry = ConnectionRegistry()
    conn, stream = _watcher(registry, speaks=SESSION_COMMAND_PROTOCOL_REVISION)
    conn.stream_attached = True
    async with _client(session_factory, registry, "someone-else") as client:
        refused = await client.post(
            f"/agent-sessions/{AGENT}/session-1/commands", json=COMMAND
        )
    assert refused.status_code == 403
    assert conn.session_commands == []
    await stream.aclose()


@pytest.mark.parametrize(
    ("speaks", "scope", "attached"),
    [
        (SESSION_COMMAND_PROTOCOL_REVISION, "all", False),
        (SESSION_COMMAND_PROTOCOL_REVISION - 1, "all", True),
        (SESSION_COMMAND_PROTOCOL_REVISION, "single", True),
    ],
)
async def test_a_command_nobody_can_take_is_refused(
    session_factory, owner, speaks, scope, attached
):
    registry = ConnectionRegistry()
    conn, stream = _watcher(registry, speaks=speaks, scope=scope)
    conn.stream_attached = attached
    async with _client(session_factory, registry, owner) as client:
        refused = await client.post(
            f"/agent-sessions/{AGENT}/session-1/commands", json=COMMAND
        )
    assert refused.status_code == 409
    assert refused.json()["code"] == "HOST_OFFLINE"
    assert conn.session_commands == []
    await stream.aclose()
