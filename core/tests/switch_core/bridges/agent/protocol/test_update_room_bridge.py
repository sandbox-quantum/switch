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


class _FakeRoomStore:
    async def update_fields(self, session: Any, room_id: str, **kwargs: Any) -> None:
        return None


class _FakeBridgeStore:
    def __init__(self, found: bool) -> None:
        self._found = found

    async def get(self, session: Any, bridge_id: str) -> Any:
        return SimpleNamespace(id=bridge_id) if self._found else None


class _FakeRoomService:
    def __init__(self) -> None:
        self.change_bridge_calls: list[dict[str, Any]] = []

    async def change_bridge(
        self,
        room_id: str,
        *,
        bridge_id: str,
        channel_type: str | None,
        external_channel_id: str | None = None,
    ) -> None:
        self.change_bridge_calls.append(
            {
                "room_id": room_id,
                "bridge_id": bridge_id,
                "channel_type": channel_type,
                "external_channel_id": external_channel_id,
            }
        )


def _build_service(
    *, bridge_found: bool = True
) -> tuple[ProtocolService, _FakeRoomService]:
    room_service = _FakeRoomService()
    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = lambda: _FakeSession()  # type: ignore[assignment]
    svc.room_store = _FakeRoomStore()  # type: ignore[assignment]
    svc.bridge_store = _FakeBridgeStore(bridge_found)  # type: ignore[assignment]
    svc.room_service = room_service  # type: ignore[assignment]

    async def _no_member(agent_id: str, room_id: str) -> Any:
        return SimpleNamespace(id=room_id)

    async def _no_action(
        session: Any, agent_id: str, room_id: str, action: str
    ) -> None:
        return None

    async def _detail(agent_id: str, room_id: str) -> Any:
        return SimpleNamespace(room_id=room_id)

    svc.require_room_member = _no_member  # type: ignore[assignment]
    svc._require_room_action = _no_action  # type: ignore[assignment]
    svc.get_room_detail = _detail  # type: ignore[assignment]
    return svc, room_service


class TestUpdateRoomBridge:
    async def test_no_bridge_id_skips_change_bridge(self) -> None:
        svc, room_service = _build_service()

        await svc.update_room("agent-1", "room-1", name="Renamed")

        assert room_service.change_bridge_calls == []

    async def test_bridge_id_triggers_move(self) -> None:
        svc, room_service = _build_service()

        await svc.update_room(
            "agent-1",
            "room-1",
            bridge_id="bridge-new",
            channel_type="channel_private",
        )

        assert room_service.change_bridge_calls == [
            {
                "room_id": "room-1",
                "bridge_id": "bridge-new",
                "channel_type": "channel_private",
                "external_channel_id": None,
            }
        ]

    async def test_unknown_bridge_raises_before_move(self) -> None:
        svc, room_service = _build_service(bridge_found=False)

        with pytest.raises(ValueError, match="Bridge not found"):
            await svc.update_room("agent-1", "room-1", bridge_id="nope")

        assert room_service.change_bridge_calls == []

    async def test_invalid_channel_type_raises_before_move(self) -> None:
        svc, room_service = _build_service()

        with pytest.raises(ValueError, match="channel_type must be"):
            await svc.update_room(
                "agent-1", "room-1", bridge_id="bridge-new", channel_type="bogus"
            )

        assert room_service.change_bridge_calls == []
