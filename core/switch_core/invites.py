"""Who may bring an agent into a room.

An owner chooses who their agent takes instructions from. That choice should
also decide who can bring the agent into a room: otherwise a stranger can pull
it in, learn where it is used, and leave it sitting among people it will only
refuse.

Nothing here restates the rules. An invite is answered by the same
`AddressingResolver.judge` that answers a message, so "who may invite" and "who
may address" cannot drift apart. This module adds only the shape of *who is
asking* and the sentence a person reads when the answer is no.

Every invite path ends in `RoomService.create_room` or
`RoomService.add_agents_to_room`, and both call :class:`InviteGate`. The
inviter is a required argument there, so a future path cannot skip the check by
forgetting to say who is asking.

Platform joins are the one case where the inviter may genuinely be unknown: a
platform can add a bot to a channel without telling Switch who did it. Those
joins are allowed — refusing would break a channel for a reason nobody in it
can fix — but never quietly. :func:`unverified_join_notice` and
:func:`needs_disclosure` are what the caller uses to disclose them, and an
unknown adder is never treated as the owner or as an administrator.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Literal

from switch_core.addressing import parse_policy
from switch_core.agent_display_name import agent_label_with_identifier
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.delivery.addressing import AddressingResolver, SenderPrincipal

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import Agent
    from switch_core.db.stores.agent_store import AgentStore

InviterKind = Literal[
    "person", "agent", "command_sender", "platform_adder", "unknown", "system"
]


@dataclass(frozen=True)
class Inviter:
    """Who is asking for an agent to join a room.

    Build one with the classmethod that says what is actually known. There is
    deliberately no default value on ``add_agents_to_room`` /
    ``create_room``: a path that cannot say who is asking is a path that has
    not thought about the answer.
    """

    kind: InviterKind
    subject: str = ""
    bridge_id: str = ""
    # Agents a template this inviter is running has just created. They belong
    # to the same person, so they may be seated even under an owner-only rule.
    vouched_for: frozenset[str] = frozenset()
    # When set, this inviter is only known to have brought these agents. A
    # platform reports who added one bot, not every bot already in the channel.
    speaks_for: frozenset[str] | None = None

    @classmethod
    def person(cls, user_id: str) -> Inviter:
        """A signed-in Switch user: the gateway room page, Switch Console, a
        YAML provision, or a template run."""
        return cls("person", user_id)

    @classmethod
    def agent(
        cls, agent_id: str, *, created_for_this_run: frozenset[str] = frozenset()
    ) -> Inviter:
        """An agent acting on its own authority, never its owner's.

        An agent gets in through its owner's ``owner_agents`` rule (the
        default for new agents), not by borrowing the owner's identity.
        ``created_for_this_run`` are agents a template it is running has just
        created; those are the runner's, so a team of private agents can still
        be seated in the room the same template describes.
        """
        return cls("agent", agent_id, vouched_for=created_for_this_run)

    @classmethod
    def command_sender(cls, transport_user_id: str) -> Inviter:
        """Whoever typed ``!invite-agent``, as the room knows them."""
        return cls("command_sender", transport_user_id)

    @classmethod
    def platform_adder(cls, bridge_id: str, external_user_id: str) -> Inviter:
        """The person a messaging platform says added the bot to a channel."""
        return cls("platform_adder", external_user_id, bridge_id)

    @classmethod
    def unknown_adder(cls) -> Inviter:
        """The platform put the agent in a channel and did not say who asked.

        The join stands, because refusing would leave a channel broken for a
        reason nobody in it can fix. It is never trusted quietly: the caller
        discloses it and this inviter is never the owner or an administrator.
        """
        return cls("unknown")

    @classmethod
    def system(cls, reason: str) -> Inviter:
        """Switch's own machinery, acting for nobody. Not judged.

        ``reason`` is for the person reading the call site: an exemption from an
        owner's choice should have to explain itself.
        """
        return cls("system", reason)

    def only_for(self, agent_ids: Collection[str]) -> Inviter:
        """This inviter, for these agents alone.

        A platform names who added one bot. Other bots found in the same
        channel got there some other way, so that person should not answer for
        them.

        An unknown adder stays unknown: narrowing it to a bot would read as
        "someone we could name brought this one", which is exactly what nobody
        said, and would suppress the disclosure the unknown case needs.
        """
        if not self.is_judged:
            return self
        return replace(self, speaks_for=frozenset(agent_ids))

    def having_created(self, agent_ids: Collection[str]) -> Inviter:
        """The same inviter, also bringing agents its run has just created.

        A run may seat what it made even under a policy that would not admit
        the runner for anything else: those agents belong to the runner's
        owner and the run is the reason they exist. Only an agent carries
        this; for anyone else it changes nothing.
        """
        if self.kind != "agent":
            return self
        return replace(self, vouched_for=self.vouched_for | frozenset(agent_ids))

    @property
    def is_judged(self) -> bool:
        """Whether an addressing policy is asked about this inviter at all."""
        return self.kind not in ("system", "unknown")

    @property
    def telemetry_kind(self) -> Literal["user", "agent", "system"]:
        if self.kind == "agent":
            return "agent"
        if self.kind in ("person", "command_sender", "platform_adder"):
            return "user"
        return "system"


class InviteRefused(PermissionError):
    """An owner's choice keeps these agents out.

    A ``PermissionError`` so the agent bridge answers it as a 403, and its text
    is written for the person who asked, not for a log.
    """

    def __init__(self, agents: list[Agent], inviter: Inviter) -> None:
        super().__init__(invite_refusal(agents, inviter))
        self.agent_ids = [agent.id for agent in agents]
        self.kind = inviter.kind


def invite_refusal(agents: list[Agent], inviter: Inviter) -> str:
    """The one sentence every invite path gives: what happened, and what to do.

    It never says where an agent already is; keeping that private is part of
    why invites are checked at all.
    """
    labels = ", ".join(
        agent_label_with_identifier(agent.display_name, agent.name) for agent in agents
    )
    if len(agents) == 1:
        message = (
            f"{labels} only takes instructions from people its owner has chosen, "
            "so you can't add it here. Ask its owner to add it, or to let you "
            "talk to it."
        )
    else:
        message = (
            f"{labels} only take instructions from people their owners have "
            "chosen, so you can't add them here. Ask their owners to add them, "
            "or to let you talk to them."
        )
    if inviter.kind in ("command_sender", "platform_adder"):
        # An owner on an unlinked chat account looks like a stranger. Say so,
        # or they are refused by their own agent with no idea why.
        message += (
            " If you are the owner, link this chat account to your Switch user in "
            "Switch Console and try again."
        )
    return message


def unverified_join_notice(agent: Agent, owner_handle: str | None) -> str:
    """What a channel reads when a restricted agent arrives and nobody can say
    who added it. It accuses no one: most of the time this is the owner or a
    teammate."""
    label = agent_label_with_identifier(agent.display_name, agent.name)
    owner = f"its owner (@{owner_handle})" if owner_handle else "its owner"
    return (
        f"{label} was added to this channel, but the platform didn't say who added "
        "it, so Switch couldn't check they're someone it takes instructions from. "
        f"It may not respond to everyone here, and {owner} can remove it if this "
        "wasn't expected."
    )


def unverified_join_owner_notice(agent: Agent, platform: str, channel_name: str) -> str:
    """What an owner reads when they have no account in the channel itself."""
    label = agent_label_with_identifier(agent.display_name, agent.name)
    return (
        f"{label} was added to {channel_name} on {platform}. The platform didn't say "
        "who added it, so Switch couldn't check they're someone it takes "
        "instructions from. If you didn't expect this, you can remove it from that "
        "room. It still won't act for anyone your settings don't allow."
    )


def needs_disclosure(agent: Agent) -> bool:
    """Whether an unverified join is worth saying out loud.

    An agent open to everyone would have admitted whoever it was, so there is
    nothing to report. A restricted agent's owner should know.
    """
    return not parse_policy(agent.addressing_policy).is_open()


class InviteGate:
    """Answers "may this inviter bring these agents here?" and nothing else."""

    def __init__(
        self,
        *,
        resolver: AddressingResolver,
        agent_store: AgentStore,
        external_user_store: ExternalUserStore,
    ) -> None:
        self._resolver = resolver
        self._agent_store = agent_store
        self._external_user_store = external_user_store

    async def refused(
        self,
        session: AsyncSession,
        inviter: Inviter,
        agents: list[Agent],
        *,
        room_id: str,
        group_id: str | None,
    ) -> list[Agent]:
        """The agents that refuse this inviter.

        ``room_id`` is "" for a room that does not exist yet, which a rule
        naming particular rooms does not admit.
        """
        if not inviter.is_judged:
            return []
        principal = await self._principal(session, inviter)
        return [
            agent
            for agent in agents
            if not await self._admits(
                session, agent, inviter, principal, room_id, group_id
            )
        ]

    async def _admits(
        self,
        session: AsyncSession,
        agent: Agent,
        inviter: Inviter,
        principal: SenderPrincipal | None,
        room_id: str,
        group_id: str | None,
    ) -> bool:
        if inviter.speaks_for is not None and agent.id not in inviter.speaks_for:
            # This inviter was only named for other agents; this one is not
            # theirs to answer for.
            return True
        if inviter.kind == "agent" and (
            inviter.subject == agent.id or agent.id in inviter.vouched_for
        ):
            # An agent seating itself (or an agent a template it is running
            # just created) must not be blocked by its own owner-only policy.
            return True
        if principal is None:
            # Nobody we can name. An agent open to everyone admits them; a
            # restricted one does not, which is what restricted means.
            return parse_policy(agent.addressing_policy).is_open()
        decision = await self._resolver.judge(
            session,
            agent=agent,
            principal=principal,
            room_id=room_id,
            group_id=group_id,
        )
        return decision.allowed

    async def _principal(
        self, session: AsyncSession, inviter: Inviter
    ) -> SenderPrincipal | None:
        """The inviter in the terms an addressing policy is written in."""
        if inviter.kind == "person":
            # In person: a rule naming a platform account is about that
            # platform, not about this sign-in, so no claimed account is
            # consulted here.
            return SenderPrincipal("user", "", [inviter.subject], None)
        if inviter.kind == "agent":
            agent = await self._agent_store.get(session, inviter.subject)
            if agent is None:
                return None
            return SenderPrincipal("agent", agent.id, [], agent.owner_id)
        if inviter.kind == "command_sender":
            return await self._resolver.resolve_sender(session, inviter.subject)
        account = await self._external_user_store.get_by_external_id(
            session, inviter.bridge_id, inviter.subject
        )
        if account is None:
            return None
        claimants = await self._external_user_store.claimant_ids(session, account.id)
        return SenderPrincipal("user", account.id, claimants, None)
