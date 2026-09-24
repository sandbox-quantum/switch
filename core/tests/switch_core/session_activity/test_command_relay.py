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

from .conftest import make_agent, make_room

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


async def test_a_relayed_session_command_reaches_the_watcher_stream() -> None:
    registry = ConnectionRegistry()
    _, stream = _watcher(registry, speaks=SESSION_COMMAND_PROTOCOL_REVISION)
    try:
        await anext(stream)  # connection_state
        waiting = asyncio.create_task(anext(stream))
        await asyncio.sleep(0.05)
        assert registry.relay_session_command(AGENT, FRAME) is True
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
    assert registry.relay_session_command(AGENT, FRAME) is False
    assert conn.session_commands == []
    await stream.aclose()


async def test_the_owner_sees_connections_and_where_sessions_are(
    session_factory, owner
) -> None:
    registry = ConnectionRegistry()
    _watcher(registry, speaks=SESSION_COMMAND_PROTOCOL_REVISION)
    registry.place_session(AGENT, "session-1", "room-1")
    async with _client(session_factory, registry, owner) as client:
        health = (await client.get("/agent-sessions/room-health")).json()
    assert health == {
        "connections": {AGENT: [f"conn-all-{SESSION_COMMAND_PROTOCOL_REVISION}"]},
        "placements": {AGENT: {"session-1": "room-1"}},
    }
    async with _client(session_factory, registry, "someone-else") as client:
        assert (await client.get("/agent-sessions/room-health")).json() == {
            "connections": {},
            "placements": {},
        }


async def test_the_owner_moves_a_room_to_a_session(session_factory, owner) -> None:
    async with session_factory() as db, db.begin():
        room_id = await make_room(db, member=AGENT)
        foreign = await make_room(db, member=None)
    registry = ConnectionRegistry()
    registry.place_session(AGENT, "session-old", room_id)
    async with _client(session_factory, registry, owner) as client:
        moved = await client.post(
            f"/agent-sessions/{AGENT}/session-new/place", json={"roomId": room_id}
        )
        refused = await client.post(
            f"/agent-sessions/{AGENT}/session-new/place", json={"roomId": foreign}
        )
    assert moved.json() == {"roomId": room_id, "displaced": "session-old"}
    assert registry.session_in_room(AGENT, room_id) == "session-new"
    assert refused.status_code == 403
    async with _client(session_factory, registry, "someone-else") as client:
        assert (
            await client.post(
                f"/agent-sessions/{AGENT}/session-x/place", json={"roomId": room_id}
            )
        ).status_code == 403
