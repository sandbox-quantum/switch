"""A Hypothesis state machine over the real ownership code and Postgres.

It does what `properties/specs/ownership.qnt` models: two processes, each with
its own `ProcessLease` and `Ownership`, on one database, wanting one key. A step
renews a lease, balances, shuts a process down, crashes it, stalls it, resumes
it, writes under its fence, or lets time pass.

Time is moved without sleeping, and the two clocks apart. A process's own clock
is the monotonic clock `ProcessLease` is given, and `tick` advances each by a
different amount: one slow, one fast, down to half the rate the lease is sound
for. The database's clock cannot be set, so it is moved the other way: every
process lease's beat is made older, which is all `now() - beat_at` reads.

As in the model, a running process whose lease stops being sure has its timer
fire at once (`Ownership.run` wakes it at that moment), unless it is stalled,
and it does not renew before it has. A stalled process is the one that misses
its deadline; what keeps it from doing harm is the fence, which `write` uses.

`balance_alone` reaches `OwnedKind._balance` itself, to give it a stale view.

What is not here: the wake-up signals, the loop that calls `balance`, and a
renewal that is sent and lands later (`renew` is the two together).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, ClassVar

import hypothesis.strategies as st
from hypothesis import event
from hypothesis.errors import InvalidArgument
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, OwnershipLease
from switch_core.db.stores.delivery_cursor_store import (
    CursorAdvance,
    DeliveryCursorStore,
)
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.ownership import Fence, OwnedKind, Ownership
from switch_core.process_identity import new_process_id
from switch_core.process_lease import LEASE_TTL, ProcessLease
from switch_core.signals import SignalBus
from switch_core.tenant_context import tenant_scope
from tests.conftest import TEST_KEYRING, empty_the_database
from tests.routing import make_person, make_room

KIND = "client"
KEY = "the-key"
PROCESSES = (1, 2)

# The model's unit of time: a quarter of the lease. The database's clock moves
# two a tick, and a process's own by one to three.
UNIT = LEASE_TTL.total_seconds() / 4

COVERAGE: Counter[str] = Counter()

# What a run has to reach for the invariants to have been tried on anything.
SHOULD_REACH = (
    "a process claims the key",
    "a write is accepted",
    "a holder's lease lapses and another process takes the key",
    "a stalled holder that was taken over is refused",
)


def note(what: str) -> None:
    COVERAGE[what] += 1
    with contextlib.suppress(InvalidArgument):
        event(what)


def _never_listening() -> Any:
    raise AssertionError("these processes' signal buses are never started")


@dataclass
class Process:
    number: int
    lease: ProcessLease
    ownership: Ownership
    kind: OwnedKind
    stalled: bool = False
    crashed: bool = False
    # The fences this process started work under and has not stopped.
    running: dict[str, Fence] = field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.lease.process_id

    @property
    def live(self) -> bool:
        return not self.crashed and not self.stalled

    def active(self) -> bool:
        """Running the key and still sure of its lease by its own clock."""
        return bool(self.running) and self.lease.surely_held()


class Ownerships(RuleBasedStateMachine):
    """The processes, leases and key of `ownership.qnt` on a real database."""

    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url)
        try:
            self._set_up()
        except BaseException:
            self._release()
            raise

    def _set_up(self) -> None:
        self.run(empty_the_database(self.engine))
        self.session_factory = create_session_factory(self.engine)
        self.clocks: dict[int, float] = {n: 1000.0 for n in PROCESSES}
        self.processes: dict[int, Process] = {n: self._process(n) for n in PROCESSES}
        self.run(self._seed())
        # The tokens of every fence started, in order, and of every write
        # accepted: the model's `token` and `writes`.
        self.fenced: list[int] = []
        self.accepted: list[int] = []
        self.next_seq = 1

    def _process(self, number: int) -> Process:
        lease = ProcessLease(
            process_id=new_process_id("machine"),
            session_factory=self.session_factory,
            processes=SwitchCoreProcessStore(),
            key_ids=[key.id for key in TEST_KEYRING.keys],
            monotonic=lambda: self.clocks[number],
        )
        ownership = Ownership(
            lease=lease,
            session_factory=self.session_factory,
            bus=SignalBus(
                self.session_factory, _never_listening, process_id=lease.process_id
            ),
            store=OwnershipLeaseStore(),
            processes=SwitchCoreProcessStore(),
        )
        holder: dict[str, Process] = {}

        async def start(key: str, fence: Fence) -> None:
            process = holder["p"]
            process.running[key] = fence
            self.fenced.append(fence.token)
            note("a process claims the key")

        async def stop(key: str) -> None:
            holder["p"].running.pop(key, None)

        kind = ownership.kind(KIND, start=start, stop=stop)
        kind.want(KEY)
        holder["p"] = Process(number, lease, ownership, kind)
        return holder["p"]

    async def _seed(self) -> None:
        """A client in a room, for the fenced write to move the cursor of."""
        room = await make_room(self.session_factory, "room")
        client = await make_person(self.session_factory, "client")
        self.client_id = client.id
        self.room_id = room.id
        async with self.session_factory() as session:
            await RoomStore().add_client(session, client.id, room.id)
            await session.commit()

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(coroutine)

    def teardown(self) -> None:
        self._release()

    def _release(self) -> None:
        try:
            self.run(self.engine.dispose())
        finally:
            self.loop.close()
            self._scope.__exit__(None, None, None)

    # ── Steps ─────────────────────────────────────────────────────────────────

    def _timer_pending(self, process: Process) -> bool:
        """A running process past its deadline, whose timer is about to fire."""
        return bool(process.running) and not process.lease.surely_held()

    @rule(number=st.sampled_from(PROCESSES))
    def renew(self, number: int) -> None:
        process = self.processes[number]
        if not process.live or self._timer_pending(process):
            return
        self.run(process.lease.renew())

    @rule(number=st.sampled_from(PROCESSES))
    def balance(self, number: int) -> None:
        process = self.processes[number]
        if not process.live:
            return
        claims, before = len(self.fenced), self.token()
        self.run(process.ownership.balance())
        if len(self.fenced) > claims and before > 0:
            note("a holder's lease lapses and another process takes the key")

    @rule(number=st.sampled_from(PROCESSES))
    def balance_alone(self, number: int) -> None:
        """A balance that decided from a view in which this process is the only
        one alive: the leases it read before another's renewal landed. What
        holds the key off the other then is the claim's own check of the
        holder's lease, not the process choosing correctly."""
        process = self.processes[number]
        if not process.live or not process.lease.surely_held():
            return
        claims, before = len(self.fenced), self.token()
        self.run(self._balance_alone(process))
        if len(self.fenced) > claims and before > 0:
            note("a holder's lease lapses and another process takes the key")

    async def _balance_alone(self, process: Process) -> None:
        async with process.ownership.balancing():
            await process.kind._balance([process.id])

    @rule(number=st.sampled_from(PROCESSES))
    def shutdown(self, number: int) -> None:
        process = self.processes[number]
        if not process.live:
            return
        self.run(process.ownership.stop())
        self.run(process.lease.stop())
        process.ownership.gone()
        process.crashed = True

    @rule(number=st.sampled_from(PROCESSES))
    def crash(self, number: int) -> None:
        process = self.processes[number]
        if process.crashed:
            return
        process.crashed = True
        process.running.clear()

    @rule(number=st.sampled_from(PROCESSES))
    def stall(self, number: int) -> None:
        process = self.processes[number]
        if not process.crashed:
            process.stalled = True

    @rule(number=st.sampled_from(PROCESSES))
    def resume(self, number: int) -> None:
        self.processes[number].stalled = False

    @rule(slow=st.sampled_from(PROCESSES), fast=st.sampled_from(PROCESSES))
    def tick(self, slow: int, fast: int) -> None:
        """The database's clock moves by two, each process's own by one to
        three; then every running process that is not stalled stops if its
        lease is no longer sure, as its timer would."""
        self.run(self._age_leases(2 * UNIT))
        for number in PROCESSES:
            step = 1 if number == slow else 3 if number == fast else 2
            self.clocks[number] += step * UNIT
        for process in self.processes.values():
            if process.live and self._timer_pending(process):
                self.run(process.ownership.balance())

    @rule(number=st.sampled_from(PROCESSES))
    def outlast(self, number: int) -> None:
        """Time passes while `number` is stalled until its lease has lapsed,
        the others renewing, and they balance: the takeover a stalled holder
        has to be fenced from. The same steps as above, in the one order that
        gets there, which a run of single steps seldom finds."""
        process = self.processes[number]
        others = [p for p in self.processes.values() if p is not process]
        if not process.stalled or process.crashed:
            return
        for _ in range(2):
            self.tick(slow=number, fast=others[0].number)
            for other in others:
                self.renew(other.number)
        for other in others:
            self.balance(other.number)

    @rule(number=st.sampled_from(PROCESSES))
    def write(self, number: int) -> None:
        """A cursor move under the fence the process holds, which the database
        accepts only while the key is still its under that token."""
        process = self.processes[number]
        fence = process.running.get(KEY)
        if not process.live or fence is None:
            return
        seq = self.next_seq
        self.next_seq += 1
        written = self.run(self._advance(process, fence, seq))
        if written:
            assert fence.token == self.token(), (
                f"a write under token {fence.token} was accepted while the key "
                f"is at token {self.token()}"
            )
            self.accepted.append(fence.token)
            note("a write is accepted")
        elif fence.token < self.token():
            note("a stalled holder that was taken over is refused")

    # ── What the database says ────────────────────────────────────────────────

    async def _age_leases(self, seconds: float) -> None:
        async with self.session_factory() as session:
            await session.execute(
                text(
                    "UPDATE switch_core_processes "
                    "SET beat_at = beat_at - make_interval(secs => :seconds)"
                ),
                {"seconds": seconds},
            )
            await session.commit()

    async def _advance(self, process: Process, fence: Fence, seq: int) -> bool:
        async with self.session_factory() as session:
            written = await DeliveryCursorStore().advance(
                session,
                process_id=process.id,
                advances=[
                    CursorAdvance(
                        client_id=self.client_id,
                        room_id=self.room_id,
                        seq=seq,
                        kind=fence.kind,
                        key=fence.key,
                        token=fence.token,
                    )
                ],
            )
            await session.commit()
        return bool(written)

    def token(self) -> int:
        return self.run(self._token())

    async def _token(self) -> int:
        async with self.session_factory() as session:
            return (
                await session.execute(
                    select(OwnershipLease.token).where(
                        OwnershipLease.kind == KIND, OwnershipLease.key == KEY
                    )
                )
            ).scalar_one_or_none() or 0

    # ── The model's invariants ────────────────────────────────────────────────

    @invariant()
    def no_overlap(self) -> None:
        """`NoOverlap`: at most one process is running the key and sure of its
        lease."""
        active = [p.number for p in self.processes.values() if p.active()]
        assert len(active) <= 1, (
            f"processes {active} are all running {KEY} and sure of their leases"
        )

    @invariant()
    def fenced_takeover(self) -> None:
        """`FencedTakeover`: every claim's token is above the last, and the
        tokens of the writes accepted never fall, nor pass the key's."""
        assert self.fenced == sorted(set(self.fenced)), (
            f"claims were given tokens {self.fenced}, not strictly rising"
        )
        assert self.accepted == sorted(self.accepted), (
            f"writes were accepted under tokens {self.accepted}: a holder that "
            f"was taken over still wrote"
        )
        token = self.token()
        assert all(accepted <= token for accepted in self.accepted)


def machine_on(url: str) -> type[Ownerships]:
    """The machine, on the database at `url`."""
    return type("OwnershipsOn", (Ownerships,), {"url": url})
