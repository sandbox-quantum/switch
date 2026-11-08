"""The invite rule itself, on the policies Switch Console offers."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.addressing import (
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.agent_invites import (
    agent_may_invite,
    invite_refusal,
    person_may_invite,
)

_OWNER_ONLY = owner_only_policy([]).model_dump()
_DEFAULT = owner_and_owner_agents_policy().model_dump()


def _agent(policy: dict | None, owner_id: str | None = "alice") -> SimpleNamespace:
    return SimpleNamespace(addressing_policy=policy, owner_id=owner_id)


def _inviter(
    agent_id: str, owner_id: str | None, *, manages: bool = False
) -> SimpleNamespace:
    return SimpleNamespace(id=agent_id, owner_id=owner_id, can_manage_agents=manages)


def _person(agent: SimpleNamespace, user_id: str) -> bool:
    return person_may_invite(
        agent, room_id="room-1", group_id=None, user_id=user_id, external_user_ids=[]
    )


class TestPersonMayInvite:
    @pytest.mark.parametrize("policy", [_OWNER_ONLY, _DEFAULT])
    def test_the_owner_may(self, policy: dict) -> None:
        assert _person(_agent(policy), "alice")

    @pytest.mark.parametrize("policy", [_OWNER_ONLY, _DEFAULT])
    def test_someone_else_may_not(self, policy: dict) -> None:
        assert not _person(_agent(policy), "bob")

    def test_anyone_may_invite_an_open_agent(self) -> None:
        assert _person(_agent(None), "bob")

    def test_an_ownerless_restricted_agent_admits_nobody(self) -> None:
        assert not _person(_agent(_OWNER_ONLY, owner_id=None), "alice")

    def test_a_person_the_policy_names_by_account_may(self) -> None:
        policy = {"rules": [{"users": ["mm-bob"], "agents": []}]}
        assert person_may_invite(
            _agent(policy),
            room_id="room-1",
            group_id=None,
            user_id="bob",
            external_user_ids=["mm-bob"],
        )

    def test_a_rule_naming_other_rooms_does_not_admit_this_one(self) -> None:
        policy = {"rules": [{"rooms": ["room-2"], "users": "*", "agents": []}]}
        assert not _person(_agent(policy), "bob")


class TestAgentMayInvite:
    def test_the_owners_own_agent_under_the_default_policy(self) -> None:
        assert agent_may_invite(
            _agent(_DEFAULT), _inviter("a2", "alice"), room_id="r", group_id=None
        )

    def test_the_owners_own_agent_under_owner_only_is_refused(self) -> None:
        assert not agent_may_invite(
            _agent(_OWNER_ONLY), _inviter("a2", "alice"), room_id="r", group_id=None
        )

    def test_the_owners_managing_agent_may(self) -> None:
        assert agent_may_invite(
            _agent(_OWNER_ONLY),
            _inviter("a2", "alice", manages=True),
            room_id="r",
            group_id=None,
        )

    def test_another_owners_managing_agent_may_not(self) -> None:
        assert not agent_may_invite(
            _agent(_DEFAULT),
            _inviter("b2", "bob", manages=True),
            room_id="r",
            group_id=None,
        )

    def test_an_agent_granted_by_id(self) -> None:
        policy = owner_only_policy(["b2"]).model_dump()
        assert agent_may_invite(
            _agent(policy), _inviter("b2", "bob"), room_id="r", group_id=None
        )


def test_the_refusal_says_why_and_who_can() -> None:
    assert invite_refusal("**Helper (`helper`)**") == (
        "You can't invite **Helper (`helper`)**: it doesn't take instructions "
        "from you. Ask its owner to invite it, or to let you talk to it."
    )
