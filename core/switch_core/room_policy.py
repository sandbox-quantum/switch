"""Who may do what to a room.

Every surface that changes or reads a room (the gateway routes and the flags
they report, the agent tools, the in-room chat commands) asks `decide` here,
so the rule lives in one table instead of at each call site.

Three tiers, from narrowest to widest:

- **owner** — the room's owner, or a workspace or organization admin
  (`Principal.is_admin`). A room nobody owns is admins only.
- **in the room** — the owner tier, plus whoever takes part in the room: added
  to it through Switch, seen in its channel, or owning an agent in it. A chat
  poster with no linked Switch account counts as in the room, with no
  identity of their own.
- **can see** — the "in the room" tier, plus everyone in the workspace when
  the room's read visibility is public.

An agent acts with its owner's rights: the surface builds the `RoomCaller`
from the owner, never from the agent. An agent that takes requests from people
other than its owner gets the "in the room" tier at most: whoever may address
it could otherwise change the room with its owner's rights.

Two cross-cutting exceptions sit on top of the table:

- **Your own things.** You may take your own agent out of a room, set or
  clear its alias, and delete a room document you created, whatever the
  room's tier would say. You may unlink a resource you own if you are also in
  the room.
- **Fixed membership.** Who is in a direct or group conversation is fixed by
  its platform, so nobody adds or removes its members from outside it. A chat
  command posted in the conversation is from inside it.

A room's write visibility no longer grants anything here: changing a room is
the owner tier's, and adding to it is the "in the room" tier's.

The module is pure (no database, no I/O). Working out whether a caller is in
the room, and whether they own the thing acted on, is each surface's job.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, Protocol

from switch_core.authz import Principal

# The channel types whose members their platform fixes.
FIXED_MEMBERSHIP = ("direct", "group")

# The channel types only their members can see on the platform.
PRIVATE_CHANNELS = ("channel_private", "group", "direct")


def visibility_for_channel(channel_type: str) -> Literal["public", "private"]:
    """The read visibility a new room takes from its channel: private when
    only the channel's members can see it, public otherwise.

    Only at creation. Switching the channel on the platform afterwards does
    not move the room; its owner or an admin changes the Switch side.
    """
    return "private" if channel_type in PRIVATE_CHANNELS else "public"


class Tier(StrEnum):
    OWNER = "owner"
    IN_ROOM = "in_room"
    CAN_SEE = "can_see"


RoomAction = Literal[
    "read",
    "configure",
    "archive",
    "change_access",
    "delete",
    "add_agent",
    "add_person",
    "attach",
    "remove_member",
    "unlink",
    "delete_document",
    "set_alias",
    "agent_settings",
]

# What each action needs. This is the matrix the room permissions proposal
# agreed; change a row here to change the rule everywhere.
#
# `configure` covers a room's name, description, instructions, roles,
# protection and observe settings, linked rooms, group and aliases map, and
# the chat commands that change how the room behaves (assigning its agent,
# follow-ups, auto-route).
RULES: dict[RoomAction, Tier] = {
    "read": Tier.CAN_SEE,
    "configure": Tier.OWNER,
    "archive": Tier.OWNER,
    "change_access": Tier.OWNER,
    "delete": Tier.OWNER,
    "add_agent": Tier.IN_ROOM,
    "add_person": Tier.IN_ROOM,
    "attach": Tier.IN_ROOM,
    "remove_member": Tier.OWNER,
    "unlink": Tier.OWNER,
    "delete_document": Tier.OWNER,
    "set_alias": Tier.OWNER,
    # An agent's settings in this room, such as whether it hears joins.
    "agent_settings": Tier.OWNER,
}

# Actions where owning the thing acted on is enough on its own.
_OWN_THING_SUFFICES: frozenset[RoomAction] = frozenset(
    {"remove_member", "set_alias", "delete_document", "agent_settings"}
)

# Actions where owning the thing acted on is enough if you are in the room.
_OWN_THING_IN_ROOM_SUFFICES: frozenset[RoomAction] = frozenset({"unlink"})

_MEMBERSHIP_ACTIONS: frozenset[RoomAction] = frozenset(
    {"add_agent", "add_person", "remove_member"}
)

# How each action reads in a refusal: "Only … can <verb>."
_VERBS: dict[RoomAction, str] = {
    "read": "see this room",
    "configure": "change this room's settings",
    "archive": "archive or unarchive this room",
    "change_access": "change who can see this room",
    "delete": "delete this room",
    "add_agent": "add agents to this room",
    "add_person": "add people to this room",
    "attach": "attach resources to this room",
    "remove_member": "remove agents or people from this room",
    "unlink": "unlink resources from this room",
    "delete_document": "delete this room's documents",
    "set_alias": "set or remove aliases in this room",
    "agent_settings": "change an agent's settings in this room",
}

_OWN_THING_HINT: dict[RoomAction, str] = {
    "remove_member": ", or the agent's own owner for their agent",
    "set_alias": ", or the agent's own owner for their agent",
    "agent_settings": ", or the agent's own owner for their agent",
    "delete_document": ", or the document's creator",
    "unlink": ", or the resource's owner if they are in the room",
}


class RoomFacts(Protocol):
    """What the policy reads from a room. Satisfied by the `Room` model."""

    @property
    def owner_id(self) -> str | None: ...

    @property
    def read_visibility(self) -> str: ...

    @property
    def channel_type(self) -> str | None: ...


@dataclass(frozen=True)
class RoomCaller:
    """Who is asking, as the policy sees them.

    `principal` is a person, or an agent's owner when an agent asks; its `id`
    is None for a chat poster with no linked account, or an agent nobody
    owns. `in_room` is whether that person takes part in the room (the room
    store's `involves`), or for a chat poster, that they posted in its
    channel.

    `owner_rights` is False for an agent that takes requests from people
    other than its owner: it then gets the "in the room" tier at most, even
    when its owner owns the room or is an admin.
    """

    principal: Principal
    in_room: bool
    owner_rights: bool = True


@dataclass(frozen=True)
class RoomDecision:
    allowed: bool
    reason: str | None


class RoomPermissionError(PermissionError):
    """A room action was refused. The message says why, in plain words."""


def is_room_owner(principal: Principal, room: RoomFacts) -> bool:
    """The owner tier: the room's owner, or a workspace or organization admin.
    A room nobody owns has no owner to match."""
    return principal.is_admin or (
        room.owner_id is not None and room.owner_id == principal.id
    )


def _meets(caller: RoomCaller, room: RoomFacts, tier: Tier) -> bool:
    if caller.owner_rights and is_room_owner(caller.principal, room):
        return True
    if tier is Tier.OWNER:
        return False
    if caller.in_room:
        return True
    if tier is Tier.IN_ROOM:
        return False
    return room.read_visibility == "public"


_ALLOWED = RoomDecision(True, None)

_OPEN_AGENT_REFUSAL = (
    "This agent takes requests from people other than its owner, so it can't "
    "use its owner's rights to change this room. Ask the room's owner, or "
    "change it yourself."
)


def decide(
    caller: RoomCaller,
    room: RoomFacts,
    action: RoomAction,
    *,
    owns_target: bool,
    from_inside: bool = False,
) -> RoomDecision:
    """Whether `caller` may do `action` to `room`, and if not, why.

    `owns_target` is whether the caller owns the thing acted on: the agent
    being removed or aliased, the document being deleted, the resource being
    unlinked. Pass False for actions on the room itself.

    `from_inside` is True for a chat command posted in the room's own
    conversation, which may change a direct or group conversation's members.
    """
    tier = RULES.get(action)
    if tier is None:
        # An action this table doesn't name: refuse it rather than fail.
        return RoomDecision(False, "Switch doesn't know that room action.")
    if (
        not from_inside
        and action in _MEMBERSHIP_ACTIONS
        and room.channel_type in FIXED_MEMBERSHIP
    ):
        return RoomDecision(
            False,
            "Who is in a direct or group conversation is set by its platform, "
            "so its members can't be changed from Switch.",
        )
    if _meets(caller, room, tier):
        return _ALLOWED
    if owns_target and action in _OWN_THING_SUFFICES:
        return _ALLOWED
    if owns_target and action in _OWN_THING_IN_ROOM_SUFFICES and caller.in_room:
        return _ALLOWED
    if not caller.owner_rights and is_room_owner(caller.principal, room):
        return RoomDecision(False, _OPEN_AGENT_REFUSAL)
    return RoomDecision(False, _refusal(tier, action))


def _refusal(tier: Tier, action: RoomAction) -> str:
    verb = _VERBS[action]
    if tier is Tier.CAN_SEE:
        return "This room is private: only the people in it and admins can see it."
    if tier is Tier.IN_ROOM:
        return f"Only people in the room can {verb}."
    hint = _OWN_THING_HINT.get(action)
    if hint is None:
        return f"Only the room's owner or a workspace admin can {verb}."
    return f"Only the room's owner or a workspace admin{hint}, can {verb}."


def allows(
    caller: RoomCaller,
    room: RoomFacts,
    action: RoomAction,
    *,
    owns_target: bool = False,
    from_inside: bool = False,
) -> bool:
    """`decide`, as a yes or no."""
    return decide(
        caller, room, action, owns_target=owns_target, from_inside=from_inside
    ).allowed


def require(
    caller: RoomCaller,
    room: RoomFacts,
    action: RoomAction,
    *,
    owns_target: bool = False,
    from_inside: bool = False,
) -> None:
    """Raise `RoomPermissionError` with the reason unless `decide` allows it."""
    decision = decide(
        caller, room, action, owns_target=owns_target, from_inside=from_inside
    )
    if not decision.allowed:
        raise RoomPermissionError(decision.reason)
