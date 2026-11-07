from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Principal, can_manage
from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import (
    authorize_room,
    get_current_user,
    get_tenant_is_admin,
)
from switch_core.gateway.dependencies import (
    get_room_schedules,
    get_room_store,
    get_session,
)
from switch_core.gateway.schemas import (
    RoomScheduleCreateRequest,
    RoomScheduleDetail,
    RoomScheduleUpdateRequest,
)
from switch_core.room_schedules import RoomScheduleService, schedule_to_dict

router = APIRouter()


async def _manageable_room(
    session: AsyncSession,
    room_store: RoomStore,
    room_id: str,
    user: User,
    is_admin: bool,
) -> Room:
    """The room, if `user` may change its schedules: they own it or administer
    the workspace. Not write access: a publicly writable room (the default)
    would hand every member a recurring message sent in Switch's name."""
    principal = Principal(user.id, is_admin)
    room = await authorize_room(session, room_store, room_id, principal, "read")
    if not can_manage(principal, room.owner_id):
        raise HTTPException(
            status_code=403,
            detail="Only the room's owner or a workspace admin can change its schedules",
        )
    return room


@router.get("/rooms/{room_id}/schedules")
async def list_room_schedules(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    schedules: Annotated[RoomScheduleService, Depends(get_room_schedules)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[RoomScheduleDetail]:
    await authorize_room(
        session, room_store, room_id, Principal(user.id, is_admin), "read"
    )
    return [
        RoomScheduleDetail(**schedule_to_dict(schedule))
        for schedule in await schedules.list_for_room(session, room_id)
    ]


@router.post("/rooms/{room_id}/schedules", status_code=201)
async def create_room_schedule(
    room_id: str,
    req: RoomScheduleCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    schedules: Annotated[RoomScheduleService, Depends(get_room_schedules)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleDetail:
    room = await _manageable_room(session, room_store, room_id, user, is_admin)
    try:
        schedule = await schedules.create(
            session,
            room,
            agent_ids=req.agent_ids,
            message=req.message,
            schedule_type=req.schedule_type,
            cron_expression=req.cron_expression,
            run_at=req.run_at,
            timezone=req.timezone,
            acting_user_id=user.id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    view = RoomScheduleDetail(**schedule_to_dict(schedule))
    await session.commit()
    return view


@router.patch("/rooms/{room_id}/schedules/{schedule_id}")
async def update_room_schedule(
    room_id: str,
    schedule_id: str,
    req: RoomScheduleUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    schedules: Annotated[RoomScheduleService, Depends(get_room_schedules)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleDetail:
    room = await _manageable_room(session, room_store, room_id, user, is_admin)
    try:
        schedule = await schedules.update(
            session,
            room,
            schedule_id,
            agent_ids=req.agent_ids,
            message=req.message,
            schedule_type=req.schedule_type,
            cron_expression=req.cron_expression,
            run_at=req.run_at,
            timezone=req.timezone,
            enabled=req.enabled,
            acting_user_id=user.id,
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    view = RoomScheduleDetail(**schedule_to_dict(schedule))
    await session.commit()
    return view


@router.delete("/rooms/{room_id}/schedules/{schedule_id}", status_code=204)
async def delete_room_schedule(
    room_id: str,
    schedule_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    schedules: Annotated[RoomScheduleService, Depends(get_room_schedules)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> Response:
    room = await _manageable_room(session, room_store, room_id, user, is_admin)
    try:
        await schedules.delete(session, room, schedule_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    await session.commit()
    return Response(status_code=204)
