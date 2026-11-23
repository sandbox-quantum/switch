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
    bridge._mapping_stamps = 0
    bridge._mapping_stamped = {}
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


class _QueuedReads:
    """Each read returns the rooms as they were when it began and is held
    until its own release, so reads can finish in any order."""

    def __init__(self) -> None:
        self.rooms: list[SimpleNamespace] = []
        self.reads: list[tuple[asyncio.Event, asyncio.Event]] = []

    async def get_by_bridge(self, session: Any, bridge_id: str) -> list[Any]:
        rooms = list(self.rooms)
        read, release = asyncio.Event(), asyncio.Event()
        self.reads.append((read, release))
        read.set()
        await release.wait()
        return rooms


async def test_the_reload_that_began_last_wins_whichever_finishes_first() -> None:
    store = _QueuedReads()
    bridge = _bridge(store)  # type: ignore[arg-type]

    store.rooms = [ROOM]
    older = asyncio.create_task(bridge.reload_channel_map())
    await asyncio.sleep(0)
    store.rooms = []
    newer = asyncio.create_task(bridge.reload_channel_map())
    await asyncio.sleep(0)
    assert len(store.reads) == 2

    store.reads[0][1].set()
    await asyncio.wait_for(older, 5)
    assert bridge._find_channel(room_id=ROOM.id) == "C1"
    store.reads[1][1].set()
    await asyncio.wait_for(newer, 5)

    assert bridge._find_channel(room_id=ROOM.id) is None


async def test_a_channel_moved_to_another_room_stays_mapped() -> None:
    """Another process moved C1 from one room to another, the new room's key
    sorting first: unmapping the old room must not take C1 from the new."""
    moved_from = SimpleNamespace(
        id="room-2",
        transport_room_id="!room-2:switch.local",
        external_channel_id="C1",
        tenant_id="tenant-1",
    )
    store = _RoomStore([ROOM])
    store.release.set()
    bridge = _bridge(store)
    bridge.add_room_mapping(
        moved_from.id, moved_from.transport_room_id, "C1", "tenant-1"
    )

    await bridge.reload_channel_map()

    assert bridge._find_channel(room_id=ROOM.id) == "C1"
    assert bridge._find_channel(room_id=moved_from.id) is None
    assert bridge._channel_to_room["C1"] == (ROOM.id, ROOM.transport_room_id)


async def test_a_room_moved_to_another_channel_no_longer_hears_the_old_one() -> None:
    store = _RoomStore([ROOM])
    store.release.set()
    bridge = _bridge(store)
    bridge.add_room_mapping(ROOM.id, ROOM.transport_room_id, "C0", ROOM.tenant_id)

    await bridge.reload_channel_map()

    assert bridge._find_channel(room_id=ROOM.id) == "C1"
    assert "C0" not in bridge._channel_to_room
