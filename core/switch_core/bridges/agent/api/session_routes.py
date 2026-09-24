import hashlib
import json
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import (
    get_collab_lifecycle,
    get_event_buffer,
    get_protocol,
    get_session_factory,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.db.models import Agent, Client, Message, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.sessions.contract import (
    MAX_EVENT_BYTES,
    Command,
    CommandStatus,
    HostEvent,
    Session,
    Snapshot,
)
from switch_core.sessions.service import SessionAuthority, SessionError

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


async def read_host_event(request: Request) -> HostEvent:
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_EVENT_BYTES:
            raise SessionError(
                "PAYLOAD_TOO_LARGE", "Host events must not exceed 64 KiB."
            )
        data.extend(chunk)
    try:
        return HostEvent.model_validate_json(data)
    except ValueError as exc:
        raise SessionError("INVALID_EVENT", "Invalid host event.") from exc


@router.post("/events")
async def ingest(
    body: Annotated[HostEvent, Depends(read_host_event)],
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
    body: Annotated[HostEvent, Depends(read_host_event)],
    agent: AuthenticatedAgent,
    factory: Factory,
    lifecycle: Lifecycle,
    host_id: str,
) -> dict[str, int]:
    through = await SessionAuthority(factory).ingest(
        agent.id, host_id, body, reconcile=True
    )
    await lifecycle.refresh_sdk_session(body.session_id)
    return {"throughHostSequence": through}


@router.post("/{session_id}/recover")
async def recover(
    session_id: str,
    body: Recovery,
    agent: AuthenticatedAgent,
    factory: Factory,
    lifecycle: Lifecycle,
) -> Snapshot:
    snapshot = await SessionAuthority(factory).recover(
        agent.id,
        session_id,
        body.host_id,
        body.epoch,
        body.operation_id,
        body.through_host_sequence,
    )
    await lifecycle.refresh_sdk_session(session_id)
    return snapshot


class RoomMessage(HostLease):
    room_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    sequence: int = Field(ge=1)
    missed_count: int = Field(default=0, ge=0)
    gap_reason: str | None = None


@router.post("/{session_id}/room-message")
async def room_message(
    session_id: str,
    body: RoomMessage,
    agent: AuthenticatedAgent,
    factory: Factory,
    buffer: Annotated[EventBuffer, Depends(get_event_buffer)],
    lifecycle: Lifecycle,
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> CommandStatus:
    status = await SessionAuthority(factory).submit_room_message(
        agent.id,
        session_id,
        body.host_id,
        body.epoch,
        body.room_id,
        body.message_id,
        body.sequence,
        body.missed_count,
        body.gap_reason,
        buffer,
        protocol.connections.live_agent_ids,
    )

    await lifecycle.refresh_sdk_session(session_id)
    return status


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
            "X-Content-SHA256": blob.sha256 or hashlib.sha256(blob.data).hexdigest(),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


class RoomConnection(HostLease):
    connection_id: str = Field(min_length=1)


@router.post("/{session_id}/room-connection")
async def bind_room_connection(
    session_id: str,
    body: RoomConnection,
    agent: AuthenticatedAgent,
    factory: Factory,
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, list[str]]:
    rooms = await SessionAuthority(factory).bind_connection(
        agent.id,
        session_id,
        body.host_id,
        body.epoch,
        body.connection_id,
        protocol.connections,
    )
    return {"rooms": rooms}


class RoomFailure(RoomConnection):
    room_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    reason: Literal["startup", "delivery", "conversation"]


@router.post("/{session_id}/room-failure")
async def room_failure(
    session_id: str,
    body: RoomFailure,
    agent: AuthenticatedAgent,
    factory: Factory,
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, str]:
    thread_id = await SessionAuthority(factory).failure_notice_thread(
        agent.id,
        session_id,
        body.host_id,
        body.epoch,
        body.connection_id,
        body.room_id,
        body.message_id,
        protocol.connections,
    )
    messages = {
        "startup": "I could not start the provider, so I could not process your request. Open this session in Switch Console to check the error and restart it.",
        "delivery": "I could not verify your earlier message after reconnecting, so I did not process it. Please send the message and any attachments again.",
        "conversation": f"This saved conversation cannot continue. Send !reset @{agent.name} here, or choose Start a fresh conversation in Switch Console. Your pending messages will be delivered after you make that choice.",
    }
    key = json.dumps([agent.id, body.room_id, body.message_id, body.reason])
    async with tenant_session(factory, require_tenant_id()) as db, db.begin():
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"room-failure:{require_tenant_id()}:{key}"},
        )
        sender = (
            select(Client.matrix_user_id)
            .join(Agent, Agent.client_id == Client.id)
            .where(Agent.id == agent.id)
            .scalar_subquery()
        )
        previous = await db.scalar(
            select(Message.id)
            .where(
                Message.room_id == body.room_id,
                Message.sender_id == sender,
                Message.content["switch_room_failure"].astext == key,
            )
            .limit(1)
        )
        if previous is None:
            await protocol.send_message(
                agent.id,
                body.room_id,
                messages[body.reason],
                thread_id=thread_id,
                extra_content={"switch_room_failure": key},
            )
    return {"room_id": body.room_id, "message_id": body.message_id}
