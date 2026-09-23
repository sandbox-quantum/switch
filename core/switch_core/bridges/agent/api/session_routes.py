import hashlib
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
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
from switch_core.db.models import Agent
from switch_core.sessions.contract import (
    MAX_EVENT_BYTES,
    Command,
    CommandStatus,
    HostEvent,
    Session,
    Snapshot,
)
from switch_core.sessions.service import RoomGrant, SessionAuthority, SessionError

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


class RestoreLegacyRoom(HostLease):
    room_id: str = Field(min_length=1)


@router.post("/{session_id}/restore-legacy-room")
async def restore_legacy_room(
    session_id: str,
    body: RestoreLegacyRoom,
    agent: AuthenticatedAgent,
    factory: Factory,
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict[str, bool]:
    return {
        "restored": await SessionAuthority(factory).restore_legacy_room(
            agent.id,
            session_id,
            body.host_id,
            body.epoch,
            body.room_id,
            protocol.connections,
        )
    }


@router.post("/{session_id}/renew")
async def renew(
    session_id: str,
    body: HostLease,
    agent: AuthenticatedAgent,
    factory: Factory,
    room_work: bool = False,
) -> dict[str, int | bool]:
    # Opted into in the query string: the body is strict, so a field there
    # would be refused by a server built before it, while an unknown query
    # parameter is ignored. A worker that does not ask pays nothing for it.
    authority = SessionAuthority(factory)
    if not room_work:
        await authority.renew(agent.id, session_id, body.host_id, body.epoch)
        return {"leaseSeconds": 30}
    owed = await authority.renew_reporting_room_work(
        agent.id, session_id, body.host_id, body.epoch
    )
    return {"leaseSeconds": 30, "roomWork": owed}


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


class Grant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    room_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)


class Acquisition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session: Session
    operation_id: str = Field(min_length=1, max_length=128)
    # Absent for a session nobody addressed a room message to — one a person
    # started, or one an older controller is claiming with no admission behind
    # it. Present, it is the delivery the session is being started for, and
    # the session is created already holding that room.
    grant: Grant | None = None


class Recovery(HostLease):
    operation_id: str = Field(min_length=1, max_length=128)
    through_host_sequence: int = Field(ge=0)


@router.post("/claim")
async def claim(
    body: Acquisition, agent: AuthenticatedAgent, factory: Factory
) -> Snapshot:
    return await SessionAuthority(factory).acquire(
        agent.id,
        body.session,
        body.operation_id,
        RoomGrant(body.grant.room_id, body.grant.message_id) if body.grant else None,
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
    # Accepted and ignored. A host counted this for itself before the server
    # could, and the body is strict on both ends: rejecting the field would
    # break every such host on its first room message, for a number the server
    # now works out per room from events it already holds.
    missed_count: int = Field(default=0, ge=0)
    gap_reason: str | None = None


# Declared without a response model: the receipt for a host that asked to be
# handed the command carries a field the plain status does not, and a response
# model would filter it back out. A host that did not ask is answered with the
# status shape it already parses strictly.
@router.post("/{session_id}/room-message", response_model=None)
async def room_message(
    session_id: str,
    body: RoomMessage,
    agent: AuthenticatedAgent,
    factory: Factory,
    buffer: Annotated[EventBuffer, Depends(get_event_buffer)],
    lifecycle: Lifecycle,
    # Asked for in the query string rather than the body, because the body is
    # strict on both ends: a server built before this existed answers an
    # unknown field with 422 and the host dies on its first room message, while
    # an unknown query parameter it simply ignores. The default is what makes
    # the skew work in the other direction too — an older host asks for
    # nothing and is answered with the shape it already parses.
    include_command: bool = False,
) -> CommandStatus:
    status = await SessionAuthority(factory).submit_room_message(
        agent.id,
        session_id,
        body.host_id,
        body.epoch,
        body.room_id,
        body.message_id,
        body.sequence,
        include_command,
        buffer,
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


class RoomDelivery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    room_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)


class RoomAdmissionRequest(RoomDelivery):
    sequence: int = Field(ge=1)
    # Whether the controller asking may start a session. It decides whether the
    # server issues the right to start one, and it belongs to the delivery
    # rather than to the controller: the setting can be turned off while the
    # message waits, and the permission it arrived under is the one it is
    # finally admitted on.
    spawning: bool


class RoomAdmissionResponse(BaseModel):
    status: str
    session_id: str | None
    host_id: str | None
    epoch: str | None
    grant_expires_at: str | None


@router.post("/room-admission")
async def room_admission(
    body: RoomAdmissionRequest,
    agent: AuthenticatedAgent,
    factory: Factory,
    buffer: Annotated[EventBuffer, Depends(get_event_buffer)],
) -> RoomAdmissionResponse:
    admission = await SessionAuthority(factory).admit_room(
        agent.id,
        body.room_id,
        body.message_id,
        body.sequence,
        body.spawning,
        buffer,
    )
    return RoomAdmissionResponse(
        status=admission.status,
        session_id=admission.session_id,
        host_id=admission.host_id,
        epoch=admission.epoch,
        grant_expires_at=(
            admission.grant_expires_at.isoformat()
            if admission.grant_expires_at
            else None
        ),
    )


class ReservedDelivery(BaseModel):
    room_id: str
    message_id: str
    sequence: int
    expired: bool


@router.get("/room-reservations")
async def room_reservations(
    agent: AuthenticatedAgent, factory: Factory
) -> list[ReservedDelivery]:
    return [
        ReservedDelivery(
            room_id=reservation.room_id,
            message_id=reservation.message_id,
            sequence=reservation.sequence,
            expired=reservation.expired,
        )
        for reservation in await SessionAuthority(factory).room_reservations(agent.id)
    ]


@router.post("/{session_id}/room-reservations")
async def session_room_reservations(
    session_id: str, body: HostLease, agent: AuthenticatedAgent, factory: Factory
) -> list[ReservedDelivery]:
    return [
        ReservedDelivery(
            room_id=reservation.room_id,
            message_id=reservation.message_id,
            sequence=reservation.sequence,
            expired=reservation.expired,
        )
        for reservation in await SessionAuthority(factory).session_room_reservations(
            agent.id, session_id, body.host_id, body.epoch
        )
    ]


@router.post("/room-reservations/discard")
async def discard_room_reservation(
    body: RoomDelivery, agent: AuthenticatedAgent, factory: Factory
) -> dict[str, bool]:
    await SessionAuthority(factory).discard_room_reservation(
        agent.id, body.room_id, body.message_id
    )
    return {"discarded": True}


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


class ConnectionCarryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str = Field(min_length=1)


class RefusedRoomResponse(BaseModel):
    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, populate_by_name=True
    )
    room_id: str
    reason: str


class CarriedSessionResponse(BaseModel):
    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, populate_by_name=True
    )
    session_id: str
    adopted: list[str]
    refused: list[RefusedRoomResponse]


class ConnectionCarryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel)
    sessions: list[CarriedSessionResponse]
    unverifiable: list[str]


@router.post("/carry-connection-rooms")
async def carry_connection_rooms(
    body: ConnectionCarryRequest,
    agent: AuthenticatedAgent,
    factory: Factory,
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> ConnectionCarryResponse:
    carry = await SessionAuthority(factory).carry_connection_rooms(
        agent.id, body.connection_id, protocol.connections
    )
    return ConnectionCarryResponse(
        sessions=[
            CarriedSessionResponse(
                session_id=session.session_id,
                adopted=list(session.adopted),
                refused=[
                    RefusedRoomResponse(room_id=room.room_id, reason=room.reason)
                    for room in session.refused
                ],
            )
            for session in carry.sessions
        ],
        unverifiable=list(carry.unverifiable),
    )
