from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import RoomSchedule


class RoomScheduleStore:
    """Storage for room-level message schedules (`room_schedules`)."""

    async def create(
        self,
        session: AsyncSession,
        *,
        room_id: str,
        message: str,
        target_agent_ids: list[str],
        schedule_type: str = "recurring",
        cron_expression: str | None = None,
        timezone: str = "UTC",
        next_run_at: datetime | None = None,
        created_by_user_id: str | None = None,
        name: str | None = None,
        status: str = "active",
        missed_run_policy: str = "run_once",
    ) -> RoomSchedule:
        schedule = RoomSchedule(
            room_id=room_id,
            created_by_user_id=created_by_user_id,
            name=name,
            message=message,
            target_agent_ids=target_agent_ids,
            schedule_type=schedule_type,
            cron_expression=cron_expression,
            timezone=timezone,
            next_run_at=next_run_at,
            status=status,
            missed_run_policy=missed_run_policy,
        )
        session.add(schedule)
        await session.flush()
        return schedule

    async def get(self, session: AsyncSession, schedule_id: str) -> RoomSchedule | None:
        return await session.get(RoomSchedule, schedule_id)

    async def list_for_room(
        self, session: AsyncSession, room_id: str
    ) -> list[RoomSchedule]:
        stmt = (
            select(RoomSchedule)
            .where(RoomSchedule.room_id == room_id)
            .order_by(RoomSchedule.created_at.asc())
        )
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def update(
        self,
        session: AsyncSession,
        schedule_id: str,
        *,
        name: str | None = None,
        message: str | None = None,
        target_agent_ids: list[str] | None = None,
        cron_expression: str | None = None,
        timezone: str | None = None,
        next_run_at: datetime | None = None,
        status: str | None = None,
        missed_run_policy: str | None = None,
    ) -> RoomSchedule | None:
        schedule = await session.get(RoomSchedule, schedule_id)
        if schedule is None:
            return None
        if name is not None:
            schedule.name = name
        if message is not None:
            schedule.message = message
        if target_agent_ids is not None:
            schedule.target_agent_ids = target_agent_ids
        if cron_expression is not None:
            schedule.cron_expression = cron_expression
        if timezone is not None:
            schedule.timezone = timezone
        if next_run_at is not None:
            schedule.next_run_at = next_run_at
        if status is not None:
            schedule.status = status
        if missed_run_policy is not None:
            schedule.missed_run_policy = missed_run_policy
        await session.flush()
        return schedule

    async def set_status(
        self,
        session: AsyncSession,
        schedule_id: str,
        status: str,
        next_run_at: datetime | None = None,
    ) -> RoomSchedule | None:
        schedule = await self.get(session, schedule_id)
        if schedule is None:
            return None
        schedule.status = status
        if next_run_at is not None:
            schedule.next_run_at = next_run_at
        await session.flush()
        return schedule

    async def delete(self, session: AsyncSession, schedule_id: str) -> bool:
        schedule = await self.get(session, schedule_id)
        if schedule is None:
            return False
        await session.delete(schedule)
        await session.flush()
        return True

    async def fetch_due_schedules(
        self,
        session: AsyncSession,
        as_of: datetime,
        limit: int = 50,
    ) -> list[RoomSchedule]:
        """Fetch and lock due schedules that are active and scheduled to run at or before `as_of`.

        Uses `with_for_update(skip_locked=True)` to prevent duplicate execution across
        multiple concurrent worker processes or pods.
        """
        stmt = (
            select(RoomSchedule)
            .where(
                RoomSchedule.status == "active",
                RoomSchedule.next_run_at <= as_of,
            )
            .order_by(RoomSchedule.next_run_at.asc())
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def record_run(
        self,
        session: AsyncSession,
        schedule_id: str,
        *,
        executed_at: datetime,
        next_run_at: datetime | None,
        mark_completed: bool = False,
    ) -> None:
        schedule = await session.get(RoomSchedule, schedule_id)
        if schedule is None:
            return
        schedule.last_run_at = executed_at
        schedule.next_run_at = next_run_at
        if mark_completed:
            schedule.status = "completed"
        await session.flush()
