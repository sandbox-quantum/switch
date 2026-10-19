"""Where a consumer starts reading each room, and how far it has got.

A consumer reads its rooms through a `DeliveryProgress`, which says where to
start in each room and hears how far the consumer has got. There are two.

**`ConsumerCursors`, for a consumer one process owns.** The consumer reads its
rooms from `delivery_cursors`, one row per membership, so the process that
owns it (`ownership.py`) starts where the last owner stopped rather than at
each room's newest row. Rows written while no process was reading are handed
over when one is, and a hand-over between processes neither repeats nor skips
what the old owner had finished. Progress is written after the effects it
covers, so a row whose effects were made but whose cursor was not written is
handled again by the next owner, and whatever runs under ownership makes its
effects safe to repeat.

**`FromHead`, for a reader nothing is stored for.** Each room is read from its
newest row, as it was before cursors were stored, and progress lives only in
the transport's memory. Every consumer is owned now and reads through
`ConsumerCursors`; this is for a transport read outside any ownership, as the
transport's own tests read.

**One writer per process.** Every consumer reads every new row in its rooms,
so a stored cursor moves for every owned consumer with every message. Written
one at a time, that is a pool checkout per consumer per message, which is what
the shared room read (`room_cache.py`) exists to avoid on the read side. The
writer takes everything pending, writes it in one statement per tenant, and
takes what has piled up meanwhile next, so the writes cost at most one
connection however many consumers there are.

**Fenced.** Each advance names the lease its consumer was started under, and
the statement writes only where this process still holds it under that token
(`DeliveryCursorStore.advance`). An advance refused because the lease moved is
reported to the ownership, which stops the consumer here.

**A cap on what a new owner replays.** A consumer resuming a room skips
through every row older than `BACKLOG_MAX_AGE`: an hour-old refusal or "I am
offline" posted now would only mislead. The skip is logged and counted, and
the rows it passed are still there to read.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Collection
from datetime import timedelta
from typing import TYPE_CHECKING, Protocol

from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.delivery_cursor_store import CursorAdvance
from switch_core.db.stores.message_store import MessageStore
from switch_core.observability.catalogue import DELIVERY_BACKLOG_SKIPPED
from switch_core.observability.metrics import metrics

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore
    from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
    from switch_core.ownership import Fence

logger = logging.getLogger(__name__)

# How old a row may be and still be handled by a consumer that resumes past
# it. Long enough to cover a deploy or a hand-over after a process died, short
# enough that what is answered is still being waited for.
BACKLOG_MAX_AGE = timedelta(minutes=10)

# How long a batch the database refused waits before it is written again.
WRITE_RETRY_SECONDS = 2.0


class DeliveryProgress(Protocol):
    """Where one consumer run starts each room, and where it records how far
    it got."""

    async def resume(
        self, session: AsyncSession, room_ids: Collection[str]
    ) -> dict[str, int]:
        """Where to read each of `room_ids` from, in the caller's session. A
        room left out of the answer is one the client is no longer in."""
        ...

    async def resume_joined(
        self, session: AsyncSession, room_id: str, arrival_seq: int
    ) -> int:
        """Where to read a room from that the client has just joined itself,
        writing its arrival at `arrival_seq`: from before the arrival, so the
        client reads its own join the way every other member does."""
        ...

    def advance(self, room_id: str, seq: int) -> None:
        """Every row of the room through `seq` is handled."""
        ...


class FromHead:
    """For a reader nothing is stored for: each room from its newest row.

    Nothing is stored. A process that starts reads only what is written from
    then on, and every process reads the same rows for itself.
    """

    def __init__(self, messages: MessageStore) -> None:
        self._messages = messages

    async def resume(
        self, session: AsyncSession, room_ids: Collection[str]
    ) -> dict[str, int]:
        return await self._messages.head_seqs(session, list(room_ids))

    async def resume_joined(
        self, session: AsyncSession, room_id: str, arrival_seq: int
    ) -> int:
        return arrival_seq - 1

    def advance(self, room_id: str, seq: int) -> None:
        return None


class ConsumerCursors:
    """For a consumer one process owns: one client, under one hold of its
    lease, reading from the client's stored cursors.

    Built when the process starts the consumer and dropped when it stops it,
    so a later run here, under a newer token, never shares one.
    """

    def __init__(
        self,
        *,
        writer: CursorWriter,
        store: DeliveryCursorStore,
        tenant_id: str,
        client_id: str,
        fence: Fence,
        actor_role: str,
        on_lost: Callable[[Fence], None],
    ) -> None:
        self._writer = writer
        self._store = store
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.fence = fence
        self._actor_role = actor_role
        self.on_lost = on_lost

    async def resume(
        self, session: AsyncSession, room_ids: Collection[str]
    ) -> dict[str, int]:
        """The stored cursor, or for a membership that has none (one written
        before cursors were, by something that does not write them) the
        room's newest row, stored now. Rows past the cursor older than
        `BACKLOG_MAX_AGE` are skipped, and the skip is recorded as progress.
        """
        if not room_ids:
            return {}
        places = await self._store.positions(session, self.client_id, room_ids)
        missing = [room_id for room_id in room_ids if room_id not in places]
        if missing:
            await self._store.seed_memberships(session, self.client_id, missing)
            places.update(await self._store.positions(session, self.client_id, missing))
            await session.commit()
        ends = await self._store.backlog_ends(session, places, BACKLOG_MAX_AGE)
        for room_id, end in sorted(ends.items()):
            if end <= places[room_id]:
                continue
            skipped = end - places[room_id]
            logger.warning(
                "Client %s resumes room %s past %d row(s) older than %s "
                "(through seq %d): too old to act on now. They stay in the "
                "room's history.",
                self.client_id,
                room_id,
                skipped,
                BACKLOG_MAX_AGE,
                end,
            )
            metrics().increment(
                DELIVERY_BACKLOG_SKIPPED, {"actor": self._actor_role}, skipped
            )
            places[room_id] = end
            self.advance(room_id, end)
        return places

    async def resume_joined(
        self, session: AsyncSession, room_id: str, arrival_seq: int
    ) -> int:
        """The stored cursor, which the membership was written with, just
        before the arrival (`RoomStore.add_client`)."""
        places = await self.resume(session, [room_id])
        return places.get(room_id, arrival_seq - 1)

    def advance(self, room_id: str, seq: int) -> None:
        """Written shortly, by the process's writer."""
        self._writer.advance(self, room_id, seq)

    async def flush(self) -> None:
        """Write what is pending now, for a consumer about to stop."""
        await self._writer.flush()


class CursorWriter:
    """Writes every owned consumer's progress in this process, in batches."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        cursors: DeliveryCursorStore,
        leases: OwnershipLeaseStore,
        process_id: str,
    ) -> None:
        self._session_factory = session_factory
        self._cursors = cursors
        self._leases = leases
        self._process_id = process_id
        # The newest place each (client, room) has reached and not yet been
        # written, with the consumer run that reached it.
        self._pending: dict[tuple[str, str], tuple[ConsumerCursors, int]] = {}
        self._wake = asyncio.Event()
        # One write at a time, whether the loop's or a flush's: two would
        # each write half of what the other has taken.
        self._lock = asyncio.Lock()

    def advance(self, consumer: ConsumerCursors, room_id: str, seq: int) -> None:
        key = (consumer.client_id, room_id)
        current = self._pending.get(key)
        if current is None or current[0] is not consumer or current[1] < seq:
            self._pending[key] = (consumer, seq)
        self._wake.set()

    @property
    def pending(self) -> int:
        return len(self._pending)

    async def run(self) -> None:
        """Write whatever is pending, as soon as it is, until cancelled."""
        while True:
            await self._wake.wait()
            self._wake.clear()
            try:
                await self.flush()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error(
                    "Writing %d delivery cursor(s) failed; kept and retried in %.0fs",
                    len(self._pending),
                    WRITE_RETRY_SECONDS,
                    exc_info=True,
                )
                await asyncio.sleep(WRITE_RETRY_SECONDS)
                self._wake.set()

    async def flush(self) -> None:
        """Write everything pending now. Raises if a tenant's batch could not
        be written, after keeping it to be written again."""
        async with self._lock:
            if not self._pending:
                return
            batch, self._pending = self._pending, {}
            by_tenant: dict[
                str, dict[tuple[str, str], tuple[ConsumerCursors, int]]
            ] = {}
            for key, entry in batch.items():
                by_tenant.setdefault(entry[0].tenant_id, {})[key] = entry
            failed: BaseException | None = None
            for tenant_id, entries in by_tenant.items():
                try:
                    await self._write(tenant_id, entries)
                except Exception as exc:
                    self._keep(entries)
                    failed = exc
            if failed is not None:
                raise failed

    def _keep(
        self, entries: dict[tuple[str, str], tuple[ConsumerCursors, int]]
    ) -> None:
        """Put entries that were not written back, unless something newer from
        the same consumer run arrived meanwhile."""
        for key, (consumer, seq) in entries.items():
            current = self._pending.get(key)
            if current is None or (current[0] is consumer and current[1] < seq):
                self._pending[key] = (consumer, seq)

    async def _write(
        self,
        tenant_id: str,
        entries: dict[tuple[str, str], tuple[ConsumerCursors, int]],
    ) -> None:
        advances = [
            CursorAdvance(
                client_id=client_id,
                room_id=room_id,
                seq=seq,
                kind=consumer.fence.kind,
                key=consumer.fence.key,
                token=consumer.fence.token,
            )
            for (client_id, room_id), (consumer, seq) in entries.items()
        ]
        async with tenant_session(self._session_factory, tenant_id) as session:
            written = await self._cursors.advance(
                session, process_id=self._process_id, advances=advances
            )
            await session.commit()
            refused = {
                consumer.fence: consumer
                for key, (consumer, _) in entries.items()
                if key not in written
            }
            still_held = await self._still_held(session, refused)
        for fence, consumer in refused.items():
            if fence in still_held:
                # The lease is still this process's, so the membership went:
                # the membership signal stops the room's delivery.
                continue
            logger.warning(
                "Client %s's cursor was refused: its %s lease is no longer "
                "this process's (token %d)",
                consumer.client_id,
                fence.kind,
                fence.token,
            )
            consumer.on_lost(fence)

    async def _still_held(
        self, session: AsyncSession, refused: dict[Fence, ConsumerCursors]
    ) -> set[Fence]:
        by_kind: dict[str, dict[str, Fence]] = {}
        for fence in refused:
            by_kind.setdefault(fence.kind, {})[fence.key] = fence
        held: set[Fence] = set()
        for kind, fences in by_kind.items():
            keys = await self._leases.held(
                session,
                kind=kind,
                tokens={key: fence.token for key, fence in fences.items()},
                process_id=self._process_id,
            )
            held.update(fences[key] for key in keys)
        return held
