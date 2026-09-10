from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session_factory
from switch_core.sessions.contract import (
    Command,
    CommandBody,
    CommandStatus,
    Origin,
    ServerEvent,
    Session,
    Snapshot,
)
from switch_core.sessions.service import SessionAuthority

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
