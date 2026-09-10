import hashlib
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import (
    get_event_buffer,
    get_session_factory,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import Agent
from switch_core.sessions.contract import (
    Command,
    CommandStatus,
    HostEvent,
    Session,
    Snapshot,
)
from switch_core.sessions.service import SessionAuthority

router = APIRouter(prefix="/sessions")
Factory = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
AuthenticatedAgent = Annotated[Agent, Depends(get_agent_from_scope)]


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
    host_id: str,
) -> dict[str, int]:
    through = await SessionAuthority(factory).ingest(agent.id, host_id, body)
    return {"throughHostSequence": through}


@router.post("/{session_id}/commands")
async def pending(
    session_id: str, body: HostLease, agent: AuthenticatedAgent, factory: Factory
) -> list[Command]:
    return await SessionAuthority(factory).pending(
        agent.id, session_id, body.host_id, body.epoch
    )


class Acquisition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session: Session
    operation_id: str = Field(min_length=1, max_length=128)


class Recovery(HostLease):
    operation_id: str = Field(min_length=1, max_length=128)
    through_host_sequence: int = Field(ge=0)


@router.post("/claim")
async def claim(
    body: Acquisition, agent: AuthenticatedAgent, factory: Factory
) -> Snapshot:
    return await SessionAuthority(factory).acquire(
        agent.id, body.session, body.operation_id
    )


@router.post("/{session_id}/quiesce")
async def quiesce(
    session_id: str, body: HostLease, agent: AuthenticatedAgent, factory: Factory
) -> dict[str, bool]:
    await SessionAuthority(factory).quiesce(
        agent.id, session_id, body.host_id, body.epoch
    )
    return {"quiesced": True}


@router.post("/reconcile")
async def reconcile(
    body: HostEvent,
    agent: AuthenticatedAgent,
    factory: Factory,
    host_id: str,
) -> dict[str, int]:
    through = await SessionAuthority(factory).ingest(
        agent.id, host_id, body, reconcile=True
    )
    return {"throughHostSequence": through}


@router.post("/{session_id}/recover")
async def recover(
    session_id: str,
    body: Recovery,
    agent: AuthenticatedAgent,
    factory: Factory,
) -> Snapshot:
    snapshot = await SessionAuthority(factory).recover(
        agent.id,
        session_id,
        body.host_id,
        body.epoch,
        body.operation_id,
        body.through_host_sequence,
    )
    return snapshot


class RoomMessage(HostLease):
    room_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    sequence: int = Field(ge=1)


@router.post("/{session_id}/room-message")
async def room_message(
    session_id: str,
    body: RoomMessage,
    agent: AuthenticatedAgent,
    factory: Factory,
    buffer: Annotated[EventBuffer, Depends(get_event_buffer)],
) -> CommandStatus:
    return await SessionAuthority(factory).submit_room_message(
        agent.id,
        session_id,
        body.host_id,
        body.epoch,
        body.room_id,
        body.message_id,
        body.sequence,
        buffer,
    )


@router.get("/{session_id}/attachments/{attachment_id}")
async def download_attachment(
    session_id: str,
    attachment_id: str,
    host_id: str,
    epoch: str,
    agent: AuthenticatedAgent,
    factory: Factory,
) -> Response:
    blob = await SessionAuthority(factory).attachment(
        agent.id, session_id, host_id, epoch, attachment_id
    )
    return Response(
        blob.data,
        media_type=blob.content_type,
        headers={
            "X-Content-SHA256": hashlib.sha256(blob.data).hexdigest(),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
