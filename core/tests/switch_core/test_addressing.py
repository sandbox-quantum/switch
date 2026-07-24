from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.addressing import (
    AddressingPolicy,
    AddressingRule,
    can_address,
    parse_policy,
)


def _allows(policy: AddressingPolicy, **kw: object) -> bool:
    defaults = dict(room_id="room-1", group_id=None, sender_kind="user", sender_id="u1")
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
