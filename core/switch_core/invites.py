"""Who may bring an agent into a room.

An agent's addressing policy says who may talk to it (`addressing`). The same
policy decides who may invite it into a room: an agent that sits in a room
whose people it may not answer only ever replies that it can't act, and its
presence tells everyone there where it is used. So "may invite" is "may
address", answered by the same functions the router uses for messages.

Every path that adds agents to a room, existing or new, goes through
`RoomService.add_agents_to_room` or `RoomService.create_room`, and both take the
`Inviter` as a required argument and ask `InviteGate.check` before anything is
written. That includes joins made on the platform itself. A future path cannot
skip the check without saying who it is inviting for, and nobody is let in on
an implicit admin bypass. Agents already in a room are not checked again:
tightening a policy changes who may invite next, not who is already there.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from switch_core.agent_display_name import agent_label_with_identifier
from switch_core.db.models import User
from switch_core.delivery.addressing import (
    SenderPrincipal,
    principal_permitted,
    resolve_sender,
    unclaimed_owner_refusal,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import Agent
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.client_store import ClientStore
    from switch_core.db.stores.external_user_store import ExternalUserStore

logger = logging.getLogger(__name__)

InviterKind = Literal["user", "agent", "chat", "platform"]


@dataclass(frozen=True)
class Inviter:
    """On whose authority agents are being added to a room.

    - `user`: a Switch user, by user id (the gateway, Switch Console, a
      template a person runs). Judged as that person, with the chat accounts
      they have claimed, exactly as the platform acting for them is.
    - `agent`: an agent, by agent id (its MCP tools and HTTP API).
    - `chat`: whoever typed a command in a room, by their transport user id
      (`!invite-agent`, `/invite-agent`). Judged as the sender of a message.
    - `platform`: an agent's bot added to a channel on the platform itself.
      `id` is the platform account that added it, on `bridge_id`, judged as
      that account; empty when the platform does not say who it was, and then
      the join is let through but disclosed (`InviteOutcome.unverified`).
    """

    kind: InviterKind
    id: str
    bridge_id: str | None

    @classmethod
    def user(cls, user_id: str) -> Inviter:
        return cls("user", user_id, None)

    @classmethod
    def agent(cls, agent_id: str) -> Inviter:
        return cls("agent", agent_id, None)

    @classmethod
    def chat(cls, transport_user_id: str) -> Inviter:
        return cls("chat", transport_user_id, None)

    @classmethod
    def platform(cls, bridge_id: str, added_by: str | None) -> Inviter:
        """A join made on the platform, by `added_by` (a platform account id)
        when the platform reports who it was, else None."""
        return cls("platform", added_by or "", bridge_id)

    @property
    def unknown(self) -> bool:
        """A platform join whose platform did not say who made it."""
        return self.kind == "platform" and not self.id

    @property
    def actor_kind(self) -> Literal["user", "agent", "system"]:
        """The kind telemetry counts this inviter as."""
        if self.kind == "platform":
            return "system" if self.unknown else "user"
        return "user" if self.kind == "chat" else self.kind


class InviteRefused(PermissionError):
    """An agent's addressing policy does not let this inviter add it to a room.

    A PermissionError, so every front door that already answers 403 to one
    answers it here too. The message says why and who can add the agent.
    """

    def __init__(self, agent: Agent, message: str) -> None:
        super().__init__(message)
        self.agent_id = agent.id
        self.agent_name = agent.name


@dataclass
class InviteOutcome:
    """What the gate decided for each agent of one invite."""

    refused: list[InviteRefused] = field(default_factory=list)
    #: Let in although nobody could say who asked for it: a platform join the
    #: platform did not attribute. The caller discloses each one.
    unverified: list[Agent] = field(default_factory=list)

    @property
    def refused_ids(self) -> set[str]:
        return {refusal.agent_id for refusal in self.refused}


def refusal_message(agent: Agent, owner_name: str | None, *, unclaimed: bool) -> str:
    """What a refused inviter is told: why, and who can add the agent instead."""
    label = agent_label_with_identifier(agent.display_name, agent.name)
    if unclaimed:
        return (
            f"{label} only joins rooms its owner adds it to, and this chat "
            "account isn't linked to a Switch user yet, so Switch can't tell "
            "whether that's you. If it is, link this account to your Switch "
            "user in Switch Console and try again."
        )
    who = f"its owner, {owner_name}," if owner_name else "its owner"
    return (
        f"{label} can only be added to a room by someone it takes instructions "
        f"from, and its addressing policy doesn't include you. Ask {who} to add "
        "it, or to change who it takes instructions from."
    )


class InviteGate:
    """Judges an invite by the invited agents' addressing policies."""

    def __init__(
        self,
        *,
        agent_store: AgentStore,
        client_store: ClientStore,
        external_user_store: ExternalUserStore,
    ) -> None:
        self._agent_store = agent_store
        self._client_store = client_store
        self._external_user_store = external_user_store

    async def check(
        self,
        session: AsyncSession,
        *,
        inviter: Inviter,
        agents: Sequence[Agent],
        room_id: str | None,
        group_id: str | None,
    ) -> InviteOutcome:
        """Which agents `inviter` may not add, and which it adds unverified.

        `room_id` is None for a room still being created. It has no id yet,
        so a rule scoped to particular rooms cannot admit the invite; rules
        for any room, or for the room's group, still can.
        """
        outcome = InviteOutcome()
        if not agents:
            return outcome
        if inviter.unknown:
            outcome.unverified = list(agents)
            return outcome
        principal = await self._principal(session, inviter)
        for agent in agents:
            if principal is not None and await principal_permitted(
                session,
                agent=agent,
                principal=principal,
                room_id=room_id or "",
                group_id=group_id,
                claimed_accounts=self._claimed_accounts,
            ):
                continue
            owner = await session.get(User, agent.owner_id) if agent.owner_id else None
            unclaimed = principal is not None and unclaimed_owner_refusal(
                agent, principal
            )
            logger.warning(
                "Invite of %s refused: %s %s may not address it (room %s)",
                agent.name,
                inviter.kind,
                inviter.id,
                room_id or "being created",
            )
            outcome.refused.append(
                InviteRefused(
                    agent,
                    refusal_message(
                        agent, owner.name if owner else None, unclaimed=unclaimed
                    ),
                )
            )
        return outcome

    async def _principal(
        self, session: AsyncSession, inviter: Inviter
    ) -> SenderPrincipal | None:
        """The inviter in the terms an addressing policy is written in."""
        if inviter.kind == "user":
            # A person acting through Switch rather than a chat account: the
            # policy is asked what it would say to them in person.
            return SenderPrincipal("platform", "", [], None, on_behalf_of=inviter.id)
        if inviter.kind == "agent":
            agent = await self._agent_store.get(session, inviter.id)
            if agent is None:
                return None
            return SenderPrincipal("agent", agent.id, [], agent.owner_id)
        if inviter.kind == "platform":
            assert inviter.bridge_id is not None
            account = await self._external_user_store.get_by_external_id(
                session, inviter.bridge_id, inviter.id
            )
            if account is None:
                # Someone Switch has never seen on this platform: nobody has
                # claimed them, so they are judged as an unlinked account.
                return SenderPrincipal("user", inviter.id, [], None)
            claimants = await self._external_user_store.claimant_ids(
                session, account.id
            )
            return SenderPrincipal("user", account.id, claimants, None)
        return await resolve_sender(
            session,
            inviter.id,
            None,
            client_store=self._client_store,
            agent_store=self._agent_store,
            external_user_store=self._external_user_store,
        )

    async def _claimed_accounts(self, session: AsyncSession, user_id: str) -> list[str]:
        claimed = await self._external_user_store.get_by_user(session, user_id)
        return [ext.id for ext in claimed]

    async def owner_handle(
        self, session: AsyncSession, agent: Agent, bridge_id: str | None
    ) -> str | None:
        """The owner's account on this room's platform, to @-mention them.

        The same rule as the owner pings in agents' replies: the account the
        owner has claimed on this bridge, the first by name if several.
        """
        if agent.owner_id is None or bridge_id is None:
            return None
        claimed = await self._external_user_store.get_by_user(session, agent.owner_id)
        here = sorted(u.external_username for u in claimed if u.bridge_id == bridge_id)
        return here[0] if here else None


def unverified_notice(agent: Agent, owner_handle: str | None) -> str:
    """Posted when an agent was added on the platform by someone unnamed."""
    label = agent_label_with_identifier(agent.display_name, agent.name)
    owner = f"its owner (@{owner_handle})" if owner_handle else "its owner"
    return (
        f"{label} was added to this channel, but the chat app didn't say who "
        "added it, so Switch couldn't check that its addressing policy allows "
        f"them. It's here for now; {owner} can remove it with "
        f"`!remove-agent @{agent.name}`."
    )


def refused_join_notice(refusal: InviteRefused) -> str:
    """Posted when someone added an agent on the platform that may not."""
    return (
        "An agent was added to this channel, but Switch didn't bring it into "
        f"this room: {refusal}"
    )
