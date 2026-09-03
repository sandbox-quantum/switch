from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.room_service import RoomService


class _FakeSessionCM:
    async def __aenter__(self) -> _FakeSessionCM:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def commit(self) -> None:
        return None


class _FakeRoomStore:
    def __init__(
        self,
        rooms: list[Any],
        client_ids_by_room: dict[str, list[str]],
        agent_clients_by_room: dict[str, dict[str, str]],
    ) -> None:
        self._rooms = rooms
        self._client_ids_by_room = client_ids_by_room
        self._agent_clients_by_room = agent_clients_by_room
        self.added: list[tuple[str, str]] = []

    async def get_all(
        self, session: Any, *, include_archived: bool = False
    ) -> list[Any]:
        return list(self._rooms)

    async def get_client_ids(self, session: Any, room_id: str) -> list[str]:
        return list(self._client_ids_by_room.get(room_id, []))

    async def get_member_agent_clients(
        self, session: Any, room_id: str
    ) -> dict[str, str]:
        return dict(self._agent_clients_by_room.get(room_id, {}))

    async def add_client(self, session: Any, client_id: str, room_id: str) -> None:
        self.added.append((client_id, room_id))


class _FakeClientLifecycle:
    """Resolves system clients by type, mirroring the real lookup."""

    def __init__(self, by_type: dict[str, list[Any]]) -> None:
        self._by_type = by_type

    def get_by_type(self, client_type: str) -> list[Any]:
        return list(self._by_type.get(client_type, []))


class _FakeMatrix:
    def __init__(self) -> None:
        self.invited: list[tuple[str, str]] = []

    async def invite_to_room(self, matrix_room_id: str, matrix_user_id: str) -> None:
        self.invited.append((matrix_room_id, matrix_user_id))


def _admin() -> SimpleNamespace:
    return SimpleNamespace(
        client_id="admin-client", matrix_user_id="@switch-admin:switch.local"
    )


def _build_service(
    *,
    rooms: list[Any],
    client_ids_by_room: dict[str, list[str]],
    by_type: dict[str, list[Any]],
    agent_clients_by_room: dict[str, dict[str, str]] | None = None,
) -> tuple[RoomService, _FakeRoomStore, _FakeMatrix]:
    room_store = _FakeRoomStore(rooms, client_ids_by_room, agent_clients_by_room or {})
    matrix = _FakeMatrix()
    svc = object.__new__(RoomService)
    svc._session_factory = lambda: _FakeSessionCM()  # type: ignore[assignment]
    svc._room_store = room_store  # type: ignore[assignment]
    svc._client_lifecycle = _FakeClientLifecycle(by_type)  # type: ignore[assignment]
    svc._matrix_admin = matrix  # type: ignore[assignment]
    return svc, room_store, matrix


class TestReconcileRoomClients:
    async def test_backfills_missing_admin_into_existing_room(self) -> None:
        # A room created before the admin client existed: it has the other
        # system clients but not the admin. Reconcile invites + records it.
        room = SimpleNamespace(id="room-1", matrix_room_id="!mx:switch.local")
        svc, room_store, matrix = _build_service(
            rooms=[room],
            client_ids_by_room={"room-1": ["resource-mgr", "observe"]},
            by_type={"admin": [_admin()]},
        )

        await svc.reconcile_room_clients()

        assert matrix.invited == [("!mx:switch.local", "@switch-admin:switch.local")]
        assert room_store.added == [("admin-client", "room-1")]

    async def test_skips_room_that_already_has_the_admin(self) -> None:
        room = SimpleNamespace(id="room-1", matrix_room_id="!mx:switch.local")
        svc, room_store, matrix = _build_service(
            rooms=[room],
            client_ids_by_room={"room-1": ["admin-client"]},
            by_type={"admin": [_admin()]},
        )

        await svc.reconcile_room_clients()

        assert matrix.invited == []
        assert room_store.added == []

    async def test_covers_archived_rooms_too(self) -> None:
        rooms = [
            SimpleNamespace(id="live", matrix_room_id="!live:switch.local"),
            SimpleNamespace(id="archived", matrix_room_id="!arch:switch.local"),
        ]
        svc, room_store, matrix = _build_service(
            rooms=rooms,
            client_ids_by_room={"live": [], "archived": []},
            by_type={"admin": [_admin()]},
        )

        await svc.reconcile_room_clients()

        assert ("!live:switch.local", "@switch-admin:switch.local") in matrix.invited
        assert ("!arch:switch.local", "@switch-admin:switch.local") in matrix.invited
        assert ("admin-client", "live") in room_store.added
        assert ("admin-client", "archived") in room_store.added

    async def test_no_running_system_clients_is_a_noop(self) -> None:
        room = SimpleNamespace(id="room-1", matrix_room_id="!mx:switch.local")
        svc, room_store, matrix = _build_service(
            rooms=[room],
            client_ids_by_room={"room-1": []},
            by_type={},
        )

        await svc.reconcile_room_clients()

        assert matrix.invited == []
        assert room_store.added == []

    async def test_reinvites_an_agent_whose_invite_never_landed(self) -> None:
        # `add_agents_to_room` writes the membership row, invites, then records
        # `room_clients`. A crash in that window leaves the member with no
        # `room_clients` row, which is exactly what is repaired here.
        room = SimpleNamespace(id="room-1", matrix_room_id="!mx:switch.local")
        svc, room_store, matrix = _build_service(
            rooms=[room],
            client_ids_by_room={"room-1": []},
            by_type={},
            agent_clients_by_room={"room-1": {"agent-client": "@fixer:switch.local"}},
        )

        await svc.reconcile_room_clients()

        assert matrix.invited == [("!mx:switch.local", "@fixer:switch.local")]
        assert room_store.added == [("agent-client", "room-1")]

    async def test_an_agent_already_recorded_is_left_alone(self) -> None:
        room = SimpleNamespace(id="room-1", matrix_room_id="!mx:switch.local")
        svc, room_store, matrix = _build_service(
            rooms=[room],
            client_ids_by_room={"room-1": ["agent-client"]},
            by_type={},
            agent_clients_by_room={"room-1": {"agent-client": "@fixer:switch.local"}},
        )

        await svc.reconcile_room_clients()

        assert matrix.invited == []
        assert room_store.added == []
