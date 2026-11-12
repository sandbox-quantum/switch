"""A Hypothesis state machine over the real router, event buffer and Postgres.

It does what `properties/specs/delivery.qnt` models: transactions that write a
room row and number events for the agents it is for, held open or committed in
whatever order Hypothesis picks; agents joining and leaving; retention; a
client of an agent resuming. The invariants are the model's, checked against
the database after every step, and the names below follow the model's state.

An operation that takes a lock another is holding really waits: it runs as a
task, and a step that needs it to finish first lets the one it waits for finish.
A transaction is held between the statements of `MessageRouter.store` and its
commit, which is where the model's `claim` and `commit` meet; what an agent
number or a row's `seq` is, and whether it is committed, is read from the
database, not predicted.

What is not here: the wake-up (`routed.committed()` is not called, so no agent
is woken and no reply is posted) and room commands.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

import hypothesis.strategies as st
from hypothesis import event
from hypothesis.errors import InvalidArgument
from hypothesis.stateful import (
    RuleBasedStateMachine,
    invariant,
    precondition,
    rule,
)
from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.bridges.agent.protocol.agent_connections import (
    POSITIONS_PROTOCOL_REVISION,
    AgentConnection,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import CursorExpiredError
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.bridges.agent.protocol.stream import _opening_gaps
from switch_core.db.engine import create_session_factory
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentEventHead,
    AgentEventRow,
    Client,
    ClientRoom,
    Message,
    Room,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.tenant_context import tenant_scope
from switch_core.transport.invites import InviteBus
from switch_core.transport.postgres import new_event_id
from tests.conftest import empty_the_database
from tests.db_buffer import db_buffer_on
from tests.routing import make_agent, make_person, make_room, router_on

AGENTS = ("alpha", "beta")
ROOMS = ("r1", "r2")
WRITERS = (1, 2, 3)

# What a retention window is here, which `expire` below puts a cutoff inside.
RETENTION_SECONDS = 3600

# How long a step waits for operations to finish or wait for a lock.
SETTLE_SECONDS = 20.0


COVERAGE: Counter[str] = Counter()


# What a run has to reach for the invariants to have been tried on anything
# (the model's `sometimes`): a run that reaches none of these has checked
# nothing.
SHOULD_REACH = (
    "a post waits for a lock",
    "a commit stores events for 1 of the agents",
    "a commit stores events for 2 of the agents",
    "an agent is removed from a room",
    "a read delivers events",
)

# Outcomes a run of the `ci` profile's size reaches only most of the time; the
# scenario tests reach each of them every run, and the `nightly` profile has to.
SHOULD_REACH_AT_SCALE = (
    "a leave waits for a lock",
    "retention runs over events",
    "the process restarts",
)


def note(what: str) -> None:
    """Record that something the machine is there to reach happened, for
    Hypothesis's statistics and for the test that every outcome was reached."""
    COVERAGE[what] += 1
    with contextlib.suppress(InvalidArgument):
        event(what)


@dataclass
class Operation:
    """Something running as a task: a transaction writing a room row, or an
    agent being removed from a room."""

    kind: str
    task: asyncio.Task[None] | None = None
    # running: not yet parked or finished. parked: a post that has written its
    # row and events and waits to commit. done, or failed with `error`.
    state: str = "running"
    error: BaseException | None = None
    waited: bool = False


@dataclass
class Post(Operation):
    room: str = ""
    addressed: frozenset[str] = frozenset()
    gate: asyncio.Future[str] | None = None
    seq: int = 0
    # The events it numbered, read in its own transaction before it ends: after
    # the commit a removal waiting for the agent's head row can already have
    # deleted them.
    stored: list[tuple[str, int]] = field(default_factory=list)
    # Members of the room when the post began, less any that left since: the
    # agents that were in the room throughout the post.
    stable: set[str] = field(default_factory=set)


@dataclass
class Leave(Operation):
    agent: str = ""
    room: str = ""


@dataclass
class Row:
    """A committed row, and what the router did with it."""

    seq: int
    addressed: frozenset[str]
    stored: frozenset[str]
    stable: frozenset[str]


class Delivery(RuleBasedStateMachine):
    """The rooms, agents and clients of `delivery.qnt` on a real database."""

    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        # Named, so what waits for a lock is counted for this machine alone and
        # what it leaves behind can be ended.
        self.application = f"machine-{uuid.uuid4().hex[:12]}"
        self.engine = create_async_engine(
            self.url,
            connect_args={"server_settings": {"application_name": self.application}},
        )
        try:
            self._set_up()
        except BaseException:
            self._release()
            raise

    def _set_up(self) -> None:
        self.run(empty_the_database(self.engine))
        self.session_factory = create_session_factory(self.engine)

        self.boot = 0
        self.rooms: dict[str, Room] = {}
        self.agents: dict[str, tuple[Agent, Client]] = {}
        self.sender: Client
        self.run(self._seed())
        self._boot()

        # The ghosts of the model: what each agent is owed, the numbers given
        # to committed events in order, where each event came from, and what a
        # client has been given or told it lost.
        self.members: dict[str, set[str]] = {room: set(AGENTS) for room in ROOMS}
        self.rows: dict[str, list[Row]] = {room: [] for room in ROOMS}
        self.committed_seqs: dict[str, list[int]] = {room: [] for room in ROOMS}
        self.owed: dict[str, dict[int, tuple[str, int]]] = {a: {} for a in AGENTS}
        self.numbered: dict[str, list[int]] = {a: [] for a in AGENTS}
        self.sources: dict[str, list[tuple[str, int]]] = {a: [] for a in AGENTS}
        self.position: dict[str, int] = dict.fromkeys(AGENTS, 0)
        self.accounted: dict[str, set[int]] = {a: set() for a in AGENTS}

        self.posts: dict[int, Post] = {}
        self.leaves: dict[str, Leave] = {}

    # ── Running things ────────────────────────────────────────────────────────

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(coroutine)

    async def _seed(self) -> None:
        for name in ROOMS:
            self.rooms[name] = await make_room(self.session_factory, name)
        self.sender = await make_person(self.session_factory, "sender")
        for name in AGENTS:
            self.agents[name] = await make_agent(
                self.session_factory, name, connection_model="session_passive"
            )
        for room in self.rooms.values():
            await self._join(self.sender, None, room)
            for agent, client in self.agents.values():
                await self._join(client, agent, room)

    async def _join(self, client: Client, agent: Agent | None, room: Room) -> None:
        """Put a client in a room, written to the tables as a member from before
        the machine would be: no arrival is written, so nobody is greeted."""
        async with tenant_session(self.session_factory, TENANT_ZERO_ID) as session:
            session.add(ClientRoom(client_id=client.id, room_id=room.id))
            if agent is not None:
                await session.execute(
                    pg_insert(room_agents)
                    .values(
                        room_id=room.id,
                        agent_id=agent.id,
                        alias=None,
                        receives_join_events=False,
                    )
                    .on_conflict_do_nothing()
                )
            await session.commit()

    def _boot(self) -> None:
        """A process: a router with a buffer whose numbering starts above every
        earlier boot's."""
        self.buffer = db_buffer_on(
            self.session_factory,
            sequence_base=self.boot * 1000,
            retention_seconds=RETENTION_SECONDS,
        )
        self.router = router_on(self.session_factory, buffer=self.buffer)
        self.provisioning = PostgresProvisioning(
            session_factory=self.session_factory,
            room_store=RoomStore(),
            client_store=ClientStore(),
            router=self.router,
            invites=InviteBus(),
        )

    def teardown(self) -> None:
        try:
            for post in self.posts.values():
                if post.state == "parked" and post.gate is not None:
                    post.gate.set_result("rollback")
            with contextlib.suppress(Exception):
                self.run(self._settle())
            for operation in [*self.posts.values(), *self.leaves.values()]:
                if operation.task is not None and not operation.task.done():
                    operation.task.cancel()
            with contextlib.suppress(Exception):
                self.run(asyncio.sleep(0))
            self.run(self._end_left_open())
        finally:
            self._release()

    def _release(self) -> None:
        """Give back the engine, the loop and the tenant context, which
        Hypothesis would not do for a machine whose `__init__` raised."""
        try:
            self.run(self.engine.dispose())
        finally:
            self.loop.close()
            self._scope.__exit__(None, None, None)

    async def _end_left_open(self) -> None:
        """End this machine's sessions that are still in a transaction, which a
        cancelled operation leaves, so they cannot hold a lock into the next
        example."""
        async with self.engine.connect() as connection:
            await connection.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE application_name = :application AND pid <> pg_backend_pid()"
                ),
                {"application": self.application},
            )

    # ── Waiting for what is running ───────────────────────────────────────────

    def _operations(self) -> list[Operation]:
        return [*self.posts.values(), *self.leaves.values()]

    async def _lock_waiters(self) -> int:
        async with self.session_factory() as session:
            return int(
                await session.scalar(
                    text(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE application_name = :application "
                        "AND wait_event_type = 'Lock'"
                    ),
                    {"application": self.application},
                )
                or 0
            )

    async def _settle(self) -> None:
        """Let every operation run until it is parked, finished, or waiting for
        a lock another holds. One that is none of these within the time is a
        hang, and fails the run; so does one that raised."""
        deadline = self.loop.time() + SETTLE_SECONDS
        quiet = 0
        while True:
            await asyncio.sleep(0.005)
            for operation in self._operations():
                if operation.state == "failed":
                    raise AssertionError(
                        f"a {operation.kind} failed: {operation.error!r}"
                    ) from operation.error
            running = [op for op in self._operations() if op.state == "running"]
            if not running:
                return
            if await self._lock_waiters() >= len(running):
                quiet += 1
                if quiet >= 4:
                    for op in running:
                        if not op.waited:
                            op.waited = True
                            note(f"a {op.kind} waits for a lock")
                    return
            else:
                quiet = 0
            if self.loop.time() > deadline:
                raise AssertionError(
                    f"{[op.kind for op in running]} neither finished nor waited "
                    "for a lock"
                )

    def settle(self) -> None:
        self.run(self._settle())

    # ── Transactions ──────────────────────────────────────────────────────────

    def begin_post(self, writer: int, room: str, addressed: frozenset[str]) -> None:
        """A transaction that writes a row to `room` for the agents `addressed`
        names, and holds it, uncommitted, once it is written."""
        assert writer not in self.posts
        post = Post(
            kind="post",
            room=room,
            addressed=addressed,
            stable=set(self.members[room])
            - {agent for agent, leave in self.leaves.items() if leave.room == room},
        )
        post.gate = self.loop.create_future()
        self.posts[writer] = post
        post.task = self.loop.create_task(self._post(post))
        self.settle()

    async def _post(self, post: Post) -> None:
        room = self.rooms[post.room]
        mentions = " ".join(f"@{name}" for name in sorted(post.addressed))
        try:
            async with tenant_session(self.session_factory, TENANT_ZERO_ID) as session:
                routed = await self.router.store(
                    session,
                    tenant_id=TENANT_ZERO_ID,
                    room_id=room.id,
                    transport_room_id=room.transport_room_id,
                    message=Message(
                        room_id=room.id,
                        transport_event_id=new_event_id(),
                        sender_id=self.sender.transport_user_id,
                        sender_client_id=self.sender.id,
                        sender_name=self.sender.display_name,
                        event_type="m.room.message",
                        msgtype="m.text",
                        body=f"{mentions} {uuid.uuid4().hex[:6]}".strip(),
                        content={"body": mentions, "msgtype": "m.text"},
                    ),
                    attachments=[],
                )
                post.seq = routed.seq
                post.stored = [
                    (agent_id, number)
                    for agent_id, number in (
                        await session.execute(
                            select(AgentEventRow.agent_id, AgentEventRow.seq).where(
                                AgentEventRow.room_id == room.id,
                                AgentEventRow.room_seq == routed.seq,
                            )
                        )
                    ).all()
                ]
                post.state = "parked"
                assert post.gate is not None
                decision = await post.gate
                if decision == "commit":
                    await session.commit()
                else:
                    await session.rollback()
            post.state = "done"
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            post.error = error
            post.state = "failed"

    def end_post(self, writer: int, decision: str) -> None:
        """Commit or roll back a parked transaction, and take what it did into
        the ghosts, in the order it committed."""
        post = self.posts[writer]
        assert post.state == "parked" and post.gate is not None
        post.gate.set_result(decision)
        self.run(self._until(lambda: post.state != "parked"))
        if post.state == "failed":
            raise AssertionError(f"a post failed: {post.error!r}") from post.error
        del self.posts[writer]
        if decision == "commit":
            self.run(self._observe_commit(post))
        self.settle()

    async def _until(self, done: Any) -> None:
        deadline = self.loop.time() + SETTLE_SECONDS
        while not done():
            if self.loop.time() > deadline:
                raise AssertionError("an operation did not finish")
            await asyncio.sleep(0.005)

    async def _observe_commit(self, post: Post) -> None:
        names = {agent.id: name for name, (agent, _) in self.agents.items()}
        stored = post.stored
        note(f"a commit stores events for {len(stored)} of the agents")
        row = Row(
            seq=post.seq,
            addressed=post.addressed,
            stored=frozenset(names[agent_id] for agent_id, _ in stored),
            stable=frozenset(post.stable & post.addressed),
        )
        self.rows[post.room].append(row)
        self.committed_seqs[post.room].append(post.seq)
        for agent_id, number in sorted(stored, key=lambda pair: pair[1]):
            name = names[agent_id]
            self.owed[name][number] = (post.room, post.seq)
            self.numbered[name].append(number)
            self.sources[name].append((post.room, post.seq))

    # ── Membership ────────────────────────────────────────────────────────────

    def begin_leave(self, agent: str, room: str) -> None:
        assert agent in self.members[room] and agent not in self.leaves
        leave = Leave(kind="leave", agent=agent, room=room)
        self.leaves[agent] = leave
        leave.task = self.loop.create_task(self._leave(leave))
        self.settle()
        self._take_finished_leaves()

    async def _leave(self, leave: Leave) -> None:
        try:
            await self.provisioning.kick_user(
                self.rooms[leave.room].transport_room_id,
                self.agents[leave.agent][1].transport_user_id,
            )
            leave.state = "done"
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            leave.error = error
            leave.state = "failed"

    def _take_finished_leaves(self) -> None:
        """An agent that has been removed is no longer a member, and is owed
        nothing more from the room."""
        for agent, leave in list(self.leaves.items()):
            if leave.state != "done":
                continue
            del self.leaves[agent]
            note("an agent is removed from a room")
            self.members[leave.room].discard(agent)
            self.owed[agent] = {
                number: source
                for number, source in self.owed[agent].items()
                if source[0] != leave.room
            }
            for post in self.posts.values():
                if post.room == leave.room:
                    post.stable.discard(agent)

    def join(self, agent: str, room: str) -> None:
        assert agent not in self.members[room] and agent not in self.leaves
        client = self.agents[agent][1]
        self.run(self._join(client, self.agents[agent][0], self.rooms[room]))
        self.members[room].add(agent)

    # ── Retention ─────────────────────────────────────────────────────────────

    def expire_at(self, choice: int) -> None:
        """Retention, with its cutoff placed at one of the `created_at` values
        in the table, so that it deletes every event created up to there and
        none after. The events are moved back in time together until that
        value is older than the window, then `expire` runs."""
        self.settle()
        self.run(self._expire_at(choice))

    async def _expire_at(self, choice: int) -> None:
        async with tenant_session(self.session_factory, TENANT_ZERO_ID) as session:
            created = sorted(
                set(await session.scalars(select(AgentEventRow.created_at)))
            )
            if not created:
                return
            cutoff = created[choice % len(created)]
            note("retention runs over events")
            window = timedelta(seconds=RETENTION_SECONDS)
            now = datetime.now(UTC)
            shift = cutoff - (now - window) + timedelta(microseconds=1)
            await session.execute(
                update(AgentEventRow).values(
                    created_at=AgentEventRow.created_at - shift
                )
            )
            await session.commit()
        await self.buffer.expire(TENANT_ZERO_ID)

    # ── A client reading ──────────────────────────────────────────────────────

    def read(self, agent: str) -> None:
        """A client of the agent resumes from its position and reads what is
        there: the stream's opening checks, then the events after them.

        A reader of an agent with no head row inserts one, and waits for a
        transaction that is inserting it, so it is not started while one is
        open: the machine could not finish that transaction while it waited."""
        self.settle()
        if any(post.state == "parked" for post in self.posts.values()):
            if not self.run(self._has_head_row(agent)):
                note("a read is skipped")
                return
        self.run(self._read(agent))

    async def _has_head_row(self, agent: str) -> bool:
        async with tenant_session(self.session_factory, TENANT_ZERO_ID) as session:
            return (
                await session.scalar(
                    select(AgentEventHead.agent_id).where(
                        AgentEventHead.agent_id == self.agents[agent][0].id
                    )
                )
                is not None
            )

    async def _read(self, name: str) -> None:
        agent, _ = self.agents[name]
        at = self.position[name]
        now = time.monotonic()
        conn = AgentConnection(
            id="client",
            agent_id=agent.id,
            scope="single",
            delivery_filter="addressed",
            spawn_capable=False,
            position={OWN_EVENTS: at},
            last_beat=now,
            opened_at=now,
            declaration=ClientDeclaration(speaks=POSITIONS_PROTOCOL_REVISION),
        )
        gaps: list[dict[str, Any]] = list(
            await _opening_gaps(conn, self.buffer, TENANT_ZERO_ID)
        )
        while True:
            head = await self.buffer.head(TENANT_ZERO_ID, agent.id)
            try:
                items = await self.buffer.read_from(
                    TENANT_ZERO_ID,
                    agent.id,
                    conn.position[OWN_EVENTS],
                    through_seq=head,
                )
            except CursorExpiredError as expired:
                gaps.append(
                    {
                        "from_sequence": expired.requested,
                        "rooms": list(expired.rooms),
                        "all_rooms": False,
                        "resumed_position": {OWN_EVENTS: expired.resume_after},
                    }
                )
                conn.position[OWN_EVENTS] = expired.resume_after
                continue
            break
        if items:
            note("a read delivers events")
        if gaps:
            note("a read reports a gap")
        room_names = {room.id: name for name, room in self.rooms.items()}
        for gap in gaps:
            low = gap["from_sequence"]
            high = gap["resumed_position"][OWN_EVENTS]
            lost = {room_names[room_id] for room_id in gap["rooms"]}
            for number, (room, _) in self.owed[name].items():
                if low < number <= high and (gap["all_rooms"] or room in lost):
                    self.accounted[name].add(number)
        for item in items:
            self.accounted[name].add(item.seq)
            conn.position[OWN_EVENTS] = max(conn.position[OWN_EVENTS], item.seq)
        self.position[name] = conn.position[OWN_EVENTS]

    # ── A restart ─────────────────────────────────────────────────────────────

    def restart(self) -> None:
        """A new process: every open transaction is lost, and the buffer's
        numbering starts above every earlier boot's."""
        for writer, post in list(self.posts.items()):
            if post.state == "parked":
                self.end_post(writer, "rollback")
        self.boot += 1
        note("the process restarts")
        self._boot()

    # ── The invariants of the model, read from the database ───────────────────

    def check_all(self) -> None:
        self.settle()
        self._take_finished_leaves()
        self.run(self._check())

    async def _check(self) -> None:
        ids = {name: agent.id for name, (agent, _) in self.agents.items()}
        names = {agent_id: name for name, agent_id in ids.items()}
        room_names = {room.id: name for name, room in self.rooms.items()}
        async with tenant_session(self.session_factory, TENANT_ZERO_ID) as session:
            message_seqs: dict[str, list[int]] = {}
            for name, room in self.rooms.items():
                message_seqs[name] = list(
                    await session.scalars(
                        select(Message.seq)
                        .where(Message.room_id == room.id, Message.seq > 0)
                        .order_by(Message.seq)
                    )
                )
            events = (
                await session.execute(
                    select(
                        AgentEventRow.agent_id,
                        AgentEventRow.seq,
                        AgentEventRow.room_id,
                        AgentEventRow.room_seq,
                    )
                )
            ).all()
            heads = {
                row.agent_id: row
                for row in (await session.scalars(select(AgentEventHead))).all()
            }
            members = {
                (names[agent_id], room_names[room_id])
                for agent_id, room_id in (
                    await session.execute(
                        select(Agent.id, ClientRoom.room_id).join(
                            ClientRoom, ClientRoom.client_id == Agent.client_id
                        )
                    )
                ).all()
            }

        # bus.room-seq-dense
        for room in ROOMS:
            n = len(self.committed_seqs[room])
            assert self.committed_seqs[room] == list(range(1, n + 1)), (
                f"{room}: rows committed as {self.committed_seqs[room]}"
            )
            assert message_seqs[room] == list(range(1, n + 1)), (
                f"{room}: rows in the table are {message_seqs[room]}"
            )

        retained = {
            (names[agent_id], room_names[room_id], room_seq, seq)
            for agent_id, seq, room_id, room_seq in events
        }

        # delivery.decided-at-write
        for agent, room, room_seq, number in retained:
            row = next((r for r in self.rows[room] if r.seq == room_seq), None)
            assert row is not None, f"{agent} has event {number} for no row"
            assert agent in row.stored and agent in row.addressed, (
                f"{agent} has event {number} for {room} row {room_seq}, which "
                f"stored {sorted(row.stored)} of {sorted(row.addressed)}"
            )

        # delivery.own-seq-contiguous
        for agent in AGENTS:
            log = self.numbered[agent]
            head = heads.get(ids[agent])
            if log:
                assert head is not None, f"{agent} has events and no head row"
            if head is not None:
                assert head.last_seq == head.first_seq - 1 + len(log), (
                    f"{agent}: head {head.first_seq}..{head.last_seq}, numbered {log}"
                )
                assert log == [head.first_seq + i for i in range(len(log))], (
                    f"{agent}: numbered {log} from {head.first_seq}"
                )

        # delivery.addressed-exactly-once
        for room in ROOMS:
            for row in self.rows[room]:
                assert row.stored <= row.addressed, f"{room} {row.seq}: {row}"
                assert row.stable <= row.stored, (
                    f"{room} row {row.seq} was for {sorted(row.stable)}, who were "
                    f"in the room throughout, and stored {sorted(row.stored)}"
                )
        for agent in AGENTS:
            assert len(self.sources[agent]) == len(set(self.sources[agent])), (
                f"{agent}: events from the same row: {self.sources[agent]}"
            )

        # delivery.no-events-after-leave
        for agent, room, room_seq, number in retained:
            assert (agent, room) in members, (
                f"{agent} has event {number} in {room}, which it has left"
            )
        assert members == {
            (agent, room) for room in ROOMS for agent in self.members[room]
        }

        # delivery.no-silent-loss
        for agent in AGENTS:
            for number in self.owed[agent]:
                if number <= self.position[agent]:
                    assert number in self.accounted[agent], (
                        f"{agent}: position {self.position[agent]} is past event "
                        f"{number}, which it was neither given nor told it lost"
                    )

    @invariant()
    def invariants_hold(self) -> None:
        self.check_all()

    # ── The rules Hypothesis chooses from ─────────────────────────────────────
    #
    # Each is available only when it can do something, and picks what it acts on
    # from what there is, so a run spends its steps on operations that happen
    # rather than on ones that find nothing to do.

    def _parked(self) -> list[int]:
        return sorted(w for w, post in self.posts.items() if post.state == "parked")

    def _idle(self) -> list[int]:
        return [w for w in WRITERS if w not in self.posts]

    def _members(self) -> list[tuple[str, str]]:
        return [
            (agent, room)
            for room in ROOMS
            for agent in AGENTS
            if agent in self.members[room] and agent not in self.leaves
        ]

    def _absentees(self) -> list[tuple[str, str]]:
        return [
            (agent, room)
            for room in ROOMS
            for agent in AGENTS
            if agent not in self.members[room] and agent not in self.leaves
        ]

    @precondition(lambda self: bool(self._idle()))
    @rule(
        pick=st.integers(min_value=0, max_value=99),
        room=st.sampled_from(ROOMS),
        addressed=st.frozensets(st.sampled_from(AGENTS)),
    )
    def post(self, pick: int, room: str, addressed: frozenset[str]) -> None:
        idle = self._idle()
        self.begin_post(idle[pick % len(idle)], room, addressed)

    @precondition(lambda self: bool(self._parked()))
    @rule(
        pick=st.integers(min_value=0, max_value=99),
        decision=st.sampled_from(["commit", "commit", "commit", "rollback"]),
    )
    def finish(self, pick: int, decision: str) -> None:
        parked = self._parked()
        self.end_post(parked[pick % len(parked)], decision)

    @precondition(lambda self: bool(self._parked()))
    @rule(pick=st.integers(min_value=0, max_value=99))
    def commit(self, pick: int) -> None:
        """As `finish`, which Hypothesis would otherwise pick as often as a
        rollback or a restart: commits are what the invariants are about."""
        parked = self._parked()
        self.end_post(parked[pick % len(parked)], "commit")

    @precondition(lambda self: len(self._members()) >= 3)
    @rule(pick=st.integers(min_value=0, max_value=99))
    def leave(self, pick: int) -> None:
        members = self._members()
        agent, room = members[pick % len(members)]
        self.begin_leave(agent, room)

    @precondition(lambda self: bool(self._absentees()))
    @rule(pick=st.integers(min_value=0, max_value=99))
    def rejoin(self, pick: int) -> None:
        absentees = self._absentees()
        agent, room = absentees[pick % len(absentees)]
        self.join(agent, room)

    @precondition(lambda self: any(self.owed.values()))
    @rule(choice=st.integers(min_value=0, max_value=20))
    def expire(self, choice: int) -> None:
        self.expire_at(choice)

    @rule(agent=st.sampled_from(AGENTS))
    def read_events(self, agent: str) -> None:
        self.read(agent)

    @precondition(lambda self: any(self.owed.values()))
    @rule(agent=st.sampled_from(AGENTS))
    def read_owed_events(self, agent: str) -> None:
        """As `read_events`, where there is something to read."""
        self.read(agent)

    @precondition(lambda self: self.boot < 1)
    @rule()
    def restart_process(self) -> None:
        self.restart()


def machine_on(url: str) -> type[Delivery]:
    """The machine, on the database at `url`."""
    return type("DeliveryOn", (Delivery,), {"url": url})
