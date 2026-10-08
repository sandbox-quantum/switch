"""The room delivery cache on its own, against a store a test can steer.

These pin the rules the cache rests on without a database in the way: what
range an entry claims, when a shared read counts for a reader, what is
published together, and what happens at every limit. The same rules are
proved again through `PostgresTransport` against Postgres in
`test_room_delivery_cache.py`; here a test can stop a read half-way and look.
"""

from __future__ import annotations

import asyncio
import contextlib
import random
import uuid
from collections.abc import AsyncIterator, Collection
from datetime import UTC, datetime
from typing import Any

import pytest

from switch_core.db.models import Message, MessageAttachment
from switch_core.tenant_context import current_tenant_id
from switch_core.transport.room_cache import (
    CachedAttachment,
    CachedPage,
    RoomCacheLimits,
    RoomDeliveryCache,
)

TENANT = "tenant-a"
ROOM = "room-1"
PAGE = 5


class _Sessions:
    """Stands in for the session factory: `tenant_session` only enters it."""

    def __call__(self) -> contextlib.AbstractAsyncContextManager[object]:
        return self._session()

    @contextlib.asynccontextmanager
    async def _session(self) -> AsyncIterator[object]:
        yield object()


class _Store:
    """The two reads a fill makes, over rows a test commits.

    A read takes its snapshot when it is called, like a statement does, and
    can then be held at `gate` so a test can act while it is in flight.
    """

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], list[Message]] = {}
        self.files: dict[str, list[MessageAttachment]] = {}
        self.reads = 0
        self.tenants: list[str | None] = []
        self.gate: asyncio.Event | None = None
        self.attachments_gate: asyncio.Event | None = None
        self.fail_next = False
        self.yield_randomly: random.Random | None = None

    def commit(
        self,
        room_id: str = ROOM,
        *,
        tenant_id: str = TENANT,
        body: str | None = None,
        files: int = 0,
    ) -> Message:
        log = self.rows.setdefault((tenant_id, room_id), [])
        seq = (log[-1].seq if log else 0) + 1
        row = Message(
            id=uuid.uuid4().hex,
            seq=seq,
            room_id=room_id,
            transport_event_id=f"sw_{uuid.uuid4().hex}",
            sender_id="@a:test",
            sender_name="a",
            event_type="m.room.message",
            msgtype="m.file" if files else "m.text",
            body=body or f"line {seq}",
            formatted_body=None,
            thread_root_event_id=None,
            content={"body": body or f"line {seq}", "nested": {"n": seq}},
            sent_at=datetime.now(UTC),
        )
        log.append(row)
        self.files[row.id] = [
            MessageAttachment(
                message_id=row.id,
                position=i,
                uri=f"switch-media://{row.id}/{i}",
                filename=f"f{i}.txt",
                mimetype="text/plain",
                size=10 + i,
            )
            for i in range(files)
        ]
        return row

    async def _maybe_yield(self) -> None:
        if self.yield_randomly is not None:
            for _ in range(self.yield_randomly.randint(0, 3)):
                await asyncio.sleep(0)

    async def list_for_room(
        self, session: object, room_id: str, *, after_seq: int, limit: int
    ) -> list[Message]:
        self.reads += 1
        tenant = current_tenant_id()
        self.tenants.append(tenant)
        await self._maybe_yield()
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("pool timeout")
        log = self.rows.get((tenant or "", room_id), [])
        snapshot = [row for row in log if row.seq > after_seq][:limit]
        if self.gate is not None:
            await self.gate.wait()
        await self._maybe_yield()
        return snapshot

    async def attachments_for(
        self, session: object, message_ids: Collection[str]
    ) -> dict[str, list[MessageAttachment]]:
        if self.attachments_gate is not None:
            await self.attachments_gate.wait()
        await self._maybe_yield()
        return {i: self.files[i] for i in message_ids if self.files.get(i)}


def _limits(**overrides: Any) -> RoomCacheLimits:
    values: dict[str, Any] = {
        "max_bytes": 10_000_000,
        "max_rooms": 100,
        "max_rows_per_room": 50,
        "max_age_seconds": 300.0,
    }
    values.update(overrides)
    return RoomCacheLimits(**values)


def _cache(store: _Store, page: int = PAGE, **limits: Any) -> RoomDeliveryCache:
    return RoomDeliveryCache(
        session_factory=_Sessions(),  # type: ignore[arg-type]
        message_store=store,  # type: ignore[arg-type]
        limits=_limits(**limits),
        page=page,
    )


def _seqs(page: CachedPage | None) -> list[int]:
    assert page is not None
    return [row.seq for row in page.rows]


async def _read(
    cache: RoomDeliveryCache,
    after_seq: int,
    woken_at: int,
    *,
    tenant_id: str = TENANT,
    room_id: str = ROOM,
) -> CachedPage | None:
    return await cache.read(
        tenant_id, room_id, after_seq=after_seq, woken_at=woken_at, limit=PAGE
    )


async def _until(predicate: Any) -> None:
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("never happened")


class TestOneFillPerRoom:
    async def test_concurrent_reads_for_one_room_collapse_into_one_fill(self) -> None:
        store = _Store()
        cache = _cache(store)
        watchers = [object() for _ in range(6)]
        for watcher in watchers:
            cache.attach(TENANT, ROOM, watcher)
        for _ in range(3):
            store.commit()
        store.gate = asyncio.Event()
        woken = cache.tick()

        readers = [asyncio.create_task(_read(cache, 0, woken)) for _ in watchers]
        await _until(lambda: store.reads == 1)
        for _ in range(5):
            await asyncio.sleep(0)
        assert store.reads == 1, "a second read started while one was in flight"
        store.gate.set()
        pages = await asyncio.gather(*readers)

        assert store.reads == 1
        assert all(_seqs(page) == [1, 2, 3] for page in pages)
        assert all(page is not None and page.done for page in pages)

    async def test_a_reader_cancelled_while_waiting_does_not_cancel_the_fill(
        self,
    ) -> None:
        """The fill is the room's, not the reader's that happened to start it."""
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        cache.attach(TENANT, ROOM, "b")
        store.commit()
        store.gate = asyncio.Event()
        woken = cache.tick()

        starter = asyncio.create_task(_read(cache, 0, woken))
        await _until(lambda: store.reads == 1)
        other = asyncio.create_task(_read(cache, 0, woken))
        await asyncio.sleep(0)
        starter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await starter
        store.gate.set()

        assert _seqs(await other) == [1]
        assert store.reads == 1

    async def test_a_failed_fill_reaches_its_waiters_and_the_next_read_retries(
        self,
    ) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        store.commit()
        store.fail_next = True
        woken = cache.tick()

        with pytest.raises(RuntimeError, match="pool timeout"):
            await _read(cache, 0, woken)
        assert _seqs(await _read(cache, 0, woken)) == [1]


class TestTheHandoff:
    """The range an entry claims, and when a shared read counts for a reader."""

    async def test_a_reader_inside_the_range_gets_exactly_the_rows_after_it(
        self,
    ) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        for _ in range(4):
            store.commit()
        woken = cache.tick()
        assert _seqs(await _read(cache, 0, woken)) == [1, 2, 3, 4]

        for cursor in range(4):
            page = await _read(cache, cursor, woken)
            assert _seqs(page) == list(range(cursor + 1, 5))
            assert page is not None and page.done
        assert store.reads == 1

    async def test_a_fill_that_began_before_a_wake_does_not_answer_for_it(
        self,
    ) -> None:
        """The missed-notification window, closed.

        A read that took its snapshot before row 2 committed cannot say there
        is nothing after 1 to a reader woken for row 2. It is waited for, not
        trusted, and a fresh fill finds the row.
        """
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        cache.attach(TENANT, ROOM, "b")
        store.commit()
        store.gate = asyncio.Event()
        early = asyncio.create_task(_read(cache, 0, cache.tick()))
        await _until(lambda: store.reads == 1)

        store.commit()  # row 2, committed after the fill's snapshot
        woken_for_two = cache.tick()
        late = asyncio.create_task(_read(cache, 0, woken_for_two))
        await asyncio.sleep(0)
        store.gate.set()

        assert _seqs(await early) == [1]
        first = await late
        assert _seqs(first) == [1]
        assert first is not None and not first.done, "told it was caught up"
        second = await _read(cache, 1, woken_for_two)
        assert _seqs(second) == [2]
        assert second is not None and second.done
        assert store.reads == 2

    async def test_caught_up_means_a_fill_after_the_wake_reached_the_end(
        self,
    ) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        store.commit()
        before = cache.tick()
        assert _seqs(await _read(cache, 0, before)) == [1]

        # Nothing new, and the last fill started after this wake: no read.
        assert _seqs(await _read(cache, 1, before)) == []
        assert store.reads == 1

        # Woken again: the old fill cannot vouch for it, so one more read.
        store.commit()
        later = cache.tick()
        assert _seqs(await _read(cache, 1, later)) == [2]
        assert store.reads == 2

    async def test_a_reader_below_the_range_is_sent_to_the_database(self) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        for _ in range(3):
            store.commit()
        woken = cache.tick()
        # The first reader is at 2, so the entry starts there.
        assert _seqs(await _read(cache, 2, woken)) == [3]

        assert await _read(cache, 1, woken) is None
        assert await _read(cache, 0, woken) is None
        # Once its own reads bring it to the range, it is served from it.
        assert _seqs(await _read(cache, 2, woken)) == [3]

    async def test_a_reader_ahead_of_the_entry_extends_it_without_a_gap(
        self,
    ) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        store.commit()
        assert _seqs(await _read(cache, 0, cache.tick())) == [1]
        for _ in range(3):
            store.commit()

        woken = cache.tick()
        # This reader read 2 and 3 itself; the entry extends from 1, not 3.
        assert _seqs(await _read(cache, 3, woken)) == [4]
        assert _seqs(await _read(cache, 0, woken)) == [1, 2, 3, 4]

    async def test_a_long_room_is_read_a_page_at_a_time(self) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        for _ in range(PAGE * 2 + 1):
            store.commit()
        woken = cache.tick()

        cursor, seen = 0, []
        while True:
            page = await _read(cache, cursor, woken)
            assert page is not None
            seen.extend(row.seq for row in page.rows)
            if page.rows:
                cursor = page.rows[-1].seq
            if page.done:
                break
        assert seen == list(range(1, PAGE * 2 + 2))


class TestWhatIsPublished:
    async def test_rows_are_published_only_with_their_attachments(self) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        cache.attach(TENANT, ROOM, "b")
        store.commit(files=2)
        store.attachments_gate = asyncio.Event()
        woken = cache.tick()

        first = asyncio.create_task(_read(cache, 0, woken))
        await _until(lambda: store.reads == 1)
        # Rows read, attachments not yet: nothing is visible to anyone.
        assert cache.stats().rows == 0
        second = asyncio.create_task(_read(cache, 0, woken))
        await asyncio.sleep(0)
        assert not second.done()
        store.attachments_gate.set()

        for page in (await first, await second):
            assert page is not None
            (row,) = page.rows
            assert [f.uri for f in row.attachments] == [
                f"switch-media://{row.id}/0",
                f"switch-media://{row.id}/1",
            ]

    async def test_attachments_are_metadata_only(self) -> None:
        """Media bytes live in `media_blobs` and are never read or held."""
        assert set(CachedAttachment.__slots__) == {
            "uri",
            "filename",
            "mimetype",
            "size",
        }

    async def test_each_access_to_content_is_a_fresh_dict(self) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        store.commit(body="original")
        page = await _read(cache, 0, cache.tick())
        assert page is not None
        (row,) = page.rows

        mine = row.content
        mine["body"] = "edited"
        mine["nested"]["n"] = -1
        theirs = row.content
        assert theirs["body"] == "original"
        assert theirs["nested"] == {"n": 1}

    async def test_a_cached_row_cannot_be_changed(self) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        store.commit()
        page = await _read(cache, 0, cache.tick())
        assert page is not None
        with pytest.raises(AttributeError):
            page.rows[0].body = "edited"  # type: ignore[misc]


class TestKeys:
    async def test_an_entry_is_never_served_to_another_tenant(self) -> None:
        """Same room id, two tenants: two entries, each filled under its own
        tenant. A room id alone never finds another tenant's rows."""
        store = _Store()
        cache = _cache(store)
        cache.attach("tenant-a", ROOM, "a")
        cache.attach("tenant-b", ROOM, "b")
        store.commit(tenant_id="tenant-a", body="for a")
        woken = cache.tick()

        mine = await _read(cache, 0, woken, tenant_id="tenant-a")
        theirs = await _read(cache, 0, woken, tenant_id="tenant-b")

        assert mine is not None and [r.body for r in mine.rows] == ["for a"]
        assert theirs is not None and theirs.rows == ()
        assert store.tenants == ["tenant-a", "tenant-b"]
        assert cache.stats().rooms == 2

    async def test_a_room_nobody_is_watching_is_not_cached(self) -> None:
        store = _Store()
        cache = _cache(store)
        store.commit()
        assert await _read(cache, 0, cache.tick()) is None
        assert cache.stats().rooms == 0
        assert store.reads == 0


class TestLettingGo:
    async def _filled(self, cache: RoomDeliveryCache, store: _Store) -> None:
        cache.attach(TENANT, ROOM, "a")
        store.commit()
        assert _seqs(await _read(cache, 0, cache.tick())) == [1]

    async def test_the_last_watcher_leaving_purges_the_room(self) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "b")
        await self._filled(cache, store)

        cache.detach(TENANT, ROOM, "a")
        assert cache.stats().rooms == 1, "one member is still watching"
        cache.detach(TENANT, ROOM, "b")
        assert cache.stats() == cache.stats().__class__(bytes=0, rooms=0, rows=0)

    async def test_detaching_what_never_attached_is_harmless(self) -> None:
        cache = _cache(_Store())
        cache.detach(TENANT, ROOM, "never")

    async def test_invalidate_drops_the_entry(self) -> None:
        """The hook for a future edit or redaction, and for room deletion."""
        store = _Store()
        cache = _cache(store)
        await self._filled(cache, store)

        cache.invalidate(TENANT, ROOM)

        assert cache.stats().rooms == 0
        assert cache.stats().bytes == 0
        # Still watched, so the next read fills afresh from the database.
        assert _seqs(await _read(cache, 0, cache.tick())) == [1]
        assert store.reads == 2

    async def test_invalidate_during_a_fill_sends_its_waiters_to_the_database(
        self,
    ) -> None:
        store = _Store()
        cache = _cache(store)
        cache.attach(TENANT, ROOM, "a")
        store.commit()
        store.gate = asyncio.Event()
        reader = asyncio.create_task(_read(cache, 0, cache.tick()))
        await _until(lambda: store.reads == 1)

        cache.invalidate(TENANT, ROOM)
        store.gate.set()

        assert await reader is None
        assert cache.stats().rooms == 0, "a discarded fill came back to life"

    async def test_an_eviction_during_a_fill_still_serves_its_waiters(
        self,
    ) -> None:
        """The rows were read once already; a waiter reading them again
        because the entry was evicted would multiply the load under churn."""
        store = _Store()
        cache = _cache(store, max_rooms=1)
        cache.attach(TENANT, ROOM, "a")
        cache.attach(TENANT, "other", "b")
        store.commit()
        store.commit("other")
        store.gate = asyncio.Event()
        woken = cache.tick()
        waiters = [asyncio.create_task(_read(cache, 0, woken)) for _ in range(3)]
        await _until(lambda: store.reads == 1)
        # Another room's read takes the only slot and evicts this one mid-fill.
        other = asyncio.create_task(_read(cache, 0, cache.tick(), room_id="other"))
        await _until(lambda: store.reads == 2)

        store.gate.set()

        for waiter in waiters:
            page = await waiter
            assert page is not None, "an evicted fill sent its waiter to the database"
            assert _seqs(page) == [1]
            assert page.done
        assert _seqs(await other) == [1]
        assert cache.stats().rooms == 1, "the evicted room came back"
        assert store.reads == 2

    async def test_the_byte_limit_evicts_the_least_recently_read_room(
        self,
    ) -> None:
        store = _Store()
        probe = _cache(store)
        probe.attach(TENANT, "probe", "p")
        store.commit("probe")
        await _read(probe, 0, probe.tick(), room_id="probe")
        one_row = probe.stats().bytes

        cache = _cache(store, max_bytes=one_row * 2 + one_row // 2)
        for room in ("r1", "r2", "r3"):
            cache.attach(TENANT, room, "a")
            store.commit(room)
        woken = cache.tick()
        await _read(cache, 0, woken, room_id="r1")
        await _read(cache, 0, woken, room_id="r2")
        await _read(cache, 0, woken, room_id="r1")  # r2 is now the oldest
        await _read(cache, 0, cache.tick(), room_id="r3")

        assert cache.stats().rooms == 2
        assert cache.stats().bytes <= one_row * 2 + one_row // 2
        reads = store.reads
        await _read(cache, 0, woken, room_id="r1")
        assert store.reads == reads, "r1 should have survived"
        await _read(cache, 0, cache.tick(), room_id="r2")
        assert store.reads == reads + 1, "r2 should have been evicted"

    async def test_the_room_limit_evicts_the_least_recently_read_room(
        self,
    ) -> None:
        store = _Store()
        cache = _cache(store, max_rooms=2)
        for room in ("r1", "r2", "r3"):
            cache.attach(TENANT, room, "a")
            store.commit(room)
            await _read(cache, 0, cache.tick(), room_id=room)
        assert cache.stats().rooms == 2

    async def test_the_row_limit_raises_the_floor(self) -> None:
        store = _Store()
        cache = _cache(store, max_rows_per_room=PAGE)
        cache.attach(TENANT, ROOM, "a")
        for _ in range(PAGE):
            store.commit()
        woken = cache.tick()
        assert len(_seqs(await _read(cache, 0, woken))) == PAGE
        store.commit()
        store.commit()
        woken = cache.tick()
        assert _seqs(await _read(cache, PAGE, woken)) == [PAGE + 1, PAGE + 2]

        assert cache.stats().rows == PAGE
        # Rows 1 and 2 were let go: a reader that still needs them reads them.
        assert await _read(cache, 0, woken) is None
        assert await _read(cache, 1, woken) is None
        assert _seqs(await _read(cache, 2, woken))[0] == 3

    async def test_the_age_limit_raises_the_floor(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        clock = [1000.0]
        monkeypatch.setattr(
            "switch_core.transport.room_cache.time.monotonic", lambda: clock[0]
        )
        store = _Store()
        cache = _cache(store, max_age_seconds=60.0)
        cache.attach(TENANT, ROOM, "a")
        store.commit()
        woken = cache.tick()
        await _read(cache, 0, woken)
        clock[0] += 61.0
        store.commit()
        woken = cache.tick()
        assert _seqs(await _read(cache, 1, woken)) == [2]

        assert await _read(cache, 0, woken) is None, "row 1 outlived its age"
        assert cache.stats().rows == 1

    def test_a_room_must_hold_at_least_one_page(self) -> None:
        with pytest.raises(ValueError, match="max_rows_per_room"):
            _cache(_Store(), page=200, max_rows_per_room=199)


class TestEveryRowOnceInOrder:
    """Readers, writes, evictions and invalidations, interleaved at random.

    Each reader behaves as a transport does: it is woken after a commit, keeps
    its own cursor, takes what the cache gives it and reads the store itself
    when the cache says no. Whatever the interleaving, each must see every
    row exactly once and in order.
    """

    @pytest.mark.parametrize("seed", range(40))
    async def test_random_interleavings(self, seed: int) -> None:
        rng = random.Random(seed)
        store = _Store()
        store.yield_randomly = rng
        page = rng.choice([1, 2, 3, PAGE])
        cache = _cache(
            store,
            page=page,
            max_rows_per_room=page + rng.randint(0, 4),
            max_bytes=rng.choice([10_000_000, 3000, 1500]),
        )
        readers = 4
        total = 40
        received: list[list[int]] = [[] for _ in range(readers)]
        wakes = [asyncio.Event() for _ in range(readers)]
        woken = [0] * readers
        cursors = [0] * readers
        idle = [asyncio.Event() for _ in range(readers)]

        async def own_read(after: int) -> tuple[list[int], bool]:
            # A transport's own database read: snapshot, then a suspension.
            rows = [r.seq for r in store.rows.get((TENANT, ROOM), [])]
            await asyncio.sleep(0)
            found = [s for s in rows if s > after][:page]
            return found, len(found) < page

        async def reader(i: int) -> None:
            cache.attach(TENANT, ROOM, i)
            while True:
                await wakes[i].wait()
                wakes[i].clear()
                at = woken[i]
                while True:
                    shared = await cache.read(
                        TENANT, ROOM, after_seq=cursors[i], woken_at=at, limit=page
                    )
                    if shared is None:
                        seqs, done = await own_read(cursors[i])
                    else:
                        seqs, done = [r.seq for r in shared.rows], shared.done
                    for seq in seqs:
                        assert seq == cursors[i] + 1, (i, cursors[i], seqs)
                        cursors[i] = seq
                        received[i].append(seq)
                        # Reader 3 is slow, so it falls out of the held range.
                        for _ in range(rng.randint(0, 6) if i == 3 else 0):
                            await asyncio.sleep(0)
                        if rng.random() < 0.3:
                            await asyncio.sleep(0)
                    if done or not seqs:
                        break
                if not wakes[i].is_set():
                    idle[i].set()

        def wake_all() -> None:
            for i in range(readers):
                woken[i] = cache.tick()
                idle[i].clear()
                wakes[i].set()

        tasks = [asyncio.create_task(reader(i)) for i in range(readers)]
        try:
            for _ in range(total):
                store.commit()
                wake_all()
                for _ in range(rng.randint(0, 4)):
                    await asyncio.sleep(0)
                if rng.random() < 0.05:
                    cache.invalidate(TENANT, ROOM)
            for i in range(readers):
                settled = asyncio.ensure_future(idle[i].wait())
                done, _ = await asyncio.wait(
                    [settled, tasks[i]],
                    timeout=5,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                settled.cancel()
                if tasks[i] in done:
                    tasks[i].result()  # a reader's own assertion, raised here
                assert done, f"reader {i} never settled, seed {seed}"
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        expected = list(range(1, total + 1))
        for i in range(readers):
            assert received[i] == expected, f"reader {i}, seed {seed}"
