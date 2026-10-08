from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import SwitchCoreProcess


@dataclass(frozen=True)
class ProcessLeaseRow:
    beat_at: datetime
    stopped_at: datetime | None


class SwitchCoreProcessStore:
    """Each switch-core process's lease (`switch_core_processes`), a global
    table.

    Every time here is the database's own clock, so leases written by one
    process and read by another are compared on one clock whatever the two
    hosts' clocks say.
    """

    async def renew(self, session: AsyncSession, process_id: str) -> None:
        """Claim the lease, or renew it: its beat is now. A row pruned while
        this process could not reach the database is claimed again."""
        await session.execute(
            insert(SwitchCoreProcess)
            .values(id=process_id, started_at=func.now(), beat_at=func.now())
            .on_conflict_do_update(
                index_elements=[SwitchCoreProcess.id],
                set_={"beat_at": func.now(), "stopped_at": None},
            )
        )

    async def stop(self, session: AsyncSession, process_id: str) -> None:
        await session.execute(
            update(SwitchCoreProcess)
            .where(SwitchCoreProcess.id == process_id)
            .values(stopped_at=func.now())
        )

    async def prune(self, session: AsyncSession, older_than: timedelta) -> int:
        """Delete leases whose last beat is older than `older_than`. Returns
        how many."""
        result = await session.execute(
            delete(SwitchCoreProcess)
            .where(SwitchCoreProcess.beat_at < func.now() - older_than)
            .returning(SwitchCoreProcess.id)
        )
        return len(result.all())

    async def read(
        self, session: AsyncSession
    ) -> tuple[datetime, dict[str, ProcessLeaseRow]]:
        """The database's now, and every lease as it stands then."""
        now = (await session.execute(select(func.now()))).scalar_one()
        rows = await session.execute(
            select(
                SwitchCoreProcess.id,
                SwitchCoreProcess.beat_at,
                SwitchCoreProcess.stopped_at,
            )
        )
        return now, {
            process_id: ProcessLeaseRow(beat_at=beat_at, stopped_at=stopped_at)
            for process_id, beat_at, stopped_at in rows.all()
        }
