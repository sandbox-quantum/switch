"""A Hypothesis state machine over a controller's event stream and Postgres.

A controller starts a session when something addressed to one of its agents
reaches it, so what core owes an agent with no session is that every event
addressed to it arrives on the controller's stream: once the controller has
the agent attached, every event after the position the stream attached it at,
in the agent's own order, with none skipped and none repeated within a stream.
The machine is a controller: it asks its agents, reads frames, confirms what it
has processed, and drops its socket or its whole connection and opens again
from its confirmed position, while the stream's own passes fail now and then.

A step that reads takes exactly the events it knows are outstanding, so a
stream that fails to deliver one is a step that times out, not one that passes.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import Counter
from typing import Any, ClassVar

import hypothesis.strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.bridges.agent.operations.agent_management import (
    disable_agent_management,
)
from switch_core.bridges.agent.protocol import controller_stream
from switch_core.bridges.agent.protocol.controller_stream import IDLE
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.engine import create_session_factory
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.gateway.cloud_controllers import set_cloud_enrollment
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

AGENTS = ("one", "two")
READ_SECONDS = 5.0

# What a run should have done at least once, which the nightly run checks.
COVERAGE: Counter[str] = Counter()
SHOULD_REACH = (
    "opened a connection",
    "reopened the socket",
    "reopened the connection",
    "read a backlog",
    "retried a failed pass",
    "confirmed a position",
)


def _message(room_id: str, body: str, *, message_id: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room_id,
        payload=MessagePayload(
            addressed=True,
            sender="@ada:test",
            sender_name="Ada",
            message_id=message_id,
            body=body,
            timestamp=0,
        ),
    )


class ControllerStreams(RuleBasedStateMachine):
    """One controller with two agents in one room, on a real database."""

    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url)
        self.http_open = False
        self.stream: Any = None
        self._retry_wait = controller_stream.PASS_RETRY_FIRST_SECONDS
        controller_stream.PASS_RETRY_FIRST_SECONDS = 0.01
        try:
            self._set_up()
        except BaseException:
            self._release()
            raise

    def _set_up(self) -> None:
        self.run(empty_the_database(self.engine))
        self.session_factory = create_session_factory(self.engine)
        self.harness: Harness = build_harness(self.session_factory)
        self.http = self.harness.client()
        self.run(self.http.__aenter__())
        self.http_open = True
        self.controller: EnrolledController
        self.agents: dict[str, str] = {}
        self.run(self._seed())
        # Per agent: how many events have been asked, the position the
        # controller has processed to, and the position it last confirmed.
        self.head = {agent: 0 for agent in AGENTS}
        self.position = {agent: 0 for agent in AGENTS}
        self.confirmed = {agent: 0 for agent in AGENTS}
        self.opened: dict[str, Any] | None = None
        self.failing = 0
        self.asked = 0
        buffer = self.harness.protocol.event_buffer
        read_from = buffer.read_from

        async def read_from_or_fail(*args: object, **kwargs: object) -> object:
            if self.failing:
                self.failing -= 1
                COVERAGE["retried a failed pass"] += 1
                raise PoolTimeoutError("QueuePool limit reached, timed out")
            return await read_from(*args, **kwargs)  # type: ignore[arg-type]

        self._read_from = read_from
        self._buffer = buffer
        buffer.read_from = read_from_or_fail  # type: ignore[method-assign]

    async def _seed(self) -> None:
        owner = await add_member(self.session_factory, "ada")
        self.controller = await enroll_console(self.harness, self.http, owner)
        for name in AGENTS:
            self.agents[name] = await place_agent(self.http, self.controller, name=name)
        self.room_id = await add_room(self.session_factory, *self.agents.values())

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(coroutine)

    def teardown(self) -> None:
        self._release()

    def _release(self) -> None:
        try:
            if self.stream is not None:
                with contextlib.suppress(Exception):
                    self.run(self.stream.aclose())
            if hasattr(self, "_buffer"):
                self._buffer.read_from = self._read_from  # type: ignore[method-assign]
            if self.http_open:
                self.run(self.http.__aexit__(None, None, None))
            self.run(self.engine.dispose())
        finally:
            controller_stream.PASS_RETRY_FIRST_SECONDS = self._retry_wait
            disable_agent_management()
            set_cloud_enrollment(None)
            self.loop.close()
            self._scope.__exit__(None, None, None)

    # ── Reading ──────────────────────────────────────────────────────────────

    def _outstanding(self) -> int:
        return sum(self.head[a] - self.position[a] for a in AGENTS)

    async def _read(self, events: int) -> None:
        """Read until `events` events have arrived, taking each one as the next
        in its agent's order."""
        by_id = {agent_id: name for name, agent_id in self.agents.items()}
        taken = 0

        async def pump() -> None:
            nonlocal taken
            while taken < events:
                raw = await anext(self.stream)
                if raw is IDLE:
                    continue
                name, data = parse_frame(raw)
                if name == "agent.gap":
                    raise AssertionError(f"the stream reported a gap: {data}")
                if name != "agent.event":
                    continue
                agent = by_id[data["agent_id"]]
                assert data["seq"] == self.position[agent] + 1, (
                    f"{agent} was sent event {data['seq']} after {self.position[agent]}"
                )
                self.position[agent] = data["seq"]
                taken += 1

        try:
            await asyncio.wait_for(pump(), timeout=READ_SECONDS)
        except TimeoutError:
            raise AssertionError(
                f"{taken} of {events} events arrived in {READ_SECONDS}s; the "
                f"controller is at {self.position} of {self.head}"
            ) from None

    async def _opening(self) -> None:
        """The frames a stream opens with: its own state, then each agent
        attached where the controller last confirmed it."""
        by_id = {agent_id: name for name, agent_id in self.agents.items()}
        attached: dict[str, int] = {}

        async def pump() -> None:
            while len(attached) < len(AGENTS):
                raw = await anext(self.stream)
                if raw is IDLE:
                    continue
                name, data = parse_frame(raw)
                if name == "agent.gap":
                    raise AssertionError(f"the stream reported a gap: {data}")
                if name == "agent.attached":
                    attached[by_id[data["agent_id"]]] = data["from_seq"]

        try:
            await asyncio.wait_for(pump(), timeout=READ_SECONDS)
        except TimeoutError:
            raise AssertionError(
                f"the stream attached {sorted(attached)} of {list(AGENTS)} "
                f"in {READ_SECONDS}s"
            ) from None
        for agent, from_seq in attached.items():
            assert from_seq == self.confirmed[agent], (
                f"{agent} was attached from {from_seq}, "
                f"where {self.confirmed[agent]} was confirmed"
            )
            self.position[agent] = from_seq

    async def _close(self) -> None:
        if self.stream is not None:
            await self.stream.aclose()
            self.stream = None

    # ── Steps ────────────────────────────────────────────────────────────────

    @rule(agent=st.sampled_from(AGENTS))
    def ask(self, agent: str) -> None:
        """A person addresses the agent: the row in the room's log, and the
        agent's own event for it."""
        self.asked += 1
        body = f"#{self.asked}"

        async def go() -> int:
            row = await say(
                self.session_factory,
                self.room_id,
                body,
                sender="@ada:test",
                sender_name="Ada",
            )
            return await self.harness.protocol.event_buffer.enqueue(
                TENANT_ZERO_ID,
                self.agents[agent],
                self.room_id,
                _message(self.room_id, body, message_id=row.transport_event_id),
                room_seq=row.seq,
                message_key=row.transport_event_id,
            )

        self.head[agent] = self.run(go())

    @precondition(lambda self: self.opened is None)
    @rule()
    def open_connection(self) -> None:
        """The controller's first connection and stream. An agent it has no
        position for is attached at its head, so what was asked before that is
        not the stream's to deliver."""

        async def go() -> None:
            self.opened = await open_connection(self.http, self.controller)
            self.stream = await open_stream(self.harness, self.controller, self.opened)
            for agent in AGENTS:
                self.confirmed[agent] = self.head[agent]
            await self._opening()

        self.run(go())
        COVERAGE["opened a connection"] += 1

    @precondition(lambda self: self.opened is not None)
    @rule(count=st.integers(min_value=1, max_value=4))
    def read(self, count: int) -> None:
        count = min(count, self._outstanding())
        if count:
            self.run(self._read(count))

    @precondition(lambda self: self.opened is not None)
    @rule()
    def drain(self) -> None:
        """Everything asked reaches the controller: the model's liveness."""
        backlog = self._outstanding()
        if backlog > 1:
            COVERAGE["read a backlog"] += 1
        if backlog:
            self.run(self._read(backlog))
        assert self.position == self.head

    @precondition(lambda self: self.opened is not None)
    @rule()
    def confirm(self) -> None:
        """The controller reports what it has processed, as a pong does."""

        async def go() -> None:
            assert self.opened is not None
            answer = await beat(
                self.harness,
                self.controller,
                connection_id=self.opened["connection_id"],
                generation=self.opened["generation"],
                cursors={self.agents[a]: self.position[a] for a in AGENTS},
            )
            assert answer.status_code == 200, answer.text

        self.run(go())
        self.confirmed = dict(self.position)
        COVERAGE["confirmed a position"] += 1

    @precondition(lambda self: self.opened is not None)
    @rule()
    def reopen_socket(self) -> None:
        """The socket drops and the same connection is streamed again. What the
        controller processed past its last confirmation arrives a second time."""

        async def go() -> None:
            assert self.opened is not None
            await self._close()
            self.stream = await open_stream(self.harness, self.controller, self.opened)
            await self._opening()

        self.run(go())
        COVERAGE["reopened the socket"] += 1

    @precondition(lambda self: self.opened is not None)
    @rule()
    def reopen_connection(self) -> None:
        """The controller starts again and opens a new connection from the
        positions it holds, which are the ones it last confirmed."""

        async def go() -> None:
            await self._close()
            self.opened = await open_connection(
                self.http,
                self.controller,
                {self.agents[a]: self.confirmed[a] for a in AGENTS},
            )
            self.stream = await open_stream(self.harness, self.controller, self.opened)
            await self._opening()

        self.run(go())
        COVERAGE["reopened the connection"] += 1

    @precondition(lambda self: self.opened is not None)
    @rule(times=st.integers(min_value=1, max_value=2))
    def fail_a_pass(self, times: int) -> None:
        """The next reads of the buffer fail as a pool with no connection to
        give does; the stream tries again rather than ending."""
        self.failing = times

    # ── Invariants ───────────────────────────────────────────────────────────

    @invariant()
    def nothing_is_ahead_of_what_was_asked(self) -> None:
        for agent in AGENTS:
            assert self.position[agent] <= self.head[agent], (
                f"{agent} was sent event {self.position[agent]} of {self.head[agent]}"
            )
            assert self.confirmed[agent] <= self.head[agent]


def machine_on(url: str) -> type[ControllerStreams]:
    """The machine against the database at `url`."""
    return type("ControllerStreamsOnPostgres", (ControllerStreams,), {"url": url})
