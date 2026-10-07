"""What the agent event buffer costs per delivered event, and what it logs.

An agent past the cap drops an event on every enqueue, and used to log a
warning on every one: a line per delivered message for an agent that had read
everything. The warning is now at most once per interval per agent, while the
drop counter and the gap a reader is told about stay exact.

The buffer answers reads by walking the agent's retained events, so the walk is
measured: how many events, and how long, per call.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator

import pytest

from switch_core.bridges.agent.protocol import event_buffer as buffer_module
from switch_core.bridges.agent.protocol.event_buffer import (
    OVERFLOW_WARNING_INTERVAL_SECONDS,
    CursorExpiredError,
    EventBuffer,
    Reader,
)
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.observability.otlp import HistogramPoint

_LOGGER = "switch_core.bridges.agent.protocol.event_buffer"


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    clock = _Clock()
    monkeypatch.setattr(buffer_module.time, "monotonic", clock)
    return clock


def _event(index: int, *, addressed: bool = True) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id="room-1",
        payload=MessagePayload(
            message_id=f"m{index}",
            sender="@someone:test",
            sender_name="someone",
            body=f"hello {index}",
            addressed=addressed,
            timestamp=index,
        ),
    )


def _overflow_warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name == _LOGGER and "exceeded" in record.getMessage()
    ]


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


def test_overflow_warns_once_per_interval_per_agent(clock, registry, caplog):
    caplog.set_level(logging.WARNING, logger=_LOGGER)
    buffer = EventBuffer(
        max_events_per_agent=3, retention_seconds=3600, sequence_base=0
    )

    for index in range(50):
        buffer.enqueue("agent-1", "room-1", _event(index))
        clock.now += 0.1

    # 47 drops inside five seconds: one line, not 47.
    assert len(_overflow_warnings(caplog)) == 1
    assert _dropped(registry) == {(("reason", "overflow"),): 47.0}


def test_overflow_warning_resumes_after_the_interval_with_a_count(
    clock, registry, caplog
):
    caplog.set_level(logging.WARNING, logger=_LOGGER)
    buffer = EventBuffer(
        max_events_per_agent=3, retention_seconds=3600, sequence_base=0
    )

    for index in range(4):
        buffer.enqueue("agent-1", "room-1", _event(index))
    for index in range(4, 14):
        clock.now += 1
        buffer.enqueue("agent-1", "room-1", _event(index))
    clock.now += OVERFLOW_WARNING_INTERVAL_SECONDS
    buffer.enqueue("agent-1", "room-1", _event(14))

    warnings = _overflow_warnings(caplog)
    assert len(warnings) == 2
    # The ten drops between the two lines are counted into the second.
    assert "plus 10 dropped since the last warning" in warnings[1].getMessage()
    assert _dropped(registry) == {(("reason", "overflow"),): 12.0}


def test_overflow_warning_is_per_agent(clock, caplog):
    caplog.set_level(logging.WARNING, logger=_LOGGER)
    buffer = EventBuffer(
        max_events_per_agent=1, retention_seconds=3600, sequence_base=0
    )

    for index in range(5):
        buffer.enqueue("agent-1", "room-1", _event(index))
        buffer.enqueue("agent-2", "room-1", _event(index))

    warned = sorted(
        record.getMessage().split()[1] for record in _overflow_warnings(caplog)
    )
    assert warned == ["agent=agent-1", "agent=agent-2"]


def test_a_quiet_warning_still_leaves_the_gap_for_readers(clock, caplog):
    caplog.set_level(logging.WARNING, logger=_LOGGER)
    buffer = EventBuffer(
        max_events_per_agent=3, retention_seconds=3600, sequence_base=0
    )

    for index in range(20):
        buffer.enqueue("agent-1", "room-1", _event(index))

    assert len(_overflow_warnings(caplog)) == 1
    # A reader from the start is told about every drop, logged or not.
    with pytest.raises(CursorExpiredError) as exc:
        buffer.read_from("agent-1", 0)
    assert exc.value.oldest == 18
    assert exc.value.rooms == ("room-1",)
    assert [item.seq for item in buffer.read_from("agent-1", 17)] == [18, 19, 20]


def test_removing_an_agent_forgets_its_warning_state(clock, caplog):
    caplog.set_level(logging.WARNING, logger=_LOGGER)
    buffer = EventBuffer(
        max_events_per_agent=1, retention_seconds=3600, sequence_base=0
    )

    for index in range(3):
        buffer.enqueue("agent-1", "room-1", _event(index))
    buffer.remove("agent-1")
    for index in range(3):
        buffer.enqueue("agent-1", "room-1", _event(index))

    assert len(_overflow_warnings(caplog)) == 2


def test_a_read_records_how_many_events_it_walked(registry):
    buffer = EventBuffer(
        max_events_per_agent=100, retention_seconds=3600, sequence_base=0
    )
    for index in range(10):
        buffer.enqueue("agent-1", "room-1", _event(index))

    buffer.read_from("agent-1", 0)
    # Stopping at the limit walks only as far as the limit was reached.
    buffer.read_from("agent-1", 0, limit=3)

    scanned = _histograms(registry, "switch.agent.buffer.scanned")["read"]
    assert scanned.count == 2
    assert scanned.total == 13.0


def test_a_read_and_an_unread_count_record_their_duration(registry):
    buffer = EventBuffer(
        max_events_per_agent=100, retention_seconds=3600, sequence_base=0
    )
    reader = Reader(id="session-1", is_session=True)
    buffer.caught_up("agent-1", reader, "room-1", 0, arrived_on=None)
    for index in range(4):
        buffer.enqueue("agent-1", "room-1", _event(index, addressed=index == 3))

    buffer.read_from("agent-1", 0)
    assert buffer.unread("agent-1", "room-1", 4).count == 3

    collected = registry.collect()
    durations = next(
        p for p in collected if p.name == "switch.agent.buffer.scan.duration"
    )
    scanned = next(p for p in collected if p.name == "switch.agent.buffer.scanned")
    assert {p.attributes["operation"]: p.count for p in durations.histograms} == {
        "read": 1,
        "unread": 1,
    }
    assert all(p.total >= 0 for p in durations.histograms)
    assert {p.attributes["operation"]: p.total for p in scanned.histograms} == {
        "read": 4.0,
        "unread": 4.0,
    }


def test_an_unread_count_with_nothing_to_count_records_no_scan(registry):
    buffer = EventBuffer(sequence_base=0)
    buffer.enqueue("agent-1", "room-1", _event(0))

    # No baseline: answered without walking the buffer.
    assert buffer.unread("agent-1", "room-1", 1).count is None

    names = {p.name for p in registry.collect()}
    assert "switch.agent.buffer.scanned" not in names
