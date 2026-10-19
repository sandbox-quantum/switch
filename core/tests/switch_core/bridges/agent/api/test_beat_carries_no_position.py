"""A heartbeat says the client is still there, and nothing more.

Clients report how far they have read on every beat: a position from clients
on agent-protocol revision 9, one number from older ones, a ticket from older
ones reading the room conversation. The server does not read it. The
connection's position is moved only by the stream, as it sends, and a client
that drops resumes from the position it sends when it reopens, which is
checked against the database then.

So a beat cannot move the server past events it never sent, whatever number it
carries, and it costs no database query. Beats arrive every two seconds from
every client, and a burst of them follows any restart.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.handlers import connection_beat
from switch_core.bridges.agent.api.schemas import ConnectionBeatRequest
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnection,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import TICKET_FLOOR, EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS, room_source
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import seed_agent

AGENT_ID = "agent-1"
CONN_ID = "conn-1"
ROOM_ID = "room-1"


class _Protocol:
    def __init__(self, event_buffer: EventBuffer | None) -> None:
        self.event_buffer = event_buffer
        self.connections = AgentConnectionRegistry()


def _connect(protocol: _Protocol) -> AgentConnection:
    conn = protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=CONN_ID,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        position={OWN_EVENTS: 4, room_source(ROOM_ID): 7},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    conn.stream_attached = True
    return conn


async def _beat(protocol: _Protocol, conn: AgentConnection, **body: Any) -> Any:
    return await connection_beat(
        AGENT_ID,
        ConnectionBeatRequest.model_validate(
            {"connection_id": CONN_ID, "generation": conn.stream_generation, **body}
        ),
        agent=SimpleNamespace(id=AGENT_ID, tenant_id=TENANT_ZERO_ID),  # type: ignore[arg-type]
        protocol=protocol,  # type: ignore[arg-type]
    )


async def test_a_beat_counts_and_reads_nothing_from_the_database() -> None:
    protocol = _Protocol(event_buffer=None)
    conn = _connect(protocol)

    await _beat(protocol, conn, cursor=9)

    assert conn.beats == 1


@pytest.mark.parametrize(
    "report",
    [
        {"position": {OWN_EVENTS: 500, room_source(ROOM_ID): 90}},
        {"position": {room_source("elsewhere"): 3}},
        {"position": {"not a source": 1}},
        {"cursor": 500},
        {"cursor": TICKET_FLOOR + 1},
    ],
    ids=["ahead", "another room", "not a position", "one number", "ticket"],
)
async def test_whatever_a_beat_reports_the_position_stays_where_the_stream_put_it(
    report: dict[str, Any],
) -> None:
    """Ahead of what was sent, as from another history (a database restored
    from a backup, another server); a room the connection has no place in;
    something that is not a position at all. The beat counts, and the position
    is untouched."""
    protocol = _Protocol(event_buffer=None)
    conn = _connect(protocol)

    await _beat(protocol, conn, **report)

    assert conn.beats == 1
    assert conn.position == {OWN_EVENTS: 4, room_source(ROOM_ID): 7}


async def test_the_next_event_after_a_beat_from_another_history_is_delivered(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The loss a beat could once cause: had the server adopted 500, the
    connection would sit past the agent's next event and skip it silently."""
    await seed_agent(session_factory, AGENT_ID)
    protocol = _Protocol(db_buffer)
    conn = protocol.connections.open(
        agent_id=AGENT_ID,
        connection_id=CONN_ID,
        scope="single",
        delivery_filter="addressed",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    conn.stream_attached = True
    protocol.connections.claim_room(conn, ROOM_ID, takeover=True)

    await _beat(protocol, conn, position={OWN_EVENTS: 500})
    sequence = await db_buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT_ID,
        ROOM_ID,
        AgentEvent(
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
        ),
        room_seq=1,
        message_key="$m",
    )

    delivered = await db_buffer.read_from(
        TENANT_ZERO_ID, AGENT_ID, conn.position[OWN_EVENTS], rooms={ROOM_ID}
    )
    assert [item.seq for item in delivered] == [sequence]
