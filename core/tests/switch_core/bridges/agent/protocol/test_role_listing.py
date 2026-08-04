from __future__ import annotations

from types import SimpleNamespace
from typing import Any

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

    async def list_roles(self, _session: Any, _room_id: str) -> list[Any]:
        return list(self._roles)

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
    def __init__(self, rooms: dict[str, Any]) -> None:
        self._rooms = rooms

    async def get(self, _session: Any, room_id: str) -> Any:
        return self._rooms.get(room_id)


def _role(
    role_id: str, name: str, exclusive: bool, instructions: str
) -> SimpleNamespace:
    return SimpleNamespace(
        id=role_id, name=name, exclusive=exclusive, instructions=instructions
    )


def _lease(
    role_id: str, agent_id: str, transport_session_id: str | None
) -> SimpleNamespace:
    return SimpleNamespace(
        role_id=role_id, agent_id=agent_id, transport_session_id=transport_session_id
    )


def _build_service(
    *,
    roles: list[Any],
    leases: dict[str, list[Any]],
    agents: dict[str, Any],
    bindings: dict[str, tuple[str, str]],
    rooms: dict[str, Any],
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
    svc.room_store = _FakeRoomStore(rooms)  # type: ignore[assignment]
    return svc


class TestListRoomRoles:
    async def test_holder_locations_here_elsewhere_and_unbound(self) -> None:
        # Shared role with three holders: one connected here, one attending
        # another room, one whose session can't be located.
        role = _role("role-w", "worker", False, "do the work")
        leases = {
            "role-w": [
                _lease("role-w", "a-here", "tx-here"),
                _lease("role-w", "a-elsewhere", "tx-elsewhere"),
                _lease("role-w", "a-unbound", None),
            ]
        }
        svc = _build_service(
            roles=[role],
            leases=leases,
            agents={
                "a-here": SimpleNamespace(name="alice"),
                "a-elsewhere": SimpleNamespace(name="bob"),
                "a-unbound": SimpleNamespace(name="carol"),
            },
            bindings={
                "tx-here": ("a-here", "room-1"),
                "tx-elsewhere": ("a-elsewhere", "room-2"),
            },
            rooms={
                "room-1": SimpleNamespace(name="This Room"),
                "room-2": SimpleNamespace(name="Other Room"),
            },
        )

        result = await svc.list_room_roles("viewer", "room-1")

        assert len(result) == 1
        entry = result[0]
        assert entry["name"] == "worker"
        assert entry["exclusive"] is False
        by_name = {h["name"]: h for h in entry["held_by"]}
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
        assert by_name["carol"] == {
            "name": "carol",
            "present_here": False,
            "session_room": None,
        }

    async def test_free_role_has_empty_held_by_and_is_assumable(self) -> None:
        role = _role("role-m", "manager", True, "coordinate")
        svc = _build_service(
            roles=[role],
            leases={},
            agents={},
            bindings={},
            rooms={"room-1": SimpleNamespace(name="This Room")},
        )

        result = await svc.list_room_roles("viewer", "room-1")

        assert result[0]["held_by"] == []
        assert result[0]["assumable_by_me"] is True

    async def test_exclusive_held_by_other_blocks_assume(self) -> None:
        role = _role("role-m", "manager", True, "coordinate")
        leases = {"role-m": [_lease("role-m", "holder", "tx-h")]}
        svc = _build_service(
            roles=[role],
            leases=leases,
            agents={"holder": SimpleNamespace(name="dan")},
            bindings={"tx-h": ("holder", "room-1")},
            rooms={"room-1": SimpleNamespace(name="This Room")},
        )

        result = await svc.list_room_roles("viewer", "room-1")

        assert [h["name"] for h in result[0]["held_by"]] == ["dan"]
        assert result[0]["held_by"][0]["present_here"] is True
        assert result[0]["assumable_by_me"] is False
