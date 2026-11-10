"""The signed-in owner's pending, workspace-scoped notices."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Agent, OwnerNotice, Room, User, require_tenant_id
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session

router = APIRouter()


class OwnerNoticeView(BaseModel):
    id: str
    owner_id: str
    tenant_id: str
    kind: Literal["unverified_agent_invite"]
    agent_name: str
    room_name: str
    created_at: datetime


@router.get("/owner-notices")
async def list_owner_notices(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[OwnerNoticeView]:
    rows = await session.execute(
        select(OwnerNotice, Agent.name, Room.name)
        .join(
            Agent,
            and_(
                Agent.id == OwnerNotice.agent_id,
                Agent.tenant_id == OwnerNotice.tenant_id,
            ),
        )
        .join(
            Room,
            and_(
                Room.id == OwnerNotice.room_id, Room.tenant_id == OwnerNotice.tenant_id
            ),
        )
        .where(OwnerNotice.tenant_id == require_tenant_id(), Agent.owner_id == user.id)
        .order_by(OwnerNotice.created_at, OwnerNotice.id)
        .limit(100)
    )
    return [
        OwnerNoticeView(
            id=notice.id,
            owner_id=user.id,
            tenant_id=notice.tenant_id,
            kind="unverified_agent_invite",
            agent_name=agent_name,
            room_name=room_name,
            created_at=notice.created_at,
        )
        for notice, agent_name, room_name in rows
    ]


@router.delete("/owner-notices/{notice_id}", status_code=204)
async def dismiss_owner_notice(
    notice_id: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    # Lock the agent while authorizing so a concurrent transfer cannot change
    # who may dismiss this notice between the check and the delete.
    agent_id = await session.scalar(
        select(Agent.id)
        .join(
            OwnerNotice,
            and_(
                OwnerNotice.agent_id == Agent.id,
                OwnerNotice.tenant_id == Agent.tenant_id,
            ),
        )
        .where(
            OwnerNotice.id == notice_id,
            OwnerNotice.tenant_id == require_tenant_id(),
            Agent.owner_id == user.id,
        )
        .with_for_update(of=Agent)
    )
    if agent_id is None:
        raise HTTPException(status_code=404, detail="Notice not found")
    deleted = await session.scalar(
        delete(OwnerNotice)
        .where(
            OwnerNotice.id == notice_id, OwnerNotice.tenant_id == require_tenant_id()
        )
        .returning(OwnerNotice.id)
    )
    if deleted is None:
        raise HTTPException(status_code=404, detail="Notice not found")
    await session.commit()
    return Response(status_code=204)
