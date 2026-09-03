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


class TestReadContextThreads:
    async def test_groups_threads_ordered_by_latest_activity(self) -> None:
        # chunk is newest-first, as the homeserver returns it.
        chunk = [
            _ev("e2", "reply to e1", 200, thread_root="e1"),
            _ev("e3", "later top-level", 150),
            _ev("e1", "root", 100),
        ]
        svc = _service_with_transport(_transport(chunk=chunk))

        result = (await svc.read_context("agent", "room"))["threads"]

        # Two threads: e3 (latest 150) then e1 (latest 200) — most-active last.
        assert [g["root"]["id"] for g in result] == ["e3", "e1"]
        assert result[0]["replies"] == []
        assert [m["id"] for m in result[1]["replies"]] == ["e2"]
        # Each message exposes its id.
        assert result[1]["root"]["id"] == "e1"

    async def test_fetches_orphan_root_outside_window(self) -> None:
        chunk = [_ev("e9", "reply", 200, thread_root="e1")]
        events = {"e1": _ev("e1", "old root", 100)}
        svc = _service_with_transport(_transport(chunk=chunk, events=events))

        result = (await svc.read_context("agent", "room"))["threads"]

        assert len(result) == 1
        assert result[0]["root"]["id"] == "e1"
        assert result[0]["root"]["body"] == "old root"
        assert "elided" not in result[0]["root"]
        assert [m["id"] for m in result[0]["replies"]] == ["e9"]

    async def test_orphan_root_elided_when_fetch_fails(self) -> None:
        chunk = [_ev("e9", "reply", 200, thread_root="e1")]
        svc = _service_with_transport(_transport(chunk=chunk, events={}))

        result = (await svc.read_context("agent", "room"))["threads"]

        assert len(result) == 1
        assert result[0]["root"]["id"] == "e1"
        assert result[0]["root"]["elided"] is True
        assert result[0]["root"]["body"] is None
        assert [m["id"] for m in result[0]["replies"]] == ["e9"]
