"""A room's schedules: the messages Switch posts to its agents on a timer.

Seeing them takes the right to read the room. Changing them takes the right
to change its settings (its owner, a room admin or a workspace admin), the
gate `can_write` reports for the room, as the agent tools ask it: anyone in
the room could otherwise pause or delete everyone's schedules. Whoever last
sets what a schedule says, or to whom, becomes its author: it is posted on
their behalf, so nobody can make a schedule speak for someone else.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import RoomSchedule, User
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import (
    get_current_user,
    get_tenant_is_admin,
    require_room_access,
)
from switch_core.gateway.dependencies import get_room_store, get_session
from switch_core.room_schedules import (
    TEXT_LIMIT,
    ScheduleError,
    addressed_first_run,
    first_run,
)

router = APIRouter()

STORE = RoomScheduleStore()


class RoomScheduleWrite(BaseModel):
    """What a schedule says, to whom, and when: a cron rule or a one-off time."""

    agent_ids: list[str] = Field(min_length=1)
    text: str = Field(min_length=1, max_length=TEXT_LIMIT)
    cron: str | None
    run_at: datetime | None
    timezone: str


class RoomSchedulePause(BaseModel):
    paused: bool


class RoomScheduleDetail(BaseModel):
    id: str
    room_id: str
    author_id: str
    # The agent that set it up through its Switch tools; None for a person.
    author_agent_id: str | None
    agent_ids: list[str]
    text: str
    cron: str | None
    run_at: datetime | None
    timezone: str
    paused: bool
    # None once a one-off has been sent.
    next_run_at: datetime | None
    last_run_at: datetime | None


def _detail(schedule: RoomSchedule) -> RoomScheduleDetail:
    return RoomScheduleDetail(
        id=schedule.id,
        room_id=schedule.room_id,
        author_id=schedule.author_id,
        author_agent_id=schedule.author_agent_id,
        agent_ids=list(schedule.agent_ids),
        text=schedule.text,
        cron=schedule.cron,
        run_at=schedule.run_at,
        timezone=schedule.timezone,
        paused=schedule.paused,
        next_run_at=schedule.next_run_at,
        last_run_at=schedule.last_run_at,
    )


async def _checked_first_run(
    session: AsyncSession, room_store: RoomStore, room_id: str, body: RoomScheduleWrite
) -> datetime:
    """When `body` first fires, once its agents are known to be in the room."""
    try:
        return await addressed_first_run(
            session,
            room_store,
            room_id,
            agent_ids=body.agent_ids,
            cron=body.cron,
            run_at=body.run_at,
            timezone=body.timezone,
            now=datetime.now(UTC),
        )
    except ScheduleError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


async def _schedule_in(
    session: AsyncSession, room_id: str, schedule_id: str
) -> RoomSchedule:
    schedule = await STORE.get(session, schedule_id)
    if schedule is None or schedule.room_id != room_id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return schedule


@router.get("/rooms/{room_id}/schedules")
async def list_room_schedules(
    room_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> list[RoomScheduleDetail]:
    await require_room_access(session, room_store, room_id, user, "read", is_admin)
    return [_detail(schedule) for schedule in await STORE.for_room(session, room_id)]


@router.post("/rooms/{room_id}/schedules", status_code=201)
async def create_room_schedule(
    room_id: str,
    body: RoomScheduleWrite,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleDetail:
    await require_room_access(session, room_store, room_id, user, "configure", is_admin)
    next_run_at = await _checked_first_run(session, room_store, room_id, body)
    schedule = await STORE.create(
        session,
        RoomSchedule(
            room_id=room_id,
            author_id=user.id,
            agent_ids=body.agent_ids,
            text=body.text,
            cron=body.cron,
            run_at=body.run_at,
            timezone=body.timezone,
            paused=False,
            next_run_at=next_run_at,
        ),
    )
    detail = _detail(schedule)
    await session.commit()
    return detail


@router.put("/rooms/{room_id}/schedules/{schedule_id}")
async def update_room_schedule(
    room_id: str,
    schedule_id: str,
    body: RoomScheduleWrite,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleDetail:
    await require_room_access(session, room_store, room_id, user, "configure", is_admin)
    schedule = await _schedule_in(session, room_id, schedule_id)
    schedule.next_run_at = await _checked_first_run(session, room_store, room_id, body)
    schedule.author_id = user.id
    schedule.author_agent_id = None
    schedule.agent_ids = body.agent_ids
    schedule.text = body.text
    schedule.cron = body.cron
    schedule.run_at = body.run_at
    schedule.timezone = body.timezone
    await session.flush()
    detail = _detail(schedule)
    await session.commit()
    return detail


@router.put("/rooms/{room_id}/schedules/{schedule_id}/paused")
async def pause_room_schedule(
    room_id: str,
    schedule_id: str,
    body: RoomSchedulePause,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> RoomScheduleDetail:
    """Pause a schedule, or resume it from now: runs missed while paused are not sent."""
    await require_room_access(session, room_store, room_id, user, "configure", is_admin)
    schedule = await _schedule_in(session, room_id, schedule_id)
    if not body.paused and schedule.paused:
        try:
            schedule.next_run_at = first_run(
                cron=schedule.cron,
                run_at=schedule.run_at,
                timezone=schedule.timezone,
                now=datetime.now(UTC),
            )
        except ScheduleError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
    schedule.paused = body.paused
    await session.flush()
    detail = _detail(schedule)
    await session.commit()
    return detail


@router.delete("/rooms/{room_id}/schedules/{schedule_id}", status_code=204)
async def delete_room_schedule(
    room_id: str,
    schedule_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> Response:
    await require_room_access(session, room_store, room_id, user, "configure", is_admin)
    await STORE.delete(session, await _schedule_in(session, room_id, schedule_id))
    await session.commit()
    return Response(status_code=204)
