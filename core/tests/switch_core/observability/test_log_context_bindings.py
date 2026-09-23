"""The context fields are actually bound, not merely bindable.

Asserting a field *can* be bound proves it exists and nothing about whether
anything sets it, and a log field nobody binds is worse than no field: a column
of nulls that reads as "this never has a room" rather than "nobody wrote one".
So each test here drives a real code path and asserts the value reaches a
`LogRecord` — the filter is on the handler, so a bound value lands on every
record underneath it, including records from libraries.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.logging_context import LogContextFilter, current_log_context
from switch_core.transport.postgres import PostgresTransport


class _Capture(logging.Handler):
    """Records with the context filter applied, as the real handler has it."""

    def __init__(self) -> None:
        super().__init__()
        self.addFilter(LogContextFilter(default_tenant_id="default"))
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def fields(self, name: str) -> list[Any]:
        return [getattr(record, name, None) for record in self.records]


@pytest.fixture
def captured():
    handler = _Capture()
    root = logging.getLogger()
    root.addHandler(handler)
    previous = root.level
    root.setLevel(logging.DEBUG)
    yield handler
    root.removeHandler(handler)
    root.setLevel(previous)


class TestTheDeliveryLoopBindsItsRoom:
    """The loop drains one room at a time and its failure path names the room
    in the message. Everything *underneath* the drain — the handlers, the
    stores, whatever they log — had no room on it at all, which is most of what
    a stalled room produces."""

    async def test_a_failing_drain_carries_the_room(self, captured: _Capture) -> None:
        transport = object.__new__(PostgresTransport)
        transport.user_id = "@someone:test"  # type: ignore[attr-defined]
        transport._wake = asyncio.Event()  # type: ignore[attr-defined]
        transport._pending = {"room-7"}  # type: ignore[attr-defined]
        transport._delivering = False  # type: ignore[attr-defined]

        async def _boom(room_id: str) -> None:
            logging.getLogger("switch_core.test").info("inside the drain")
            raise RuntimeError("delivery blew up")

        transport._drain_room = _boom  # type: ignore[attr-defined]
        transport._wake.set()

        loop = asyncio.create_task(transport._deliver_forever_unbound())
        await asyncio.sleep(0.05)
        loop.cancel()
        with pytest.raises(asyncio.CancelledError):
            await loop

        # Both the line the drain itself logged and the loop's own error line.
        assert "room-7" in captured.fields("room_id")
        assert captured.fields("room_id").count("room-7") >= 2

    async def test_the_binding_does_not_outlive_the_loop(
        self, captured: _Capture
    ) -> None:
        """A `ContextVar` set and never reset would leak one room's id onto
        every later line in the same task."""
        transport = object.__new__(PostgresTransport)
        transport.user_id = "@someone:test"  # type: ignore[attr-defined]
        transport._wake = asyncio.Event()  # type: ignore[attr-defined]
        transport._pending = {"room-7"}  # type: ignore[attr-defined]
        transport._delivering = False  # type: ignore[attr-defined]

        async def _ok(room_id: str) -> None:
            return None

        transport._drain_room = _ok  # type: ignore[attr-defined]
        transport._wake.set()

        loop = asyncio.create_task(transport._deliver_forever_unbound())
        await asyncio.sleep(0.05)
        loop.cancel()
        with pytest.raises(asyncio.CancelledError):
            await loop

        assert current_log_context().room_id is None


class TestTheProtocolBindsItsAgent:
    """Both of these are swept by the registry's own bookkeeping rather than
    called by an agent, so there is no request context to inherit — and both
    are exactly the line somebody goes looking for when one agent will not stay
    connected or keeps missing events."""

    def test_a_closing_connection_carries_the_agent(self, captured: _Capture) -> None:
        registry = ConnectionRegistry()
        registry.open(
            agent_id="agent-42",
            connection_id="c1",
            scope="single",  # type: ignore[arg-type]
            delivery_filter="all",  # type: ignore[arg-type]
            spawn_capable=False,
            cursor=0,
            declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        )

        registry.close("c1", "heartbeat lapsed")

        closed = [r for r in captured.records if "[CONN] closed" in r.getMessage()]
        assert closed, "the registry did not report the close at all"
        assert all(getattr(r, "agent_id", None) == "agent-42" for r in closed)

    def test_an_overflowing_buffer_carries_the_agent(self, captured: _Capture) -> None:
        buffer = EventBuffer(max_events_per_agent=2, retention_seconds=3600)
        for index in range(5):
            buffer.enqueue(
                "agent-99",
                "room-1",
                AgentEvent(
                    type="message",
                    room_id="room-1",
                    payload=MessagePayload(
                        addressed=True,
                        sender="@u:s",
                        sender_name="u",
                        message_id=f"$m{index}",
                        body="hi",
                        timestamp=0,
                    ),
                ),
            )

        overflow = [r for r in captured.records if "exceeded" in r.getMessage()]
        assert overflow, "the buffer did not report an overflow at all"
        assert all(getattr(r, "agent_id", None) == "agent-99" for r in overflow)


class TestTheBridgeInboundPathBindsItsRoom:
    """`_traced` already resolves the channel's room to find the tenant, so the
    id is in hand — it just was not a field. An inbound platform event fans out
    across room lookup, identity provisioning and the transport, and none of
    those lines could be attributed to a room."""

    async def test_an_inbound_event_carries_the_room_it_is_for(
        self, captured: _Capture
    ) -> None:
        bridge = _bridge_core("slack", channel_to_room={"C1": ["room-5"]})

        async def handler(event) -> None:
            logging.getLogger("switch_core.test").info("handling the event")

        await bridge._traced("message", handler)(_InboundEvent("C1"))

        handled = [
            r for r in captured.records if "handling the event" in r.getMessage()
        ]
        assert handled, "the handler never ran"
        assert all(getattr(r, "room_id", None) == "room-5" for r in handled)

    async def test_a_channel_with_no_room_yet_binds_nothing(
        self, captured: _Capture
    ) -> None:
        """Auto-room-creation, still ahead of the handler. There is no room to
        name, and inventing one would be worse than the absence — `None` is the
        honest reading."""
        bridge = _bridge_core("slack", channel_to_room={})

        async def handler(event) -> None:
            logging.getLogger("switch_core.test").info("handling the event")

        await bridge._traced("message", handler)(_InboundEvent("C-unknown"))

        handled = [
            r for r in captured.records if "handling the event" in r.getMessage()
        ]
        assert handled
        assert all(getattr(r, "room_id", None) is None for r in handled)


class _InboundEvent:
    def __init__(self, channel_id: str) -> None:
        self.channel_id = channel_id


def _bridge_core(bridge_type: str, *, channel_to_room: dict[str, list[str]]):
    """A `BridgeCore` with only what `_traced` reads.

    Through `__new__` for the reason the outbound one is: the real constructor
    wants an adapter and six stores, none of which this path touches.
    """
    core = object.__new__(BridgeCore)
    core._bridge_type = bridge_type  # type: ignore[attr-defined]
    core._bridge_tenant_id = "tenant-1"  # type: ignore[attr-defined]
    core._channel_to_room = channel_to_room  # type: ignore[attr-defined]

    async def _room_tenant(room_id: str) -> str:
        return "tenant-1"

    core._room_tenant = _room_tenant  # type: ignore[attr-defined]
    return core
