"""Room automation management. Public write access does not grant automation."""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

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
from switch_core.scheduling.timing import ScheduleTimingError, next_cron_run


class ScheduleError(ValueError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


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
    author_agent_id: str | None = None
    body: str
    agent_ids: list[str]
    timezone: str
    cron: str | None
    next_run_at: datetime | None
    paused: bool
    last_error: str | None
    last_run_at: datetime | None


async def managed_room(
    session: AsyncSession, rooms: RoomStore, room_id: str, user: User, is_admin: bool
) -> Room:
    room = await rooms.get(session, room_id)
    if room is None:
        raise ScheduleError(404, "Room not found")
    try:
        require_manage(Principal(user.id, is_admin), room.owner_id)
    except PermissionError as exc:
        raise ScheduleError(403, str(exc)) from exc
    if room.archived_at is not None:
        raise ScheduleError(409, "Unarchive this room to manage its schedules")
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
        raise ScheduleError(404, "Schedule not found")
    return row


async def detail(session: AsyncSession, row: RoomSchedule) -> ScheduleDetail:
    return (await details(session, [row]))[0]


async def details(
    session: AsyncSession, rows: list[RoomSchedule]
) -> list[ScheduleDetail]:
    if not rows:
        return []
    ids = [row.id for row in rows]
    targets: dict[str, list[str]] = {}
    for schedule_id, agent_id in await session.execute(
        select(RoomScheduleTarget.schedule_id, RoomScheduleTarget.agent_id)
        .where(
            RoomScheduleTarget.schedule_id.in_(ids),
            RoomScheduleTarget.tenant_id == require_tenant_id(),
        )
        .order_by(RoomScheduleTarget.agent_id)
    ):
        targets.setdefault(schedule_id, []).append(agent_id)
    last_runs = {
        schedule_id: last_run
        for schedule_id, last_run in await session.execute(
            select(RoomScheduleRun.schedule_id, func.max(RoomScheduleRun.scheduled_for))
            .where(
                RoomScheduleRun.schedule_id.in_(ids),
                RoomScheduleRun.tenant_id == require_tenant_id(),
            )
            .group_by(RoomScheduleRun.schedule_id)
        )
    }
    return [
        ScheduleDetail(
            id=row.id,
            author_agent_id=row.author_agent_id,
            body=row.body,
            agent_ids=targets.get(row.id, []),
            timezone=row.timezone,
            cron=row.cron,
            next_run_at=row.next_run_at,
            paused=row.paused,
            last_error=row.last_error,
            last_run_at=last_runs.get(row.id),
        )
        for row in rows
    ]


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
        raise ScheduleError(422, "Choose agents that are currently in this room")
    now = (await session.execute(select(func.clock_timestamp()))).scalar_one()
    try:
        ZoneInfo(data.timezone)
        next_due = (
            next_cron_run(data.cron, data.timezone, now)
            if data.cron is not None
            else data.run_at
        )
    except (ScheduleTimingError, ZoneInfoNotFoundError, ValueError) as exc:
        raise ScheduleError(422, str(exc)) from exc
    assert next_due is not None
    if next_due <= now:
        raise ScheduleError(422, "Choose a future one-off time")
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


async def list_schedules(
    room_id: str, session: AsyncSession, rooms: RoomStore, user: User, is_admin: bool
) -> list[ScheduleDetail]:
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
    return await details(session, list(rows))


async def create_schedule(
    room_id: str,
    data: ScheduleInput,
    session: AsyncSession,
    rooms: RoomStore,
    user: User,
    is_admin: bool,
    *,
    author_agent_id: str | None = None,
) -> ScheduleDetail:
    await managed_room(session, rooms, room_id, user, is_admin)
    row = RoomSchedule(
        room_id=room_id,
        author_id=user.id,
        author_agent_id=author_agent_id,
        body=data.body,
        timezone=data.timezone,
    )
    session.add(row)
    await apply_input(session, row, data)
    result = await detail(session, row)
    await session.commit()
    return result


async def edit_schedule(
    room_id: str,
    schedule_id: str,
    data: ScheduleInput,
    session: AsyncSession,
    rooms: RoomStore,
    user: User,
    is_admin: bool,
    *,
    author_agent_id: str | None = None,
) -> ScheduleDetail:
    await managed_room(session, rooms, room_id, user, is_admin)
    row = await find_schedule(session, room_id, schedule_id)
    row.author_id = user.id
    row.author_agent_id = author_agent_id
    await apply_input(session, row, data)
    result = await detail(session, row)
    await session.commit()
    return result


async def pause_schedule(
    room_id: str,
    schedule_id: str,
    data: SchedulePause,
    session: AsyncSession,
    rooms: RoomStore,
    user: User,
    is_admin: bool,
    *,
    author_agent_id: str | None = None,
) -> ScheduleDetail:
    await managed_room(session, rooms, room_id, user, is_admin)
    row = await find_schedule(session, room_id, schedule_id)
    if not data.paused and row.next_run_at is None and row.cron is None:
        raise ScheduleError(409, "Edit the time to run a completed schedule again")
    if not data.paused and row.paused:
        if row.cron:
            now = (await session.execute(select(func.clock_timestamp()))).scalar_one()
            try:
                row.next_run_at = next_cron_run(row.cron, row.timezone, now)
            except ScheduleTimingError as exc:
                raise ScheduleError(422, str(exc)) from exc
        row.author_id = user.id
        row.author_agent_id = author_agent_id
        row.last_error = None
    row.paused = data.paused
    result = await detail(session, row)
    await session.commit()
    return result


async def delete_schedule(
    room_id: str,
    schedule_id: str,
    session: AsyncSession,
    rooms: RoomStore,
    user: User,
    is_admin: bool,
) -> None:
    await managed_room(session, rooms, room_id, user, is_admin)
    row = await find_schedule(session, room_id, schedule_id)
    await session.delete(row)
    await session.commit()
