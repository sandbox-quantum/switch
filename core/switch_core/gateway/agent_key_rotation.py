"""Re-issuing an agent's key on request, for a key that may have leaked.

The same re-issue handing an agent to a new owner does (`accounts/transfer.py`):
the key row keeps its id and gets a new secret, the agent's connection rows
go in the same transaction, and once it commits every process drops the old
secret and closes the connections made with it
(`AgentConnectionRegistry.agent_key_reissued`). The new secret is answered
once, as registering the agent answers it; its owner can reveal it again
later, as any agent key.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.accounts.transfer import reissue_agent_key
from switch_core.authz import Principal, can_manage
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.config import SwitchConfig
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import Agent, User, require_tenant_id
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import get_config, get_protocol, get_session
from switch_core.gateway.schemas import RotateAgentKeyResponse

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/agents/{agent_id}/key/rotate")
async def rotate_agent_key(
    agent_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> RotateAgentKeyResponse:
    """Give the agent a new key and refuse the old one everywhere, closing
    every connection made with it. Its owner, a workspace admin or the
    server's operator. Whatever runs the agent with its own key has to be
    given the new one; an agent run by a device is not affected, since its
    device acts for it with credentials of its own."""
    tenant_id = require_tenant_id()
    agent = await session.scalar(
        select(Agent)
        .where(Agent.tenant_id == tenant_id, Agent.id == agent_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")
    if not can_manage(Principal(user.id, is_admin), agent.owner_id):
        raise HTTPException(
            status_code=403,
            detail="Only the agent's owner, a workspace admin or the server's "
            "operator can rotate its key.",
        )
    reissued = await reissue_agent_key(session, agent, config.keyring)
    await AgentConnectionStore().delete_agent(
        session, tenant_id=tenant_id, agent_id=agent.id
    )
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=user.id,
        action=AuditAction.AGENT_KEY_ROTATED,
        target_type="agent",
        target_id=agent.id,
        details={"api_key_id": agent.api_key_id},
    )
    await session.commit()

    protocol.api_key_cache.invalidate(reissued.retired_hash)
    protocol.api_key_cache.invalidate_agent(agent_id)
    # After the old secret is dropped, so a client told cannot open another
    # connection with it here.
    await protocol.connections.agent_key_reissued(agent_id)
    logger.warning("%s rotated the key of agent %s", user.id, agent_id)
    return RotateAgentKeyResponse(agent_id=agent_id, api_key=reissued.plaintext)
