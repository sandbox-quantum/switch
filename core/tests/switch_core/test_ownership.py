"""One owner for each piece of work, among several processes on one database.

Each "process" here is what `main` builds for one: its own lease in
`switch_core_processes`, its own `Ownership` and its own work, all on the same
database, so who owns what is decided only by the rows, as it is between real
processes. Balances are run by hand instead of on the interval.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import main as main_module
from switch_core.db.models import OwnershipLease, SwitchCoreProcess
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.main import _release_process
from switch_core.ownership import Fence, OwnedKind, Ownership, owner_of
from switch_core.process_lease import LEASE_TTL, ProcessLease
from switch_core.signals import SignalBus
from tests.ownership import process_lease_on

KIND = "work"
KEYS = [f"key-{n}" for n in range(24)]


def _never_listening() -> Any:
    raise AssertionError("these processes' signal buses are never started")


@dataclass
class _Everywhere:
    """Which processes run each key right now, across all of them, so a test
    can say a key never ran in two at once."""

    running: dict[str, set[str]] = field(default_factory=dict)
    overlaps: list[str] = field(default_factory=list)


@dataclass
class _Process:
    lease: ProcessLease
    ownership: Ownership
    kind: OwnedKind
    started: list[Fence] = field(default_factory=list)
    stopped: list[str] = field(default_factory=list)

    @property
    def process_id(self) -> str:
        return self.lease.process_id

    def runs(self) -> set[str]:
        return self.kind.held()


def _process(
    session_factory: async_sessionmaker[AsyncSession], everywhere: _Everywhere
) -> _Process:
    lease = process_lease_on(session_factory)
    process_id = lease.process_id
    ownership = Ownership(
        lease=lease,
        session_factory=session_factory,
        bus=SignalBus(session_factory, _never_listening, process_id=process_id),
        store=OwnershipLeaseStore(),
        processes=SwitchCoreProcessStore(),
    )
    holder: dict[str, _Process] = {}

    async def start(key: str, fence: Fence) -> None:
        holder["p"].started.append(fence)
        running = everywhere.running.setdefault(key, set())
        if running:
            everywhere.overlaps.append(key)
        running.add(process_id)

    async def stop(key: str) -> None:
        holder["p"].stopped.append(key)
        everywhere.running.get(key, set()).discard(process_id)

    kind = ownership.kind(KIND, start=start, stop=stop)
    holder["p"] = _Process(lease=lease, ownership=ownership, kind=kind)
    return holder["p"]


@pytest.fixture
def everywhere() -> _Everywhere:
    return _Everywhere()


@pytest.fixture
async def two(
    session_factory: async_sessionmaker[AsyncSession], everywhere: _Everywhere
) -> AsyncIterator[tuple[_Process, _Process]]:
    a = _process(session_factory, everywhere)
    b = _process(session_factory, everywhere)
    for process in (a, b):
        await process.lease.renew()
        for key in KEYS:
            process.kind.want(key)
    yield a, b


async def _holders(session_factory: async_sessionmaker[AsyncSession]) -> dict[str, str]:
    async with session_factory() as session:
        rows = await session.execute(
            select(OwnershipLease.key, OwnershipLease.process_id).where(
                OwnershipLease.kind == KIND
            )
        )
    return {key: process_id for key, process_id in rows.tuples().all() if process_id}


async def _lapse(
    session_factory: async_sessionmaker[AsyncSession], process: _Process
) -> None:
    """Make `process`'s lease read as lapsed to everyone: as if it had not
    renewed for longer than the lease lives."""
    async with session_factory() as session:
        await session.execute(
            update(SwitchCoreProcess)
            .where(SwitchCoreProcess.id == process.process_id)
            .values(beat_at=func.now() - LEASE_TTL - timedelta(seconds=1))
        )
        await session.commit()


class TestOneOwner:
    async def test_two_processes_split_the_keys_and_run_each_once(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
        everywhere: _Everywhere,
    ) -> None:
        a, b = two

        await a.ownership.balance()
        await b.ownership.balance()

        assert a.runs() | b.runs() == set(KEYS)
        assert a.runs() & b.runs() == set()
        assert a.runs() and b.runs()
        assert everywhere.overlaps == []
        holders = await _holders(session_factory)
        assert {key for key, holder in holders.items() if holder == a.process_id} == (
            a.runs()
        )

    async def test_each_runs_what_the_hash_gives_it(
        self, two: tuple[_Process, _Process]
    ) -> None:
        a, b = two
        await a.ownership.balance()
        await b.ownership.balance()

        live = sorted([a.process_id, b.process_id])
        for key in KEYS:
            owner = a if owner_of(KIND, key, live) == a.process_id else b
            assert key in owner.runs()

    async def test_keys_placed_with_another_kinds_key_run_beside_it(
        self, two: tuple[_Process, _Process]
    ) -> None:
        a, b = two
        beside = ("socket", "the-one")
        for process in two:
            for key in KEYS:
                process.kind.want(key, placed_with=beside)
        await a.ownership.balance()
        await b.ownership.balance()

        live = sorted([a.process_id, b.process_id])
        owner = a if owner_of(*beside, live) == a.process_id else b
        assert owner.runs() == set(KEYS)

    async def test_one_process_owns_everything(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        everywhere: _Everywhere,
    ) -> None:
        only = _process(session_factory, everywhere)
        await only.lease.renew()
        for key in KEYS:
            only.kind.want(key)

        await only.ownership.balance()

        assert only.runs() == set(KEYS)
        assert [fence.token for fence in only.started] == [1] * len(KEYS)

    async def test_a_kind_registered_while_balancing_runs_from_the_next_balance(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Discord's gateway registers its kind once the signal bus has
        started, so a resync's balance can be under way as it does. That
        balance goes on with the kinds it began with; the next one takes the
        new kind in."""
        lease = process_lease_on(session_factory)
        ownership = Ownership(
            lease=lease,
            session_factory=session_factory,
            bus=SignalBus(
                session_factory, _never_listening, process_id=lease.process_id
            ),
            store=OwnershipLeaseStore(),
            processes=SwitchCoreProcessStore(),
        )
        late_started: list[str] = []

        async def late_start(key: str, _fence: Fence) -> None:
            late_started.append(key)

        async def nothing(_key: str) -> None:
            return None

        async def start_and_register(_key: str, _fence: Fence) -> None:
            ownership.kind("socket", start=late_start, stop=nothing).want("the-one")

        ownership.kind(KIND, start=start_and_register, stop=nothing).want("key-0")
        await lease.renew()

        await ownership.balance()
        assert late_started == []
        await ownership.balance()
        assert late_started == ["the-one"]


class TestHandingOver:
    async def test_a_process_that_joins_takes_its_share_without_overlap(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        everywhere: _Everywhere,
    ) -> None:
        a = _process(session_factory, everywhere)
        await a.lease.renew()
        for key in KEYS:
            a.kind.want(key)
        await a.ownership.balance()
        assert a.runs() == set(KEYS)

        b = _process(session_factory, everywhere)
        await b.lease.renew()
        for key in KEYS:
            b.kind.want(key)
        # b's share is still a's: nothing is claimed from a live holder.
        await b.ownership.balance()
        assert b.runs() == set()
        # a sees b and lets go of b's share; b then claims it.
        await a.ownership.balance()
        await b.ownership.balance()

        live = sorted([a.process_id, b.process_id])
        b_share = {key for key in KEYS if owner_of(KIND, key, live) == b.process_id}
        assert b.runs() == b_share
        assert a.runs() == set(KEYS) - b_share
        assert set(a.stopped) == b_share
        assert everywhere.overlaps == []
        # Every claim moves the token on, so a's old holds are fenced off.
        assert {fence.token for fence in b.started} == {2}

    async def test_a_process_that_stops_hands_everything_over(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
        everywhere: _Everywhere,
    ) -> None:
        a, b = two
        await a.ownership.balance()
        await b.ownership.balance()
        a_had = a.runs()

        # As `main` shuts a process down: its work, then its lease.
        await a.ownership.stop()
        await a.lease.stop()
        await b.ownership.balance()

        assert b.runs() == set(KEYS)
        assert set(a.stopped) == a_had
        assert everywhere.overlaps == []
        assert await _holders(session_factory) == dict.fromkeys(KEYS, b.process_id)

    async def test_a_process_that_stops_is_taken_over_on_its_last_signal(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
        everywhere: _Everywhere,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Shut down as `main` does (`_release_process`). The other process
        balances when it hears a signal, so the last one a sends must come
        once a's lease reads as stopped, or b claims nothing until its next
        interval."""
        a, b = two
        await a.ownership.balance()
        await b.ownership.balance()
        a_had = a.runs()
        assert a_had

        sent_with_lease_stopped: list[bool] = []
        publish = a.ownership._bus.publish

        def recording(kind: str, **fields: Any) -> None:
            sent_with_lease_stopped.append(a.lease._stopped)
            publish(kind, **fields)

        monkeypatch.setattr(a.ownership._bus, "publish", recording)

        class _NoConnections:
            async def flush(self) -> None:
                pass

        await _release_process(
            a.ownership,
            _NoConnections(),  # type: ignore[arg-type]
            None,
            a.lease,
        )

        assert sent_with_lease_stopped[-1:] == [True]
        await b.ownership.balance()  # on hearing it
        assert b.runs() == set(KEYS)
        assert everywhere.overlaps == []

    async def test_work_that_would_not_stop_leaves_the_lease_to_lapse(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
        everywhere: _Everywhere,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """`main` releases twice as it shuts down, from the signal handler
        and from the lifespan's teardown, in either order. The first gave up
        on a stop that hung, so the work may still run here: the second must
        not mark the lease stopped either, and the work passes on once the
        lease lapses."""
        a, b = two
        await a.ownership.balance()
        await b.ownership.balance()
        a_had = a.runs()
        assert a_had

        async def hang(key: str) -> None:
            await asyncio.Event().wait()

        monkeypatch.setattr(a.kind, "_stop", hang)
        monkeypatch.setattr(main_module, "_HAND_OVER_SECONDS", 0.05)

        class _NoConnections:
            async def flush(self) -> None:
                pass

        for _ in range(2):
            await _release_process(
                a.ownership,
                _NoConnections(),  # type: ignore[arg-type]
                None,
                a.lease,
            )

        assert not a.lease._stopped
        await b.ownership.balance()
        assert b.runs() == set(KEYS) - a_had
        assert everywhere.overlaps == []

        await _lapse(session_factory, a)
        await b.ownership.balance()
        assert b.runs() == set(KEYS)

    async def test_a_process_that_died_is_taken_over_once_its_lease_lapses(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
    ) -> None:
        a, b = two
        await a.ownership.balance()
        await b.ownership.balance()
        a_had = a.runs()

        # a dies without a word. While its lease still holds, b waits.
        await b.ownership.balance()
        assert b.runs() == set(KEYS) - a_had

        await _lapse(session_factory, a)
        await b.ownership.balance()

        assert b.runs() == set(KEYS)
        assert a.stopped == []

    async def test_a_process_unsure_of_its_lease_stops_its_work_first(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
        everywhere: _Everywhere,
    ) -> None:
        """Its renewals have been failing: it stops at half the lease's
        lifetime by its own clock, before anyone may read the lease as
        lapsed and take its work."""
        a, b = two
        await a.ownership.balance()
        await b.ownership.balance()
        a_had = a.runs()

        a.lease._renewed_at = time.monotonic() - LEASE_TTL.total_seconds()
        await a.ownership.balance()
        assert a.runs() == set()
        assert set(a.stopped) == a_had

        await _lapse(session_factory, a)
        await b.ownership.balance()
        assert b.runs() == set(KEYS)
        assert everywhere.overlaps == []

        # Renewing again, a gets its share back from b.
        await a.lease.renew()
        await a.ownership.balance()
        await b.ownership.balance()
        await a.ownership.balance()
        assert a.runs() == a_had
        assert everywhere.overlaps == []

    async def test_work_dropped_here_is_stopped_and_let_go_of(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
    ) -> None:
        a, b = two
        await a.ownership.balance()
        key = sorted(a.runs())[0]

        await a.kind.drop(key)

        assert key in a.stopped
        assert key not in a.runs()
        assert key not in await _holders(session_factory)
        # Not wanted here any more, so not claimed again either.
        await a.ownership.balance()
        assert key not in a.runs()

    async def test_work_found_taken_over_is_stopped_here(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
    ) -> None:
        a, b = two
        await a.ownership.balance()
        key = sorted(a.runs())[0]
        fence = a.kind.fence(key)
        assert fence is not None

        a.kind.lost(fence)
        await a.ownership.balance()

        assert key in a.stopped
        # Still a's by the hash and free in the table, so a claims it again
        # under a new token.
        assert key in a.runs()
        renewed = a.kind.fence(key)
        assert renewed is not None and renewed.token == fence.token + 1


class TestRendezvous:
    def test_a_process_leaving_moves_only_its_own_keys(self) -> None:
        keys = [f"k{n}" for n in range(500)]
        three = ["p1", "p2", "p3"]
        before = {key: owner_of(KIND, key, three) for key in keys}
        after = {key: owner_of(KIND, key, ["p1", "p3"]) for key in keys}

        moved = {key for key in keys if before[key] != after[key]}

        assert moved == {key for key in keys if before[key] == "p2"}

    def test_the_keys_spread_over_the_processes(self) -> None:
        keys = [f"k{n}" for n in range(600)]
        counts: dict[str, int] = {}
        for key in keys:
            owner = owner_of(KIND, key, ["p1", "p2", "p3"])
            assert owner is not None
            counts[owner] = counts.get(owner, 0) + 1

        assert set(counts) == {"p1", "p2", "p3"}
        assert min(counts.values()) > 120

    def test_no_process_owns_nothing(self) -> None:
        empty: Callable[[], list[str]] = list
        assert owner_of(KIND, "k", empty()) is None


class TestThisProcessLease:
    async def test_a_renewed_lease_is_sure_until_half_its_lifetime(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        lease = process_lease_on(session_factory)
        assert not lease.surely_held()

        await lease.renew()
        held_until = lease.held_until()
        assert lease.surely_held()
        assert held_until is not None
        assert held_until - time.monotonic() <= LEASE_TTL.total_seconds() / 2

        lease._renewed_at = time.monotonic() - LEASE_TTL.total_seconds() / 2
        assert not lease.surely_held()

    async def test_a_stopped_lease_is_not_held(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        lease = process_lease_on(session_factory)
        await lease.renew()

        await lease.stop()

        assert not lease.surely_held()
        assert lease.held_until() is None

    async def test_work_claimed_at_boot_survives_a_slow_boot(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        everywhere: _Everywhere,
    ) -> None:
        """As `main` boots: `ownership.start()` renews and claims, then the
        rest of the boot (the quiet copies, the room reconcile under the boot
        lock) runs before the renewal loop is first scheduled."""
        p = _process(session_factory, everywhere)
        for key in KEYS:
            p.kind.want(key)
        await p.ownership.start()
        assert p.runs() == set(KEYS)

        await asyncio.sleep(4.0)
        tasks = [
            asyncio.create_task(p.lease.run()),
            asyncio.create_task(p.ownership.run()),
        ]
        try:
            # Past the half lease counted from the renewal at boot.
            await asyncio.sleep(4.5)
            assert p.stopped == []
            assert p.runs() == set(KEYS)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def test_one_slow_renewal_does_not_stop_the_work(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        everywhere: _Everywhere,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """One renewal held up for 2.6 s, as a pool checkout under load or a
        slow commit would, and nothing else wrong."""
        p = _process(session_factory, everywhere)
        for key in KEYS:
            p.kind.want(key)
        await p.ownership.start()

        store = p.lease._processes
        real_renew = store.renew
        renewals = 0

        async def renew(*args: Any, **kwargs: Any) -> None:
            nonlocal renewals
            renewals += 1
            if renewals == 1:
                await asyncio.sleep(2.6)
            await real_renew(*args, **kwargs)

        monkeypatch.setattr(store, "renew", renew)
        tasks = [
            asyncio.create_task(p.lease.run()),
            asyncio.create_task(p.ownership.run()),
        ]
        try:
            await asyncio.sleep(9.0)
            assert renewals >= 2
            assert p.stopped == []
            assert p.runs() == set(KEYS)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
