"""A reload of a bridge's room mappings that read the rows before a room was
unbridged here must not map the room again: no signal would come to undo it,
and the bridge would carry the channel into a room it no longer serves."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore

ROOM = SimpleNamespace(
    id="room-1",
    transport_room_id="!room-1:switch.local",
    external_channel_id="C1",
    tenant_id="tenant-1",
)


class _RoomStore:
    """The bridge's rooms as they were read, with the read held until
    released once it has read."""

    def __init__(self, rooms: list[SimpleNamespace]) -> None:
        self.rooms = rooms
        self.read = asyncio.Event()
        self.release = asyncio.Event()

    async def get_by_bridge(self, session: Any, bridge_id: str) -> list[Any]:
        rooms = list(self.rooms)
        self.read.set()
        await self.release.wait()
        return rooms


class _Session:
    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


def _bridge(store: _RoomStore) -> CollaborationCore:
    bridge = CollaborationCore.__new__(CollaborationCore)
    bridge._bridge_id = "bridge-1"
    bridge._bridge_tenant_id = "tenant-1"
    bridge._room_tenants = {}
    bridge._channel_to_room = {}
    bridge._room_to_channel = {}
    bridge._mapping_changes = {}
    bridge._room_store = store  # type: ignore[assignment]
    bridge._session_factory = _Session  # type: ignore[assignment]
    return bridge


async def test_a_room_unbridged_during_a_reload_stays_unmapped() -> None:
    store = _RoomStore([ROOM])
    bridge = _bridge(store)
    bridge.add_room_mapping(ROOM.id, ROOM.transport_room_id, "C1", ROOM.tenant_id)

    reload = asyncio.create_task(bridge.reload_channel_map())
    await asyncio.wait_for(store.read.wait(), 5)
    # As unbridging does: the row is cleared, then the mapping here.
    store.rooms = []
    bridge.remove_room_mapping(ROOM.id, ROOM.transport_room_id)
    store.release.set()
    await asyncio.wait_for(reload, 5)

    assert bridge._find_channel(room_id=ROOM.id) is None
    assert "C1" not in bridge._channel_to_room


async def test_a_room_bridged_during_a_reload_stays_mapped() -> None:
    store = _RoomStore([])
    bridge = _bridge(store)

    reload = asyncio.create_task(bridge.reload_channel_map())
    await asyncio.wait_for(store.read.wait(), 5)
    bridge.add_room_mapping(ROOM.id, ROOM.transport_room_id, "C1", ROOM.tenant_id)
    store.release.set()
    await asyncio.wait_for(reload, 5)

    assert bridge._find_channel(room_id=ROOM.id) == "C1"


async def test_a_room_unbridged_elsewhere_is_unmapped() -> None:
    store = _RoomStore([])
    store.release.set()
    bridge = _bridge(store)
    bridge.add_room_mapping(ROOM.id, ROOM.transport_room_id, "C1", ROOM.tenant_id)

    await bridge.reload_channel_map()

    assert bridge._find_channel(room_id=ROOM.id) is None
