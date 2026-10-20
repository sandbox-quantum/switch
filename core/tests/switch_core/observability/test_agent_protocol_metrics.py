"""The agent-side data-loss paths, which had counters only on the other side.

A delivery that raises is counted and alerted on. Until these existed, an event
dropped from an agent's buffer — the same loss, one layer up — was a log line,
and a connection expiring on a lapsed heartbeat was not recorded at all.
"""

from __future__ import annotations

import time as time_module
from collections.abc import Iterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol import agent_connections as conn_module
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from tests.db_buffer import age_events, seed_agent


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _counts(registry: MetricsRegistry, name: str) -> dict[tuple, float]:
    payload = next((p for p in registry.collect() if p.name == name), None)
    if payload is None:
        return {}
    return {
        tuple(sorted(point.attributes.items())): point.value
        for point in payload.numbers
    }


def _event(index: int) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id="room-1",
        payload=MessagePayload(
            message_id=f"m{index}",
            sender="@someone:test",
            sender_name="someone",
            body=f"hello {index}",
            addressed=True,
            timestamp=index,
        ),
    )


async def _keep(buffer: EventBuffer, index: int) -> None:
    """Message `index`, addressed to the agent and kept as one of its own."""
    await buffer.enqueue(
        TENANT_ZERO_ID,
        "agent-1",
        "room-1",
        _event(index),
        room_seq=index + 1,
        message_key=f"m{index}",
    )


async def test_events_dropped_for_retention_are_counted(
    registry, session_factory: async_sessionmaker[AsyncSession], db_buffer: EventBuffer
):
    """Each event retention deletes is counted, under its reason.

    There is no per-agent cap any more, so retention is the only way an event
    leaves the buffer unread. The reader is told it missed them when it next
    reads, so the loss is disclosed; this is what makes it countable too.
    """
    await seed_agent(session_factory, "agent-1")
    for index in range(3):
        await _keep(db_buffer, index)
    await age_events(session_factory, "agent-1", seconds=7200)

    assert await db_buffer.expire(TENANT_ZERO_ID) == 3
    assert _counts(registry, "switch.agent.events_dropped") == {
        (("reason", "retention"),): 3.0
    }


async def test_nothing_is_counted_when_nothing_is_dropped(
    registry, session_factory: async_sessionmaker[AsyncSession], db_buffer: EventBuffer
):
    await seed_agent(session_factory, "agent-1")
    await _keep(db_buffer, 0)

    assert await db_buffer.expire(TENANT_ZERO_ID) == 0
    assert _counts(registry, "switch.agent.events_dropped") == {}


def test_expired_connections_are_counted(registry, monkeypatch):
    """A flat connection count hides agents reconnecting as fast as they lapse."""
    connections = AgentConnectionRegistry()
    connections.open(
        agent_id="agent-1",
        connection_id="c1",
        scope="single",  # type: ignore[arg-type]
        delivery_filter="all",  # type: ignore[arg-type]
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )

    # Push the clock past the heartbeat TTL rather than sleeping through it.
    later = time_module.monotonic() + conn_module.HEARTBEAT_TTL_SECONDS + 1
    monkeypatch.setattr(conn_module.time, "monotonic", lambda: later)

    closed = connections.sweep()
    assert closed

    assert _counts(registry, "switch.agent.connections_expired") == {
        (): float(len(closed))
    }


def test_a_quiet_sweep_counts_nothing(registry):
    connections = AgentConnectionRegistry()
    connections.open(
        agent_id="agent-1",
        connection_id="c1",
        scope="single",  # type: ignore[arg-type]
        delivery_filter="all",  # type: ignore[arg-type]
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )

    assert connections.sweep() == []
    assert _counts(registry, "switch.agent.connections_expired") == {}


def _open(connections: AgentConnectionRegistry, connection_id: str = "c1") -> None:
    connections.open(
        agent_id="agent-1",
        connection_id=connection_id,
        scope="single",  # type: ignore[arg-type]
        delivery_filter="all",  # type: ignore[arg-type]
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )


def test_a_first_open_is_fresh(registry):
    _open(AgentConnectionRegistry())

    assert _counts(registry, "switch.agent.connections_opened") == {
        (("kind", "fresh"),): 1.0
    }


def test_a_socket_coming_back_to_a_live_connection_is_a_reattach(registry):
    connections = AgentConnectionRegistry()
    _open(connections)
    _open(connections)

    assert _counts(registry, "switch.agent.connections_opened") == {
        (("kind", "fresh"),): 1.0,
        (("kind", "reattach"),): 1.0,
    }


def test_a_return_after_a_lapse_is_told_apart(registry, monkeypatch):
    """The reconnect storm: agents lapse, then come straight back."""
    connections = AgentConnectionRegistry()
    _open(connections)
    later = time_module.monotonic() + conn_module.HEARTBEAT_TTL_SECONDS + 1
    monkeypatch.setattr(conn_module.time, "monotonic", lambda: later)
    assert connections.sweep()

    _open(connections)

    assert _counts(registry, "switch.agent.connections_opened") == {
        (("kind", "fresh"),): 1.0,
        (("kind", "after_lapse"),): 1.0,
    }


def test_a_return_after_any_other_close_is_after_close(registry):
    connections = AgentConnectionRegistry()
    _open(connections)
    connections.close("c1", conn_module.TAKEN_OVER)
    _open(connections)

    assert (
        _counts(registry, "switch.agent.connections_opened")[(("kind", "after_close"),)]
        == 1.0
    )


def test_the_memory_of_closed_connections_is_bounded(monkeypatch):
    monkeypatch.setattr(conn_module, "_RECENTLY_CLOSED_LIMIT", 2)
    connections = AgentConnectionRegistry()
    for index in range(4):
        _open(connections, f"c{index}")
        connections.close(f"c{index}", conn_module.HEARTBEAT_LAPSED)

    assert list(connections._recently_closed) == ["c2", "c3"]


def test_a_lapse_noticed_on_next_use_is_counted_too(registry, monkeypatch):
    """The sweep is one of three ways a lapse is noticed. Counting only it
    under-reported lapses against the reconnects that follow them."""
    connections = AgentConnectionRegistry()
    _open(connections)
    later = time_module.monotonic() + conn_module.HEARTBEAT_TTL_SECONDS + 1
    monkeypatch.setattr(conn_module.time, "monotonic", lambda: later)

    with pytest.raises(conn_module.UnknownConnectionError):
        connections.require("agent-1", "c1")
    _open(connections)

    # One collection: reading the registry resets it.
    payloads = {p.name: p for p in registry.collect()}
    expired = sum(
        point.value for point in payloads["switch.agent.connections_expired"].numbers
    )
    opened = {
        point.attributes["kind"]: point.value
        for point in payloads["switch.agent.connections_opened"].numbers
    }
    assert expired == 1.0
    assert opened == {"fresh": 1.0, "after_lapse": 1.0}
