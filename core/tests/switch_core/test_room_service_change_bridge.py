from __future__ import annotations

from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.exc import IntegrityError

from switch_core.bridges.collaboration.adapter import ChannelNotBindable
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelInUse,
    ChannelNotUsable,
    CreatedChannel,
)
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
        self.created_channel_names: list[tuple[str, str]] = []
        # Channel id → the id of the room already bound to it.
        self.bound: dict[str, str] = {}
        # Raised by `update_bridge`, standing in for the database refusing it.
        self.update_bridge_error: Exception | None = None

    async def get(self, session: Any, room_id: str) -> Any:
        return self._room

    async def get_by_external_channel(
        self, session: Any, bridge_id: str, external_channel_id: str
    ) -> Any:
        room_id = self.bound.get(external_channel_id)
        return None if room_id is None else SimpleNamespace(id=room_id)

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
        if self.update_bridge_error is not None:
            raise self.update_bridge_error
        self.update_bridge_calls.append(
            {
                "room_id": room_id,
                "bridge_id": bridge_id,
                "channel_type": channel_type,
                "external_channel_id": external_channel_id,
            }
        )

    async def set_created_channel_name(
        self, session: Any, room_id: str, channel_name: str
    ) -> None:
        self.created_channel_names.append((room_id, channel_name))


class _FakeAgentStore:
    def __init__(self, names: dict[str, str]) -> None:
        self._names = names

    async def get(self, session: Any, agent_id: str) -> Any:
        return SimpleNamespace(id=agent_id, name=self._names[agent_id])


class _FakeAdapter:
    platform_name = "Fakechat"
    private_channel_needs_owner = False
    adds_creator_to_public_channel = True

    def __init__(self, events: list[Any], new_channel_id: str) -> None:
        self._events = events
        self._new_channel_id = new_channel_id
        self.not_bindable: set[str] = set()
        self.not_usable: dict[str, str] = {}
        self.owners_refused: set[str] = set()
        # Platform ids `add_users_to_channel` reports as not added.
        self.add_refused: set[str] = set()

    async def require_bindable_channel(self, channel_id: str) -> None:
        self._events.append(("require_bindable", channel_id))
        if channel_id in self.not_bindable:
            raise ChannelNotBindable(f"{channel_id} is not this bridge's")

    async def check_channel_usable(self, channel_id: str) -> None:
        self._events.append(("check_usable", channel_id))
        if channel_id in self.not_usable:
            raise ChannelNotUsable(self.not_usable[channel_id])

    def can_own_channel(self, external_user_id: str) -> bool:
        return external_user_id not in self.owners_refused

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: str = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        if owner_external_id is None:
            self._events.append(("create_channel", name, topic, channel_type))
        else:
            self._events.append(
                ("create_channel", name, topic, channel_type, owner_external_id)
            )
        return CreatedChannel(id=self._new_channel_id, name=name)

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        self._events.append(("add_agents", channel_id, list(agent_names)))

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        self._events.append(("add_users", channel_id, list(user_external_ids)))
        return [i for i in user_external_ids if i in self.add_refused]

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        self._events.append(("ensure_capture", list(channels)))


class _FakeCollaborationCore:
    def __init__(
        self,
        events: list[Any],
        *,
        transport_user_id: str,
        new_channel_id: str = "",
    ) -> None:
        self._events = events
        self._workspace_consumer_transport_user_id = transport_user_id
        self.adapter = _FakeAdapter(events, new_channel_id)

    def add_room_mapping(
        self,
        room_id: str,
        transport_room_id: str,
        external_channel_id: str,
        tenant_id: str,
    ) -> None:
        self._events.append(("add_room_mapping", room_id, external_channel_id))

    def remove_room_mapping(self, room_id: str, transport_room_id: str) -> None:
        self._events.append(("remove_room_mapping", room_id))

    def begin_provisioning(self, external_channel_id: str) -> None:
        self._events.append(("begin_provisioning", external_channel_id))

    async def ensure_external_users_in_room(
        self, room_id: str, transport_room_id: str, external_user_ids: list[str]
    ) -> None:
        self._events.append(("ensure_in_room", room_id, list(external_user_ids)))

    def end_provisioning(self, external_channel_id: str) -> None:
        self._events.append(("end_provisioning", external_channel_id))


class _FakeLifecycle:
    def __init__(self, bridges: dict[str, Any]) -> None:
        self._bridges = bridges
        # Bridges whose rooms changed, announced for the other processes.
        self.rooms_changed_for: list[str] = []
        # What the target connection still lacks before it can make a channel.
        self.channel_creation_blocked_by: str | None = None

    def get(self, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)

    def channel_creation_blocker(
        self, bridge_type: str, connection_config: Any
    ) -> str | None:
        return self.channel_creation_blocked_by

    def rooms_changed(self, bridge_id: str) -> None:
        self.rooms_changed_for.append(bridge_id)


class _FakeProvisioning:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    async def record_join(
        self, session: object, room_id: str, user_id: str
    ) -> Callable[[], None]:
        raise NotImplementedError

    async def invite_to_room(
        self, transport_room_id: str, transport_user_id: str
    ) -> None:
        self._events.append(("invite", transport_user_id))

    async def kick_user(
        self, transport_room_id: str, transport_user_id: str, **_kwargs: object
    ) -> None:
        self._events.append(("kick", transport_user_id))


class _FakeBridgeStore:
    """Whether an operator has left this connection able to create channels.

    Moving a room to a bridge provisions a channel on it, so the same switch
    that governs creating a room governs this."""

    def __init__(self, *, channel_creation_enabled: bool) -> None:
        self._enabled = channel_creation_enabled

    async def get(self, session: Any, bridge_id: str) -> Any:
        return SimpleNamespace(
            id=bridge_id,
            type="fake",
            display_name=bridge_id,
            channel_creation_enabled=self._enabled,
            connection_config={},
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
    svc._provisioning = _FakeProvisioning(events)  # type: ignore[assignment]
    svc._collab_bridge_store = _FakeBridgeStore(  # type: ignore[assignment]
        channel_creation_enabled=channel_creation_enabled
    )
    return svc, room_store


async def _no_check(*_: Any) -> None:
    return None


def _owner_linked(svc: RoomService) -> None:
    """The room's owner has a confirmed account on the new bridge, which a new
    private channel there needs."""

    async def owner(*_: Any) -> Any:
        return SimpleNamespace(
            external_user_id="owner-account", external_username="ada"
        )

    svc._private_channel_creator = owner  # type: ignore[method-assign]


def _owner_account(svc: RoomService, *, linked: bool = True) -> None:
    """Whether the room's owner has a confirmed account on the new bridge, to
    be put in a new public channel there."""

    async def accounts(*_: Any) -> list[Any]:
        if not linked:
            return []
        return [
            SimpleNamespace(external_user_id="owner-account", external_username="ada")
        ]

    svc._confirmed_accounts = accounts  # type: ignore[method-assign]


class TestChangeBridge:
    async def test_full_move_provisions_repopulates_and_detaches(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Work",
            description="A room",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        old_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-old:switch.local"
        )
        svc, room_store = _build_service(
            room=room,
            agent_ids=["a1", "a2"],
            agent_names={"a1": "agent.one", "a2": "agent.two"},
            bridges={"bridge-new": new_bridge, "bridge-old": old_bridge},
            events=events,
        )

        _owner_linked(svc)

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
        # The channel made for the room is the one the room now follows.
        assert room_store.created_channel_names == [("room-1", "Work")]
        # Agents were re-added to the new channel; of the people, only the
        # owner is carried over, so the new private channel has someone in it.
        assert ("add_agents", "chan-new", ["agent.one", "agent.two"]) in events
        assert [e for e in events if e[0] == "add_users"] == [
            ("add_users", "chan-new", ["owner-account"])
        ]
        # New bridge client joined; old one kicked; old mapping removed.
        assert ("invite", "@bot-new:switch.local") in events
        assert ("kick", "@bot-old:switch.local") in events
        assert ("remove_room_mapping", "room-1") in events
        assert ("add_room_mapping", "room-1", "chan-new") in events
        # Both bridges' rooms changed, for every other process to map again.
        assert svc._collab_lifecycle.rooms_changed_for == [  # type: ignore[attr-defined]
            "bridge-new",
            "bridge-old",
        ]

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
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Secret",
            description="d",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_private",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        old_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-old:switch.local"
        )
        svc, room_store = _build_service(
            room=room,
            agent_ids=[],
            agent_names={},
            bridges={"bridge-new": new_bridge, "bridge-old": old_bridge},
            events=events,
        )

        _owner_linked(svc)

        await svc.change_bridge("room-1", bridge_id="bridge-new")

        assert room_store.update_bridge_calls[0]["channel_type"] == "channel_private"
        assert ("create_channel", "Secret", "d", "channel_private") in events

    async def test_first_time_bridge_skips_teardown(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Internal",
            description="d",
            transport_room_id="!mx:switch.local",
            bridge_id=None,
            channel_type=None,
            external_channel_id=None,
        )
        new_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-new:switch.local", new_channel_id="chan-new"
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
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Work",
            description="A room",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        old_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-old:switch.local"
        )
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

        # No new channel provisioned; the provided id is vouched for, then
        # bound and mapped.
        assert not any(e[0] == "create_channel" for e in events)
        assert events[0] == ("require_bindable", "chan-reused")
        assert room_store.update_bridge_calls[0]["external_channel_id"] == "chan-reused"
        assert ("add_room_mapping", "room-1", "chan-reused") in events
        assert ("add_agents", "chan-reused", ["agent.one"]) in events
        # Provisioning a channel subscribes to it on the way past; binding one
        # that already exists has nothing to piggy-back on, so capture must be
        # established explicitly or the room only ever hears @mentions.
        assert ("ensure_capture", [("chan-reused", "channel_public")]) in events

    async def test_a_channel_the_bridge_refuses_is_not_bound(self) -> None:
        """The id is the caller's, and binding decides where the room's
        messages are posted: a bridge on a shared connection can see other
        organisations' channels, so it is asked first and nothing moves."""
        events: list[Any] = []
        room = SimpleNamespace(
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Work",
            description="A room",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-new:switch.local"
        )
        new_bridge.adapter.not_bindable.add("chan-elsewhere")
        old_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-old:switch.local"
        )
        svc, room_store = _build_service(
            room=room,
            agent_ids=["a1"],
            agent_names={"a1": "agent.one"},
            bridges={"bridge-new": new_bridge, "bridge-old": old_bridge},
            events=events,
        )

        with pytest.raises(ChannelNotBindable):
            await svc.change_bridge(
                "room-1",
                bridge_id="bridge-new",
                external_channel_id="chan-elsewhere",
            )

        assert events == [("require_bindable", "chan-elsewhere")]
        assert room_store.update_bridge_calls == []

    @staticmethod
    def _moving(events: list[Any]) -> tuple[RoomService, _FakeRoomStore, Any]:
        room = SimpleNamespace(
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Work",
            description="A room",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-new:switch.local"
        )
        old_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-old:switch.local"
        )
        svc, room_store = _build_service(
            room=room,
            agent_ids=["a1"],
            agent_names={"a1": "agent.one"},
            bridges={"bridge-new": new_bridge, "bridge-old": old_bridge},
            events=events,
        )
        return svc, room_store, new_bridge

    async def test_a_channel_another_room_uses_is_a_conflict(self) -> None:
        events: list[Any] = []
        svc, room_store, _ = self._moving(events)
        room_store.bound["chan-taken"] = "room-2"

        with pytest.raises(ChannelInUse, match="already used by a room"):
            await svc.change_bridge(
                "room-1", bridge_id="bridge-new", external_channel_id="chan-taken"
            )

        # Asked whose it is first; the platform is not asked about it.
        assert events == [("require_bindable", "chan-taken")]
        assert room_store.update_bridge_calls == []

    async def test_another_bridges_channel_is_refused_before_saying_it_is_used(
        self,
    ) -> None:
        """On a connection shared between organisations, "already used by a
        room" would tell the caller that another organisation's channel is
        bound. Whose it is is asked first."""
        events: list[Any] = []
        svc, room_store, new_bridge = self._moving(events)
        new_bridge.adapter.not_bindable.add("chan-theirs")
        room_store.bound["chan-theirs"] = "their-room"

        with pytest.raises(ChannelNotBindable):
            await svc.change_bridge(
                "room-1", bridge_id="bridge-new", external_channel_id="chan-theirs"
            )

    async def test_a_channel_this_room_already_uses_is_not_a_conflict(self) -> None:
        events: list[Any] = []
        svc, room_store, _ = self._moving(events)
        room_store.bound["chan-mine"] = "room-1"

        await svc.change_bridge(
            "room-1", bridge_id="bridge-new", external_channel_id="chan-mine"
        )

        assert room_store.update_bridge_calls[0]["external_channel_id"] == "chan-mine"

    async def test_the_platforms_reason_is_given_for_a_channel_it_cannot_use(
        self,
    ) -> None:
        events: list[Any] = []
        svc, room_store, new_bridge = self._moving(events)
        new_bridge.adapter.not_usable["chan-gone"] = "Discord cannot find it."

        with pytest.raises(ChannelNotUsable, match="Discord cannot find it"):
            await svc.change_bridge(
                "room-1", bridge_id="bridge-new", external_channel_id="chan-gone"
            )

        assert events == [
            ("require_bindable", "chan-gone"),
            ("check_usable", "chan-gone"),
        ]
        assert room_store.update_bridge_calls == []

    async def test_losing_a_race_for_the_channel_is_a_conflict(self) -> None:
        events: list[Any] = []
        svc, room_store, _ = self._moving(events)
        room_store.update_bridge_error = IntegrityError(
            "UPDATE rooms",
            {},
            Exception(
                "duplicate key value violates unique constraint "
                '"uq_rooms_bridge_external_channel"'
            ),
        )

        with pytest.raises(ChannelInUse):
            await svc.change_bridge(
                "room-1", bridge_id="bridge-new", external_channel_id="chan-raced"
            )

    async def test_another_database_refusal_is_not_called_a_conflict(self) -> None:
        events: list[Any] = []
        svc, room_store, _ = self._moving(events)
        room_store.update_bridge_error = IntegrityError(
            "UPDATE rooms", {}, Exception("violates foreign key constraint")
        )

        with pytest.raises(IntegrityError):
            await svc.change_bridge(
                "room-1", bridge_id="bridge-new", external_channel_id="chan-x"
            )

    async def test_a_new_private_channel_is_made_with_the_owner_it_needs(
        self,
    ) -> None:
        events: list[Any] = []
        svc, _, new_bridge = self._moving(events)
        new_bridge.adapter.private_channel_needs_owner = True
        _owner_linked(svc)

        await svc.change_bridge(
            "room-1", bridge_id="bridge-new", channel_type="channel_private"
        )

        assert (
            "create_channel",
            "Work",
            "A room",
            "channel_private",
            "owner-account",
        ) in (events)
        # Made its owner, so in it already: not asked to add them again.
        assert not any(e[0] == "add_users" for e in events)
        assert ("ensure_in_room", "room-1", ["owner-account"]) in events

    async def test_the_owner_is_put_in_a_new_private_channel_elsewhere(
        self,
    ) -> None:
        # The one person a move carries over: without them a new private
        # channel would be one nobody can get into.
        events: list[Any] = []
        svc, _, new_bridge = self._moving(events)
        new_bridge.adapter._new_channel_id = "chan-new"
        _owner_linked(svc)

        await svc.change_bridge(
            "room-1", bridge_id="bridge-new", channel_type="channel_private"
        )

        assert ("create_channel", "Work", "A room", "channel_private") in events
        assert ("add_users", "chan-new", ["owner-account"]) in events
        assert ("ensure_in_room", "room-1", ["owner-account"]) in events

    async def test_a_move_says_so_when_the_platform_will_not_add_the_owner(
        self,
    ) -> None:
        # The move is finished first, old bridge let go included, so the
        # room is not left on two bridges; then it is reported.
        events: list[Any] = []
        svc, room_store, new_bridge = self._moving(events)
        new_bridge.adapter._new_channel_id = "chan-new"
        new_bridge.adapter.add_refused.add("owner-account")
        _owner_linked(svc)

        with pytest.raises(BridgeOperationError, match="would not add its owner"):
            await svc.change_bridge(
                "room-1", bridge_id="bridge-new", channel_type="channel_private"
            )

        assert room_store.update_bridge_calls[0]["external_channel_id"] == "chan-new"
        assert ("remove_room_mapping", "room-1") in events
        assert ("kick", "@bot-old:switch.local") in events

    async def test_linking_says_so_when_the_platform_will_not_add_the_owner(
        self,
    ) -> None:
        events: list[Any] = []
        svc, _, new_bridge = self._moving(events)
        new_bridge.adapter._new_channel_id = "chan-new"
        new_bridge.adapter.add_refused.add("owner-account")
        _owner_linked(svc)
        svc._require_tenant_bridge = _no_check  # type: ignore[method-assign]

        with pytest.raises(BridgeOperationError, match="would not add its owner"):
            await svc.link_bridge_to_room("room-1", "bridge-new", "channel_private")

    async def test_the_owner_is_put_in_a_private_channel_given_to_a_room(
        self,
    ) -> None:
        events: list[Any] = []
        svc, _, new_bridge = self._moving(events)
        new_bridge.adapter._new_channel_id = "chan-new"
        _owner_linked(svc)
        svc._require_tenant_bridge = _no_check  # type: ignore[method-assign]

        await svc.link_bridge_to_room("room-1", "bridge-new", "channel_private")

        assert ("add_users", "chan-new", ["owner-account"]) in events
        assert ("ensure_in_room", "room-1", ["owner-account"]) in events

    async def test_the_owner_is_put_in_a_new_public_channel_on_a_move(
        self,
    ) -> None:
        events: list[Any] = []
        svc, _, new_bridge = self._moving(events)
        new_bridge.adapter._new_channel_id = "chan-new"
        _owner_account(svc)

        await svc.change_bridge(
            "room-1", bridge_id="bridge-new", channel_type="channel_public"
        )

        assert ("create_channel", "Work", "A room", "channel_public") in events
        assert ("add_users", "chan-new", ["owner-account"]) in events
        assert ("ensure_in_room", "room-1", ["owner-account"]) in events

    async def test_a_move_to_a_public_channel_goes_ahead_without_a_link(
        self,
    ) -> None:
        events: list[Any] = []
        svc, room_store, new_bridge = self._moving(events)
        new_bridge.adapter._new_channel_id = "chan-new"
        _owner_account(svc, linked=False)

        await svc.change_bridge(
            "room-1", bridge_id="bridge-new", channel_type="channel_public"
        )

        assert room_store.update_bridge_calls[0]["external_channel_id"] == "chan-new"
        assert not any(e[0] in ("add_users", "ensure_in_room") for e in events)

    async def test_a_public_move_is_not_failed_when_the_owner_is_refused(
        self,
    ) -> None:
        # They can join a public channel themselves.
        events: list[Any] = []
        svc, room_store, new_bridge = self._moving(events)
        new_bridge.adapter._new_channel_id = "chan-new"
        new_bridge.adapter.add_refused.add("owner-account")
        _owner_account(svc)

        await svc.change_bridge(
            "room-1", bridge_id="bridge-new", channel_type="channel_public"
        )

        assert room_store.update_bridge_calls[0]["external_channel_id"] == "chan-new"
        assert ("remove_room_mapping", "room-1") in events

    async def test_the_owner_is_put_in_a_public_channel_given_to_a_room(
        self,
    ) -> None:
        events: list[Any] = []
        svc, _, new_bridge = self._moving(events)
        new_bridge.adapter._new_channel_id = "chan-new"
        _owner_account(svc)
        svc._require_tenant_bridge = _no_check  # type: ignore[method-assign]

        await svc.link_bridge_to_room("room-1", "bridge-new", "channel_public")

        assert ("add_users", "chan-new", ["owner-account"]) in events
        assert ("ensure_in_room", "room-1", ["owner-account"]) in events

    async def test_linking_a_public_channel_is_not_failed_when_the_owner_is_refused(
        self,
    ) -> None:
        events: list[Any] = []
        svc, _, new_bridge = self._moving(events)
        new_bridge.adapter._new_channel_id = "chan-new"
        new_bridge.adapter.add_refused.add("owner-account")
        _owner_account(svc)
        svc._require_tenant_bridge = _no_check  # type: ignore[method-assign]

        await svc.link_bridge_to_room("room-1", "bridge-new", "channel_public")

        assert ("add_users", "chan-new", ["owner-account"]) in events

    async def test_capture_is_established_for_a_freshly_created_channel(self) -> None:
        # Idempotent by design: the adapter skips a channel it is already
        # subscribed to, so asking again after provisioning costs nothing and
        # removes the need for either path to know what the other did.
        events: list[Any] = []
        room = SimpleNamespace(
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Work",
            description="d",
            transport_room_id="!mx:switch.local",
            bridge_id=None,
            channel_type=None,
            external_channel_id=None,
        )
        new_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-new:switch.local", new_channel_id="chan-new"
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
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Work",
            description="d",
            transport_room_id="!mx:switch.local",
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
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Work",
            description="d",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-x",
            channel_type="channel_public",
            external_channel_id="chan-x",
        )
        svc, _ = _build_service(
            room=room,
            agent_ids=[],
            agent_names={},
            bridges={
                "bridge-x": _FakeCollaborationCore(events, transport_user_id="@b:s")
            },
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
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Work",
            description="d",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        new_bridge = _FakeCollaborationCore(
            events, transport_user_id="@bot-new:switch.local", new_channel_id="chan-new"
        )
        svc, room_store = _build_service(
            room=room,
            agent_ids=[],
            agent_names={},
            bridges={
                "bridge-new": new_bridge,
                "bridge-old": _FakeCollaborationCore(
                    events, transport_user_id="@bot-old:s"
                ),
            },
            events=events,
            channel_creation_enabled=False,
        )

        with pytest.raises(ChannelCreationUnsupported, match="turned off"):
            await svc.change_bridge("room-1", bridge_id="bridge-new")

        assert room_store.update_bridge_calls == []
        assert events == []

    async def test_move_refused_when_the_target_lacks_what_a_channel_needs(
        self,
    ) -> None:
        # A Teams connection with no default team does not know which team to
        # make the channel in: refused, saying so, before anything is touched.
        events: list[Any] = []
        room = SimpleNamespace(
            owner_id=None,
            id="room-1",
            tenant_id="room-tenant",
            name="Work",
            description="d",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-old",
            channel_type="channel_public",
            external_channel_id="chan-old",
        )
        svc, room_store = _build_service(
            room=room,
            agent_ids=[],
            agent_names={},
            bridges={
                "bridge-new": _FakeCollaborationCore(
                    events,
                    transport_user_id="@bot-new:switch.local",
                    new_channel_id="chan-new",
                ),
                "bridge-old": _FakeCollaborationCore(
                    events, transport_user_id="@bot-old:s"
                ),
            },
            events=events,
        )
        svc._collab_lifecycle.channel_creation_blocked_by = "No default team is set"  # type: ignore[attr-defined]

        with pytest.raises(ChannelCreationUnsupported, match="No default team"):
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
            tenant_id="room-tenant",
            name="Work",
            description="d",
            transport_room_id="!mx:switch.local",
            bridge_id=None,
            channel_type=None,
            external_channel_id=None,
        )

    async def test_binding_an_existing_channel_establishes_capture(self) -> None:
        events: list[Any] = []
        bridge = _FakeCollaborationCore(events, transport_user_id="@bot:switch.local")
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
        bridge = _FakeCollaborationCore(events, transport_user_id="@bot:switch.local")
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
