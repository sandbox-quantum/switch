from collections.abc import Collection
from datetime import datetime

from sqlalchemy import delete, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import RoomSchedule, RoomScheduleAgent


class RoomScheduleStore:
    """Storage for a room's scheduled messages (`room_schedules`) and the
    agents each one addresses (`room_schedule_agents`)."""

    async def create(
        self,
        session: AsyncSession,
        *,
        room_id: str,
        author_id: str,
        author_agent_id: str | None,
        body: str,
        run_at: datetime | None,
        cron: str | None,
        timezone: str,
        next_run_at: datetime | None,
        agent_ids: Collection[str],
    ) -> RoomSchedule:
        schedule = RoomSchedule(
            room_id=room_id,
            author_id=author_id,
            author_agent_id=author_agent_id,
            body=body,
            run_at=run_at,
            cron=cron,
            timezone=timezone,
            paused=False,
            next_run_at=next_run_at,
        )
        session.add(schedule)
        await session.flush()
        await self.set_agents(session, schedule.id, agent_ids)
        return schedule

    async def get(
        self, session: AsyncSession, room_id: str, schedule_id: str
    ) -> RoomSchedule | None:
        result = await session.execute(
            select(RoomSchedule).where(
                RoomSchedule.id == schedule_id, RoomSchedule.room_id == room_id
            )
        )
        return result.scalar_one_or_none()

    async def list_for_room(
        self, session: AsyncSession, room_id: str
    ) -> list[RoomSchedule]:
        result = await session.scalars(
            select(RoomSchedule)
            .where(RoomSchedule.room_id == room_id)
            .order_by(RoomSchedule.created_at, RoomSchedule.id)
        )
        return list(result.all())

    async def agent_ids(
        self, session: AsyncSession, schedule_ids: Collection[str]
    ) -> dict[str, list[str]]:
        """The agents each schedule addresses, keyed by schedule id. A schedule
        with no agents left has no key."""
        if not schedule_ids:
            return {}
        result = await session.execute(
            select(RoomScheduleAgent.schedule_id, RoomScheduleAgent.agent_id)
            .where(RoomScheduleAgent.schedule_id.in_(schedule_ids))
            .order_by(RoomScheduleAgent.agent_id)
        )
        by_schedule: dict[str, list[str]] = {}
        for schedule_id, agent_id in result.all():
            by_schedule.setdefault(schedule_id, []).append(agent_id)
        return by_schedule

    async def set_agents(
        self, session: AsyncSession, schedule_id: str, agent_ids: Collection[str]
    ) -> None:
        await session.execute(
            delete(RoomScheduleAgent).where(
                RoomScheduleAgent.schedule_id == schedule_id
            )
        )
        if agent_ids:
            await session.execute(
                insert(RoomScheduleAgent),
                [
                    {"schedule_id": schedule_id, "agent_id": agent_id}
                    for agent_id in sorted(set(agent_ids))
                ],
            )
        await session.flush()

    async def remove_agents(
        self, session: AsyncSession, schedule_id: str, agent_ids: Collection[str]
    ) -> None:
        await session.execute(
            delete(RoomScheduleAgent).where(
                RoomScheduleAgent.schedule_id == schedule_id,
                RoomScheduleAgent.agent_id.in_(agent_ids),
            )
        )
        await session.flush()

    async def delete(self, session: AsyncSession, schedule: RoomSchedule) -> None:
        await session.delete(schedule)
        await session.flush()

    async def claim_due(self, session: AsyncSession) -> RoomSchedule | None:
        """The earliest schedule of the bound tenant that is due, locked for
        this transaction; None when none is due or every due one is already
        claimed by another process. Due is judged on the database's clock."""
        result = await session.execute(
            select(RoomSchedule)
            .where(
                RoomSchedule.paused.is_(False),
                RoomSchedule.next_run_at <= func.now(),
            )
            .order_by(RoomSchedule.next_run_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        return result.scalar_one_or_none()
