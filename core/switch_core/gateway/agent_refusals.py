"""The requests agents were refused, as their owners see them.

What a refusal is and when one is recorded is in ``agent_refusals``. Switch
Console shows these quietly under Templates.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AgentRefusal, User
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import get_session

router = APIRouter()

# A look at what happened lately, not a history.
RECENT_REFUSALS = 50


class AgentRefusalEntry(BaseModel):
    id: str
    agent_id: str | None
    agent_name: str | None
    operation: str
    reason: str
    message: str
    subject: str | None
    created_at: datetime


@router.get("/agent-refusals")
async def list_agent_refusals(
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[AgentRefusalEntry]:
    """The viewer's agents' refusals, newest first. An admin sees every
    agent's, the same reach they have over runs."""
    stmt = select(AgentRefusal).order_by(AgentRefusal.created_at.desc())
    if not is_admin:
        stmt = stmt.where(AgentRefusal.owner_id == user.id)
    rows = (await session.execute(stmt.limit(RECENT_REFUSALS))).scalars().all()
    return [
        AgentRefusalEntry(
            id=r.id,
            agent_id=r.agent_id,
            agent_name=r.agent_name,
            operation=r.operation,
            reason=r.reason,
            message=r.message,
            subject=r.subject,
            created_at=r.created_at,  # type: ignore[arg-type]
        )
        for r in rows
    ]
