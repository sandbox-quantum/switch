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


class _RecordingClient:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def send_message(self, room_id: str, body: str, **_kwargs: Any) -> str:
        self.sent.append((room_id, body))
        return "$evt"


class _FakeClientLifecycle:
    def __init__(self, client: Any) -> None:
        self._client = client

    def get_by_agent_id(self, _agent_id: str) -> Any:
        return self._client


class _FakeRoomStore:
    def __init__(self, room: Any, members: list[str]) -> None:
        self._room = room
        self._members = members

    async def get(self, _session: Any, room_id: str) -> Any:
        return self._room if room_id == self._room.id else None

    async def get_agent_ids(self, _session: Any, _room_id: str) -> list[str]:
        return list(self._members)

    async def get_with_membership(
        self, session: Any, room_id: str, agent_id: str
    ) -> Any:
        room = await self.get(session, room_id)
        if room is None:
            return None
        return room, agent_id in await self.get_agent_ids(session, room_id)


class _FakeRoomRoleStore:
    def __init__(
        self,
        *,
        role: Any = None,
        agent_lease: Any | None = None,
        lease_role_name: str | None = None,
    ) -> None:
        self._role = role
        self._agent_lease = agent_lease
        self._lease_role_name = lease_role_name
        self.acquired = False
        self.released = False

    async def get_role(self, _session: Any, _room_id: str, _name: str) -> Any:
        return self._role

    async def get_agent_live_lease(
        self, _session: Any, _agent_id: str, _alive: Any = ()
    ) -> Any | None:
        return self._agent_lease

    async def acquire_lease(
        self, _session: Any, role: Any, agent_id: str, _tx: str | None, _alive: Any = ()
    ) -> Any:
        self.acquired = True
        return SimpleNamespace(role_id=role.id, agent_id=agent_id)

    async def agent_room_role(
        self, _session: Any, _room_id: str, _agent_id: str, _alive: Any = ()
    ) -> str | None:
        return self._lease_role_name

    async def release_lease(self, _session: Any, _agent_id: str) -> None:
        self.released = True


_ROOM = SimpleNamespace(
    id="room-1",
    name="This Room",
    description="desc",
    matrix_room_id="!mx:switch.local",
    archived_at=None,
    bridge_id=None,
)
_ROLE = SimpleNamespace(id="role-m", name="manager", instructions="coordinate")


def _build_service(
    *, role_store: _FakeRoomRoleStore, client: Any, members: list[str]
) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = _session_factory  # type: ignore[assignment]
    svc.room_role_store = role_store  # type: ignore[assignment]
    svc.room_store = _FakeRoomStore(_ROOM, members)  # type: ignore[assignment]
    svc.client_lifecycle = _FakeClientLifecycle(client)  # type: ignore[assignment]
    return svc


class TestAssumeNotice:
    async def test_fresh_assume_posts_notice(self) -> None:
        client = _RecordingClient()
        store = _FakeRoomRoleStore(role=_ROLE, agent_lease=None)
        svc = _build_service(role_store=store, client=client, members=["a1"])

        result = await svc.assume_room_role("a1", "room-1", "manager", "tx-1")

        assert result == {"role": "manager", "instructions": "coordinate"}
        assert store.acquired is True
        assert client.sent == [("!mx:switch.local", "🎭 assumed the `manager` role.")]

    async def test_reassume_same_role_posts_no_notice(self) -> None:
        client = _RecordingClient()
        prior = SimpleNamespace(role_id="role-m", agent_id="a1")
        store = _FakeRoomRoleStore(role=_ROLE, agent_lease=prior)
        svc = _build_service(role_store=store, client=client, members=["a1"])

        await svc.assume_room_role("a1", "room-1", "manager", "tx-1")

        assert store.acquired is True
        assert client.sent == []


class TestReleaseNotice:
    async def test_release_live_lease_posts_notice(self) -> None:
        client = _RecordingClient()
        live = SimpleNamespace(role_id="role-m", room_id="room-1", agent_id="a1")
        store = _FakeRoomRoleStore(agent_lease=live, lease_role_name="manager")
        svc = _build_service(role_store=store, client=client, members=["a1"])

        await svc.release_room_role("a1")

        assert store.released is True
        assert client.sent == [("!mx:switch.local", "🎭 released the `manager` role.")]

    async def test_release_without_lease_posts_no_notice(self) -> None:
        client = _RecordingClient()
        store = _FakeRoomRoleStore(agent_lease=None)
        svc = _build_service(role_store=store, client=client, members=["a1"])

        await svc.release_room_role("a1")

        assert store.released is True
        assert client.sent == []
