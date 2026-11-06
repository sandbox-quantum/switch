"""Addressing authority for a new membership, shared by every invite path."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import allows_on_behalf_of, can_address, parse_policy
from switch_core.db.models import Agent
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver, SenderPrincipal


class InvitationActor(BaseModel):
    """Supplied by authenticated code, never taken from a request body.

    Unknown is an explicit platform limitation, not a default administrator.
    """

    kind: Literal["user", "agent", "sender", "external", "unknown"]
    id: str | None = None


class InvitationDenied(ValueError):
    """The target's policy refuses this new membership."""


async def require_invitation(
    session: AsyncSession,
    *,
    agent: Agent,
    actor: InvitationActor | None,
    room_id: str,
    group_id: str | None,
) -> bool:
    """Refuse a known unauthorized inviter; return whether origin is unknown.

    No administrator exception exists. New-room checks use an empty room id:
    a rule naming existing rooms cannot authorize creating another.
    """
    if actor is not None and actor.kind == "unknown":
        return True
    policy = parse_policy(getattr(agent, "addressing_policy", None))
    if policy.is_open() and (actor is None or actor.kind != "sender"):
        return False
    external_users = ExternalUserStore()
    principal: SenderPrincipal | None = None
    allowed = policy.is_open()
    if actor is not None and actor.id:
        if actor.kind == "user":
            accounts = await external_users.get_by_user(session, actor.id)
            allowed = allows_on_behalf_of(
                policy,
                room_id=room_id,
                group_id=group_id,
                user_id=actor.id,
                external_user_ids=[account.id for account in accounts],
                owner_user_id=agent.owner_id,
            )
        else:
            if actor.kind == "agent":
                sender = await AgentStore().get(session, actor.id)
                if sender is not None:
                    principal = SenderPrincipal("agent", sender.id, [], sender.owner_id)
            elif actor.kind == "external":
                account = await external_users.get(session, actor.id)
                if account is not None:
                    principal = SenderPrincipal(
                        "user",
                        account.id,
                        await external_users.claimant_ids(session, account.id),
                        None,
                    )
            elif actor.kind == "sender":
                resolver = AddressingResolver(
                    room_store=RoomStore(),
                    room_role_store=RoomRoleStore(),
                    client_store=ClientStore(),
                    agent_store=AgentStore(),
                    external_user_store=external_users,
                    live_connection_ids=set,
                )
                principal = await resolver.resolve_sender(session, actor.id)
            if principal is not None:
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
    if not allowed:
        raise InvitationDenied(
            f"Cannot invite {agent.name}: its addressing policy does not allow "
            "you to direct it in this room. Ask the agent's owner to invite it "
            "or change its addressing policy. Link your chat account in Switch "
            "Console if you are the owner."
        )
    return False
