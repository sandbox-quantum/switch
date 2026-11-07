"""Who may put an agent into a room.

An agent's addressing policy says who may address it — send it work it is
expected to act on. An invite is how work reaches it: a room it has been put
in is a room whose people can address it in, and everyone there learns where
the agent is used. An agent whose owner set it to answer only to them could
still be pulled into any room by anyone who could run `!invite-agent`, call
`invite_agent_to_room`, name it in `create_room`, or add it on the room page,
which got around the policy for everything except the messages afterwards.

So an invite is judged by the same policy, as whoever is doing the inviting,
before the agent is added. `InviteGate.check` is that one judgement, and
`RoomService.create_room` / `RoomService.add_agents_to_room` — the two
funnels every invite path ends in — take the inviter as a required argument
and ask it. A future path cannot skip the check without saying who it is
inviting for, and there is no implicit admin bypass: an inviter the policy
does not admit is refused, whoever they are, with a message that says why
and who can invite instead (the agent's owner, or anyone the policy admits).

Only agents about to be added are judged. An agent already in the room
stays, whatever its policy says now, so tightening a policy never empties a
room.

Joins made on the platform itself (someone adds the agent's bot to a
channel in Slack, Telegram, …) are judged as the person who added it,
whenever the platform reports who that was. When it does not, the join is
let through but disclosed, never silently trusted: the agents whose policy
restricts who may address them come back in the outcome's `unverified`, and
the caller posts a notice in the room saying Switch could not verify who
added them, logs a warning, and tells the owner (see
`bridges/collaboration`). An unidentified inviter is never judged as
trusted — there is simply nothing to judge, so the room is told instead.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from switch_core.addressing import parse_policy
from switch_core.agent_display_name import agent_label_with_identifier
from switch_core.db.models import User
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.delivery.addressing import AddressingResolver, SenderPrincipal

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import Agent
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.room_store import RoomStore

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class UserInviter:
    """A Switch user acting in person: the gateway's room page, a Switch
    Console chat, a room they provision from YAML, a template they run.
    Judged as that person, with the platform accounts they have claimed —
    exactly what the policy would say to them speaking in the room."""

    user_id: str


@dataclass(frozen=True)
class AgentInviter:
    """An agent acting through its tools or the agent bridge (`create_room`,
    `invite_agent_to_room`). Judged as the agent itself, not as its owner:
    the `owner_agents` symbolic subject is what admits an owner's other
    agents, so an agent of a different owner is refused like anyone else."""

    agent_id: str


@dataclass(frozen=True)
class ChatSender:
    """Whoever typed a command in a room (`!invite-agent` and its slash
    forms), known by their transport user id. Judged as the sender of a
    message, which is what they are."""

    transport_user_id: str


@dataclass(frozen=True)
class PlatformInviter:
    """An agent's bot added to a channel on the platform itself.

    `added_by_external_user_id` is the platform's own id for whoever added
    it, on `bridge_id`, when the platform reports it (Slack names an
    inviter, Telegram names who added a member); None when it does not
    (Mattermost's `user_added` names only the account added, and a join
    found by a startup sweep names nobody). None is let through but
    disclosed — see the module docstring.
    """

    bridge_id: str
    added_by_external_user_id: str | None


Inviter = UserInviter | AgentInviter | ChatSender | PlatformInviter


def actor_kind(inviter: Inviter) -> Literal["user", "agent", "system"]:
    """How telemetry counts this inviter (`room_agents_added.added_by_kind`).

    A platform join counts as the system's own doing when nobody is named,
    and as a user's when the person who added the agent is known and was
    judged as themselves.
    """
    if isinstance(inviter, AgentInviter):
        return "agent"
    if isinstance(inviter, PlatformInviter):
        return "system" if inviter.added_by_external_user_id is None else "user"
    return "user"


class InviteRefused(PermissionError):
    """An invite the agents' addressing policies do not allow.

    A PermissionError, so every front door that already answers 403 to one
    answers it here too. `agent_ids` / `agent_names` are the agents that
    refused it — a caller adding several can name, or for a platform join
    drop, exactly those — and the message says why, and who can invite
    them instead.
    """

    def __init__(
        self, message: str, agent_ids: list[str], agent_names: list[str]
    ) -> None:
        super().__init__(message)
        self.agent_ids = agent_ids
        self.agent_names = agent_names

    @property
    def agent_id(self) -> str:
        """The (first) refusing agent's id, for a single-agent refusal."""
        return self.agent_ids[0]

    @property
    def agent_name(self) -> str:
        return self.agent_names[0]


@dataclass
class InviteOutcome:
    """What the gate decided for one invite.

    `refused` holds one `InviteRefused` per agent the inviter may not add,
    each with its own message. `unverified` holds the restricted agents a
    platform join let in without anyone to judge, for the caller to
    disclose; it is empty for every other kind of inviter, because every
    other inviter is somebody.
    """

    refused: list[InviteRefused] = field(default_factory=list)
    unverified: list[Agent] = field(default_factory=list)


def refusal_message(agent: Agent, owner_name: str | None, *, unclaimed: bool) -> str:
    """What a refused inviter is told: which agent, why, and who can add it.

    The unclaimed case is the one worth telling apart: an owner-scoped
    policy cannot match a chat account nobody has linked to a Switch user,
    so the would-be inviter may be the owner themselves and simply
    unrecognised — the message says what to fix rather than implying a
    decision was made about them.
    """
    label = agent_label_with_identifier(agent.display_name, agent.name)
    if unclaimed:
        return (
            f"{label} only joins rooms its owner adds it to, and this chat "
            "account isn't linked to a Switch user yet, so Switch can't tell "
            "whether that's you. If it is, link this account to your Switch "
            "user in Switch Console and try again."
        )
    who = f"its owner ({owner_name})" if owner_name else "its owner"
    return (
        f"{label} doesn't take instructions from you, so it wasn't added. "
        f"Ask {who} to invite it, or to change who it takes instructions from."
    )


def unverified_notice(agent: Agent, owner_handle: str | None) -> str:
    """Posted in a room when an agent was added on the platform by someone
    the platform did not name: the join stands, and the room is told it was
    not checked, with the owner named (and @-mentioned, when they have an
    account on this bridge) so they can act on it."""
    label = agent_label_with_identifier(agent.display_name, agent.name)
    owner = f"its owner (@{owner_handle})" if owner_handle else "its owner"
    return (
        f"{label} was added to this channel, but the platform didn't say who "
        "added it, so Switch couldn't verify they're allowed to invite it. "
        f"It's here for now; {owner} can remove it with "
        f"`!remove-agent @{agent.name}`, or change who it takes instructions "
        "from."
    )


class InviteGate:
    """Judges an invite by the invited agents' addressing policies.

    Built from the same stores the delivery router reads, and asks the
    resolver's `judge` — the same reading of the policy a message gets —
    so an invite and a message can never disagree about a sender.
    """

    @classmethod
    def build(cls, *, room_store: RoomStore, agent_store: AgentStore) -> InviteGate:
        external_user_store = ExternalUserStore()
        return cls(
            resolver=AddressingResolver(
                room_store=room_store,
                room_role_store=RoomRoleStore(),
                client_store=ClientStore(),
                agent_store=agent_store,
                external_user_store=external_user_store,
                # Only role mentions consult liveness; an invite never does.
                live_connection_ids=set,
            ),
            agent_store=agent_store,
            external_user_store=external_user_store,
        )

    def __init__(
        self,
        *,
        resolver: AddressingResolver,
        agent_store: AgentStore,
        external_user_store: ExternalUserStore,
    ) -> None:
        self._resolver = resolver
        self._agents = agent_store
        self._external_users = external_user_store

    async def check(
        self,
        session: AsyncSession,
        inviter: Inviter,
        agents: Sequence[Agent],
        *,
        room_id: str,
        group_id: str | None,
    ) -> InviteOutcome:
        """Which of `agents` `inviter` may not put in the room, and which a
        platform join lets in unverified.

        `room_id` is "" for a room that is not made yet, and `group_id` is
        the group it will be filed under.
        """
        outcome = InviteOutcome()
        if not agents:
            return outcome
        if isinstance(inviter, PlatformInviter) and (
            inviter.added_by_external_user_id is None
        ):
            # Nobody to judge. Restricted agents are disclosed by the
            # caller; open ones have nothing to disclose.
            outcome.unverified = [
                agent
                for agent in agents
                if not parse_policy(agent.addressing_policy).is_open()
            ]
            return outcome
        principal = await self._principal(session, inviter)
        user_external_ids = None
        if (
            principal is not None
            and principal.kind == "platform"
            and principal.on_behalf_of is not None
            and any(not parse_policy(agent.addressing_policy).is_open() for agent in agents)
        ):
            user_external_ids = await self._resolver.claimed_accounts(
                session, principal.on_behalf_of
            )
        for agent in agents:
            if principal is not None:
                decision = await self._resolver.judge(
                    session,
                    agent=agent,
                    room_id=room_id,
                    group_id=group_id,
                    principal=principal,
                    user_external_ids=user_external_ids,
                )
                if decision.allowed:
                    continue
            owner = await session.get(User, agent.owner_id) if agent.owner_id else None
            unclaimed = (
                principal is not None
                and principal.kind == "user"
                and not principal.user_ids
                and parse_policy(agent.addressing_policy).requires_owner_identity()
            )
            logger.warning(
                "Invite of %s refused: %s may not address it (room %s)",
                agent.name,
                self._describe(inviter),
                room_id or "being created",
            )
            outcome.refused.append(
                InviteRefused(
                    refusal_message(
                        agent, owner.name if owner else None, unclaimed=unclaimed
                    ),
                    [agent.id],
                    [agent.name],
                )
            )
        return outcome

    async def require(
        self,
        session: AsyncSession,
        inviter: Inviter,
        agent_ids: list[str],
        *,
        room_id: str,
        group_id: str | None,
        lock_agents: bool = False,
    ) -> InviteOutcome:
        """`check` for callers that name agents by id, raising the combined
        refusal when any agent refuses a platform join that names its
        inviter, or any non-platform invite. Platform joins by an unnamed
        inviter do not raise; their outcome carries the unverified agents.
        A platform join that names its inviter still raises here — the
        caller that would rather drop the refused agents and keep the room
        (bridging a channel) catches it and retries without them."""
        if lock_agents:
            agents = await self._agents.get_many_for_update(session, agent_ids)
        elif hasattr(self._agents, "get_many"):
            agents = await self._agents.get_many(session, agent_ids)
        else:
            # Small in-memory stores used by room-service callers may only
            # expose the single-row lookup. Keep the gate usable there while
            # production stores take the batched path above.
            agents = [
                agent
                for agent_id in agent_ids
                if (agent := await self._agents.get(session, agent_id)) is not None
            ]
        outcome = await self.check(
            session, inviter, agents, room_id=room_id, group_id=group_id
        )
        if outcome.refused:
            raise InviteRefused(
                " ".join(str(refusal) for refusal in outcome.refused),
                [refusal.agent_id for refusal in outcome.refused],
                [refusal.agent_name for refusal in outcome.refused],
            )
        return outcome

    async def _principal(
        self, session: AsyncSession, inviter: Inviter
    ) -> SenderPrincipal | None:
        """The inviter in the terms an addressing policy is written in.

        None is an inviter nobody could resolve — a restricted policy
        refuses it rather than giving it the benefit of the doubt, exactly
        as delivery refuses an unresolvable sender.
        """
        if isinstance(inviter, UserInviter):
            # A person acting through Switch is judged as themselves with
            # the accounts they have claimed, which is what the policy
            # would say to the platform speaking on their behalf.
            return SenderPrincipal(
                "platform",
                "",
                [],
                None,
                on_behalf_of=inviter.user_id,
            )
        if isinstance(inviter, AgentInviter):
            agent = await self._agents.get(session, inviter.agent_id)
            if agent is None:
                return None
            return SenderPrincipal("agent", agent.id, [], agent.owner_id)
        if isinstance(inviter, ChatSender):
            return await self._resolver.resolve_sender(
                session, inviter.transport_user_id
            )
        if isinstance(inviter, PlatformInviter):
            assert inviter.added_by_external_user_id is not None
            account = await self._external_users.get_by_external_id(
                session, inviter.bridge_id, inviter.added_by_external_user_id
            )
            if account is None:
                # Someone Switch has never seen on this platform: nobody has
                # claimed them, so they are judged as an unlinked account —
                # never as trusted.
                return SenderPrincipal(
                    "user", inviter.added_by_external_user_id, [], None
                )
            claimants = await self._external_users.claimant_ids(session, account.id)
            return SenderPrincipal("user", account.id, claimants, None)
        raise TypeError(f"Not an inviter: {inviter!r}")

    async def owner_handle(
        self, session: AsyncSession, agent: Agent, bridge_id: str | None
    ) -> str | None:
        """The owner's username on this bridge, to @-mention them in a
        notice: the account they have claimed there, the first by name if
        they have claimed several. None when the owner has no account on
        the bridge — the notice then names the owner without a mention."""
        if agent.owner_id is None or bridge_id is None:
            return None
        claimed = await self._external_users.get_by_user(session, agent.owner_id)
        here = sorted(
            account.external_username
            for account in claimed
            if account.bridge_id == bridge_id
        )
        return here[0] if here else None

    @staticmethod
    def _describe(inviter: Inviter) -> str:
        if isinstance(inviter, UserInviter):
            return f"user {inviter.user_id}"
        if isinstance(inviter, AgentInviter):
            return f"agent {inviter.agent_id}"
        if isinstance(inviter, ChatSender):
            return f"chat sender {inviter.transport_user_id}"
        return f"platform adder {inviter.added_by_external_user_id}"
