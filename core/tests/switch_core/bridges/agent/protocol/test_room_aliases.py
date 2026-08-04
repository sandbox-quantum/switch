from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.aliases import AliasError
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
        aliases: dict[str, str],
    ) -> None:
        self._rooms = rooms
        self._agent_ids = agent_ids
        self._aliases = dict(aliases)  # agent_id -> alias

    async def get(self, session: Any, room_id: str) -> Any:
        return self._rooms.get(room_id)

    async def get_agent_ids(self, session: Any, room_id: str) -> list[str]:
        return list(self._agent_ids)

    async def get_client_ids(self, session: Any, room_id: str) -> list[str]:
        return []

    async def get_join_event_listeners(self, session: Any, room_id: str) -> list[str]:
        return []

    async def list_aliases(self, session: Any, room_id: str) -> dict[str, str]:
        return dict(self._aliases)

    async def set_alias(
        self, session: Any, room_id: str, agent_id: str, alias: str | None
    ) -> None:
        if agent_id not in self._agent_ids:
            raise ValueError(f"Agent {agent_id} is not a member of room {room_id}")
        if alias is None:
            self._aliases.pop(agent_id, None)
        else:
            self._aliases[agent_id] = alias

    async def update_fields(self, session: Any, room_id: str, **kwargs: Any) -> None:
        return None


class _FakeAgentStore:
    def __init__(self, agents: dict[str, Any]) -> None:
        self._agents = agents

    async def get(self, session: Any, agent_id: str) -> Any:
        return self._agents.get(agent_id)

    async def get_by_name(self, session: Any, name: str) -> Any:
        for agent in self._agents.values():
            if agent.name == name:
                return agent
        return None


class _FakeRoleStore:
    def __init__(self, role_names: list[str]) -> None:
        self._roles = [SimpleNamespace(id=f"role-{n}", name=n) for n in role_names]

    async def list_roles(self, session: Any, room_id: str) -> list[Any]:
        return list(self._roles)


def _room(**overrides: Any) -> SimpleNamespace:
    base = {
        "id": "room-1",
        "name": "Feature room",
        "description": "desc",
        "matrix_room_id": "!abc:switch.local",
        "channel_type": "channel_private",
        "admin_mode": False,
        "instructions": "",
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
    agent_ids: list[str],
    agents: dict[str, Any],
    aliases: dict[str, str] | None = None,
    role_names: list[str] | None = None,
) -> ProtocolService:
    room = _room()
    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = _session_factory  # type: ignore[assignment]
    svc.room_store = _FakeRoomStore({room.id: room}, agent_ids, aliases or {})  # type: ignore[assignment]
    svc.agent_store = _FakeAgentStore(agents)  # type: ignore[assignment]
    svc.bridge_store = SimpleNamespace()  # type: ignore[assignment]
    svc.external_user_store = SimpleNamespace(get_by_bridge=_noop_get_by_bridge)  # type: ignore[assignment]
    svc.room_role_store = _FakeRoleStore(role_names or [])  # type: ignore[assignment]

    async def _fake_statuses(room_id: str, ids: list[str]) -> dict[str, AgentStatus]:
        return {aid: AgentStatus.NO_SESSION for aid in ids}

    svc.get_agent_statuses_by_ids = _fake_statuses  # type: ignore[assignment]

    async def _fake_roles(agent_id: str, room_id: str) -> list[dict[str, Any]]:
        return []

    svc.list_room_roles = _fake_roles  # type: ignore[assignment]
    return svc


async def _noop_get_by_bridge(session: Any, bridge_id: str) -> list[Any]:
    return []


_AGENTS = {
    "a1": SimpleNamespace(id="a1", name="claude-code.alice", owner_id=None),
    "a2": SimpleNamespace(id="a2", name="moderator", owner_id=None),
}


class TestGetRoomDetailAliases:
    async def test_detail_includes_aliases_keyed_by_name(self) -> None:
        svc = _build_service(
            agent_ids=["a1", "a2"], agents=_AGENTS, aliases={"a1": "boss"}
        )
        detail = await svc.get_room_detail("a1", "room-1")
        assert detail.aliases == {"claude-code.alice": "boss"}

    async def test_detail_empty_when_no_aliases(self) -> None:
        svc = _build_service(agent_ids=["a1"], agents=_AGENTS)
        detail = await svc.get_room_detail("a1", "room-1")
        assert detail.aliases == {}


class TestUpdateRoomAliases:
    async def test_set_alias_via_update_room(self) -> None:
        svc = _build_service(agent_ids=["a1", "a2"], agents=_AGENTS)
        detail = await svc.update_room(
            "a1", "room-1", aliases={"claude-code.alice": "boss"}
        )
        assert detail.aliases == {"claude-code.alice": "boss"}

    async def test_clear_alias_with_empty_string(self) -> None:
        svc = _build_service(
            agent_ids=["a1", "a2"], agents=_AGENTS, aliases={"a1": "boss"}
        )
        detail = await svc.update_room(
            "a1", "room-1", aliases={"claude-code.alice": ""}
        )
        assert detail.aliases == {}

    async def test_alias_colliding_with_role_rejected(self) -> None:
        svc = _build_service(
            agent_ids=["a1", "a2"], agents=_AGENTS, role_names=["manager"]
        )
        with pytest.raises(AliasError, match="role"):
            await svc.update_room(
                "a1", "room-1", aliases={"claude-code.alice": "manager"}
            )

    async def test_alias_colliding_with_agent_name_rejected(self) -> None:
        svc = _build_service(agent_ids=["a1", "a2"], agents=_AGENTS)
        with pytest.raises(AliasError, match="real name"):
            await svc.update_room(
                "a1", "room-1", aliases={"claude-code.alice": "moderator"}
            )

    async def test_alias_for_non_member_rejected(self) -> None:
        svc = _build_service(agent_ids=["a1", "a2"], agents=_AGENTS)
        with pytest.raises(ValueError, match="Unknown agent"):
            await svc.update_room("a1", "room-1", aliases={"ghost": "boss"})
