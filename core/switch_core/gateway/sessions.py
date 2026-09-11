import base64
import binascii
import json
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session_factory
from switch_core.sessions.attachments import MAX_ATTACHMENT_BYTES
from switch_core.sessions.contract import (
    Attachment,
    Command,
    CommandBody,
    CommandStatus,
    Origin,
    ServerEvent,
    Session,
    Snapshot,
)
from switch_core.sessions.service import SessionAuthority, SessionError

router = APIRouter()
Factory = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
CurrentUser = Annotated[User, Depends(get_current_user)]


class SubmitCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    command_id: str = Field(alias="commandId", min_length=1)
    epoch: str = Field(min_length=1)
    surface: Literal["console", "switch-web"]
    room_id: str | None = Field(alias="roomId")
    body: CommandBody


class RetireSession(BaseModel):
    model_config = ConfigDict(extra="forbid")
    epoch: str = Field(min_length=1)


@router.post("/{session_id}/retire")
async def retire(
    session_id: str, body: RetireSession, user: CurrentUser, factory: Factory
) -> Snapshot:
    return await SessionAuthority(factory).retire(session_id, user.id, body.epoch)


@router.get("")
async def list_sessions(user: CurrentUser, factory: Factory) -> list[Session]:
    return await SessionAuthority(factory).list_sessions(user.id)


@router.get("/{session_id}/commands/{command_id}")
async def command_status(
    session_id: str, command_id: str, user: CurrentUser, factory: Factory
) -> CommandStatus:
    return await SessionAuthority(factory).command_status(
        session_id, command_id, user.id
    )


@router.get("/{session_id}")
async def snapshot(session_id: str, user: CurrentUser, factory: Factory) -> Snapshot:
    return await SessionAuthority(factory).snapshot(session_id, user.id)


@router.get("/{session_id}/events")
async def events(
    session_id: str,
    user: CurrentUser,
    factory: Factory,
    after: Annotated[int, Query(ge=0)] = 0,
) -> list[ServerEvent]:
    return await SessionAuthority(factory).events(session_id, user.id, after)


@router.post("/{session_id}/commands")
async def submit(
    session_id: str,
    body: SubmitCommand,
    user: CurrentUser,
    factory: Factory,
) -> CommandStatus:
    command = Command(
        contract_version=1,
        command_id=body.command_id,
        session_id=session_id,
        epoch=body.epoch,
        origin=Origin(
            surface=body.surface,
            actor_id=user.id,
            room_id=body.room_id,
            thread_id=None,
            message_id=None,
        ),
        body=body.body,
    )
    status = await SessionAuthority(factory).submit(
        command, user_id=user.id, bridge_id=None
    )
    return status


class UploadAttachment(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    name: str
    mime_type: str = Field(alias="mimeType")
    data: str


@router.put("/{session_id}/attachments/{attachment_id}")
async def upload_attachment(
    session_id: str,
    attachment_id: str,
    request: Request,
    user: CurrentUser,
    factory: Factory,
) -> Attachment:
    authority = SessionAuthority(factory)
    await authority.snapshot(session_id, user.id)
    chunks = bytearray()
    async for chunk in request.stream():
        chunks.extend(chunk)
        if len(chunks) > MAX_ATTACHMENT_BYTES * 4 // 3 + 4096:
            raise SessionError("PAYLOAD_TOO_LARGE", "Attachment exceeds 10 MiB.")
    try:
        payload = UploadAttachment.model_validate(json.loads(chunks))
        data = base64.b64decode(payload.data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise SessionError("INVALID_ATTACHMENT", "Invalid attachment upload.") from exc
    return await authority.upload_attachment(
        session_id, user.id, attachment_id, payload.name, payload.mime_type, data
    )
