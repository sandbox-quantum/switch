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
