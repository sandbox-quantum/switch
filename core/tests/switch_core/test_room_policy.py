"""The room permissions matrix, row by row, against `room_policy.decide`."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.authz import Principal
from switch_core.room_policy import (
    RULES,
    RoomCaller,
    RoomPermissionError,
    allows,
    decide,
    require,
)

OWNER = RoomCaller(Principal("u-owner", False), in_room=True)
ADMIN = RoomCaller(Principal("u-admin", True), in_room=False)
MEMBER = RoomCaller(Principal("u-member", False), in_room=True)
UNLINKED_POSTER = RoomCaller(Principal(None, False), in_room=True)
BYSTANDER = RoomCaller(Principal("u-bystander", False), in_room=False)
NOBODY = RoomCaller(Principal(None, False), in_room=False)


def _room(
    *, visibility: str, owner_id: str | None = "u-owner", channel="channel_public"
):
    return SimpleNamespace(
        owner_id=owner_id, read_visibility=visibility, channel_type=channel
    )


PRIVATE = _room(visibility="private")
PUBLIC = _room(visibility="public")

OWN = {"owner", "admin"}
OP = OWN | {"member", "unlinked"}
ALL = OP | {"bystander"}

CALLERS = {
    "owner": OWNER,
    "admin": ADMIN,
    "member": MEMBER,
    "unlinked": UNLINKED_POSTER,
    "bystander": BYSTANDER,
}

# (action, who may on a private room, who may on a public room) — the
# proposal's "New" columns.
MATRIX = [
    ("read", OP, ALL),
    ("configure", OWN, OWN),
    ("archive", OWN, OWN),
    ("change_access", OWN, OWN),
    ("delete", OWN, OWN),
    ("add_agent", OP, OP),
    ("add_person", OP, OP),
    ("attach", OP, OP),
    ("remove_member", OWN, OWN),
    ("unlink", OWN, OWN),
    ("delete_document", OWN, OWN),
    ("set_alias", OWN, OWN),
    ("agent_settings", OWN, OWN),
]


def test_matrix_covers_every_action() -> None:
    assert {row[0] for row in MATRIX} == set(RULES)


@pytest.mark.parametrize("action,private,public", MATRIX)
def test_matrix(action, private, public) -> None:
    for room, expected in ((PRIVATE, private), (PUBLIC, public)):
        for name, caller in CALLERS.items():
            assert allows(caller, room, action) == (name in expected), (
                action,
                room.read_visibility,
                name,
            )


class TestOwnThings:
    def test_owner_of_an_agent_may_remove_and_alias_it(self) -> None:
        assert allows(BYSTANDER, PUBLIC, "remove_member", owns_target=True)
        assert allows(MEMBER, PRIVATE, "set_alias", owns_target=True)

    def test_owner_of_an_agent_may_change_its_settings(self) -> None:
        assert allows(BYSTANDER, PUBLIC, "agent_settings", owns_target=True)
        assert not allows(MEMBER, PUBLIC, "agent_settings", owns_target=False)

    def test_creator_may_delete_their_document(self) -> None:
        assert allows(BYSTANDER, PRIVATE, "delete_document", owns_target=True)

    def test_resource_owner_may_unlink_only_if_in_the_room(self) -> None:
        assert allows(MEMBER, PUBLIC, "unlink", owns_target=True)
        assert not allows(BYSTANDER, PUBLIC, "unlink", owns_target=True)

    def test_owning_the_target_does_not_unlock_room_settings(self) -> None:
        assert not allows(MEMBER, PUBLIC, "configure", owns_target=True)
        assert not allows(MEMBER, PUBLIC, "archive", owns_target=True)


class TestRoomWithNoOwner:
    ROOM = _room(visibility="public", owner_id=None)

    def test_only_admins_change_it(self) -> None:
        assert allows(ADMIN, self.ROOM, "configure")
        assert not allows(MEMBER, self.ROOM, "configure")

    def test_a_caller_with_no_identity_does_not_own_it(self) -> None:
        assert not allows(NOBODY, self.ROOM, "configure")
        assert not allows(UNLINKED_POSTER, self.ROOM, "configure")

    def test_people_in_it_still_add(self) -> None:
        assert allows(MEMBER, self.ROOM, "add_agent")


class TestFixedMembership:
    @pytest.mark.parametrize("channel", ["direct", "group"])
    @pytest.mark.parametrize("action", ["add_agent", "add_person", "remove_member"])
    def test_nobody_changes_members(self, channel, action) -> None:
        room = _room(visibility="private", channel=channel)
        for caller in (OWNER, ADMIN, MEMBER):
            decision = decide(caller, room, action, owns_target=True)
            assert not decision.allowed
            assert "direct or group conversation" in (decision.reason or "")

    def test_other_actions_follow_the_table(self) -> None:
        room = _room(visibility="private", channel="direct")
        assert allows(OWNER, room, "configure")
        assert allows(MEMBER, room, "attach")

    @pytest.mark.parametrize("channel", ["direct", "group"])
    def test_a_command_from_inside_follows_the_table(self, channel) -> None:
        """A chat command posted in the conversation is from inside it."""
        room = _room(visibility="private", channel=channel)
        assert allows(OWNER, room, "remove_member", from_inside=True)
        assert allows(MEMBER, room, "remove_member", owns_target=True, from_inside=True)
        assert not allows(MEMBER, room, "remove_member", from_inside=True)


class TestAgentOpenToOthers:
    """An agent that takes requests from people other than its owner gets the
    "in the room" tier at most, whatever its owner may do."""

    @staticmethod
    def _open(caller: RoomCaller) -> RoomCaller:
        return RoomCaller(caller.principal, caller.in_room, owner_rights=False)

    @pytest.mark.parametrize("action", ["configure", "archive", "remove_member"])
    def test_cannot_use_its_owners_room_owner_or_admin_rights(self, action) -> None:
        for caller in (OWNER, ADMIN):
            decision = decide(self._open(caller), PUBLIC, action, owns_target=False)
            assert not decision.allowed
            assert "takes requests from people other than its owner" in (
                decision.reason or ""
            )

    def test_still_adds_when_its_owner_is_in_the_room(self) -> None:
        assert allows(self._open(OWNER), PRIVATE, "add_agent")
        assert allows(self._open(OWNER), PRIVATE, "read")

    def test_still_acts_on_its_owners_own_things(self) -> None:
        assert allows(self._open(MEMBER), PUBLIC, "remove_member", owns_target=True)

    def test_an_admins_open_agent_sees_only_what_others_see(self) -> None:
        open_admin = RoomCaller(Principal("u-admin", True), False, owner_rights=False)
        assert not allows(open_admin, PRIVATE, "read")
        assert allows(open_admin, PUBLIC, "read")


def test_an_unknown_action_is_refused_not_raised() -> None:
    decision = decide(OWNER, PUBLIC, "write", owns_target=False)  # type: ignore[arg-type]
    assert not decision.allowed


class TestReasons:
    def test_owner_tier(self) -> None:
        with pytest.raises(
            RoomPermissionError, match="room's owner or a workspace admin can change"
        ):
            require(MEMBER, PUBLIC, "configure")

    def test_own_thing_hint(self) -> None:
        reason = decide(MEMBER, PUBLIC, "remove_member", owns_target=False).reason
        assert reason is not None and "agent's own owner" in reason

    def test_in_room_tier(self) -> None:
        reason = decide(BYSTANDER, PUBLIC, "add_agent", owns_target=False).reason
        assert reason == "Only people in the room can add agents to this room."

    def test_private_room(self) -> None:
        reason = decide(BYSTANDER, PRIVATE, "read", owns_target=False).reason
        assert reason is not None and reason.startswith("This room is private")

    def test_no_at_mentions(self) -> None:
        for action in RULES:
            reason = decide(BYSTANDER, PRIVATE, action, owns_target=False).reason
            assert reason is not None and "@" not in reason

    def test_refusal_is_a_permission_error(self) -> None:
        assert issubclass(RoomPermissionError, PermissionError)
