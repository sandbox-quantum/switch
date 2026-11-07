"""Who may bring an agent into a room.

An agent's addressing policy (`switch_core.addressing`) says who it takes
instructions from. Inviting it into a room is one of those instructions: an
agent pulled into a room by someone it would not answer only sits there
replying that it can't act, and its presence tells that room where it is used.
So every invite path asks the same question, here: would the policy let the
inviter address this agent in the room it is being invited into?

The rule is the one `!remove-agent` already applies, so the people who may
take an agent out of a room are the people who may put it in:

  - anyone the agent's policy admits in that room (its owner, under the
    default policy);
  - an agent that manages agents (`can_manage_agents`) for the same owner,
    which is that owner acting through a program;
  - a workspace admin, who answers for every agent in the workspace.

The callers resolve the inviter (a chat account, an agent, or a Switch user)
and pass what they found; this module stays free of I/O, like
`switch_core.addressing`. Agents already in a room are not affected: only new
invites are checked.
"""

from __future__ import annotations

from typing import Protocol

from switch_core.addressing import allows_on_behalf_of, can_address, parse_policy


class InvitedAgent(Protocol):
    """The fields of an `Agent` the check reads."""

    @property
    def addressing_policy(self) -> dict | None: ...

    @property
    def owner_id(self) -> str | None: ...


class InvitingAgent(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def owner_id(self) -> str | None: ...

    @property
    def can_manage_agents(self) -> bool: ...


def person_may_invite(
    agent: InvitedAgent,
    *,
    room_id: str,
    group_id: str | None,
    user_id: str,
    external_user_ids: list[str],
    is_admin: bool,
) -> bool:
    """Whether the Switch user `user_id` may invite `agent` into `room_id`.

    True for a workspace admin, otherwise exactly what the policy would say to
    that person addressing the agent in the room themselves
    (`allows_on_behalf_of`). `external_user_ids` are the chat accounts they
    have claimed; pass [] where none are consulted, as Switch Console does.
    """
    if is_admin:
        return True
    return allows_on_behalf_of(
        parse_policy(agent.addressing_policy),
        room_id=room_id,
        group_id=group_id,
        user_id=user_id,
        external_user_ids=external_user_ids,
        owner_user_id=agent.owner_id,
    )


def agent_may_invite(
    agent: InvitedAgent,
    inviter: InvitingAgent,
    *,
    room_id: str,
    group_id: str | None,
) -> bool:
    """Whether the agent `inviter` may invite `agent` into `room_id`.

    True when the policy admits `inviter` in that room (by id, or as one of the
    owner's own agents), or when `inviter` manages agents for the same owner.
    """
    if (
        inviter.can_manage_agents
        and inviter.owner_id is not None
        and inviter.owner_id == agent.owner_id
    ):
        return True
    return can_address(
        parse_policy(agent.addressing_policy),
        room_id=room_id,
        group_id=group_id,
        sender_kind="agent",
        sender_id=inviter.id,
        sender_user_ids=[],
        sender_owner_user_id=inviter.owner_id,
        owner_user_id=agent.owner_id,
    )


def invite_refusal(agent_label: str) -> str:
    """What a refused inviter is told: why, and who can do it instead.

    The owner is named by role, not by name: the reply goes to a room the
    owner may not be in, and a name is theirs to share. `agent_label` is shown
    as given, so callers pass a defused label (`agent_label_with_identifier`).
    """
    return (
        f"You can't invite {agent_label}: it doesn't take instructions from "
        "you. Ask its owner to invite it, or to let you talk to it."
    )
