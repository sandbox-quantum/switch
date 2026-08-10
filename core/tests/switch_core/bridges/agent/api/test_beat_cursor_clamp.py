"""A heartbeat cursor is clamped to the buffer head before anything adopts it.

The event buffer is in memory, so restarting switch-core resets the sequence to
zero while clients keep beating the number they had reached. Nothing downstream
can undo that: `beat()` and `confirm()` both refuse to move a cursor backwards,
and the stream's own rewind on resume is re-poisoned by the next heartbeat two
seconds later.

The result is silent. The connection is claimed, heartbeats succeed and posting
works, so the session looks healthy while every event up to the stale cursor is
skipped — and `confirm()` marks those events consumed on the way past.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.api.handlers import connection_beat
from switch_core.bridges.agent.api.schemas import ConnectionBeatRequest
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload

AGENT_ID = "agent-1"
CONN_ID = "conn-1"
ROOM_ID = "room-1"


class _Protocol:
    def __init__(self) -> None:
        self.event_buffer = EventBuffer()
        self.connections = ConnectionRegistry()


def _message() -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=ROOM_ID,
        payload=MessagePayload(
            addressed=True,
            sender="@u:s",
            sender_name="u",
            message_id="$m",
            body="hi",
            timestamp=0,
        ),
    )


def _connect(protocol: _Protocol, cursor: int = 0) -> Any:
    conn = protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=CONN_ID,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=cursor,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
    )
    conn.stream_attached = True
    return conn


async def _beat(protocol: _Protocol, cursor: int) -> Any:
    return await connection_beat(
        AGENT_ID,
        ConnectionBeatRequest(connection_id=CONN_ID, cursor=cursor),
        SimpleNamespace(id=AGENT_ID),  # type: ignore[arg-type]
        protocol,  # type: ignore[arg-type]
    )


async def test_a_cursor_past_the_head_is_pulled_back_to_it() -> None:
    # The restart case: the buffer is empty (head 0) and the client is still
    # beating the sequence it reached before the process died.
    protocol = _Protocol()
    conn = _connect(protocol)

    result = await _beat(protocol, cursor=9)

    assert protocol.event_buffer.head(AGENT_ID) == 0
    assert conn.cursor == 0
    assert result["cursor"] == 0


async def test_the_first_event_after_a_restart_is_still_delivered() -> None:
    # The symptom the clamp exists to prevent: without it the connection sits at
    # cursor 9, and sequences 1..9 — including the message that arrives next —
    # are skipped with no error anywhere.
    protocol = _Protocol()
    conn = _connect(protocol)
    protocol.connections.claim_room(conn, ROOM_ID, takeover=True)

    await _beat(protocol, cursor=9)
    protocol.event_buffer.enqueue(AGENT_ID, ROOM_ID, _message())

    delivered = protocol.event_buffer.read_from(AGENT_ID, conn.cursor, rooms={ROOM_ID})
    assert [item.seq for item in delivered] == [1]


async def test_a_cursor_within_the_buffer_is_left_alone() -> None:
    protocol = _Protocol()
    conn = _connect(protocol)
    for _ in range(3):
        protocol.event_buffer.enqueue(AGENT_ID, ROOM_ID, _message())

    await _beat(protocol, cursor=2)

    assert conn.cursor == 2


async def test_the_clamped_value_is_what_gets_confirmed() -> None:
    # confirm() drives retention. Handing it the stale cursor would mark events
    # consumed that were never delivered, so the clamp has to reach it too.
    protocol = _Protocol()
    _connect(protocol)
    confirmed: list[int] = []
    protocol.event_buffer.confirm = (  # type: ignore[method-assign]
        lambda agent_id, connection_id, cursor: confirmed.append(cursor)
    )

    await _beat(protocol, cursor=9)

    assert confirmed == [0]
