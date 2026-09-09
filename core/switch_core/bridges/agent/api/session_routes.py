from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import (
    get_collab_lifecycle,
    get_session_factory,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.session.contract import (
    Command,
    HostEvent,
    Session,
    Snapshot,
)
from switch_core.db.models import Agent
from switch_core.sessions.service import SessionAuthority

router = APIRouter(prefix="/sessions")
Factory = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
AuthenticatedAgent = Annotated[Agent, Depends(get_agent_from_scope)]
Lifecycle = Annotated[
    CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
]


class HostLease(BaseModel):
    model_config = ConfigDict(extra="forbid")
    host_id: str
    epoch: str


@router.post("/acquire")
async def acquire(
    body: Session, agent: AuthenticatedAgent, factory: Factory
) -> Snapshot:
    return await SessionAuthority(factory).acquire(agent.id, body)


@router.post("/{session_id}/renew")
async def renew(
    session_id: str, body: HostLease, agent: AuthenticatedAgent, factory: Factory
) -> dict[str, int]:
    await SessionAuthority(factory).renew(
        agent.id, session_id, body.host_id, body.epoch
    )
    return {"leaseSeconds": 30}


@router.post("/events")
async def ingest(
    body: HostEvent,
    agent: AuthenticatedAgent,
    factory: Factory,
    lifecycle: Lifecycle,
    host_id: str,
) -> dict[str, int]:
    through = await SessionAuthority(factory).ingest(agent.id, host_id, body)
    await lifecycle.refresh_sdk_session(body.session_id)
    return {"throughHostSequence": through}


@router.post("/{session_id}/commands")
async def pending(
    session_id: str, body: HostLease, agent: AuthenticatedAgent, factory: Factory
) -> list[Command]:
    return await SessionAuthority(factory).pending(
        agent.id, session_id, body.host_id, body.epoch
    )
