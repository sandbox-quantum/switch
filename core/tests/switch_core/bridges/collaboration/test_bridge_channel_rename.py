"""A bridged room named after its channel follows the channel's name, while a
room someone named, or one whose origin is unknown, keeps its title and is
told the channel's name; another channel's rename touches nothing."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.db.models import Room
from switch_core.db.stores.room_store import NAME_SOURCE_KEY, RoomStore
from switch_core.tenant_context import current_tenant_id


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _RoomStore:
    def __init__(self, rooms: dict[str, SimpleNamespace]) -> None:
        self._rooms = rooms

    async def get_by_external_channel(
        self, session: Any, bridge_id: str, external_channel_id: str
    ) -> SimpleNamespace | None:
        assert bridge_id == "bridge-1"
        return self._rooms.get(external_channel_id)


class _RoomService:
    """Decides as `RoomStore.follow_channel_name` does, over the fake rooms."""

    def __init__(self, rooms: dict[str, SimpleNamespace]) -> None:
        self._rooms = {room.id: room for room in rooms.values()}
        self.renamed: list[tuple[str, str, str, str | None]] = []
        self.recorded: list[tuple[str, str]] = []

    async def follow_channel_name(
        self, room_id: str, name: str, channel_name: str, legacy_name: str
    ) -> bool:
        room = self._rooms[room_id]
        source = room.metadata_.get(NAME_SOURCE_KEY)
        if not (source == "channel" or (source is None and room.name == legacy_name)):
            return False
        self.renamed.append((room_id, name, channel_name, current_tenant_id()))
        return True

    async def record_channel_name(self, room_id: str, channel_name: str) -> None:
        self.recorded.append((room_id, channel_name))


def _room(room_id: str, name: str, source: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=room_id,
        name=name,
        metadata_={NAME_SOURCE_KEY: source} if source is not None else {},
    )


def _bridge(rooms: dict[str, SimpleNamespace]) -> SimpleNamespace:
    session = _FakeSession()
    return SimpleNamespace(
        _session_factory=lambda: session,
        _room_store=_RoomStore(rooms),
        _room_service=_RoomService(rooms),
        _bridge_id="bridge-1",
        _bridge_tenant_id="tenant-1",
        _bridge_type="discord",
        _bridge_display_name="Discord",
    )


async def _named(bridge: SimpleNamespace, channel_id: str, old: str, new: str) -> None:
    await CollaborationCore._handle_channel_named(bridge, channel_id, old, new)  # type: ignore[arg-type]


async def test_a_room_named_after_its_channel_follows_it() -> None:
    bridge = _bridge(
        {
            "c-1": _room("room-1", "Discord: qa-overnight-adopted", "channel"),
            "c-2": _room("room-2", "Discord: launch", None),
        }
    )
    # Named after the channel: follows even when its name was left stale.
    await _named(bridge, "c-1", "qa-adopted-renamed", "qa-adopted-again")
    # From before the source was kept: follows only an exact match.
    await _named(bridge, "c-2", "launch", "launch-2026")
    await _named(bridge, "c-9", "unlinked", "still-unlinked")
    assert bridge._room_service.renamed == [
        ("room-1", "Discord: qa-adopted-again", "qa-adopted-again", "tenant-1"),
        ("room-2", "Discord: launch-2026", "launch-2026", "tenant-1"),
    ]


async def test_a_named_or_ambiguous_room_keeps_its_title_and_learns_the_channel() -> (
    None
):
    bridge = _bridge(
        {
            "c-1": _room("room-1", "Discord: launch room", "custom"),
            # Pre-provenance and not an exact match: could be someone's title.
            "c-2": _room("room-2", "Discord: qa-overnight-adopted", None),
        }
    )
    await _named(bridge, "c-1", "launch", "launch-2026")
    await _named(bridge, "c-2", "qa-adopted-renamed", "qa-adopted-again")
    assert bridge._room_service.renamed == []
    assert bridge._room_service.recorded == [
        ("room-1", "launch-2026"),
        ("room-2", "qa-adopted-again"),
    ]


async def test_naming_a_room_marks_it_custom_and_a_platform_name_channel(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        room = await store.create(
            session,
            Room(
                transport_room_id="!r:test",
                name="Discord: general",
                description="",
                metadata_={"created_by_kind": "system"},
            ),
        )
        # Saving the name it already has is not naming it.
        await store.update_fields(session, room.id, name="Discord: general")
        assert NAME_SOURCE_KEY not in room.metadata_
        await store.update_fields(session, room.id, name="Discord: our room")
        assert room.metadata_[NAME_SOURCE_KEY] == "custom"
        # Named by someone between the bridge's read and its write: kept.
        assert not await store.follow_channel_name(
            session, room.id, "Discord: general-2", "general-2", "Discord: our room"
        )
        assert room.name == "Discord: our room"
        await store.set_platform_name(
            session, room.id, "Discord: general-2", "general-2"
        )
        assert room.metadata_[NAME_SOURCE_KEY] == "channel"
        assert room.metadata_["linked_channel_name"] == "general-2"
        assert room.metadata_["created_by_kind"] == "system"


async def test_the_adapter_reports_only_its_own_guilds_channels() -> None:
    reported: list[tuple[str, str]] = []

    async def named(channel_id: str, old: str, new: str) -> None:
        reported.append((channel_id, new))

    adapter = SimpleNamespace(
        _guild_id=1, _on_channel_named=named, _channel_names_seen=set()
    )

    def channel(guild_id: int, name: str) -> SimpleNamespace:
        return SimpleNamespace(id=42, name=name, guild=SimpleNamespace(id=guild_id))

    for before, after in (
        (channel(1, "old"), channel(1, "new")),
        (channel(2, "old"), channel(2, "new")),
        # A topic or permission change, once the channel has been seen: no lookup.
        (channel(1, "new"), channel(1, "new")),
        (channel(1, "new"), channel(1, "newer")),
    ):
        await DiscordAdapter.dispatch_channel_update(adapter, before, after)  # type: ignore[arg-type]
    assert reported == [("42", "new"), ("42", "newer")]
