"""The session-activity sweeps run in one process at a time, and move to
another when that one stops or its lease lapses."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import SwitchCoreProcess
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.ownership import Ownership
from switch_core.process_lease import LEASE_TTL
from switch_core.session_activity import maintenance
from switch_core.signals import SignalBus
from tests.ownership import process_lease_on


def _never_listening() -> Any:
    raise AssertionError("these processes' signal buses are never started")


async def test_one_process_sweeps_and_another_takes_over(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sweeping: list[str] = []

    async def loop(_factory: Any) -> None:
        process = asyncio.current_task().get_name()  # type: ignore[union-attr]
        sweeping.append(process)
        try:
            await asyncio.Event().wait()
        finally:
            sweeping.remove(process)

    monkeypatch.setattr(maintenance, "maintenance_loop", loop)

    processes = []
    for _ in range(2):
        lease = process_lease_on(session_factory)
        await lease.renew()
        ownership = Ownership(
            lease=lease,
            session_factory=session_factory,
            bus=SignalBus(
                session_factory, _never_listening, process_id=lease.process_id
            ),
            store=OwnershipLeaseStore(),
            processes=SwitchCoreProcessStore(),
        )
        kind = maintenance.own_maintenance(ownership, session_factory)
        processes.append((lease, ownership, kind))

    for _, ownership, _ in processes:
        await ownership.balance()
    await asyncio.sleep(0)
    holders = [kind for _, _, kind in processes if kind.held()]
    assert len(holders) == 1 and len(sweeping) == 1

    holder = next(p for p in processes if p[2].held())
    other = next(p for p in processes if not p[2].held())
    # The holder dies: its lease lapses and the other process claims the sweeps.
    async with session_factory() as session:
        await session.execute(
            update(SwitchCoreProcess)
            .where(SwitchCoreProcess.id == holder[0].process_id)
            .values(beat_at=func.now() - LEASE_TTL - timedelta(seconds=1))
        )
        await session.commit()
    await other[1].balance()
    await asyncio.sleep(0)
    assert other[2].held() == {maintenance.SWEEP_KEY}
    for _, ownership, _ in processes:
        await ownership.stop()


async def test_sweeps_that_end_with_an_error_are_restarted(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runs: list[int] = []
    second_run = asyncio.Event()

    async def loop(_factory: Any) -> None:
        runs.append(len(runs))
        if len(runs) == 1:
            raise RuntimeError("sweep broke")
        second_run.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(maintenance, "maintenance_loop", loop)

    starts: dict[str, Any] = {}

    class _Kind:
        def want(self, key: str) -> None:
            pass

    class _Ownership:
        def kind(self, name: str, *, start: Any, stop: Any) -> _Kind:
            starts["start"], starts["stop"] = start, stop
            return _Kind()

    maintenance.own_maintenance(_Ownership(), session_factory)  # type: ignore[arg-type]
    await starts["start"](maintenance.SWEEP_KEY, None)
    await asyncio.wait_for(second_run.wait(), timeout=1)
    assert runs == [0, 1]
    await starts["stop"](maintenance.SWEEP_KEY)
