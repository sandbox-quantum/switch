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


def _session_factory() -> _FakeSession:
    return _FakeSession()


class _FakeRoomRoleStore:
    def __init__(self, roles: list[Any], holders: dict[str, list[str]]) -> None:
        self._roles = roles
        self._holders = holders

    async def list_roles(self, _session: Any, _room_id: str) -> list[Any]:
        return list(self._roles)

    async def live_holders_for_room(
        self, _session: Any, _room_id: str, _alive: Any = ()
    ) -> dict[str, list[str]]:
        return {k: list(v) for k, v in self._holders.items()}


class _FakeAgentStore:
    def __init__(self, agents: dict[str, Any]) -> None:
        self._agents = agents

    async def get(self, _session: Any, agent_id: str) -> Any:
        return self._agents.get(agent_id)


def _participant(name: str, ptype: str, status: AgentStatus | None) -> SimpleNamespace:
    return SimpleNamespace(name=name, type=ptype, status=status)


def _build_service(
    *,
    participants: list[Any],
    roles: list[Any],
    holders: dict[str, list[str]],
    agents: dict[str, Any],
) -> tuple[ProtocolService, list[str]]:
    sent_bodies: list[str] = []

    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = _session_factory  # type: ignore[assignment]
    svc.room_role_store = _FakeRoomRoleStore(roles, holders)  # type: ignore[assignment]
    svc.agent_store = _FakeAgentStore(agents)  # type: ignore[assignment]

    async def _list_participants(_room_id: str) -> list[Any]:
        return list(participants)

    async def _send_message(
        _agent_id: str, _room_id: str, body: str, thread_id: str | None = None
    ) -> str:
        sent_bodies.append(body)
        return "evt-1"

    svc.list_participants = _list_participants  # type: ignore[assignment]
    svc.send_message = _send_message  # type: ignore[assignment]
    return svc, sent_bodies


class TestSendTargetedRoles:
    async def test_role_fans_out_to_live_holders(self) -> None:
        role = SimpleNamespace(id="r-mgr", name="manager")
        svc, bodies = _build_service(
            participants=[
                _participant("alice", "agent", AgentStatus.LIVE),
                _participant("bob", "agent", AgentStatus.NO_SESSION),
            ],
            roles=[role],
            holders={"r-mgr": ["a-alice", "a-bob"]},
            agents={
                "a-alice": SimpleNamespace(name="alice"),
                "a-bob": SimpleNamespace(name="bob"),
            },
        )

        result = await svc.send_targeted_message(
            "sender", "room-1", [], "standup please", target_roles=["manager"]
        )

        # The body carries the @role token (routing fans out to holders).
        assert bodies == ["@manager standup please"]
        # Statuses report each live holder's reachability.
        assert result.target_statuses == {
            "alice": AgentStatus.LIVE,
            "bob": AgentStatus.NO_SESSION,
        }

    async def test_names_and_roles_combine(self) -> None:
        role = SimpleNamespace(id="r-mgr", name="manager")
        svc, bodies = _build_service(
            participants=[
                _participant("carol", "agent", AgentStatus.LIVE),
                _participant("alice", "agent", AgentStatus.LIVE),
            ],
            roles=[role],
            holders={"r-mgr": ["a-alice"]},
            agents={"a-alice": SimpleNamespace(name="alice")},
        )

        result = await svc.send_targeted_message(
            "sender", "room-1", ["carol"], "ping", target_roles=["manager"]
        )

        assert bodies == ["@carol @manager ping"]
        assert result.target_statuses == {
            "carol": AgentStatus.LIVE,
            "alice": AgentStatus.LIVE,
        }

    async def test_unknown_role_raises(self) -> None:
        svc, _ = _build_service(
            participants=[],
            roles=[SimpleNamespace(id="r-mgr", name="manager")],
            holders={},
            agents={},
        )

        with pytest.raises(ValueError, match="Roles not defined"):
            await svc.send_targeted_message(
                "sender", "room-1", [], "hi", target_roles=["ghost"]
            )

    async def test_no_targets_raises(self) -> None:
        svc, _ = _build_service(participants=[], roles=[], holders={}, agents={})

        with pytest.raises(ValueError, match="at least one"):
            await svc.send_targeted_message("sender", "room-1", [], "hi")

    async def test_role_with_no_live_holder_still_posts(self) -> None:
        role = SimpleNamespace(id="r-mgr", name="manager")
        svc, bodies = _build_service(
            participants=[],
            roles=[role],
            holders={},  # nobody holds it
            agents={},
        )

        result = await svc.send_targeted_message(
            "sender", "room-1", [], "anyone?", target_roles=["manager"]
        )

        assert bodies == ["@manager anyone?"]
        assert result.target_statuses == {}
