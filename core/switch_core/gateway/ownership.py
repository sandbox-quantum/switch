"""Handing an owned thing to another member of the workspace.

One route for every kind, because the rule is the same for all of them: the
current owner or a workspace admin, to a current member of this workspace.
What differs per kind lives in `accounts/transfer.py`.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.accounts.transfer import TransferRefused, transfer_ownership
from switch_core.authz import Principal
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.chats.service import ChatService
from switch_core.config import SwitchConfig
from switch_core.db.models import User, require_tenant_id, room_agents
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.chats import get_chat_service
from switch_core.gateway.dependencies import get_config, get_protocol, get_session

logger = logging.getLogger(__name__)

router = APIRouter()


class OwnershipTransferRequest(BaseModel):
    kind: str
    id: str
    new_owner_id: str


class OwnershipTransferResponse(BaseModel):
    kind: str
    id: str
    owner_id: str
    # True for an agent: its API key was re-issued to the new owner, and the
    # agent has to be reconnected with it.
    agent_key_reissued: bool


@router.post("/ownership/transfer")
async def transfer(
    req: OwnershipTransferRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    chat_service: Annotated[ChatService, Depends(get_chat_service)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> OwnershipTransferResponse:
    """Make another current member of this workspace the owner of an agent,
    room, package, reference, reference type, library document or template.

    `kind` is one of `agent`, `room`, `package`, `reference`,
    `reference_type`, `document`, `template`; `id` is the thing's id, or the
    slug for a reference type. A refusal is the status and message from
    `TransferRefused`, and changes nothing.
    """
    tenant_id = require_tenant_id()
    try:
        done = await transfer_ownership(
            session,
            tenant_id=tenant_id,
            kind=req.kind,
            resource_id=req.id,
            new_owner_id=req.new_owner_id,
            caller=Principal(user.id, is_admin),
            keyring=config.keyring,
        )
    except TransferRefused as refused:
        await session.rollback()
        raise HTTPException(status_code=refused.status, detail=str(refused)) from None
    rooms: list[str] = []
    if done.kind == "agent":
        rooms = list(
            await session.scalars(
                select(room_agents.c.room_id).where(
                    room_agents.c.agent_id == done.resource_id
                )
            )
        )
    await session.commit()

    if done.retired_key_hash is not None:
        protocol.api_key_cache.invalidate(done.retired_key_hash)
        protocol.api_key_cache.invalidate_agent(done.resource_id)
        # Its connections authenticated with the old key when they opened.
        # After the key is dropped, so a client told cannot open another.
        await protocol.connections.agent_key_reissued(done.resource_id)
    # A chat membership held only because its holder owned this agent goes
    # with the ownership.
    for room_id in rooms:
        await chat_service.sync_room(tenant_id, room_id)
    logger.info(
        "%s moved %s %s from %s to %s",
        user.id,
        done.kind,
        done.resource_id,
        done.previous_owner_id,
        done.new_owner_id,
    )
    return OwnershipTransferResponse(
        kind=done.kind,
        id=done.resource_id,
        owner_id=done.new_owner_id,
        agent_key_reissued=done.retired_key_hash is not None,
    )
