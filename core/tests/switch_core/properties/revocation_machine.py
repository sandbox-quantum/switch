"""A Hypothesis state machine for `revocation.takes-effect-everywhere`.

Two switch-core processes share one Postgres. Each has its own `SignalBus`
listening on the real `NOTIFY` channel, and its own copy of the resource
under test: a cache built on `HeldRows`, say. The resource is granted and
revoked by writing its row, as another process would, so each process hears
of the change only through the signal its trigger sends. A step checks
whether a process still acts on the resource, severs a process's listening
connection (`pg_terminate_backend`, so the signals sent meanwhile are lost),
lets it connect again, moves the clock, runs the periodic re-check, or reads
slowly across a revocation.

The bound a revoked resource must be refused within, on a process:

- at once, if the process listened on one connection from the revocation
  until now, since its signal has then been handled;
- otherwise once the TTL has passed since the revocation, the longest an
  entry read before it is kept when no signal can drop it.

What a resource is, how it is granted, revoked and checked, is a `Resource`.
One machine serves every resource; a test picks one (`machine_on`).

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
from typing import Any, ClassVar, Protocol

import hypothesis.strategies as st
from hypothesis import event
from hypothesis.errors import InvalidArgument
from hypothesis.stateful import RuleBasedStateMachine, precondition, rule
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent import held_rows
from switch_core.bridges.agent.auth import ControllerAuthError, ControllerPrincipal
from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, AgentController, ApiKey, User
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.management.auth import ManagementAuthenticator
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

# Set in the task of a slow check, so only its own read is held.
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

    async def seed(self, session_factory: SessionFactory) -> None:
        """The rows the resource needs, granted."""

    def attach(self, process: Process, session_factory: SessionFactory) -> None:
        """Build the process's copy of the resource and register its handlers
        on `process.bus`, which has not started yet. A read of the database
        it makes to answer `allowed` goes through `held_read(process, ...)`,
        so a step can hold it after it has read."""

    async def grant(self, session_factory: SessionFactory) -> None: ...

    async def revoke(self, session_factory: SessionFactory) -> None: ...

    async def allowed(self, process: Process) -> bool:
        """Whether the process acts on the resource now, through the path a
        request takes, cache and all."""


async def held_read[T](process: Process, read: Awaitable[T]) -> T:
    """`read`, held after it has read, when it is a slow check's."""
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
        # The machine's clock at the last revocation, and the processes that
        # have listened on one connection since.
        self.revoked_at: float | None = None
        self.heard: set[int] = set()
        self.barriers = 0
        self.slow: dict[int, asyncio.Task[bool]] = {}
        for number in PROCESSES:
            self.processes[number] = self._process(number)
        self.run(self._start())

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
            await process.bus.start()
        await self._until(
            lambda: all(p.resyncs == 1 for p in self.processes.values()),
            "every bus listening",
        )

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

    async def _until(self, done: Callable[[], bool], what: str) -> None:
        async def wait() -> None:
            while not done():
                await asyncio.sleep(0.005)

        try:
            await asyncio.wait_for(wait(), WAIT_SECONDS)
        except TimeoutError:
            raise AssertionError(f"waited {WAIT_SECONDS}s for {what}") from None

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
        await self.engine.dispose()

    # ── The resource ──────────────────────────────────────────────────────────

    @rule()
    def grant(self) -> None:
        self.run(self.resource.grant(self.session_factory))
        self.granted = True

    @rule()
    def revoke(self) -> None:
        self.run(self._revoke())

    async def _revoke(self) -> None:
        await self.resource.revoke(self.session_factory)
        if self.granted:
            # Revoked again, the resource was revoked all along: the bound
            # runs from the first.
            self.revoked_at = self.clock.now
        self.granted = False
        # Signals reach a listener in the order their transactions committed,
        # so once a process has handled a barrier sent after the revocation,
        # it has handled the revocation's signal too.
        self.barriers += 1
        listening = {n for n, p in self.processes.items() if p.listening}
        self.heard = listening
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
        await self._until(
            lambda: all(self.processes[n].barrier >= self.barriers for n in listening),
            "the revocation's signal to reach every listening process",
        )

    @rule(number=st.sampled_from(PROCESSES))
    def check(self, number: int) -> None:
        self._judge(number, self.run(self.resource.allowed(self.processes[number])))

    def _judge(self, number: int, allowed: bool) -> None:
        """Whether process `number` may answer `allowed` now."""
        if self.granted:
            assert allowed, f"process {number} refused a granted resource"
            return
        assert self.revoked_at is not None
        if not allowed:
            return
        assert number not in self.heard, (
            f"process {number} heard the revocation and still acts on it"
        )
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
        await self._until(lambda: not process.listening, "the severed bus to notice")
        self.heard.discard(process.number)
        note("a listening connection is severed")

    @precondition(lambda self: any(not p.listening for p in self.processes.values()))
    @rule(data=st.data())
    def reconnect(self, data: st.DataObject) -> None:
        number = data.draw(
            st.sampled_from([n for n, p in self.processes.items() if not p.listening])
        )
        process = self.processes[number]
        resyncs = process.resyncs
        process.reachable = True
        self.run(
            self._until(
                lambda: process.resyncs > resyncs, "the bus to listen and resync"
            )
        )
        note("a severed process connects again")

    @rule(seconds=st.sampled_from([TTL / 2, TTL]))
    def tick(self, seconds: float) -> None:
        self.clock.now += seconds

    @rule()
    def recheck(self) -> None:
        for process in self.processes.values():
            self.run(process.bus.recheck_all())

    # ── A read that straddles a change ────────────────────────────────────────

    @precondition(lambda self: len(self.slow) < len(PROCESSES))
    @rule(data=st.data())
    def begin_slow_check(self, data: st.DataObject) -> None:
        """A check whose read is held after it has read, so that whatever
        comes next lands between the read and what is done with it."""
        number = data.draw(
            st.sampled_from([n for n in PROCESSES if n not in self.slow])
        )
        process = self.processes[number]
        process.gate, process.gated = asyncio.Event(), asyncio.Event()
        gated = process.gated

        async def slow() -> bool:
            _SLOW.set(True)
            return await self.resource.allowed(process)

        async def begin() -> asyncio.Task[bool]:
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
            self._judge(number, task.result())
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


# ── Resources ─────────────────────────────────────────────────────────────────


class _HeldStore(AgentControllerStore):
    """The controller store, its reads held when the process says so."""

    def __init__(self, process: Process) -> None:
        super().__init__()
        self._process = process

    async def get(
        self, session: AsyncSession, tenant_id: str, controller_id: str
    ) -> Any:  # type: ignore[override]
        return await held_read(
            self._process, super().get(session, tenant_id, controller_id)
        )


class ControllerAccess:
    """A controller's access token, checked as every request checks it
    (`ManagementAuthenticator.current`), through `ControllerAuthCache`.
    Revoked by setting `revoked_at`, which `controller.auth_changed` names."""

    def __init__(self) -> None:
        self.principal: ControllerPrincipal | None = None

    async def seed(self, session_factory: SessionFactory) -> None:
        async with session_factory() as session:
            owner = User(name="owner", email="owner@example.invalid", role="user")
            session.add(owner)
            await session.flush()
            key = ApiKey(
                user_id=owner.id,
                key_hash="controller-hash",
                encrypted_key="",
                label="k",
                type="controller",
            )
            session.add(key)
            await session.flush()
            controller = await AgentControllerStore().create(
                session,
                owner_id=owner.id,
                name="box",
                description=None,
                kind="daemon",
                platform={"os": "linux", "arch": "x64", "os_version": "6"},
                version="0.1.0",
                public_key=None,
                api_key_id=key.id,
            )
            await session.commit()
        self.principal = ControllerPrincipal(
            controller_id=controller.id, owner_id=owner.id, tenant_id=TENANT_ZERO_ID
        )

    def attach(self, process: Process, session_factory: SessionFactory) -> None:
        cache = ControllerAuthCache(ttl_seconds=TTL, max_entries=10)
        cache.follow(process.bus)
        process.parts["auth"] = ManagementAuthenticator(
            session_factory=session_factory,
            controllers=_HeldStore(process),
            token_secret="unused",
            presence=ControllerPresence(on_bound=lambda _agent_id: None),
            auth_cache=cache,
        )

    async def _set_revoked(
        self, session_factory: SessionFactory, revoked: bool
    ) -> None:
        assert self.principal is not None
        async with session_factory() as session:
            await session.execute(
                update(AgentController)
                .where(AgentController.id == self.principal.controller_id)
                .values(revoked_at=text("now()") if revoked else None)
            )
            await session.commit()

    async def grant(self, session_factory: SessionFactory) -> None:
        await self._set_revoked(session_factory, False)

    async def revoke(self, session_factory: SessionFactory) -> None:
        await self._set_revoked(session_factory, True)

    async def allowed(self, process: Process) -> bool:
        assert self.principal is not None
        try:
            await process.parts["auth"].current(self.principal)
        except ControllerAuthError:
            return False
        return True
