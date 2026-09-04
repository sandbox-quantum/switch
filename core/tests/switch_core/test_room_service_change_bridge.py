from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.models import ChannelCreationUnsupported
from switch_core.room_service import RoomService


class _FakeSessionCM:
    """Minimal async context manager standing in for a DB session.

    The store fakes ignore the session object entirely, so it only needs to
    support the ``async with`` protocol and ``commit``.
    """

    async def __aenter__(self) -> _FakeSessionCM:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def commit(self) -> None:
        return None


class _FakeRoomStore:
    def __init__(self, room: Any, agent_ids: list[str]) -> None:
        self._room = room
        self._agent_ids = agent_ids
        self.update_bridge_calls: list[dict[str, Any]] = []

    async def get(self, session: Any, room_id: str) -> Any:
        return self._room

    async def get_agent_ids(self, session: Any, room_id: str) -> list[str]:
        return list(self._agent_ids)

    async def update_bridge(
        self,
        session: Any,
        room_id: str,
        *,
        bridge_id: str,
        channel_type: str,
        external_channel_id: str | None,
    ) -> None:
        self.update_bridge_calls.append(
            {
                "room_id": room_id,
                "bridge_id": bridge_id,
                "channel_type": channel_type,
                "external_channel_id": external_channel_id,
            }
        )


class _FakeAgentStore:
    def __init__(self, names: dict[str, str]) -> None:
        self._names = names

    async def get(self, session: Any, agent_id: str) -> Any:
        return SimpleNamespace(id=agent_id, name=self._names[agent_id])


class _FakeAdapter:
    def __init__(self, events: list[Any], new_channel_id: str) -> None:
        self._events = events
        self._new_channel_id = new_channel_id

    async def create_channel(
        self, name: str, topic: str, *, channel_type: str = "channel_public"
    ) -> str:
        self._events.append(("create_channel", name, topic, channel_type))
        return self._new_channel_id

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        self._events.append(("add_agents", channel_id, list(agent_names)))

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        self._events.append(("ensure_capture", list(channels)))


class _FakeBridgeCore:
    def __init__(
        self,
        events: list[Any],
        *,
        matrix_user_id: str,
        new_channel_id: str = "",
    ) -> None:
        self._events = events
        self._bridge_client_matrix_user_id = matrix_user_id
        self.adapter = _FakeAdapter(events, new_channel_id)

    def add_room_mapping(
        self, room_id: str, matrix_room_id: str, external_channel_id: str
    ) -> None:
        self._events.append(("add_room_mapping", room_id, external_channel_id))

    def remove_room_mapping(self, room_id: str, matrix_room_id: str) -> None:
        self._events.append(("remove_room_mapping", room_id))

    def begin_provisioning(self, external_channel_id: str) -> None:
        self._events.append(("begin_provisioning", external_channel_id))

    def end_provisioning(self, external_channel_id: str) -> None:
        self._events.append(("end_provisioning", external_channel_id))


class _FakeLifecycle:
    def __init__(self, bridges: dict[str, Any]) -> None:
        self._bridges = bridges

    def get(self, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)


class _FakeMatrix:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    async def invite_to_room(self, matrix_room_id: str, matrix_user_id: str) -> None:
        self._events.append(("invite", matrix_user_id))

    async def kick_user(self, matrix_room_id: str, matrix_user_id: str) -> None:
        self._events.append(("kick", matrix_user_id))


class _FakeBridgeStore:
    """Whether an operator has left this connection able to create channels.

    Moving a room to a bridge provisions a channel on it, so the same switch
    that governs creating a room governs this."""

    def __init__(self, *, channel_creation_enabled: bool) -> None:
        self._enabled = channel_creation_enabled

    async def get(self, session: Any, bridge_id: str) -> Any:
        return SimpleNamespace(
            id=bridge_id,
            display_name=bridge_id,
            channel_creation_enabled=self._enabled,
        )


def _build_service(
    *,
    room: Any,
    agent_ids: list[str],
    agent_names: dict[str, str],
    bridges: dict[str, Any],
    events: list[Any],
    channel_creation_enabled: bool = True,
) -> tuple[RoomService, _FakeRoomStore]:
    room_store = _FakeRoomStore(room, agent_ids)
    svc = object.__new__(RoomService)
    svc._session_factory = lambda: _FakeSessionCM()  # type: ignore[assignment]
    svc._room_store = room_store  # type: ignore[assignment]
    svc._agent_store = _FakeAgentStore(agent_names)  # type: ignore[assignment]
    svc._collab_lifecycle = _FakeLifecycle(bridges)  # type: ignore[assignment]
    svc._matrix_admin = _FakeMatrix(events)  # type: ignore[assignment]
    svc._collab_bridge_store = _FakeBridgeStore(  # type: ignore[assignment]
        channel_creation_enabled=channel_creation_enabled
    )
    return svc, room_store


class TestChangeBridge:
    async def test_full_move_provisions_repopulates_and_detaches(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            name="Work",
            description="A room",
            matrix_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeBridgeCore(
            events, matrix_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        old_bridge = _FakeBridgeCore(events, matrix_user_id="@bot-old:switch.local")
        svc, room_store = _build_service(
            room=room,
            agent_ids=["a1", "a2"],
            agent_names={"a1": "agent.one", "a2": "agent.two"},
            bridges={"bridge-new": new_bridge, "bridge-old": old_bridge},
            events=events,
        )

        await svc.change_bridge(
            "room-1",
            bridge_id="bridge-new",
            channel_type="channel_private",
        )

        # New binding persisted with the requested channel type + new channel id.
        assert room_store.update_bridge_calls == [
            {
                "room_id": "room-1",
                "bridge_id": "bridge-new",
                "channel_type": "channel_private",
                "external_channel_id": "chan-new",
            }
        ]
        # Agents were re-added to the new channel; users are NOT carried over.
        assert ("add_agents", "chan-new", ["agent.one", "agent.two"]) in events
        assert not any(e[0] in ("add_users", "ensure_users") for e in events)
        # New bridge client joined; old one kicked; old mapping removed.
        assert ("invite", "@bot-new:switch.local") in events
        assert ("kick", "@bot-old:switch.local") in events
        assert ("remove_room_mapping", "room-1") in events
        assert ("add_room_mapping", "room-1", "chan-new") in events

        # Ordering invariants: the new channel exists and is mapped before the
        # old bridge is torn down.
        create_idx = events.index(
            ("create_channel", "Work", "A room", "channel_private")
        )
        map_idx = events.index(("add_room_mapping", "room-1", "chan-new"))
        remove_idx = events.index(("remove_room_mapping", "room-1"))
        assert create_idx < map_idx < remove_idx

    async def test_keeps_existing_privacy_when_channel_type_omitted(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            name="Secret",
            description="d",
            matrix_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_private",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeBridgeCore(
            events, matrix_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        old_bridge = _FakeBridgeCore(events, matrix_user_id="@bot-old:switch.local")
        svc, room_store = _build_service(
            room=room,
            agent_ids=[],
            agent_names={},
            bridges={"bridge-new": new_bridge, "bridge-old": old_bridge},
            events=events,
        )

        await svc.change_bridge("room-1", bridge_id="bridge-new")

        assert room_store.update_bridge_calls[0]["channel_type"] == "channel_private"
        assert ("create_channel", "Secret", "d", "channel_private") in events

    async def test_first_time_bridge_skips_teardown(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            name="Internal",
            description="d",
            matrix_room_id="!mx:switch.local",
            bridge_id=None,
            channel_type=None,
            external_channel_id=None,
        )
        new_bridge = _FakeBridgeCore(
            events, matrix_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        svc, _ = _build_service(
            room=room,
            agent_ids=["a1"],
            agent_names={"a1": "agent.one"},
            bridges={"bridge-new": new_bridge},
            events=events,
        )

        await svc.change_bridge("room-1", bridge_id="bridge-new")

        # No bridge to tear down -> no kick, no remove_room_mapping.
        assert not any(e[0] == "kick" for e in events)
        assert not any(e[0] == "remove_room_mapping" for e in events)
        # Defaulted to a public channel for the previously-internal room.
        assert ("create_channel", "Internal", "d", "channel_public") in events

    async def test_reuses_existing_channel_when_id_provided(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            name="Work",
            description="A room",
            matrix_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeBridgeCore(
            events, matrix_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        old_bridge = _FakeBridgeCore(events, matrix_user_id="@bot-old:switch.local")
        svc, room_store = _build_service(
            room=room,
            agent_ids=["a1"],
            agent_names={"a1": "agent.one"},
            bridges={"bridge-new": new_bridge, "bridge-old": old_bridge},
            events=events,
        )

        await svc.change_bridge(
            "room-1",
            bridge_id="bridge-new",
            external_channel_id="chan-reused",
        )

        # No new channel provisioned; the provided id is bound and mapped.
        assert not any(e[0] == "create_channel" for e in events)
        assert room_store.update_bridge_calls[0]["external_channel_id"] == "chan-reused"
        assert ("add_room_mapping", "room-1", "chan-reused") in events
        assert ("add_agents", "chan-reused", ["agent.one"]) in events
        # Provisioning a channel subscribes to it on the way past; binding one
        # that already exists has nothing to piggy-back on, so capture must be
        # established explicitly or the room only ever hears @mentions.
        assert ("ensure_capture", [("chan-reused", "channel_public")]) in events

    async def test_capture_is_established_for_a_freshly_created_channel(self) -> None:
        # Idempotent by design: the adapter skips a channel it is already
        # subscribed to, so asking again after provisioning costs nothing and
        # removes the need for either path to know what the other did.
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            name="Work",
            description="d",
            matrix_room_id="!mx:switch.local",
            bridge_id=None,
            channel_type=None,
            external_channel_id=None,
        )
        new_bridge = _FakeBridgeCore(
            events, matrix_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        svc, _ = _build_service(
            room=room,
            agent_ids=[],
            agent_names={},
            bridges={"bridge-new": new_bridge},
            events=events,
        )

        await svc.change_bridge("room-1", bridge_id="bridge-new")

        assert ("ensure_capture", [("chan-new", "channel_public")]) in events

    async def test_raises_when_target_bridge_not_running(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            name="Work",
            description="d",
            matrix_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        svc, _ = _build_service(
            room=room,
            agent_ids=[],
            agent_names={},
            bridges={},
            events=events,
        )

        with pytest.raises(ValueError, match="Bridge not running"):
            await svc.change_bridge("room-1", bridge_id="bridge-new")

    async def test_raises_when_already_on_target_bridge(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            name="Work",
            description="d",
            matrix_room_id="!mx:switch.local",
            bridge_id="bridge-x",
            channel_type="channel_public",
            external_channel_id="chan-x",
        )
        svc, _ = _build_service(
            room=room,
            agent_ids=[],
            agent_names={},
            bridges={"bridge-x": _FakeBridgeCore(events, matrix_user_id="@b:s")},
            events=events,
        )

        with pytest.raises(ValueError, match="already bound"):
            await svc.change_bridge("room-1", bridge_id="bridge-x")

    async def test_move_refused_when_the_target_may_not_create_channels(self) -> None:
        # Moving a room to a bridge provisions a channel on it, so a connection
        # an operator has withheld channel creation from must refuse here too —
        # before the old binding is touched, so a refused move changes nothing.
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            name="Work",
            description="d",
            matrix_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeBridgeCore(
            events, matrix_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        svc, room_store = _build_service(
            room=room,
            agent_ids=[],
            agent_names={},
            bridges={
                "bridge-new": new_bridge,
                "bridge-old": _FakeBridgeCore(events, matrix_user_id="@bot-old:s"),
            },
            events=events,
            channel_creation_enabled=False,
        )

        with pytest.raises(ChannelCreationUnsupported, match="turned off"):
            await svc.change_bridge("room-1", bridge_id="bridge-new")

        assert room_store.update_bridge_calls == []
        assert events == []


class TestLinkBridgeToRoom:
    """Binding a bridge to an existing internal room.

    The other way a room ends up pointing at a channel nobody subscribed to.
    """

    def _room(self) -> Any:
        return SimpleNamespace(
            id="room-1",
            name="Work",
            description="d",
            matrix_room_id="!mx:switch.local",
            bridge_id=None,
            channel_type=None,
            external_channel_id=None,
        )

    async def test_binding_an_existing_channel_establishes_capture(self) -> None:
        events: list[Any] = []
        bridge = _FakeBridgeCore(events, matrix_user_id="@bot:switch.local")
        svc, room_store = _build_service(
            room=self._room(),
            agent_ids=[],
            agent_names={},
            bridges={"bridge-1": bridge},
            events=events,
        )

        await svc.link_bridge_to_room(
            "room-1",
            "bridge-1",
            "channel_private",
            external_channel_id="chan-existing",
        )

        assert not any(e[0] == "create_channel" for e in events)
        assert room_store.update_bridge_calls[0]["external_channel_id"] == (
            "chan-existing"
        )
        assert ("ensure_capture", [("chan-existing", "channel_private")]) in events

    async def test_capture_follows_the_mapping(self) -> None:
        # Capture must not be established before the room↔channel mapping is
        # registered: a notification arriving in the gap has nowhere to land.
        events: list[Any] = []
        bridge = _FakeBridgeCore(events, matrix_user_id="@bot:switch.local")
        svc, _ = _build_service(
            room=self._room(),
            agent_ids=[],
            agent_names={},
            bridges={"bridge-1": bridge},
            events=events,
        )

        await svc.link_bridge_to_room(
            "room-1", "bridge-1", "channel_public", external_channel_id="chan-existing"
        )

        map_idx = events.index(("add_room_mapping", "room-1", "chan-existing"))
        capture_idx = events.index(
            ("ensure_capture", [("chan-existing", "channel_public")])
        )
        assert map_idx < capture_idx
