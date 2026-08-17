from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.addressing import (
    AddressingPolicy,
    AddressingRule,
    can_address,
    owner_and_owner_agents_policy,
    owner_only_policy,
    parse_policy,
)


def _allows(policy: AddressingPolicy, **kw: object) -> bool:
    defaults = dict(
        room_id="room-1",
        group_id=None,
        sender_kind="user",
        sender_id="u1",
        sender_user_ids=[],
        sender_owner_user_id=None,
        owner_user_id=None,
    )
    defaults.update(kw)
    return can_address(policy, **defaults)  # type: ignore[arg-type]


class TestOpenPolicy:
    """No rules → open: anyone may address (today's behaviour, preserved)."""

    def test_empty_policy_allows_everyone(self) -> None:
        policy = AddressingPolicy()
        assert policy.is_open() is True
        assert _allows(policy, sender_kind="user", sender_id="anyone") is True
        assert _allows(policy, sender_kind="agent", sender_id="any-agent") is True

    def test_parse_none_is_open(self) -> None:
        assert parse_policy(None).is_open() is True

    def test_parse_empty_dict_is_open(self) -> None:
        assert parse_policy({}).is_open() is True

    def test_policy_with_rules_is_not_open(self) -> None:
        policy = AddressingPolicy(rules=[AddressingRule()])
        assert policy.is_open() is False


class TestDenyByDefault:
    """With rules present, only matching attempts are permitted."""

    def test_wildcard_rule_allows_all(self) -> None:
        # A single all-"*" rule is equivalent to open, but explicitly so.
        policy = AddressingPolicy(rules=[AddressingRule()])
        assert _allows(policy, sender_kind="user", sender_id="u1") is True
        assert _allows(policy, sender_kind="agent", sender_id="a1") is True

    def test_non_matching_room_denied(self) -> None:
        policy = AddressingPolicy(rules=[AddressingRule(rooms=["room-9"])])
        assert _allows(policy, room_id="room-1") is False
        assert _allows(policy, room_id="room-9") is True


class TestSenderKinds:
    """`users` matches human senders; `agents` matches agent senders. The two
    are independent: an empty list on one kind excludes it entirely."""

    def test_users_only_excludes_agents(self) -> None:
        # owner-only shape: allow one human, no agents.
        policy = AddressingPolicy(rules=[AddressingRule(users=["owner"], agents=[])])
        assert _allows(policy, sender_kind="user", sender_id="owner") is True
        assert _allows(policy, sender_kind="user", sender_id="someone") is False
        assert _allows(policy, sender_kind="agent", sender_id="owner") is False

    def test_agents_only_excludes_users(self) -> None:
        policy = AddressingPolicy(rules=[AddressingRule(users=[], agents=["a1"])])
        assert _allows(policy, sender_kind="agent", sender_id="a1") is True
        assert _allows(policy, sender_kind="agent", sender_id="a2") is False
        assert _allows(policy, sender_kind="user", sender_id="a1") is False

    def test_empty_subset_matches_nothing(self) -> None:
        # A rule with both sender dimensions empty admits no one.
        policy = AddressingPolicy(rules=[AddressingRule(users=[], agents=[])])
        assert _allows(policy, sender_kind="user", sender_id="u1") is False
        assert _allows(policy, sender_kind="agent", sender_id="a1") is False


class TestRoomAndGroupScoping:
    def test_room_subset(self) -> None:
        policy = AddressingPolicy(rules=[AddressingRule(rooms=["r1", "r2"])])
        assert _allows(policy, room_id="r1") is True
        assert _allows(policy, room_id="r3") is False

    def test_group_subset(self) -> None:
        policy = AddressingPolicy(rules=[AddressingRule(room_groups=["g1"])])
        assert _allows(policy, group_id="g1") is True
        assert _allows(policy, group_id="g2") is False

    def test_ungrouped_room_only_matches_wildcard_group(self) -> None:
        # group_id None (ungrouped room) is admitted by "*" but not by a subset.
        wildcard = AddressingPolicy(rules=[AddressingRule(room_groups="*")])
        subset = AddressingPolicy(rules=[AddressingRule(room_groups=["g1"])])
        assert _allows(wildcard, group_id=None) is True
        assert _allows(subset, group_id=None) is False

    def test_room_and_group_are_conjunctive(self) -> None:
        # Both must match within a single rule.
        policy = AddressingPolicy(
            rules=[AddressingRule(rooms=["r1"], room_groups=["g1"])]
        )
        assert _allows(policy, room_id="r1", group_id="g1") is True
        assert _allows(policy, room_id="r1", group_id="g2") is False
        assert _allows(policy, room_id="r2", group_id="g1") is False


class TestMultipleRules:
    def test_any_rule_permits(self) -> None:
        # Two rules: humans in r1, or agent a1 anywhere.
        policy = AddressingPolicy(
            rules=[
                AddressingRule(rooms=["r1"], agents=[]),
                AddressingRule(agents=["a1"], users=[]),
            ]
        )
        assert _allows(policy, room_id="r1", sender_kind="user", sender_id="u1") is True
        assert (
            _allows(policy, room_id="r2", sender_kind="user", sender_id="u1") is False
        )
        assert (
            _allows(policy, room_id="r2", sender_kind="agent", sender_id="a1") is True
        )
        assert (
            _allows(policy, room_id="r2", sender_kind="agent", sender_id="a2") is False
        )


class TestOwnerRule:
    """`owner=True` admits the agent's owner as a symbolic subject, resolved
    at enforcement time from `owner_user_id` and the set of Switch users who
    have claimed the sender's platform account."""

    def _policy(self) -> AddressingPolicy:
        # Owner and nobody else: no other human, no agent.
        return AddressingPolicy(rules=[AddressingRule(users=[], agents=[], owner=True)])

    def test_owner_matches(self) -> None:
        assert (
            _allows(
                self._policy(),
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is True
        )

    def test_different_user_denied(self) -> None:
        assert (
            _allows(
                self._policy(),
                sender_kind="user",
                sender_id="ext-9",
                sender_user_ids=["user-2"],
                owner_user_id="user-1",
            )
            is False
        )

    def test_owner_among_several_claimants_matches(self) -> None:
        # Claiming is not exclusive: a shared or duplicated account may be
        # claimed by several Switch users, and the owner need only be one of
        # them. Requiring them to be the sole claimant would let anyone else
        # deny the owner their own agent just by claiming the account too.
        assert (
            _allows(
                self._policy(),
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=["user-2", "user-1", "user-3"],
                owner_user_id="user-1",
            )
            is True
        )

    def test_claimants_without_the_owner_denied(self) -> None:
        # Claimed, just not by the owner — a stranger's claim admits nobody.
        assert (
            _allows(
                self._policy(),
                sender_kind="user",
                sender_id="ext-9",
                sender_user_ids=["user-2", "user-3"],
                owner_user_id="user-1",
            )
            is False
        )

    def test_ownerless_agent_denies(self) -> None:
        # No owner to match against — not a permissive guess.
        assert (
            _allows(
                self._policy(),
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=["user-1"],
                owner_user_id=None,
            )
            is False
        )

    def test_unclaimed_identity_denies(self) -> None:
        # The platform identity belongs to no Switch user, so it cannot be
        # recognised as the owner even if the human behind it is.
        assert (
            _allows(
                self._policy(),
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=[],
                owner_user_id="user-1",
            )
            is False
        )

    def test_both_none_denies(self) -> None:
        assert (
            _allows(
                self._policy(),
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=[],
                owner_user_id=None,
            )
            is False
        )

    def test_agent_sender_is_never_the_owner(self) -> None:
        # An agent owned by the same person is still just an agent: it must be
        # admitted through `agents`, never through `owner`.
        assert (
            _allows(
                self._policy(),
                sender_kind="agent",
                sender_id="agent-7",
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is False
        )

    def test_owner_still_scoped_by_room(self) -> None:
        # `owner` widens the sender dimension, not the room/group ones.
        policy = AddressingPolicy(
            rules=[AddressingRule(rooms=["r1"], users=[], agents=[], owner=True)]
        )
        assert (
            _allows(
                policy,
                room_id="r1",
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is True
        )
        assert (
            _allows(
                policy,
                room_id="r2",
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is False
        )

    def test_owner_flag_off_ignores_the_ids(self) -> None:
        policy = AddressingPolicy(rules=[AddressingRule(users=[], agents=[])])
        assert (
            _allows(
                policy,
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is False
        )


class TestOwnerAgentsRule:
    """`owner_agents`: any agent the target's owner also owns (CHOO-2137).

    The counterpart to `owner` on the other side of the sender split. It exists
    because an owner's orchestration is the owner acting: a manager agent
    handing work to a worker both belong to the same person, and listing each
    one by id goes stale the next time they register one.
    """

    OWNED = AddressingPolicy(
        rules=[AddressingRule(users=[], agents=[], owner_agents=True)]
    )

    def test_an_agent_of_the_same_owner_is_admitted(self) -> None:
        assert (
            _allows(
                self.OWNED,
                sender_kind="agent",
                sender_id="manager",
                sender_owner_user_id="user-1",
                owner_user_id="user-1",
            )
            is True
        )

    def test_somebody_elses_agent_is_not(self) -> None:
        assert (
            _allows(
                self.OWNED,
                sender_kind="agent",
                sender_id="their-manager",
                sender_owner_user_id="user-2",
                owner_user_id="user-1",
            )
            is False
        )

    def test_an_unowned_sender_does_not_inherit_the_fleet(self) -> None:
        # Ownerless is not a wildcard. An agent registered without an owner
        # must not slip into every owner-scoped policy at once.
        assert (
            _allows(
                self.OWNED,
                sender_kind="agent",
                sender_id="orphan",
                sender_owner_user_id=None,
                owner_user_id="user-1",
            )
            is False
        )

    def test_an_unowned_target_admits_nobody_this_way(self) -> None:
        # Two ownerless agents are not each other's, and matching None to None
        # would make them so.
        assert (
            _allows(
                self.OWNED,
                sender_kind="agent",
                sender_id="orphan",
                sender_owner_user_id=None,
                owner_user_id=None,
            )
            is False
        )

    def test_it_does_not_let_the_owner_in_as_a_human(self) -> None:
        # The two subjects are separate on purpose: "my agents may" is not
        # "I may". Only `owner` admits the person.
        assert (
            _allows(
                self.OWNED,
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is False
        )

    def test_it_is_still_scoped_by_room(self) -> None:
        policy = AddressingPolicy(
            rules=[AddressingRule(rooms=["r1"], users=[], agents=[], owner_agents=True)]
        )
        for room, expected in (("r1", True), ("r2", False)):
            assert (
                _allows(
                    policy,
                    room_id=room,
                    sender_kind="agent",
                    sender_id="manager",
                    sender_owner_user_id="user-1",
                    owner_user_id="user-1",
                )
                is expected
            )

    def test_off_by_default_for_a_policy_written_before_it_existed(self) -> None:
        # Stored policies carry no `owner_agents` key. Reading absence as true
        # would quietly widen every existing owner-only agent.
        policy = parse_policy({"rules": [{"users": [], "agents": [], "owner": True}]})
        assert policy.rules[0].owner_agents is False
        assert (
            _allows(
                policy,
                sender_kind="agent",
                sender_id="manager",
                sender_owner_user_id="user-1",
                owner_user_id="user-1",
            )
            is False
        )


class TestOwnerAndOwnerAgentsPolicy:
    """The shape a Switch Console agent is created on."""

    def test_admits_the_owner_and_their_agents(self) -> None:
        policy = owner_and_owner_agents_policy()
        assert (
            _allows(
                policy,
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is True
        )
        assert (
            _allows(
                policy,
                sender_kind="agent",
                sender_id="manager",
                sender_owner_user_id="user-1",
                owner_user_id="user-1",
            )
            is True
        )

    def test_and_nobody_else(self) -> None:
        policy = owner_and_owner_agents_policy()
        assert (
            _allows(
                policy,
                sender_kind="user",
                sender_id="ext-9",
                sender_user_ids=["user-2"],
                owner_user_id="user-1",
            )
            is False
        )
        assert (
            _allows(
                policy,
                sender_kind="agent",
                sender_id="their-agent",
                sender_owner_user_id="user-2",
                owner_user_id="user-1",
            )
            is False
        )

    def test_shape(self) -> None:
        assert owner_and_owner_agents_policy().model_dump() == {
            "rules": [
                {
                    "rooms": "*",
                    "room_groups": "*",
                    "users": [],
                    "agents": [],
                    "owner": True,
                    "owner_agents": True,
                }
            ]
        }


class TestOwnerOnlyPolicy:
    """Strictly the owner: the narrower of the two shortcuts."""

    def test_admits_only_the_owner(self) -> None:
        policy = owner_only_policy([])
        assert policy.is_open() is False
        assert (
            _allows(
                policy,
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is True
        )
        assert (
            _allows(
                policy,
                sender_kind="user",
                sender_id="ext-9",
                sender_user_ids=["user-2"],
                owner_user_id="user-1",
            )
            is False
        )
        assert (
            _allows(
                policy,
                sender_kind="agent",
                sender_id="agent-7",
                sender_user_ids=[],
                owner_user_id="user-1",
            )
            is False
        )

    def test_allowed_agent_is_let_in(self) -> None:
        # How a dispatcher (manager / orchestrator) is granted access.
        policy = owner_only_policy(["dispatcher"])
        assert (
            _allows(
                policy,
                sender_kind="agent",
                sender_id="dispatcher",
                sender_user_ids=[],
                owner_user_id="user-1",
            )
            is True
        )
        assert (
            _allows(
                policy,
                sender_kind="agent",
                sender_id="other-agent",
                sender_user_ids=[],
                owner_user_id="user-1",
            )
            is False
        )
        # Still owner-only on the human side.
        assert (
            _allows(
                policy,
                sender_kind="user",
                sender_id="dispatcher",
                sender_user_ids=["user-2"],
                owner_user_id="user-1",
            )
            is False
        )
        assert (
            _allows(
                policy,
                sender_kind="user",
                sender_id="ext-3",
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is True
        )

    def test_applies_in_every_room(self) -> None:
        policy = owner_only_policy([])
        assert (
            _allows(
                policy,
                room_id="any-room",
                group_id="any-group",
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is True
        )
        assert (
            _allows(
                policy,
                room_id="other-room",
                group_id=None,
                sender_user_ids=["user-1"],
                owner_user_id="user-1",
            )
            is True
        )

    def test_shape(self) -> None:
        assert owner_only_policy(["a1"]).model_dump() == {
            "rules": [
                {
                    "rooms": "*",
                    "room_groups": "*",
                    "users": [],
                    "agents": ["a1"],
                    "owner": True,
                    "owner_agents": False,
                }
            ]
        }


class TestRequiresOwnerIdentity:
    """Flags a policy that admits nobody until the owner claims an identity."""

    def test_false_when_open(self) -> None:
        assert AddressingPolicy().requires_owner_identity() is False

    def test_false_without_owner_rules(self) -> None:
        policy = AddressingPolicy(rules=[AddressingRule(users=["u1"], agents=[])])
        assert policy.requires_owner_identity() is False

    def test_true_when_any_rule_is_owner_scoped(self) -> None:
        policy = AddressingPolicy(
            rules=[
                AddressingRule(users=["u1"], agents=[]),
                AddressingRule(users=[], agents=[], owner=True),
            ]
        )
        assert policy.requires_owner_identity() is True

    def test_true_for_owner_only_policy(self) -> None:
        assert owner_only_policy([]).requires_owner_identity() is True


class TestValidation:
    def test_rejects_bad_dimension_scalar(self) -> None:
        with pytest.raises(ValidationError):
            AddressingRule(rooms="everyone")  # type: ignore[arg-type]

    def test_rejects_non_string_ids(self) -> None:
        with pytest.raises(ValidationError):
            AddressingRule(users=[1, 2])  # type: ignore[list-item]

    def test_roundtrips_through_dict(self) -> None:
        policy = AddressingPolicy(
            rules=[AddressingRule(rooms=["r1"], users=["u1"], agents=[])]
        )
        assert parse_policy(policy.model_dump()) == policy

    def test_owner_flag_roundtrips(self) -> None:
        policy = owner_only_policy(["a1"])
        assert parse_policy(policy.model_dump()) == policy

    def test_stored_policy_without_owner_key_defaults_to_false(self) -> None:
        # A pre-CHOO-2137 blob has no `owner` key; it must not become truthy.
        policy = parse_policy({"rules": [{"users": ["u1"], "agents": []}]})
        assert policy.requires_owner_identity() is False
