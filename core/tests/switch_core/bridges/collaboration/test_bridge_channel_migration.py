"""A room follows its channel when the platform reissues the channel's id.

Telegram gives a group a brand new chat id the moment it becomes a supergroup,
which promoting a bot or adding members is enough to trigger. Left alone, the
room stays bound to an id nothing arrives from again while sends keep working —
the platform forwards those — so the bridge looks alive and is deaf. These tests
pin the re-point, and the two cases where it must refuse rather than guess.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore

OLD_ID = "-4912345678"
NEW_ID = "-1009876543210"


class _Adapter:
    def __init__(self) -> None:
        self.notices: list[tuple[str, str]] = []

    async def admin_message(self, channel_id: str, content: str, *a: Any) -> str:
        self.notices.append((channel_id, content))
        return f"{channel_id}:1"


class _RoomStore:
    """Rooms keyed by external channel id, and the re-points asked for."""

    def __init__(self, rooms: dict[str, SimpleNamespace]) -> None:
        self._rooms = rooms
        self.repoints: list[tuple[str, str]] = []

    async def get_by_external_channel(
        self, session: Any, bridge_id: str, external_channel_id: str
    ) -> SimpleNamespace | None:
        return self._rooms.get(external_channel_id)

    async def update_external_channel(
        self, session: Any, room_id: str, external_channel_id: str
    ) -> None:
        self.repoints.append((room_id, external_channel_id))


class _Session:
    async def commit(self) -> None:
        return None

    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


def _make_bridge(rooms: dict[str, SimpleNamespace]) -> BridgeCore:
    bridge = BridgeCore.__new__(BridgeCore)
    bridge._bridge_id = "bridge-1"
    bridge._channel_locks = {}
    bridge._channel_to_room = {}
    bridge._room_to_channel = {}
    bridge._adapter = _Adapter()  # type: ignore[assignment]
    bridge._room_store = _RoomStore(rooms)  # type: ignore[assignment]
    bridge._session_factory = _Session  # type: ignore[assignment]
    return bridge


def _room(room_id: str = "room-uuid") -> SimpleNamespace:
    return SimpleNamespace(id=room_id, matrix_room_id=f"!{room_id}:switch.local")


def test_the_room_moves_onto_the_new_channel_id() -> None:
    room = _room()
    bridge = _make_bridge({OLD_ID: room})
    bridge._channel_to_room[OLD_ID] = (room.id, room.matrix_room_id)
    bridge._room_to_channel[(room.id, room.matrix_room_id)] = OLD_ID

    asyncio.run(BridgeCore._handle_channel_migrated(bridge, OLD_ID, NEW_ID))

    store: Any = bridge._room_store
    assert store.repoints == [(room.id, NEW_ID)]
    # The in-memory routing table is what inbound traffic is matched against,
    # so a committed row alone would not fix anything until the next restart.
    assert bridge._channel_to_room == {NEW_ID: (room.id, room.matrix_room_id)}
    assert bridge._room_to_channel == {(room.id, room.matrix_room_id): NEW_ID}


def test_the_chat_is_told_its_room_followed_it() -> None:
    room = _room()
    bridge = _make_bridge({OLD_ID: room})

    asyncio.run(BridgeCore._handle_channel_migrated(bridge, OLD_ID, NEW_ID))

    adapter: Any = bridge._adapter
    assert [channel for channel, _ in adapter.notices] == [NEW_ID]


def test_a_migration_of_an_unbridged_channel_is_a_no_op() -> None:
    bridge = _make_bridge({})

    asyncio.run(BridgeCore._handle_channel_migrated(bridge, OLD_ID, NEW_ID))

    store: Any = bridge._room_store
    adapter: Any = bridge._adapter
    assert store.repoints == []
    assert adapter.notices == []


def test_a_new_id_another_room_already_holds_is_refused() -> None:
    # The unique index on (bridge, external channel) would reject the update
    # anyway. Refusing loudly beats leaving two rooms that both look right when
    # one of them is bound to a dead id.
    old_room = _room("room-old")
    occupant = _room("room-new")
    bridge = _make_bridge({OLD_ID: old_room, NEW_ID: occupant})

    asyncio.run(BridgeCore._handle_channel_migrated(bridge, OLD_ID, NEW_ID))

    store: Any = bridge._room_store
    adapter: Any = bridge._adapter
    assert store.repoints == []
    assert adapter.notices == []
