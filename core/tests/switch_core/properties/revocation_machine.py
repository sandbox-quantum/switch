"""A Hypothesis state machine for `revocation.takes-effect-everywhere`.

Two switch-core processes share one Postgres. Each has its own `SignalBus`
listening on the real `NOTIFY` channel, and its own copy of the resource
under test: a cache built on `HeldRows`, or a client's copy reading its
rooms. The resource is granted and
revoked by writing its row, as another process would, so each process hears
of the change only through the signal its trigger sends. A step checks
whether a process still acts on the resource, severs a process's listening
connection (`pg_terminate_backend`, so the signals sent meanwhile are lost),
lets it connect again, moves the clock, runs the periodic re-check, or reads
slowly across a revocation.

A process that listened on one connection from a change until now has
handled its signal, and must agree with the database at once. One that did
not depends on the resource's kind:

- `held`, a cache: a revoked resource is refused once the TTL has passed
  since the revocation, the longest an entry read before it is kept when no
  signal can drop it. A granted one is never refused, since no refusal is
  kept.
- `reread`, a copy that re-reads the database: it agrees once it has
  resynced on a new connection or run the periodic re-check since the
  change.
- `direct`, read from the database on every check: it agrees at once,
  heard or not.

What a resource is, how it is granted, revoked and checked, is a `Resource`
(`revocation_resources.py`). One machine serves every resource; a test picks
one (`machine_on`).

Time: `HeldRows` reads `time.monotonic`, which the machine replaces with a
clock of its own (`tick`). The bus's heartbeat and reconnect back-off are
shortened so that a severed connection is noticed, and a reachable database
reconnected to, within a step; its periodic re-check is pushed out of reach
and run by `recheck` instead.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, ClassVar, Literal, Protocol

import hypothesis.strategies as st
from hypothesis import event
from hypothesis.errors import InvalidArgument
from hypothesis.stateful import RuleBasedStateMachine, precondition, rule
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent import held_rows
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.process_identity import new_process_id
from switch_core.signals import SIGNAL_CHANNEL, SignalBus
from switch_core.tenant_context import tenant_scope
from tests.conftest import empty_the_database

SessionFactory = async_sessionmaker[AsyncSession]

PROCESSES = (1, 2)

# The caches' TTL, in seconds of the machine's clock.
TTL = 4.0

# How long a step may wait on the bus before the run is declared stuck.
WAIT_SECONDS = 10.0

# Where a process connects while its database is unreachable: nothing listens
# on port 1, so the connection is refused at once.
UNREACHABLE = "postgresql+asyncpg://nobody@127.0.0.1:1/nothing"

BARRIER = "machine.barrier"

# Set in the task of a slow step, so only its own read is held.
_SLOW: contextvars.ContextVar[bool] = contextvars.ContextVar("slow", default=False)

COVERAGE: Counter[str] = Counter()


def note(what: str) -> None:
    COVERAGE[what] += 1
    with contextlib.suppress(InvalidArgument):
        event(what)


class Clock:
    """The monotonic clock `HeldRows` reads, moved only by the machine."""

    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now


@dataclass
class Process:
    """One switch-core process: its bus, and whatever the resource keeps."""

    number: int
    bus: SignalBus
    # False while its database is unreachable: the bus's next connection is
    # refused.
    reachable: bool = True
    # The last barrier its bus has handled, and how many resyncs have run
    # to the end.
    barrier: int = 0
    resyncs: int = 0
    # The resource's own objects for this process (`Resource.attach`).
    parts: dict[str, Any] = field(default_factory=dict)
    # A read held after it read, until released (`Resource.held_read`).
    gate: asyncio.Event | None = None
    gated: asyncio.Event | None = None

    @property
    def listening(self) -> bool:
        return self.bus.connected.is_set()


class Resource(Protocol):
    """Something revoked, as one process and every other see it."""

    kind: ClassVar[Literal["held", "reread", "direct"]]

    async def seed(self, session_factory: SessionFactory) -> None:
        """The rows the resource needs, granted."""

    def attach(self, process: Process, session_factory: SessionFactory) -> None:
        """Build the process's copy of the resource and register its handlers
        on `process.bus`, which has not started yet. A read of the database it
        makes goes through `held_read(process, ...)`, so a slow step can hold
        it after it has read."""

    async def start(self, process: Process) -> None:
        """Start what the process runs for the resource, before its bus."""

    async def stop(self, process: Process) -> None: ...

    async def settled(self, process: Process) -> None:
        """Return once the work a signal, resync or re-check handed the
        process has finished."""

    async def grant(self, session_factory: SessionFactory) -> None: ...

    async def revoke(self, session_factory: SessionFactory) -> None: ...

    async def allowed(self, process: Process) -> bool:
        """Whether the process acts on the resource now, through the path a
        request takes, cache and all."""

    async def slow(self, process: Process) -> bool | None:
        """What a slow step runs: a check or a re-read. An answer given from
        memory, without reading, is judged like any check. One given after a
        held read is not: it is what the database said when the read began,
        and the checks after it judge what the read left behind."""


async def until(done: Callable[[], bool], what: str) -> None:
    """Return once `done()`, or fail after `WAIT_SECONDS`."""

    async def wait() -> None:
        while not done():
            await asyncio.sleep(0.005)

    try:
        await asyncio.wait_for(wait(), WAIT_SECONDS)
    except TimeoutError:
        raise AssertionError(f"waited {WAIT_SECONDS}s for {what}") from None


async def held_read[T](process: Process, read: Awaitable[T]) -> T:
    """`read`, held after it has read, when it is a slow step's."""
    found = await read
    if _SLOW.get() and process.gate is not None and not process.gate.is_set():
        assert process.gated is not None
        process.gated.set()
        await process.gate.wait()
    return found


class Revocations(RuleBasedStateMachine):
    """The resource, granted and revoked under the processes' feet."""

    url: ClassVar[str]
    resource_type: ClassVar[Callable[[], Resource]]
    clock: ClassVar[Clock]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url)
        self.processes: dict[int, Process] = {}
        try:
            self._set_up()
        except BaseException:
            self._release()
            raise

    def _set_up(self) -> None:
        self.run(empty_the_database(self.engine))
        self.session_factory = create_session_factory(self.engine)
        self.resource = self.resource_type()
        self.run(self.resource.seed(self.session_factory))
        self.granted = True
        # The machine's clock when the resource was last revoked; the
        # processes that have listened on one connection since the last
        # change, and those that have resynced or re-checked since.
        self.revoked_at: float | None = None
        self.heard: set[int] = set()
        self.caught_up: set[int] = set()
        # Processes that were listening at the last change but held in a slow
        # re-read: they hear it once the held re-read lets their work run.
        self.hearing: set[int] = set()
        self.barriers = 0
        self.slow: dict[int, asyncio.Task[bool | None]] = {}
        for number in PROCESSES:
            self.processes[number] = self._process(number)
        self.run(self._start())
        # Every process has listened, resynced and settled: each agrees with
        # the database from the start.
        self.heard = {n for n, p in self.processes.items() if p.listening}
        self.caught_up = set(self.processes)

    def _process(self, number: int) -> Process:
        holder: dict[str, Process] = {}

        def engine() -> Any:
            if not holder["p"].reachable:
                return create_async_engine(UNREACHABLE, poolclass=NullPool)
            return create_async_engine(
                self.url,
                poolclass=NullPool,
                connect_args={
                    "server_settings": {"application_name": self._listener(number)}
                },
            )

        bus = SignalBus(self.session_factory, engine, process_id=new_process_id("m"))
        process = holder["p"] = Process(number, bus)
        self.resource.attach(process, self.session_factory)

        def barrier(signal: dict[str, Any]) -> None:
            process.barrier = max(process.barrier, signal["n"])

        async def resynced() -> None:
            process.resyncs += 1

        bus.handle(BARRIER, barrier)
        # Last, so it counts a resync once every family's has run.
        bus.on_resync(resynced)
        return process

    def _listener(self, number: int) -> str:
        return f"revocation-machine-{number}"

    async def _start(self) -> None:
        for process in self.processes.values():
            await self.resource.start(process)
        for process in self.processes.values():
            await process.bus.start()
        await until(
            lambda: all(p.resyncs == 1 for p in self.processes.values()),
            "every bus listening",
        )
        for process in self.processes.values():
            await self.resource.settled(process)

    def run(self, coroutine: Any) -> Any:
        """Run a step's coroutine, failing it rather than waiting forever."""

        async def bounded() -> Any:
            try:
                return await asyncio.wait_for(coroutine, WAIT_SECONDS * 2)
            except TimeoutError:
                raise AssertionError(
                    f"a step took more than {WAIT_SECONDS * 2}s"
                ) from None

        return self.loop.run_until_complete(bounded())

    def teardown(self) -> None:
        self._release()

    def _release(self) -> None:
        try:
            for process in self.processes.values():
                if process.gate is not None:
                    process.gate.set()
            self.run(self._stop())
        finally:
            self.loop.close()
            self._scope.__exit__(None, None, None)

    async def _stop(self) -> None:
        for task in self.slow.values():
            task.cancel()
        await asyncio.gather(*self.slow.values(), return_exceptions=True)
        for process in self.processes.values():
            await process.bus.stop()
            await self.resource.stop(process)
        await self.engine.dispose()

    # ── The resource ──────────────────────────────────────────────────────────

    @rule()
    def grant(self) -> None:
        self.run(self._change(granted=True))
        self._check_all()

    @rule()
    def revoke(self) -> None:
        self.run(self._change(granted=False))
        self._check_all()

    def _check_all(self) -> None:
        """Check every process a change can be checked on, as requests
        arriving at both would: what they read is in memory for the next
        change to make stale."""
        for number in PROCESSES:
            if not self._blocked(number):
                self.check(number)

    def _blocked(self, number: int) -> bool:
        """Whether a re-read held on the process keeps the work a signal
        hands it from running: it waits for the held one."""
        return self.resource.kind == "reread" and number in self.slow

    async def _change(self, *, granted: bool) -> None:
        if granted:
            await self.resource.grant(self.session_factory)
        else:
            await self.resource.revoke(self.session_factory)
        listening = {
            n for n, p in self.processes.items() if p.listening and not self._blocked(n)
        }
        # Changed again to what it was, nothing changes: the bound runs from
        # the first, and a write that changed no row may send no signal.
        if granted != self.granted:
            self.heard, self.caught_up = listening, set()
            self.hearing = {
                n for n, p in self.processes.items() if p.listening and self._blocked(n)
            }
            if not granted:
                self.revoked_at = self.clock.now
        self.granted = granted
        # Signals reach a listener in the order their transactions committed,
        # so once a process has handled a barrier sent after the change, it
        # has handled the change's signal too.
        self.barriers += 1
        async with self.session_factory() as session:
            await session.execute(
                text("SELECT pg_notify(:channel, :payload)"),
                {
                    "channel": SIGNAL_CHANNEL,
                    "payload": json.dumps(
                        {"kind": BARRIER, "from": "machine", "n": self.barriers}
                    ),
                },
            )
            await session.commit()
        await until(
            lambda: all(self.processes[n].barrier >= self.barriers for n in listening),
            "the change's signal to reach every listening process",
        )
        for number in listening:
            await self.resource.settled(self.processes[number])

    @rule(number=st.sampled_from(PROCESSES))
    def check(self, number: int) -> None:
        self._judge(number, self.run(self.resource.allowed(self.processes[number])))

    def _judge(self, number: int, allowed: bool) -> None:
        """Whether process `number` may answer `allowed` now."""
        if allowed == self.granted:
            return
        doing = "acts on a revoked" if allowed else "refuses a granted"
        assert self.resource.kind != "direct", (
            f"process {number} {doing} resource it reads on every check"
        )
        assert number not in self.heard, (
            f"process {number} heard the change and still {doing} resource"
        )
        if self.resource.kind == "reread":
            assert number not in self.caught_up, (
                f"process {number} re-read since the change and still {doing} resource"
            )
            note("a process that missed the change is behind until it re-reads")
            return
        assert allowed, f"process {number} refuses a granted resource"
        assert self.revoked_at is not None
        assert self.clock.now < self.revoked_at + TTL, (
            f"process {number} acts on a resource revoked "
            f"{self.clock.now - self.revoked_at:.1f}s ago, past the TTL of {TTL}s"
        )
        note("a process that missed the revocation acts on it within the TTL")

    # ── The bus ───────────────────────────────────────────────────────────────

    @precondition(lambda self: any(p.listening for p in self.processes.values()))
    @rule(data=st.data())
    def sever(self, data: st.DataObject) -> None:
        number = data.draw(
            st.sampled_from([n for n, p in self.processes.items() if p.listening])
        )
        self.run(self._sever(self.processes[number]))

    async def _sever(self, process: Process) -> None:
        process.reachable = False
        async with self.session_factory() as session:
            terminated = (
                await session.execute(
                    text(
                        "SELECT count(*) FROM ("
                        " SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
                        " WHERE application_name = :name) AS t"
                    ),
                    {"name": self._listener(process.number)},
                )
            ).scalar_one()
        assert terminated == 1, f"found {terminated} listeners to sever"
        await until(lambda: not process.listening, "the severed bus to notice")
        self.heard.discard(process.number)
        self.hearing.discard(process.number)
        note("a listening connection is severed")

    def _reconnectable(self) -> list[int]:
        return [
            n
            for n, p in self.processes.items()
            if not p.listening and not self._blocked(n)
        ]

    @precondition(lambda self: bool(self._reconnectable()))
    @rule(data=st.data())
    def reconnect(self, data: st.DataObject) -> None:
        number = data.draw(st.sampled_from(self._reconnectable()))
        process = self.processes[number]
        resyncs = process.resyncs
        process.reachable = True
        self.run(until(lambda: process.resyncs > resyncs, "the bus to resync"))
        self.run(self.resource.settled(process))
        self.caught_up.add(number)
        note("a severed process connects again")

    @rule(seconds=st.sampled_from([TTL / 2, TTL]))
    def tick(self, seconds: float) -> None:
        self.clock.now += seconds

    @rule()
    def recheck(self) -> None:
        for number, process in self.processes.items():
            if self._blocked(number):
                continue
            self.run(process.bus.recheck_all())
            self.run(self.resource.settled(process))
            self.caught_up.add(number)

    # ── A read that straddles a change ────────────────────────────────────────

    @precondition(lambda self: len(self.slow) < len(PROCESSES))
    @rule(data=st.data())
    def begin_slow_check(self, data: st.DataObject) -> None:
        """A check or re-read whose read is held after it has read, so that
        whatever comes next lands between the read and what is done with
        it."""
        number = data.draw(
            st.sampled_from([n for n in PROCESSES if n not in self.slow])
        )
        process = self.processes[number]
        process.gate, process.gated = asyncio.Event(), asyncio.Event()
        gated = process.gated

        async def slow() -> bool | None:
            _SLOW.set(True)
            return await self.resource.slow(process)

        async def begin() -> asyncio.Task[bool | None]:
            task = asyncio.create_task(slow())
            done, _ = await asyncio.wait(
                [task, asyncio.create_task(gated.wait())],
                timeout=WAIT_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
            assert done, "the slow check neither read nor finished"
            return task

        task = self.run(begin())
        if task.done():
            # Answered from memory, without reading: a check like any other.
            process.gate = process.gated = None
            answer = task.result()
            if answer is not None:
                self._judge(number, answer)
            return
        self.slow[number] = task

    @precondition(lambda self: bool(self.slow))
    @rule(data=st.data())
    def finish_slow_check(self, data: st.DataObject) -> None:
        number = data.draw(st.sampled_from(sorted(self.slow)))
        process = self.processes[number]
        task = self.slow.pop(number)
        assert process.gate is not None
        process.gate.set()
        self.run(asyncio.wait_for(task, WAIT_SECONDS))
        process.gate = process.gated = None
        # What the held read kept waiting runs now, the change's signal work
        # among it if the process was listening when it was made.
        self.run(self.resource.settled(process))
        if number in self.hearing and process.listening:
            self.hearing.discard(number)
            self.heard.add(number)
        note("a read straddled other steps")


def machine_on(
    url: str, resource: Callable[[], Resource], clock: Clock
) -> type[Revocations]:
    """The machine for `resource`, on the database at `url`, with `clock` in
    place of the one `HeldRows` reads."""
    return type(
        "RevocationsOn",
        (Revocations,),
        {"url": url, "resource_type": staticmethod(resource), "clock": clock},
    )


def held_rows_clock(clock: Clock) -> SimpleNamespace:
    """What `held_rows.time` is replaced with."""
    return SimpleNamespace(monotonic=clock.monotonic)


HELD_ROWS_MODULE = held_rows
