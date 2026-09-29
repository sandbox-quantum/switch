from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.bridge_core import BridgeCore

# On startup BridgeCore asks the adapter for each channel's real type and
# corrects rooms saved with the wrong one. A private channel's room saved as
# public is the case that matters: moving that room to another bridge keeps the
# saved type, and so opens a public channel there.


class _FakeSession:
    def __init__(self) -> None:
        self.commits = 0

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    async def commit(self) -> None:
        self.commits += 1


def _room(
    room_id: str, external_channel_id: str | None, channel_type: str | None
) -> SimpleNamespace:
    return SimpleNamespace(
        id=room_id, external_channel_id=external_channel_id, channel_type=channel_type
    )


class _RoomStore:
    def __init__(
        self, rooms: list[SimpleNamespace], *, changed_since: set[str] | None = None
    ) -> None:
        self._rooms = rooms
        # Rooms deleted, moved or retyped between the read and the write.
        self._changed_since = changed_since or set()
        self.written: list[tuple[str, str]] = []

    async def get_by_bridge(self, session: Any, bridge_id: str) -> list[Any]:
        assert bridge_id == "bridge-1"
        return self._rooms

    async def correct_channel_type(
        self,
        session: Any,
        room_id: str,
        *,
        bridge_id: str,
        external_channel_id: str,
        saved_type: str,
        channel_type: str,
    ) -> bool:
        assert bridge_id == "bridge-1"
        room = next(r for r in self._rooms if r.id == room_id)
        assert external_channel_id == room.external_channel_id
        assert saved_type == room.channel_type
        if room_id in self._changed_since:
            return False
        self.written.append((room_id, channel_type))
        return True


class _Adapter:
    def __init__(self, types: dict[str, str]) -> None:
        self._types = types
        self.asked: list[list[str]] = []

    async def read_channel_types(self, channel_ids: list[str]) -> dict[str, str]:
        self.asked.append(channel_ids)
        return {c: self._types[c] for c in channel_ids if c in self._types}


def _bridge(store: _RoomStore, adapter: _Adapter) -> SimpleNamespace:
    return SimpleNamespace(
        _session_factory=_FakeSession,
        _room_store=store,
        _adapter=adapter,
        _bridge_id="bridge-1",
        _bridge_tenant_id="tenant-1",
        _bridge_type="teams",
    )


async def test_a_private_channel_saved_as_public_is_corrected(
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = _RoomStore([_room("room-1", "19:p@thread.tacv2", "channel_public")])
    adapter = _Adapter({"19:p@thread.tacv2": "channel_private"})

    with caplog.at_level(logging.WARNING):
        await BridgeCore._correct_channel_types(_bridge(store, adapter))

    assert store.written == [("room-1", "channel_private")]
    assert "room-1" in caplog.text
    assert "corrected" in caplog.text


async def test_a_public_channel_saved_as_private_is_corrected() -> None:
    store = _RoomStore([_room("room-1", "19:s@thread.tacv2", "channel_private")])
    adapter = _Adapter({"19:s@thread.tacv2": "channel_public"})

    await BridgeCore._correct_channel_types(_bridge(store, adapter))

    assert store.written == [("room-1", "channel_public")]


async def test_a_room_changed_since_the_read_is_not_reported_corrected(
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = _RoomStore(
        [
            _room("room-moved", "19:m@thread.tacv2", "channel_public"),
            _room("room-1", "19:p@thread.tacv2", "channel_public"),
        ],
        changed_since={"room-moved"},
    )
    adapter = _Adapter(
        {"19:m@thread.tacv2": "channel_private", "19:p@thread.tacv2": "channel_private"}
    )

    with caplog.at_level(logging.WARNING):
        await BridgeCore._correct_channel_types(_bridge(store, adapter))

    assert store.written == [("room-1", "channel_private")]
    assert "room-moved" not in caplog.text
    assert "room-1" in caplog.text


async def test_rooms_that_match_or_cannot_be_read_are_left_alone() -> None:
    store = _RoomStore(
        [
            _room("room-ok", "19:ok@thread.tacv2", "channel_private"),
            _room("room-unread", "19:unread@thread.tacv2", "channel_public"),
        ]
    )
    adapter = _Adapter({"19:ok@thread.tacv2": "channel_private"})

    await BridgeCore._correct_channel_types(_bridge(store, adapter))

    assert store.written == []


async def test_only_channels_are_asked_about() -> None:
    store = _RoomStore(
        [
            _room("room-1", "19:a@thread.tacv2", "channel_public"),
            _room("room-2", "a:dm", "direct"),
            _room("room-3", "19:g@thread.v2", "group"),
            _room("room-4", None, "channel_public"),
            _room("room-5", "19:b@thread.tacv2", None),
        ]
    )
    adapter = _Adapter({})

    await BridgeCore._correct_channel_types(_bridge(store, adapter))

    assert adapter.asked == [["19:a@thread.tacv2"]]


async def test_nothing_is_asked_without_channels() -> None:
    store = _RoomStore([_room("room-2", "a:dm", "direct")])
    adapter = _Adapter({})

    await BridgeCore._correct_channel_types(_bridge(store, adapter))

    assert adapter.asked == []
    assert store.written == []


async def test_adapters_have_nothing_to_correct_by_default() -> None:
    types = await CollaborationAdapter.read_channel_types(
        SimpleNamespace(),  # type: ignore[arg-type]
        ["C1"],
    )
    assert types == {}
