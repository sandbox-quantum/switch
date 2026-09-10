from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy.exc import IntegrityError

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundAppJoin

# CHOO-1660: creating a Slack-bridged room provisions a channel; the bot
# auto-joins it and fires an inbound app-join BEFORE create_room commits the
# room<->channel mapping. Without a guard, that join concluded "no room yet"
# and auto-created a SECOND room for the same channel. These tests pin the
# guard, the idempotent DB adoption, and the unique-constraint backstop.


def _make_bridge(**overrides: Any) -> BridgeCore:
    """A BridgeCore with only the attributes the auto-room-creation path
    touches, so the real methods run without the full dependency graph."""
    created_configs: list[Any] = []
    room = SimpleNamespace(
        id="room-uuid", tenant_id="tenant-1", matrix_room_id="!m:switch.local"
    )

    async def create_room(config: Any) -> SimpleNamespace:
        created_configs.append(config)
        return SimpleNamespace(room=room)

    class _Adapter:
        async def admin_message(self, *a: Any, **k: Any) -> str:
            return "C1:1.1"

    async def _resolve_agents_for_channel(
        channel_id: str, channel_type: str
    ) -> list[str]:
        return []

    async def _adopt_existing_room(channel_id: str) -> tuple[str, str] | None:
        return None

    bridge = BridgeCore.__new__(BridgeCore)
    bridge._provisioning_channels = set()
    bridge._channel_to_room = {}
    bridge._room_to_channel = {}
    bridge._room_tenants = {}
    bridge._channel_locks = {}
    bridge._bridge_id = "bridge-1"
    bridge._bridge_tenant_id = "tenant-1"
    bridge._bridge_display_name = "Switch"
    bridge._adapter = _Adapter()  # type: ignore[assignment]
    bridge._room_service = SimpleNamespace(create_room=create_room)  # type: ignore[assignment]
    # Instance attrs shadow the class methods so the DB is never touched.
    bridge._resolve_agents_for_channel = _resolve_agents_for_channel  # type: ignore[assignment]
    bridge._adopt_existing_room = _adopt_existing_room  # type: ignore[assignment]
    bridge._created_configs = created_configs  # type: ignore[attr-defined]
    for name, value in overrides.items():
        setattr(bridge, name, value)
    return bridge


async def test_begin_end_provisioning_tracks_channel() -> None:
    bridge = _make_bridge()
    bridge.begin_provisioning("C1")
    assert "C1" in bridge._provisioning_channels
    bridge.end_provisioning("C1")
    assert "C1" not in bridge._provisioning_channels
    # Idempotent — clearing an untracked channel is a no-op, not an error.
    bridge.end_provisioning("C1")


async def test_provisioning_channel_is_not_re_created() -> None:
    # The channel Switch is provisioning has no mapping yet: the handler must
    # NOT create a second room; it defers to the in-flight create_room.
    bridge = _make_bridge(_provisioning_channels={"C1"})

    result = await BridgeCore._create_room_for_channel(
        bridge,
        channel_id="C1",
        channel_type="channel_public",
        channel_name="general",
    )

    assert result is None
    assert bridge._created_configs == []


async def test_provisioning_channel_returns_existing_mapping() -> None:
    bridge = _make_bridge(
        _provisioning_channels={"C1"},
        _channel_to_room={"C1": ("room-x", "!x:switch.local")},
    )

    result = await BridgeCore._create_room_for_channel(
        bridge,
        channel_id="C1",
        channel_type="channel_public",
    )

    assert result == ("room-x", "!x:switch.local")
    assert bridge._created_configs == []


async def test_existing_db_room_is_adopted_not_recreated() -> None:
    async def _adopt(channel_id: str) -> tuple[str, str] | None:
        return ("adopted-room", "!adopted:switch.local")

    bridge = _make_bridge(_adopt_existing_room=_adopt)

    result = await BridgeCore._create_room_for_channel(
        bridge,
        channel_id="C1",
        channel_type="channel_public",
    )

    assert result == ("adopted-room", "!adopted:switch.local")
    # Adopted the existing room instead of creating a duplicate.
    assert bridge._created_configs == []


async def test_integrity_error_falls_back_to_existing_room() -> None:
    # Backstop: the unique index rejected a concurrent duplicate at commit.
    # The loser adopts the winner rather than surfacing the IntegrityError.
    calls = {"adopt": 0}

    async def _adopt(channel_id: str) -> tuple[str, str] | None:
        calls["adopt"] += 1
        # First call (top-of-method re-check) finds nothing; the row is
        # committed by the racing winner only by the time the except runs.
        return ("winner-room", "!winner:switch.local") if calls["adopt"] > 1 else None

    async def create_room(config: Any) -> SimpleNamespace:
        raise IntegrityError("INSERT INTO rooms", {}, Exception("duplicate key"))

    bridge = _make_bridge(
        _adopt_existing_room=_adopt,
        _room_service=SimpleNamespace(create_room=create_room),
    )

    result = await BridgeCore._create_room_for_channel(
        bridge,
        channel_id="C1",
        channel_type="channel_public",
    )

    assert result == ("winner-room", "!winner:switch.local")
    assert calls["adopt"] == 2


async def test_app_join_during_provisioning_creates_no_room() -> None:
    # End-to-end race path: the app-join handler fires while create_room is
    # still provisioning the channel. It must not spawn a duplicate room.
    bridge = _make_bridge(_provisioning_channels={"C1"})

    await BridgeCore._handle_app_joined_channel(
        bridge,
        InboundAppJoin(
            channel_id="C1",
            channel_type="channel_public",
            channel_name="general",
        ),
    )

    assert bridge._created_configs == []


async def test_adopt_existing_room_registers_mapping() -> None:
    # The real _adopt_existing_room: a DB hit registers the in-memory mapping
    # and returns the room, so subsequent lookups short-circuit.
    room = SimpleNamespace(
        id="db-room", tenant_id="tenant-1", matrix_room_id="!db:switch.local"
    )

    class _Session:
        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *a: Any) -> None:
            return None

    class _RoomStore:
        async def get_by_external_channel(
            self, session: Any, bridge_id: str, channel_id: str
        ) -> Any:
            return room if channel_id == "C1" else None

    bridge = BridgeCore.__new__(BridgeCore)
    bridge._channel_to_room = {}
    bridge._room_to_channel = {}
    bridge._room_tenants = {}
    bridge._bridge_id = "bridge-1"
    bridge._bridge_tenant_id = "tenant-1"
    bridge._session_factory = _Session  # type: ignore[assignment]
    bridge._room_store = _RoomStore()  # type: ignore[assignment]

    result = await bridge._adopt_existing_room("C1")

    assert result == ("db-room", "!db:switch.local")
    assert bridge._channel_to_room["C1"] == ("db-room", "!db:switch.local")

    # No room for an unmapped channel.
    assert await bridge._adopt_existing_room("C2") is None
