"""A Hypothesis state machine over who reads a connection as online, on two
processes sharing Postgres (`presence.online-iff-lease`).

A connection lives in the memory of the process holding its socket. Every
other process answers presence questions about it too, from a copy, and the
copy counts only while the holding process holds its lease: renewed within
`LEASE_TTL` and not stopped. A process that dies writes no closing, so its
lease going stale is what takes its connections offline everywhere else.

Two kinds of connection, read two ways each:

- an agent's own connection (`connection_rows.py`): the other process's
  registry copy (`is_live`), and the rows as a read of them finds them held;
- a controller's connection (`connection_ledger.py`), for an agent it runs:
  the other process's presence (`is_live`, from `held_elsewhere`), and the
  controller's state as the gateway reads it (`placement.controller_state`).

Time is the database's: a lease lapses by moving its last renewal back past
`LEASE_TTL`, so nothing sleeps. A process's lease is renewed, lapses, or is
stopped as a process shutting down stops it.

What is checked, after every step, for the process not holding the connection:

- A read of the database (the rows' `held`, the controller's state) says
  online exactly while the connection is open and its holder holds its lease.
- A copy may be out of date only until the process has caught up with what
  changed: a connection opened or closed, once its signal is heard; a lease
  that lapsed or was stopped, once the process checks the leases; anything,
  once it reads every connection again, as its periodic re-check does. After
  that, it reads online exactly when the database does.

The holding process's own view is not judged: it holds the socket, and a
socket it holds is live to it whatever its lease says.
"""

from __future__ import annotations

import asyncio
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, ClassVar

import hypothesis.strategies as st
from hypothesis.stateful import RuleBasedStateMachine, precondition, rule
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.operations.agent_management import (
    disable_agent_management,
)
from switch_core.bridges.agent.protocol.agent_connections import (
    AGENT_DELETED,
    PROTOCOL_VERSION,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.connection_rows import SharedConnections
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, AgentController, SwitchCoreProcess
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.gateway.cloud_controllers import set_cloud_enrollment
from switch_core.management.placement import controller_state
from switch_core.process_lease import LEASE_TTL, read_leases
from switch_core.tenant_context import tenant_scope
from tests.conftest import empty_the_database
from tests.db_buffer import seed_agent
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    enroll_console,
    open_connection,
    place_agent,
)

PROCESSES = (0, 1)
WAIT_SECONDS = 5.0
AGENT = "agent-own"

# What a process must do to catch up with each kind of change.
SIGNAL = "signal"
LEASE_DOWN = "lease down"
LEASE_UP = "lease up"

COVERAGE: Counter[str] = Counter()
SHOULD_REACH = (
    "agent read online elsewhere",
    "controller read online elsewhere",
    "agent copy dropped on checking the leases",
    "controller copy dropped on checking the leases",
    "agent copy stale before checking the leases",
    "controller copy stale before checking the leases",
    "agent read online again on a re-read after a renewal",
    "controller read online again on a re-read after a renewal",
    "a stopped lease read offline",
)


@dataclass
class Process:
    number: int
    harness: Harness
    shared: SharedConnections
    client: Any
    lease: str = "held"

    @property
    def registry(self) -> Any:
        return self.harness.protocol.connections

    @property
    def process_id(self) -> str:
        return self.harness.management.lease.process_id


@dataclass
class Target:
    """A connection, and what each other process still has to catch up with
    since it last changed."""

    kind: str
    holder: int | None = None
    open: bool = False
    handle: Any = None
    owed: dict[int, set[str]] = field(
        default_factory=lambda: {number: set() for number in PROCESSES}
    )

    def connected(self, holder: int) -> None:
        """A new connection: what was owed about the one before is moot, and
        every other process owes the signal of this one."""
        self.holder, self.open = holder, True
        for owed in self.owed.values():
            owed.clear()
        self.owe(SIGNAL)

    def owe(self, what: str) -> None:
        for number in PROCESSES:
            if number != self.holder:
                self.owed[number].add(what)


class LeasePresence(RuleBasedStateMachine):
    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url)
        self.processes: list[Process] = []
        self.started = False
        self.targets = {"agent": Target("agent"), "controller": Target("controller")}
        try:
            self.run(self._set_up())
        except BaseException:
            self._release()
            raise

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(self._kept(coroutine))

    async def _kept(self, coroutine: Any) -> Any:
        """Renew every lease the model holds first: the database's clock runs
        on, and a lease left unrenewed for `LEASE_TTL` lapses there whatever
        the steps say."""
        for process in self.processes:
            if process.lease == "held":
                await process.harness.management.lease.renew()
        return await coroutine

    async def _set_up(self) -> None:
        await empty_the_database(self.engine)
        self.session_factory = create_session_factory(self.engine)
        for number in PROCESSES:
            harness = build_harness(
                self.session_factory,
                signal_engine=lambda: create_async_engine(self.url, poolclass=NullPool),
            )
            shared = SharedConnections(
                registry=harness.protocol.connections,
                session_factory=self.session_factory,
                store=AgentConnectionStore(),
                bus=harness.bus,
                lease=harness.management.lease,
            )
            client = harness.client()
            await client.__aenter__()
            self.processes.append(Process(number, harness, shared, client))
            await harness.management.lease.renew()
        await seed_agent(self.session_factory, AGENT)
        owner = await add_member(self.session_factory, "ada")
        self.controller: EnrolledController = await enroll_console(
            self.processes[0].harness, self.processes[0].client, owner
        )
        self.run_by_controller = await place_agent(
            self.processes[0].client, self.controller, name="run"
        )
        for process in self.processes:
            await process.shared.start()
            await process.harness.management.load_bindings()
        for process in self.processes:
            await process.harness.bus.start()
        self.started = True
        for process in self.processes:
            await asyncio.wait_for(process.harness.bus.connected.wait(), WAIT_SECONDS)
        await self._until(
            lambda: all(
                p.registry.controllers.is_bound(self.run_by_controller)
                for p in self.processes
            ),
            "the controller's agent to be bound on every process",
        )
        # `enroll_console` connected the controller through process 0; this
        # machine connects it itself.
        presence = self.processes[0].registry.controllers
        conn = presence.current_connection(self.controller.controller_id)
        if conn is not None:
            presence.supersede(self.controller.controller_id)
            await self.processes[0].harness.management.ledger.flush_all()
        for process in self.processes:
            await process.shared.reload_all()
            await process.harness.management.service.signals.read_connections()

    def teardown(self) -> None:
        self._release()

    def _release(self) -> None:
        try:
            self.run(self._stop())
        finally:
            disable_agent_management()
            set_cloud_enrollment(None)
            self.loop.close()
            self._scope.__exit__(None, None, None)

    async def _stop(self) -> None:
        if self.started:
            for process in self.processes:
                await process.harness.bus.stop()
        for process in self.processes:
            await process.client.__aexit__(None, None, None)
        await self.engine.dispose()

    # ── Reading ──────────────────────────────────────────────────────────────

    async def _until(self, done: Any, what: str) -> None:
        async def wait() -> None:
            while not done():
                await asyncio.sleep(0.01)

        try:
            await asyncio.wait_for(wait(), WAIT_SECONDS)
        except TimeoutError:
            raise AssertionError(f"waited {WAIT_SECONDS}s for {what}") from None

    def _online(self, target: Target) -> bool:
        """Whether the connection is online: open, and its holder holding."""
        return (
            target.open
            and target.holder is not None
            and self.processes[target.holder].lease == "held"
        )

    def _copy(self, target: Target, number: int) -> bool:
        """Whether this process's copy reads the connection online."""
        registry = self.processes[number].registry
        if target.kind == "agent":
            return bool(registry.is_live(AGENT))
        return bool(registry.is_live(self.run_by_controller))

    async def _database(self, target: Target) -> bool:
        """Whether a read of the database finds the connection online."""
        async with tenant_session(self.session_factory, TENANT_ZERO_ID) as session:
            if target.kind == "agent":
                rows = await AgentConnectionStore().read_agent(
                    session,
                    AGENT,
                    # A process holding none of them, so each counts only
                    # by its holder's lease.
                    process_id="a-reader-holding-nothing",
                    lease_ttl=LEASE_TTL,
                )
                return any(
                    row.held and not row.closed for row in rows.connections.values()
                )
            controller = await session.scalar(
                select(AgentController).where(
                    AgentController.id == self.controller.controller_id
                )
            )
            assert controller is not None
            leases = await read_leases(session, SwitchCoreProcessStore())
        return controller_state(controller, leases) == "online"

    def _judge(self) -> None:
        for target in self.targets.values():
            online = self._online(target)
            found = self.run(self._database(target))
            assert found == online, (
                f"a read of the database finds the {target.kind}'s connection "
                f"{'online' if found else 'offline'}, held by process "
                f"{target.holder} whose lease is "
                f"{self._lease_of(target)}, {'open' if target.open else 'closed'}"
            )
            for number in PROCESSES:
                if number == target.holder:
                    continue
                copy = self._copy(target, number)
                if copy and number != target.holder and online:
                    COVERAGE[f"{target.kind} read online elsewhere"] += 1
                if copy == online:
                    continue
                owed = target.owed[number]
                if copy and LEASE_DOWN in owed:
                    COVERAGE[
                        f"{target.kind} copy stale before checking the leases"
                    ] += 1
                # Online wrongly only until it hears a closing or checks a
                # lease that went down; offline wrongly only until it hears
                # an opening or re-reads after a renewal.
                excuses = {SIGNAL, LEASE_DOWN} if copy else {SIGNAL, LEASE_UP}
                assert owed & excuses, (
                    f"process {number} reads the {target.kind}'s connection "
                    f"{'online' if copy else 'offline'}, held by process "
                    f"{target.holder} whose lease is {self._lease_of(target)}, "
                    f"{'open' if target.open else 'closed'}, owing "
                    f"{sorted(owed) or 'nothing'}, none of which explains it"
                )

    def _lease_of(self, target: Target) -> str:
        return "none" if target.holder is None else self.processes[target.holder].lease

    def _leases_changed(self, number: int, what: str) -> None:
        for target in self.targets.values():
            if target.open and target.holder == number:
                target.owe(what)

    # ── Steps: connections ───────────────────────────────────────────────────

    @precondition(lambda self: not self.targets["agent"].open)
    @rule(through=st.sampled_from(PROCESSES))
    def connect_agent(self, through: int) -> None:
        process = self.processes[through]
        target = self.targets["agent"]

        async def go() -> Any:
            registry = process.registry
            async with registry.slots(AGENT):
                async with registry.recorded(AGENT):
                    return registry.open(
                        agent_id=AGENT,
                        connection_id=str(uuid.uuid4()),
                        scope="single",
                        delivery_filter="addressed",
                        spawn_capable=False,
                        position={OWN_EVENTS: 0},
                        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
                        expected_generation=None,
                    )

        target.handle = self.run(go())
        target.connected(through)
        self._judge()

    @precondition(lambda self: self.targets["agent"].open)
    @rule()
    def disconnect_agent(self) -> None:
        target = self.targets["agent"]
        assert target.holder is not None
        process = self.processes[target.holder]

        async def go() -> None:
            closed = process.registry.close(target.handle.id, AGENT_DELETED)
            assert closed is not None
            await process.shared.flush()

        self.run(go())
        target.open = False
        target.owe(SIGNAL)
        self._judge()

    @precondition(lambda self: not self.targets["controller"].open)
    @rule(through=st.sampled_from(PROCESSES))
    def connect_controller(self, through: int) -> None:
        process = self.processes[through]
        target = self.targets["controller"]

        async def go() -> Any:
            await open_connection(process.client, self.controller)
            presence = process.registry.controllers
            conn = presence.current_connection(self.controller.controller_id)
            assert conn is not None
            token = presence.attach_stream(conn)
            await process.harness.management.ledger.flush_all()
            return conn, token

        target.handle = self.run(go())
        target.connected(through)
        self._judge()

    @precondition(lambda self: self.targets["controller"].open)
    @rule()
    def disconnect_controller(self) -> None:
        target = self.targets["controller"]
        assert target.holder is not None
        process = self.processes[target.holder]
        conn, token = target.handle

        async def go() -> None:
            process.registry.controllers.detach_stream(conn, token)
            await process.harness.management.ledger.flush_all()

        self.run(go())
        target.open = False
        target.owe(SIGNAL)
        self._judge()

    # ── Steps: leases ────────────────────────────────────────────────────────

    @precondition(lambda self: any(p.lease != "stopped" for p in self.processes))
    @rule(data=st.data())
    def renew(self, data: st.DataObject) -> None:
        process = data.draw(
            st.sampled_from([p for p in self.processes if p.lease != "stopped"]),
            label="process",
        )
        was = process.lease
        self.run(process.harness.management.lease.renew())
        process.lease = "held"
        if was != "held":
            self._leases_changed(process.number, LEASE_UP)
        self._judge()

    @precondition(lambda self: any(p.lease == "held" for p in self.processes))
    @rule(data=st.data())
    def lapse(self, data: st.DataObject) -> None:
        """The process stops renewing, as one that died or lost the database
        does, and its last renewal is now older than the lease lasts."""
        process = data.draw(
            st.sampled_from([p for p in self.processes if p.lease == "held"]),
            label="process",
        )

        async def go() -> None:
            async with self.session_factory() as session:
                await session.execute(
                    update(SwitchCoreProcess)
                    .where(SwitchCoreProcess.id == process.process_id)
                    .values(
                        beat_at=SwitchCoreProcess.beat_at
                        - LEASE_TTL
                        - timedelta(seconds=1)
                    )
                )
                await session.commit()

        self.run(go())
        process.lease = "lapsed"
        self._leases_changed(process.number, LEASE_DOWN)
        self._judge()

    @precondition(lambda self: sum(p.lease == "stopped" for p in self.processes) == 0)
    @rule(data=st.data())
    def stop(self, data: st.DataObject) -> None:
        """The process shuts down: its lease is marked stopped, while its
        sockets have not gone yet."""
        process = data.draw(
            st.sampled_from([p for p in self.processes if p.lease != "stopped"]),
            label="process",
        )
        was = process.lease
        self.run(process.harness.management.lease.stop())
        process.lease = "stopped"
        if was == "held":
            self._leases_changed(process.number, LEASE_DOWN)
        if any(t.open and t.holder == process.number for t in self.targets.values()):
            COVERAGE["a stopped lease read offline"] += 1
        self._judge()

    # ── Steps: catching up ───────────────────────────────────────────────────

    @rule(observer=st.sampled_from(PROCESSES))
    def check_the_leases(self, observer: int) -> None:
        """The process's lease watch (`WATCH_SECONDS`)."""
        before = {kind: self._copy(t, observer) for kind, t in self.targets.items()}
        self.run(self.processes[observer].shared.check_leases())
        for kind, target in self.targets.items():
            if target.holder == observer:
                continue
            owed = target.owed[observer]
            if LEASE_DOWN in owed:
                if before[kind] and not self._copy(target, observer):
                    COVERAGE[f"{kind} copy dropped on checking the leases"] += 1
                owed.discard(LEASE_DOWN)
        self._judge()

    @rule(observer=st.sampled_from(PROCESSES))
    def reread(self, observer: int) -> None:
        """The process's periodic re-check: every connection read again."""
        process = self.processes[observer]
        before = {kind: self._copy(t, observer) for kind, t in self.targets.items()}

        async def go() -> None:
            await process.shared.reload_all()
            await process.harness.management.service.signals.read_connections(
                check_first=True
            )

        self.run(go())
        for kind, target in self.targets.items():
            if target.holder == observer:
                continue
            owed = target.owed[observer]
            if LEASE_UP in owed and not before[kind] and self._copy(target, observer):
                COVERAGE[f"{kind} read online again on a re-read after a renewal"] += 1
            owed.clear()
        self._judge()

    @rule()
    def hear(self) -> None:
        """Every signal sent is heard: a copy owed only a signal agrees."""

        def heard() -> bool:
            return all(
                self._copy(target, number) == self._online(target)
                for target in self.targets.values()
                for number in PROCESSES
                if number != target.holder and target.owed[number] == {SIGNAL}
            )

        self.run(self._until(heard, "every process to hear the connections change"))
        for target in self.targets.values():
            for number in PROCESSES:
                if target.owed[number] == {SIGNAL}:
                    target.owed[number].clear()
        self._judge()


def machine_on(url: str) -> type[LeasePresence]:
    return type("LeasePresenceOnPostgres", (LeasePresence,), {"url": url})
