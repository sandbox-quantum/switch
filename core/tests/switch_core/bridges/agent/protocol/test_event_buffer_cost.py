"""What the agent event buffer records about its reads and what it drops.

Events used to sit in a capped in-memory deque, and an agent past the cap lost
one on every enqueue, with a warning rate-limited per agent. The cap and the
warning are gone: rows are deleted only by `expire`, and each deletion is
counted exactly and leaves a gap a reader is told about.

Reads are indexed queries now rather than walks of the deque, so what is
measured is how many events each call returned, and how long it took.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import (
    CursorExpiredError,
    EventBuffer,
    Reader,
)
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS, room_source
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.observability.otlp import HistogramPoint
from tests.db_buffer import age_events, say, seed_agent, seed_member


@pytest.fixture(autouse=True)
async def _agent_rows(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agents events are queued for here, so their rows have one to belong to."""
    await seed_agent(session_factory, "agent-1")
    await seed_agent(session_factory, "agent-2")


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _event(index: int, *, message_id: str | None = None) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id="room-1",
        payload=MessagePayload(
            message_id=message_id or f"m{index}",
            sender="@someone:test",
            sender_name="someone",
            body=f"hello {index}",
            addressed=True,
            timestamp=index,
        ),
    )


async def _keep(buffer: EventBuffer, agent_id: str, event: AgentEvent) -> int:
    """Keep one of an agent's own events. What is measured is the agent's own
    sequence, so the room row it stands for is left out."""
    return await buffer.enqueue(
        TENANT_ZERO_ID, agent_id, "room-1", event, room_seq=0, message_key=None
    )


def _dropped(registry: MetricsRegistry) -> dict[tuple, float]:
    payload = next(
        (p for p in registry.collect() if p.name == "switch.agent.events_dropped"),
        None,
    )
    if payload is None:
        return {}
    return {
        tuple(sorted(point.attributes.items())): point.value
        for point in payload.numbers
    }


def _histograms(registry: MetricsRegistry, name: str) -> dict[str, HistogramPoint]:
    payload = next((p for p in registry.collect() if p.name == name), None)
    assert payload is not None, f"{name} was not recorded"
    return {point.attributes["operation"]: point for point in payload.histograms}


async def test_expiry_counts_every_drop_and_leaves_the_gap_for_readers(
    registry, db_buffer: EventBuffer, session_factory
):
    buffer = db_buffer
    for index in range(17):
        await _keep(buffer, "agent-1", _event(index))
    await _keep(buffer, "agent-2", _event(0))
    await age_events(session_factory, "agent-1", seconds=2 * 3600)
    await age_events(session_factory, "agent-2", seconds=2 * 3600)

    assert await buffer.expire(TENANT_ZERO_ID) == 18
    for index in range(17, 20):
        await _keep(buffer, "agent-1", _event(index))

    # Every deleted row is counted, across agents, under the retention reason.
    assert _dropped(registry) == {(("reason", "retention"),): 18.0}
    # A reader from the start is told about every drop.
    with pytest.raises(CursorExpiredError) as exc:
        await buffer.read_from(TENANT_ZERO_ID, "agent-1", 0)
    assert exc.value.oldest == 18
    assert exc.value.rooms == ("room-1",)
    assert [
        item.seq for item in await buffer.read_from(TENANT_ZERO_ID, "agent-1", 17)
    ] == [18, 19, 20]


async def test_an_expiry_with_nothing_old_enough_drops_and_counts_nothing(
    registry, db_buffer: EventBuffer
):
    buffer = db_buffer
    await _keep(buffer, "agent-1", _event(0))

    assert await buffer.expire(TENANT_ZERO_ID) == 0

    assert _dropped(registry) == {}
    assert await buffer.rooms_dropped_after(TENANT_ZERO_ID, "agent-1", 0) == ()


async def test_a_read_records_how_many_events_it_returned(
    registry, db_buffer: EventBuffer
):
    buffer = db_buffer
    for index in range(10):
        await _keep(buffer, "agent-1", _event(index))

    await buffer.read_from(TENANT_ZERO_ID, "agent-1", 0)
    # A limited read is bounded by its limit, not by what is retained.
    await buffer.read_from(TENANT_ZERO_ID, "agent-1", 0, limit=3)

    scanned = _histograms(registry, "switch.agent.buffer.scanned")["read"]
    assert scanned.count == 2
    assert scanned.total == 13.0


async def test_a_read_and_an_unread_count_record_their_duration(
    registry, db_buffer: EventBuffer, session_factory
):
    buffer = db_buffer
    await seed_member(session_factory, "agent-1", "room-1")
    reader = Reader(id="session-1", is_session=True)
    await buffer.caught_up(TENANT_ZERO_ID, "agent-1", reader, "room-1", 0, None)
    # Three messages of conversation, then one addressed to the agent: a row in
    # the room like the others, and the agent's own event besides.
    for index in range(3):
        await say(session_factory, "room-1", f"hello {index}")
    asked = await say(session_factory, "room-1", "hello 3")
    await buffer.enqueue(
        TENANT_ZERO_ID,
        "agent-1",
        "room-1",
        _event(3, message_id=asked.transport_event_id),
        room_seq=asked.seq,
        message_key=asked.transport_event_id,
    )

    await buffer.read(
        TENANT_ZERO_ID,
        "agent-1",
        {OWN_EVENTS: 0, room_source("room-1"): 0},
        conversation_rooms={"room-1"},
        limit=200,
    )
    assert (
        await buffer.unread(TENANT_ZERO_ID, "agent-1", "room-1", asked.seq)
    ).count == 3

    collected = registry.collect()
    durations = next(
        p for p in collected if p.name == "switch.agent.buffer.scan.duration"
    )
    scanned = next(p for p in collected if p.name == "switch.agent.buffer.scanned")
    # A read is two scans: the agent's own events, and the rooms' conversation.
    assert {p.attributes["operation"]: p.count for p in durations.histograms} == {
        "read": 2,
        "unread": 1,
    }
    assert all(p.total >= 0 for p in durations.histograms)
    # Each scan of a read records the rows it returned (one event of the
    # agent's own, three of conversation); an unread count is one query, and
    # records what it counted (the addressed fourth message is not unread).
    assert {p.attributes["operation"]: p.total for p in scanned.histograms} == {
        "read": 4.0,
        "unread": 3.0,
    }


async def test_an_unread_count_with_nothing_to_count_records_no_scan(
    registry, db_buffer: EventBuffer
):
    buffer = db_buffer
    await _keep(buffer, "agent-1", _event(0))

    # No baseline: answered without counting the room's log.
    assert (await buffer.unread(TENANT_ZERO_ID, "agent-1", "room-1", 1)).count is None

    names = {p.name for p in registry.collect()}
    assert "switch.agent.buffer.scanned" not in names
