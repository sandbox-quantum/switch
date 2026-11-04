"""The restart sweep is owned work, as upstream's session-activity sweeps are:
one process runs it at a time, so a Core with several processes never posts
the restart line twice for one turn, and another takes over when it stops."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.ownership import Ownership
from switch_core.session_activity import maintenance
from switch_core.signals import SignalBus
from tests.ownership import process_lease_on


async def _post(*_a: Any, **_k: Any) -> str:
    return "$notice"


def _never_listening() -> Any:
    raise AssertionError("these processes' signal buses are never started")


class _Kind:
    def __init__(self) -> None:
        self.wanted: list[str] = []

    def want(self, key: str) -> None:
        self.wanted.append(key)


class _Ownership:
    def __init__(self) -> None:
        self.kinds: dict[str, tuple[Any, Any, _Kind]] = {}

    def kind(self, name: str, *, start: Any, stop: Any) -> _Kind:
        kind = _Kind()
        self.kinds[name] = (start, stop, kind)
        return kind


async def test_it_runs_only_once_its_process_owns_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Registered as its own kind and wanted, but nothing runs until ownership
    starts it here; stopping it stops the loop."""
    running = asyncio.Event()
    stopped = asyncio.Event()

    async def loop(_factory: Any, _post_as_agent: Any) -> None:
        running.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(maintenance, "restart_sweep_loop", loop)
    ownership = _Ownership()
    maintenance.own_restart_sweep(ownership, object(), _post)  # type: ignore[arg-type]
    start, stop, kind = ownership.kinds[maintenance.RESTART_SWEEP_KIND]
    assert kind.wanted == [maintenance.SWEEP_KEY]
    await asyncio.sleep(0)
    assert not running.is_set()  # not owned yet: no sweep here
    await start(maintenance.SWEEP_KEY, None)
    await asyncio.wait_for(running.wait(), timeout=1)
    await stop(maintenance.SWEEP_KEY)
    assert stopped.is_set()


async def test_a_sweep_that_ends_with_an_error_is_restarted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runs: list[int] = []
    second_run = asyncio.Event()

    async def loop(_factory: Any, _post_as_agent: Any) -> None:
        runs.append(len(runs))
        if len(runs) == 1:
            raise RuntimeError("sweep broke")
        second_run.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(maintenance, "restart_sweep_loop", loop)
    ownership = _Ownership()
    maintenance.own_restart_sweep(ownership, object(), _post)  # type: ignore[arg-type]
    start, stop, _ = ownership.kinds[maintenance.RESTART_SWEEP_KIND]
    await start(maintenance.SWEEP_KEY, None)
    await asyncio.wait_for(second_run.wait(), timeout=1)
    assert runs == [0, 1]
    await stop(maintenance.SWEEP_KEY)


async def test_of_two_processes_only_one_sweeps(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Against Postgres: two processes register it, and one holds it."""
    sweeping: list[str] = []

    async def loop(_factory: Any, _post_as_agent: Any) -> None:
        process = asyncio.current_task().get_name()  # type: ignore[union-attr]
        sweeping.append(process)
        try:
            await asyncio.Event().wait()
        finally:
            sweeping.remove(process)

    monkeypatch.setattr(maintenance, "restart_sweep_loop", loop)
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
        kind = maintenance.own_restart_sweep(ownership, session_factory, _post)
        processes.append((ownership, kind))
    for ownership, _ in processes:
        await ownership.balance()
    await asyncio.sleep(0)
    assert len([kind for _, kind in processes if kind.held()]) == 1
    assert len(sweeping) == 1
    for ownership, _ in processes:
        await ownership.stop()
