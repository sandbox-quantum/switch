"""A bridged room follows its channel's renames while it is named after the
channel: adopted from it ("<app>: <channel>"), or named in Switch with the
channel made from that name. A room someone renamed in Switch, or one whose
origin cannot be told, keeps its name and is told the channel's; another
channel's rename touches nothing."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.db.models import Room
from switch_core.db.stores.room_store import (
    LINKED_CHANNEL_NAME_KEY,
    NAME_SOURCE_KEY,
    RoomStore,
)
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
    """Follows the rooms listed in `follows`; records what it was asked."""

    def __init__(self, follows: set[str]) -> None:
        self._follows = follows
        self.asked: list[tuple[str, dict[str, Any], str | None]] = []
        self.recorded: list[tuple[str, str]] = []

    async def follow_channel_name(self, room_id: str, **kwargs: Any) -> bool:
        self.asked.append((room_id, kwargs, current_tenant_id()))
        return room_id in self._follows

    async def record_channel_name(self, room_id: str, channel_name: str) -> None:
        self.recorded.append((room_id, channel_name))


def _bridge(rooms: dict[str, SimpleNamespace], follows: set[str]) -> SimpleNamespace:
    session = _FakeSession()
    return SimpleNamespace(
        _session_factory=lambda: session,
        _room_store=_RoomStore(rooms),
        _room_service=_RoomService(follows),
        _adapter=SlackAdapter,
        _bridge_id="bridge-1",
        _bridge_tenant_id="tenant-1",
        _bridge_type="slack",
        _bridge_display_name="Slack",
    )


def _linked(room_id: str, channel_name: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=room_id,
        metadata_=(
            {LINKED_CHANNEL_NAME_KEY: channel_name} if channel_name is not None else {}
        ),
    )


async def _named(bridge: SimpleNamespace, channel_id: str, old: str, new: str) -> None:
    await CollaborationCore._handle_channel_named(bridge, channel_id, old, new)  # type: ignore[arg-type]


async def test_the_bridge_hands_the_rename_to_the_room_with_its_own_naming() -> None:
    bridge = _bridge({"C1": _linked("room-1", "payments")}, follows={"room-1"})
    await _named(bridge, "C1", "payments", "payments-squad")
    await _named(bridge, "C9", "unlinked", "still-unlinked")
    [(room_id, asked, tenant)] = bridge._room_service.asked
    assert (room_id, tenant) == ("room-1", "tenant-1")
    assert asked["old_name"] == "payments"
    assert asked["new_name"] == "payments-squad"
    assert asked["bridge_display_name"] == "Slack"
    assert asked["channel_name_for"]("Payments Team") == "payments-team"
    assert bridge._room_service.recorded == []


async def test_a_room_that_does_not_follow_learns_the_channels_new_name() -> None:
    bridge = _bridge(
        {
            "C1": _linked("room-1", "payments"),
            "C2": _linked("room-2", "launch-2026"),
        },
        follows=set(),
    )
    await _named(bridge, "C1", "payments", "payments-squad")
    # Already knows it: nothing to write.
    await _named(bridge, "C2", "launch", "launch-2026")
    assert bridge._room_service.recorded == [("room-1", "payments-squad")]


async def _room(
    session: AsyncSession, name: str, metadata: dict[str, Any] | None = None
) -> Room:
    return await RoomStore().create(
        session,
        Room(
            transport_room_id=f"!{name}:test",
            name=name,
            description="",
            metadata_={"created_by_kind": "user", **(metadata or {})},
        ),
    )


async def _follow(
    session: AsyncSession, room: Room, old: str, new: str, *, bridge: str = "Slack"
) -> bool:
    return await RoomStore().follow_channel_name(
        session,
        room.id,
        old_name=old,
        new_name=new,
        bridge_display_name=bridge,
        channel_name_for=SlackAdapter.channel_name_for,
    )


def _source(room: Room) -> tuple[str | None, str | None]:
    metadata = room.metadata_ or {}
    return metadata.get(NAME_SOURCE_KEY), metadata.get(LINKED_CHANNEL_NAME_KEY)


async def test_an_adopted_room_keeps_the_app_prefix(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        room = await _room(
            session,
            "Slack: payments",
            {NAME_SOURCE_KEY: "channel", LINKED_CHANNEL_NAME_KEY: "payments"},
        )
        assert await _follow(session, room, "payments", "payments-squad")
        assert room.name == "Slack: payments-squad"
        assert _source(room) == ("channel", "payments-squad")


async def test_a_room_created_in_switch_takes_the_channel_name_every_time(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        room = await _room(session, "Payments Team")
        await RoomStore().set_created_channel_name(session, room.id, "payments-team")
        assert _source(room) == ("created", "payments-team")
        assert await _follow(session, room, "payments-team", "payments-squad")
        assert room.name == "payments-squad"
        assert await _follow(session, room, "payments-squad", "payments-guild")
        assert room.name == "payments-guild"
        assert _source(room) == ("created", "payments-guild")


async def test_a_first_sighting_is_not_a_rename(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Discord reports every channel the first time it sees it, with both
    names the same; Telegram reports a chat's title the same way."""
    async with session_factory() as session:
        created = await _room(session, "Payments Team")
        await RoomStore().set_created_channel_name(session, created.id, "payments-team")
        assert not await _follow(session, created, "payments-team", "payments-team")
        assert created.name == "Payments Team"
        legacy = await _room(session, "launch")
        assert not await _follow(session, legacy, "launch", "launch")
        assert legacy.name == "launch"


async def test_a_name_seen_after_a_missed_rename_is_followed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Renamed while the bridge was down: the bridge only reports the name it
    now sees (both names the same, as Discord does, or no old name, as
    Telegram does on its first sighting)."""
    async with session_factory() as session:
        adopted = await _room(
            session,
            "Telegram: Ops",
            {NAME_SOURCE_KEY: "channel", LINKED_CHANNEL_NAME_KEY: "Ops"},
        )
        assert await _follow(session, adopted, "", "Ops 2026", bridge="Telegram")
        assert adopted.name == "Telegram: Ops 2026"
        created = await _room(session, "Payments Team")
        await RoomStore().set_created_channel_name(session, created.id, "payments-team")
        assert await _follow(session, created, "payments-squad", "payments-squad")
        assert created.name == "payments-squad"


async def test_a_rename_of_some_other_name_is_only_recorded(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A Teams team rename names the team's General channel by the team, but a
    room that knows that channel as "General" was not named after the team."""
    async with session_factory() as session:
        room = await _room(
            session,
            "Teams: General",
            {NAME_SOURCE_KEY: "channel", LINKED_CHANNEL_NAME_KEY: "General"},
        )
        assert not await _follow(
            session, room, "Contoso", "Contoso Ltd", bridge="Teams"
        )
        assert room.name == "Teams: General"
        named_after_team = await _room(
            session,
            "Teams: Contoso",
            {NAME_SOURCE_KEY: "channel", LINKED_CHANNEL_NAME_KEY: "Contoso"},
        )
        assert await _follow(
            session, named_after_team, "Contoso", "Contoso Ltd", bridge="Teams"
        )
        assert named_after_team.name == "Teams: Contoso Ltd"


async def test_a_room_named_in_switch_keeps_its_name(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        room = await _room(session, "Payments Team")
        await store.set_created_channel_name(session, room.id, "payments-team")
        # Saving the name it already has is not naming it.
        await store.update_fields(session, room.id, name="Payments Team")
        assert _source(room)[0] == "created"
        await store.update_fields(session, room.id, name="Payments – EU")
        assert _source(room)[0] == "custom"
        assert not await _follow(session, room, "payments-team", "payments-squad")
        assert room.name == "Payments – EU"


@pytest.mark.parametrize(
    ("name", "old", "new", "expected", "source"),
    [
        # Adopted before the source was kept, still exactly as adopted.
        ("Slack: launch", "launch", "launch-2026", "Slack: launch-2026", "channel"),
        # Created in Switch before the source was kept: the channel was made
        # from the room's name, so it still matches it.
        (
            "Payments Team",
            "payments-team",
            "payments-squad",
            "payments-squad",
            "created",
        ),
        # A platform that took the room's name as it was (Mattermost).
        (
            "Release Train",
            "Release Train",
            "Release Train 2026",
            "Release Train 2026",
            "created",
        ),
    ],
)
async def test_an_older_room_follows_while_it_still_matches(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    old: str,
    new: str,
    expected: str,
    source: str,
) -> None:
    async with session_factory() as session:
        room = await _room(session, name)
        assert await _follow(session, room, old, new)
        assert room.name == expected
        assert _source(room) == (source, new)


@pytest.mark.parametrize(
    ("name", "old"),
    [
        # Could be someone's title.
        ("Slack: qa-overnight-adopted", "qa-adopted-renamed"),
        ("Payments (old)", "payments-team"),
        # The platform did not say what the channel was called.
        ("Payments Team", ""),
    ],
)
async def test_an_older_room_that_no_longer_matches_keeps_its_name(
    session_factory: async_sessionmaker[AsyncSession], name: str, old: str
) -> None:
    async with session_factory() as session:
        room = await _room(session, name)
        assert not await _follow(session, room, old, "payments-squad")
        assert room.name == name
        assert _source(room) == (None, None)


async def test_taking_the_channel_name_back_follows_from_then_on(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        room = await _room(session, "Payments – EU", {NAME_SOURCE_KEY: "custom"})
        await store.record_channel_name(session, room.id, "payments-squad")
        await store.set_platform_name(
            session, room.id, "Slack: payments-squad", "payments-squad"
        )
        assert _source(room) == ("channel", "payments-squad")
        assert room.metadata_["created_by_kind"] == "user"
        assert await _follow(session, room, "payments-squad", "payments-guild")
        assert room.name == "Slack: payments-guild"


async def test_a_name_given_in_switch_while_the_rename_waits_wins(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as setup:
        room = await _room(setup, "Payments Team")
        await store.set_created_channel_name(setup, room.id, "payments-team")
        await setup.commit()
        room_id = room.id

    async with session_factory() as naming, session_factory() as renaming:
        # The Switch rename holds the row until it commits.
        await store.update_fields(naming, room_id, name="Payments – EU")
        bridge = asyncio.create_task(
            store.follow_channel_name(
                renaming,
                room_id,
                old_name="payments-team",
                new_name="payments-squad",
                bridge_display_name="Slack",
                channel_name_for=SlackAdapter.channel_name_for,
            )
        )
        await asyncio.sleep(0.2)
        assert not bridge.done()
        await naming.commit()
        assert not await bridge
        await renaming.commit()

    async with session_factory() as check:
        stored = await store.get(check, room_id)
        assert stored is not None
        assert stored.name == "Payments – EU"
        assert (stored.metadata_ or {})[NAME_SOURCE_KEY] == "custom"


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
