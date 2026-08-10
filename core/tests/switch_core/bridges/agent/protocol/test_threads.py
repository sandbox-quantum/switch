from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from nio import RoomGetEventError

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService


def _ev(
    event_id: str,
    body: str,
    ts: int,
    *,
    thread_root: str | None = None,
    sender: str = "@u:server",
) -> SimpleNamespace:
    content: dict[str, Any] = {"sender_name": "U"}
    if thread_root is not None:
        content["m.relates_to"] = {"rel_type": "m.thread", "event_id": thread_root}
    return SimpleNamespace(
        event_id=event_id,
        sender=sender,
        server_timestamp=ts,
        body=body,
        source={"content": content},
    )


class _FakeNio:
    """Minimal nio AsyncClient stand-in for read paths."""

    def __init__(
        self,
        chunk: list[SimpleNamespace] | None = None,
        events: dict[str, SimpleNamespace] | None = None,
    ) -> None:
        self._chunk = chunk or []
        self._events = events or {}

    async def room_messages(
        self, room_id: str, start: str | None = None, limit: int = 0
    ) -> SimpleNamespace:
        return SimpleNamespace(chunk=self._chunk, end=None)

    async def room_get_event(self, room_id: str, event_id: str) -> Any:
        ev = self._events.get(event_id)
        if ev is None:
            return object.__new__(RoomGetEventError)
        return SimpleNamespace(event=ev)


def _service_with_client(nio: _FakeNio) -> ProtocolService:
    client = SimpleNamespace(nio_client=nio)
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


class TestResolveThreadRoot:
    async def test_passthrough_for_root(self) -> None:
        nio = _FakeNio(events={"e1": _ev("e1", "root", 100)})
        svc = _service_with_client(nio)
        client = svc.client_lifecycle.get_by_agent_id("a")

        root = await svc._resolve_thread_root(client, "!m:s", "e1")

        assert root == "e1"

    async def test_normalizes_mid_thread_reply_to_root(self) -> None:
        nio = _FakeNio(events={"e2": _ev("e2", "reply", 200, thread_root="e1")})
        svc = _service_with_client(nio)
        client = svc.client_lifecycle.get_by_agent_id("a")

        root = await svc._resolve_thread_root(client, "!m:s", "e2")

        assert root == "e1"

    async def test_raises_when_event_missing(self) -> None:
        nio = _FakeNio(events={})
        svc = _service_with_client(nio)
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
        svc = _service_with_client(_FakeNio(chunk=chunk))

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
        svc = _service_with_client(_FakeNio(chunk=chunk, events=events))

        result = (await svc.read_context("agent", "room"))["threads"]

        assert len(result) == 1
        assert result[0]["root"]["id"] == "e1"
        assert result[0]["root"]["body"] == "old root"
        assert "elided" not in result[0]["root"]
        assert [m["id"] for m in result[0]["replies"]] == ["e9"]

    async def test_orphan_root_elided_when_fetch_fails(self) -> None:
        chunk = [_ev("e9", "reply", 200, thread_root="e1")]
        svc = _service_with_client(_FakeNio(chunk=chunk, events={}))

        result = (await svc.read_context("agent", "room"))["threads"]

        assert len(result) == 1
        assert result[0]["root"]["id"] == "e1"
        assert result[0]["root"]["elided"] is True
        assert result[0]["root"]["body"] is None
        assert [m["id"] for m in result[0]["replies"]] == ["e9"]
