"""Who may invite an agent into a room: one rule for every way in.

An agent can be brought into a room three ways: the Gateway's room route
(Switch Console and the web UI), an agent's `invite_agent_to_room` tool, and
`!invite-agent` posted in the room. All three ask this module, so they agree.

The rule: the inviter must be **in the room**, and **allowed to address** the
agent being invited. An agent sitting in a room sees everything said there, so
pulling in an agent you could not talk to yourself would hand someone else's
restricted agent a view of a room its owner never chose.

- *In the room* is `RoomStore.involved_room_ids`: the inviter owns the room,
  is in it (in Switch Console or through a platform account they claimed), or
  owns an agent in it. Workspace and organisation admins always count.
- *Allowed to address* is the target's own addressing policy, read exactly as
  it would be for a message from the inviter.
- An agent inviting through its tool is judged as its owner. It also passes
  when the target's policy admits that agent itself: the target's owner chose
  to trust it by name, which is no wider than letting it send the request.
- Someone posting `!invite-agent` is in the channel, so counts as in the room
  whether or not their chat account is linked to a Switch user; the policy
  then decides, which for an unlinked poster means only open agents.

Each refusal says why in plain words, the same on every path.

Direct and group conversations are not this module's concern: who is in them
is changed only from inside (`require_membership_changeable_from_outside`),
which the outside paths check before this one.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from switch_core.addressing import allows_on_behalf_of, can_address, parse_policy
from switch_core.agent_display_name import agent_label_with_identifier

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import Agent, Room
    from switch_core.db.stores.external_user_store import ExternalUserStore
    from switch_core.db.stores.room_store import RoomStore


NOT_IN_ROOM_REFUSAL = (
    "You can't invite agents to this room because you're not in it. Only "
    "people in the room, and workspace admins, can bring agents in."
)


def not_addressable_refusal(target: Agent) -> str:
    """The refusal for an agent the inviter may not address. No leading `@`:
    it may be posted to the room, where a live mention would address it."""
    label = agent_label_with_identifier(target.display_name, target.name)
    return (
        f"You can't invite {label}: it doesn't take requests from you, so you "
        "can't bring it into a room either. Ask its owner to invite it, or to "
        "let you address it."
    )


class InviteRefused(PermissionError):
    """An invite the rule does not allow. `str()` is the refusal to show."""


async def _takes_part(
    session: AsyncSession, room_store: RoomStore, room_id: str, user_id: str | None
) -> bool:
    if user_id is None:
        return False
    return bool(await room_store.involved_room_ids(session, user_id, [room_id]))


async def _user_may_address(
    session: AsyncSession,
    external_user_store: ExternalUserStore,
    target: Agent,
    *,
    room: Room,
    user_id: str,
) -> bool:
    """Whether a Switch user may address `target` in `room` themselves: the
    policy as it reads for that person, any platform account they claimed
    included."""
    policy = parse_policy(target.addressing_policy)
    if policy.is_open():
        return True
    claimed = await external_user_store.get_by_user(session, user_id)
    return allows_on_behalf_of(
        policy,
        room_id=room.id,
        group_id=room.group_id,
        user_id=user_id,
        external_user_ids=[ext.id for ext in claimed],
        owner_user_id=target.owner_id,
    )


def _agent_may_address(target: Agent, *, room: Room, caller: Agent) -> bool:
    """Whether the policy admits `caller` itself: by name, or through an
    owner's-agents rule when both share an owner."""
    return can_address(
        parse_policy(target.addressing_policy),
        room_id=room.id,
        group_id=room.group_id,
        sender_kind="agent",
        sender_id=caller.id,
        sender_user_ids=[],
        sender_owner_user_id=caller.owner_id,
        owner_user_id=target.owner_id,
    )


async def require_user_may_invite(
    session: AsyncSession,
    room_store: RoomStore,
    external_user_store: ExternalUserStore,
    *,
    room: Room,
    targets: list[Agent],
    user_id: str,
    is_admin: bool,
) -> None:
    """Raise `InviteRefused` unless the Switch user may invite every one of
    `targets` into `room`."""
    if not is_admin and not await _takes_part(session, room_store, room.id, user_id):
        raise InviteRefused(NOT_IN_ROOM_REFUSAL)
    for target in targets:
        if not await _user_may_address(
            session, external_user_store, target, room=room, user_id=user_id
        ):
            raise InviteRefused(not_addressable_refusal(target))


async def require_agent_may_invite(
    session: AsyncSession,
    room_store: RoomStore,
    external_user_store: ExternalUserStore,
    *,
    room: Room,
    target: Agent,
    caller: Agent,
    owner_is_admin: bool,
) -> None:
    """Raise `InviteRefused` unless `caller` may invite `target` into `room`.

    Judged as the caller's owner. An agent already in the room counts as in
    it too: its owner then owns an agent there anyway, and an agent nobody
    owns keeps the reach it has always had in rooms it belongs to.
    """
    in_room = (
        owner_is_admin
        or caller.id in await room_store.get_agent_ids(session, room.id)
        or await _takes_part(session, room_store, room.id, caller.owner_id)
    )
    if not in_room:
        raise InviteRefused(NOT_IN_ROOM_REFUSAL)
    if parse_policy(target.addressing_policy).is_open():
        return
    if _agent_may_address(target, room=room, caller=caller):
        return
    if caller.owner_id is not None and await _user_may_address(
        session, external_user_store, target, room=room, user_id=caller.owner_id
    ):
        return
    raise InviteRefused(not_addressable_refusal(target))
