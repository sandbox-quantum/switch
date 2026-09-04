"""Whether a message addresses a given agent, and whether it is allowed to.

Two separate questions, deliberately kept apart:

- **Addressed** is about intent. Did this message ask this agent for something
  — by name, by the alias it goes under in this room, by a role it holds, or
  by being the only other party in a direct chat?
- **Permitted** is about authority. An agent may carry a scoped addressing
  policy saying who is allowed to ask it for things at all.

A message can be addressed and not permitted, and the caller demotes it to
ordinary room chatter when so. Nothing here sends anything; deciding is all it
does, and the refusal wording travels back with the decision so the caller does
not have to re-derive why.

This used to live on `AgentClient`, where every answer was reached through a
live Matrix client. It takes a message as data instead — a sender, a body, a
content dict — so the same rules decide for a message read out of the log as
for one that arrived on the bus. That equivalence is the point: two code paths
answering "is this for me?" differently would be a security bug waiting for a
rewrite to expose it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, NamedTuple

from switch_core.addressing import SenderKind, can_address, parse_policy
from switch_core.clients.admin_messages import ADMIN_MARKER
from switch_core.clients.mentions import mention_regex, strip_emphasis

if TYPE_CHECKING:
    from collections.abc import Callable

    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import Agent
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.client_store import ClientStore
    from switch_core.db.stores.external_user_store import ExternalUserStore
    from switch_core.db.stores.room_role_store import RoomRoleStore
    from switch_core.db.stores.room_store import RoomStore

logger = logging.getLogger(__name__)

# Posted (once, guarded by an auto-reply flag) when a sender tags an agent but
# the agent's scoped addressing policy does not permit that sender to address
# it there. The message is demoted to unaddressed room chatter; this reply is
# the sender's only feedback that the attempt was rejected.
ADDRESSING_DENIED_MESSAGE = (
    "You're not permitted to direct messages to me in this room — my operator "
    "has restricted who can address me here."
)


# The same refusal, for the case worth telling apart: the agent answers only to
# its owner, and the sender's chat account is not linked to any Switch user, so
# it cannot be recognised as the owner even if it is. Without this the owner
# gets refused by their own agent with no idea why.
ADDRESSING_UNCLAIMED_MESSAGE = (
    "I only take instructions from my owner, and this chat account isn't "
    "linked to a Switch user yet — so I can't tell whether that's you. If it "
    "is, link this account to your Switch user in Switch Console and try again."
)


@dataclass(frozen=True)
class IncomingMessage:
    """What addressing needs to know about a message, and nothing else.

    `formatted_body` is where a Matrix client puts a rendered mention pill,
    which is the one addressing signal that has no plain-text equivalent. It is
    absent on media events and on anything read back from the log that never
    had one, so it is never the only thing consulted.
    """

    sender: str
    body: str
    formatted_body: str | None = None
    content: dict = field(default_factory=dict)


class AddressingDecision(NamedTuple):
    """Whether a sender may address an agent, and what to say if not."""

    allowed: bool
    refusal: str


class SenderPrincipal(NamedTuple):
    """Who a sender turned out to be, in the terms a policy is written in.

    `user_ids` and `owner_user_id` are the two ways a symbolic subject
    resolves, and are mutually exclusive: a human has claimants, an agent has
    an owner.
    """

    kind: SenderKind
    id: str
    user_ids: list[str]
    owner_user_id: str | None


class AddressingResolver:
    """Answers "is this for that agent, and may it be?" from stores alone."""

    def __init__(
        self,
        *,
        room_store: RoomStore,
        room_role_store: RoomRoleStore,
        client_store: ClientStore,
        agent_store: AgentStore,
        external_user_store: ExternalUserStore,
        live_agent_ids: Callable[[], set[str]],
    ) -> None:
        self._room_store = room_store
        self._room_role_store = room_role_store
        self._client_store = client_store
        self._agent_store = agent_store
        self._external_user_store = external_user_store
        # A callable rather than a set: a role only routes while its holder's
        # session is live, and that changes between one message and the next.
        self._live_agent_ids = live_agent_ids

    # ── Addressed ─────────────────────────────────────────────────────────────

    def addressed_without_lookup(
        self,
        *,
        agent: Agent,
        agent_matrix_id: str,
        channel_type: str | None,
        message: IncomingMessage,
    ) -> bool | None:
        """The addressing answer that needs no database read, or None when the
        room's aliases and role leases have to be consulted.

        Callers use it to decide whether to take a pool slot at all: most room
        chatter carries no `@` and is answered here, and a room fans every
        message out to all of its agent clients at once.
        """
        if ADMIN_MARKER in message.content:
            return False
        if channel_type == "direct":
            return True
        if self.mentions_name(
            agent=agent, agent_matrix_id=agent_matrix_id, message=message
        ):
            return True
        if "@" not in message.body:
            return False
        return None

    async def addresses(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        agent_matrix_id: str,
        room_id: str,
        channel_type: str | None,
        message: IncomingMessage,
    ) -> bool:
        """Whether this message asks this agent for something.

        **A system message never addresses anyone**, whatever the room type.
        Switch's own notices — a command's answer, "Added X to this room", the
        guidance shown when someone tags the app itself — are output, not a
        request for a reply. Two ways they were read as one: in a direct room
        every message addresses the agent, so running `/list-agents` in a 1:1
        chat had the agent start a session to respond to its own roster; and in
        any room, a notice that lists the agents present writes each `@name`,
        which tagged every one of them. The marker exists to say "generated by
        Switch"; this is it being honoured.
        """
        decided = self.addressed_without_lookup(
            agent=agent,
            agent_matrix_id=agent_matrix_id,
            channel_type=channel_type,
            message=message,
        )
        if decided is not None:
            return decided
        if await self.mentions_alias(
            session, agent=agent, room_id=room_id, message=message
        ):
            return True
        return await self.mentions_role(
            session, agent=agent, room_id=room_id, message=message
        )

    def mentions_name(
        self, *, agent: Agent, agent_matrix_id: str, message: IncomingMessage
    ) -> bool:
        """An `@name` at a token boundary, or a rendered mention pill.

        The pill is checked first because it is unambiguous. The plain-text
        scan is what catches everything else — media captions carry no
        formatted body, and neither does a bridged message.
        """
        if message.formatted_body and agent_matrix_id in message.formatted_body:
            return True
        return (
            mention_regex(agent.name).search(strip_emphasis(message.body)) is not None
        )

    async def mentions_alias(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        room_id: str,
        message: IncomingMessage,
    ) -> bool:
        """An `@alias` for the name this agent goes under in this room.

        A room alias addresses the agent exactly like its real name. Looked up
        live, so a change takes effect on the next message with no per-client
        cache to invalidate.
        """
        if "@" not in message.body:
            return False
        alias = await self._room_store.get_alias(session, room_id, agent.id)
        if not alias:
            return False
        return mention_regex(alias).search(message.body) is not None

    async def mentions_role(
        self,
        session: AsyncSession,
        *,
        agent: Agent,
        room_id: str,
        message: IncomingMessage,
    ) -> bool:
        """An `@role` for a room-role this agent LIVE-holds.

        Tagging a role reaches whoever is doing that job, so an interchangeable
        agent can be addressed by responsibility rather than by name. Only a
        live lease counts, which makes "held" mean the same thing here as in
        `!roles`: a stale lease — session gone, role auto-released, shown free
        — does not route here. A holder whose session merely hopped to another
        room still matches, because the renewal loop keeps that lease alive.
        """
        if "@" not in message.body:
            return False
        role_name = await self._room_role_store.agent_room_role(
            session, room_id, agent.id, self._live_agent_ids()
        )
        if not role_name:
            return False
        return mention_regex(role_name).search(strip_emphasis(message.body)) is not None

    # ── Permitted ─────────────────────────────────────────────────────────────

    async def permitted(
        self, session: AsyncSession, *, agent: Agent, room_id: str, sender: str
    ) -> AddressingDecision:
        """Whether `sender` may address this agent in this room.

        An agent with no policy is open to anyone, so this answers without a
        database round-trip. With a policy set it is deny-by-default: a sender
        that resolves to nothing is refused rather than given the benefit of
        the doubt, because an identity nobody can name is exactly what a
        restricted agent is restricted against.
        """
        policy = parse_policy(agent.addressing_policy)
        if policy.is_open():
            return AddressingDecision(allowed=True, refusal="")

        principal = await self.resolve_sender(session, sender)
        room = await self._room_store.get(session, room_id)

        if principal is None:
            logger.warning(
                "Addressing denied for %s: unresolvable sender %s in room %s",
                agent.name,
                sender,
                room_id,
            )
            return AddressingDecision(allowed=False, refusal=ADDRESSING_DENIED_MESSAGE)

        allowed = can_address(
            policy,
            room_id=room_id,
            group_id=room.group_id if room is not None else None,
            sender_kind=principal.kind,
            sender_id=principal.id,
            sender_user_ids=principal.user_ids,
            sender_owner_user_id=principal.owner_user_id,
            owner_user_id=agent.owner_id,
        )
        if allowed:
            return AddressingDecision(allowed=True, refusal="")

        # An owner-scoped rule cannot match a human nobody has claimed, so the
        # refusal says what to fix rather than implying a decision was made.
        unclaimed = (
            principal.kind == "user"
            and not principal.user_ids
            and policy.requires_owner_identity()
        )
        if unclaimed:
            logger.warning(
                "Addressing denied for %s: sender %s in room %s has not been "
                "claimed by any Switch user, so an owner-scoped rule cannot "
                "match them — the owner may need to link this identity",
                agent.name,
                principal.id,
                room_id,
            )
        else:
            logger.warning(
                "Addressing denied for %s: %s %s not permitted in room %s",
                agent.name,
                principal.kind,
                principal.id,
                room_id,
            )
        return AddressingDecision(
            allowed=False,
            refusal=(
                ADDRESSING_UNCLAIMED_MESSAGE if unclaimed else ADDRESSING_DENIED_MESSAGE
            ),
        )

    async def resolve_sender(
        self, session: AsyncSession, matrix_user_id: str
    ) -> SenderPrincipal | None:
        """Map a sender's mxid to the principal a policy is written about.

        Every participant is a Switch client, so the mxid resolves to a Client
        and from there to either an Agent (an agent-to-agent attempt) or an
        ExternalUser (a human on a bridge). None means neither, which a
        restricted agent should not trust.

        The two symbolic subjects come from different fields and only one
        applies to any sender: `user_ids` are the Switch users who have claimed
        a human's platform account — empty for an agent, which is never its own
        owner — and `owner_user_id` is who owns an agent sender, None for a
        human.
        """
        client = await self._client_store.get_by_matrix_user_id(session, matrix_user_id)
        if client is None:
            return None
        agent = await self._agent_store.get_by_client_id(session, client.id)
        if agent is not None:
            return SenderPrincipal("agent", agent.id, [], agent.owner_id)
        external_user = await self._external_user_store.get_by_client_id(
            session, client.id
        )
        if external_user is not None:
            claimants = await self._external_user_store.claimant_ids(
                session, external_user.id
            )
            return SenderPrincipal("user", external_user.id, claimants, None)
        return None
