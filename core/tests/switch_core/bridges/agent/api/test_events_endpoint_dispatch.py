"""The /events endpoint serves both transports off one path (CHOO-1857).

`Accept: text/event-stream` opens a connection and streams; anything else gets
the long poll. Both read the same buffer, so the two cannot diverge while they
coexist — but the dispatch itself is easy to break silently, hence these.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from starlette.responses import StreamingResponse

from switch_core.bridges.agent.api.handlers import _resolve_start_cursor, poll_events
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer

AGENT_ID = "agent-1"


class _Protocol:
    def __init__(self) -> None:
        self.event_buffer = EventBuffer()
        self.connections = ConnectionRegistry()
        self.polled = False

    async def poll_events(self, agent_id: str, timeout: float) -> list[Any]:
        self.polled = True
        return []

    async def require_room_member(self, agent_id: str, room_id: str) -> None:
        return None


def _agent() -> Any:
    return SimpleNamespace(id=AGENT_ID)


async def _call(protocol: _Protocol, **kw: Any) -> Any:
    params: dict[str, Any] = {
        "agent_id": AGENT_ID,
        "agent": _agent(),
        "protocol": protocol,
        "timeout": 0,
        "accept": None,
        "connection_id": None,
        "scope": "single",
        "event_filter": "all",
        "start_from": "head",
        "spawn_capable": False,
        "protocol_version": PROTOCOL_VERSION,
        "rooms": None,
        "last_event_id": None,
    }
    params.update(kw)
    return await poll_events(**params)


async def test_without_the_sse_accept_header_it_long_polls() -> None:
    protocol = _Protocol()
    resp = await _call(protocol, accept="application/json")

    assert protocol.polled
    assert resp.status_code == 204


async def test_with_the_sse_accept_header_it_opens_a_connection() -> None:
    protocol = _Protocol()
    resp = await _call(
        protocol, accept="text/event-stream", connection_id="c1", scope="all"
    )

    assert isinstance(resp, StreamingResponse)
    assert resp.media_type == "text/event-stream"
    # Buffering proxies would defeat the point of a push channel.
    assert resp.headers["x-accel-buffering"] == "no"
    assert not protocol.polled

    conn = protocol.connections.get("c1")
    assert conn is not None
    assert conn.scope == "all"


async def test_streaming_without_a_connection_id_is_refused() -> None:
    protocol = _Protocol()
    with pytest.raises(HTTPException) as excinfo:
        await _call(protocol, accept="text/event-stream")

    assert excinfo.value.status_code == 400
    assert "connection_id is required" in excinfo.value.detail


@pytest.mark.parametrize(
    ("field", "value"),
    [("scope", "everything"), ("event_filter", "some")],
)
async def test_bad_scope_or_filter_is_refused(field: str, value: str) -> None:
    protocol = _Protocol()
    with pytest.raises(HTTPException) as excinfo:
        await _call(
            protocol, accept="text/event-stream", connection_id="c1", **{field: value}
        )

    assert excinfo.value.status_code == 400


async def test_an_incompatible_protocol_version_is_refused() -> None:
    protocol = _Protocol()
    with pytest.raises(HTTPException) as excinfo:
        await _call(
            protocol,
            accept="text/event-stream",
            connection_id="c1",
            protocol_version=PROTOCOL_VERSION + 1,
        )

    assert excinfo.value.status_code == 409
    assert "update the Switch agent runtime" in excinfo.value.detail


# ── Start cursor ────────────────────────────────────────────────────────────


def test_head_means_only_what_happens_next() -> None:
    protocol = _Protocol()
    protocol.event_buffer.enqueue(AGENT_ID, "room", _event())
    assert _resolve_start_cursor(protocol, AGENT_ID, "head", None) == 1


def test_last_event_id_wins_over_start_from() -> None:
    protocol = _Protocol()
    assert _resolve_start_cursor(protocol, AGENT_ID, "head", "42") == 42


def test_explicit_start_from_is_honoured() -> None:
    protocol = _Protocol()
    assert _resolve_start_cursor(protocol, AGENT_ID, "17", None) == 17


def test_a_nonsense_cursor_is_refused_rather_than_guessed() -> None:
    protocol = _Protocol()
    with pytest.raises(HTTPException) as excinfo:
        _resolve_start_cursor(protocol, AGENT_ID, "banana", None)
    assert excinfo.value.status_code == 400


def _event() -> Any:
    from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload

    return AgentEvent(
        type="message",
        room_id="room",
        payload=MessagePayload(
            addressed=True,
            sender="@u:s",
            sender_name="u",
            message_id="$e",
            body="hi",
            timestamp=0,
        ),
    )


class TestDeclaringARoomAtOpenTakesOver:
    """A supervisor opening a stream for a room it manages must win the slot.

    The rule: the client doing the delivering owns the room. Naming a room on
    the URL is a supervisor asserting ownership of a session it is about to
    feed; a `connect_to_room` claim is cooperative and yields.

    Without the takeover, a session started before its supervisor learned to
    share connections keeps the slot, and the supervisor's restored stream 409s
    and retries forever while the session sits silent.
    """

    async def test_an_incumbent_is_evicted_from_the_room(self) -> None:
        protocol = _Protocol()
        incumbent = protocol.connections.open(
            agent_id=AGENT_ID,
            connection_id="in-session-runtime",
            scope="single",
            delivery_filter="all",
            spawn_capable=False,
            cursor=0,
            protocol_version=PROTOCOL_VERSION,
        )
        protocol.connections.claim_room(incumbent, "room-1")

        resp = await _call(
            protocol,
            accept="text/event-stream",
            connection_id="supervisor",
            rooms="room-1",
        )

        assert isinstance(resp, StreamingResponse)
        claimant = protocol.connections.claimant_of(AGENT_ID, "room-1")
        assert claimant is not None
        assert claimant.id == "supervisor"
        assert "room-1" not in incumbent.rooms
