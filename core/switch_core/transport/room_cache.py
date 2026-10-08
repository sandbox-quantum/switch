"""One read of a room's new messages, shared by every client watching it.

Each client has its own `PostgresTransport`, and each transport reads the rows
after its own cursor when the listener says a room moved. A room with six
agents in it therefore reads every new message six times, through six pool
checkouts, at the same moment. Under a restart burst that is what exhausted
the pool. This keeps one bounded copy of a room's recent rows in the process,
so the first transport to need them reads them and the rest are handed the
same rows.

**What an entry claims.** An entry for a room holds every row whose `seq` is
in `(floor, ceiling]`, exactly, and nothing else. A fill reads `seq >
ceiling` and appends, so the range only ever grows at the top and stays
contiguous. Trimming raises `floor`. A reader whose cursor is in
`[floor, ceiling)` is served from memory; one below `floor` reads the
database itself, and comes back once its cursor reaches the range. No read is
ever served across a hole, because the entry never has one.

**When an entry is current enough.** A row is visible to a read only if it
committed before the read's snapshot, and a reader woken for a row must not
be told "nothing new" by a read that started before that row committed. So
time here is a counter, `tick()`: a transport takes one when it is woken
(after the NOTIFY, so after the commit), and a fill takes one before it
queries. A fill that started after a reader's wake has seen what the reader
was woken for. `complete_as_of` is the start of the latest fill that reached
the end of the room: every row committed before it is at or below `ceiling`.
A reader may be told it has caught up only when that tick is later than its
own wake. This is what keeps the missed-notification window closed on the
first read after subscribing, without a database read per transport.

**One fill per room at a time.** It runs as a task of its own, not in any
transport's loop, so a client that is cancelled mid-read does not cancel the
read every other member is waiting on. Never from the listener's fan-out
either: a waker only notes the room, as it always has.

**Rows are immutable snapshots.** A row and its attachments are published
together, in one step with no await, after both reads finish. `content` is
kept as JSON text and parsed afresh for every delivery, so no two clients ever
hold the same dict. Attachment metadata only: the bytes live in `media_blobs`
and are never read here.

**Messages are append-only.** The NOTIFY trigger fires on INSERT only
(`db/notify_ddl.py`), nothing updates a delivered row, and deleting a room
cascades its messages away. A cached row is therefore never stale. A future
edit or redaction path must call `invalidate` for the room, or members would
keep being handed the old text from memory.

**What it does not do.** It checks nothing about who may read. The key is
`(tenant_id, room_id)`, taken from a transport that resolved the room under
its own tenant, and every fill reads under that tenant's session, so row-level
security applies to the fill exactly as it did to each transport's own read.
Whether *this* client is still in the room, and whether it wants the message,
stays with the transport and its consumer, checked after every await.
"""

from __future__ import annotations

import asyncio
import bisect
import json
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, cast

from switch_core.db.session_scope import tenant_session
from switch_core.observability.catalogue import (
    DELIVERY_CACHE_EVICTIONS,
    DELIVERY_CACHE_FILLS,
    DELIVERY_CACHE_READS,
    DELIVERY_CACHE_ROWS_READ,
)
from switch_core.observability.metrics import metrics
from switch_core.tenant_context import no_tenant

if TYPE_CHECKING:
    from collections.abc import Iterable

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.models import Message, MessageAttachment
    from switch_core.db.stores.message_store import MessageStore

logger = logging.getLogger(__name__)

# How many rows one wake-up reads at a time, by a transport or by a fill. A
# page rather than everything outstanding, so a room that moved a long way
# while a handler was busy is delivered in bounded steps instead of one
# unbounded read. Here rather than beside the transport so the process can
# size the cache without naming a transport implementation.
DELIVERY_PAGE = 200

# What a row costs beyond its strings: the object, its tuple slot, the
# datetime. An estimate, so the byte limit is a budget rather than a measure.
_ROW_OVERHEAD_BYTES = 400

# How many fills one read may wait for before it gives up and lets the
# transport read the database. Each fill started after the reader's wake
# either reaches the end of the room or adds a page, so one or two is the
# norm; this bounds the odd case of a cursor far ahead of an old entry.
_MAX_ROUNDS = 4

CacheKey = tuple[str, str]


@dataclass(frozen=True, slots=True)
class CachedAttachment:
    """A file's metadata, as `to_inbound` reads it off `MessageAttachment`."""

    uri: str
    filename: str | None
    mimetype: str | None
    size: int | None


@dataclass(frozen=True, slots=True)
class CachedRow:
    """A message row frozen at the moment it was read.

    Carries the attributes `to_inbound` and the delivery metrics read off a
    `Message`, under the same names, so both paths build an event the same
    way.
    """

    id: str
    seq: int
    transport_event_id: str
    sender_id: str
    sender_name: str | None
    event_type: str
    msgtype: str | None
    body: str | None
    formatted_body: str | None
    thread_root_event_id: str | None
    sent_at: datetime
    content_json: str
    attachments: tuple[CachedAttachment, ...]
    size: int

    @property
    def content(self) -> dict[str, Any]:
        """A fresh dict on every access, so one client's edit is its own."""
        return cast("dict[str, Any]", json.loads(self.content_json))

    @classmethod
    def of(cls, row: Message, attachments: Iterable[MessageAttachment]) -> CachedRow:
        files = tuple(
            CachedAttachment(
                uri=file.uri,
                filename=file.filename,
                mimetype=file.mimetype,
                size=file.size,
            )
            for file in attachments
        )
        content_json = json.dumps(row.content, separators=(",", ":"))
        texts = (
            row.transport_event_id,
            row.sender_id,
            row.sender_name,
            row.event_type,
            row.msgtype,
            row.body,
            row.formatted_body,
            row.thread_root_event_id,
            content_json,
        )
        size = _ROW_OVERHEAD_BYTES + sum(len(text) for text in texts if text)
        size += sum(
            len(file.uri) + len(file.filename or "") + len(file.mimetype or "") + 64
            for file in files
        )
        return cls(
            id=row.id,
            seq=row.seq,
            transport_event_id=row.transport_event_id,
            sender_id=row.sender_id,
            sender_name=row.sender_name,
            event_type=row.event_type,
            msgtype=row.msgtype,
            body=row.body,
            formatted_body=row.formatted_body,
            thread_root_event_id=row.thread_root_event_id,
            sent_at=cast("datetime", row.sent_at),
            content_json=content_json,
            attachments=files,
            size=size,
        )


@dataclass(frozen=True)
class RoomCacheLimits:
    """Process-wide bounds. Whatever falls outside them is read from the
    database, so a limit set too low costs reads, never messages."""

    max_bytes: int
    max_rooms: int
    max_rows_per_room: int
    max_age_seconds: float


@dataclass(frozen=True)
class RoomCacheStats:
    bytes: int
    rooms: int
    rows: int


@dataclass(frozen=True)
class CachedPage:
    """Rows after a reader's cursor, in `seq` order with no gaps.

    `done` means nothing else was committed before the reader was woken, so
    it can stop without asking again.
    """

    rows: tuple[CachedRow, ...]
    done: bool


class _Fill:
    __slots__ = ("after", "rows", "started", "task")

    def __init__(self, started: int, after: int) -> None:
        self.started = started
        # It reads the rows after this, so what it holds is (after, last].
        self.after = after
        # What it read, once checked; kept so its waiters can still use it if
        # the entry is dropped before it lands.
        self.rows: tuple[CachedRow, ...] | None = None
        self.task: asyncio.Task[None] | None = None


class _Entry:
    __slots__ = (
        "born",
        "bytes",
        "ceiling",
        "complete_as_of",
        "dropped",
        "filling",
        "floor",
        "rows",
    )

    def __init__(self, floor: int) -> None:
        self.floor = floor
        self.ceiling = floor
        self.rows: tuple[CachedRow, ...] = ()
        # When each row was cached, for the age limit. Parallel to `rows`.
        self.born: tuple[float, ...] = ()
        self.bytes = 0
        # No fill has reached the end yet, so no wake is covered.
        self.complete_as_of = -1
        self.filling: _Fill | None = None
        # Why it was dropped, once it has been.
        self.dropped: str | None = None


class RoomDeliveryCache:
    """The process's shared read of recent rows, one entry per watched room."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        message_store: MessageStore,
        limits: RoomCacheLimits,
        page: int = DELIVERY_PAGE,
    ) -> None:
        if limits.max_rooms < 1 or limits.max_bytes < 1:
            raise ValueError("the room delivery cache needs room for one room")
        if limits.max_rows_per_room < page:
            # A fill reads a page; a room that cannot hold one would trim what
            # it just read before anyone was served from it.
            raise ValueError(
                f"max_rows_per_room ({limits.max_rows_per_room}) must be at "
                f"least the delivery page ({page})"
            )
        self._session_factory = session_factory
        self._message_store = message_store
        self._limits = limits
        self._page = page
        # Least recently read first, so eviction pops from the front.
        self._entries: OrderedDict[CacheKey, _Entry] = OrderedDict()
        # Who is watching each room. An entry exists only while someone is,
        # which is what purges a room every member has left or that was
        # deleted (deleting a room removes its members first).
        self._watchers: dict[CacheKey, set[object]] = {}
        self._bytes = 0
        self._clock = 0

    # ── Time ──────────────────────────────────────────────────────────────────

    def tick(self) -> int:
        """A moment, ordered against every other moment in this process.

        Synchronous and strictly increasing, which is all the handoff needs:
        whether a fill started after a reader was woken.
        """
        self._clock += 1
        return self._clock

    # ── Who is watching ───────────────────────────────────────────────────────

    def attach(self, tenant_id: str, room_id: str, watcher: object) -> None:
        self._watchers.setdefault((tenant_id, room_id), set()).add(watcher)

    def detach(self, tenant_id: str, room_id: str, watcher: object) -> None:
        """Forget a watcher; drop the room's rows when it was the last.

        Safe for a watcher that never attached, like the buses' unsubscribe,
        because `_release_claim` undoes a claim that may never have
        subscribed.
        """
        key = (tenant_id, room_id)
        watchers = self._watchers.get(key)
        if watchers is None:
            return
        watchers.discard(watcher)
        if watchers:
            return
        del self._watchers[key]
        self._drop(key, "unwatched")

    def invalidate(self, tenant_id: str, room_id: str) -> None:
        """Drop everything held for a room.

        The hook for anything that changes a row after it was written (an
        edit, a redaction) or removes the room. Nothing does the former today;
        see the module docstring. A fill in flight for the room is discarded
        when it lands, and its waiters read the database: it may have read
        rows from before the change.
        """
        self._drop((tenant_id, room_id), "invalidated")

    # ── Reading ───────────────────────────────────────────────────────────────

    async def read(
        self,
        tenant_id: str,
        room_id: str,
        *,
        after_seq: int,
        woken_at: int,
        limit: int,
    ) -> CachedPage | None:
        """Rows after `after_seq`, or None for "read the database yourself".

        `woken_at` is the reader's tick from when it was last woken for this
        room. An empty page is only ever answered once a fill that started
        after it has reached the end of the room.
        """
        key = (tenant_id, room_id)
        waited = False
        for round_ in range(_MAX_ROUNDS + 1):
            if key not in self._watchers:
                self._count("unwatched")
                return None
            entry = self._entries.get(key)
            if entry is None:
                entry = self._create(key, floor=after_seq)
            else:
                self._entries.move_to_end(key)
                self._expire(key, entry)
            if after_seq < entry.floor:
                self._count("behind")
                return None
            if after_seq < entry.ceiling:
                start = bisect.bisect_right(entry.rows, after_seq, key=_seq_of)
                rows = entry.rows[start : start + limit]
                done = rows[-1].seq >= entry.ceiling and entry.complete_as_of > woken_at
                self._count("filled" if waited else "hit")
                return CachedPage(rows=rows, done=done)
            if entry.complete_as_of > woken_at:
                self._count("filled" if waited else "hit")
                return CachedPage(rows=(), done=True)
            if round_ == _MAX_ROUNDS:
                break
            fill = entry.filling
            if fill is None:
                fill = self._start_fill(key, entry)
            # A fill that started before this reader was woken may not have
            # seen what woke it. It is still waited for rather than run
            # beside, so a room has one read in flight; the next round starts
            # a fresh one.
            waited = True
            assert fill.task is not None
            await asyncio.shield(fill.task)
            if self._entries.get(key) is not entry:
                return self._from_dropped(
                    key,
                    entry,
                    fill,
                    after_seq=after_seq,
                    woken_at=woken_at,
                    limit=limit,
                )
        self._count("gave_up")
        return None

    def _from_dropped(
        self,
        key: CacheKey,
        entry: _Entry,
        fill: _Fill,
        *,
        after_seq: int,
        woken_at: int,
        limit: int,
    ) -> CachedPage | None:
        """Serve a waiter from a fill whose entry was dropped while it read.

        Evicted for room or bytes, the rows are as good as ever; they are just
        not kept. Sending every waiter to the database instead would put a
        read per member on top of the one already made, which under churn is
        the load this cache exists to remove. Invalidated means a row may have
        changed under the read, so its waiters still read the database.
        """
        if key not in self._watchers:
            self._count("unwatched")
            return None
        if (
            entry.dropped == "invalidated"
            or fill.rows is None
            or after_seq < fill.after
        ):
            self._count("evicted")
            return None
        rows = tuple(row for row in fill.rows if row.seq > after_seq)
        reached_end = len(fill.rows) < self._page and fill.started > woken_at
        if not rows and not reached_end:
            self._count("evicted")
            return None
        served = rows[:limit]
        self._count("filled")
        return CachedPage(rows=served, done=reached_end and len(served) == len(rows))

    def stats(self) -> RoomCacheStats:
        return RoomCacheStats(
            bytes=self._bytes,
            rooms=len(self._entries),
            rows=sum(len(entry.rows) for entry in self._entries.values()),
        )

    # ── Filling ───────────────────────────────────────────────────────────────

    def _create(self, key: CacheKey, *, floor: int) -> _Entry:
        entry = _Entry(floor)
        self._entries[key] = entry
        while len(self._entries) > self._limits.max_rooms:
            oldest = next(iter(self._entries))
            self._drop(oldest, "rooms")
        return entry

    def _start_fill(self, key: CacheKey, entry: _Entry) -> _Fill:
        # Ticked here, before the task can query, so a reader woken after
        # this moment never mistakes this fill for one that saw its row.
        fill = _Fill(started=self.tick(), after=entry.ceiling)
        task = asyncio.create_task(
            self._fill(key, entry, fill), name="room-delivery-cache-fill"
        )
        # Every waiter may have been cancelled; the outcome is still
        # retrieved, so a failed fill does not warn "never retrieved".
        task.add_done_callback(_retrieve)
        fill.task = task
        entry.filling = fill
        return fill

    async def _fill(self, key: CacheKey, entry: _Entry, fill: _Fill) -> None:
        tenant_id, room_id = key
        after = fill.after
        try:
            # The task inherits its creator's context; the session below binds
            # the tenant explicitly, and nothing else here should inherit one.
            with no_tenant():
                async with tenant_session(self._session_factory, tenant_id) as session:
                    rows = await self._message_store.list_for_room(
                        session, room_id, after_seq=after, limit=self._page
                    )
                    attachments = await self._message_store.attachments_for(
                        session, [row.id for row in rows]
                    )
            snapshots = tuple(
                CachedRow.of(row, attachments.get(row.id, ())) for row in rows
            )
        except BaseException:
            if entry.filling is fill:
                entry.filling = None
            metrics().increment(DELIVERY_CACHE_FILLS, {"outcome": "failed"})
            raise
        if entry.filling is fill:
            entry.filling = None
        metrics().increment(DELIVERY_CACHE_ROWS_READ, {}, float(len(snapshots)))
        if snapshots and snapshots[0].seq <= after:
            # `list_for_room` reads `seq > after` in order, so this cannot
            # happen; if it ever does, holding these rows would break the
            # range the entry claims.
            logger.error(
                "A fill for room %s returned seq %d at or below %d; discarding",
                room_id,
                snapshots[0].seq,
                after,
            )
            metrics().increment(DELIVERY_CACHE_FILLS, {"outcome": "discarded"})
            return
        fill.rows = snapshots
        if self._entries.get(key) is not entry or entry.ceiling != after:
            # Evicted, unwatched or invalidated while reading. Publishing into
            # a dropped entry would resurrect it outside the limits; its
            # waiters may still take the rows (`_from_dropped`).
            metrics().increment(DELIVERY_CACHE_FILLS, {"outcome": "discarded"})
            return
        self._publish(key, entry, fill, snapshots)
        metrics().increment(DELIVERY_CACHE_FILLS, {"outcome": "ok"})

    def _publish(
        self,
        key: CacheKey,
        entry: _Entry,
        fill: _Fill,
        snapshots: tuple[CachedRow, ...],
    ) -> None:
        """Make a fill's rows visible. No await, so nobody sees half of it."""
        now = time.monotonic()
        entry.rows = entry.rows + snapshots
        entry.born = entry.born + (now,) * len(snapshots)
        if snapshots:
            entry.ceiling = snapshots[-1].seq
        if len(snapshots) < self._page:
            # It read to the end of the room as of its snapshot.
            entry.complete_as_of = max(entry.complete_as_of, fill.started)
        added = sum(row.size for row in snapshots)
        entry.bytes += added
        self._bytes += added
        excess = len(entry.rows) - self._limits.max_rows_per_room
        if excess > 0:
            self._trim(entry, excess)
            metrics().increment(DELIVERY_CACHE_EVICTIONS, {"reason": "rows"})
        while self._bytes > self._limits.max_bytes and self._entries:
            self._drop(next(iter(self._entries)), "bytes")

    # ── Letting go ────────────────────────────────────────────────────────────

    def _expire(self, key: CacheKey, entry: _Entry) -> None:
        """Trim rows past the age limit. Lazy, on read: the byte and room
        limits are what bound memory, this only stops a quiet room holding
        rows nobody will ask for again."""
        horizon = time.monotonic() - self._limits.max_age_seconds
        stale = bisect.bisect_left(entry.born, horizon)
        if stale:
            self._trim(entry, stale)
            metrics().increment(DELIVERY_CACHE_EVICTIONS, {"reason": "age"})

    def _trim(self, entry: _Entry, count: int) -> None:
        """Drop the oldest `count` rows; the range now starts above them."""
        dropped = entry.rows[:count]
        entry.floor = dropped[-1].seq
        entry.rows = entry.rows[count:]
        entry.born = entry.born[count:]
        freed = sum(row.size for row in dropped)
        entry.bytes -= freed
        self._bytes -= freed

    def _drop(self, key: CacheKey, reason: str) -> None:
        entry = self._entries.pop(key, None)
        if entry is None:
            return
        entry.dropped = reason
        self._bytes -= entry.bytes
        metrics().increment(DELIVERY_CACHE_EVICTIONS, {"reason": reason})

    # ── Counting ──────────────────────────────────────────────────────────────

    def _count(self, outcome: str) -> None:
        metrics().increment(DELIVERY_CACHE_READS, {"outcome": outcome})


def _seq_of(row: CachedRow) -> int:
    return row.seq


def _retrieve(task: asyncio.Task[None]) -> None:
    if not task.cancelled():
        task.exception()
