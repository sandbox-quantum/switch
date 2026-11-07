"""Who may bring an agent into a room (#805).

The gate never restates a policy. These tests pin that down two ways:

- each way of saying who is asking resolves to the principal an addressing
  policy is written in, and
- for every policy shape and every inviter, the gate's answer is exactly the
  answer `can_address` gives for a message from that principal.

The second is the important one: if "may invite" ever drifts from "may
address", one of these fails.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from switch_core.addressing import (
    AddressingPolicy,
    AddressingRule,
    can_address,
    default_agent_policy,
    owner_only_policy,
    parse_policy,
)
from switch_core.delivery.addressing import AddressingDecision, SenderPrincipal
from switch_core.invites import (
    InviteGate,
    Inviter,
    InviteRefused,
    invite_refusal,
    needs_disclosure,
    unverified_join_notice,
)

OWNER = "user-owner"
STRANGER = "user-stranger"
ROOM = "room-1"


@dataclass
class _Agent:
    id: str
    name: str
    owner_id: str | None
    addressing_policy: object

    @property
    def display_name(self) -> str | None:
        return None


class _AgentStore:
    def __init__(self, agents: list[_Agent]) -> None:
        self._by_id = {agent.id: agent for agent in agents}

    async def get(self, _session: object, agent_id: str) -> _Agent | None:
        return self._by_id.get(agent_id)


class _ExternalUserStore:
    """Platform accounts by `(bridge, external id)`, plus who has claimed them."""

    def __init__(self, accounts: dict[tuple[str, str], tuple[str, list[str]]]) -> None:
        self._accounts = accounts

    async def get_by_external_id(
        self, _session: object, bridge_id: str, external_user_id: str
    ) -> SimpleNamespace | None:
        found = self._accounts.get((bridge_id, external_user_id))
        if found is None:
            return None
        return SimpleNamespace(id=found[0])

    async def claimant_ids(self, _session: object, account_id: str) -> list[str]:
        for account, claimants in self._accounts.values():
            if account == account_id:
                return claimants
        raise AssertionError("unknown account")


class _Resolver:
    """The part of the real resolver `judge` uses, without a database.

    `AddressingResolver.judge` is a thin wrapper over `can_address`; this stub
    keeps these tests to the gate. It records what it was asked, so a test can
    assert the inviter reached it as the right principal (or did not reach it
    at all).
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, SenderPrincipal, str, str | None]] = []

    async def judge(
        self,
        _session: object,
        *,
        agent: _Agent,
        principal: SenderPrincipal,
        room_id: str,
        group_id: str | None,
    ) -> AddressingDecision:
        self.calls.append((agent.id, principal, room_id, group_id))
        allowed = can_address(
            parse_policy(agent.addressing_policy),
            room_id=room_id,
            group_id=group_id,
            sender_kind=principal.kind,
            sender_id=principal.id,
            sender_user_ids=principal.user_ids,
            sender_owner_user_id=principal.owner_user_id,
            owner_user_id=agent.owner_id,
        )
        return AddressingDecision(allowed=allowed, refusal="" if allowed else "no")

    async def resolve_sender(
        self, _session: object, _transport_id: str
    ) -> SenderPrincipal | None:
        return SenderPrincipal("user", "account-9", [OWNER], None)


def _gate(
    agents: list[_Agent],
    accounts: dict[tuple[str, str], tuple[str, list[str]]] | None = None,
) -> tuple[InviteGate, _Resolver]:
    resolver = _Resolver()
    return (
        InviteGate(
            resolver=resolver,  # type: ignore[arg-type]
            agent_store=_AgentStore(agents),  # type: ignore[arg-type]
            external_user_store=_ExternalUserStore(accounts or {}),  # type: ignore[arg-type]
        ),
        resolver,
    )


POLICIES: dict[str, AddressingPolicy] = {
    "open": parse_policy(None),
    "owner_only": owner_only_policy([]),
    "default": default_agent_policy(),
    "stranger_only": AddressingPolicy(
        rules=[AddressingRule(users=[STRANGER], agents=[])]
    ),
    "agents_only": AddressingPolicy(
        rules=[AddressingRule(users=[], agents=["agent-manager"])]
    ),
    "one_room": AddressingPolicy(rules=[AddressingRule(rooms=[ROOM], agents=[])]),
    "one_group": AddressingPolicy(
        rules=[AddressingRule(room_groups=["group-1"], agents=[])]
    ),
}


def _agent(
    agent_id: str = "agent-1", policy: object = None, owner: str | None = OWNER
) -> _Agent:
    return _Agent(id=agent_id, name=agent_id, owner_id=owner, addressing_policy=policy)


async def _refused(
    gate: InviteGate,
    inviter: Inviter,
    agents: list[_Agent],
    *,
    room_id: str = ROOM,
    group_id: str | None = None,
) -> list[str]:
    return [
        agent.id
        for agent in await gate.refused(
            object(),  # type: ignore[arg-type]
            inviter,
            agents,  # type: ignore[arg-type]
            room_id=room_id,
            group_id=group_id,
        )
    ]


class TestInviterShape:
    async def test_person_is_a_user_principal_with_that_one_user(self) -> None:
        target = _agent(policy=owner_only_policy([]))
        gate, resolver = _gate([target])
        assert await _refused(gate, Inviter.person(OWNER), [target]) == []
        ((_agent_id, principal, room, group),) = resolver.calls
        assert principal == SenderPrincipal("user", "", [OWNER], None)
        assert (room, group) == (ROOM, None)

    async def test_agent_is_judged_as_itself_not_its_owner(self) -> None:
        manager = _agent("agent-manager", default_agent_policy())
        target = _agent("agent-1", default_agent_policy())
        gate, resolver = _gate([manager, target])
        assert await _refused(gate, Inviter.agent("agent-manager"), [target]) == []
        ((_agent_id, principal, _room, _group),) = resolver.calls
        assert principal == SenderPrincipal("agent", "agent-manager", [], OWNER)

    async def test_unknown_agent_inviter_is_nobody(self) -> None:
        target = _agent(policy=owner_only_policy([]))
        gate, resolver = _gate([target])
        assert await _refused(gate, Inviter.agent("agent-missing"), [target]) == [
            "agent-1"
        ]
        assert resolver.calls == []

    async def test_platform_adder_resolves_claims_from_the_platform_account(
        self,
    ) -> None:
        target = _agent(policy=owner_only_policy([]))
        gate, resolver = _gate([target], {("bridge-1", "U1"): ("account-1", [OWNER])})
        inviter = Inviter.platform_adder("bridge-1", "U1")
        assert await _refused(gate, inviter, [target]) == []
        ((_agent_id, principal, _room, _group),) = resolver.calls
        assert principal == SenderPrincipal("user", "account-1", [OWNER], None)

    async def test_an_unclaimed_platform_account_is_nobody(self) -> None:
        target = _agent(policy=owner_only_policy([]))
        gate, resolver = _gate([target], {("bridge-1", "U1"): ("account-1", [])})
        inviter = Inviter.platform_adder("bridge-1", "U1")
        assert await _refused(gate, inviter, [target]) == ["agent-1"]

    async def test_command_sender_resolves_through_the_resolver(self) -> None:
        target = _agent(policy=owner_only_policy([]))
        gate, resolver = _gate([target])
        inviter = Inviter.command_sender("@u:test")
        assert await _refused(gate, inviter, [target]) == []
        ((_agent_id, principal, _room, _group),) = resolver.calls
        assert principal == SenderPrincipal("user", "account-9", [OWNER], None)

    async def test_person_inviter_does_not_consult_their_platform_claims(
        self,
    ) -> None:
        """A rule naming a platform account is about that platform, not a sign-in."""
        target = _agent(
            policy=AddressingPolicy(
                rules=[AddressingRule(users=[], agents=[], platform=True)]
            )
        )
        gate, _resolver = _gate([target], {("bridge-1", "U1"): ("account-1", [OWNER])})
        assert await _refused(gate, Inviter.person(OWNER), [target]) == ["agent-1"]


class TestParityWithAddressing:
    """Every judged inviter gets exactly the answer a message from them gets."""

    @pytest.mark.parametrize("policy_name", sorted(POLICIES))
    @pytest.mark.parametrize(
        "inviter",
        [
            Inviter.person(OWNER),
            Inviter.person(STRANGER),
            Inviter.agent("agent-manager"),
            Inviter.agent("agent-1"),
            Inviter.agent("agent-other"),
        ],
        ids=lambda inviter: f"{inviter.kind}:{inviter.subject}",
    )
    async def test_gate_matches_can_address(
        self, policy_name: str, inviter: Inviter
    ) -> None:
        policy = POLICIES[policy_name]
        manager = _agent("agent-manager", POLICIES["default"])
        other_agent = _agent("agent-other", POLICIES["default"])
        target = _agent("agent-1", policy)
        gate, _resolver = _gate([manager, other_agent, target])

        if inviter.kind == "person":
            principal = SenderPrincipal("user", "", [inviter.subject], None)
        else:
            principal = SenderPrincipal("agent", inviter.subject, [], OWNER)

        self_seating = inviter.kind == "agent" and inviter.subject == target.id
        expected = self_seating or can_address(
            policy,
            room_id=ROOM,
            group_id=None,
            sender_kind=principal.kind,
            sender_id=principal.id,
            sender_user_ids=principal.user_ids,
            sender_owner_user_id=principal.owner_user_id,
            owner_user_id=target.owner_id,
        )
        refused = await _refused(gate, inviter, [target])
        assert bool(refused) is (not expected)
        if refused:
            assert refused == [target.id]

    async def test_room_scoped_rule_sees_the_room(self) -> None:
        target = _agent(policy=POLICIES["one_room"])
        gate, _resolver = _gate([target])
        inviter = Inviter.person(STRANGER)
        assert await _refused(gate, inviter, [target]) == []
        assert await _refused(gate, inviter, [target], room_id="room-2") == ["agent-1"]

    async def test_group_scoped_rule_sees_the_group(self) -> None:
        target = _agent(policy=POLICIES["one_group"])
        gate, _resolver = _gate([target])
        inviter = Inviter.person(STRANGER)
        assert await _refused(gate, inviter, [target], group_id="group-1") == []
        assert await _refused(gate, inviter, [target], group_id="group-2") == [
            "agent-1"
        ]

    async def test_a_room_not_yet_made_is_not_admitted_by_a_room_scoped_rule(
        self,
    ) -> None:
        target = _agent(policy=POLICIES["one_room"])
        gate, _resolver = _gate([target])
        assert await _refused(gate, Inviter.person(STRANGER), [target], room_id="") == [
            "agent-1"
        ]


class TestUnjudgedInviters:
    async def test_system_is_never_judged(self) -> None:
        target = _agent(policy=owner_only_policy([]))
        gate, resolver = _gate([target])
        assert await _refused(gate, Inviter.system("test"), [target]) == []
        assert resolver.calls == []

    async def test_unknown_is_allowed_but_never_named(self) -> None:
        restricted = _agent(policy=owner_only_policy([]))
        open_agent = _agent("agent-open", parse_policy(None))
        gate, resolver = _gate([restricted, open_agent])
        assert (
            await _refused(gate, Inviter.unknown_adder(), [restricted, open_agent])
            == []
        )
        assert resolver.calls == []

    async def test_nobody_speaks_for_agents_they_were_not_named_for(self) -> None:
        owned = _agent("agent-owned", owner_only_policy([]))
        stranger_agent = _agent("agent-stranger", owner_only_policy([]))
        gate, _resolver = _gate(
            [owned, stranger_agent], {("bridge-1", "U1"): ("account-1", [OWNER])}
        )
        inviter = Inviter.platform_adder("bridge-1", "U1").only_for(["agent-owned"])
        assert await _refused(gate, inviter, [owned]) == []
        # The platform named this person for one bot only; the other is not
        # theirs to answer for, so it is not refused either.
        assert await _refused(gate, inviter, [stranger_agent]) == []

    async def test_narrowing_an_unknown_adder_does_not_make_it_attributed(
        self,
    ) -> None:
        """An unknown adder stays unknown, even when one bot was named."""
        inviter = Inviter.unknown_adder().only_for(["agent-1"])
        assert inviter.kind == "unknown"
        assert inviter.speaks_for is None

    async def test_an_agent_seating_itself_is_not_refused_by_its_own_rule(
        self,
    ) -> None:
        target = _agent("agent-1", owner_only_policy([]))
        gate, resolver = _gate([target])
        assert await _refused(gate, Inviter.agent("agent-1"), [target]) == []
        assert resolver.calls == []

    async def test_a_run_brings_what_it_created(self) -> None:
        runner = Inviter.agent("agent-manager")
        assert runner.having_created(["agent-new"]).vouched_for == frozenset(
            {"agent-new"}
        )
        # Anyone else's "run" vouches for nothing: a person's created agents
        # are admitted by their own policy like any other invite.
        assert Inviter.person(OWNER).having_created(["agent-new"]).vouched_for == (
            frozenset()
        )

    async def test_vouched_for_agents_come_with_the_runner(self) -> None:
        runner = _agent("agent-manager", owner_only_policy([]))
        created = _agent("agent-new", owner_only_policy([]))
        gate, _resolver = _gate([runner, created])
        inviter = Inviter.agent(
            "agent-manager", created_for_this_run=frozenset({"agent-new"})
        )
        assert await _refused(gate, inviter, [created]) == []

    async def test_an_agent_a_run_did_not_create_is_still_judged(self) -> None:
        runner = _agent("agent-manager", owner_only_policy([]))
        someone_elses = _agent("agent-elses", owner_only_policy([]))
        gate, _resolver = _gate([runner, someone_elses])
        inviter = Inviter.agent(
            "agent-manager", created_for_this_run=frozenset({"agent-new"})
        )
        assert await _refused(gate, inviter, [someone_elses]) == ["agent-elses"]


class TestRefusal:
    def test_names_agents_and_says_who_can(self) -> None:
        target = _agent("agent-1", owner_only_policy([]))
        refused = InviteRefused([target], Inviter.person(STRANGER))  # type: ignore[list-item]
        assert isinstance(refused, PermissionError)
        assert refused.agent_ids == ["agent-1"]
        assert "owner" in str(refused)
        assert "agent-1" in str(refused)

    def test_chat_inviter_is_told_how_to_prove_who_they_are(self) -> None:
        target = _agent("agent-1", owner_only_policy([]))
        text = invite_refusal([target], Inviter.command_sender("@u:test"))  # type: ignore[list-item]
        assert "link this chat account" in text

    def test_a_gateway_inviter_is_not_told_about_chat_linking(self) -> None:
        target = _agent("agent-1", owner_only_policy([]))
        text = invite_refusal([target], Inviter.person(STRANGER))  # type: ignore[list-item]
        assert "chat account" not in text

    def test_it_never_says_where_the_agent_already_is(self) -> None:
        target = _agent("agent-1", owner_only_policy([]))
        text = invite_refusal([target], Inviter.person(STRANGER))  # type: ignore[list-item]
        assert ROOM not in text
        assert "room" not in text


class TestDisclosure:
    def test_a_restricted_agent_is_disclosed(self) -> None:
        assert needs_disclosure(_agent(policy=owner_only_policy([]))) is True  # type: ignore[arg-type]

    def test_an_open_agent_is_not(self) -> None:
        assert needs_disclosure(_agent(policy=parse_policy(None))) is False  # type: ignore[arg-type]

    def test_channel_notice_names_the_owner_without_accusing_anyone(self) -> None:
        notice = unverified_join_notice(_agent(), "alex")  # type: ignore[arg-type]
        assert "@alex" in notice
        assert "didn't say who added it" in notice
        assert "wasn't expected" in notice

    def test_channel_notice_without_a_linked_owner_still_names_the_role(self) -> None:
        notice = unverified_join_notice(_agent(), None)  # type: ignore[arg-type]
        assert "its owner" in notice
        assert "@" not in notice
