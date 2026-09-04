from collections.abc import Collection
from datetime import UTC, datetime

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Message, MessageAttachment, Room


class MessageStore:
    async def create(
        self,
        session: AsyncSession,
        message: Message,
        attachments: list[MessageAttachment],
    ) -> Message:
        """Persist a message and its files as one unit.

        Attachments are numbered by their order in the list, which is the order
        they were sent in.

        The caller must not have set `seq`; this assigns it.
        """
        message.seq = await self._next_seq(session, message.room_id)
        session.add(message)
        await session.flush()
        for position, attachment in enumerate(attachments):
            attachment.message_id = message.id
            attachment.position = position
            session.add(attachment)
        await session.flush()
        return message

    async def mark_history_backfilled(
        self, session: AsyncSession, room_id: str
    ) -> None:
        """Record that this room's history has been walked to its start.

        A write of the backfill's own progress, so it lives beside the writes
        of its output: a dry run replaces this store wholesale, and anything
        that reaches the database from outside it is a write a dry run does
        not know to withhold.
        """
        room = await session.get(Room, room_id)
        if room is None:
            return
        room.history_backfilled_at = datetime.now(UTC)  # type: ignore[assignment]
        await session.flush()

    async def create_historical(
        self,
        session: AsyncSession,
        message: Message,
        attachments: list[MessageAttachment],
    ) -> Message:
        """Persist a message that predates recording, numbered below zero.

        Reconstructed history cannot take positions above the live log: `seq`
        orders the room, and giving a message from last month a number above
        one from this morning would put it at the top of every read. It cannot
        take positions among the live rows either — they are taken, and
        renumbering to make room would move every cursor that points at them.

        So it counts down from zero. Ordering by `seq` still walks the room in
        the order it happened, `(room_id, seq)` stays unique, and the sign
        carries a fact worth being able to read off a row: **positive is what
        Switch recorded as it happened, negative is what was reconstructed
        afterwards.**

        The sign is load-bearing for delivery, not just descriptive. A cursor
        starts at 0, so backfilling a year of history delivers none of it —
        which is the only sane answer, since nobody wants last March's
        messages pushed at them tonight.

        The caller must not have set `seq`; this assigns it. `sent_at` is the
        caller's to set, and must be when the message was *sent* rather than
        when this row was written, or the reconstructed history lands in the
        wrong place in every time window.
        """
        message.seq = await self._previous_seq(session, message.room_id)
        session.add(message)
        await session.flush()
        for position, attachment in enumerate(attachments):
            attachment.message_id = message.id
            attachment.position = position
            session.add(attachment)
        await session.flush()
        return message

    async def _previous_seq(self, session: AsyncSession, room_id: str) -> int:
        """The next position below the room's oldest, at most -1.

        Same lock as `_next_seq`, for the same reason and against the same
        contenders: two backfills of one room must not pick the same number,
        and the uniqueness constraint would otherwise be the thing that noticed.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:room_id))"),
            {"room_id": room_id},
        )
        result = await session.execute(
            select(func.coalesce(func.min(Message.seq), 0)).where(
                Message.room_id == room_id
            )
        )
        return min(int(result.scalar_one()), 0) - 1

    async def _next_seq(self, session: AsyncSession, room_id: str) -> int:
        """The next position in this room, allocated in commit order.

        A database sequence — `Identity`, `SERIAL`, `nextval` — is the obvious
        way to number rows and the wrong one here. It hands out a number when
        the INSERT runs, not when the transaction commits, and it does so
        outside transaction control so the number is never given back. Two
        concurrent senders therefore take 7 and 8, and if 8 commits first a
        reader paging on `seq > n` can advance its cursor past 8 while 7 is
        still in flight. When 7 lands it is behind the cursor and is never
        read again: a message that was delivered, recorded, and silently
        skipped. Rare, unreproducible, and invisible — the worst shape of bug
        this table could have.

        So the number is allocated under a lock held to commit. Writers to the
        same room serialise, which makes `seq` order and commit order the same
        order, which is the only property a cursor actually needs. The lock is
        an advisory one keyed on the room: it takes no row lock, so it cannot
        deadlock against anything that updates the room itself, and Postgres
        releases it at commit or rollback whatever happens. Two rooms whose
        ids collide in the hash serialise against each other needlessly and
        are otherwise unaffected.

        The cost is per-room serialisation of a single INSERT on a path that
        has already returned to the caller — the send completed before
        recording began. Rooms do not contend with each other.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:room_id))"),
            {"room_id": room_id},
        )
        result = await session.execute(
            select(func.coalesce(func.max(Message.seq), 0)).where(
                Message.room_id == room_id
            )
        )
        return int(result.scalar_one()) + 1

    async def head_seq(self, session: AsyncSession, room_id: str) -> int:
        """The room's current position, or 0 when nothing has been sent.

        What a subscriber starts from when it wants everything after now
        rather than everything. Reconstructed history is numbered below zero,
        so an empty live log answers 0 whatever has been backfilled into it.
        """
        result = await session.execute(
            select(func.coalesce(func.max(Message.seq), 0)).where(
                Message.room_id == room_id
            )
        )
        return max(int(result.scalar_one()), 0)

    async def get_by_transport_event_id(
        self, session: AsyncSession, transport_event_id: str
    ) -> Message | None:
        result = await session.execute(
            select(Message).where(Message.transport_event_id == transport_event_id)
        )
        return result.scalar_one_or_none()

    async def list_for_room(
        self, session: AsyncSession, room_id: str, *, after_seq: int, limit: int
    ) -> list[Message]:
        """Oldest first, from just after `after_seq`. Pass 0 to start.

        Paging on `seq` rather than a timestamp keeps the cursor exact: within
        a room it is a total order with no ties, and `create` assigns it in
        commit order, so no row can be skipped or repeated between pages.

        This is also what a delivery cursor reads: it must see the room in the
        order it happened, and must be able to stop part-way and resume from
        the last row it handled. `after_seq` is exclusive, so re-reading with
        the same cursor delivers nothing twice. Passing 0 also skips
        reconstructed history, which is numbered below zero — a backfill is
        not something to deliver.
        """
        result = await session.execute(
            select(Message)
            .where(Message.room_id == room_id, Message.seq > after_seq)
            .order_by(Message.seq)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def list_timeline(
        self,
        session: AsyncSession,
        room_id: str,
        *,
        limit: int,
        since: datetime | None,
        before: datetime | None,
    ) -> list[Message]:
        """The newest `limit` rows in the window, newest first.

        The window is half-open: `since` is included, `before` is not. Ordering
        is by `seq` rather than `sent_at` — within a room `seq` is a total order
        with no ties, whereas two rows can share a timestamp — so a caller that
        asks for the newest N gets the same N every time.
        """
        query = select(Message).where(Message.room_id == room_id)
        if since is not None:
            query = query.where(Message.sent_at >= since)
        if before is not None:
            query = query.where(Message.sent_at < before)
        result = await session.execute(query.order_by(Message.seq.desc()).limit(limit))
        return list(result.scalars().all())

    async def list_by_transport_event_ids(
        self, session: AsyncSession, room_id: str, event_ids: Collection[str]
    ) -> list[Message]:
        """Rows for specific transport event ids within one room.

        Scoped to the room so an id from elsewhere cannot be read through it.
        """
        if not event_ids:
            return []
        result = await session.execute(
            select(Message).where(
                Message.room_id == room_id,
                Message.transport_event_id.in_(list(event_ids)),
            )
        )
        return list(result.scalars().all())

    async def attachments_for(
        self, session: AsyncSession, message_ids: Collection[str]
    ) -> dict[str, list[MessageAttachment]]:
        """Attachments for several messages at once, keyed by message id.

        One query for the whole page: fetching per message would put the N+1
        back that moving the read path here is meant to remove. Messages with
        no files are simply absent from the map.
        """
        if not message_ids:
            return {}
        result = await session.execute(
            select(MessageAttachment)
            .where(MessageAttachment.message_id.in_(list(message_ids)))
            .order_by(MessageAttachment.message_id, MessageAttachment.position)
        )
        by_message: dict[str, list[MessageAttachment]] = {}
        for attachment in result.scalars().all():
            by_message.setdefault(attachment.message_id, []).append(attachment)
        return by_message

    async def get_attachments(
        self, session: AsyncSession, message_id: str
    ) -> list[MessageAttachment]:
        result = await session.execute(
            select(MessageAttachment)
            .where(MessageAttachment.message_id == message_id)
            .order_by(MessageAttachment.position)
        )
        return list(result.scalars().all())
