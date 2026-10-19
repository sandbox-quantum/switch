"""Signals between switch-core processes, over Postgres `NOTIFY`.

A signal says that something changed and who should look: "controller C has a
new assignment", "controller C was revoked". It never carries the change
itself. Whoever holds the client the signal is about reads the database, the
same rule `messages/notify.py` follows for rooms, so a signal that is lost
costs a delay and never a wrong answer.

Every process listens on one channel. The process that makes a change acts on
it locally at once and publishes the signal for the others, which skip their
own: the holder of a controller's socket may be any process, and the database
is the one path that reaches it wherever it is.

Publishing is batched. A transaction that sends a `NOTIFY` takes a lock that
every other notifying transaction waits on as it commits, so signals raised
together go out in one statement rather than one transaction each. Payloads
are ids and small fields only: `NOTIFY` is not subject to row-level security,
and any session listening on the channel can read what is sent.

Reconnecting resyncs. Signals sent while the listening connection was down
were never queued, so every registered resync runs once the connection is back,
and each re-reads what its clients are owed.

Nothing here is allowed to lose a change for good. A batch that fails to send
is kept and sent again, as the controller connection ledger keeps its writes.
And because a signal can still be missed (its sender died between the commit
and the send, or a receiver was busy restarting), every family also registers
a periodic re-check that compares what this process holds with the database.
A missed signal then costs at most `RECHECK_SECONDS` of delay. That is only
safe because every handler and every re-check re-reads state and is
idempotent: signals from different processes arrive in no particular order.

Work a signal asks for that needs the database goes through `PendingWork`:
the handler adds a key and returns at once, one task re-reads each key, and a
key whose re-read fails is kept and tried again.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable, Hashable
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

SIGNAL_CHANNEL = "switch_signal"

# How often the listening connection is proved alive, and how long the proof may
# take, as `MessageListener` does.
HEARTBEAT_SECONDS = 20.0
HEARTBEAT_TIMEOUT_SECONDS = 60.0
RECONNECT_BACKOFF_BASE = 1.0
RECONNECT_BACKOFF_CAP = 15.0

# Postgres refuses a payload of 8000 bytes or more. Ours are a few dozen.
MAX_PAYLOAD_BYTES = 7999

# How long a batch that failed to send, or a key whose re-read failed, waits
# before it is tried again.
RETRY_SECONDS = 2.0

# How many unsent signals are kept while the database refuses them. Past this
# the oldest are dropped and logged: by then the database has been unreachable
# for a long while, and the periodic re-checks bring every process back in
# line once it returns, so holding more would only cost memory.
MAX_UNSENT = 10_000

# How often every family's re-check runs, so that a signal missed for any
# reason costs at most this long rather than lasting until a restart.
RECHECK_SECONDS = 30.0

SignalHandler = Callable[[dict[str, Any]], None]
Resync = Callable[[], Awaitable[None]]
Recheck = Callable[[], Awaitable[None]]
EngineFactory = Callable[[], "AsyncEngine"]

_NOTIFY_MANY = text(
    "SELECT pg_notify(:channel, payload) FROM unnest(CAST(:payloads AS text[])) AS payload"
)


class PendingWork[K: Hashable]:
    """Keys whose state has to be re-read, worked one at a time by one task.

    A key added again before its turn is still one piece of work, which is
    what lets a burst of signals about one thing cost one read. A key whose
    work raises is kept and tried again after `RETRY_SECONDS`, so a database
    error on the receiving side delays a change rather than dropping it.
    """

    def __init__(self, name: str, work: Callable[[K], Awaitable[None]]) -> None:
        self.name = name
        self._work = work
        # A dict rather than a set, so keys are worked in the order they came.
        self._pending: dict[K, None] = {}
        self._wake = asyncio.Event()

    def add(self, key: K) -> None:
        self._pending[key] = None
        self._wake.set()

    @property
    def pending(self) -> int:
        return len(self._pending)

    async def run(self) -> None:
        """Work keys as they are added, until cancelled."""
        while True:
            await self._wake.wait()
            self._wake.clear()
            failed = await self.work_all()
            if failed:
                logger.error(
                    "%d %s re-read(s) failed; kept and retried in %.0fs",
                    len(failed),
                    self.name,
                    RETRY_SECONDS,
                )
                await asyncio.sleep(RETRY_SECONDS)
                self._wake.set()

    async def work_all(self) -> list[K]:
        """Work every key now pending. Returns the keys that failed, which
        are pending again."""
        failed: list[K] = []
        while self._pending:
            key = next(iter(self._pending))
            del self._pending[key]
            try:
                await self._work(key)
            except asyncio.CancelledError:
                self._pending.setdefault(key, None)
                raise
            except Exception:
                logger.warning("Re-reading %s %r failed", self.name, key, exc_info=True)
                failed.append(key)
        for key in failed:
            self._pending.setdefault(key, None)
        return failed


class SignalBus:
    """Publishes signals to every process and hands each process its own."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        engine_factory: EngineFactory,
        process_id: str,
    ) -> None:
        self._session_factory = session_factory
        # Signals carry the sender's process id, and a process skips its own:
        # whoever publishes has already acted on the change locally.
        self.process_id = process_id
        # A factory, as for `MessageListener`: a reconnect builds a fresh engine.
        self._engine_factory = engine_factory
        self._handlers: dict[str, SignalHandler] = {}
        self._resyncs: list[Resync] = []
        self._rechecks: list[Recheck] = []
        self._work: list[PendingWork[Any]] = []
        self._outbox: list[str] = []
        self._has_outbox = asyncio.Event()
        self._inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._tasks: list[asyncio.Task[None]] = []
        self._running = False
        self.connected = asyncio.Event()

    # ── Registration ──────────────────────────────────────────────────────────

    def handle(self, kind: str, handler: SignalHandler) -> None:
        """Run `handler` for every signal of `kind` another process sends.

        Handlers run in the dispatch loop and must not block: they hand the
        signal to whatever holds the client, which does its own I/O."""
        if kind in self._handlers:
            raise ValueError(f"A handler for signal {kind!r} is already registered")
        self._handlers[kind] = handler

    def on_resync(self, resync: Resync) -> None:
        """Run `resync` each time the listening connection is (re)established."""
        self._resyncs.append(resync)

    def on_recheck(self, recheck: Recheck) -> None:
        """Run `recheck` every `RECHECK_SECONDS` while the bus runs.

        A family's re-check compares what this process holds with the
        database and repairs any difference, so it must be idempotent and
        cheap when nothing changed: a read, never a write."""
        self._rechecks.append(recheck)

    def pending_work[K: Hashable](
        self, name: str, work: Callable[[K], Awaitable[None]]
    ) -> PendingWork[K]:
        """A `PendingWork` whose task runs while the bus does: where a
        handler puts what it has to read from the database."""
        pending = PendingWork(name, work)
        self._work.append(pending)
        if self._running:
            self._tasks.append(
                asyncio.create_task(pending.run(), name=f"signal-work-{name}")
            )
        return pending

    # ── Publishing ────────────────────────────────────────────────────────────

    def publish(self, kind: str, **fields: Any) -> None:
        """Send a signal to every process, after the change it announces has
        committed. Never blocks the caller: the send is batched, and a batch
        that fails is kept and sent again rather than raised, since the
        change itself is already durable."""
        payload = json.dumps(
            {"kind": kind, "from": self.process_id, **fields}, separators=(",", ":")
        )
        if len(payload.encode()) > MAX_PAYLOAD_BYTES:
            raise ValueError(
                f"Signal {kind!r} is too large to send ({len(payload)} bytes)"
            )
        self._outbox.append(payload)
        self._has_outbox.set()

    @property
    def unsent(self) -> int:
        return len(self._outbox)

    async def _send_forever(self) -> None:
        while self._running:
            await self._has_outbox.wait()
            self._has_outbox.clear()
            batch, self._outbox = self._outbox, []
            if not batch:
                continue
            # Set once the batch's transaction has committed, which is when
            # Postgres sends it: what fails after that (closing the session)
            # did not stop it going, and keeping it would send it twice.
            committed = False
            try:
                async with self._session_factory() as session:
                    await session.execute(
                        _NOTIFY_MANY, {"channel": SIGNAL_CHANNEL, "payloads": batch}
                    )
                    await session.commit()
                    committed = True
            except asyncio.CancelledError:
                if not committed:
                    self._outbox = batch + self._outbox
                raise
            except Exception:
                if committed:
                    logger.warning(
                        "Sent %d signal(s), then closing the session failed",
                        len(batch),
                        exc_info=True,
                    )
                    continue
                # The receivers' listening connections did not drop, so none
                # of them will resync: a batch dropped here would be lost
                # until the next re-check. Kept ahead of anything published
                # since, so a process still receives one sender's signals in
                # the order they were raised.
                self._outbox = batch + self._outbox
                if len(self._outbox) > MAX_UNSENT:
                    dropped = len(self._outbox) - MAX_UNSENT
                    self._outbox = self._outbox[dropped:]
                    logger.error(
                        "Dropped the %d oldest unsent signal(s); the periodic "
                        "re-checks repair what they announced",
                        dropped,
                    )
                logger.error(
                    "Could not send %d signal(s); kept and retried in %.0fs",
                    len(self._outbox),
                    RETRY_SECONDS,
                    exc_info=True,
                )
                await asyncio.sleep(RETRY_SECONDS)
                self._has_outbox.set()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._running:
            raise RuntimeError("SignalBus is already started")
        self._running = True
        self._tasks = [
            asyncio.create_task(self._listen_forever(), name="signal-listener"),
            asyncio.create_task(self._dispatch_forever(), name="signal-dispatch"),
            asyncio.create_task(self._send_forever(), name="signal-sender"),
            asyncio.create_task(self._recheck_forever(), name="signal-recheck"),
        ]
        self._tasks += [
            asyncio.create_task(pending.run(), name=f"signal-work-{pending.name}")
            for pending in self._work
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
                    "Signal listener lost its connection; retrying in %.1fs",
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
                        "No driver connection behind the signal listener; "
                        "LISTEN needs asyncpg directly"
                    )
                await driver.add_listener(SIGNAL_CHANNEL, self._on_notify)
                try:
                    self.connected.set()
                    await self._resync_all()
                    await self._hold_open(driver)
                finally:
                    self.connected.clear()
                    with contextlib.suppress(Exception):
                        await driver.remove_listener(SIGNAL_CHANNEL, self._on_notify)
        finally:
            await engine.dispose()

    async def _hold_open(self, driver: Any) -> None:
        while self._running:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            await driver.execute("SELECT 1", timeout=HEARTBEAT_TIMEOUT_SECONDS)

    def _on_notify(
        self, _connection: Any, _pid: int, _channel: str, payload: str
    ) -> None:
        """asyncpg's callback, in the connection's read loop: queue and return."""
        try:
            signal = json.loads(payload)
            if not isinstance(signal, dict) or not isinstance(signal.get("kind"), str):
                raise ValueError("no kind")
        except ValueError:
            logger.warning("Ignoring an unreadable signal: %r", payload[:200])
            return
        self._inbox.put_nowait(signal)

    async def _recheck_forever(self) -> None:
        while self._running:
            await asyncio.sleep(RECHECK_SECONDS)
            await self.recheck_all()

    async def recheck_all(self) -> None:
        """Run every family's re-check once, one after another so they never
        compete for the pool, each failure logged and left to the next run."""
        for recheck in self._rechecks:
            try:
                await recheck()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("A signal re-check failed", exc_info=True)

    async def _resync_all(self) -> None:
        for resync in self._resyncs:
            try:
                await resync()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("A signal resync failed", exc_info=True)

    # ── Dispatch ──────────────────────────────────────────────────────────────

    async def _dispatch_forever(self) -> None:
        while self._running:
            signal = await self._inbox.get()
            if signal.get("from") == self.process_id:
                continue
            handler = self._handlers.get(signal["kind"])
            if handler is None:
                # A newer process may send kinds an older one does not know,
                # during a rolling deploy.
                logger.debug("No handler for signal %r", signal["kind"])
                continue
            try:
                handler(signal)
            except Exception:
                logger.error("Handling signal %r failed", signal["kind"], exc_info=True)


def payload_chunks[T](entries: list[T], envelope_bytes: int) -> list[list[T]]:
    """Split the list a signal carries into lists that each fit in one payload
    under the `NOTIFY` limit, beside the `envelope_bytes` kept for the
    signal's other fields. Measured as JSON, which writes a character outside
    ASCII in up to twelve bytes. An entry too large to fit even alone gets a
    list of its own, which `SignalBus.publish` then refuses."""
    chunks: list[list[T]] = []
    current: list[T] = []
    size = envelope_bytes
    for entry in entries:
        cost = len(json.dumps(entry)) + 1
        if current and size + cost > MAX_PAYLOAD_BYTES:
            chunks.append(current)
            current, size = [], envelope_bytes
        current.append(entry)
        size += cost
    if current:
        chunks.append(current)
    return chunks
