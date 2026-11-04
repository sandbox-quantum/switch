"""Who may put an agent in a room.

An agent's `addressing_policy` says who may *talk* to it. It also decides who
may invite it: an agent pulled into a room by someone it will not take
instructions from sits there answering only that it cannot act, and the invite
itself tells that person where the agent is used.

The rules are not restated here. An invite is judged with exactly the
evaluation the receive path uses (`switch_core.addressing.can_address`), so the
two cannot drift: what this module adds is the shape of an *inviter* (who may
be a person, an agent, the platform, or Switch's own machinery), one refusal
wording, and the exception every invite path raises.

Enforcement lives in `RoomService` — `add_agents_to_room` and `create_room`
are the only two ways an agent reaches a room's roster, and both ask here
before anything is provisioned. A new invite path is a caller of one of those,
so it is checked by construction rather than by remembering to.

What this does **not** touch is membership that already exists: only the
agents an invite would newly add are judged, so tightening a policy never
ejects an agent from a room it is already in.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from switch_core.addressing import (
    AddressingPolicy,
    SenderKind,
    can_address,
    parse_policy,
)
from switch_core.db.models import Agent, User

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.delivery.addressing import AddressingResolver

logger = logging.getLogger(__name__)

#: Switch's own machinery acting for nobody — reconciliation, a channel the
#: platform handed the bridge, a room template's own joins. Not a sender kind,
#: because no policy is written about it.
InviterKind = SenderKind | Literal["system"]

ActorKind = Literal["user", "agent", "system"]


class InviteNotPermitted(PermissionError):
    """An agent's addressing policy does not admit whoever is inviting it.

    A `PermissionError`, so the agent-bridge front doors already answer it
    `403` and the gateway can map it without learning a new exception.
    """


@dataclass(frozen=True)
class Inviter:
    """Who is asking for an agent to be put in a room, in the terms a policy
    is written in.

    `ids` are the identities the sender may be named by in a rule's `users` /
    `agents` dimension — a person's claimed chat accounts, or an agent's id.
    Empty means the sender carries no such identity and can only get in
    through a symbolic rule (`owner`, `owner_agents`) or an open policy.
    `user_ids` are the Switch users the sender *is*, which is what an `owner`
    rule matches; `owner_user_id` is who owns an agent sender.
    """

    kind: InviterKind
    ids: list[str]
    user_ids: list[str]
    owner_user_id: str | None

    @classmethod
    def user(cls, user_id: str) -> Inviter:
        """A Switch user acting in person — the gateway, Switch Console.

        No claimed chat account is consulted, matching how the same question
        is already asked for a Console chat: a rule naming platform accounts
        is about that platform, not about the app the person signed in to.
        """
        return cls(kind="user", ids=[], user_ids=[user_id], owner_user_id=None)

    @classmethod
    def chat_account(
        cls, external_user_id: str, claimant_user_ids: list[str]
    ) -> Inviter:
        """A person speaking from a chat account, with the Switch users who
        have claimed it (empty when nobody has)."""
        return cls(
            kind="user",
            ids=[external_user_id],
            user_ids=list(claimant_user_ids),
            owner_user_id=None,
        )

    @classmethod
    def on_behalf_of(cls, user_id: str, external_user_ids: list[str]) -> Inviter:
        """The platform carrying a person's authority: judged as that person,
        by any of the chat accounts they have claimed."""
        return cls(
            kind="user",
            ids=list(external_user_ids),
            user_ids=[user_id],
            owner_user_id=None,
        )

    @classmethod
    def agent(cls, agent_id: str, owner_user_id: str | None) -> Inviter:
        """Another agent. An agent is never the target's owner — owner rules
        admit the person, not the programs acting for them — so it gets in
        through the `agents` dimension or an `owner_agents` rule."""
        return cls(
            kind="agent", ids=[agent_id], user_ids=[], owner_user_id=owner_user_id
        )

    @classmethod
    def platform(cls, client_id: str) -> Inviter:
        """Switch itself speaking for nobody in particular. Denied even by an
        open policy unless a rule opts the platform in."""
        return cls(kind="platform", ids=[client_id], user_ids=[], owner_user_id=None)

    @classmethod
    def unknown(cls) -> Inviter:
        """A human sender that resolved to no identity at all. An open policy
        admits them like anyone else; a restricted one does not, which is what
        being restricted means."""
        return cls(kind="user", ids=[], user_ids=[], owner_user_id=None)

    @classmethod
    def system(cls) -> Inviter:
        """Switch's own machinery, acting for nobody. Not judged."""
        return cls(kind="system", ids=[], user_ids=[], owner_user_id=None)

    @property
    def is_judged(self) -> bool:
        """Whether a policy is asked about this inviter at all.

        False only for Switch's own machinery. Callers read it to skip the
        reads the check would need; `require_can_invite` answers the same way
        on its own, so skipping is an optimisation and not the rule.
        """
        return self.kind != "system"

    @property
    def actor_kind(self) -> ActorKind:
        """How telemetry spells this inviter. The platform is machinery."""
        if self.kind == "agent":
            return "agent"
        if self.kind == "user":
            return "user"
        return "system"


def invite_allowed(
    policy: AddressingPolicy,
    *,
    room_id: str,
    group_id: str | None,
    owner_user_id: str | None,
    inviter: Inviter,
) -> bool:
    """Whether `inviter` may put an agent carrying `policy` in this room.

    The question the receive path asks, asked about an invite: an inviter the
    agent would refuse to hear from is an inviter that may not summon it.
    Several candidate ids are tried because one person may hold several chat
    accounts, and a rule naming any of them names them.
    """
    if inviter.kind == "system":
        return True
    candidates = inviter.ids or [""]
    return any(
        can_address(
            policy,
            room_id=room_id,
            group_id=group_id,
            sender_kind=inviter.kind,
            sender_id=candidate,
            sender_user_ids=inviter.user_ids,
            sender_owner_user_id=inviter.owner_user_id,
            owner_user_id=owner_user_id,
        )
        for candidate in candidates
    )


def invite_refusal(*, agent_name: str, owner_name: str | None) -> str:
    """The one wording every refused invite carries, whichever path refused it.

    It says what was refused, why, and who to ask — an agent its owner keeps
    to themselves is not a bug report, and the person who can change it is
    the one worth naming.
    """
    whose = f"Its owner, {owner_name}," if owner_name else "Its owner"
    return (
        f"You're not permitted to invite `{agent_name}` into this room: its "
        "owner restricts who can address it, and that same rule decides who "
        f"can invite it. {whose} can invite it, as can anyone they allow to "
        "address it."
    )


async def require_can_invite(
    session: AsyncSession,
    *,
    agents: list[Agent],
    room_id: str,
    group_id: str | None,
    inviter: Inviter,
) -> None:
    """Raise `InviteNotPermitted` unless `inviter` may invite every agent.

    `agents` are the agents an invite would *newly* add; an agent already in
    the room is not passed here and is never removed by this check.

    `room_id` is `""` for a room that does not exist yet (room creation): a
    rule naming particular rooms admits nobody into a new one, which is how
    the same question is already asked of a new Console chat.
    """
    if inviter.kind == "system":
        return
    for agent in agents:
        if invite_allowed(
            parse_policy(agent.addressing_policy),
            room_id=room_id,
            group_id=group_id,
            owner_user_id=agent.owner_id,
            inviter=inviter,
        ):
            continue
        owner = await session.get(User, agent.owner_id) if agent.owner_id else None
        logger.warning(
            "Invite denied for %s: %s %s may not address it in room %r",
            agent.name,
            inviter.kind,
            ", ".join(inviter.ids) or ", ".join(inviter.user_ids) or "unidentified",
            room_id,
        )
        raise InviteNotPermitted(
            invite_refusal(
                agent_name=agent.name,
                owner_name=owner.name if owner is not None else None,
            )
        )


async def inviter_for_sender(
    resolver: AddressingResolver,
    session: AsyncSession,
    sender: str,
    content: Mapping[str, object],
) -> Inviter:
    """The inviter behind a room message, resolved the way the receive path
    resolves the sender of one — so a chat command is judged as the same
    principal the agent would judge a message from."""
    principal = await resolver.resolve_sender(session, sender, content)
    if principal is None:
        return Inviter.unknown()
    if principal.kind == "agent":
        return Inviter.agent(principal.id, principal.owner_user_id)
    if principal.kind == "platform":
        if principal.on_behalf_of is None:
            return Inviter.platform(principal.id)
        return Inviter.on_behalf_of(
            principal.on_behalf_of,
            await resolver.claimed_accounts(session, principal.on_behalf_of),
        )
    return Inviter.chat_account(principal.id, principal.user_ids)
