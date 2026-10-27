"""What an agent's turns spent per room (`RoomTokenUsage`)."""

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, literal, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import RoomTokenUsage


@dataclass(frozen=True)
class RoomSpend:
    """One room's spend for one agent on one UTC day, across models."""

    room_id: str
    day: str
    turns: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int


class RoomUsageStore:
    async def record(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        agent_id: str,
        room_id: str,
        model: str,
        turns: int,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int,
        cache_write_tokens: int,
    ) -> None:
        """Add to the current hour's row, in the caller's transaction. The hour
        is the database's, in UTC, as `UsageStore.record` takes it."""
        bucket = func.date_trunc("hour", func.now(), literal("UTC"))
        statement = insert(RoomTokenUsage).values(
            tenant_id=tenant_id,
            agent_id=agent_id,
            room_id=room_id,
            bucket_start=bucket,
            model=model,
            turns=turns,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
        )
        excluded = statement.excluded
        statement = statement.on_conflict_do_update(
            index_elements=[
                "tenant_id",
                "agent_id",
                "room_id",
                "bucket_start",
                "model",
            ],
            set_={
                "turns": RoomTokenUsage.turns + excluded.turns,
                "input_tokens": RoomTokenUsage.input_tokens + excluded.input_tokens,
                "output_tokens": RoomTokenUsage.output_tokens + excluded.output_tokens,
                "cache_read_tokens": RoomTokenUsage.cache_read_tokens
                + excluded.cache_read_tokens,
                "cache_write_tokens": RoomTokenUsage.cache_write_tokens
                + excluded.cache_write_tokens,
            },
        )
        await session.execute(statement)

    async def by_room_and_day(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        agent_id: str,
        since: datetime,
    ) -> list[RoomSpend]:
        """The agent's spend per room per UTC day, from `since`, newest day
        first. Names the tenant explicitly, as `UsageStore.totals` does."""
        day = func.to_char(
            func.timezone("UTC", RoomTokenUsage.bucket_start), "YYYY-MM-DD"
        ).label("day")
        rows = await session.execute(
            select(
                RoomTokenUsage.room_id,
                day,
                func.sum(RoomTokenUsage.turns),
                func.sum(RoomTokenUsage.input_tokens),
                func.sum(RoomTokenUsage.output_tokens),
                func.sum(RoomTokenUsage.cache_read_tokens),
                func.sum(RoomTokenUsage.cache_write_tokens),
            )
            .where(
                RoomTokenUsage.tenant_id == tenant_id,
                RoomTokenUsage.agent_id == agent_id,
                RoomTokenUsage.bucket_start >= func.date_trunc("hour", literal(since)),
            )
            .group_by(RoomTokenUsage.room_id, day)
            .order_by(day.desc(), RoomTokenUsage.room_id)
        )
        return [
            RoomSpend(
                room_id=room_id,
                day=day_,
                turns=int(turns),
                input_tokens=int(input_),
                output_tokens=int(output),
                cache_read_tokens=int(cache_read),
                cache_write_tokens=int(cache_write),
            )
            for room_id, day_, turns, input_, output, cache_read, cache_write in rows
        ]
