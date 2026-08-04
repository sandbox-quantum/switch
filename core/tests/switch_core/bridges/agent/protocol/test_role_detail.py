from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def commit(self) -> None:
        return None


def _session_factory() -> _FakeSession:
    return _FakeSession()


class _FakeRoomRoleStore:
    def __init__(
        self,
        roles: list[Any],
        leases: dict[str, list[Any]],
        my_lease: Any | None,
    ) -> None:
        self._roles = roles
        self._leases = leases
        self._my_lease = my_lease

    async def get_role(self, _session: Any, _room_id: str, name: str) -> Any | None:
        for role in self._roles:
            if role.name == name:
                return role
        return None

    async def live_leases_for_room(
        self, _session: Any, _room_id: str, _alive: Any = ()
    ) -> dict[str, list[Any]]:
        return {k: list(v) for k, v in self._leases.items()}

    async def get_agent_live_lease(
        self, _session: Any, _agent_id: str, _alive: Any = ()
    ) -> Any | None:
        return self._my_lease


class _FakeAgentStore:
    def __init__(self, agents: dict[str, Any]) -> None:
        self._agents = agents

    async def get(self, _session: Any, agent_id: str) -> Any:
        return self._agents.get(agent_id)


class _FakeAgentSessionStore:
    """Maps transport_session_id -> (agent_id, room_id) it is connected to."""

    def __init__(self, bindings: dict[str, tuple[str, str]]) -> None:
        self._bindings = bindings

    async def get_connected_room(
        self, _session: Any, transport_session_id: str
    ) -> tuple[str, str] | None:
        return self._bindings.get(transport_session_id)


class _FakeRoomStore:
    def __init__(self, rooms: dict[str, Any], members: dict[str, list[str]]) -> None:
        self._rooms = rooms
        self._members = members

    async def get(self, _session: Any, room_id: str) -> Any:
        return self._rooms.get(room_id)

    async def get_agent_ids(self, _session: Any, room_id: str) -> list[str]:
        return list(self._members.get(room_id, []))


def _role(name: str, exclusive: bool, instructions: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=f"role-{name}", name=name, exclusive=exclusive, instructions=instructions
    )


def _lease(
    role_id: str, agent_id: str, transport_session_id: str | None
) -> SimpleNamespace:
    return SimpleNamespace(
        role_id=role_id, agent_id=agent_id, transport_session_id=transport_session_id
    )


def _room(room_id: str, name: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=room_id, name=name, description="d", matrix_room_id="!m:x"
    )


def _build_service(
    *,
    roles: list[Any],
    leases: dict[str, list[Any]],
    agents: dict[str, Any],
    bindings: dict[str, tuple[str, str]],
    rooms: dict[str, Any],
    members: dict[str, list[str]],
    my_lease: Any | None = None,
) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = _session_factory  # type: ignore[assignment]
    svc.room_role_store = _FakeRoomRoleStore(roles, leases, my_lease)  # type: ignore[assignment]
    svc.agent_store = _FakeAgentStore(agents)  # type: ignore[assignment]
    svc.agent_session_store = _FakeAgentSessionStore(bindings)  # type: ignore[assignment]
    svc.room_store = _FakeRoomStore(rooms, members)  # type: ignore[assignment]
    return svc


class TestGetRoomRole:
    async def test_returns_full_untruncated_instructions(self) -> None:
        long_instructions = "x" * 500
        role = _role("manager", True, long_instructions)
        svc = _build_service(
            roles=[role],
            leases={},
            agents={},
            bindings={},
            rooms={"room-1": _room("room-1", "This Room")},
            members={"room-1": ["viewer"]},
        )

        result = await svc.get_room_role("viewer", "room-1", "manager")

        assert result["name"] == "manager"
        assert result["exclusive"] is True
        # Full instructions, not the 200-char preview.
        assert result["instructions"] == long_instructions
        assert "instructions_preview" not in result
        assert result["held_by"] == []
        assert result["assumable_by_me"] is True

    async def test_includes_holder_presence(self) -> None:
        role = _role("worker", False, "do the work")
        leases = {
            "role-worker": [
                _lease("role-worker", "a-here", "tx-here"),
                _lease("role-worker", "a-elsewhere", "tx-elsewhere"),
            ]
        }
        svc = _build_service(
            roles=[role],
            leases=leases,
            agents={
                "a-here": SimpleNamespace(name="alice"),
                "a-elsewhere": SimpleNamespace(name="bob"),
            },
            bindings={
                "tx-here": ("a-here", "room-1"),
                "tx-elsewhere": ("a-elsewhere", "room-2"),
            },
            rooms={
                "room-1": _room("room-1", "This Room"),
                "room-2": _room("room-2", "Other Room"),
            },
            members={"room-1": ["viewer"]},
        )

        result = await svc.get_room_role("viewer", "room-1", "worker")

        by_name = {h["name"]: h for h in result["held_by"]}
        assert by_name["alice"] == {
            "name": "alice",
            "present_here": True,
            "session_room": None,
        }
        assert by_name["bob"] == {
            "name": "bob",
            "present_here": False,
            "session_room": "Other Room",
        }

    async def test_unknown_role_raises(self) -> None:
        svc = _build_service(
            roles=[_role("manager", True, "coordinate")],
            leases={},
            agents={},
            bindings={},
            rooms={"room-1": _room("room-1", "This Room")},
            members={"room-1": ["viewer"]},
        )

        with pytest.raises(ValueError, match="not found"):
            await svc.get_room_role("viewer", "room-1", "nonexistent")

    async def test_non_member_is_rejected(self) -> None:
        svc = _build_service(
            roles=[_role("manager", True, "coordinate")],
            leases={},
            agents={},
            bindings={},
            rooms={"room-1": _room("room-1", "This Room")},
            members={"room-1": ["someone-else"]},
        )

        with pytest.raises(PermissionError):
            await svc.get_room_role("viewer", "room-1", "manager")
