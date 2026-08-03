from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService


class _FakeSession:
    def __init__(self) -> None:
        self.committed = False

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def commit(self) -> None:
        self.committed = True


class _FakeResourceService:
    """Records detach calls and replays a canned existence result."""

    def __init__(self, *, exists: bool) -> None:
        self._exists = exists
        self.detach_calls: list[dict[str, str]] = []

    async def detach_linked_room(
        self,
        session: Any,
        *,
        source_room_id: str,
        target_room_id: str,
    ) -> bool:
        self.detach_calls.append(
            {"source_room_id": source_room_id, "target_room_id": target_room_id}
        )
        return self._exists


class _FakeAgentStore:
    """Returns an ownerless agent so `_resolve_acting_identity` resolves to an
    anonymous principal (room write is granted via public write_visibility)."""

    async def get(self, session: Any, agent_id: str) -> Any:
        return SimpleNamespace(id=agent_id, owner_id=None)


class _FakeRoomStore:
    """Returns a publicly-writable room so the write guard passes."""

    async def get(self, session: Any, room_id: str) -> Any:
        return SimpleNamespace(
            id=room_id,
            owner_id=None,
            read_visibility="public",
            write_visibility="public",
        )


def _build_service(
    *, exists: bool
) -> tuple[ProtocolService, _FakeSession, _FakeResourceService]:
    session = _FakeSession()
    resource_service = _FakeResourceService(exists=exists)

    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = lambda: session  # type: ignore[assignment]
    svc.resource_service = resource_service  # type: ignore[assignment]
    svc.agent_store = _FakeAgentStore()  # type: ignore[assignment]
    svc.room_store = _FakeRoomStore()  # type: ignore[assignment]
    return svc, session, resource_service


class TestUnlinkRooms:
    async def test_removes_link_and_commits(self) -> None:
        svc, session, resource_service = _build_service(exists=True)

        await svc.unlink_rooms("agent-1", "room-a", "room-b")

        assert resource_service.detach_calls == [
            {"source_room_id": "room-a", "target_room_id": "room-b"}
        ]
        assert session.committed is True

    async def test_raises_when_link_missing(self) -> None:
        svc, session, resource_service = _build_service(exists=False)

        with pytest.raises(LookupError):
            await svc.unlink_rooms("agent-1", "room-a", "room-b")

        # The detach was attempted, but nothing should be committed.
        assert resource_service.detach_calls == [
            {"source_room_id": "room-a", "target_room_id": "room-b"}
        ]
        assert session.committed is False
