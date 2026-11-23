"""A Hypothesis state machine over a controller's connection being taken over,
on two processes sharing Postgres (`controller.takeover-fenced`).

A controller has one connection that counts: the one it opened last. It opens
through either process, and its sockets attach through either, to that
connection or to one it opened before. Each process has its own presence, its
own management and ledger, and a signal bus on the real `NOTIFY` channel, so a
process hears of a change another made a moment later, as in production.

What is checked, against the controller's row and what the machine has done:

- An attach naming a connection older than the one the row names is refused,
  and refused as `taken_over` by a process that held it. The current one is
  never refused as `taken_over`, which is terminal for a controller: it is
  attached unless another process still has its socket, or has not yet written
  that it went.
- A socket that was taken over (its connection replaced, taken up by another
  process, or another socket attached to it on the same process) is sent
  `evicted taken_over`, and then nothing. Once its process has heard, the only
  events before the eviction are those of the pass it was in: a pass reads the
  heads after it starts, so one paused at a frame finishes, but the next pass
  ends it. A socket left waiting to be woken is evicted at once. A beat on a
  connection taken over is refused as `taken_over` once its process has heard.
- The ledger's writes land late: a flush is held after it has taken what was
  queued, while the controller opens, attaches and drops sockets, and lets go
  later. Once every process has heard and written everything, the row names the
  newest connection, held where its socket is, connected while one is attached
  and closed when none is, and no older connection as connected.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, ClassVar

import hypothesis.strategies as st
from hypothesis.stateful import RuleBasedStateMachine, precondition, rule
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.operations.agent_management import (
    disable_agent_management,
)
from switch_core.bridges.agent.protocol.controller_stream import IDLE
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID, AgentController
from switch_core.gateway.cloud_controllers import set_cloud_enrollment
from switch_core.management import controller_routes
from switch_core.management.errors import ManagementError
from switch_core.tenant_context import tenant_scope
from tests.conftest import empty_the_database
from tests.db_buffer import say
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    add_room,
    beat,
    build_harness,
    enroll_console,
    open_connection,
    open_stream,
    parse_frame,
    place_agent,
)

PROCESSES = (0, 1)
WAIT_SECONDS = 5.0
# Opens and sockets per run, so the remembered taken-over connections
# (`_SUPERSEDED_REMEMBERED`) are never forgotten within one.
MAX_OPENS = 6
MAX_SOCKETS = 8
# Why a socket going is recorded, other than the ones that end a connection.
SOCKET_GOING = ("socket_closed",)

COVERAGE: Counter[str] = Counter()
SHOULD_REACH = (
    "refused an attach to a replaced connection",
    "attached the current connection on the other process",
    "fenced a socket by a newer connection",
    "fenced a socket by another on its connection",
    "fenced a socket taken up elsewhere",
    "refused a beat on a replaced connection",
    "landed a held write late",
    "sent an event in hand before the eviction",
    "took over a socket waiting to be woken",
)


@dataclass
class Opened:
    """A connection the controller opened, and the processes that held it."""

    number: int
    connection_id: str
    generation: int
    held_by: set[int] = field(default_factory=set)


@dataclass
class Socket:
    """A stream attached to a connection on a process.

    `fence` is None while it is the controller's socket; `heard` once its
    process acts on what took it over, or `pending` until it has heard.
    `next` is the read of its next frame, started ahead as the socket's own
    pump starts it, so the stream can be left waiting to be woken."""

    number: int
    opened: Opened
    process: int
    stream: Any
    attached: bool = False
    position: int = 0
    in_hand: int | None = None
    fence: str | None = None
    why: str = ""
    next: asyncio.Task[Any] | None = None
    waiting: bool = False
    # Whether `next` had already produced its frame when the process heard.
    frame_in_hand: bool = False


class Takeovers(RuleBasedStateMachine):
    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url)
        self._let_go_wait = controller_routes.LET_GO_WAIT_SECONDS
        controller_routes.LET_GO_WAIT_SECONDS = 0.05
        self.harnesses: list[Harness] = []
        self.clients: list[Any] = []
        self.started = False
        self.opens: list[Opened] = []
        self.sockets: list[Socket] = []
        self.made = 0
        self.head = 0
        self.gates: dict[int, asyncio.Event] = {}
        self.held: dict[int, asyncio.Task[None]] = {}
        # The process holding the newest connection, as the row has it, and
        # the processes that have heard the last change to either.
        self.holder = 0
        self.caught_up: set[int] = set(PROCESSES)
        # The processes whose held flush has taken what was queued.
        self.taken: set[int] = set()
        try:
            self.run(self._set_up())
        except BaseException:
            self._release()
            raise

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(coroutine)

    async def _set_up(self) -> None:
        await empty_the_database(self.engine)
        self.session_factory = create_session_factory(self.engine)
        for number in PROCESSES:
            harness = build_harness(
                self.session_factory,
                signal_engine=lambda: create_async_engine(self.url, poolclass=NullPool),
            )
            self.harnesses.append(harness)
            self._hold_writes(number, harness)
            client = harness.client()
            await client.__aenter__()
            self.clients.append(client)
            await harness.management.lease.renew()
        for harness in self.harnesses:
            await harness.bus.start()
        self.started = True
        for harness in self.harnesses:
            await asyncio.wait_for(harness.bus.connected.wait(), WAIT_SECONDS)
        owner = await add_member(self.session_factory, "ada")
        self.controller: EnrolledController = await enroll_console(
            self.harnesses[0], self.clients[0], owner
        )
        self.agent_id = await place_agent(self.clients[0], self.controller, name="one")
        self.room_id = await add_room(self.session_factory, self.agent_id)
        await self._until(
            lambda: all(
                h.protocol.connections.controllers.is_bound(self.agent_id)
                for h in self.harnesses
            ),
            "the agent to be bound on every process",
        )

    def _hold_writes(self, number: int, harness: Harness) -> None:
        """Let a flush be held after it has taken what was queued."""
        ledger = harness.management.ledger
        gate = self.gates[number] = asyncio.Event()
        gate.set()
        write = ledger._write

        async def held(transitions: Any) -> None:
            if not gate.is_set():
                self.taken.add(number)
            await gate.wait()
            await write(transitions)

        ledger._write = held  # type: ignore[method-assign]

    def teardown(self) -> None:
        self._release()

    def _release(self) -> None:
        try:
            self.run(self._stop())
        finally:
            controller_routes.LET_GO_WAIT_SECONDS = self._let_go_wait
            disable_agent_management()
            set_cloud_enrollment(None)
            self.loop.close()
            self._scope.__exit__(None, None, None)

    async def _stop(self) -> None:
        for gate in self.gates.values():
            gate.set()
        for task in self.held.values():
            with contextlib.suppress(Exception):
                await task
        for socket in self.sockets:
            with contextlib.suppress(Exception):
                await self._close(socket)
        if self.started:
            for harness in self.harnesses:
                await harness.bus.stop()
        for client in self.clients:
            await client.__aexit__(None, None, None)
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

    async def _row(self) -> AgentController:
        async with self.session_factory() as session:
            row = await session.scalar(
                select(AgentController).where(
                    AgentController.id == self.controller.controller_id
                )
            )
        assert row is not None
        return row

    def _process_id(self, number: int) -> str:
        return self.harnesses[number].management.lease.process_id

    def _presence(self, number: int) -> Any:
        return self.harnesses[number].protocol.connections.controllers

    def _take(
        self, socket: Socket, name: str, data: dict[str, Any], *, before: bool
    ) -> bool:
        """Judge one frame of the socket's, `before` its process heard it was
        taken over or not. Returns whether it ended it."""
        if socket.fence == "heard" and not before:
            if name == "agent.event":
                assert socket.in_hand is not None and data["seq"] <= socket.in_hand, (
                    f"socket {socket.number} was sent event {data['seq']} after it "
                    f"was taken over ({socket.why}), past the pass it was in, "
                    f"which read through {socket.in_hand}"
                )
                COVERAGE["sent an event in hand before the eviction"] += 1
            else:
                assert name == "evicted", (
                    f"socket {socket.number} was sent {name} after it was taken "
                    f"over ({socket.why})"
                )
        if name == "evicted":
            assert data["code"] == "taken_over", (
                f"socket {socket.number} was evicted {data}"
            )
            assert socket.fence is not None, (
                f"socket {socket.number}, on the controller's current connection "
                f"and its only socket, was evicted as taken over"
            )
            return True
        if name == "agent.attached":
            assert data["from_seq"] <= self.head
            socket.attached = True
            socket.position = data["from_seq"]
        elif name == "agent.event":
            assert data["seq"] == socket.position + 1, (
                f"socket {socket.number} was sent event {data['seq']} after "
                f"{socket.position}"
            )
            socket.position = data["seq"]
        elif name in ("agent.detached", "agent.gap"):
            raise AssertionError(f"socket {socket.number} was sent {name}: {data}")
        return False

    async def _pump(self, socket: Socket, done: Any, what: str) -> bool:
        """Take the socket's frames until `done()` or its end. Returns whether
        it ended, having been evicted."""
        evicted = False

        async def pump() -> None:
            nonlocal evicted
            while not done():
                task = self._read_ahead(socket)
                try:
                    raw = await task
                except StopAsyncIteration:
                    assert evicted, f"socket {socket.number} ended without a frame"
                    return
                finally:
                    if task.done():
                        socket.next = None
                before = socket.frame_in_hand
                socket.frame_in_hand = False
                if raw is IDLE:
                    continue
                assert not evicted, (
                    f"socket {socket.number} was sent {raw} after its eviction"
                )
                evicted = self._take(socket, *parse_frame(raw), before=before)

        try:
            await asyncio.wait_for(pump(), WAIT_SECONDS)
        except TimeoutError:
            raise AssertionError(
                f"waited {WAIT_SECONDS}s for socket {socket.number} {what}"
            ) from None
        return evicted

    def _read_ahead(self, socket: Socket) -> asyncio.Task[Any]:
        """The read of the socket's next frame, started if it is not."""
        if socket.next is None:
            if socket.fence == "heard" and socket.in_hand is None:
                # The pass it was in when taken over goes on, reading the
                # heads as they are now; the next one ends it.
                socket.in_hand = self.head
            socket.next = asyncio.ensure_future(anext(socket.stream))
        return socket.next

    async def _close(self, socket: Socket) -> None:
        if socket.next is not None:
            socket.next.cancel()
            with contextlib.suppress(BaseException):
                await socket.next
        await socket.stream.aclose()

    def _fence(self, socket: Socket, how: str, *, heard: bool) -> None:
        if socket.fence is not None:
            return
        socket.why = how
        socket.fence = "pending"
        if heard:
            self._heard(socket)

    def _heard(self, socket: Socket) -> None:
        socket.fence = "heard"
        socket.frame_in_hand = socket.next is not None and socket.next.done()
        if socket.waiting:
            COVERAGE["took over a socket waiting to be woken"] += 1
        COVERAGE[f"fenced a socket {socket.why}"] += 1

    @staticmethod
    def _watch_waiting(socket: Socket) -> None:
        """Note while the socket's stream waits to be woken."""
        runner = socket.stream.ag_frame.f_locals["self"]
        wait = runner._wait

        async def watched() -> bool:
            socket.waiting = True
            try:
                return bool(await wait())
            finally:
                socket.waiting = False

        runner._wait = watched

    async def _hear(self) -> None:
        """Every process acts on the row: none holds a connection the row says
        another holds, or that the controller has replaced."""
        row = await self._row()

        def agree(number: int) -> bool:
            local = self._presence(number).current_connection(
                self.controller.controller_id
            )
            return local is None or (
                local.id == row.open_connection_id
                and row.open_process_id == self._process_id(number)
            )

        await self._until(
            lambda: all(agree(n) for n in PROCESSES),
            f"every process to act on the row naming {row.open_connection_id} "
            f"held by process {self._number_of(row.open_process_id)}",
        )
        for socket in self.sockets:
            if socket.fence == "pending":
                self._heard(socket)
        self.caught_up = set(PROCESSES)

    def _number_of(self, process_id: str | None) -> int | None:
        for number in PROCESSES:
            if self._process_id(number) == process_id:
                return number
        return None

    async def _let_go(self, number: int) -> None:
        task = self.held.pop(number, None)
        self.taken.discard(number)
        self.gates[number].set()
        if task is not None:
            await task
            COVERAGE["landed a held write late"] += 1

    # ── Steps ────────────────────────────────────────────────────────────────

    @rule()
    def ask(self) -> None:
        """Something addressed to the agent: its event, and each process told
        of it, as the notification listener tells them."""

        async def go() -> int:
            row = await say(
                self.session_factory,
                self.room_id,
                "hello",
                sender="@ada:test",
                sender_name="Ada",
            )
            seq = await self.harnesses[0].protocol.event_buffer.enqueue(
                TENANT_ZERO_ID,
                self.agent_id,
                self.room_id,
                AgentEvent(
                    type="message",
                    room_id=self.room_id,
                    payload=MessagePayload(
                        addressed=True,
                        sender="@ada:test",
                        sender_name="Ada",
                        message_id=row.transport_event_id,
                        body="hello",
                        timestamp=0,
                    ),
                ),
                room_seq=row.seq,
                message_key=row.transport_event_id,
            )
            self.harnesses[1].protocol.event_buffer.ring(self.agent_id, seq)
            return int(seq)

        self.head = self.run(go())

    @precondition(lambda self: len(self.opens) < MAX_OPENS)
    @rule(through=st.sampled_from(PROCESSES))
    def open(self, through: int) -> None:
        """The controller opens a connection, replacing the one it had."""

        async def go() -> None:
            opened = await open_connection(self.clients[through], self.controller)
            self.opens.append(
                Opened(
                    len(self.opens),
                    opened["connection_id"],
                    opened["generation"],
                    {through},
                )
            )

        self.run(go())
        self.holder = through
        self.caught_up = {through}
        for socket in self.sockets:
            self._fence(
                socket, "by a newer connection", heard=socket.process == through
            )

    @precondition(lambda self: self.opens and len(self.sockets) < MAX_SOCKETS)
    @rule(data=st.data(), through=st.sampled_from(PROCESSES))
    def attach(self, data: st.DataObject, through: int) -> None:
        """A socket attaches through a process, naming a connection the
        controller opened: most often its newest, sometimes an older one."""
        newest = self.opens[-1]
        opened = data.draw(
            st.one_of(st.just(newest), st.sampled_from(self.opens)), label="opened"
        )
        self.run(self._attach(opened, through))

    async def _attach(self, opened: Opened, through: int) -> None:
        row = await self._row()
        assert row.open_connection_id == self.opens[-1].connection_id
        current = opened is self.opens[-1]
        try:
            stream = await open_stream(
                self.harnesses[through],
                self.controller,
                {
                    "connection_id": opened.connection_id,
                    "generation": opened.generation,
                },
            )
        except ManagementError as error:
            code = error.body()["error"]["code"]
            if not current:
                expected = (
                    {"taken_over"}
                    if through in opened.held_by
                    else {"taken_over", "unknown_connection"}
                )
                assert code in expected, (
                    f"an attach to connection {opened.number}, replaced, through "
                    f"process {through}, which "
                    f"{'held' if through in opened.held_by else 'never held'} it, "
                    f"was refused {code}"
                )
                COVERAGE["refused an attach to a replaced connection"] += 1
                return
            assert code != "taken_over", (
                f"an attach to connection {opened.number}, the current one, was "
                f"refused as taken over"
            )
            held_here = row.open_process_id == self._process_id(through)
            not_let_go = row.connection_id == opened.connection_id and (
                row.disconnected_at is None or row.disconnect_reason not in SOCKET_GOING
            )
            assert not held_here and not_let_go, (
                f"an attach to connection {opened.number}, the current one, "
                f"through process {through}, was refused {code}, with its row "
                f"held by process {self._number_of(row.open_process_id)} and "
                f"naming {row.connection_id} gone at {row.disconnected_at} "
                f"({row.disconnect_reason})"
            )
            return
        assert current, (
            f"an attach to connection {opened.number} through process {through} "
            f"was accepted, though the controller has opened "
            f"{self.opens[-1].number} since"
        )
        if row.open_process_id != self._process_id(through):
            COVERAGE["attached the current connection on the other process"] += 1
            self.holder = through
            self.caught_up = {through}
        self.made += 1
        socket = Socket(self.made, opened, through, stream)
        self._watch_waiting(socket)
        for other in self.sockets:
            if other.opened is opened:
                if other.process == through:
                    self._fence(other, "by another on its connection", heard=True)
                else:
                    self._fence(other, "taken up elsewhere", heard=False)
        opened.held_by.add(through)
        self.sockets.append(socket)
        await self._pump(socket, lambda: socket.attached, "to attach the agent")

    @precondition(lambda self: self.sockets)
    @rule(data=st.data())
    def read(self, data: st.DataObject) -> None:
        """Read a socket: one taken over to its end, any other through every
        event asked."""
        socket = data.draw(st.sampled_from(self.sockets), label="socket")

        async def go() -> None:
            if socket.fence == "heard":
                await self._pump(socket, lambda: False, "to be evicted")
                self.sockets.remove(socket)
                return
            evicted = await self._pump(
                socket, lambda: socket.position >= self.head, "to read every event"
            )
            if evicted:
                self.sockets.remove(socket)

        self.run(go())

    @precondition(lambda self: self.sockets)
    @rule(data=st.data())
    def drop(self, data: st.DataObject) -> None:
        """A socket goes."""
        socket = data.draw(st.sampled_from(self.sockets), label="socket")
        self.sockets.remove(socket)
        self.run(self._close(socket))

    @precondition(lambda self: self.sockets)
    @rule(data=st.data())
    def idle(self, data: st.DataObject) -> None:
        """The socket's pump asks for the next frame and the stream, having
        nothing to send, waits to be woken."""
        socket = data.draw(st.sampled_from(self.sockets), label="socket")

        async def go() -> None:
            task = self._read_ahead(socket)
            await self._until(
                lambda: socket.waiting or task.done(),
                f"socket {socket.number} to wait or send",
            )

        self.run(go())

    @precondition(lambda self: self.sockets)
    @rule(data=st.data())
    def beat(self, data: st.DataObject) -> None:
        """A pong on a socket, through the process it is attached to."""
        socket = data.draw(st.sampled_from(self.sockets), label="socket")

        async def go() -> None:
            answer = await beat(
                self.harnesses[socket.process],
                self.controller,
                connection_id=socket.opened.connection_id,
                generation=socket.opened.generation,
                cursors={},
            )
            replaced = (
                socket.opened is not self.opens[-1] or self.holder != socket.process
            )
            if replaced and socket.process in self.caught_up:
                assert answer.status_code == 409, (
                    f"a beat on socket {socket.number}, whose connection was "
                    f"taken over ({socket.why}), was answered {answer.text}"
                )
                assert answer.json()["error"]["code"] == "taken_over", answer.text
                COVERAGE["refused a beat on a replaced connection"] += 1
            elif socket.fence is None and not replaced:
                assert answer.status_code == 200, (
                    f"a beat on socket {socket.number}, the controller's, was "
                    f"answered {answer.text}"
                )

        self.run(go())

    @precondition(lambda self: len(self.held) < len(PROCESSES))
    @rule(through=st.sampled_from(PROCESSES))
    def hold_a_flush(self, through: int) -> None:
        """The process's ledger takes what is queued, and its write waits."""
        if through in self.held:
            return
        ledger = self.harnesses[through].management.ledger
        if not ledger.pending:
            return
        self.gates[through].clear()

        async def go() -> None:
            self.held[through] = asyncio.ensure_future(ledger.flush_all())
            await self._until(lambda: through in self.taken, "the flush to take")

        self.run(go())

    @precondition(lambda self: self.held)
    @rule(data=st.data())
    def let_a_flush_go(self, data: st.DataObject) -> None:
        through = data.draw(st.sampled_from(sorted(self.held)), label="process")
        self.run(self._let_go(through))

    @rule(through=st.sampled_from(PROCESSES))
    def flush(self, through: int) -> None:
        async def go() -> None:
            await self._let_go(through)
            await self.harnesses[through].management.ledger.flush_all()

        self.run(go())

    @rule()
    def hear(self) -> None:
        self.run(self._hear())

    @precondition(lambda self: self.opens)
    @rule()
    def settle(self) -> None:
        """Every process hears and writes everything; then the row says what
        happened."""

        async def go() -> None:
            for _ in range(4):
                await self._hear()
                for number in PROCESSES:
                    await self._let_go(number)
                    await self.harnesses[number].management.ledger.flush_all()
            await self._hear()
            assert all(not h.management.ledger.pending for h in self.harnesses), (
                "a ledger still has writes queued"
            )
            await self._check_row()

        self.run(go())

    async def _check_row(self) -> None:
        row = await self._row()
        newest = self.opens[-1]
        assert row.open_connection_id == newest.connection_id
        live = [
            socket
            for socket in self.sockets
            if socket.fence is None and socket.opened is newest
        ]
        assert len(live) <= 1, f"the controller has {len(live)} sockets"
        if live:
            (socket,) = live
            assert (
                row.connection_id,
                row.connection_process_id,
                row.disconnected_at,
            ) == (newest.connection_id, self._process_id(socket.process), None), (
                f"connection {newest.number}'s socket is attached through process "
                f"{socket.process}, and the row names {row.connection_id} held by "
                f"process {self._number_of(row.connection_process_id)}, gone at "
                f"{row.disconnected_at} ({row.disconnect_reason})"
            )
            return
        assert row.connection_id is None or row.disconnected_at is not None, (
            f"no socket is attached, and the row names {row.connection_id} as "
            f"connected through process {self._number_of(row.connection_process_id)}"
        )
        if row.connection_id == newest.connection_id:
            assert row.disconnect_reason in SOCKET_GOING, (
                f"the current connection's socket went, and the row says "
                f"{row.disconnect_reason}"
            )


def machine_on(url: str) -> type[Takeovers]:
    return type("TakeoversOnPostgres", (Takeovers,), {"url": url})
