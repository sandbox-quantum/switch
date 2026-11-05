"""Room automation management. Public write access does not grant automation."""

from datetime import UTC, datetime
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import AwareDatetime, BaseModel, Field, field_validator, model_validator
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Principal, require_manage
from switch_core.db.models import (
    Room,
    RoomSchedule,
    RoomScheduleRun,
    RoomScheduleTarget,
    User,
    require_tenant_id,
    room_agents,
)
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import (
    get_current_user,
    get_tenant_is_admin,
    require_room_access,
)
from switch_core.gateway.dependencies import get_room_store, get_session
from switch_core.scheduling.timing import ScheduleTimingError, next_cron_run

router = APIRouter()


class ScheduleInput(BaseModel):
    body: str = Field(min_length=1, max_length=32000)
    agent_ids: list[str] = Field(min_length=1, max_length=25)
    timezone: str = Field(default="UTC", min_length=1, max_length=128)
    cron: str | None = Field(default=None, max_length=128)
    run_at: AwareDatetime | None = None

    @field_validator("body")
    @classmethod
    def nonempty_body(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Enter a message")
        return value.strip()

    @model_validator(mode="after")
    def one_timing(self) -> "ScheduleInput":
        if (self.cron is None) == (self.run_at is None):
            raise ValueError("Choose either a one-off time or a cron rule")
        if len(set(self.agent_ids)) != len(self.agent_ids):
            raise ValueError("Choose each agent only once")
        return self


class SchedulePause(BaseModel):
    paused: bool


class ScheduleDetail(BaseModel):
    id: str
    body: str
    agent_ids: list[str]
    timezone: str
    cron: str | None
    next_run_at: datetime | None
    paused: bool
    last_error: str | None
    last_run_at: datetime | None


Session = Annotated[AsyncSession, Depends(get_session)]
Rooms = Annotated[RoomStore, Depends(get_room_store)]
Person = Annotated[User, Depends(get_current_user)]
Admin = Annotated[bool, Depends(get_tenant_is_admin)]


async def managed_room(
    session: AsyncSession, rooms: RoomStore, room_id: str, user: User, is_admin: bool
) -> Room:
    room = await require_room_access(session, rooms, room_id, user, "read", is_admin)
    try:
        require_manage(Principal(user.id, is_admin), room.owner_id)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    if room.archived_at is not None:
        raise HTTPException(409, "Unarchive this room to manage its schedules")
    return room


async def find_schedule(
    session: AsyncSession, room_id: str, schedule_id: str
) -> RoomSchedule:
    row = await session.scalar(
        select(RoomSchedule)
        .where(
            RoomSchedule.tenant_id == require_tenant_id(),
            RoomSchedule.room_id == room_id,
            RoomSchedule.id == schedule_id,
        )
        .with_for_update()
    )
    if row is None:
        raise HTTPException(404, "Schedule not found")
    return row


async def detail(session: AsyncSession, row: RoomSchedule) -> ScheduleDetail:
    targets = list(
        (
            await session.scalars(
                select(RoomScheduleTarget.agent_id)
                .where(
                    RoomScheduleTarget.schedule_id == row.id,
                    RoomScheduleTarget.tenant_id == require_tenant_id(),
                )
                .order_by(RoomScheduleTarget.agent_id)
            )
        ).all()
    )
    last_run = await session.scalar(
        select(func.max(RoomScheduleRun.scheduled_for)).where(
            RoomScheduleRun.schedule_id == row.id,
            RoomScheduleRun.tenant_id == require_tenant_id(),
        )
    )
    return ScheduleDetail(
        id=row.id,
        body=row.body,
        agent_ids=targets,
        timezone=row.timezone,
        cron=row.cron,
        next_run_at=row.next_run_at,
        paused=row.paused,
        last_error=row.last_error,
        last_run_at=last_run,
    )


async def apply_input(
    session: AsyncSession, row: RoomSchedule, data: ScheduleInput
) -> None:
    members = set(
        (
            await session.scalars(
                select(room_agents.c.agent_id).where(
                    room_agents.c.room_id == row.room_id,
                    room_agents.c.tenant_id == require_tenant_id(),
                )
            )
        ).all()
    )
    if not set(data.agent_ids) <= members:
        raise HTTPException(422, "Choose agents that are currently in this room")
    now = (await session.execute(select(func.clock_timestamp()))).scalar_one()
    try:
        ZoneInfo(data.timezone)
        next_due = (
            next_cron_run(data.cron, data.timezone, now)
            if data.cron is not None
            else data.run_at
        )
    except (ScheduleTimingError, ZoneInfoNotFoundError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
    assert next_due is not None
    if next_due <= now:
        raise HTTPException(422, "Choose a future one-off time")
    row.body, row.timezone, row.cron = data.body, data.timezone, data.cron
    row.next_run_at, row.last_error = next_due.astimezone(UTC), None
    await session.flush()
    await session.execute(
        delete(RoomScheduleTarget).where(
            RoomScheduleTarget.schedule_id == row.id,
            RoomScheduleTarget.tenant_id == require_tenant_id(),
        )
    )
    session.add_all(
        RoomScheduleTarget(schedule_id=row.id, agent_id=agent_id)
        for agent_id in data.agent_ids
    )
    await session.flush()


@router.get("/rooms/{room_id}/schedules")
async def list_schedules(
    room_id: str, session: Session, rooms: Rooms, user: Person, is_admin: Admin
) -> list[ScheduleDetail]:
    await require_room_access(session, rooms, room_id, user, "read", is_admin)
    rows = (
        await session.scalars(
            select(RoomSchedule)
            .where(
                RoomSchedule.room_id == room_id,
                RoomSchedule.tenant_id == require_tenant_id(),
            )
            .order_by(RoomSchedule.id)
        )
    ).all()
    return [await detail(session, row) for row in rows]


@router.post("/rooms/{room_id}/schedules", status_code=201)
async def create_schedule(
    room_id: str,
    data: ScheduleInput,
    session: Session,
    rooms: Rooms,
    user: Person,
    is_admin: Admin,
) -> ScheduleDetail:
    await managed_room(session, rooms, room_id, user, is_admin)
    row = RoomSchedule(
        room_id=room_id, author_id=user.id, body=data.body, timezone=data.timezone
    )
    session.add(row)
    await apply_input(session, row, data)
    result = await detail(session, row)
    await session.commit()
    return result


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
    await managed_room(session, rooms, room_id, user, is_admin)
    row = await find_schedule(session, room_id, schedule_id)
    row.author_id = user.id
    await apply_input(session, row, data)
    result = await detail(session, row)
    await session.commit()
    return result


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
    await managed_room(session, rooms, room_id, user, is_admin)
    row = await find_schedule(session, room_id, schedule_id)
    if not data.paused:
        if row.next_run_at is None and row.cron is None:
            raise HTTPException(409, "Edit the time to run a completed schedule again")
        if row.cron:
            now = (await session.execute(select(func.clock_timestamp()))).scalar_one()
            try:
                row.next_run_at = next_cron_run(row.cron, row.timezone, now)
            except ScheduleTimingError as exc:
                raise HTTPException(422, str(exc)) from exc
        row.author_id = user.id
        row.last_error = None
    row.paused = data.paused
    result = await detail(session, row)
    await session.commit()
    return result


@router.delete("/rooms/{room_id}/schedules/{schedule_id}", status_code=204)
async def delete_schedule(
    room_id: str,
    schedule_id: str,
    session: Session,
    rooms: Rooms,
    user: Person,
    is_admin: Admin,
) -> Response:
    await managed_room(session, rooms, room_id, user, is_admin)
    row = await find_schedule(session, room_id, schedule_id)
    await session.delete(row)
    await session.commit()
    return Response(status_code=204)
