"""Who may add an agent to a room.

An agent's addressing policy says who may talk to it. Adding the agent to a
room is a way of talking to it from there, and it shows everyone in the room
where the agent is used, so the rule is the same one: whoever the policy would
admit in that room may add it, and nobody else.

`RoomService.add_agents_to_room` and `create_room` take an `Inviter`, with no
default, and ask it about every agent before anything is written. A caller has
to say who is asking; the one that is not a person or an agent says `SystemInviter`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from switch_core.addressing import allows_on_behalf_of, can_address, parse_policy

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.db.models import Agent
    from switch_core.delivery.addressing import AddressingResolver


class Inviter(Protocol):
    async def may_invite(
        self,
        session: AsyncSession,
        agent: Agent,
        *,
        room_id: str,
        group_id: str | None,
    ) -> bool:
        """Whether this inviter may add `agent` to the room. `room_id` is "" for
        a room that does not exist yet."""
        ...


class InviteRefused(ValueError):
    """The agents the inviter may not add. A `ValueError`, so a caller that
    reports every refusal of an invite the same way still does."""

    def __init__(self, agents: Sequence[Agent]) -> None:
        self.agents = list(agents)
        names = ", ".join(agent.name for agent in self.agents)
        super().__init__(
            f"Not permitted to add {names} to this room: it does not take "
            "instructions from you here. Ask its owner to add it, or to change "
            "who may talk to it."
            if len(self.agents) == 1
            else f"Not permitted to add {names} to this room: they do not take "
            "instructions from you here. Ask their owners to add them, or to "
            "change who may talk to them."
        )


@dataclass(frozen=True)
class SystemInviter:
    """Switch acting for no one: a channel the platform delivered to a bridge,
    or a room an operator's configuration describes. Nothing is asked."""

    reason: str

    async def may_invite(
        self,
        session: AsyncSession,
        agent: Agent,
        *,
        room_id: str,
        group_id: str | None,
    ) -> bool:
        return True


@dataclass(frozen=True)
class UserInviter:
    """A Switch user acting as themselves, as in the gateway. Judged as the
    platform judges a message it sends for them: no claimed chat account is
    consulted."""

    user_id: str

    async def may_invite(
        self,
        session: AsyncSession,
        agent: Agent,
        *,
        room_id: str,
        group_id: str | None,
    ) -> bool:
        return allows_on_behalf_of(
            parse_policy(agent.addressing_policy),
            room_id=room_id,
            group_id=group_id,
            user_id=self.user_id,
            external_user_ids=[],
            owner_user_id=agent.owner_id,
        )


@dataclass(frozen=True)
class AgentInviter:
    """An agent adding another, as through the MCP tool. It gets in through the
    policy's `agents` list, or its `owner_agents` rule when both have one owner;
    an agent is never its target's owner. An agent that can manage agents for
    the target's owner may as well, as it may remove one."""

    agent_id: str
    owner_id: str | None
    can_manage_agents: bool

    async def may_invite(
        self,
        session: AsyncSession,
        agent: Agent,
        *,
        room_id: str,
        group_id: str | None,
    ) -> bool:
        if (
            self.can_manage_agents
            and self.owner_id is not None
            and self.owner_id == agent.owner_id
        ):
            return True
        policy = parse_policy(agent.addressing_policy)
        if policy.is_open():
            return True
        return can_address(
            policy,
            room_id=room_id,
            group_id=group_id,
            sender_kind="agent",
            sender_id=self.agent_id,
            sender_user_ids=[],
            sender_owner_user_id=self.owner_id,
            owner_user_id=agent.owner_id,
        )


@dataclass(frozen=True)
class ChatInviter:
    """Whoever wrote a command in a room, however they are known: a chat account,
    a Console user, or an agent. Judged exactly as the same sender addressing the
    agent in that room, by the resolver that decides that."""

    resolver: AddressingResolver
    sender: str
    content: Mapping[str, object] = field(default_factory=dict)

    async def may_invite(
        self,
        session: AsyncSession,
        agent: Agent,
        *,
        room_id: str,
        group_id: str | None,
    ) -> bool:
        decision = await self.resolver.permitted(
            session,
            agent=agent,
            room_id=room_id,
            sender=self.sender,
            content=self.content,
        )
        return decision.allowed


async def refused_agents(
    inviter: Inviter,
    session: AsyncSession,
    agents: Sequence[Agent],
    *,
    room_id: str,
    group_id: str | None,
) -> list[Agent]:
    """The agents among `agents` that `inviter` may not add."""
    return [
        agent
        for agent in agents
        if not await inviter.may_invite(
            session, agent, room_id=room_id, group_id=group_id
        )
    ]
