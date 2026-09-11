from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

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


class _FakeBridgeCore:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def remove_room_mapping(self, room_id: str, matrix_room_id: str) -> None:
        self._events.append(("remove_room_mapping", room_id, matrix_room_id))


class _FakeLifecycle:
    def __init__(self, bridges: dict[str, Any]) -> None:
        self._bridges = bridges

    def get(self, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)


class _FakeClientLifecycle:
    def __init__(self, clients: dict[str, Any]) -> None:
        self._clients = clients

    def get(self, client_id: str) -> Any:
        return self._clients.get(client_id)


class _FakeMatrix:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    async def kick_user(self, matrix_room_id: str, matrix_user_id: str) -> None:
        self._events.append(("kick", matrix_user_id))

    async def delete_room(self, matrix_room_id: str) -> None:
        self._events.append(("delete_room", matrix_room_id))


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
    svc._matrix_admin = _FakeMatrix(events)  # type: ignore[assignment]
    return svc, room_store


class TestDeleteRoom:
    async def test_evicts_bridged_room_from_bridge_core(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            matrix_room_id="!mx:switch.local",
            bridge_id="bridge-x",
            external_channel_id="chan-x",
        )
        bridge = _FakeBridgeCore(events)
        svc, room_store = _build_service(
            room=room,
            client_ids=[],
            clients={},
            bridges={"bridge-x": bridge},
            events=events,
        )

        await svc.delete_room("room-1")

        assert room_store.deleted == ["room-1"]
        assert ("delete_room", "!mx:switch.local") in events
        assert ("remove_room_mapping", "room-1", "!mx:switch.local") in events

    async def test_non_bridged_room_does_not_touch_bridge_core(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            matrix_room_id="!mx:switch.local",
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

        await svc.delete_room("room-1")

        assert room_store.deleted == ["room-1"]
        assert not any(e[0] == "remove_room_mapping" for e in events)

    async def test_missing_bridge_core_is_tolerated(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            matrix_room_id="!mx:switch.local",
            bridge_id="bridge-gone",
            external_channel_id="chan-x",
        )
        svc, room_store = _build_service(
            room=room,
            client_ids=[],
            clients={},
            bridges={},
            events=events,
        )

        await svc.delete_room("room-1")

        assert room_store.deleted == ["room-1"]
        assert not any(e[0] == "remove_room_mapping" for e in events)

    async def test_kicks_clients_before_deleting(self) -> None:
        events: list[Any] = []
        room = SimpleNamespace(
            id="room-1",
            tenant_id="room-tenant",
            matrix_room_id="!mx:switch.local",
            bridge_id=None,
            external_channel_id=None,
        )
        clients = {
            "c1": SimpleNamespace(matrix_user_id="@a:switch.local"),
            "c2": SimpleNamespace(matrix_user_id="@b:switch.local"),
        }
        svc, _ = _build_service(
            room=room,
            client_ids=["c1", "c2"],
            clients=clients,
            bridges={},
            events=events,
        )

        await svc.delete_room("room-1")

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
            await svc.delete_room("nope")
