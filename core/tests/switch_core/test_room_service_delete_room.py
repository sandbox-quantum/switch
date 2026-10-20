from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.models import RetireOutcome
from switch_core.room_service import RoomService


class _FakeSessionCM:
    async def __aenter__(self) -> _FakeSessionCM:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def commit(self) -> None:
        return None


class _FakeRoomStore:
    def __init__(self, room: Any, client_ids: list[str]) -> None:
        self._room = room
        self._client_ids = client_ids
        self.deleted: list[str] = []

    async def get(self, session: Any, room_id: str) -> Any:
        return self._room

    async def get_client_ids(self, session: Any, room_id: str) -> list[str]:
        return list(self._client_ids)

    async def delete(self, session: Any, room_id: str) -> None:
        self.deleted.append(room_id)


class _FakeAdapter:
    def __init__(self, events: list[Any], outcome: RetireOutcome | Exception) -> None:
        self._events = events
        self._outcome = outcome

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        self._events.append(("retire", external_channel_id))
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


class _FakeCollaborationCore:
    def __init__(
        self,
        events: list[Any],
        outcome: RetireOutcome | Exception = RetireOutcome(outcome="archived"),
    ) -> None:
        self._events = events
        self.adapter = _FakeAdapter(events, outcome)

    def remove_room_mapping(self, room_id: str, transport_room_id: str) -> None:
        self._events.append(("remove_room_mapping", room_id, transport_room_id))


class _FakeLifecycle:
    def __init__(self, bridges: dict[str, Any]) -> None:
        self._bridges = bridges
        # Bridges whose rooms changed, announced for the other processes.
        self.rooms_changed_for: list[str] = []

    def get(self, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)

    def rooms_changed(self, bridge_id: str) -> None:
        self.rooms_changed_for.append(bridge_id)


class _FakeClientLifecycle:
    def __init__(self, clients: dict[str, Any]) -> None:
        self._clients = clients

    def get(self, client_id: str) -> Any:
        return self._clients.get(client_id)


class _FakeProvisioning:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    async def kick_user(self, transport_room_id: str, transport_user_id: str) -> None:
        self._events.append(("kick", transport_user_id))

    async def delete_room(self, transport_room_id: str) -> None:
        self._events.append(("delete_room", transport_room_id))


class _FakeRoomCache:
    def __init__(self) -> None:
        self.invalidated: list[tuple[str, str]] = []

    def invalidate(self, tenant_id: str, room_id: str) -> None:
        self.invalidated.append((tenant_id, room_id))


def _build_service(
    *,
    room: Any,
    client_ids: list[str],
    clients: dict[str, Any],
    bridges: dict[str, Any],
    events: list[Any],
) -> tuple[RoomService, _FakeRoomStore]:
    room_store = _FakeRoomStore(room, client_ids)
    svc = object.__new__(RoomService)
    svc._session_factory = lambda: _FakeSessionCM()  # type: ignore[assignment]
    svc._room_store = room_store  # type: ignore[assignment]
    svc._collab_lifecycle = _FakeLifecycle(bridges)  # type: ignore[assignment]
    svc._client_lifecycle = _FakeClientLifecycle(clients)  # type: ignore[assignment]
    svc._provisioning = _FakeProvisioning(events)  # type: ignore[assignment]
    svc._room_cache = _FakeRoomCache()  # type: ignore[assignment]
    return svc, room_store


class TestDeleteRoom:
    async def test_evicts_bridged_room_from_collaboration_core(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-x",
            external_channel_id="chan-x",
            channel_type="channel_private",
        )
        bridge = _FakeCollaborationCore(events)
        svc, room_store = _build_service(
            room=room,
            client_ids=[],
            clients={},
            bridges={"bridge-x": bridge},
            events=events,
        )

        await svc.delete_room("room-1", retire_channel=True)

        assert room_store.deleted == ["room-1"]
        assert ("delete_room", "!mx:switch.local") in events
        assert ("remove_room_mapping", "room-1", "!mx:switch.local") in events
        # And every other process unmaps it too.
        assert svc._collab_lifecycle.rooms_changed_for == ["bridge-x"]  # type: ignore[attr-defined]

    async def test_non_bridged_room_does_not_touch_collaboration_core(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            transport_room_id="!mx:switch.local",
            bridge_id=None,
            external_channel_id=None,
        )
        svc, room_store = _build_service(
            room=room,
            client_ids=[],
            clients={},
            bridges={},
            events=events,
        )

        await svc.delete_room("room-1", retire_channel=True)

        assert room_store.deleted == ["room-1"]
        assert not any(e[0] == "remove_room_mapping" for e in events)

    async def test_missing_collaboration_core_is_tolerated(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            transport_room_id="!mx:switch.local",
            bridge_id="bridge-gone",
            external_channel_id="chan-x",
            channel_type="channel_private",
        )
        svc, room_store = _build_service(
            room=room,
            client_ids=[],
            clients={},
            bridges={},
            events=events,
        )

        await svc.delete_room("room-1", retire_channel=True)

        assert room_store.deleted == ["room-1"]
        assert not any(e[0] == "remove_room_mapping" for e in events)

    async def test_kicks_clients_before_deleting(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            transport_room_id="!mx:switch.local",
            bridge_id=None,
            external_channel_id=None,
        )
        clients = {
            "c1": SimpleNamespace(transport_user_id="@a:switch.local"),
            "c2": SimpleNamespace(transport_user_id="@b:switch.local"),
        }
        svc, _ = _build_service(
            room=room,
            client_ids=["c1", "c2"],
            clients=clients,
            bridges={},
            events=events,
        )

        await svc.delete_room("room-1", retire_channel=True)

        kick_idx = max(i for i, e in enumerate(events) if e[0] == "kick")
        delete_idx = events.index(("delete_room", "!mx:switch.local"))
        assert ("kick", "@a:switch.local") in events
        assert ("kick", "@b:switch.local") in events
        assert kick_idx < delete_idx

    async def test_raises_when_room_missing(self) -> None:
        events: list[Any] = []
        svc, _ = _build_service(
            room=None,
            client_ids=[],
            clients={},
            bridges={},
            events=events,
        )

        with pytest.raises(ValueError, match="Room not found"):
            await svc.delete_room("nope", retire_channel=True)

    async def test_drops_the_rooms_shared_delivery_reads(self) -> None:
        """Members still running here are kicked, which empties the room's
        cache entry; this is the call that covers any that were not."""
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            transport_room_id="!mx:switch.local",
            bridge_id=None,
            external_channel_id=None,
        )
        svc, room_store = _build_service(
            room=room, client_ids=[], clients={}, bridges={}, events=events
        )

        await svc.delete_room("room-1", retire_channel=True)

        assert room_store.deleted == ["room-1"]
        assert svc._room_cache.invalidated == [("room-tenant", "room-1")]  # type: ignore[attr-defined]


def _bridged_room(channel_type: str = "channel_private") -> SimpleNamespace:
    return SimpleNamespace(
        id="room-1",
        tenant_id="room-tenant",
        transport_room_id="!mx:switch.local",
        bridge_id="bridge-x",
        external_channel_id="chan-x",
        channel_type=channel_type,
    )


class TestDeleteRoomRetiresChannel:
    async def test_archives_the_channel_between_kicks_and_unmapping(self) -> None:
        events: list[Any] = []
        svc, room_store = _build_service(
            room=_bridged_room(),
            client_ids=["c1"],
            clients={"c1": SimpleNamespace(transport_user_id="@a:switch.local")},
            bridges={"bridge-x": _FakeCollaborationCore(events)},
            events=events,
        )

        channel = await svc.delete_room("room-1", retire_channel=True)

        assert channel == RetireOutcome(outcome="archived")
        assert room_store.deleted == ["room-1"]
        kinds = [e[0] for e in events]
        assert kinds.index("kick") < kinds.index("retire")
        assert kinds.index("retire") < kinds.index("remove_room_mapping")
        assert ("retire", "chan-x") in events

    async def test_a_refused_retire_still_deletes_the_room(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        events: list[Any] = []
        refused = RetireOutcome.failed("not_in_channel")
        svc, room_store = _build_service(
            room=_bridged_room(),
            client_ids=[],
            clients={},
            bridges={"bridge-x": _FakeCollaborationCore(events, refused)},
            events=events,
        )

        with caplog.at_level("WARNING"):
            channel = await svc.delete_room("room-1", retire_channel=True)

        assert channel == refused
        assert room_store.deleted == ["room-1"]
        assert ("remove_room_mapping", "room-1", "!mx:switch.local") in events
        assert "not retired: not_in_channel" in caplog.text

    async def test_a_raising_adapter_is_reported_as_failed(self) -> None:
        events: list[Any] = []
        svc, room_store = _build_service(
            room=_bridged_room(),
            client_ids=[],
            clients={},
            bridges={"bridge-x": _FakeCollaborationCore(events, RuntimeError("boom"))},
            events=events,
        )

        channel = await svc.delete_room("room-1", retire_channel=True)

        assert channel == RetireOutcome.failed("boom")
        assert room_store.deleted == ["room-1"]

    async def test_a_stopped_bridge_is_reported_as_failed(self) -> None:
        events: list[Any] = []
        svc, room_store = _build_service(
            room=_bridged_room(), client_ids=[], clients={}, bridges={}, events=events
        )

        channel = await svc.delete_room("room-1", retire_channel=True)

        assert channel is not None and channel.outcome == "failed"
        assert room_store.deleted == ["room-1"]

    async def test_a_direct_message_is_kept_without_asking_the_platform(
        self,
    ) -> None:
        events: list[Any] = []
        svc, room_store = _build_service(
            room=_bridged_room("direct"),
            client_ids=[],
            clients={},
            bridges={"bridge-x": _FakeCollaborationCore(events)},
            events=events,
        )

        channel = await svc.delete_room("room-1", retire_channel=True)

        assert channel == RetireOutcome(outcome="kept")
        assert not any(e[0] == "retire" for e in events)
        assert room_store.deleted == ["room-1"]

    async def test_disconnecting_the_app_leaves_the_channel(self) -> None:
        events: list[Any] = []
        svc, room_store = _build_service(
            room=_bridged_room(),
            client_ids=[],
            clients={},
            bridges={"bridge-x": _FakeCollaborationCore(events)},
            events=events,
        )

        channel = await svc.delete_room("room-1", retire_channel=False)

        assert channel is None
        assert not any(e[0] == "retire" for e in events)
        assert room_store.deleted == ["room-1"]

    async def test_an_unbridged_room_has_no_channel_outcome(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            transport_room_id="!mx:switch.local",
            bridge_id=None,
            external_channel_id=None,
        )
        svc, _ = _build_service(
            room=room, client_ids=[], clients={}, bridges={}, events=events
        )

        assert await svc.delete_room("room-1", retire_channel=True) is None
