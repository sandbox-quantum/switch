from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.transport import HistoryPage, InboundMessage
from tests.switch_core.transport.fake import FakeTransport


def _ev(
    event_id: str,
    body: str,
    ts: int,
    *,
    thread_root: str | None = None,
    sender: str = "@u:server",
) -> InboundMessage:
    return InboundMessage(
        room_id="!matrix:server",
        event_id=event_id,
        sender=sender,
        timestamp=ts,
        content={"sender_name": "U"},
        body=body,
        sender_name="U",
        thread_root_id=thread_root,
    )


def _service_with_transport(transport: FakeTransport) -> ProtocolService:
    client = SimpleNamespace(transport=transport)
    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()

    async def _require_room_member(agent_id: str, room_id: str) -> SimpleNamespace:
        return SimpleNamespace(matrix_room_id="!matrix:server")

    svc.require_room_member = _require_room_member  # type: ignore[assignment]
    svc.client_lifecycle = SimpleNamespace(  # type: ignore[assignment]
        get_by_agent_id=lambda agent_id: client
    )
    return svc


def _transport(
    chunk: list[InboundMessage] | None = None,
    events: dict[str, InboundMessage] | None = None,
) -> FakeTransport:
    # No continuation token: the single page is the start of the room.
    transport = FakeTransport(
        history=HistoryPage(events=list(chunk or []), next_token=None)
    )
    transport.events_by_id = dict(events or {})
    return transport


class TestResolveThreadRoot:
    async def test_passthrough_for_root(self) -> None:
        svc = _service_with_transport(_transport(events={"e1": _ev("e1", "root", 100)}))
        client = svc.client_lifecycle.get_by_agent_id("a")

        root = await svc._resolve_thread_root(client, "!m:s", "e1")

        assert root == "e1"

    async def test_normalizes_mid_thread_reply_to_root(self) -> None:
        svc = _service_with_transport(
            _transport(events={"e2": _ev("e2", "reply", 200, thread_root="e1")})
        )
        client = svc.client_lifecycle.get_by_agent_id("a")

        root = await svc._resolve_thread_root(client, "!m:s", "e2")

        assert root == "e1"

    async def test_raises_when_event_missing(self) -> None:
        svc = _service_with_transport(_transport(events={}))
        client = svc.client_lifecycle.get_by_agent_id("a")

        with pytest.raises(ValueError, match="thread_id not found"):
            await svc._resolve_thread_root(client, "!m:s", "nope")


# Thread grouping in read_context is covered by test_read_context.py, which
# reads the message log rather than a transport.
