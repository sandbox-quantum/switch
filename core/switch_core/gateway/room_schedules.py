"""Authenticated Console routes for the shared schedule service."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import (
    get_current_user,
    get_tenant_is_admin,
    require_room_access,
)
from switch_core.gateway.dependencies import get_room_store, get_session
from switch_core.scheduling import service
from switch_core.scheduling.service import ScheduleDetail, ScheduleInput, SchedulePause

router = APIRouter()
Session = Annotated[AsyncSession, Depends(get_session)]
Rooms = Annotated[RoomStore, Depends(get_room_store)]
Person = Annotated[User, Depends(get_current_user)]
Admin = Annotated[bool, Depends(get_tenant_is_admin)]


@contextmanager
def schedule_errors() -> Iterator[None]:
    try:
        yield
    except service.ScheduleError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc


@router.get("/rooms/{room_id}/schedules")
async def list_schedules(
    room_id: str, session: Session, rooms: Rooms, user: Person, is_admin: Admin
) -> list[ScheduleDetail]:
    with schedule_errors():
        await require_room_access(session, rooms, room_id, user, "read", is_admin)
        return await service.list_schedules(room_id, session, rooms, user, is_admin)


@router.post("/rooms/{room_id}/schedules", status_code=201)
async def create_schedule(
    room_id: str,
    data: ScheduleInput,
    session: Session,
    rooms: Rooms,
    user: Person,
    is_admin: Admin,
) -> ScheduleDetail:
    with schedule_errors():
        return await service.create_schedule(
            room_id, data, session, rooms, user, is_admin
        )


@router.put("/rooms/{room_id}/schedules/{schedule_id}")
async def edit_schedule(
    room_id: str,
    schedule_id: str,
    data: ScheduleInput,
    session: Session,
    rooms: Rooms,
    user: Person,
    is_admin: Admin,
) -> ScheduleDetail:
    with schedule_errors():
        return await service.edit_schedule(
            room_id, schedule_id, data, session, rooms, user, is_admin
        )


@router.patch("/rooms/{room_id}/schedules/{schedule_id}")
async def pause_schedule(
    room_id: str,
    schedule_id: str,
    data: SchedulePause,
    session: Session,
    rooms: Rooms,
    user: Person,
    is_admin: Admin,
) -> ScheduleDetail:
    with schedule_errors():
        return await service.pause_schedule(
            room_id, schedule_id, data, session, rooms, user, is_admin
        )


@router.delete("/rooms/{room_id}/schedules/{schedule_id}", status_code=204)
async def delete_schedule(
    room_id: str,
    schedule_id: str,
    session: Session,
    rooms: Rooms,
    user: Person,
    is_admin: Admin,
) -> Response:
    with schedule_errors():
        await service.delete_schedule(
            room_id, schedule_id, session, rooms, user, is_admin
        )
        return Response(status_code=204)
