"""A Hypothesis state machine over a controller's event stream and Postgres.

A controller starts a session when something addressed to one of its agents
reaches it, so what core owes an agent with no session is that every event
addressed to it arrives on the controller's stream: once the controller has
the agent attached, every event after the position the stream attached it at,
in the agent's own order, with none skipped and none repeated within a stream.
The machine is a controller: it asks its agents, reads frames, confirms what it
has processed, and drops its socket or its whole connection and opens again
from its confirmed position, while the stream's own passes fail now and then.

It also changes what the stream carries while it is open
(`controller.stream-complete`). An agent moved to another controller is
detached, and gets nothing more; one moved back is attached at its head, so
nothing it had, nor anything said while it was away, is sent again.
Retention deletes an agent's events, and a reader below what it deleted, on
the open stream or attaching on a new one, is told an `agent.gap` naming the
room and resumes just past the deletion.

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
from tests.db_buffer import age_events, say
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    add_room,
    beat,
    build_harness,
    cookies_for,
    enroll_console,
    open_connection,
    open_stream,
    parse_frame,
    place_agent,
    provider,
    report_status,
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
# What `controller.stream-complete` adds.
CHANGES_SHOULD_REACH = (
    "detached an agent mid-stream",
    "attached an agent mid-stream",
    "told a gap mid-stream",
    "told a gap on attaching",
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
        # controller has processed to, and the position it last confirmed
        # (None for one it holds no position for: never attached, or detached
        # since).
        self.head = {agent: 0 for agent in AGENTS}
        self.position = {agent: 0 for agent in AGENTS}
        self.confirmed: dict[str, int | None] = {agent: 0 for agent in AGENTS}
        # Whether the agent is placed on this controller, whether the open
        # stream has it attached, the number retention has deleted its events
        # through, and, after an attach that found its cursor deleted, the
        # cursor the gap that follows must name.
        self.bound = {agent: True for agent in AGENTS}
        self.attached = {agent: False for agent in AGENTS}
        self.expired = {agent: 0 for agent in AGENTS}
        self.gap_owed: dict[str, int | None] = {agent: None for agent in AGENTS}
        # The heads when the stream last ran, so the most it can have read;
        # and, per agent, the events retention deleted after the stream may
        # already have read them, which it may still send before its gap.
        self.ran_through = {agent: 0 for agent in AGENTS}
        self.read_before_expiry = {agent: 0 for agent in AGENTS}
        self.opened: dict[str, Any] | None = None
        # Every event the machine has read.
        self.taken = 0
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
        self.owner = owner
        self.controller = await enroll_console(self.harness, self.http, owner)
        # Where an agent moved away is placed.
        self.elsewhere = await enroll_console(self.harness, self.http, owner, "two")
        await report_status(
            self.http, self.elsewhere, 1, providers=[provider("claude")]
        )
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

    def _owed(self, agent: str) -> int:
        """The events the open stream still owes the agent: those after where
        it is, or after what retention deleted, whichever is later."""
        if not self.attached[agent]:
            return 0
        return self.head[agent] - max(self.position[agent], self.expired[agent])

    def _outstanding(self) -> int:
        return sum(self._owed(agent) for agent in AGENTS)

    def _take(self, name: str, data: dict[str, Any]) -> int:
        """Judge one frame against the model and apply it. Returns how many
        events it carried."""
        by_id = {agent_id: n for n, agent_id in self.agents.items()}
        agent = by_id.get(data.get("agent_id", ""), "")
        if name == "agent.attached":
            assert self.bound[agent], (
                f"{agent} was attached, but it is placed elsewhere"
            )
            assert not self.attached[agent], f"{agent} was attached twice"
            held = self.confirmed[agent]
            cursor = self.head[agent] if held is None else held
            if cursor < self.expired[agent]:
                # Retention deleted what follows the cursor: attached past the
                # deletion, with a gap to follow.
                assert data["from_seq"] == self.expired[agent], (
                    f"{agent} was attached from {data['from_seq']} below what "
                    f"retention deleted, through {self.expired[agent]}"
                )
                self.gap_owed[agent] = cursor
            else:
                assert data["from_seq"] == cursor, (
                    f"{agent} was attached from {data['from_seq']}, where "
                    f"{cursor} was {'its head' if held is None else 'confirmed'}"
                )
            self.attached[agent] = True
            self.position[agent] = data["from_seq"]
            self.confirmed[agent] = data["from_seq"]
            return 0
        if name == "agent.detached":
            assert self.attached[agent], f"{agent} was detached, but not attached"
            assert not self.bound[agent], f"{agent} was detached while placed here"
            assert self.gap_owed[agent] is None, f"{agent} was detached before its gap"
            self.attached[agent] = False
            self.confirmed[agent] = None
            self.read_before_expiry[agent] = 0
            return 0
        if name == "agent.gap":
            assert self.attached[agent], f"{agent} was told a gap, but not attached"
            assert data["rooms"] == [self.room_id] and data["all_rooms"] is False, (
                f"{agent}'s gap names {data['rooms']}, not the room it lost events in"
            )
            owed = self.gap_owed[agent]
            if owed is not None:
                assert (data["from_sequence"], data["resumed_at"]) == (
                    owed,
                    self.position[agent],
                ), f"{agent}'s gap on attaching is {data}"
                self.gap_owed[agent] = None
                COVERAGE["told a gap on attaching"] += 1
                return 0
            assert self.position[agent] < self.expired[agent], (
                f"{agent} was told a gap at {self.position[agent]}, past what "
                f"retention deleted, through {self.expired[agent]}"
            )
            assert (data["from_sequence"], data["resumed_at"]) == (
                self.position[agent],
                self.expired[agent],
            ), f"{agent}'s gap is {data}"
            self.position[agent] = data["resumed_at"]
            COVERAGE["told a gap mid-stream"] += 1
            return 0
        if name == "agent.event":
            assert self.attached[agent], f"{agent} was sent an event, but not attached"
            assert self.gap_owed[agent] is None, (
                f"{agent} was sent an event before the gap its attach owed"
            )
            assert data["seq"] == self.position[agent] + 1, (
                f"{agent} was sent event {data['seq']} after {self.position[agent]}"
            )
            deleted = data["seq"] <= self.expired[agent]
            assert not deleted or data["seq"] <= self.read_before_expiry[agent], (
                f"{agent} was sent event {data['seq']}, which retention deleted "
                f"before the stream could read it"
            )
            self.position[agent] = data["seq"]
            if deleted:
                # Not one the steps count as owed.
                COVERAGE["sent an event read before retention"] += 1
                return 0
            return 1
        return 0

    async def _pump(self, done: Any, what: str) -> None:
        """Take frames until `done()`, judging each."""

        self.ran_through = dict(self.head)

        async def pump() -> None:
            while not done():
                raw = await anext(self.stream)
                if raw is IDLE:
                    continue
                self.taken += self._take(*parse_frame(raw))

        try:
            await asyncio.wait_for(pump(), timeout=READ_SECONDS)
        except TimeoutError:
            raise AssertionError(
                f"waited {READ_SECONDS}s for {what}; the controller is at "
                f"{self.position} of {self.head}, attached {self.attached}"
            ) from None

    async def _read(self, events: int) -> None:
        """Read until `events` more events have arrived."""
        target = self.taken + events
        await self._pump(lambda: self.taken >= target, f"{events} events")

    async def _opening(self) -> None:
        """The frames a stream opens with: its own state, then each agent
        placed here attached where the controller last confirmed it, and the
        gap of each whose confirmed position retention passed."""
        for agent in AGENTS:
            self.attached[agent] = False
            self.gap_owed[agent] = None
        await self._pump(
            lambda: all(
                self.attached[a] and self.gap_owed[a] is None
                for a in AGENTS
                if self.bound[a]
            ),
            "the stream to attach every agent placed here",
        )

    async def _close(self) -> None:
        if self.stream is not None:
            await self.stream.aclose()
            self.stream = None
        for agent in AGENTS:
            self.attached[agent] = False
            self.read_before_expiry[agent] = 0

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
                self.confirmed[agent] = None
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
        for agent in AGENTS:
            if self.attached[agent]:
                # Or below what retention deleted with nothing after it, whose
                # gap comes with the next event or attach.
                assert (
                    max(self.position[agent], self.expired[agent]) == self.head[agent]
                )

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
                cursors={
                    self.agents[a]: self.position[a] for a in AGENTS if self.attached[a]
                },
            )
            assert answer.status_code == 200, answer.text

        self.run(go())
        for agent in AGENTS:
            if self.attached[agent]:
                self.confirmed[agent] = self.position[agent]
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
                {
                    self.agents[a]: held
                    for a in AGENTS
                    if (held := self.confirmed[a]) is not None
                },
            )
            self.stream = await open_stream(self.harness, self.controller, self.opened)
            await self._opening()

        self.run(go())
        COVERAGE["reopened the connection"] += 1

    @rule(agent=st.sampled_from(AGENTS))
    def move(self, agent: str) -> None:
        """The owner moves the agent to the other controller, or back. The
        open stream detaches it, or attaches it at its head."""
        target = self.elsewhere if self.bound[agent] else self.controller

        async def go() -> None:
            moved = await self.http.patch(
                f"/gateway/management/agents/{self.agents[agent]}",
                json={"controller_id": target.controller_id},
                cookies=cookies_for(self.owner),
            )
            assert moved.status_code == 200, moved.text
            self.bound[agent] = not self.bound[agent]
            if self.stream is None:
                if not self.bound[agent]:
                    self.confirmed[agent] = None
                return
            if self.bound[agent]:
                self.confirmed[agent] = None
                await self._pump(
                    lambda: self.attached[agent], f"{agent} to be attached"
                )
                COVERAGE["attached an agent mid-stream"] += 1
            else:
                # A pass detaches before it reads, and sends what an earlier
                # pass read before it starts, so no event of the agent's
                # follows its detach.
                await self._pump(
                    lambda: not self.attached[agent], f"{agent} to be detached"
                )
                COVERAGE["detached an agent mid-stream"] += 1

        self.run(go())

    @precondition(lambda self: any(self.head[a] > self.expired[a] for a in AGENTS))
    @rule(data=st.data())
    def expire(self, data: st.DataObject) -> None:
        """Retention deletes every event of one agent so far."""
        agent = data.draw(
            st.sampled_from([a for a in AGENTS if self.head[a] > self.expired[a]])
        )

        async def go() -> None:
            await age_events(self.session_factory, self.agents[agent], seconds=2 * 3600)
            await self.harness.protocol.event_buffer.expire(TENANT_ZERO_ID)

        self.run(go())
        self.expired[agent] = self.head[agent]
        if self.attached[agent]:
            self.read_before_expiry[agent] = self.ran_through[agent]

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
            held = self.confirmed[agent]
            assert held is None or held <= self.head[agent]


def machine_on(url: str) -> type[ControllerStreams]:
    """The machine against the database at `url`."""
    return type("ControllerStreamsOnPostgres", (ControllerStreams,), {"url": url})
