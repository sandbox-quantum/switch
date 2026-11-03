"""Who may bring an agent into a room.

An agent's addressing policy says who may talk to it (see `addressing`).
Inviting it is the same question asked about a room it is not in yet: whoever
the policy would let address the agent in that room may invite it there, and
nobody else. An agent nobody may talk to in a room has no reason to sit in it,
and letting anyone pull it in would also show them where it is used.

The decision is made in one place, `RoomService`, which every invite path goes
through: `add_agents_to_room` takes the inviter as a required argument and
`create_room` reads it from the config. A new invite path therefore cannot
skip the check without saying so in code (`Inviter.system`).

Agents already in a room are not affected: the check runs only for agents a
call would add.

This module is pure (no DB, no I/O). Callers resolve who is inviting with the
stores they already hold and hand over an `Inviter`.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict

from switch_core.addressing import (
    allows_on_behalf_of,
    can_address,
    parse_policy,
)
from switch_core.db.models import Agent

if TYPE_CHECKING:
    from switch_core.delivery.addressing import SenderPrincipal

InviterKind = Literal["user", "agent", "platform", "person", "unknown", "system"]


class Inviter(BaseModel):
    """Who is adding agents to a room, in the terms a policy is written in.

    Build one with the constructors rather than by hand:

    - `from_sender`: someone in a chat room (a command or slash command), as
      `AddressingResolver.resolve_sender` resolved them.
    - `person`: a Switch user acting through the gateway or Switch Console.
    - `agent`: an agent acting through its tools or the agent-bridge API.
    - `system`: Switch itself, with nobody to judge (a channel the platform
      delivered, a call with no actor). Use it only where that is true.
    """

    model_config = ConfigDict(frozen=True)

    kind: InviterKind
    id: str = ""
    #: Switch users who claimed a chat account (kind "user"), or the one user
    #: behind a member client.
    user_ids: tuple[str, ...] = ()
    #: Who owns an agent inviter.
    owner_user_id: str | None = None
    #: For a platform sender speaking for a person: that person's user id.
    on_behalf_of: str | None = None

    @classmethod
    def from_sender(cls, principal: SenderPrincipal | None) -> Inviter:
        """From a resolved chat sender, or None when the sender could not be
        resolved (refused by any restricted agent)."""
        if principal is None:
            return cls(kind="unknown")
        return cls(
            kind=principal.kind,
            id=principal.id,
            user_ids=tuple(principal.user_ids),
            owner_user_id=principal.owner_user_id,
            on_behalf_of=principal.on_behalf_of,
        )

    @classmethod
    def person(cls, user_id: str) -> Inviter:
        return cls(kind="person", id=user_id)

    @classmethod
    def agent(cls, agent_id: str, owner_user_id: str | None) -> Inviter:
        return cls(kind="agent", id=agent_id, owner_user_id=owner_user_id)

    @classmethod
    def system(cls) -> Inviter:
        return cls(kind="system")


class InviteRefused(PermissionError):
    """Raised when the inviter may not bring one or more agents into a room.

    `agent_names` are the agents refused; the message says why and who can
    invite them instead.
    """

    def __init__(self, agent_names: list[str], message: str) -> None:
        super().__init__(message)
        self.agent_names = agent_names
        self.message = message


def may_invite(
    agent: Agent,
    inviter: Inviter,
    *,
    room_id: str,
    group_id: str | None,
) -> bool:
    """Whether `inviter` may bring `agent` into the room.

    `room_id` is "" for a room that does not exist yet: a rule naming
    particular rooms then admits nobody, the same answer Switch Console gives
    when it lists the agents a new chat can have.
    """
    if inviter.kind == "system":
        return True
    policy = parse_policy(agent.addressing_policy)
    if inviter.kind == "unknown":
        return policy.is_open()
    if inviter.kind == "person" or (
        inviter.kind == "platform" and inviter.on_behalf_of is not None
    ):
        user_id = inviter.id if inviter.kind == "person" else inviter.on_behalf_of
        assert user_id is not None
        return allows_on_behalf_of(
            policy,
            room_id=room_id,
            group_id=group_id,
            user_id=user_id,
            external_user_ids=[],
            owner_user_id=agent.owner_id,
        )
    return can_address(
        policy,
        room_id=room_id,
        group_id=group_id,
        sender_kind=inviter.kind,
        sender_id=inviter.id,
        sender_user_ids=list(inviter.user_ids),
        sender_owner_user_id=inviter.owner_user_id,
        owner_user_id=agent.owner_id,
    )


def require_may_invite(
    agents: Iterable[Agent],
    inviter: Inviter,
    *,
    room_id: str,
    group_id: str | None,
) -> None:
    """Raise `InviteRefused` naming every agent `inviter` may not add."""
    refused = [
        agent
        for agent in agents
        if not may_invite(agent, inviter, room_id=room_id, group_id=group_id)
    ]
    if refused:
        raise InviteRefused(
            [agent.name for agent in refused], refusal_message(refused, inviter)
        )


def refusal_message(refused: list[Agent], inviter: Inviter) -> str:
    """What the inviter is told: which agents, why, and who can do it."""
    names = ", ".join(f"`{agent.name}`" for agent in refused)
    one = len(refused) == 1
    them = "it" if one else "them"
    message = (
        f"You can't invite {names}: {'its' if one else 'their'} owner limits "
        f"who can talk to {them}, and only those people can bring {them} into "
        f"a room. Ask the owner to invite {them}, or to allow you in "
        f'{"its" if one else "their"} "who can talk to this agent" setting.'
    )
    unclaimed = inviter.kind == "user" and not inviter.user_ids
    if unclaimed and any(
        parse_policy(agent.addressing_policy).requires_owner_identity()
        for agent in refused
    ):
        message += (
            " If you are the owner, this chat account isn't linked to your "
            "Switch user yet: link it in Switch Console and try again."
        )
    return message
