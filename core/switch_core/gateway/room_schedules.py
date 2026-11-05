"""A room's scheduled messages: list, create, edit, pause, resume, delete.

Anyone who may read the room sees its schedules; only those who may write it
(its owner, a workspace admin, or anyone when the room is open for writing)
change them. A schedule fires with the authority of whoever last set its text
or agents (`room_schedules.py`), so an edit by someone else makes it theirs.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import (
    get_current_user,
    get_tenant_is_admin,
    require_room_access,
)
from switch_core.gateway.dependencies import get_room_store, get_session
from switch_core.gateway.schemas import (
    RoomScheduleCreateRequest,
    RoomScheduleDetail,
    RoomScheduleUpdateRequest,
)
from switch_core.room_schedules import (
    RoomSchedules,
    ScheduleAuthor,
    ScheduleEdit,
    ScheduleNotFound,
    ScheduleRefused,
    ScheduleView,
)

router = APIRouter()


def get_room_schedule_store() -> RoomScheduleStore:
    return RoomScheduleStore()


@router.get("/rooms/{room_id}/schedules")
async def list_room_schedules(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[RoomScheduleDetail]:
    await require_room_access(session, room_store, room_id, user, "read", is_admin)
    views = await RoomSchedules(schedule_store, room_store).in_room(session, room_id)
    return [_detail(view) for view in views]


@router.post("/rooms/{room_id}/schedules", status_code=201)
async def create_room_schedule(
    room_id: str,
    req: RoomScheduleCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleDetail:
    await require_room_access(session, room_store, room_id, user, "write", is_admin)
    schedules = RoomSchedules(schedule_store, room_store)
    try:
        schedule = await schedules.create(
            session,
            room_id=room_id,
            author=ScheduleAuthor(user.id, None),
            agent_ids=req.agent_ids,
            body=req.body,
            run_at=req.run_at,
            cron=req.cron,
            timezone=req.timezone,
            now=datetime.now(UTC),
        )
    except ScheduleRefused as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await session.commit()
    [view] = await schedules.views(session, [schedule])
    return _detail(view)


@router.patch("/rooms/{room_id}/schedules/{schedule_id}")
async def update_room_schedule(
    room_id: str,
    schedule_id: str,
    req: RoomScheduleUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleDetail:
    await require_room_access(session, room_store, room_id, user, "write", is_admin)
    schedules = RoomSchedules(schedule_store, room_store)
    sent = req.model_fields_set
    try:
        schedule = await schedules.edit(
            session,
            room_id=room_id,
            schedule_id=schedule_id,
            author=ScheduleAuthor(user.id, None),
            edit=ScheduleEdit(
                agent_ids=req.agent_ids,
                body=req.body,
                timing=(
                    (req.run_at, req.cron)
                    if "run_at" in sent or "cron" in sent
                    else None
                ),
                timezone=req.timezone,
                paused=req.paused,
            ),
            now=datetime.now(UTC),
        )
    except ScheduleNotFound as e:
        raise HTTPException(status_code=404, detail="Schedule not found") from e
    except ScheduleRefused as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await session.commit()
    [view] = await schedules.views(session, [schedule])
    return _detail(view)


@router.delete("/rooms/{room_id}/schedules/{schedule_id}", status_code=204)
async def delete_room_schedule(
    room_id: str,
    schedule_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    schedule_store: Annotated[RoomScheduleStore, Depends(get_room_schedule_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> Response:
    await require_room_access(session, room_store, room_id, user, "write", is_admin)
    try:
        await RoomSchedules(schedule_store, room_store).delete(
            session, room_id, schedule_id
        )
    except ScheduleNotFound as e:
        raise HTTPException(status_code=404, detail="Schedule not found") from e
    await session.commit()
    return Response(status_code=204)


def _detail(view: ScheduleView) -> RoomScheduleDetail:
    s = view.schedule
    return RoomScheduleDetail(
        id=s.id,
        room_id=s.room_id,
        agent_ids=[agent_id for agent_id, _ in view.agents],
        body=s.body,
        run_at=s.run_at,
        cron=s.cron,
        timezone=s.timezone,
        paused=s.paused,
        next_run_at=s.next_run_at,
        last_run_at=s.last_run_at,
        last_error=s.last_error,
        author_id=s.author_id,
        author_agent_id=s.author_agent_id,
        author_name=view.author_name,
    )
