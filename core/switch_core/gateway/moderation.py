"""Incident control in a workspace: take an agent or a person out of every
room, for a workspace admin or the server's operator (`room_moderation.py`).

Freezing a room is under `/rooms/{id}/freeze` (`gateway/rooms.py`).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User, require_tenant_id
from switch_core.gateway.auth import require_tenant_admin
from switch_core.gateway.dependencies import get_room_service, get_session_factory
from switch_core.room_moderation import (
    AccountRemoval,
    ModerationTargetNotFound,
    RemovedFromRooms,
    RoomRef,
)
from switch_core.room_service import RoomService

router = APIRouter()


class RemoveFromAllRoomsRequest(BaseModel):
    # Which request this answers (an incident or ticket reference), kept in
    # the audit log.
    request: str | None = None


class RemovePersonFromAllRoomsRequest(RemoveFromAllRoomsRequest):
    # Take every agent the person owns out of every room too.
    include_agents: bool


class RemovedRoom(BaseModel):
    id: str
    name: str


class RemovedFromAllRooms(BaseModel):
    target_type: str
    target_id: str
    # The rooms the agent, or the person's own Switch Console membership,
    # left.
    rooms: list[RemovedRoom]
    # For a person with `include_agents`: each of their agents, by id, and
    # the rooms it left.
    agents: dict[str, list[RemovedRoom]]


def get_account_removal(
    request: Request,
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    room_service: Annotated[RoomService, Depends(get_room_service)],
) -> AccountRemoval:
    chat_service = request.app.state.chat_service
    return AccountRemoval(
        session_factory=session_factory,
        provisioning=room_service.provisioning,
        room_store=room_service.room_store,
        listeners=room_service,
        memberships_changed=chat_service.memberships_changed,
    )


def _response(result: RemovedFromRooms) -> RemovedFromAllRooms:
    def rooms(refs: list[RoomRef]) -> list[RemovedRoom]:
        return [RemovedRoom(id=ref.id, name=ref.name) for ref in refs]

    return RemovedFromAllRooms(
        target_type=result.target_type,
        target_id=result.target_id,
        rooms=rooms(result.rooms),
        agents={agent_id: rooms(refs) for agent_id, refs in result.agents.items()},
    )


@router.post("/moderation/agents/{agent_id}/remove-from-all-rooms")
async def remove_agent_from_all_rooms(
    agent_id: str,
    req: RemoveFromAllRoomsRequest,
    user: Annotated[User, Depends(require_tenant_admin)],
    removal: Annotated[AccountRemoval, Depends(get_account_removal)],
) -> RemovedFromAllRooms:
    """Take an agent of this workspace out of every room it is in. A
    workspace admin or the server's operator only; recorded in the audit log
    as `member.removed_from_all_rooms`."""
    try:
        result = await removal.remove_agent(
            require_tenant_id(),
            agent_id,
            actor_user_id=user.id,
            removed_by=user.name,
            request=req.request,
        )
    except ModerationTargetNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return _response(result)


@router.post("/moderation/people/{user_id}/remove-from-all-rooms")
async def remove_person_from_all_rooms(
    user_id: str,
    req: RemovePersonFromAllRoomsRequest,
    user: Annotated[User, Depends(require_tenant_admin)],
    removal: Annotated[AccountRemoval, Depends(get_account_removal)],
) -> RemovedFromAllRooms:
    """Take a person out of every room of this workspace they are in through
    Switch Console, and with `include_agents` every agent they own too. Their
    accounts on messaging platforms follow the platform's channels and are
    left alone. A workspace admin or the server's operator only; recorded in
    the audit log as `member.removed_from_all_rooms`."""
    try:
        result = await removal.remove_person(
            require_tenant_id(),
            user_id,
            include_agents=req.include_agents,
            actor_user_id=user.id,
            removed_by=user.name,
            request=req.request,
        )
    except ModerationTargetNotFound as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return _response(result)
