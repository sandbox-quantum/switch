"""Who may put an agent into a room (#805).

An agent's addressing policy says who may send it work, and an invite is how
work reaches it: a room it has been put in is a room people can address it in.
So an invite is judged by the same policy, as whoever is doing the inviting,
before the agent is added. `InviteGate.require` is that one judgement; every
route that puts an agent in a room (the `!invite-agent` command, the
`invite_agent_to_room` and `create_room` tools, the gateway's room page, a
Console chat, a template run, a channel the platform bridged) asks it.

Only agents that are about to be added are judged. An agent already in the room
stays, whatever its policy says now, so tightening a policy never empties a
room.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from switch_core.addressing import allows_on_behalf_of, parse_policy
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
    """A signed-in Switch user (the gateway's room page, a Console chat, a
    template they run)."""

    user_id: str


@dataclass(frozen=True)
class AgentInviter:
    """An agent inviting through a tool or the agent bridge's API, judged as
    that agent rather than as its owner."""

    agent_id: str


@dataclass(frozen=True)
class ChatSender:
    """Someone typing a command in a room, known only by their transport id."""

    transport_user_id: str


@dataclass(frozen=True)
class PlatformInviter:
    """A person adding the bridge's bot to a channel on the platform.

    `external_user_id` is the platform's id for them, or None when the
    platform did not say who it was.
    """

    bridge_id: str
    external_user_id: str | None


Inviter = UserInviter | AgentInviter | ChatSender | PlatformInviter


def actor_kind(inviter: Inviter) -> Literal["user", "agent", "system"]:
    """How telemetry counts this inviter."""
    if isinstance(inviter, AgentInviter):
        return "agent"
    if isinstance(inviter, PlatformInviter):
        return "system"
    return "user"


class InviteRefused(PermissionError):
    """An invite the agents' addressing policies do not allow.

    `agent_ids` and `agent_names` are the agents that refused it; the message
    says why, and who can invite them instead.
    """

    def __init__(
        self, message: str, agent_ids: list[str], agent_names: list[str]
    ) -> None:
        super().__init__(message)
        self.agent_ids = agent_ids
        self.agent_names = agent_names


class InviteGate:
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

    async def refused(
        self,
        session: AsyncSession,
        inviter: Inviter,
        agents: list[Agent],
        *,
        room_id: str,
        group_id: str | None,
    ) -> list[Agent]:
        """The agents among `agents` that `inviter` may not put in the room.

        `room_id` is "" for a room that is not made yet, which no rule can
        name; `group_id` is the group it will be filed under.
        """
        if isinstance(inviter, PlatformInviter) and inviter.external_user_id is None:
            return []
        refused: list[Agent] = []
        for agent in agents:
            if not await self._may_invite(
                session, inviter, agent, room_id=room_id, group_id=group_id
            ):
                refused.append(agent)
        return refused

    async def require(
        self,
        session: AsyncSession,
        inviter: Inviter,
        agent_ids: list[str],
        *,
        room_id: str,
        group_id: str | None,
    ) -> None:
        """Raise `InviteRefused` unless `inviter` may put every one of
        `agent_ids` in the room. Nothing is added by the caller until this
        returns."""
        agents = [
            agent
            for agent_id in agent_ids
            if (agent := await self._agents.get(session, agent_id)) is not None
        ]
        refused = await self.refused(
            session, inviter, agents, room_id=room_id, group_id=group_id
        )
        if refused:
            raise InviteRefused(
                await self._explain(session, inviter, refused),
                [agent.id for agent in refused],
                [agent.name for agent in refused],
            )

    async def _may_invite(
        self,
        session: AsyncSession,
        inviter: Inviter,
        agent: Agent,
        *,
        room_id: str,
        group_id: str | None,
    ) -> bool:
        policy = parse_policy(agent.addressing_policy)
        if policy.is_open():
            return True
        if isinstance(inviter, AgentInviter) and inviter.agent_id == agent.id:
            return True
        if isinstance(inviter, UserInviter):
            return allows_on_behalf_of(
                policy,
                room_id=room_id,
                group_id=group_id,
                user_id=inviter.user_id,
                external_user_ids=await self._resolver.claimed_accounts(
                    session, inviter.user_id
                ),
                owner_user_id=agent.owner_id,
            )
        principal = await self._principal(session, inviter)
        if principal is None:
            return policy.is_open()
        decision = await self._resolver.judge(
            session,
            agent=agent,
            room_id=room_id,
            group_id=group_id,
            principal=principal,
        )
        return decision.allowed

    async def _principal(
        self, session: AsyncSession, inviter: Inviter
    ) -> SenderPrincipal | None:
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
            assert inviter.external_user_id is not None
            account = await self._external_users.get_by_external_id(
                session, inviter.bridge_id, inviter.external_user_id
            )
            if account is None:
                return None
            claimants = await self._external_users.claimant_ids(session, account.id)
            return SenderPrincipal("user", account.id, claimants, None)
        raise TypeError(f"Not an inviter: {inviter!r}")

    async def _explain(
        self, session: AsyncSession, inviter: Inviter, refused: list[Agent]
    ) -> str:
        who = {
            UserInviter: "you",
            ChatSender: "you",
            AgentInviter: "this agent",
            PlatformInviter: "the person who added the bot",
        }[type(inviter)]
        lines: list[str] = []
        for agent in refused:
            owner = await session.get(User, agent.owner_id) if agent.owner_id else None
            can = (
                f"Its owner ({owner.name}) can invite it"
                if owner is not None
                else "Only an admin can change who it takes instructions from"
            )
            lines.append(
                f"{agent.name} doesn't take instructions from {who}, so it wasn't "
                f"added. {can}, or can change who it takes instructions from."
            )
        return " ".join(lines)
