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


class _FakeRoomStore:
    def __init__(self, group_id: str | None) -> None:
        self._group_id = group_id

    async def get(self, _session: Any, _room_id: str) -> Any:
        return SimpleNamespace(group_id=self._group_id)


def _participant(
    name: str, ptype: str, status: AgentStatus | None, *, agent_id: str | None = None
) -> SimpleNamespace:
    return SimpleNamespace(
        id=agent_id if agent_id is not None else f"a-{name}",
        name=name,
        type=ptype,
        status=status,
    )


def _agent(name: str, addressing_policy: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        name=name, addressing_policy=addressing_policy, owner_id="owner-1"
    )


def _build_service(
    *,
    participants: list[Any],
    roles: list[Any],
    holders: dict[str, list[str]],
    agents: dict[str, Any],
    group_id: str | None = None,
) -> tuple[ProtocolService, list[str]]:
    sent_bodies: list[str] = []

    svc = object.__new__(ProtocolService)
    # Presence unions the heartbeat rows with the live connections
    # (CHOO-1857); an empty registry means "rows only".
    svc.connections = ConnectionRegistry()
    svc.session_factory = _session_factory  # type: ignore[assignment]
    svc.room_role_store = _FakeRoomRoleStore(roles, holders)  # type: ignore[assignment]
    svc.agent_store = _FakeAgentStore(agents)  # type: ignore[assignment]
    svc.room_store = _FakeRoomStore(group_id)  # type: ignore[assignment]

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
            agents={"a-alice": _agent("alice"), "a-bob": _agent("bob")},
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
            agents={"a-alice": _agent("alice"), "a-carol": _agent("carol")},
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


class TestSendTargetedAddressingGate:
    """Targeting an agent whose policy does not admit you is reported, not
    refused (CHOO-2137).

    The message goes to the room and the target declines it there, the same as
    an `@name` in an ordinary message — so the refusal is on the record in the
    room rather than only in the sender's account of it. What the sender gets
    back is `not_permitted` in place of a reachability status, because "live"
    for an agent that is about to say no is the reading that sends someone
    looking for a bug. Delegation still raises; a task is a row someone is
    expected to work.
    """

    def _restricted(self) -> dict:
        """Admits one specific other agent, so `sender` is not permitted."""
        return {"rules": [{"agents": ["someone-else"], "users": []}]}

    async def test_a_restricted_target_still_receives_the_message(self) -> None:
        svc, bodies = _build_service(
            participants=[_participant("alice", "agent", AgentStatus.LIVE)],
            roles=[],
            holders={},
            agents={"a-alice": _agent("alice", self._restricted())},
        )

        result = await svc.send_targeted_message("sender", "room-1", ["alice"], "ping")

        assert bodies == ["@alice ping"]
        assert result.event_id

    async def test_and_the_sender_is_told_it_will_be_declined(self) -> None:
        # Without this the sender reads "live" and has no way to tell a refusal
        # apart from an agent that simply had nothing to say.
        svc, _bodies = _build_service(
            participants=[_participant("alice", "agent", AgentStatus.LIVE)],
            roles=[],
            holders={},
            agents={"a-alice": _agent("alice", self._restricted())},
        )

        result = await svc.send_targeted_message("sender", "room-1", ["alice"], "ping")

        assert result.target_statuses == {"alice": AgentStatus.NOT_PERMITTED}

    async def test_permitted_name_target_posts(self) -> None:
        svc, bodies = _build_service(
            participants=[_participant("alice", "agent", AgentStatus.LIVE)],
            roles=[],
            holders={},
            agents={
                "a-alice": _agent(
                    "alice", {"rules": [{"agents": ["sender"], "users": []}]}
                )
            },
        )

        result = await svc.send_targeted_message("sender", "room-1", ["alice"], "ping")
        assert bodies == ["@alice ping"]
        assert result.target_statuses == {"alice": AgentStatus.LIVE}

    async def test_owner_rule_does_not_admit_an_agent_sender(self) -> None:
        # The sender agent shares alice's owner, but an owner rule admits the
        # human, not the agents acting for them.
        svc, bodies = _build_service(
            participants=[_participant("alice", "agent", AgentStatus.LIVE)],
            roles=[],
            holders={},
            agents={
                "a-alice": _agent(
                    "alice",
                    {"rules": [{"agents": [], "users": [], "owner": True}]},
                )
            },
        )

        result = await svc.send_targeted_message("sender", "room-1", ["alice"], "ping")
        assert result.target_statuses == {"alice": AgentStatus.NOT_PERMITTED}

    async def test_a_restricted_role_holder_is_reported_too(self) -> None:
        # Role targets are resolved to their live holders and checked the same
        # way, so a role mention cannot be used to make the answer look better
        # than naming the agent would.
        role = SimpleNamespace(id="r-mgr", name="manager")
        svc, bodies = _build_service(
            participants=[_participant("alice", "agent", AgentStatus.LIVE)],
            roles=[role],
            holders={"r-mgr": ["a-alice"]},
            agents={"a-alice": _agent("alice", self._restricted())},
        )

        result = await svc.send_targeted_message(
            "sender", "room-1", [], "standup", target_roles=["manager"]
        )

        assert bodies == ["@manager standup"]
        assert result.target_statuses == {"alice": AgentStatus.NOT_PERMITTED}

    async def test_user_target_is_not_gated(self) -> None:
        # The policy governs addressing an AGENT; a human target is the
        # bridge's business.
        svc, bodies = _build_service(
            participants=[_participant("dana", "user", None)],
            roles=[],
            holders={},
            agents={},
        )

        await svc.send_targeted_message("sender", "room-1", ["dana"], "ping")
        assert bodies == ["@dana ping"]

    async def test_group_scoped_policy_uses_the_rooms_group(self) -> None:
        policy = {"rules": [{"room_groups": ["g1"], "agents": ["sender"], "users": []}]}
        allowed, _bodies = _build_service(
            participants=[_participant("alice", "agent", AgentStatus.LIVE)],
            roles=[],
            holders={},
            agents={"a-alice": _agent("alice", policy)},
            group_id="g1",
        )
        in_group = await allowed.send_targeted_message(
            "sender", "room-1", ["alice"], "ping"
        )
        assert in_group.target_statuses == {"alice": AgentStatus.LIVE}

        denied, _denied_bodies = _build_service(
            participants=[_participant("alice", "agent", AgentStatus.LIVE)],
            roles=[],
            holders={},
            agents={"a-alice": _agent("alice", policy)},
            group_id="g2",
        )
        out_of_group = await denied.send_targeted_message(
            "sender", "room-1", ["alice"], "ping"
        )
        assert out_of_group.target_statuses == {"alice": AgentStatus.NOT_PERMITTED}
