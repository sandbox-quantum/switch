"""Hears session-activity announcements and pushes them to subscribers.

The database announces each change with the row in the payload (see
`db/session_activity_notify_ddl.py`); this holds the `LISTEN` and hands each
change to the subscribers for its tenant — an agent's stream for answers, a
bridge for activity. Nothing is read back unless the row was too large to ride
in the announcement.

Announcements are not durable: whatever arrives while the connection is down
is gone. So a reconnect tells every subscriber to resync from the tables, the
same "assume everything moved" rule `messages/notify.py` follows.

Connection handling mirrors `MessageListener`: its own connection outside the
pool, a heartbeat, and a capped backoff.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from switch_core.db.session_activity_notify_ddl import SESSION_ACTIVITY_CHANNEL
from switch_core.messages.notify import (
    HEARTBEAT_SECONDS,
    HEARTBEAT_TIMEOUT_SECONDS,
    RECONNECT_BACKOFF_BASE,
    RECONNECT_BACKOFF_CAP,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Change:
    """One announced change.

    `kind` is `activity`, or `approval.<state>` (`approval.open` for a new
    request). `row` is the row as the database stored it, or None when it was
    too large to announce, in which case `kind` is `activity` or
    `approval.changed` and the subscriber reads the row by its key.
    """

    kind: str
    tenant_id: str
    agent_id: str
    session_id: str
    # The activity `seq` or the approval `request_id`, as text.
    key: str
    row: dict[str, Any] | None

    @staticmethod
    def parse(payload: str) -> Change | None:
        try:
            data = json.loads(payload)
            table = data["table"]
            row = data.get("row")
            fields = row if row is not None else data["key"]
            if table == "session_activity_events":
                kind = "activity"
                key = str(fields["seq"] if row is not None else fields["key"])
            elif table == "approval_requests":
                kind = (
                    f"approval.{row['state']}"
                    if row is not None
                    else "approval.changed"
                )
                key = str(fields["request_id"] if row is not None else fields["key"])
            else:
                raise ValueError(table)
            return Change(
                kind=kind,
                tenant_id=str(fields["tenant_id"]),
                agent_id=str(fields["agent_id"]),
                session_id=str(fields["session_id"]),
                key=key,
                row=row,
            )
        except (ValueError, TypeError, KeyError):
            logger.warning(
                "Ignoring an unreadable session-activity announcement: %r",
                payload[:200],
            )
            return None


OnChange = Callable[[Change], Awaitable[None]]
OnResync = Callable[[], Awaitable[None]]
EngineFactory = Callable[[], "AsyncEngine"]


@dataclass(frozen=True)
class _Subscriber:
    on_change: OnChange
    on_resync: OnResync


_RESYNC = object()


class SessionActivityListener:
    def __init__(self, engine_factory: EngineFactory) -> None:
        self._engine_factory = engine_factory
        self._subscribers: dict[str, set[_Subscriber]] = {}
        self._queue: asyncio.Queue[Change | object] = asyncio.Queue()
        self._tasks: list[asyncio.Task[None]] = []
        self._running = False
        self.connected = asyncio.Event()

    def subscribe(
        self, tenant_id: str, on_change: OnChange, on_resync: OnResync
    ) -> Callable[[], None]:
        """Receive the tenant's changes; returns the unsubscribe callable.

        `on_resync` runs whenever announcements may have been missed — on
        connecting and on every reconnect — and should catch up from the tables.
        """
        subscriber = _Subscriber(on_change, on_resync)
        self._subscribers.setdefault(tenant_id, set()).add(subscriber)

        def unsubscribe() -> None:
            subscribers = self._subscribers.get(tenant_id)
            if subscribers is not None:
                subscribers.discard(subscriber)
                if not subscribers:
                    del self._subscribers[tenant_id]

        return unsubscribe

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._running:
            raise RuntimeError("SessionActivityListener is already started")
        self._running = True
        self._tasks = [
            asyncio.create_task(
                self._listen_forever(), name="session-activity-listener"
            ),
            asyncio.create_task(
                self._fan_out_forever(), name="session-activity-fan-out"
            ),
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
                    "Session-activity listener lost its connection; retrying in %.1fs",
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
                        "No driver connection behind the session-activity "
                        "listener; LISTEN needs asyncpg directly"
                    )
                await driver.add_listener(SESSION_ACTIVITY_CHANNEL, self._on_notify)
                try:
                    self._queue.put_nowait(_RESYNC)
                    self.connected.set()
                    while self._running:
                        await asyncio.sleep(HEARTBEAT_SECONDS)
                        await driver.execute(
                            "SELECT 1", timeout=HEARTBEAT_TIMEOUT_SECONDS
                        )
                finally:
                    self.connected.clear()
                    with contextlib.suppress(Exception):
                        await driver.remove_listener(
                            SESSION_ACTIVITY_CHANNEL, self._on_notify
                        )
        finally:
            await engine.dispose()

    def _on_notify(
        self, _connection: Any, _pid: int, _channel: str, payload: str
    ) -> None:
        """asyncpg's callback: parse and queue, never wait on a subscriber here."""
        change = Change.parse(payload)
        if change is not None:
            self._queue.put_nowait(change)

    # ── Fan-out ───────────────────────────────────────────────────────────────

    async def _fan_out_forever(self) -> None:
        while self._running:
            item = await self._queue.get()
            if item is _RESYNC:
                for tenant_id, subscribers in list(self._subscribers.items()):
                    for subscriber in list(subscribers):
                        await self._call(tenant_id, subscriber.on_resync())
            elif isinstance(item, Change):
                for subscriber in list(self._subscribers.get(item.tenant_id, ())):
                    await self._call(item.tenant_id, subscriber.on_change(item))

    async def _call(self, tenant_id: str, handler: Awaitable[None]) -> None:
        try:
            await handler
        except asyncio.CancelledError:
            raise
        except Exception:
            # One subscriber's failure is not the others' problem; this is the
            # delivery loop, and it has to survive whatever a handler does.
            logger.error(
                "A session-activity subscriber failed for tenant %s",
                tenant_id,
                exc_info=True,
            )
