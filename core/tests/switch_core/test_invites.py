"""Who may put an agent into a room.

The gate is the one place every invite path is judged, so it is tested here
path by path — a person, an agent, a chat command's sender, and the
platform itself — against the same addressing policies delivery enforces.
The stores are fakes: the gate's logic is the reading of the policy, and
the Postgres-backed funnel tests live in `test_room_service_invites.py`.

A refusal has to say why and who can invite instead (the owner); a platform
join that names nobody is let through but disclosed, never trusted.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.addressing import (
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.delivery.addressing import AddressingResolver
from switch_core.invites import (
    AgentInviter,
    ChatSender,
    InviteGate,
    InviteRefused,
    PlatformInviter,
    UserInviter,
    actor_kind,
    unverified_notice,
)

OWNER = "user-owner"
STRANGER = "user-stranger"
BRIDGE = "bridge-1"

OWNER_ONLY = owner_only_policy([]).model_dump()
OWNER_AND_AGENTS = owner_and_owner_agents_policy().model_dump()


def _agent(
    agent_id: str,
    name: str,
    *,
    owner_id: str | None = OWNER,
    policy: dict | None = OWNER_ONLY,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=agent_id,
        name=name,
        display_name=None,
        owner_id=owner_id,
        addressing_policy=policy,
    )


class _Session:
    """Only what the gate reads through a session: the owner's row, for
    naming them in a refusal."""

    def __init__(self, users: dict[str, Any]) -> None:
        self._users = users

    async def get(self, _model: Any, pk: str) -> Any:
        return self._users.get(pk)


class _AgentStore:
    def __init__(self, agents: dict[str, Any]) -> None:
        self._agents = agents

    async def get(self, _session: Any, agent_id: str) -> Any:
        return self._agents.get(agent_id)

    async def get_by_client_id(self, _session: Any, _client_id: str) -> Any:
        return None


class _ExternalUserStore:
    """Accounts by id, who claimed them, and a user's accounts."""

    def __init__(
        self,
        *,
        by_external: dict[tuple[str, str], Any] | None = None,
        claimants: dict[str, list[str]] | None = None,
        by_user: dict[str, list[Any]] | None = None,
        by_client: dict[str, Any] | None = None,
    ) -> None:
        self._by_external = by_external or {}
        self._claimants = claimants or {}
        self._by_user = by_user or {}
        self._by_client = by_client or {}

    async def get_by_external_id(
        self, _session: Any, bridge_id: str, external_user_id: str
    ) -> Any:
        return self._by_external.get((bridge_id, external_user_id))

    async def claimant_ids(self, _session: Any, account_id: str) -> list[str]:
        return self._claimants.get(account_id, [])

    async def get_by_user(self, _session: Any, user_id: str) -> list[Any]:
        return self._by_user.get(user_id, [])

    async def get_by_client_id(self, _session: Any, client_id: str) -> Any:
        return self._by_client.get(client_id)


class _ClientStore:
    def __init__(self, by_transport: dict[str, Any]) -> None:
        self._by_transport = by_transport

    async def get_by_transport_user_id(
        self, _session: Any, transport_user_id: str
    ) -> Any:
        return self._by_transport.get(transport_user_id)


def _gate(
    *,
    agents: dict[str, Any],
    external: _ExternalUserStore | None = None,
    clients: _ClientStore | None = None,
    agents_by_client: dict[str, Any] | None = None,
) -> InviteGate:
    external = external or _ExternalUserStore()
    agent_store = _AgentStore(agents)
    if agents_by_client:

        async def get_by_client_id(
            _session: Any, client_id: str, _map: dict[str, Any] = agents_by_client
        ) -> Any:
            return _map.get(client_id)

        agent_store.get_by_client_id = get_by_client_id  # type: ignore[method-assign]
    resolver = AddressingResolver(
        room_store=SimpleNamespace(),  # type: ignore[arg-type]
        room_role_store=SimpleNamespace(),  # type: ignore[arg-type]
        client_store=clients or _ClientStore({}),  # type: ignore[arg-type]
        agent_store=agent_store,  # type: ignore[arg-type]
        external_user_store=external,  # type: ignore[arg-type]
        live_connection_ids=set,
    )
    return InviteGate(
        resolver=resolver,
        agent_store=agent_store,  # type: ignore[arg-type]
        external_user_store=external,
    )


def _session() -> _Session:
    return _Session(
        {
            OWNER: SimpleNamespace(id=OWNER, name="Olivia Owner"),
            STRANGER: SimpleNamespace(id=STRANGER, name="Stan Stranger"),
        }
    )


async def _check(gate: InviteGate, inviter: Any, agents: list[Any]) -> Any:
    return await gate.check(
        _session(), inviter, agents, room_id="room-1", group_id=None
    )


class TestUserInviter:
    async def test_the_owner_may_invite_their_owner_only_agent(self) -> None:
        gate = _gate(agents={"a1": _agent("a1", "helper.bot")})
        outcome = await _check(gate, UserInviter(OWNER), [_agent("a1", "helper.bot")])
        assert outcome.refused == []
        assert outcome.unverified == []

    async def test_a_stranger_is_refused_and_told_who_can(self) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": agent})
        outcome = await _check(gate, UserInviter(STRANGER), [agent])
        assert [r.agent_id for r in outcome.refused] == ["a1"]
        message = str(outcome.refused[0])
        assert "helper.bot" in message
        assert "doesn't take instructions from you" in message
        assert "its owner (Olivia Owner)" in message

    async def test_an_open_agent_admits_anyone(self) -> None:
        agent = _agent("a1", "open.bot", policy=None)
        gate = _gate(agents={"a1": agent})
        outcome = await _check(gate, UserInviter(STRANGER), [agent])
        assert outcome.refused == []

    async def test_no_admin_bypass(self) -> None:
        # An inviter is judged by the policy alone; there is no kind of
        # user the gate waves through.
        agent = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": agent})
        outcome = await _check(gate, UserInviter("user-admin"), [agent])
        assert [r.agent_id for r in outcome.refused] == ["a1"]


class TestAgentInviter:
    async def test_an_agent_of_the_same_owner_is_admitted(self) -> None:
        target = _agent("a1", "helper.bot", policy=OWNER_AND_AGENTS)
        sibling = _agent("a2", "sibling.bot", policy=None)
        gate = _gate(agents={"a1": target, "a2": sibling})
        outcome = await _check(gate, AgentInviter("a2"), [target])
        assert outcome.refused == []

    async def test_an_agent_of_another_owner_is_refused(self) -> None:
        target = _agent("a1", "helper.bot", policy=OWNER_AND_AGENTS)
        foreign = _agent("a2", "foreign.bot", owner_id=STRANGER, policy=None)
        gate = _gate(agents={"a1": target, "a2": foreign})
        outcome = await _check(gate, AgentInviter("a2"), [target])
        assert [r.agent_id for r in outcome.refused] == ["a1"]

    async def test_owner_only_refuses_even_the_owners_other_agents(self) -> None:
        target = _agent("a1", "helper.bot", policy=OWNER_ONLY)
        sibling = _agent("a2", "sibling.bot", policy=None)
        gate = _gate(agents={"a1": target, "a2": sibling})
        outcome = await _check(gate, AgentInviter("a2"), [target])
        assert [r.agent_id for r in outcome.refused] == ["a1"]

    async def test_an_agent_inviting_itself_is_always_allowed(self) -> None:
        target = _agent("a1", "helper.bot", policy=OWNER_ONLY)
        gate = _gate(agents={"a1": target})
        outcome = await _check(gate, AgentInviter("a1"), [target])
        assert outcome.refused == []

    async def test_an_unknown_agent_inviter_is_refused(self) -> None:
        target = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": target})
        outcome = await _check(gate, AgentInviter("gone"), [target])
        assert [r.agent_id for r in outcome.refused] == ["a1"]


class TestChatSender:
    def _clients(self) -> _ClientStore:
        return _ClientStore(
            {
                # The owner's member client: her in person.
                "@owner:switch.local": SimpleNamespace(
                    id="client-owner", type="member", user_id=OWNER
                ),
                # A platform account nobody has claimed.
                "@guest:switch.local": SimpleNamespace(
                    id="client-guest", type="human", user_id=None
                ),
            }
        )

    def _external(self) -> _ExternalUserStore:
        return _ExternalUserStore(
            by_client={
                "client-guest": SimpleNamespace(id="ext-guest"),
            },
            claimants={"ext-guest": []},
        )

    async def test_the_owner_typing_the_command_is_admitted(self) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(
            agents={"a1": agent}, external=self._external(), clients=self._clients()
        )
        outcome = await _check(gate, ChatSender("@owner:switch.local"), [agent])
        assert outcome.refused == []

    async def test_an_unclaimed_sender_is_told_to_link_their_account(
        self,
    ) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(
            agents={"a1": agent}, external=self._external(), clients=self._clients()
        )
        outcome = await _check(gate, ChatSender("@guest:switch.local"), [agent])
        assert [r.agent_id for r in outcome.refused] == ["a1"]
        assert "isn't linked to a Switch user" in str(outcome.refused[0])

    async def test_an_unresolvable_sender_is_refused(self) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": agent})
        outcome = await _check(gate, ChatSender("@nobody:switch.local"), [agent])
        assert [r.agent_id for r in outcome.refused] == ["a1"]


class TestPlatformInviter:
    def _external(self) -> _ExternalUserStore:
        return _ExternalUserStore(
            by_external={
                (BRIDGE, "U-OWNER"): SimpleNamespace(id="ext-owner"),
                (BRIDGE, "U-STRANGER"): SimpleNamespace(id="ext-stranger"),
                (BRIDGE, "U-UNCLAIMED"): SimpleNamespace(id="ext-unclaimed"),
            },
            claimants={
                "ext-owner": [OWNER],
                "ext-stranger": [STRANGER],
                "ext-unclaimed": [],
            },
        )

    async def test_judged_as_the_person_who_added_the_bot(self) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": agent}, external=self._external())
        outcome = await _check(gate, PlatformInviter(BRIDGE, "U-OWNER"), [agent])
        assert outcome.refused == []

    async def test_a_stranger_who_added_the_bot_is_refused(self) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": agent}, external=self._external())
        outcome = await _check(gate, PlatformInviter(BRIDGE, "U-STRANGER"), [agent])
        assert [r.agent_id for r in outcome.refused] == ["a1"]

    async def test_an_unclaimed_adder_is_never_trusted(self) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": agent}, external=self._external())
        outcome = await _check(gate, PlatformInviter(BRIDGE, "U-UNCLAIMED"), [agent])
        assert [r.agent_id for r in outcome.refused] == ["a1"]
        assert "isn't linked to a Switch user" in str(outcome.refused[0])

    async def test_an_unknown_account_is_never_trusted(self) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": agent}, external=self._external())
        outcome = await _check(gate, PlatformInviter(BRIDGE, "U-NEW"), [agent])
        assert [r.agent_id for r in outcome.refused] == ["a1"]

    async def test_an_unnamed_adder_lets_a_restricted_agent_in_unverified(
        self,
    ) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": agent}, external=self._external())
        outcome = await _check(gate, PlatformInviter(BRIDGE, None), [agent])
        assert outcome.refused == []
        assert outcome.unverified == [agent]

    async def test_an_unnamed_adder_and_an_open_agent_disclose_nothing(
        self,
    ) -> None:
        agent = _agent("a1", "open.bot", policy=None)
        gate = _gate(agents={"a1": agent}, external=self._external())
        outcome = await _check(gate, PlatformInviter(BRIDGE, None), [agent])
        assert outcome.refused == []
        assert outcome.unverified == []


class TestRequire:
    async def test_require_raises_the_combined_refusal(self) -> None:
        gate = _gate(
            agents={
                "a1": _agent("a1", "helper.bot"),
                "a2": _agent("a2", "other.bot"),
            }
        )
        with pytest.raises(InviteRefused) as caught:
            await gate.require(
                _session(),
                UserInviter(STRANGER),
                ["a1", "a2"],
                room_id="",
                group_id=None,
            )
        assert caught.value.agent_ids == ["a1", "a2"]
        assert isinstance(caught.value, PermissionError)

    async def test_require_passes_an_unverified_platform_join(self) -> None:
        agent = _agent("a1", "helper.bot")
        gate = _gate(agents={"a1": agent})
        outcome = await gate.require(
            _session(),
            PlatformInviter(BRIDGE, None),
            ["a1"],
            room_id="",
            group_id=None,
        )
        assert outcome.unverified == [agent]


class TestWordingAndKinds:
    def test_the_unverified_notice_names_the_agent_and_the_way_out(
        self,
    ) -> None:
        agent = _agent("a1", "helper.bot")
        notice = unverified_notice(agent, "olivia")
        assert "helper.bot" in notice
        assert "didn't say who added it" in notice
        assert "@olivia" in notice
        assert "!remove-agent @helper.bot" in notice

    def test_actor_kinds(self) -> None:
        assert actor_kind(UserInviter(OWNER)) == "user"
        assert actor_kind(AgentInviter("a1")) == "agent"
        assert actor_kind(ChatSender("@x:switch.local")) == "user"
        assert actor_kind(PlatformInviter(BRIDGE, None)) == "system"
        assert actor_kind(PlatformInviter(BRIDGE, "U1")) == "user"
