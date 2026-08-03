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

Overflow is never silent: when the cap forces events out, the agent is flagged
as having a gap and the next reader to ask is told it missed events.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass

from switch_core.bridges.agent.protocol.types import AgentEvent

logger = logging.getLogger(__name__)

# Maximum events retained per agent. Beyond this the oldest are dropped and the
# agent is flagged with a gap. Sized for chat-rate traffic: an agent would have
# to accumulate this many unread events before any reader catches up.
DEFAULT_MAX_EVENTS_PER_AGENT = 2000

# How long an event stays readable. This is the resume window: a client that
# reconnects within it recovers every event it missed, and one that reconnects
# later is told it has a gap rather than handed a partial stream.
DEFAULT_RETENTION_SECONDS = 15 * 60


class CursorExpiredError(Exception):
    """A reader asked to resume from a point the buffer no longer retains.

    Raised rather than fast-forwarding to head: a client that has missed events
    must be told, never handed a stream that looks complete.
    """

    def __init__(self, agent_id: str, requested: int, oldest: int) -> None:
        super().__init__(
            f"cursor {requested} for agent {agent_id} is older than the retained "
            f"buffer (oldest retained: {oldest}); missed events, re-read context"
        )
        self.agent_id = agent_id
        self.requested = requested
        self.oldest = oldest


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


class EventBuffer:
    def __init__(
        self,
        max_events_per_agent: int = DEFAULT_MAX_EVENTS_PER_AGENT,
        retention_seconds: float = DEFAULT_RETENTION_SECONDS,
    ) -> None:
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
        # Highest sequence number dropped by overflow, per agent. Any reader
        # resuming from at or below this has missed events.
        self._dropped_through: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Producing
    # ------------------------------------------------------------------

    def enqueue(self, agent_id: str, room_id: str, event: AgentEvent) -> int:
        """Append an event for an agent and return its sequence number."""
        seq = self._next_seq.get(agent_id, 1)
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
        """
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
        """The sequence number of the most recent event (0 if none)."""
        return self._next_seq.get(agent_id, 1) - 1

    def oldest_retained(self, agent_id: str) -> int:
        """Sequence number of the oldest retained event (0 if the buffer is empty)."""
        events = self._events.get(agent_id)
        return events[0].seq if events else 0

    def has_gap_before(self, agent_id: str, after_seq: int) -> bool:
        """Whether resuming from `after_seq` would skip dropped events."""
        dropped = self._dropped_through.get(agent_id)
        return dropped is not None and after_seq < dropped

    # ------------------------------------------------------------------
    # Reader bookkeeping
    # ------------------------------------------------------------------

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
        readers = self._cursors.get(agent_id)
        if readers:
            readers.pop(reader_id, None)

    def remove(self, agent_id: str) -> None:
        self._events.pop(agent_id, None)
        self._next_seq.pop(agent_id, None)
        self._notify.pop(agent_id, None)
        self._cursors.pop(agent_id, None)
        self._dropped_through.pop(agent_id, None)

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

    async def poll(self, agent_id: str, timeout: float = 30) -> list[AgentEvent]:
        return await self._legacy_poll(agent_id, "legacy:all", timeout=timeout)

    async def poll_room(
        self, agent_id: str, room_id: str, timeout: float = 30
    ) -> list[AgentEvent]:
        return await self._legacy_poll(
            agent_id, f"legacy:room:{room_id}", timeout=timeout, rooms={room_id}
        )

    async def poll_notifications(
        self, agent_id: str, timeout: float = 30
    ) -> list[AgentEvent]:
        return await self._legacy_poll(
            agent_id, "legacy:notifications", timeout=timeout, notifiable_only=True
        )

    async def _legacy_poll(
        self,
        agent_id: str,
        reader_id: str,
        *,
        timeout: float,
        rooms: set[str] | None = None,
        notifiable_only: bool = False,
    ) -> list[AgentEvent]:
        cursor = self._legacy_cursor(agent_id, reader_id)

        events = self._legacy_read(agent_id, reader_id, cursor, rooms, notifiable_only)
        if events:
            return self._advance_legacy(agent_id, reader_id, events)

        await self.wait(agent_id, timeout)

        cursor = self._legacy_cursor(agent_id, reader_id)
        events = self._legacy_read(agent_id, reader_id, cursor, rooms, notifiable_only)
        return self._advance_legacy(agent_id, reader_id, events)

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
        rooms: set[str] | None,
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

    def _advance_legacy(
        self, agent_id: str, reader_id: str, events: list[BufferedEvent]
    ) -> list[AgentEvent]:
        if events:
            self.confirm(agent_id, reader_id, events[-1].seq)
        return [item.event for item in events]

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _wake(self, agent_id: str) -> None:
        notify = self._notify.get(agent_id)
        if notify is not None:
            notify.set()

    def _check_cursor(self, agent_id: str, after_seq: int) -> None:
        if self.has_gap_before(agent_id, after_seq):
            raise CursorExpiredError(
                agent_id, after_seq, self._dropped_through[agent_id] + 1
            )

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

        dropped_seq = 0
        cutoff = time.monotonic() - self._retention_seconds
        while events and events[0].appended_at < cutoff:
            dropped_seq = events.popleft().seq

        overflow = len(events) - self._max_events
        if overflow > 0:
            for _ in range(overflow):
                dropped_seq = events.popleft().seq
            logger.warning(
                "[EVENT-BUF] agent=%s exceeded %s buffered events; dropped "
                "through seq=%s — readers resuming from before this will be "
                "told they missed events",
                agent_id,
                self._max_events,
                dropped_seq,
            )

        if dropped_seq:
            self._dropped_through[agent_id] = max(
                dropped_seq, self._dropped_through.get(agent_id, 0)
            )
