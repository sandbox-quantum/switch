"""An agent's events (CHOO-1857), stored in Postgres and read by position.

The events an agent receives come from two tables.

**The agent's own events.** These are the events meant for the agent: a
message addressed to it, a room_join in a room where it listens for joins, a
task it takes part in, a command sent to it. The router
(`delivery/router.py`) decides whether a room row is one of these as the row
is written, and stores each decision as a row in `agent_events` in the same
transaction as the room row (`store`). The decision cannot be repeated later,
because the addressing policy, budgets and role leases it depended on may have
changed by then. These rows are called own events. Each agent numbers its own
events in its own sequence (`agent_events.seq`).

**The rest of the conversation.** Everything else said in the agent's rooms is
already stored in `messages`, numbered per room (`messages.seq`), and is read
from there when a reader asks for it. Nothing is copied per agent, so a message
in a busy room costs one write, not one write per agent in the room. A room row
and the own events decided for it commit together, so a reader that can see
the row can also see whether it is one of the agent's own events, and can read
the conversation the moment it is written.

A reader's position (`positions.py`) records how far it has read: one number
for the agent's own events and one number per room for the conversation. Reading
deletes nothing, so several readers can consume the same events independently,
and a reader that disconnects resumes from its position, on any process and
after a restart.

`expire` deletes own events once they are older than the retention window, never
because a reader has confirmed them. Every deletion is recorded: the newest
deleted own event per agent and room goes into `agent_event_drops`, and a reader
that later resumes from before that own event is told which rooms it missed events
in.

When an own event is inserted, Postgres sends a notification
(`db/agent_event_notify_ddl.py`). A listener in every process receives it and
sets that agent's doorbell, an in-memory `asyncio.Event`, so the process that
holds the agent's connection wakes up and reads the new own event from the table.
A room row rings no doorbell of an agent's: a reader of the conversation asks to
be woken by the room's own announcement instead (`rooms`, the
`MessageListener`). Neither carries anything; the tables are the record.

An unread count says how much unaddressed conversation in a room the agent has
not caught up on. It is counted from `messages` when asked: the room's messages
after the agent's baseline for the room, minus the ones that became own events. The
baseline (`caught_up_seq`) and the reader currently in the room are stored in
`agent_room_reads`.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager, nullcontext
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Protocol, cast

from sqlalchemy import (
    BigInteger,
    Boolean,
    Text,
    bindparam,
    delete,
    func,
    literal,
    select,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, insert
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from switch_core.attachments import ATTACHMENT_GROUP_KEY, parse_attachment_group
from switch_core.bridges.agent.protocol.message_events import (
    attachment_ref,
    message_event,
    room_join_event,
)
from switch_core.bridges.agent.protocol.positions import (
    OWN_EVENTS,
    Position,
    merged,
    room_of,
    room_source,
)
from switch_core.bridges.agent.protocol.types import AgentEvent
from switch_core.clients.admin_messages import platform_replies_in_channel
from switch_core.db.models import TICKET_FLOOR as TICKET_FLOOR
from switch_core.db.models import (
    Agent,
    AgentEventDrop,
    AgentEventHead,
    AgentEventRow,
    AgentPollPosition,
    AgentPositionTicket,
    AgentRoomRead,
    Client,
    ClientRoom,
    Message,
    MessageAttachment,
    PendingAttachmentGroup,
    Room,
)
from switch_core.db.session_scope import (
    holds_shared_session,
    shared_tenant_session,
    tenant_session,
)
from switch_core.observability.catalogue import (
    AGENT_BUFFER_SCAN_DURATION,
    AGENT_BUFFER_SCANNED,
    AGENT_EVENTS_DROPPED,
)
from switch_core.observability.metrics import metrics
from switch_core.transport.stored import to_inbound
from switch_core.transport.types import InboundMedia, InboundMembership, InboundMessage

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)


class RoomAnnouncements(Protocol):
    """Who announces that a room has new rows: `messages.notify.MessageListener`.

    A reader of the rooms' conversation is woken by it, since a room row rings
    no doorbell of an agent's. The waker is called with the room's id and is
    told nothing else: it reads from its own position, as every reader here
    does.
    """

    def subscribe(
        self, room_id: str, waker: Callable[[str], Awaitable[None]]
    ) -> None: ...

    def unsubscribe(
        self, room_id: str, waker: Callable[[str], Awaitable[None]]
    ) -> None: ...


# How long an own event stays in `agent_events` before `expire` deletes it. A client
# that reconnects within this window receives every own event it missed; a client
# that reconnects later is told it has a gap instead of being handed an
# incomplete stream. This module never deletes rows from `messages`, so the
# conversation has no such window.
DEFAULT_RETENTION_SECONDS = 24 * 60 * 60

# How often a long poll that includes the rooms' conversation looks again while
# it waits. A room row rings no agent's doorbell, and a long poll has no room
# announcements to wait on, so without this it would sleep through its whole
# timeout while the rooms it reads were being talked in.
CONVERSATION_RECHECK_SECONDS = 2.0

# Some clients can store only one integer as their place in the stream. Such a
# client is sent a ticket: the id of a row in `agent_position_tickets` that
# holds the full position. Ticket ids start at `TICKET_FLOOR`, above every own
# event number the server issues (`db/models.py` derives both from the range of
# `agent_event_boot`), so the server can tell a ticket from an own event number
# when a client sends one back.

# Own event types no code writes any more. Rows of these types can still be in
# `agent_events` until retention deletes them, and are skipped on read because
# they no longer parse as an `AgentEvent`.
RETIRED_EVENT_TYPES = frozenset(
    {"task_delegate", "task_accept", "task_update", "task_finalise", "task_cancel"}
)

_READ = {"operation": "read"}
_UNREAD = {"operation": "unread"}

# How many times a long poll reads again after another poll of the same reader
# saved a position first. Each lost save means another poll moved the reader,
# so the next read starts from where that one stopped.
_POLL_SAVE_ATTEMPTS = 5

# How long `enqueue` waits before each retry of a write that failed because the
# database connection or the connection pool did. After the last, the error is
# raised.
ENQUEUE_RETRY_DELAYS = (0.5, 2.0, 5.0)

# The reason sent when no unread count can be given, because nothing in
# `agent_room_reads` says how far the agent had read the room. The count is
# left empty rather than set to zero, so that a zero always means nothing was
# missed.
NO_BASELINE = "nothing recorded what you had already seen in this room"
# The reason sent when a count is a lower bound. Own events older than the
# retention window have been deleted, so the count cannot tell which older
# messages were addressed to the agent and starts at the window instead.
COUNTED_FROM_WINDOW = (
    "counted over the retention window only; you have not caught up on this "
    "room for longer than that"
)


class CursorExpiredError(Exception):
    """A reader asked to resume from an own event number older than the oldest own event kept.

    Raised rather than fast-forwarding to head: a client that has missed events
    must be told, never handed a stream that looks complete.
    """

    def __init__(
        self,
        agent_id: str,
        requested: int,
        oldest: int,
        rooms: tuple[str, ...],
        resume_after: int,
    ) -> None:
        super().__init__(
            f"cursor {requested} for agent {agent_id} is older than what is "
            f"retained (oldest retained: {oldest}); missed events in "
            f"{', '.join(rooms)}, re-read context"
        )
        self.agent_id = agent_id
        self.requested = requested
        self.oldest = oldest
        self.rooms = rooms
        # The own-events number a reader resumes after once it has been told
        # about the gap: past every number `expire` deleted. It is not
        # `oldest - 1`, because when retention has deleted all of the agent's
        # own events there is no oldest one, and a reader moved to 0 would hit
        # the same deleted numbers on its next read and be told again, forever.
        self.resume_after = resume_after


def is_notifiable(event: AgentEvent) -> bool:
    """Whether an event is addressed at the agent rather than ambient context.

    Addressed messages and the room_join events the agent is configured to
    listen for. Excludes conversation and admin command events.
    This is the `addressed` delivery filter: a supervising connection watching
    every room wants only these, while a session in a single room wants
    everything.
    """
    if event.type == "message":
        return getattr(event.payload, "addressed", False)
    if event.type == "room_join":
        return getattr(event.payload, "listening", False)
    return False


@dataclass(frozen=True)
class BufferedEvent:
    """An event together with the source it was read from.

    `source` is `positions.OWN_EVENTS` for an event read from the agent's own events in
    `agent_events`, or `room_source(room_id)` for one read from a room's
    conversation in `messages`. `seq` is the event's number in that source;
    once the event is delivered, the reader's position for that source moves
    to it. `room_seq` is the `messages.seq` of the room row the event came
    from. `at` is when the event happened, and is used to order events from
    different sources against each other.
    """

    seq: int
    room_id: str
    event: AgentEvent
    notifiable: bool
    source: str = OWN_EVENTS
    room_seq: int = 0
    at: float = 0.0


@dataclass(frozen=True)
class Conversation:
    """The result of reading the rooms' conversation from `messages`.

    `events` holds what is to be delivered. `through` maps each room to the
    last row the read examined, whether or not that row was delivered. Rows
    that are not conversation (the agent's own messages, other kinds of event,
    rows that are already own events) are skipped, but they still count as read, so
    the reader's position moves past them and they are not examined again.
    `cut` maps each room whose read stopped at the row limit, with rows still
    to read after it, to when the last row read was sent (seconds since the
    epoch).
    """

    events: list[BufferedEvent] = field(default_factory=list)
    through: dict[str, int] = field(default_factory=dict)
    cut: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Reader:
    """Who is in a room, for the purpose of counting what went past it.

    A session when the caller named one, otherwise the connection or transport
    session it arrived on. Which of the two it is decides how a room changes
    hands: a connection may carry sessions working in several rooms, so
    covering a room is not being in it, while a session speaks for the one room
    it is in.
    """

    id: str
    is_session: bool


@dataclass(frozen=True)
class Unread:
    """Unaddressed messages a reader has yet to catch up on, in one room.

    `count` is None when nothing about it can be stated — better than a zero
    the reader would believe. `reason` explains a count that is missing
    (`NO_BASELINE`) or only a lower bound (`COUNTED_FROM_WINDOW`), and is None
    exactly when the count is complete.
    """

    count: int | None
    reason: str | None


def _epoch(when: datetime | None) -> float:
    return when.timestamp() if when is not None else 0.0


def message_key(row: Message) -> str:
    """The key of the message a `messages` row belongs to.

    Several files posted as one message are stored as separate rows that share
    an attachment group, so their key is the group id. Any other row's key is
    its own transport event id. Own events store the same key in
    `agent_events.message_key`, which is how a row is matched to its own event.
    """
    group = parse_attachment_group(row.content or {})
    return group[0] if group is not None else row.transport_event_id


# `message_key` as a SQL expression over `messages m`, so that `_UNREAD_SQL`
# can count in the database without loading every row.
_MESSAGE_KEY_SQL = (
    "COALESCE(m.content->'com.switch.attachment_group'->>'id', m.transport_event_id)"
)

# The unread counts of one room at several positions (`:throughs`, each a
# `messages.seq` in the room), in one statement. A message counts at a
# position when it is a message, not sent by the agent, not one of its own
# events, and inside (`:baseline`, position]. Several rows of one message share
# a key and count once, so each key is reduced to its first qualifying row, and
# the count at a position is the number of keys whose first row is at or
# before it. That is the same number as counting the distinct keys of the
# qualifying rows up to that position, but the room's rows are read once for
# all the positions instead of once per position. `:through` is the highest
# of `:throughs`. `firsts` is MATERIALIZED because Postgres otherwise copies it
# into the per-position count, and under a cached generic plan that reruns the
# room scan once per position (224 ms instead of 5 ms for 200 positions).
_UNREAD_SQL = text(
    f"""
    WITH firsts AS MATERIALIZED (
      SELECT min(m.seq) AS first_seq
      FROM messages m
      WHERE m.room_id = :room_id
        AND m.seq > :baseline
        AND m.seq <= :through
        AND m.seq > 0
        AND m.event_type = 'm.room.message'
        AND m.sender_id <> :me
        AND NOT EXISTS (
          SELECT 1 FROM agent_events e
          WHERE e.agent_id = :agent_id
            AND e.room_id = :room_id
            AND e.type = 'message'
            AND e.message_key = {_MESSAGE_KEY_SQL}
            AND e.room_seq >= m.seq
        )
      GROUP BY {_MESSAGE_KEY_SQL}
    )
    SELECT t.through,
           (SELECT count(*) FROM firsts f WHERE f.first_seq <= t.through)
    FROM unnest(:throughs) AS t(through)
    """
).bindparams(bindparam("throughs", type_=ARRAY(BigInteger)))


def session_slots_for(pool_size: int, max_overflow: int) -> int:
    """How many `EventBuffer.one_session` blocks may hold a connection at once:
    half the pool, so requests still find one when the pod is saturated."""
    return max(1, (pool_size + max_overflow) // 2)


class EventBuffer:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        sequence_base: int,
        rooms: RoomAnnouncements,
        retention_seconds: float = DEFAULT_RETENTION_SECONDS,
        session_slots: int | None,
    ) -> None:
        self._session_factory = session_factory
        # How many `one_session` blocks may hold a connection at once in this
        # process; None for no limit. See `one_session`.
        self._session_slots = (
            asyncio.Semaphore(session_slots) if session_slots is not None else None
        )
        # `sequence_base` comes from a database sequence that advances on every
        # boot (`main.py`), so it is above every number an earlier boot handed
        # out. An agent's first own event is numbered from it. A client still holding
        # a number from before the agent had any own events here therefore holds a
        # number below `sequence_floor`, and is recognised as older than every
        # own event. Later own events are numbered from the agent's row in
        # `agent_event_heads`, so their numbers survive restarts.
        self.sequence_floor = sequence_base + 1
        # Where a reader of the rooms' conversation asks to be woken when a
        # room it reads has a new row.
        self.rooms = rooms
        self._retention_seconds = retention_seconds
        # The doorbells of this process: one `asyncio.Event` per agent, set to
        # wake this process's readers of that agent when an own event is inserted.
        # The writer sets it for own events written here, and the notification
        # listener sets it for own events written by other processes. The events
        # themselves are always read from `agent_events`.
        self._notify: dict[str, asyncio.Event] = {}

    @asynccontextmanager
    async def one_session(self, tenant_id: str) -> AsyncIterator[AsyncSession]:
        """Everything this buffer reads and writes for `tenant_id` inside the
        block, from the task that opened it, in one session.

        Each method here opens a session of its own, so a stream's pass that
        delivers, which asks for the agent's rooms, its head, its own events,
        what was dropped after its position, its rooms' conversation and its
        unread counts, cost six pool checkouts and as many transactions. In one
        session it costs one of each. `shared_tenant_session` says what the
        block may contain; a block must not open another.

        At most `session_slots` blocks hold a connection at once, and a block
        over that waits here holding nothing. When a pod's CPU is saturated,
        every await inside a block takes longer, so without the limit the
        streams' passes come to hold most of the pool, and a request (a send, a
        context read, authentication) waits out the pool timeout and fails.
        """
        # Checked before taking a slot: a nested block would otherwise wait on
        # its own slot once every slot is taken, a deadlock seen only under load.
        if holds_shared_session(self._session_factory, tenant_id):
            raise RuntimeError("one_session opened inside another in the same task")
        slots = self._session_slots or nullcontext()
        async with (
            slots,
            shared_tenant_session(self._session_factory, tenant_id) as session,
        ):
            yield session

    # ------------------------------------------------------------------
    # Producing
    # ------------------------------------------------------------------

    async def store(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        agent_id: str,
        client_id: str,
        room_id: str,
        event: AgentEvent,
        room_seq: int,
        message_key: str | None,
    ) -> int | None:
        """Number one own event and insert it in the caller's transaction, and
        return its number, or None when nothing was stored.

        This is how the router (`delivery/router.py`) writes an agent's own
        events: in the transaction that writes the room row they come from, so
        the row and the events decided for it commit together or not at all.
        The number is claimed from the agent's row in `agent_event_heads`, and
        that row stays locked until the caller commits, so an agent's numbers
        are handed out in commit order whichever room each event comes from.
        A caller that stores events for several agents has to claim them in a
        fixed order (the router sorts by agent id), or two transactions each
        holding one agent's row would wait for each other.

        The work runs in a savepoint of its own, so a failure here leaves the
        caller's transaction usable: the room row the caller wrote still
        commits, and only this agent misses the event.

        Nothing is stored, and the number taken is given back with the
        savepoint, in two cases. The agent is no longer a member of the room:
        membership is read after the agent's row is locked, so a removal that
        committed while this waited for the lock is seen, and a removal that
        comes later deletes the event under the same lock
        (`forget_room`). Or an event from the same source is already stored:
        an agent consumer of an older release, still running beside this one
        during a rolling deploy, decides the same row and stores it itself.
        """
        savepoint = await session.begin_nested()
        try:
            seq = (await session.execute(self._claim(tenant_id, agent_id))).scalar_one()
            member = (
                select(ClientRoom.room_id)
                .where(ClientRoom.client_id == client_id, ClientRoom.room_id == room_id)
                .exists()
            )
            inserted = await session.scalar(
                self._own_event_insert(
                    select(
                        literal(tenant_id, Text),
                        literal(agent_id, Text),
                        literal(seq, BigInteger),
                        literal(room_id, Text),
                        literal(room_seq, BigInteger),
                        literal(message_key, Text),
                        literal(event.type, Text),
                        literal(event.model_dump(mode="json"), JSONB),
                        literal(is_notifiable(event), Boolean),
                    ).where(member)
                )
            )
        except BaseException:
            await savepoint.rollback()
            raise
        if inserted is None:
            await savepoint.rollback()
            return None
        await savepoint.commit()
        return int(seq)

    def _claim(self, tenant_id: str, agent_id: str) -> Any:
        """The next number of the agent's own events, taken from its row in
        `agent_event_heads`, which the statement locks until the transaction
        ends. An agent with no row yet gets one, starting at `sequence_floor`."""
        return (
            insert(AgentEventHead)
            .values(
                tenant_id=tenant_id,
                agent_id=agent_id,
                first_seq=self.sequence_floor,
                last_seq=self.sequence_floor,
            )
            .on_conflict_do_update(
                index_elements=[AgentEventHead.agent_id],
                set_={"last_seq": AgentEventHead.last_seq + 1},
            )
            .returning(AgentEventHead.last_seq)
        )

    @staticmethod
    def _own_event_insert(values: Any) -> Any:
        """An insert into `agent_events` of the row `values` selects, that
        does nothing when an event from the same source is already stored
        (`uq_agent_events_source`), and returns the stored number."""
        return (
            insert(AgentEventRow)
            .from_select(
                [
                    AgentEventRow.tenant_id,
                    AgentEventRow.agent_id,
                    AgentEventRow.seq,
                    AgentEventRow.room_id,
                    AgentEventRow.room_seq,
                    AgentEventRow.message_key,
                    AgentEventRow.type,
                    AgentEventRow.payload,
                    AgentEventRow.notifiable,
                ],
                values,
            )
            .on_conflict_do_nothing(
                index_elements=[
                    AgentEventRow.agent_id,
                    AgentEventRow.message_key,
                    AgentEventRow.room_id,
                    AgentEventRow.room_seq,
                    AgentEventRow.type,
                ],
                index_where=AgentEventRow.message_key.is_not(None),
            )
            .returning(AgentEventRow.seq)
        )

    async def forget_room(
        self, session: AsyncSession, *, agent_id: str, room_id: str
    ) -> None:
        """Delete the agent's own events in one room, in the caller's
        transaction, which is the one that takes the agent out of the room.

        Sequence numbers are untouched and no gap is recorded: a reader that
        skips these has missed nothing it was entitled to, and saying
        otherwise would send it to re-read the context of a room it is not in.

        The agent's row in `agent_event_heads` is locked first, the lock
        `store` takes to number an event. An event the router was storing for
        the room while this waited has then committed, and is deleted here;
        one it stores after this commits finds the membership gone and is not
        stored. Without the lock a message written as the agent was removed
        could leave an event behind in a room it is no longer in, which a
        stream resuming from an old position would hand it.
        """
        await session.execute(
            insert(AgentEventHead)
            .from_select(
                [
                    AgentEventHead.tenant_id,
                    AgentEventHead.agent_id,
                    AgentEventHead.first_seq,
                    AgentEventHead.last_seq,
                ],
                select(
                    Agent.tenant_id,
                    Agent.id,
                    literal(self.sequence_floor, BigInteger),
                    literal(self.sequence_floor - 1, BigInteger),
                ).where(Agent.id == agent_id),
            )
            .on_conflict_do_update(
                index_elements=[AgentEventHead.agent_id],
                set_={"last_seq": AgentEventHead.last_seq},
            )
        )
        result = await session.execute(
            delete(AgentEventRow).where(
                AgentEventRow.agent_id == agent_id,
                AgentEventRow.room_id == room_id,
            )
        )
        dropped = result.rowcount or 0  # type: ignore[attr-defined]
        if dropped:
            logger.info(
                "[EVENT-BUF] dropped %s retained event(s) for agent=%s room=%s: "
                "no longer a member",
                dropped,
                agent_id,
                room_id,
            )

    async def enqueue(
        self,
        tenant_id: str,
        agent_id: str,
        room_id: str,
        event: AgentEvent,
        *,
        room_seq: int,
        message_key: str | None,
    ) -> int:
        """Store an event meant for the agent as an own event, in a transaction
        of its own, and return its number.

        For an event decided after the room row it comes from has committed:
        a room command's handler (`bridges/agent/commands.py`) queues the
        command for the agent only once it has checked the agent's session and
        answered in the room. Everything decided as the row is written goes
        through `store` instead.

        The number comes from the agent's row in `agent_event_heads`, which is
        advanced in the same transaction as the insert into `agent_events`, so
        numbers are contiguous and never handed out twice, even after older
        own events have been deleted. `room_seq` and `message_key` identify the
        `messages` row the event came from, so that conversation reads and
        unread counts can recognise that row as already delivered.

        A write that fails because the database connection or the pool did is
        retried after each of `ENQUEUE_RETRY_DELAYS`. Nothing else will store
        this event, so one not stored here is never stored.
        """
        for delay in (*ENQUEUE_RETRY_DELAYS, None):
            try:
                seq = await self._store_own_event(
                    tenant_id, agent_id, room_id, event, room_seq, message_key
                )
                break
            except Exception as exc:
                if delay is None or not transient_failure(exc):
                    raise
                logger.warning(
                    "[EVENT-BUF] storing an own event for agent %s in room %s "
                    "failed (%s); retrying in %ss",
                    agent_id,
                    room_id,
                    type(exc).__name__,
                    delay,
                )
                await asyncio.sleep(delay)
        logger.debug(
            "[EVENT-BUF] append agent=%s room=%s type=%s seq=%s",
            agent_id,
            room_id,
            event.type,
            seq,
        )
        self.ring(agent_id)
        return seq

    async def _store_own_event(
        self,
        tenant_id: str,
        agent_id: str,
        room_id: str,
        event: AgentEvent,
        room_seq: int,
        message_key: str | None,
    ) -> int:
        """Number one own event and insert it, in one transaction, unless an
        event from the same source is already stored, and return its number.

        The source is `(message_key, room_id, room_seq, type)`
        (`uq_agent_events_source`): a write retried after a commit whose
        acknowledgement was lost repeats one that was made, and would
        otherwise give the agent the same event twice under two numbers. When
        another write of the same source lands between the lookup and the
        insert, the insert does nothing and the transaction is rolled back,
        which also gives back the number it took.
        """
        source = (
            select(AgentEventRow.seq).where(
                AgentEventRow.agent_id == agent_id,
                AgentEventRow.message_key == message_key,
                AgentEventRow.room_id == room_id,
                AgentEventRow.room_seq == room_seq,
                AgentEventRow.type == event.type,
            )
            if message_key is not None
            else None
        )
        async with tenant_session(self._session_factory, tenant_id) as session:
            if source is not None:
                stored = await session.scalar(source)
                if stored is not None:
                    return int(stored)
            seq = (await session.execute(self._claim(tenant_id, agent_id))).scalar_one()
            inserted = await session.scalar(
                self._own_event_insert(
                    select(
                        literal(tenant_id, Text),
                        literal(agent_id, Text),
                        literal(seq, BigInteger),
                        literal(room_id, Text),
                        literal(room_seq, BigInteger),
                        literal(message_key, Text),
                        literal(event.type, Text),
                        literal(event.model_dump(mode="json"), JSONB),
                        literal(is_notifiable(event), Boolean),
                    )
                )
            )
            if inserted is None:
                await session.rollback()
                assert source is not None
                stored = await session.scalar(source)
                assert stored is not None
                logger.info(
                    "[EVENT-BUF] own event for agent %s from %s was already stored "
                    "as %s",
                    agent_id,
                    message_key,
                    stored,
                )
                return int(stored)
            await session.commit()
        return int(seq)

    # ------------------------------------------------------------------
    # The agent's own events
    # ------------------------------------------------------------------

    async def read_from(
        self,
        tenant_id: str,
        agent_id: str,
        after_seq: int,
        *,
        rooms: set[str] | None = None,
        notifiable_only: bool = False,
        limit: int | None = None,
        through_seq: int | None = None,
    ) -> list[BufferedEvent]:
        """The agent's own events numbered after `after_seq`, oldest first.

        `rooms=None` reads own events from every room; otherwise only own events from the
        given rooms. `through_seq`, when given, is an upper bound the caller
        read before calling. The read stops there, so the caller can move its
        position to that bound knowing it was handed every own event up to it.
        Raises `CursorExpiredError` if `expire` has deleted own events numbered
        after `after_seq`.
        """
        started = time.perf_counter()
        query = (
            select(AgentEventRow)
            .where(
                AgentEventRow.agent_id == agent_id,
                AgentEventRow.seq > after_seq,
                AgentEventRow.type.not_in(RETIRED_EVENT_TYPES),
            )
            .order_by(AgentEventRow.seq)
        )
        if rooms is not None:
            query = query.where(AgentEventRow.room_id.in_(rooms))
        if notifiable_only:
            query = query.where(AgentEventRow.notifiable.is_(True))
        if through_seq is not None:
            query = query.where(AgentEventRow.seq <= through_seq)
        if limit is not None:
            query = query.limit(limit)
        async with tenant_session(self._session_factory, tenant_id) as session:
            rows = (await session.scalars(query)).all()
        # Checked after the read, not before. `expire` deletes rows and records
        # what it deleted in one transaction. A deletion that commits before
        # the read above is recorded by the time of this check, so a reader is
        # never handed the events after a deleted one as if nothing were
        # missing. Checked first, a deletion landing between the check and the
        # read would go unreported. One landing after the read is reported
        # too, though the rows were read: a spare gap, never a silent one.
        await self.check_cursor(tenant_id, agent_id, after_seq)
        out = [
            BufferedEvent(
                seq=row.seq,
                room_id=row.room_id,
                event=AgentEvent.model_validate(row.payload),
                notifiable=row.notifiable,
                source=OWN_EVENTS,
                room_seq=row.room_seq,
                at=_epoch(row.created_at),
            )
            for row in rows
        ]
        self._record_scan(_READ, len(out), started)
        return out

    async def wait(self, agent_id: str, timeout: float) -> None:
        """Block until an event is appended for the agent, or the timeout passes.

        A wake-up is advisory: callers re-read from their position rather than
        trusting this to deliver anything.
        """
        notify = self._notify.setdefault(agent_id, asyncio.Event())
        notify.clear()
        try:
            await asyncio.wait_for(notify.wait(), timeout=timeout)
        except TimeoutError:
            return

    def doorbell(self, agent_id: str) -> asyncio.Event:
        """The agent's doorbell, shared by every reader of the agent in this process.

        It is set whenever an own event is inserted for the agent, by this process or
        by another one. A reader that wakes re-reads from its own position. The
        signal carries no payload, so a spurious or missed wake-up costs
        latency, never correctness.
        """
        return self._notify.setdefault(agent_id, asyncio.Event())

    def ring(self, agent_id: str) -> None:
        """Set the agent's doorbell in this process.

        `enqueue` calls this after inserting an own event, and the notification
        listener calls it when another process inserts one.
        """
        notify = self._notify.get(agent_id)
        if notify is not None:
            notify.set()

    def ring_everyone(self) -> None:
        """Set every doorbell in this process.

        The notification listener calls this each time it starts listening on
        a Postgres connection, because it may have missed notifications while
        it was not listening.
        """
        for notify in self._notify.values():
            notify.set()

    async def head(self, tenant_id: str, agent_id: str) -> int:
        """The number of the agent's newest own event, or the number just
        before its first one if it has none yet. This is the agent's head."""
        query = select(AgentEventHead.last_seq).where(
            AgentEventHead.agent_id == agent_id
        )
        async with tenant_session(self._session_factory, tenant_id) as session:
            last = await session.scalar(query)
            if last is None:
                await self._start_numbering(session, {agent_id})
                last = await session.scalar(query)
        return self.sequence_floor - 1 if last is None else last

    async def heads(self, tenant_id: str, agent_ids: set[str]) -> dict[str, int]:
        """`head` for several agents in one query, for a connection that
        serves many agents."""

        def query(ids: set[str]) -> Any:
            return select(AgentEventHead.agent_id, AgentEventHead.last_seq).where(
                AgentEventHead.agent_id.in_(ids)
            )

        async with tenant_session(self._session_factory, tenant_id) as session:
            found = dict((await session.execute(query(agent_ids))).tuples().all())
            missing = agent_ids - found.keys()
            if missing:
                await self._start_numbering(session, missing)
                found.update((await session.execute(query(missing))).tuples().all())
        return {
            agent_id: found.get(agent_id, self.sequence_floor - 1)
            for agent_id in agent_ids
        }

    async def first_seq(self, tenant_id: str, agent_id: str) -> int:
        """The number of the agent's first own event.

        A number below it was handed out before the agent had any own events in
        `agent_events`, so nothing the server holds corresponds to it.
        """
        query = select(AgentEventHead.first_seq).where(
            AgentEventHead.agent_id == agent_id
        )
        async with tenant_session(self._session_factory, tenant_id) as session:
            first = await session.scalar(query)
            if first is None:
                await self._start_numbering(session, {agent_id})
                first = await session.scalar(query)
        return self.sequence_floor if first is None else first

    async def _start_numbering(
        self, session: AsyncSession, agent_ids: set[str]
    ) -> None:
        """Give each agent that has no row in `agent_event_heads` one, numbering
        its own events from this process's `sequence_floor`.

        Called the first time a process reads an agent's head, not only when
        the first own event is written. Processes started at different boots
        have different floors. If each answered from its own floor until the
        first event was written, a reader placed at the head one process
        reported could find the first event numbered below it by another
        process, and never receive it. Once the row exists, every process
        numbers the agent from it. The row is selected from `agents`, so an
        agent deleted meanwhile gets none.
        """
        await session.execute(
            insert(AgentEventHead)
            .from_select(
                [
                    AgentEventHead.tenant_id,
                    AgentEventHead.agent_id,
                    AgentEventHead.first_seq,
                    AgentEventHead.last_seq,
                ],
                select(
                    Agent.tenant_id,
                    Agent.id,
                    literal(self.sequence_floor, BigInteger),
                    literal(self.sequence_floor - 1, BigInteger),
                ).where(Agent.id.in_(agent_ids)),
            )
            .on_conflict_do_nothing(index_elements=[AgentEventHead.agent_id])
        )
        await session.commit()

    async def oldest_retained(self, tenant_id: str, agent_id: str) -> int:
        """The number of the agent's oldest own event still in `agent_events`, or 0
        if it has none."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            oldest = await session.scalar(
                select(func.min(AgentEventRow.seq)).where(
                    AgentEventRow.agent_id == agent_id
                )
            )
        return oldest or 0

    async def rooms_dropped_after(
        self, tenant_id: str, agent_id: str, after_seq: int
    ) -> tuple[str, ...]:
        """The rooms in which `expire` deleted own events numbered after
        `after_seq`, so a reader at `after_seq` has missed events there."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            rooms = (
                await session.scalars(
                    select(AgentEventDrop.room_id).where(
                        AgentEventDrop.agent_id == agent_id,
                        AgentEventDrop.dropped_through > after_seq,
                    )
                )
            ).all()
        return tuple(sorted(rooms))

    # ------------------------------------------------------------------
    # The rooms' conversation
    # ------------------------------------------------------------------

    async def member_rooms(self, tenant_id: str, agent_id: str) -> set[str]:
        """The rooms the agent is in now."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            rooms = (
                await session.scalars(
                    select(ClientRoom.room_id)
                    .join(Agent, Agent.client_id == ClientRoom.client_id)
                    .where(Agent.id == agent_id)
                )
            ).all()
        return set(rooms)

    async def room_heads(self, tenant_id: str, room_ids: set[str]) -> dict[str, int]:
        """Each room's highest `messages.seq`, or 0 for a room with no rows yet."""
        if not room_ids:
            return {}
        async with tenant_session(self._session_factory, tenant_id) as session:
            rows = (
                await session.execute(
                    select(Message.room_id, func.max(Message.seq))
                    .where(Message.room_id.in_(room_ids))
                    .group_by(Message.room_id)
                )
            ).all()
        found = {room_id: head for room_id, head in rows}
        return {room_id: max(found.get(room_id) or 0, 0) for room_id in room_ids}

    async def within_rooms(
        self, tenant_id: str, position: Position
    ) -> tuple[Position, list[str]]:
        """`position` with each room's number lowered to the room's highest
        `messages.seq` where it was higher, and the rooms that were lowered.

        A number beyond the end of a room can only come from a different
        history of the database, for example after a restore from backup. If
        it were kept, the reader would silently skip that many of the room's
        next messages, because a position never moves backwards.
        """
        rooms = {
            room_id for source in position if (room_id := room_of(source)) is not None
        }
        clamped = dict(position)
        past: list[str] = []
        for room_id, head in (await self.room_heads(tenant_id, rooms)).items():
            source = room_source(room_id)
            if clamped[source] > head:
                clamped[source] = head
                past.append(room_id)
        return clamped, sorted(past)

    async def room_window_starts(
        self, tenant_id: str, room_ids: set[str]
    ) -> dict[str, int]:
        """For each room, the `messages.seq` of its newest row older than the
        retention window, or 0 if there is none.

        A reader with no number for a room starts reading there, and a room
        with no unread baseline starts counting there, so both cover the same
        span of time that own events are kept for.
        """
        if not room_ids:
            return {}
        cutoff = datetime.now(UTC) - timedelta(seconds=self._retention_seconds)
        async with tenant_session(self._session_factory, tenant_id) as session:
            return {
                room_id: max(
                    await session.scalar(_window_start(room_id, cutoff)) or 0, 0
                )
                for room_id in room_ids
            }

    async def read_conversation(
        self,
        tenant_id: str,
        agent_id: str,
        after: dict[str, int],
        *,
        limit: int,
    ) -> Conversation:
        """The conversation in each room of `after`, read from `messages`
        after the room's number in `after`.

        A row is delivered when it is a message or a join by someone other
        than the agent, sent after the agent joined the room, and not already
        an own event. Whether a row is one of the agent's own events is decided
        as the row is written, and committed with it (`store`), so a row that
        can be read here is already decided and is delivered at once.

        The one row still undecided when it can be read is a file of a
        multi-file post whose other files have not all been written: the post
        is decided once, as a whole, when its last file arrives or when the
        router gives up waiting for it (`PendingAttachmentGroup`). The read
        stops at the first file of such a post, so the post is delivered by a
        later read as one event rather than in pieces.

        One transient case breaks the rule. During a rolling deploy a process
        still on the release before the router writes a room row without
        deciding it, and leaves the decision to its agent consumers a moment
        later. A read that lands in between delivers the row as conversation,
        and the agent receives it again as an own event if a consumer then
        decides it is one.
        """
        if not after:
            return Conversation()
        started = time.perf_counter()
        events: list[BufferedEvent] = []
        through: dict[str, int] = {}
        cut: dict[str, float] = {}
        async with tenant_session(self._session_factory, tenant_id) as session:
            me = await session.execute(
                select(Client.transport_user_id, Client.id)
                .join(Agent, Agent.client_id == Client.id)
                .where(Agent.id == agent_id)
            )
            identity = me.first()
            if identity is None:
                return Conversation()
            my_sender, my_client = identity
            joined: dict[str, Any] = {
                room_id: joined_at
                for room_id, joined_at in (
                    await session.execute(
                        select(ClientRoom.room_id, ClientRoom.joined_at).where(
                            ClientRoom.client_id == my_client,
                            ClientRoom.room_id.in_(after),
                        )
                    )
                ).all()
            }
            rooms = {
                room.id: room
                for room in (
                    await session.scalars(select(Room).where(Room.id.in_(after)))
                ).all()
            }
            for room_id, after_seq in sorted(after.items()):
                room = rooms.get(room_id)
                if room is None or room_id not in joined:
                    continue
                # Whether a file's post is still pending is read in the same
                # statement as the rows: the file that completes a post
                # writes its row and deletes the pending one in one commit,
                # so one snapshot shows a post either whole or pending, never
                # a lone first file that is neither.
                pending = (
                    select(PendingAttachmentGroup.group_id)
                    .where(
                        PendingAttachmentGroup.room_id == Message.room_id,
                        PendingAttachmentGroup.group_id
                        == Message.content[ATTACHMENT_GROUP_KEY]["id"].astext,
                    )
                    .exists()
                )
                found = (
                    await session.execute(
                        select(Message, pending)
                        .where(
                            Message.room_id == room_id,
                            Message.seq > max(after_seq, 0),
                        )
                        .order_by(Message.seq)
                        .limit(limit + 1)
                    )
                ).all()
                if not found:
                    continue
                more = len(found) > limit
                found = found[:limit]
                rows = [row for row, _ in found]
                if more:
                    cut[room_id] = _epoch(cast(datetime, rows[-1].sent_at))
                room_events, room_through = await self._conversation_in(
                    session,
                    room,
                    rows,
                    my_sender=my_sender,
                    joined_at=joined[room_id],
                    agent_id=agent_id,
                    pending_rows={row.id for row, held in found if held},
                )
                events.extend(room_events)
                if room_through > after_seq:
                    through[room_id] = room_through
        self._record_scan(_READ, len(events), started)
        return Conversation(events=events, through=through, cut=cut)

    async def _conversation_in(
        self,
        session: AsyncSession,
        room: Room,
        rows: list[Message],
        *,
        my_sender: str,
        joined_at: Any,
        agent_id: str,
        pending_rows: set[str],
    ) -> tuple[list[BufferedEvent], int]:
        """Turn one room's rows into conversation events, and return them with
        the `messages.seq` of the last row examined. `pending_rows` are the
        ids of the rows whose multi-file post was still pending when the rows
        were read."""
        # For each message key, the highest room row an own event for that message
        # was delivered through. A row at or below it is already an own event and is
        # skipped. A file of a multi-file message that arrives after the own event
        # for its group was written is above that row, so it is delivered as
        # conversation.
        keys = {message_key(row) for row in rows}
        delivered_through: dict[str, int] = {
            key: seq
            for key, seq in (
                await session.execute(
                    select(AgentEventRow.message_key, func.max(AgentEventRow.room_seq))
                    .where(
                        AgentEventRow.agent_id == agent_id,
                        AgentEventRow.message_key.in_(keys),
                    )
                    .group_by(AgentEventRow.message_key)
                )
            ).all()
        }

        def already_an_own_event(row: Message) -> bool:
            return row.seq <= delivered_through.get(message_key(row), -1)

        attachments: dict[str, list[MessageAttachment]] = {}
        message_ids = [row.id for row in rows if row.event_type == "m.room.message"]
        if message_ids:
            for attachment in (
                await session.scalars(
                    select(MessageAttachment)
                    .where(MessageAttachment.message_id.in_(message_ids))
                    .order_by(MessageAttachment.message_id, MessageAttachment.position)
                )
            ).all():
                attachments.setdefault(attachment.message_id, []).append(attachment)

        # The files of each multi-file message present in `rows`, keyed by
        # attachment group id, as (index, total, row).
        groups: dict[str, list[tuple[int, int, Message]]] = {}
        for row in rows:
            if already_an_own_event(row):
                continue
            group = parse_attachment_group(row.content or {})
            if group is not None:
                groups.setdefault(group[0], []).append((group[1], group[2], row))

        # A group the router has not decided yet, because its files are still
        # arriving, stops the read at its first file, so the whole group is
        # delivered by a later read instead of in pieces.
        undecided = {
            group_id
            for group_id, parts in groups.items()
            if any(row.id in pending_rows for _, _, row in parts)
        }
        held_from: int | None = None
        for group_id in undecided:
            first = min(row.seq for _, _, row in groups[group_id])
            held_from = first if held_from is None else min(held_from, first)
        # A group goes out at its last file, so one with a file before the
        # hold and its last file at or after it would not go out in this read,
        # while the read's place moved past its earlier files. The next read
        # would then find only the later files and send the group without
        # them. Such a group is held from its first file too, which can reach
        # back to another group that starts earlier.
        spans = [
            (min(row.seq for _, _, row in parts), max(row.seq for _, _, row in parts))
            for parts in groups.values()
        ]
        while held_from is not None:
            spanning = [first for first, last in spans if first < held_from <= last]
            if not spanning:
                break
            held_from = min(spanning)

        member_names = await self._member_names(
            session,
            {
                row.sender_id
                for row in rows
                if row.event_type == "m.room.member" and row.sender_id != my_sender
            },
        )

        events: list[BufferedEvent] = []
        through = 0
        for row in rows:
            if held_from is not None and row.seq >= held_from:
                break
            through = row.seq
            if row.sender_id == my_sender or row.sent_at < joined_at:
                continue
            if already_an_own_event(row):
                continue
            key = message_key(row)
            inbound = to_inbound(
                row, attachments.get(row.id, []), transport_room_id=room.id
            )
            event: AgentEvent | None = None
            seq = row.seq
            if isinstance(inbound, InboundMembership):
                if inbound.membership != "join" or inbound.prev_membership == "join":
                    continue
                event = room_join_event(
                    room_id=room.id,
                    bridge_id=room.bridge_id,
                    channel_type=room.channel_type,
                    member=inbound.state_key,
                    member_name=member_names.get(inbound.state_key)
                    or inbound.display_name
                    or inbound.state_key.split(":")[0].lstrip("@"),
                    timestamp=inbound.timestamp,
                    listening=False,
                )
            elif isinstance(inbound, InboundMedia) and key in groups:
                # A multi-file message goes out once, at its last file, which is
                # the room row its event is numbered by. A message posted
                # between its files goes out before it, so a room's events go
                # out in rising order. Were the group sent at its first file, a
                # client that disconnected right after it would hold a place
                # past the message in between and never receive that message.
                if row.seq != max(part.seq for _, _, part in groups[key]):
                    continue
                event, seq = self._grouped_media(
                    room, inbound, groups[key], attachments
                )
            elif isinstance(inbound, InboundMedia):
                event = message_event(
                    room_id=room.id,
                    bridge_id=room.bridge_id,
                    channel_type=room.channel_type,
                    event=inbound,
                    addressed=False,
                    sender_name=inbound.sender_name or inbound.sender,
                    body=inbound.body,
                    thread_id=inbound.thread_root_id,
                    attachments=[attachment_ref(inbound)],
                )
            elif isinstance(inbound, InboundMessage):
                event = message_event(
                    room_id=room.id,
                    bridge_id=room.bridge_id,
                    channel_type=room.channel_type,
                    event=inbound,
                    addressed=False,
                    sender_name=inbound.sender_name or inbound.sender,
                    body=inbound.body,
                    thread_id=None
                    if platform_replies_in_channel(inbound.content)
                    else inbound.thread_root_id,
                )
            if event is None:
                continue
            events.append(
                BufferedEvent(
                    seq=seq,
                    room_id=room.id,
                    event=event,
                    notifiable=False,
                    source=room_source(room.id),
                    room_seq=seq,
                    at=_epoch(cast(datetime, row.sent_at)),
                )
            )
        return events, through

    def _grouped_media(
        self,
        room: Room,
        lead_inbound: InboundMedia,
        parts: list[tuple[int, int, Message]],
        attachments: dict[str, list[MessageAttachment]],
    ) -> tuple[AgentEvent, int]:
        """Build one message event from the files of a multi-file message, and
        return it with the highest room row among the files.

        The event is based on the lowest-numbered file present, which carries
        the caption and the message id the sender was given. When files are
        missing, the body says how many arrived, as the own event the router
        makes of an incomplete post does.
        """
        ordered = sorted(parts, key=lambda part: part[0])
        total = ordered[0][1]
        lead = ordered[0][2]
        refs = []
        for _, _, row in ordered:
            inbound = to_inbound(
                row, attachments.get(row.id, []), transport_room_id=room.id
            )
            if isinstance(inbound, InboundMedia):
                refs.append(attachment_ref(inbound))
        anchor = to_inbound(
            lead, attachments.get(lead.id, []), transport_room_id=room.id
        )
        if not isinstance(anchor, InboundMedia):
            anchor = lead_inbound
        body = anchor.body
        present = len({index for index, _, _ in ordered})
        if present < total:
            notice = (
                f"[incomplete attachment group: {present} of {total} files arrived]"
            )
            body = f"{body}\n{notice}" if body else notice
        event = message_event(
            room_id=room.id,
            bridge_id=room.bridge_id,
            channel_type=room.channel_type,
            event=anchor,
            addressed=False,
            sender_name=anchor.sender_name or anchor.sender,
            body=body,
            thread_id=anchor.thread_root_id,
            attachments=refs,
        )
        return event, max(row.seq for _, _, row in ordered)

    async def _member_names(
        self, session: AsyncSession, transport_ids: set[str]
    ) -> dict[str, str]:
        if not transport_ids:
            return {}
        rows = (
            await session.execute(
                select(Client.transport_user_id, Client.display_name).where(
                    Client.transport_user_id.in_(transport_ids)
                )
            )
        ).all()
        return {transport_id: name for transport_id, name in rows}

    # ------------------------------------------------------------------
    # Reading a position
    # ------------------------------------------------------------------

    async def read(
        self,
        tenant_id: str,
        agent_id: str,
        position: Position,
        *,
        conversation_rooms: set[str],
        notifiable_only: bool = False,
        own_event_rooms: set[str] | None = None,
        limit: int,
    ) -> tuple[list[BufferedEvent], Position]:
        """The agent's own events and its rooms' conversation after `position`, in
        the order they happened, and how far each source was read.

        Own events are read up to the agent's head as it was before the read, so the
        returned position never moves past an own event inserted during the read.
        Events from one source keep that source's order, and events from
        different sources are interleaved by time. Each room in
        `conversation_rooms` is read from its number in `position`; a room with
        no number in `position` is not read.
        """
        after = position.get(OWN_EVENTS, self.sequence_floor - 1)
        bound = await self.head(tenant_id, agent_id)
        own_events = await self.read_from(
            tenant_id,
            agent_id,
            after,
            rooms=own_event_rooms,
            notifiable_only=notifiable_only,
            limit=limit,
            through_seq=bound,
        )
        looked: Position = {}
        if len(own_events) < limit and bound > after:
            looked[OWN_EVENTS] = bound
        conversation = await self.read_conversation(
            tenant_id,
            agent_id,
            {
                room_id: position[room_source(room_id)]
                for room_id in conversation_rooms
                if room_source(room_id) in position
            },
            limit=limit,
        )
        for room_id, seq in conversation.through.items():
            looked[room_source(room_id)] = seq
        events = _interleaved([own_events, *_by_source(conversation.events)])
        # A source cut short at `limit` has more to read after the last row it
        # returned. An event from another source that happened later than that
        # row waits for the next read, or it would overtake the cut source's
        # later events. The events go out as a prefix of the merged order,
        # with at least one event, so every read moves forward even when
        # clocks disagree. A source with an event held back keeps its position
        # at the last event sent, so the next read finds the event again.
        cut = {room_source(room_id): at for room_id, at in conversation.cut.items()}
        if len(own_events) >= limit:
            cut[OWN_EVENTS] = own_events[-1].at
        if cut:
            kept = len(events)
            for index, item in enumerate(events[1:], start=1):
                if any(
                    item.at > at for source, at in cut.items() if source != item.source
                ):
                    kept = index
                    break
            for source in {item.source for item in events[kept:]}:
                looked.pop(source, None)
            events = events[:kept]
        return events, looked

    # ------------------------------------------------------------------
    # Tickets, for clients that hold one number
    # ------------------------------------------------------------------

    async def mint_tickets(
        self, tenant_id: str, agent_id: str, positions: list[Position]
    ) -> list[int]:
        """Store each position in `agent_position_tickets` and return the ticket
        ids, in order.

        A client that can hold only one integer is sent a ticket id. When it
        sends the id back, `ticket` returns the stored position.
        """
        if not positions:
            return []
        ids: list[int] = []
        async with tenant_session(self._session_factory, tenant_id) as session:
            for position in positions:
                ticket = await session.scalar(
                    insert(AgentPositionTicket)
                    .values(tenant_id=tenant_id, agent_id=agent_id, position=position)
                    .returning(AgentPositionTicket.id)
                )
                assert ticket is not None
                ids.append(ticket)
            await session.commit()
        return ids

    async def ticket(
        self, tenant_id: str, agent_id: str, ticket_id: int
    ) -> Position | None:
        """The position stored under a ticket id, or None when the ticket does
        not exist, has been deleted by `expire`, or belongs to another agent."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            position = await session.scalar(
                select(AgentPositionTicket.position).where(
                    AgentPositionTicket.id == ticket_id,
                    AgentPositionTicket.agent_id == agent_id,
                )
            )
        return dict(position) if position is not None else None

    # ------------------------------------------------------------------
    # Unread counts
    # ------------------------------------------------------------------

    async def ensure_counting(
        self, tenant_id: str, agent_id: str, reader_id: str, room_id: str
    ) -> None:
        """Start counting unread messages in a room that a connection
        delivers, unless the room already has a row in `agent_room_reads`.

        A connection carries every session of an agent and delivers the union
        of their rooms, so delivering a room does not mean being in it. A
        connection listing the rooms it delivers must not take a room from the
        session that is in it, so an existing row is left unchanged. A new
        row's baseline is the room's current end, so the count starts now.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            await session.execute(
                _counting(
                    agent_id,
                    room_id,
                    baseline=_room_head(room_id),
                    occupant=Reader(id=reader_id, is_session=False),
                ).on_conflict_do_nothing(
                    index_elements=[AgentRoomRead.agent_id, AgentRoomRead.room_id]
                )
            )
            await session.commit()

    async def take_counting(
        self, tenant_id: str, agent_id: str, reader_id: str, room_id: str
    ) -> None:
        """Record that a connection has taken this room from whoever held it.

        This is for callers where the room itself changes hands and the
        registry has granted the takeover. The connection becomes the occupant
        in `agent_room_reads`, the only reader whose reads clear the room's
        unread count. The baseline is kept, so messages the room had not caught
        up on are still counted after the change.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            await session.execute(
                _counting(
                    agent_id,
                    room_id,
                    baseline=_room_head(room_id),
                    occupant=Reader(id=reader_id, is_session=False),
                ).on_conflict_do_update(
                    index_elements=[AgentRoomRead.agent_id, AgentRoomRead.room_id],
                    set_={"occupant_id": reader_id, "occupant_is_session": False},
                )
            )
            await session.commit()

    async def hand_counting_to(
        self, tenant_id: str, agent_id: str, reader: Reader, room_id: str
    ) -> None:
        """Record that `reader` is now the reader in the room.

        Connecting to a room takes it, so the new reader becomes the only one
        whose reads clear the room's unread count. The baseline is kept, so
        messages the room had not caught up on are still counted after the
        change. A room with no row yet gets a baseline at the start of the
        retention window, which is as far back as a count can reach.
        """
        start = (await self.room_window_starts(tenant_id, {room_id}))[room_id]
        async with tenant_session(self._session_factory, tenant_id) as session:
            await session.execute(
                _counting(
                    agent_id, room_id, baseline=literal(start), occupant=reader
                ).on_conflict_do_update(
                    index_elements=[AgentRoomRead.agent_id, AgentRoomRead.room_id],
                    set_={
                        "occupant_id": reader.id,
                        "occupant_is_session": reader.is_session,
                    },
                )
            )
            await session.commit()

    async def caught_up(
        self,
        tenant_id: str,
        agent_id: str,
        reader: Reader,
        room_id: str,
        through_seq: int,
        arrived_on: str | None,
    ) -> None:
        """Record that the room's occupant has read the room through
        `through_seq`, a `messages.seq` in that room.

        The baseline only moves forward, and only for the room named. A call
        from any reader other than the occupant is ignored. A read starts
        before its history arrives, so a session displaced while its read was
        in flight comes back with a result for a room it has left, and must not
        clear the new occupant's count. The one exception is a session taking
        the room over from the connection it arrived on (`arrived_on`); it
        cannot take it over from any other reader.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            held = await session.scalar(
                select(AgentRoomRead)
                .where(
                    AgentRoomRead.agent_id == agent_id,
                    AgentRoomRead.room_id == room_id,
                )
                .with_for_update()
            )
            if held is None:
                session.add(
                    AgentRoomRead(
                        tenant_id=tenant_id,
                        agent_id=agent_id,
                        room_id=room_id,
                        caught_up_seq=through_seq,
                        occupant_id=reader.id,
                        occupant_is_session=reader.is_session,
                    )
                )
                await session.commit()
                return
            occupant = Reader(id=held.occupant_id, is_session=held.occupant_is_session)
            if occupant != reader:
                if not reader.is_session:
                    return
                if occupant.is_session or occupant.id != arrived_on:
                    return
                held.occupant_id = reader.id
                held.occupant_is_session = True
            if through_seq > held.caught_up_seq:
                held.caught_up_seq = through_seq
            await session.commit()

    async def unread(
        self, tenant_id: str, agent_id: str, room_id: str, through_seq: int
    ) -> Unread:
        """Count the unaddressed messages in one room that the agent has not
        caught up on, up to `through_seq`, a `messages.seq` in that room.

        The count is computed from `messages` when asked, so it always agrees
        with the room's log. It counts messages only, leaving out the ones the agent
        sent and the ones that became own events, because it tells the agent how much
        conversation went past it. Several files posted as one message count
        once. The count never reaches further back than the retention window:
        older own events have been deleted, so older messages addressed to the agent
        can no longer be told apart. A count cut at the window says so in its
        `reason`.
        """
        counts = await self.unread_batch(tenant_id, agent_id, [(room_id, through_seq)])
        return counts[(room_id, through_seq)]

    async def unread_batch(
        self,
        tenant_id: str,
        agent_id: str,
        positions: Iterable[tuple[str, int]],
    ) -> dict[tuple[str, int], Unread]:
        """`unread` for every (room, `messages.seq`) pair in `positions`, keyed
        by the pair.

        A stream catching an agent up reports a count alongside every event it
        is woken for, up to a few hundred in one batch. Counted one at a time,
        each count read the room's baseline, its retention window and the
        agent's own user id again, then rescanned the same stretch of the
        room's log. Here the agent's baselines and user id are read once, and
        each room in the batch costs two statements however many positions are
        asked of it: its window start, and one scan that counts at all of its
        positions together (`_UNREAD_SQL`). The counts are the ones `unread`
        gives for each pair on its own.
        """
        wanted: dict[str, set[int]] = {}
        for room_id, through_seq in positions:
            wanted.setdefault(room_id, set()).add(through_seq)
        if not wanted:
            return {}
        counts: dict[tuple[str, int], Unread] = {}
        async with tenant_session(self._session_factory, tenant_id) as session:
            baselines: dict[str, int] = {
                room_id: seq
                for room_id, seq in (
                    await session.execute(
                        select(
                            AgentRoomRead.room_id, AgentRoomRead.caught_up_seq
                        ).where(
                            AgentRoomRead.agent_id == agent_id,
                            AgentRoomRead.room_id.in_(wanted),
                        )
                    )
                ).all()
            }
            for room_id in wanted.keys() - baselines.keys():
                for through_seq in wanted[room_id]:
                    counts[(room_id, through_seq)] = Unread(
                        count=None, reason=NO_BASELINE
                    )
            if not baselines:
                return counts
            me = await session.scalar(
                select(Client.transport_user_id)
                .join(Agent, Agent.client_id == Client.id)
                .where(Agent.id == agent_id)
            )
            cutoff = datetime.now(UTC) - timedelta(seconds=self._retention_seconds)
            for room_id, baseline in baselines.items():
                window_start = await session.scalar(_window_start(room_id, cutoff)) or 0
                reason = None
                if baseline < window_start:
                    baseline, reason = window_start, COUNTED_FROM_WINDOW
                throughs = sorted(wanted[room_id])
                started = time.perf_counter()
                at = {
                    through: count
                    for through, count in (
                        await session.execute(
                            _UNREAD_SQL,
                            {
                                "room_id": room_id,
                                "baseline": baseline,
                                "through": throughs[-1],
                                "throughs": throughs,
                                "me": me or "",
                                "agent_id": agent_id,
                            },
                        )
                    ).all()
                }
                # One scan of the room's log, recorded with what it counted at
                # the furthest position asked, which every other count is part of.
                self._record_scan(_UNREAD, at[throughs[-1]] or 0, started)
                for through_seq in throughs:
                    counts[(room_id, through_seq)] = Unread(
                        count=at[through_seq] or 0, reason=reason
                    )
        return counts

    # ------------------------------------------------------------------
    # Leaving
    # ------------------------------------------------------------------

    def remove(self, agent_id: str) -> None:
        """Forget this process's doorbell for an agent.

        The agent's rows in the tables this module uses are deleted with its
        row in `agents` (`ON DELETE CASCADE`).
        """
        self._notify.pop(agent_id, None)

    # ------------------------------------------------------------------
    # Retention
    # ------------------------------------------------------------------

    async def expire(self, tenant_id: str) -> int:
        """Delete one tenant's own events and tickets older than the retention window.

        For each agent and room it records the newest own event it deleted in
        `agent_event_drops`, so a reader resuming from before that own event is told
        it missed events there. Retention is independent of what readers have confirmed: an
        event stays readable for its window whether or not somebody has already
        consumed it, so a reader that arrives late still sees recent history.
        """
        cutoff = datetime.now(UTC) - timedelta(seconds=self._retention_seconds)
        async with tenant_session(self._session_factory, tenant_id) as session:
            deleted = (
                await session.execute(
                    delete(AgentEventRow)
                    .where(AgentEventRow.created_at < cutoff)
                    .returning(
                        AgentEventRow.agent_id, AgentEventRow.room_id, AgentEventRow.seq
                    )
                )
            ).all()
            through: dict[tuple[str, str], int] = {}
            for agent_id, room_id, seq in deleted:
                key = (agent_id, room_id)
                through[key] = max(seq, through.get(key, 0))
            for (agent_id, room_id), seq in through.items():
                await session.execute(
                    insert(AgentEventDrop)
                    .values(
                        tenant_id=tenant_id,
                        agent_id=agent_id,
                        room_id=room_id,
                        dropped_through=seq,
                    )
                    .on_conflict_do_update(
                        index_elements=[
                            AgentEventDrop.agent_id,
                            AgentEventDrop.room_id,
                        ],
                        set_={
                            "dropped_through": func.greatest(
                                AgentEventDrop.dropped_through, seq
                            )
                        },
                    )
                )
            await session.execute(
                delete(AgentPositionTicket).where(
                    AgentPositionTicket.created_at < cutoff
                )
            )
            await session.commit()
        if deleted:
            metrics().increment(
                AGENT_EVENTS_DROPPED, {"reason": "retention"}, len(deleted)
            )
        return len(deleted)

    # ------------------------------------------------------------------
    # Legacy long-poll compatibility
    #
    # Long-polling clients send no position and have nowhere to store one, so
    # the server stores it for them in `agent_poll_positions`, one row per
    # agent and poll endpoint (`reader_id`). Each poll returns everything after
    # what the server last gave that reader, and records what it gave. These
    # clients never see a duplicate. Reading deletes nothing, so a streaming
    # reader of the same agent is unaffected.
    #
    # Delivery to these clients is at most once: the position advances when a
    # response is sent, so a response lost in flight loses its events.
    # ------------------------------------------------------------------

    async def poll(
        self, tenant_id: str, agent_id: str, *, rooms: set[str], timeout: float = 30
    ) -> list[AgentEvent]:
        """Every event for this agent in the rooms it is in: its own events and the
        rooms' conversation.

        `rooms` is the agent's current room membership, and it is required.
        Own events are stored per agent with no record of membership, so an own event
        written while the agent was in a room stays readable after the agent
        is removed from it. Without a required filter, a new caller would by
        default receive events from rooms the agent has left.
        """
        return await self._legacy_poll(
            tenant_id,
            agent_id,
            "legacy:all",
            timeout=timeout,
            rooms=rooms,
            conversation=True,
        )

    async def poll_room(
        self, tenant_id: str, agent_id: str, room_id: str, timeout: float = 30
    ) -> list[AgentEvent]:
        return await self._legacy_poll(
            tenant_id,
            agent_id,
            f"legacy:room:{room_id}",
            timeout=timeout,
            rooms={room_id},
            conversation=True,
            rooms_are_membership=False,
        )

    async def poll_notifications(
        self, tenant_id: str, agent_id: str, *, rooms: set[str], timeout: float = 30
    ) -> list[AgentEvent]:
        """The agent's notifiable own events (see `is_notifiable`), filtered by
        `rooms` in the same way as `poll`.

        This stream carries the messages addressed to the agent, so it is where
        leaking events from a room the agent has left would matter most.
        """
        return await self._legacy_poll(
            tenant_id,
            agent_id,
            "legacy:notifications",
            timeout=timeout,
            rooms=rooms,
            notifiable_only=True,
        )

    async def _legacy_poll(
        self,
        tenant_id: str,
        agent_id: str,
        reader_id: str,
        *,
        timeout: float,
        rooms: set[str],
        conversation: bool = False,
        notifiable_only: bool = False,
        rooms_are_membership: bool = True,
    ) -> list[AgentEvent]:
        args = (
            tenant_id,
            agent_id,
            reader_id,
            rooms,
            conversation,
            notifiable_only,
            rooms_are_membership,
        )
        events = await self._legacy_take(*args)
        if events:
            return events

        if conversation:
            # New conversation rows do not set the doorbell, so a poll that
            # includes conversation looks again every
            # `CONVERSATION_RECHECK_SECONDS` instead of sleeping through the
            # whole timeout.
            await self.wait(agent_id, min(timeout, CONVERSATION_RECHECK_SECONDS))
        else:
            await self.wait(agent_id, timeout)

        return await self._legacy_take(*args)

    async def _legacy_take(
        self,
        tenant_id: str,
        agent_id: str,
        reader_id: str,
        rooms: set[str],
        conversation: bool,
        notifiable_only: bool,
        rooms_are_membership: bool,
    ) -> list[AgentEvent]:
        """Read once for a long-polling reader, save its new position, and
        return the events.

        Two polls of the same reader can overlap. Each saves its new position
        only if the stored one is still the one it read from, so of two polls
        that read the same events, one returns them and the other reads again
        from where the first stopped. Returning nothing after the last attempt
        loses nothing, because the position did not move.
        """
        for _ in range(_POLL_SAVE_ATTEMPTS):
            stored, position = await self._poll_position(
                tenant_id, agent_id, reader_id, rooms if conversation else set()
            )
            events, moved = await self._legacy_read(
                tenant_id,
                agent_id,
                reader_id,
                position,
                rooms,
                conversation,
                notifiable_only,
                rooms_are_membership,
            )
            if await self._save_poll_position(
                tenant_id, agent_id, reader_id, moved, expected=stored
            ):
                return events
        logger.warning(
            "[EVENT-BUF] legacy poller %s for agent %s lost the save of its "
            "position %s times in a row to overlapping polls; returning nothing",
            reader_id,
            agent_id,
            _POLL_SAVE_ATTEMPTS,
        )
        return []

    async def _legacy_read(
        self,
        tenant_id: str,
        agent_id: str,
        reader_id: str,
        position: Position,
        rooms: set[str],
        conversation: bool,
        notifiable_only: bool,
        rooms_are_membership: bool,
    ) -> tuple[list[AgentEvent], Position]:
        """Read for a long-polling reader from `position`, and return the
        events with the position to save once they are returned.

        The bound on own event numbers is read before the own events and the read stops
        at it, so the saved position covers exactly the own events returned. When
        `rooms` is the agent's membership, the bound is the newest own event in
        those rooms rather than the agent's head. Membership can grow: if the
        position moved to the head, own events already written for a room the agent
        is added to later would sit below the position and never be delivered.
        `poll_room` reads a fixed room chosen by the reader, so it passes
        `rooms_are_membership=False` and moves to the head.
        """
        after = position[OWN_EVENTS]
        if rooms_are_membership:
            through = await self._last_seq_in_rooms(tenant_id, agent_id, after, rooms)
        else:
            through = await self.head(tenant_id, agent_id)
        try:
            own_events = await self.read_from(
                tenant_id,
                agent_id,
                after,
                rooms=rooms,
                notifiable_only=notifiable_only,
                through_seq=through,
            )
        except CursorExpiredError as exc:
            # A polling client cannot be told about a gap — it has no protocol
            # for it. Log loudly and resume from what is retained rather than
            # silently returning nothing. Migrating the client is the real fix.
            logger.error(
                "[EVENT-BUF] legacy poller %s for agent %s missed events "
                "(cursor %s, oldest retained %s); resuming from oldest retained",
                reader_id,
                agent_id,
                exc.requested,
                exc.oldest,
            )
            after = exc.resume_after
            own_events = await self.read_from(
                tenant_id,
                agent_id,
                after,
                rooms=rooms,
                notifiable_only=notifiable_only,
                through_seq=through,
            )
        moved = merged(position, {OWN_EVENTS: max(through, after)})
        found: list[list[BufferedEvent]] = [own_events]
        if conversation:
            said = await self.read_conversation(
                tenant_id,
                agent_id,
                {room_id: moved[room_source(room_id)] for room_id in rooms},
                limit=10_000,
            )
            found.extend(_by_source(said.events))
            moved = merged(
                moved,
                {room_source(room_id): seq for room_id, seq in said.through.items()},
            )
        return [item.event for item in _interleaved(found)], moved

    async def _poll_position(
        self, tenant_id: str, agent_id: str, reader_id: str, rooms: set[str]
    ) -> tuple[Position | None, Position]:
        """A long-polling reader's stored position from `agent_poll_positions`,
        or None when it has none, and the position to read from, with a number
        for each room in `rooms`.

        A reader seen for the first time starts just before the agent's oldest
        own event still kept, so own events written before the client first polled are
        delivered. Starting at the head would silently skip them. A room the
        reader has no number for starts at the beginning of the retention
        window, for the same reason.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            row = await session.scalar(
                select(AgentPollPosition.position).where(
                    AgentPollPosition.agent_id == agent_id,
                    AgentPollPosition.reader_id == reader_id,
                )
            )
        stored: Position | None = dict(row) if row is not None else None
        position: Position = dict(stored or {})
        if OWN_EVENTS not in position:
            position[OWN_EVENTS] = await self.before_retained(tenant_id, agent_id)
        missing = {room_id for room_id in rooms if room_source(room_id) not in position}
        if missing:
            starts = await self.room_window_starts(tenant_id, missing)
            for room_id, start in starts.items():
                position[room_source(room_id)] = start
        return stored, position

    async def _save_poll_position(
        self,
        tenant_id: str,
        agent_id: str,
        reader_id: str,
        position: Position,
        *,
        expected: Position | None,
    ) -> bool:
        """Store a long-polling reader's new position if its stored position is
        still `expected` (None for no row), and return whether it was stored.

        The row is inserted from a SELECT on `agents`, so if the agent was
        deleted while the poll was in flight, nothing is saved and the insert
        does not fail on the foreign key.
        """
        unchanged = (
            AgentPollPosition.position
            == literal(expected, AgentPollPosition.position.type)
            if expected is not None
            else literal(False)
        )
        async with tenant_session(self._session_factory, tenant_id) as session:
            saved = await session.scalar(
                insert(AgentPollPosition)
                .from_select(
                    [
                        AgentPollPosition.tenant_id,
                        AgentPollPosition.agent_id,
                        AgentPollPosition.reader_id,
                        AgentPollPosition.position,
                    ],
                    select(
                        Agent.tenant_id,
                        Agent.id,
                        literal(reader_id),
                        literal(position, AgentPollPosition.position.type),
                    ).where(Agent.id == agent_id),
                )
                .on_conflict_do_update(
                    index_elements=[
                        AgentPollPosition.agent_id,
                        AgentPollPosition.reader_id,
                    ],
                    set_={
                        "position": literal(position, AgentPollPosition.position.type)
                    },
                    where=unchanged,
                )
                .returning(AgentPollPosition.reader_id)
            )
            await session.commit()
        return saved is not None

    async def _last_seq_in_rooms(
        self, tenant_id: str, agent_id: str, after_seq: int, rooms: set[str]
    ) -> int:
        """The newest retained event after `after_seq` in one of `rooms`.

        Returns `after_seq` itself when there is none. A caller that moves its
        position to the returned number therefore never moves past an own event held
        for a room the agent has not joined yet.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            last = await session.scalar(
                select(func.max(AgentEventRow.seq)).where(
                    AgentEventRow.agent_id == agent_id,
                    AgentEventRow.seq > after_seq,
                    AgentEventRow.room_id.in_(rooms),
                )
            )
        return after_seq if last is None else last

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _record_scan(operation: dict[str, str], scanned: int, started: float) -> None:
        registry = metrics()
        registry.observe(
            AGENT_BUFFER_SCAN_DURATION,
            operation,
            (time.perf_counter() - started) * 1000.0,
        )
        registry.observe(AGENT_BUFFER_SCANNED, operation, scanned)

    async def check_cursor(self, tenant_id: str, agent_id: str, after_seq: int) -> None:
        """Raise `CursorExpiredError` if `expire` has deleted any of the agent's
        own events numbered after `after_seq`, naming the rooms they were in
        and the number to resume after."""
        rooms = await self.rooms_dropped_after(tenant_id, agent_id, after_seq)
        if not rooms:
            return
        oldest = await self.oldest_retained(tenant_id, agent_id)
        resume_after = await self.before_retained(tenant_id, agent_id)
        raise CursorExpiredError(agent_id, after_seq, oldest, rooms, resume_after)

    async def before_retained(self, tenant_id: str, agent_id: str) -> int:
        """The own-events number just before the agent's oldest one still kept,
        and past every number `expire` deleted.

        `expire` deletes an agent's own events oldest first, so everything it
        deleted is numbered below everything it kept. When it has deleted all
        of them, this is the highest number it deleted rather than 0: a reader
        placed at 0 would find the deleted numbers ahead of it on every read.
        """
        async with tenant_session(self._session_factory, tenant_id) as session:
            oldest = await session.scalar(
                select(func.min(AgentEventRow.seq)).where(
                    AgentEventRow.agent_id == agent_id
                )
            )
            dropped_through = await session.scalar(
                select(func.max(AgentEventDrop.dropped_through)).where(
                    AgentEventDrop.agent_id == agent_id
                )
            )
        return max(dropped_through or 0, (oldest or 0) - 1, 0)


def transient_failure(exc: BaseException) -> bool:
    """Whether a failed database call is worth retrying: the connection or the
    connection pool failed, not the statement itself."""
    if isinstance(exc, OperationalError | InterfaceError | PoolTimeoutError):
        return True
    return isinstance(exc, DBAPIError) and exc.connection_invalidated


def _counting(agent_id: str, room_id: str, *, baseline: Any, occupant: Reader) -> Any:
    """An insert of an `agent_room_reads` row, selected from `rooms` so that it
    inserts nothing when the room does not exist.

    A room can be deleted while a reader still delivers it. The insert then
    does nothing, instead of failing the reader's stream on the foreign key.
    """
    return insert(AgentRoomRead).from_select(
        [
            AgentRoomRead.tenant_id,
            AgentRoomRead.agent_id,
            AgentRoomRead.room_id,
            AgentRoomRead.caught_up_seq,
            AgentRoomRead.occupant_id,
            AgentRoomRead.occupant_is_session,
        ],
        select(
            Room.tenant_id,
            literal(agent_id),
            Room.id,
            baseline,
            literal(occupant.id),
            literal(occupant.is_session),
        ).where(Room.id == room_id),
    )


def _window_start(room_id: str, cutoff: datetime) -> Any:
    """A query for the `messages.seq` of the room's newest row sent before
    `cutoff`. It reads one entry of the room's `sent_at` index instead of
    scanning every row sent since."""
    return (
        select(Message.seq)
        .where(Message.room_id == room_id, Message.sent_at < cutoff)
        .order_by(Message.sent_at.desc())
        .limit(1)
    )


def _room_head(room_id: str) -> Any:
    """The room's highest `messages.seq` (0 when it has none), as a subquery
    to use inside an insert."""
    return (
        select(func.coalesce(func.max(Message.seq), 0))
        .where(Message.room_id == room_id)
        .scalar_subquery()
    )


def _by_source(events: list[BufferedEvent]) -> list[list[BufferedEvent]]:
    """Events split by the source they came from, each in its own order."""
    sources: dict[str, list[BufferedEvent]] = {}
    for item in events:
        sources.setdefault(item.source, []).append(item)
    return list(sources.values())


def _interleaved(sources: list[list[BufferedEvent]]) -> list[BufferedEvent]:
    """Merge several sources' events into one list, earliest first.

    Only the next event of each source is compared, so each source's events
    stay in their own order. That order is what makes it safe to move a
    reader's position after each delivered event. Events from different
    sources are merged by when they happened.
    """
    heads = [0] * len(sources)
    out: list[BufferedEvent] = []
    while True:
        best: int | None = None
        for index, items in enumerate(sources):
            if heads[index] >= len(items):
                continue
            if best is None or items[heads[index]].at < sources[best][heads[best]].at:
                best = index
        if best is None:
            return out
        out.append(sources[best][heads[best]])
        heads[best] += 1
