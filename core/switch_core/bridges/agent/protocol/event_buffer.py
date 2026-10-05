"""Per-agent sequenced event buffer (CHOO-1857).

Replaces the destructive per-room `asyncio.Queue` fan-out. Events are appended
with a monotonically increasing sequence number and stay readable until they
age out of the retention window or the per-agent cap forces them out. Reading
never removes, so several readers can consume the same events independently and
a reader that drops off can resume from its cursor.

Retention is deliberately independent of what readers have confirmed: an event
remains readable for its window whether or not somebody has already consumed
it. Cursors record progress; they do not decide what is kept.

The buffer lives in memory: it cannot outlive the process, and persisting it
would recreate the stale-state bug this design removes. `switch-core` is
single-process by construction, so an in-process structure is authoritative.
It sits behind a narrow surface (`enqueue`, `read_from`, `wait`, `confirm`)
so it can be moved to Postgres later without touching its callers.

Overflow is never silent: when the cap forces events out, the rooms that lost
events are flagged and the next reader to ask is told it missed events there.

How far behind a reader is in a room is derived here rather than tallied: every
event is retained with its room and whether it was addressed, so "unaddressed
traffic in this room since you last caught up" is a scan between two sequence
numbers at the moment somebody asks. The only thing recorded is where each room
was last caught up, which is one number and cannot drift out of step with the
events it describes.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass

from switch_core.bridges.agent.protocol.types import AgentEvent
from switch_core.logging_context import log_context
from switch_core.observability.catalogue import AGENT_EVENTS_DROPPED
from switch_core.observability.metrics import metrics

logger = logging.getLogger(__name__)

# Maximum events retained per agent. Beyond this the oldest are dropped and the
# agent is flagged with a gap. Sized for chat-rate traffic: an agent would have
# to accumulate this many unread events before any reader catches up.
DEFAULT_MAX_EVENTS_PER_AGENT = 2000

# How long an event stays readable. This is the resume window: a client that
# reconnects within it recovers every event it missed, and one that reconnects
# later is told it has a gap rather than handed a partial stream.
DEFAULT_RETENTION_SECONDS = 15 * 60

# Why an unread count is absent or incomplete. Never a bare zero: a reader that
# is told nothing went by must be able to trust it.
NO_BASELINE = "nothing recorded what you had already seen in this room"
RESTARTED = (
    "the server restarted, so what you had already seen in this room is no longer known"
)
COUNTED_FROM_A_HOLE = (
    "older events in this room were dropped before anything counted them, so "
    "this is a floor rather than a total"
)


class CursorExpiredError(Exception):
    """A reader asked to resume from a point the buffer no longer retains.

    Raised rather than fast-forwarding to head: a client that has missed events
    must be told, never handed a stream that looks complete.
    """

    def __init__(
        self, agent_id: str, requested: int, oldest: int, rooms: tuple[str, ...]
    ) -> None:
        super().__init__(
            f"cursor {requested} for agent {agent_id} is older than the retained "
            f"buffer (oldest retained: {oldest}); missed events in "
            f"{', '.join(rooms)}, re-read context"
        )
        self.agent_id = agent_id
        self.requested = requested
        self.oldest = oldest
        self.rooms = rooms


def is_notifiable(event: AgentEvent) -> bool:
    """Whether an event is addressed at the agent rather than ambient context.

    Addressed messages, task events, and room_join events the agent is
    configured to listen for. Excludes unaddressed chatter and admin command
    events. This is the `addressed` delivery filter: a supervising connection
    watching every room wants only these, while a session in a single room
    wants everything.
    """
    if event.type == "message":
        return getattr(event.payload, "addressed", False)
    if event.type == "room_join":
        return getattr(event.payload, "listening", False)
    if event.type == "command":
        return False
    # All task_* events are enqueued only for the directly-involved agent.
    return event.type.startswith("task_")


@dataclass(frozen=True)
class BufferedEvent:
    """An event with its position in the agent's stream."""

    seq: int
    room_id: str
    event: AgentEvent
    notifiable: bool
    appended_at: float


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


@dataclass
class _Counting:
    """What one room is behind by for one agent, and who is entitled to clear it.

    `baseline` is the sequence number the room was last caught up through, or
    None for "cannot be said". `occupant` is the session or connection in the
    room now: it decides whose `caught_up` counts, and nothing else.
    """

    occupant: Reader
    baseline: int | None


@dataclass(frozen=True)
class Unread:
    """Unaddressed messages a reader has yet to catch up on, in one room.

    `count` is None when nothing about it can be stated — better than a zero
    the reader would believe. `reason` says why a count is absent, or why one
    that is present is only a floor; it is None exactly when the count is
    complete.
    """

    count: int | None
    reason: str | None


class EventBuffer:
    def __init__(
        self,
        max_events_per_agent: int = DEFAULT_MAX_EVENTS_PER_AGENT,
        retention_seconds: float = DEFAULT_RETENTION_SECONDS,
        *,
        sequence_base: int,
    ) -> None:
        # Each boot numbers from its own base, above every earlier boot's, so a
        # sequence number is never reused and a cursor from a previous boot is
        # recognisably below this one's floor.
        self.sequence_floor = sequence_base + 1
        self.boot = sequence_base >> 32
        self._max_events = max_events_per_agent
        self._retention_seconds = retention_seconds
        self._events: dict[str, deque[BufferedEvent]] = {}
        self._next_seq: dict[str, int] = {}
        self._notify: dict[str, asyncio.Event] = {}
        # reader id -> last sequence number that reader has confirmed. Used to
        # resume a reader and to report progress; deliberately NOT used to
        # decide what to drop. Retention is by age and cap alone, so a reader
        # that connects after an event was already consumed by someone else
        # still sees it.
        self._cursors: dict[str, dict[str, int]] = {}
        # agent -> room -> highest sequence number dropped from that room. Any
        # reader resuming from at or below it has missed events there, and
        # knowing which room is what lets the warning name one.
        self._dropped_through: dict[str, dict[str, int]] = {}
        # agent -> room -> how far behind that room is, and who is in it.
        # Distinct from the delivery cursor, which records what the server has
        # written out: the two are allowed to diverge, and that divergence is
        # what makes a count per-room rather than per-connection.
        #
        # Keyed by room rather than by reader because at most one session of an
        # agent may be in a room, so the room names the count on its own — and
        # the reader cannot name it once an agent has a single inbound
        # connection, which every one of its sessions arrives on. What went
        # past unread in a room belongs to the room: a session taking it over
        # inherits what the agent has yet to catch up on there rather than
        # starting at a zero nothing justifies.
        self._counting: dict[str, dict[str, _Counting]] = {}
        # Agents whose baselines were lost with a previous life of this
        # process. A room counted for the first time after that starts unknown
        # rather than at a number: the conversation it missed before the
        # restart is gone from the buffer, so a count taken from what is left
        # would be a floor presented as a total.
        self._restarted: set[str] = set()

    # ------------------------------------------------------------------
    # Producing
    # ------------------------------------------------------------------

    def enqueue(self, agent_id: str, room_id: str, event: AgentEvent) -> int:
        """Append an event for an agent and return its sequence number."""
        seq = self._next_seq.get(agent_id, self.sequence_floor)
        if seq >= self.sequence_floor - 1 + (1 << 32):
            raise RuntimeError(
                "Agent event sequence range exhausted; restart the server."
            )
        self._next_seq[agent_id] = seq + 1

        events = self._events.setdefault(agent_id, deque())
        events.append(
            BufferedEvent(
                seq=seq,
                room_id=room_id,
                event=event,
                notifiable=is_notifiable(event),
                appended_at=time.monotonic(),
            )
        )
        logger.debug(
            "[EVENT-BUF] append agent=%s room=%s type=%s seq=%s",
            agent_id,
            room_id,
            event.type,
            seq,
        )
        self._trim(agent_id)
        self._wake(agent_id)
        return seq

    # ------------------------------------------------------------------
    # Consuming
    # ------------------------------------------------------------------

    def read_from(
        self,
        agent_id: str,
        after_seq: int,
        *,
        rooms: set[str] | None = None,
        notifiable_only: bool = False,
        limit: int | None = None,
    ) -> list[BufferedEvent]:
        """Return retained events after `after_seq`, oldest first.

        `rooms=None` means every room the agent has events for; otherwise only
        the given rooms. Raises `CursorExpiredError` if `after_seq` predates
        what the buffer still holds.

        The window is enforced here as well as on append, because an agent
        that goes quiet appends nothing and would otherwise go on serving
        events long past it. Elsewhere the promise that an event stops being
        readable when its window ends is relied on to decide how long a record
        about it has to be kept.
        """
        self._trim(agent_id)
        self._check_cursor(agent_id, after_seq)

        out: list[BufferedEvent] = []
        for item in self._events.get(agent_id, ()):
            if item.seq <= after_seq:
                continue
            if rooms is not None and item.room_id not in rooms:
                continue
            if notifiable_only and not item.notifiable:
                continue
            out.append(item)
            if limit is not None and len(out) >= limit:
                break
        return out

    async def wait(self, agent_id: str, timeout: float) -> None:
        """Block until an event is appended for the agent, or the timeout passes.

        A wake-up is advisory: callers re-read from their cursor rather than
        trusting this to deliver anything. The buffer is the record; this is
        only the doorbell.
        """
        notify = self._notify.setdefault(agent_id, asyncio.Event())
        notify.clear()
        try:
            await asyncio.wait_for(notify.wait(), timeout=timeout)
        except TimeoutError:
            return

    def doorbell(self, agent_id: str) -> asyncio.Event:
        """The wake-up signal for an agent, shared by every reader.

        Set whenever an event is appended. Readers re-read from their own
        cursor when woken; the signal carries no payload, so a spurious or
        missed wake costs latency, never correctness.
        """
        return self._notify.setdefault(agent_id, asyncio.Event())

    def head(self, agent_id: str) -> int:
        """The sequence number of the most recent event (the floor less one if none)."""
        return self._next_seq.get(agent_id, self.sequence_floor) - 1

    def oldest_retained(self, agent_id: str) -> int:
        """Sequence number of the oldest retained event (0 if the buffer is empty)."""
        events = self._events.get(agent_id)
        return events[0].seq if events else 0

    def has_gap_before(self, agent_id: str, after_seq: int) -> bool:
        """Whether resuming from `after_seq` would skip dropped events."""
        return bool(self.rooms_dropped_after(agent_id, after_seq))

    def rooms_dropped_after(self, agent_id: str, after_seq: int) -> tuple[str, ...]:
        """The rooms that lost events a reader at `after_seq` would have seen."""
        markers = self._dropped_through.get(agent_id, {})
        return tuple(sorted(room for room, seq in markers.items() if seq > after_seq))

    # ------------------------------------------------------------------
    # Reader bookkeeping
    # ------------------------------------------------------------------

    def ensure_counting(
        self, agent_id: str, connection_id: str, room_id: str, from_seq: int
    ) -> None:
        """A connection is delivering this room: count it from `from_seq` if
        nothing is counting it yet.

        Covering a room is not being in it. A connection carries every session
        of an agent and delivers the union of their rooms, so a connection
        saying what it covers must not take a room from whoever is in it — and
        a delivery loop says it on every pass.

        Nothing already recorded is touched: what is there is either progress
        or a deliberate unknown, and replacing either would invent a zero.
        """
        if room_id in self._counting.setdefault(agent_id, {}):
            return
        self._begin(
            agent_id, room_id, Reader(id=connection_id, is_session=False), from_seq
        )

    def take_counting(
        self, agent_id: str, connection_id: str, room_id: str, from_seq: int
    ) -> None:
        """A connection has taken this room from whoever held it.

        For the doors where the room slot itself changes hands and the registry
        has granted the takeover — not for a connection re-stating what it
        delivers. Whoever is being told how far behind the room is has to be
        the one whose reading clears it, so the taker becomes the occupant
        whether it took the room from another connection or from a session that
        has now been displaced from it.

        What the room is behind by survives the change of hands: the messages
        went past unread whoever was there, and a successor told zero would be
        told something nobody has established.
        """
        rooms = self._counting.setdefault(agent_id, {})
        taker = Reader(id=connection_id, is_session=False)
        held = rooms.get(room_id)
        if held is None:
            self._begin(agent_id, room_id, taker, from_seq)
            return
        held.occupant = taker

    def hand_counting_to(self, agent_id: str, reader: Reader, room_id: str) -> None:
        """Record that `reader` is the one in the room now.

        Connecting to a room is taking it, so the newcomer becomes the only
        caller whose reading clears the count there — which is what stops a
        read begun by the session it displaced from clearing a count that is
        no longer that session's to clear.

        What the room is behind by survives the change of hands: the messages
        went past unread whoever was there, and a successor told zero would be
        told something nobody has established. A room nothing has counted yet
        starts from the oldest event still retained, the most that can be said
        about how far behind it is.
        """
        rooms = self._counting.setdefault(agent_id, {})
        held = rooms.get(room_id)
        if held is None:
            self._begin(agent_id, room_id, reader, 0)
            return
        held.occupant = reader

    def mark_restarted(self, agent_id: str) -> None:
        """Record that how far behind any of this agent's rooms are cannot be said.

        The buffer is in memory, so a restart takes every room's baseline with
        it — not only the rooms of whichever connection noticed. An `all`-scope
        connection names no rooms at all and the rooms its sessions work in
        arrive afterwards, so the rule has to outlive the reconnection that
        reports it: a room first counted after a restart starts unknown too.

        Sticky either way, so a room is not quietly given a fresh baseline and
        its reader told nothing went by. The next time one catches up it gets a
        real baseline again. Whoever is in a room stays in it: losing the
        buffer says nothing about who is where.
        """
        self._restarted.add(agent_id)
        for counting in self._counting.get(agent_id, {}).values():
            counting.baseline = None

    def caught_up(
        self,
        agent_id: str,
        reader: Reader,
        room_id: str,
        through_seq: int,
        arrived_on: str | None,
    ) -> None:
        """Record that the room's occupant has caught up through `through_seq`.

        Forward only, and only for the room named: catching up on one room
        says nothing about any other, which is the whole point of counting
        per room.

        Ignored from anyone but the occupant. A read is begun before its
        history arrives, so a session displaced from the room while its read
        was in flight comes back holding an answer for a room it has left; the
        session that took the room has not read a word of it, and must not be
        told otherwise.

        A session may take the count over from the connection it is speaking
        over — `arrived_on` — and from nothing else. That connection carried it
        into the room, so a count opened in the connection's name is the
        session's own to clear, which is how a session recovers one rather than
        reading forever against a baseline nothing it can say will clear. A
        count any other connection holds belongs to whoever took the room, and
        a session outranking it would put the displaced back in charge of it.
        """
        rooms = self._counting.setdefault(agent_id, {})
        held = rooms.get(room_id)
        if held is None:
            rooms[room_id] = _Counting(occupant=reader, baseline=through_seq)
            return
        if held.occupant != reader:
            if not reader.is_session:
                return
            if held.occupant.is_session or held.occupant.id != arrived_on:
                return
            held.occupant = reader
        if held.baseline is None or through_seq > held.baseline:
            held.baseline = through_seq

    def unread(self, agent_id: str, room_id: str, through_seq: int) -> Unread:
        """Unaddressed messages in one room the agent has not caught up on.

        Counted on demand from the retained events rather than tallied as they
        arrive, so it cannot disagree with what the buffer holds. Only
        messages: an agent is told how much conversation went past it, not how
        many admin events did.

        Asked by room alone, with no reader: a connection carrying every
        session of an agent could not say which of them a room's count belongs
        to, and only one of them can be in the room to be told.
        """
        held = self._counting.get(agent_id, {}).get(room_id)
        if held is None:
            return Unread(count=None, reason=NO_BASELINE)
        baseline = held.baseline
        if baseline is None:
            return Unread(count=None, reason=RESTARTED)

        count = sum(
            1
            for item in self._events.get(agent_id, ())
            if item.room_id == room_id
            and baseline < item.seq <= through_seq
            and item.event.type == "message"
            and not item.notifiable
        )
        dropped = self._dropped_through.get(agent_id, {}).get(room_id, 0)
        if dropped > baseline:
            return Unread(count=count, reason=COUNTED_FROM_A_HOLE)
        return Unread(count=count, reason=None)

    def register_reader(self, agent_id: str, reader_id: str, cursor: int) -> None:
        self._cursors.setdefault(agent_id, {})[reader_id] = cursor

    def confirm(self, agent_id: str, reader_id: str, cursor: int) -> None:
        """Record how far a reader has consumed, so its events can be trimmed.

        Cursors only move forward. A reader reporting a lower value than it has
        already confirmed is ignored rather than allowed to rewind the buffer.
        """
        readers = self._cursors.setdefault(agent_id, {})
        if cursor > readers.get(reader_id, 0):
            readers[reader_id] = cursor

    def drop_reader(self, agent_id: str, reader_id: str) -> None:
        """Forget a reader's delivery cursor. What its rooms are behind by stays.

        A reader going away does not mean the conversation it was not reading
        was read. The next session in the room is told what went past.
        """
        readers = self._cursors.get(agent_id)
        if readers:
            readers.pop(reader_id, None)

    def remove(self, agent_id: str) -> None:
        self._events.pop(agent_id, None)
        self._notify.pop(agent_id, None)
        self._cursors.pop(agent_id, None)
        self._dropped_through.pop(agent_id, None)
        self._counting.pop(agent_id, None)
        self._restarted.discard(agent_id)

    def _begin(
        self, agent_id: str, room_id: str, occupant: Reader, baseline: int
    ) -> None:
        """Start counting a room, unknown when the buffer restarted under it."""
        self._counting.setdefault(agent_id, {})[room_id] = _Counting(
            occupant=occupant,
            baseline=None if agent_id in self._restarted else baseline,
        )

    def drop_room(self, agent_id: str, room_id: str) -> None:
        """Forget everything retained for this agent in one room.

        Called when the agent is removed from it. The buffer is keyed by agent
        and knows nothing about who is in what, so an event queued while it was
        a member stays readable after it is not.

        Sequence numbers are untouched and no gap is recorded: a reader that
        skips these has missed nothing it was entitled to, and saying otherwise
        would send it to re-read the context of a room it is not in.
        """
        events = self._events.get(agent_id)
        if not events:
            return
        kept = [item for item in events if item.room_id != room_id]
        dropped = len(events) - len(kept)
        if not dropped:
            return
        events.clear()
        events.extend(kept)
        logger.info(
            "[EVENT-BUF] dropped %s retained event(s) for agent=%s room=%s: "
            "no longer a member",
            dropped,
            agent_id,
            room_id,
        )

    # ------------------------------------------------------------------
    # Legacy long-poll compatibility
    #
    # Polling clients send no cursor and have nowhere to keep one, so the
    # server holds it for them: "everything after the last thing I gave you,
    # and record that I gave it". Behaviour is unchanged from their point of
    # view — they never see a duplicate — but reads are no longer destructive,
    # so a streaming reader on the same agent is unaffected.
    #
    # Delivery stays at-most-once for these callers, exactly as before: the
    # cursor advances on send, so a response lost in flight loses its events.
    # Confirming clients get at-least-once instead.
    # ------------------------------------------------------------------

    async def poll(
        self, agent_id: str, *, rooms: set[str], timeout: float = 30
    ) -> list[AgentEvent]:
        """Everything queued for this agent in the rooms it is in.

        `rooms` is how the caller applies membership, and it is required: the
        buffer is keyed by agent and knows nothing about who is in what, so an
        event queued while the agent was a member stays queued after it is
        removed. A default would make the leak the thing a new caller gets for
        free.

        Read once, before the wait. A room the agent is added to while this is
        parked has its first events held back to the next poll, which the
        caller makes immediately; asking the caller to re-read membership
        mid-poll would buy that one round trip at the cost of a callback
        reaching back out of the buffer, and this stays behind the narrow
        surface described at the top of the module.
        """
        return await self._legacy_poll(
            agent_id, "legacy:all", timeout=timeout, rooms=rooms
        )

    async def poll_room(
        self, agent_id: str, room_id: str, timeout: float = 30
    ) -> list[AgentEvent]:
        return await self._legacy_poll(
            agent_id,
            f"legacy:room:{room_id}",
            timeout=timeout,
            rooms={room_id},
            rooms_are_membership=False,
        )

    async def poll_notifications(
        self, agent_id: str, *, rooms: set[str], timeout: float = 30
    ) -> list[AgentEvent]:
        """The notifiable half of `poll`, under the same membership rule.

        This is the stream carrying messages addressed at the agent, so it is
        the one a removal matters most on.
        """
        return await self._legacy_poll(
            agent_id,
            "legacy:notifications",
            timeout=timeout,
            rooms=rooms,
            notifiable_only=True,
        )

    async def _legacy_poll(
        self,
        agent_id: str,
        reader_id: str,
        *,
        timeout: float,
        rooms: set[str],
        notifiable_only: bool = False,
        rooms_are_membership: bool = True,
    ) -> list[AgentEvent]:
        args = (agent_id, reader_id, rooms, notifiable_only, rooms_are_membership)
        events = self._legacy_take(*args)
        if events:
            return events

        await self.wait(agent_id, timeout)

        return self._legacy_take(*args)

    def _legacy_take(
        self,
        agent_id: str,
        reader_id: str,
        rooms: set[str],
        notifiable_only: bool,
        rooms_are_membership: bool,
    ) -> list[AgentEvent]:
        """One read, moving the cursor past what this reader can never want.

        Past what it can never want, and no further. A legacy read has no
        limit, so it always reaches the end of the buffer, and leaving the
        cursor behind an event the filter excluded parks it below the head
        indefinitely — until retention trims it and the next read reports a
        gap that never happened.

        Which exclusions are permanent depends on the filter.
        `notifiable_only` tests a property of the event, which is fixed, so
        those can be skipped for good. A room set taken from membership is not
        fixed: an agent added to a room the buffer already holds events for
        would find the cursor already past them, and they would never be
        delivered. `poll_room`'s filter is the reader's own scope rather than a
        membership snapshot, so there the exclusions are permanent too — hence
        `rooms_are_membership`.
        """
        cursor = self._legacy_cursor(agent_id, reader_id)
        events = self._legacy_read(agent_id, reader_id, cursor, rooms, notifiable_only)
        if rooms_are_membership:
            self.confirm(
                agent_id, reader_id, self._last_seq_in_rooms(agent_id, cursor, rooms)
            )
        else:
            self.confirm(agent_id, reader_id, self.head(agent_id))
        return [item.event for item in events]

    def _last_seq_in_rooms(self, agent_id: str, after_seq: int, rooms: set[str]) -> int:
        """The newest retained event after `after_seq` in one of `rooms`.

        `after_seq` itself when there is none, so a caller confirming this
        never moves a cursor over an event held for a room the agent is not in
        yet.
        """
        last = after_seq
        for item in self._events.get(agent_id, ()):
            if item.seq > after_seq and item.room_id in rooms:
                last = item.seq
        return last

    def _legacy_cursor(self, agent_id: str, reader_id: str) -> int:
        readers = self._cursors.setdefault(agent_id, {})
        if reader_id not in readers:
            # A poller seen for the first time starts before the oldest
            # retained event, mirroring the queue it replaces: events
            # accumulated while nobody was polling and the first poll drained
            # them. Starting at head would silently swallow anything that
            # arrived before the client got around to asking.
            readers[reader_id] = max(self.oldest_retained(agent_id) - 1, 0)
        return readers[reader_id]

    def _legacy_read(
        self,
        agent_id: str,
        reader_id: str,
        cursor: int,
        rooms: set[str],
        notifiable_only: bool,
    ) -> list[BufferedEvent]:
        try:
            return self.read_from(
                agent_id, cursor, rooms=rooms, notifiable_only=notifiable_only
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
            resumed = max(exc.oldest - 1, 0)
            self._cursors.setdefault(agent_id, {})[reader_id] = resumed
            return self.read_from(
                agent_id, resumed, rooms=rooms, notifiable_only=notifiable_only
            )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _wake(self, agent_id: str) -> None:
        notify = self._notify.get(agent_id)
        if notify is not None:
            notify.set()

    def _check_cursor(self, agent_id: str, after_seq: int) -> None:
        rooms = self.rooms_dropped_after(agent_id, after_seq)
        if not rooms:
            return
        markers = self._dropped_through[agent_id]
        raise CursorExpiredError(agent_id, after_seq, max(markers.values()) + 1, rooms)

    def _trim(self, agent_id: str) -> None:
        """Enforce the retention window and the cap.

        Both are lossy, so both record a gap that the next reader resuming from
        before it will be told about. Retention is deliberately independent of
        what readers have confirmed: an event stays readable for its window
        whether or not somebody has already consumed it, so a reader that
        arrives late still sees recent history.
        """
        events = self._events.get(agent_id)
        if not events:
            return

        dropped: dict[str, int] = {}
        expired = 0
        cutoff = time.monotonic() - self._retention_seconds
        while events and events[0].appended_at < cutoff:
            item = events.popleft()
            dropped[item.room_id] = item.seq
            expired += 1
        if expired:
            metrics().increment(AGENT_EVENTS_DROPPED, {"reason": "retention"}, expired)

        overflow = len(events) - self._max_events
        if overflow > 0:
            for _ in range(overflow):
                item = events.popleft()
                dropped[item.room_id] = item.seq
            metrics().increment(AGENT_EVENTS_DROPPED, {"reason": "overflow"}, overflow)
            # The agent is a field as well as being in the message: this fires
            # from the buffer's own bookkeeping rather than from anything the
            # agent called, so there is no request context to inherit it from,
            # and "which agent is falling behind" is the only question this
            # line is ever read to answer.
            with log_context(agent_id=agent_id):
                logger.warning(
                    "[EVENT-BUF] agent=%s exceeded %s buffered events; dropped "
                    "through seq=%s in rooms %s — readers resuming from before "
                    "this will be told they missed events",
                    agent_id,
                    self._max_events,
                    max(dropped.values()),
                    ", ".join(sorted(dropped)),
                )

        if dropped:
            markers = self._dropped_through.setdefault(agent_id, {})
            for room_id, seq in dropped.items():
                markers[room_id] = max(seq, markers.get(room_id, 0))
