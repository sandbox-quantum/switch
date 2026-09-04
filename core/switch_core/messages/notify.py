"""Listens for new-message announcements and wakes whoever cares.

The database announces every insert into `messages` (see
`switch_core/db/notify_ddl.py`). This is the other half: one long-lived
connection holding a `LISTEN`, and an in-process fan-out to the consumers that
asked about a room.

**A wake-up is not a delivery.** A subscriber is told that a room has advanced
to at least some position, never what was said. It then reads the rows it has
not seen. Everything awkward about the notification queue — not durable, not
replayable, delivered at most once, and only to connections that happened to
be listening — stops mattering under that rule, because the worst a lost
announcement can do is delay a read that a later announcement will trigger
anyway.

Two consequences are load-bearing:

- **Announcements coalesce.** Only the highest position per room is kept while
  a subscriber is busy. Ten rows arriving during one handler run produce one
  wake-up, and the handler reads all ten, because the handler works from its
  own cursor rather than from what it was handed. That is also why there is no
  backpressure to apply and no queue to overflow.
- **Reconnecting wakes every room.** A dropped connection misses
  announcements outright, and nothing will ever replay them. So the listener
  treats a reconnect as "everything may have moved" and wakes all subscribers,
  which closes the gap without anyone having to detect it.

The connection is deliberately not taken from the application pool. It is held
for the process's life, never returns, and the pool's recycling and
`idle_in_transaction_session_timeout` would both be actively wrong for it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from switch_core.db.notify_ddl import MESSAGE_CHANNEL

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)

# How often the listening connection is proved still alive. A half-open socket
# reports nothing and delivers nothing, which is the failure this exists to
# catch: without it the process looks connected and silently stops receiving.
HEARTBEAT_SECONDS = 20.0

# Backoff for a listener that cannot connect. Capped low: the whole system's
# delivery latency is behind this, so a long sleep is a long outage.
RECONNECT_BACKOFF_BASE = 1.0
RECONNECT_BACKOFF_CAP = 15.0

RoomWaker = Callable[[str], Awaitable[None]]
EngineFactory = Callable[[], "AsyncEngine"]


@dataclass(frozen=True)
class Announcement:
    """What the trigger said: a room moved, and how far.

    `seq` is a lower bound on where the room now is, not a row to fetch. By the
    time a subscriber runs there may be later rows, and after a coalesce there
    certainly are.
    """

    room_id: str
    seq: int
    message_id: str

    @staticmethod
    def parse(payload: str) -> Announcement | None:
        """Read one notification payload, or None if it is not one of ours.

        A payload that cannot be understood is dropped with a warning rather
        than raised: this runs inside the connection's read loop, and a bad
        message from somewhere else on the channel must not take delivery down
        for every room.
        """
        try:
            data = json.loads(payload)
            return Announcement(
                room_id=str(data["room_id"]),
                seq=int(data["seq"]),
                message_id=str(data["id"]),
            )
        except (ValueError, TypeError, KeyError):
            logger.warning(
                "Ignoring an unreadable message announcement: %r", payload[:200]
            )
            return None


class MessageListener:
    """Holds the `LISTEN` and fans announcements out to room subscribers."""

    def __init__(self, engine_factory: EngineFactory) -> None:
        # A factory rather than an engine: reconnecting builds a fresh one, so
        # a connection that failed leaves nothing of itself behind.
        self._engine_factory = engine_factory
        self._subscribers: dict[str, set[RoomWaker]] = {}
        # Room → the highest position announced but not yet handed on. This is
        # the coalescing buffer; see the module docstring.
        self._pending: dict[str, int] = {}
        self._has_pending = asyncio.Event()
        self._tasks: list[asyncio.Task[None]] = []
        self._running = False
        # Set once the connection is up and every subscriber has been woken,
        # so a caller can wait for delivery to be live rather than guess.
        self.connected = asyncio.Event()

    # ── Subscription ──────────────────────────────────────────────────────────

    def subscribe(self, room_id: str, waker: RoomWaker) -> None:
        """Ask to be woken when `room_id` advances.

        The waker is called with the room id and nothing else, because what it
        should do about it is read the rows after its own cursor. It is woken
        once on subscribing too: a subscriber that starts mid-stream is behind
        by definition, and making it read immediately is cheaper than making
        every caller remember to.
        """
        self._subscribers.setdefault(room_id, set()).add(waker)
        self._mark(room_id, 0)

    def unsubscribe(self, room_id: str, waker: RoomWaker) -> None:
        wakers = self._subscribers.get(room_id)
        if wakers is None:
            return
        wakers.discard(waker)
        if not wakers:
            del self._subscribers[room_id]

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._running:
            raise RuntimeError("MessageListener is already started")
        self._running = True
        self._tasks = [
            asyncio.create_task(self._listen_forever(), name="message-listener"),
            asyncio.create_task(self._fan_out_forever(), name="message-fan-out"),
        ]

    async def stop(self) -> None:
        self._running = False
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []
        self.connected.clear()

    # ── The listening connection ──────────────────────────────────────────────

    async def _listen_forever(self) -> None:
        attempt = 0
        while self._running:
            try:
                await self._listen_once()
                attempt = 0
            except asyncio.CancelledError:
                raise
            except Exception:
                attempt += 1
                delay = min(
                    RECONNECT_BACKOFF_BASE * 2 ** (attempt - 1), RECONNECT_BACKOFF_CAP
                )
                logger.error(
                    "Message listener lost its connection; retrying in %.1fs",
                    delay,
                    exc_info=True,
                )
                self.connected.clear()
                await asyncio.sleep(delay)

    async def _listen_once(self) -> None:
        engine = self._engine_factory()
        try:
            async with engine.connect() as connection:
                raw = await connection.get_raw_connection()
                driver = raw.driver_connection
                if driver is None:
                    raise RuntimeError(
                        "No driver connection behind the message listener; "
                        "LISTEN needs asyncpg directly"
                    )
                await driver.add_listener(MESSAGE_CHANNEL, self._on_notify)
                try:
                    # Whatever happened while there was no connection was not
                    # queued anywhere, so assume every room moved.
                    self._wake_everything()
                    self.connected.set()
                    await self._hold_open(driver)
                finally:
                    self.connected.clear()
                    with contextlib.suppress(Exception):
                        await driver.remove_listener(MESSAGE_CHANNEL, self._on_notify)
        finally:
            await engine.dispose()

    async def _hold_open(self, driver: Any) -> None:
        """Keep the connection until it fails, proving it alive as we go."""
        while self._running:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            await driver.execute("SELECT 1")

    def _on_notify(
        self, _connection: Any, _pid: int, _channel: str, payload: str
    ) -> None:
        """asyncpg's callback. Runs in the connection's read loop.

        It does nothing but record a position, so a slow subscriber can never
        stall the connection that every other room's delivery depends on.
        """
        announcement = Announcement.parse(payload)
        if announcement is not None:
            self._mark(announcement.room_id, announcement.seq)

    # ── Fan-out ───────────────────────────────────────────────────────────────

    def _mark(self, room_id: str, seq: int) -> None:
        self._pending[room_id] = max(self._pending.get(room_id, 0), seq)
        self._has_pending.set()

    def _wake_everything(self) -> None:
        for room_id in self._subscribers:
            self._mark(room_id, 0)

    async def _fan_out_forever(self) -> None:
        while self._running:
            await self._has_pending.wait()
            self._has_pending.clear()
            rooms = list(self._pending)
            self._pending.clear()
            for room_id in rooms:
                await self._wake_room(room_id)

    async def _wake_room(self, room_id: str) -> None:
        for waker in list(self._subscribers.get(room_id, ())):
            try:
                await waker(room_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                # One subscriber's failure is not the other subscribers' or the
                # other rooms' problem; this is the delivery loop, and it has to
                # survive whatever a handler does.
                logger.error(
                    "A subscriber failed handling new messages in room %s",
                    room_id,
                    exc_info=True,
                )
