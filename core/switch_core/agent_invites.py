"""Apply an agent's addressing policy to the identity making an invitation."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import allows_on_behalf_of, can_address, parse_policy
from switch_core.db.models import Agent
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver, SenderPrincipal


class AgentInviter(BaseModel):
    kind: Literal["user", "agent", "sender", "platform"]
    subject: str | None
    bridge_id: str | None = None

    @model_validator(mode="after")
    def valid_source(self) -> AgentInviter:
        if self.kind == "platform":
            if not self.bridge_id:
                raise ValueError("A platform inviter needs its connection id")
        elif not self.subject:
            raise ValueError("An inviter needs an identity")
        return self


class AgentInviteDenied(PermissionError):
    pass


class AgentInvitePolicy:
    def __init__(self, agent_store: AgentStore, room_store: RoomStore) -> None:
        self._agents = agent_store
        self._external = ExternalUserStore()
        self._addressing = AddressingResolver(
            room_store=room_store,
            room_role_store=RoomRoleStore(),
            client_store=ClientStore(),
            agent_store=agent_store,
            external_user_store=self._external,
            live_connection_ids=set,
        )

    async def _principal(
        self, session: AsyncSession, inviter: AgentInviter | None
    ) -> SenderPrincipal | None:
        if inviter is None or inviter.subject is None:
            return None
        if inviter.kind == "sender":
            return await self._addressing.resolve_sender(session, inviter.subject)
        if inviter.kind == "agent":
            agent = await self._agents.get(session, inviter.subject)
            return (
                SenderPrincipal("agent", agent.id, [], agent.owner_id)
                if agent is not None
                else None
            )
        if inviter.kind == "platform":
            assert inviter.bridge_id is not None
            external = await self._external.get_by_external_id(
                session, inviter.bridge_id, inviter.subject
            )
            if external is None:
                return None
            return SenderPrincipal(
                "user",
                external.id,
                await self._external.claimant_ids(session, external.id),
                None,
            )
        return None

    async def require(
        self,
        session: AsyncSession,
        *,
        agent_ids: list[str],
        room_id: str,
        group_id: str | None,
        inviter: AgentInviter | None,
    ) -> list[Agent]:
        if not agent_ids:
            return []
        agents = list(
            (
                await session.scalars(
                    select(Agent)
                    .where(Agent.id.in_(agent_ids))
                    .order_by(Agent.id)
                    .with_for_update()
                )
            ).all()
        )
        if set(agent_ids) != {agent.id for agent in agents}:
            raise ValueError("An invited agent no longer exists")
        if (
            inviter is not None
            and inviter.kind == "platform"
            and inviter.subject is None
        ):
            return agents
        principal = await self._principal(session, inviter)
        for agent in agents:
            policy = parse_policy(agent.addressing_policy)
            if inviter is not None and inviter.kind == "user":
                assert inviter.subject is not None
                allowed = allows_on_behalf_of(
                    policy,
                    room_id=room_id,
                    group_id=group_id,
                    user_id=inviter.subject,
                    external_user_ids=await self._addressing.claimed_accounts(
                        session, inviter.subject
                    ),
                    owner_user_id=agent.owner_id,
                )
            elif principal is not None:
                allowed = can_address(
                    policy,
                    room_id=room_id,
                    group_id=group_id,
                    sender_kind=principal.kind,
                    sender_id=principal.id,
                    sender_user_ids=principal.user_ids,
                    sender_owner_user_id=principal.owner_user_id,
                    owner_user_id=agent.owner_id,
                )
            else:
                allowed = policy.is_open()
            if not allowed:
                raise AgentInviteDenied(
                    f"You cannot invite agent '{agent.name}' into this room: its "
                    "addressing policy does not allow you here. Ask its owner to "
                    "invite it or update the policy. If you are the owner, link "
                    "your platform account in Switch Console."
                )
        return []
