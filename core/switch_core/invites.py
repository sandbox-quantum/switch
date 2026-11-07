"""Who may bring an agent into a room.

An owner chooses who their agent takes instructions from. That choice should
also decide who can bring the agent into a room. Otherwise the agent sits among
people it cannot help, and anyone can learn where it is used just by inviting it.

Nothing here restates the rules. An invite is asked of the same
`AddressingResolver.judge` that decides every message, so what someone can say
to an agent and whether they can invite it cannot drift apart. This module adds
only the shape of "who is asking" and the sentence a person reads when the answer
is no.
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

InviterKind = Literal["person", "agent", "sender", "chat_account", "unknown", "switch"]


@dataclass(frozen=True)
class Inviter:
    """Who is asking for an agent to join a room.

    Build one with the classmethod that says what you actually know. There is no
    default, because a path that cannot say who is asking should not be able to
    add an agent.
    """

    kind: InviterKind
    subject: str = ""
    bridge_id: str = ""
    vouched_for: frozenset[str] = frozenset()
    # When set, the only agents this inviter is known to have brought.
    speaks_for: frozenset[str] | None = None

    @classmethod
    def person(cls, user_id: str) -> Inviter:
        """Someone signed in to the gateway or Switch Console."""
        return cls("person", user_id)

    @classmethod
    def agent(
        cls, agent_id: str, *, created_for_this_run: frozenset[str] = frozenset()
    ) -> Inviter:
        """An agent acting on its own authority, never its owner's. An agent
        gets in through its owner's `owner_agents` rule, not by borrowing them.

        `created_for_this_run` are agents a template it is running has just made.
        They belong to the person it runs for, so a team of private agents can
        still be put in the room the same template describes.
        """
        return cls("agent", agent_id, vouched_for=created_for_this_run)

    @classmethod
    def sender(cls, transport_user_id: str) -> Inviter:
        """Whoever typed a chat command, as the room knows them."""
        return cls("sender", transport_user_id)

    @classmethod
    def chat_account(cls, bridge_id: str, external_user_id: str) -> Inviter:
        """The person a messaging platform says added the bot to a channel."""
        return cls("chat_account", external_user_id, bridge_id)

    @classmethod
    def unknown_adder(cls) -> Inviter:
        """The platform put the agent there and did not say who asked.

        The join stands, because refusing would leave a channel broken for a
        reason nobody there could fix. It is never trusted quietly: the caller
        discloses it (`needs_disclosure`).
        """
        return cls("unknown")

    @classmethod
    def switch(cls, reason: str) -> Inviter:
        """Switch's own machinery, acting for nobody. Not judged.

        `reason` is there for the person reading the call site: an exemption from
        an owner's choice should have to explain itself.
        """
        return cls("switch", reason)

    def only_for(self, agent_ids: Collection[str]) -> Inviter:
        """This inviter, for these agents alone.

        A platform names who added one bot. Other bots found in the same channel
        got there some other way, so that person shouldn't answer for them.
        """
        return replace(self, speaks_for=frozenset(agent_ids))

    @property
    def is_judged(self) -> bool:
        """Whether an addressing policy is asked about this inviter at all."""
        return self.kind not in ("switch", "unknown")

    @property
    def telemetry_kind(self) -> Literal["user", "agent", "system"]:
        if self.kind == "agent":
            return "agent"
        if self.kind in ("person", "sender", "chat_account"):
            return "user"
        return "system"


class InviteRefused(PermissionError):
    """An owner's choice keeps these agents out. A `PermissionError`, so the agent
    bridge already answers it as a 403, and its text is written for the person."""

    def __init__(self, agents: list[Agent], inviter: Inviter) -> None:
        super().__init__(invite_refusal(agents, inviter))
        self.agent_ids = [agent.id for agent in agents]


def invite_refusal(agents: list[Agent], inviter: Inviter) -> str:
    """The one sentence every invite path gives: what happened and what to do next.

    It never says where an agent already is, since keeping that private is part of
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
    if inviter.kind in ("sender", "chat_account"):
        # An owner on a chat account they never linked looks like a stranger. Tell
        # them, or they get refused by their own agent with no idea why.
        message += (
            " If you are the owner, link this chat account to your Switch user in "
            "Switch Console and try again."
        )
    return message


def unverified_join_notice(agent: Agent, owner_handle: str | None) -> str:
    """What a channel reads when a restricted agent arrives and nobody can say who
    added it. It accuses no one: most of the time this is the owner or a teammate."""
    label = agent_label_with_identifier(agent.display_name, agent.name)
    owner = f"its owner (@{owner_handle})" if owner_handle else "its owner"
    return (
        f"{label} was added to this channel, but the platform didn't say who added "
        "it, so Switch couldn't check they're someone it takes instructions from. "
        f"It may not respond to everyone here, and {owner} can remove it if this "
        "wasn't expected."
    )


def unverified_join_owner_notice(agent: Agent, platform: str, channel_name: str) -> str:
    """What an owner with no account on that platform reads, because a mention in
    the channel would never reach them."""
    label = agent_label_with_identifier(agent.display_name, agent.name)
    return (
        f"{label} was added to {channel_name} on {platform}. The platform didn't say "
        "who added it, so Switch couldn't check they're someone it takes "
        "instructions from. If you didn't expect this, you can remove it from that "
        "room. It still won't act for anyone your settings don't allow."
    )


def needs_disclosure(agent: Agent) -> bool:
    """Whether an unverified join is worth saying out loud. An agent open to
    everyone would have admitted whoever it was, so there is nothing to report."""
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
        """The agents that would refuse this inviter. `room_id` is "" for a room
        not made yet."""
        if inviter.kind in ("switch", "unknown"):
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
            return True
        # An agent making a room for its own work has to be able to be in it,
        # whoever its owner lets talk to it.
        if inviter.kind == "agent" and (
            inviter.subject == agent.id or agent.id in inviter.vouched_for
        ):
            return True
        # Nobody we can name: an agent open to everyone still admits them, and a
        # restricted one does not, which is what being restricted means.
        if principal is None:
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
            # In person, so no claimed chat account is consulted: a rule naming a
            # platform account is about that platform, not about this sign-in.
            return SenderPrincipal("user", "", [inviter.subject], None)
        if inviter.kind == "agent":
            agent = await self._agent_store.get(session, inviter.subject)
            if agent is None:
                return None
            return SenderPrincipal("agent", agent.id, [], agent.owner_id)
        if inviter.kind == "sender":
            return await self._resolver.resolve_sender(session, inviter.subject)
        account = await self._external_user_store.get_by_external_id(
            session, inviter.bridge_id, inviter.subject
        )
        if account is None:
            return None
        claimants = await self._external_user_store.claimant_ids(session, account.id)
        return SenderPrincipal("user", account.id, claimants, None)
