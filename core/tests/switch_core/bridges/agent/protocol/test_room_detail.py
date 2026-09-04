from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import AgentStatus


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def commit(self) -> None:
        return None


def _session_factory() -> _FakeSession:
    return _FakeSession()


class _FakeRoomStore:
    def __init__(
        self,
        rooms: dict[str, Any],
        agent_ids: list[str],
        client_ids: list[str],
    ) -> None:
        self._rooms = rooms
        self._agent_ids = agent_ids
        self._client_ids = client_ids
        self.update_calls: list[dict[str, Any]] = []

    async def get(self, session: Any, room_id: str) -> Any:
        return self._rooms.get(room_id)

    async def get_agent_ids(self, session: Any, room_id: str) -> list[str]:
        return list(self._agent_ids)

    async def get_with_membership(
        self, session: Any, room_id: str, agent_id: str
    ) -> Any:
        room = await self.get(session, room_id)
        if room is None:
            return None
        return room, agent_id in await self.get_agent_ids(session, room_id)

    async def get_client_ids(self, session: Any, room_id: str) -> list[str]:
        return list(self._client_ids)

    async def get_join_event_listeners(self, session: Any, room_id: str) -> list[str]:
        return []

    async def list_aliases(self, session: Any, room_id: str) -> dict[str, str]:
        return {}

    async def update_fields(
        self,
        session: Any,
        room_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        admin_mode: bool | None = None,
    ) -> None:
        self.update_calls.append(
            {
                "room_id": room_id,
                "name": name,
                "description": description,
                "instructions": instructions,
                "admin_mode": admin_mode,
            }
        )
        room = self._rooms[room_id]
        if name is not None:
            room.name = name
        if description is not None:
            room.description = description
        if instructions is not None:
            room.instructions = instructions
        if admin_mode is not None:
            room.admin_mode = admin_mode

    async def set_archived(self, session: Any, room_id: str, archived: bool) -> None:
        room = self._rooms[room_id]
        room.archived_at = "2026-06-02T12:00:00+00:00" if archived else None


class _FakeAgentStore:
    def __init__(self, agents: dict[str, Any]) -> None:
        self._agents = agents

    async def get(self, session: Any, agent_id: str) -> Any:
        return self._agents.get(agent_id)


class _FakeBridgeStore:
    def __init__(self, bridges: dict[str, Any]) -> None:
        self._bridges = bridges

    async def get(self, session: Any, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)


class _FakeExternalUserStore:
    def __init__(self, by_bridge: dict[str, list[Any]]) -> None:
        self._by_bridge = by_bridge

    async def get_by_bridge(self, session: Any, bridge_id: str) -> list[Any]:
        return list(self._by_bridge.get(bridge_id, []))


def _room(**overrides: Any) -> SimpleNamespace:
    base = {
        "id": "room-1",
        "name": "Feature room",
        "description": "Work on the feature",
        "matrix_room_id": "!abc:switch.local",
        "channel_type": "channel_private",
        "admin_mode": False,
        "instructions": "Be excellent",
        "created_at": "2026-05-29T00:00:00+00:00",
        "bridge_id": None,
        "external_channel_id": None,
        "owner_id": None,
        "group_id": None,
        "read_visibility": "public",
        "write_visibility": "public",
        "archived_at": None,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def _build_service(
    *,
    room: SimpleNamespace,
    agent_ids: list[str],
    client_ids: list[str] | None = None,
    agents: dict[str, Any] | None = None,
    bridges: dict[str, Any] | None = None,
    ext_users: dict[str, list[Any]] | None = None,
    statuses: dict[str, AgentStatus] | None = None,
    roles: list[dict[str, Any]] | None = None,
) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = _session_factory  # type: ignore[assignment]
    svc.room_store = _FakeRoomStore({room.id: room}, agent_ids, client_ids or [])  # type: ignore[assignment]
    svc.agent_store = _FakeAgentStore(agents or {})  # type: ignore[assignment]
    svc.bridge_store = _FakeBridgeStore(bridges or {})  # type: ignore[assignment]
    svc.external_user_store = _FakeExternalUserStore(ext_users or {})  # type: ignore[assignment]

    resolved = statuses or {aid: AgentStatus.NO_SESSION for aid in agent_ids}

    async def _fake_statuses(room_id: str, ids: list[str]) -> dict[str, AgentStatus]:
        return {aid: resolved[aid] for aid in ids if aid in resolved}

    svc.get_agent_statuses_by_ids = _fake_statuses  # type: ignore[assignment]

    resolved_roles = roles or []

    async def _fake_roles(agent_id: str, room_id: str) -> list[dict[str, Any]]:
        return resolved_roles

    svc.list_room_roles = _fake_roles  # type: ignore[assignment]
    return svc


class TestGetRoomDetail:
    async def test_returns_full_detail_for_member(self) -> None:
        room = _room()
        svc = _build_service(
            room=room,
            agent_ids=["agent-1", "agent-2"],
            agents={
                "agent-1": SimpleNamespace(name="claude-code.alice"),
                "agent-2": SimpleNamespace(name="moderator"),
            },
            statuses={
                "agent-1": AgentStatus.LIVE,
                "agent-2": AgentStatus.NO_SESSION,
            },
        )

        detail = await svc.get_room_detail("agent-1", "room-1")

        assert detail.id == "room-1"
        assert detail.name == "Feature room"
        assert detail.description == "Work on the feature"
        assert detail.channel_type == "channel_private"
        assert detail.admin_mode is False
        assert detail.instructions == "Be excellent"
        assert detail.matrix_room_id == "!abc:switch.local"
        assert detail.created_at == "2026-05-29T00:00:00+00:00"
        assert detail.bridge_id is None
        assert detail.bridge_display_name is None
        assert detail.external_channel_id is None
        assert detail.agent_names == ["claude-code.alice", "moderator"]
        # Statuses are keyed by agent name, not id, for agent-facing use.
        assert detail.agent_statuses == {
            "claude-code.alice": "live",
            "moderator": "no_session",
        }
        assert detail.connected_user_names == []
        assert detail.roles == []

    async def test_includes_roles_mirroring_list_roles(self) -> None:
        room = _room()
        roles = [
            {
                "name": "manager",
                "exclusive": True,
                "instructions_preview": "Coordinate the work",
                "held_by": [
                    {
                        "name": "claude-code.alice",
                        "present_here": True,
                        "session_room": None,
                    }
                ],
                "assumable_by_me": False,
            },
            {
                "name": "worker",
                "exclusive": False,
                "instructions_preview": "Do the work",
                "held_by": [],
                "assumable_by_me": True,
            },
        ]
        svc = _build_service(
            room=room,
            agent_ids=["agent-1"],
            agents={"agent-1": SimpleNamespace(name="claude-code.alice")},
            roles=roles,
        )

        detail = await svc.get_room_detail("agent-1", "room-1")

        assert detail.roles == roles

    async def test_raises_permission_error_for_non_member(self) -> None:
        room = _room()
        svc = _build_service(
            room=room,
            agent_ids=["agent-1"],
            agents={
                "agent-1": SimpleNamespace(name="claude-code.alice", owner_id=None)
            },
        )

        with pytest.raises(PermissionError):
            await svc.get_room_detail("intruder", "room-1")

    async def test_includes_bridge_and_connected_users(self) -> None:
        room = _room(bridge_id="bridge-1", external_channel_id="C123")
        svc = _build_service(
            room=room,
            agent_ids=["agent-1"],
            client_ids=["client-a", "client-b", "client-unknown"],
            agents={
                "agent-1": SimpleNamespace(name="claude-code.alice", owner_id=None)
            },
            bridges={"bridge-1": SimpleNamespace(display_name="Mattermost")},
            ext_users={
                "bridge-1": [
                    SimpleNamespace(client_id="client-b", external_username="zara"),
                    SimpleNamespace(client_id="client-a", external_username="louisa"),
                ]
            },
        )

        detail = await svc.get_room_detail("agent-1", "room-1")

        assert detail.bridge_id == "bridge-1"
        assert detail.bridge_display_name == "Mattermost"
        assert detail.external_channel_id == "C123"
        # Sorted by name; the client with no matching external user is dropped.
        assert detail.connected_user_names == ["louisa", "zara"]


class TestUpdateRoom:
    async def test_only_provided_fields_are_passed_through(self) -> None:
        room = _room()
        svc = _build_service(
            room=room,
            agent_ids=["agent-1"],
            agents={
                "agent-1": SimpleNamespace(name="claude-code.alice", owner_id=None)
            },
        )

        detail = await svc.update_room(
            "agent-1",
            "room-1",
            name="Renamed room",
            description="New description",
        )

        store = svc.room_store
        assert isinstance(store, _FakeRoomStore)
        assert store.update_calls == [
            {
                "room_id": "room-1",
                "name": "Renamed room",
                "description": "New description",
                "instructions": None,
                "admin_mode": None,
            }
        ]
        # Returns the refreshed full detail reflecting the change.
        assert detail.name == "Renamed room"
        assert detail.description == "New description"
        # Untouched fields are preserved.
        assert detail.instructions == "Be excellent"
        assert detail.admin_mode is False

    async def test_raises_permission_error_for_non_member(self) -> None:
        room = _room()
        svc = _build_service(
            room=room,
            agent_ids=["agent-1"],
            agents={
                "agent-1": SimpleNamespace(name="claude-code.alice", owner_id=None)
            },
        )

        with pytest.raises(PermissionError):
            await svc.update_room("intruder", "room-1", name="Hijacked")

        # No write should have happened.
        store = svc.room_store
        assert isinstance(store, _FakeRoomStore)
        assert store.update_calls == []


class TestSetRoomArchived:
    async def test_archive_then_unarchive_reflected_in_detail(self) -> None:
        room = _room()
        svc = _build_service(
            room=room,
            agent_ids=["agent-1"],
            agents={
                "agent-1": SimpleNamespace(name="claude-code.alice", owner_id=None)
            },
        )

        detail = await svc.set_room_archived("agent-1", "room-1", True)
        assert detail.archived is True
        assert room.archived_at is not None

        detail = await svc.set_room_archived("agent-1", "room-1", False)
        assert detail.archived is False
        assert room.archived_at is None

    async def test_raises_permission_error_for_non_member(self) -> None:
        room = _room()
        svc = _build_service(
            room=room,
            agent_ids=["agent-1"],
            agents={
                "agent-1": SimpleNamespace(name="claude-code.alice", owner_id=None)
            },
        )

        with pytest.raises(PermissionError):
            await svc.set_room_archived("intruder", "room-1", True)

        # The room must not have been archived.
        assert room.archived_at is None
