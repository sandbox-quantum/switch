from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import (
    ColumnElement,
    and_,
    bindparam,
    delete,
    func,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.db.id_lists import any_of
from switch_core.db.models import Message, MessageAttachment, Room, require_tenant_id
from switch_core.db.notify_ddl import SET_WRITER_ANNOUNCES
from switch_core.db.raw import RawStatement
from switch_core.messages.row import text_field
from switch_core.transport.content import edited_content


@dataclass(frozen=True)
class DeletedMessages:
    event_ids: list[str]
    #: The keys agents' copies of them are stored under (`agent_events.message_key`):
    #: the attachment group id for a file sent as part of several, else the event id.
    message_keys: set[str]
    #: The files the deleted messages carried. Others may still quote them.
    uris: set[str]
    #: The rooms they were deleted from.
    room_ids: set[str]


def _nothing_deleted() -> DeletedMessages:
    return DeletedMessages(event_ids=[], message_keys=set(), uris=set(), room_ids=set())


class MessageStore:
    async def create(
        self,
        session: AsyncSession,
        message: Message,
        attachments: list[MessageAttachment],
        *,
        announced_by_writer: bool = False,
    ) -> Message:
        """Persist a message and its files as one unit.

        Attachments are numbered by their order in the list, which is the order
        they were sent in.

        The caller must not have set `seq`; this assigns it.

        With `announced_by_writer`, the triggers on `messages` and
        `agent_events` send nothing for the rest of the transaction, and the
        caller announces every row of either table it writes in it once it
        has committed (`WRITER_ANNOUNCES_SETTING` in `db/notify_ddl.py`).
        """
        message.seq = await self._next_seq(
            session, message.room_id, announced_by_writer=announced_by_writer
        )
        session.add(message)
        await session.flush()
        for position, attachment in enumerate(attachments):
            attachment.message_id = message.id
            attachment.position = position
            session.add(attachment)
        await session.flush()
        return message

    async def create_unless_stored(
        self,
        session: AsyncSession,
        message: Message,
        attachments: list[MessageAttachment],
        *,
        announced_by_writer: bool = False,
    ) -> bool:
        """`create`, unless a message with the same `transport_event_id` is
        already stored, in which case nothing is written. Returns whether the
        message was written.

        For writes whose id is derived from what caused them, so causing them
        twice writes once. The check runs under the room's lock, which every
        writer to the room holds to commit, so an earlier write of the same
        message has either committed and is found, or has not started.

        `announced_by_writer` as for `create`.
        """
        message.seq = await self._next_seq(
            session, message.room_id, announced_by_writer=announced_by_writer
        )
        if await self.get_by_transport_event_id(session, message.transport_event_id):
            return False
        session.add(message)
        await session.flush()
        for position, attachment in enumerate(attachments):
            attachment.message_id = message.id
            attachment.position = position
            session.add(attachment)
        await session.flush()
        return True

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

    async def _next_seq(
        self, session: AsyncSession, room_id: str, *, announced_by_writer: bool = False
    ) -> int:
        """The next position in this room, allocated in commit order.

        One above the room's highest, so live positions run 1, 2, 3 with no
        gaps: a transaction that rolls back takes its number with it, and the
        next writer gets the same one.

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

        The cost is per-room serialisation of a single INSERT. Rooms do not
        contend with each other.

        A writer that announces its own rows sets that up in the same
        statement as the lock, so it costs no round trip of its own.
        """
        lock = _LOCK_ROOM_ANNOUNCED_BY_WRITER if announced_by_writer else _LOCK_ROOM
        await lock.all(session, {"room_id": room_id})
        head = await _ROOM_HEAD.all(session, {"room_id": room_id})
        return int(head[0].head) + 1

    async def head_seq(
        self,
        session: AsyncSession,
        room_id: str,
        *,
        types: Collection[str] | None = None,
    ) -> int:
        """The room's current position, or 0 when nothing has been sent.

        What a subscriber starts from when it wants everything after now
        rather than everything. Reconstructed history is numbered below zero,
        so an empty live log answers 0 whatever has been backfilled into it.
        With `types`, the position of the last row of those types.
        """
        if types is not None:
            result = await session.execute(
                select(func.coalesce(func.max(Message.seq), 0)).where(
                    Message.room_id == room_id,
                    Message.event_type.in_(list(types)),
                )
            )
            return max(int(result.scalar_one()), 0)
        head = await _ROOM_HEAD.all(session, {"room_id": room_id})
        return max(int(head[0].head), 0)

    async def delete_sent_before(
        self, session: AsyncSession, cutoff: datetime, *, limit: int
    ) -> DeletedMessages:
        """Delete up to `limit` of the bound tenant's oldest messages sent before
        `cutoff`, with their attachments.

        See `_delete_where` for what else changes and what does not.
        """
        return await self._delete_where(session, Message.sent_at < cutoff, limit=limit)

    async def delete_sent_by(
        self, session: AsyncSession, *, transport_user_id: str, limit: int
    ) -> DeletedMessages:
        """Delete up to `limit` of the messages one participant sent in the bound
        tenant, with their attachments.

        Matched on `sender_id`, the participant's transport id, rather than
        `sender_client_id`: every row has the first, while the second is null
        on reconstructed history, on rows older than the column, and on rows
        whose client has been deleted. See `_delete_where` for the rest.
        """
        return await self._delete_where(
            session, Message.sender_id == transport_user_id, limit=limit
        )

    async def delete_posts(
        self,
        session: AsyncSession,
        room_id: str,
        transport_event_ids: Collection[str],
        *,
        limit: int,
    ) -> DeletedMessages:
        """Delete up to `limit` of the messages in `room_id` named by
        `transport_event_ids`, with every other file of a multi-file post one
        of them belongs to, since the files of one post are one message to
        whoever reads it (`attachments.py`).

        For a post deleted where it was written. Usually a row in the middle
        of the room, which leaves a gap in its numbering: readers page on
        `seq > cursor`, so a gap is skipped like any row a reader never had,
        and `_delete_where` keeps a deleted newest row's number from being
        given out again. See `_delete_where` for the rest.
        """
        if not transport_event_ids:
            return _nothing_deleted()
        ids = list(transport_event_ids)
        group_id = Message.content[ATTACHMENT_GROUP_KEY]["id"].astext
        groups = select(group_id).where(
            Message.room_id == room_id,
            Message.transport_event_id.in_(ids),
            group_id.is_not(None),
        )
        return await self._delete_where(
            session,
            and_(
                Message.room_id == room_id,
                or_(Message.transport_event_id.in_(ids), group_id.in_(groups)),
            ),
            limit=limit,
        )

    async def delete_room_messages(
        self, session: AsyncSession, room_id: str, *, limit: int
    ) -> DeletedMessages:
        """Delete up to `limit` of the oldest messages in `room_id`, with their
        attachments, leaving the room itself. See `_delete_where`."""
        return await self._delete_where(
            session, Message.room_id == room_id, limit=limit
        )

    async def replace_body(
        self, session: AsyncSession, message: Message, body: str, *, edited_at_ms: int
    ) -> None:
        """Replace what a stored message says with `body`, in place.

        For a post its author edited where it was written. The row keeps its
        place in the room, so no reader is handed it a second time: one that
        has read it keeps what it read, and one that reads it from now on
        reads only the new words. The old ones are not kept anywhere, which is
        the point. See `edited_content` for the content it gets.
        """
        content = edited_content(message.content, body, edited_at_ms=edited_at_ms)
        message.content = content
        message.body = text_field(content.get("body"))
        message.formatted_body = text_field(content.get("formatted_body"))
        await session.flush()

    async def _delete_where(
        self, session: AsyncSession, condition: ColumnElement[bool], *, limit: int
    ) -> DeletedMessages:
        """Delete up to `limit` of the bound tenant's oldest messages matching
        `condition`, with their attachments.

        Each room's `seq_floor` is raised to the highest live position deleted
        from it, in the same transaction, so `_next_seq` never reissues one.
        This takes no room advisory lock and needs none: `_ROOM_HEAD` reads
        the newest row and the floor in one statement, so a sender sees the
        deletion whole or not at all, and the floor's UPDATE takes a row lock
        that a sender's foreign-key check does not wait on. The rooms are
        updated in id order, so two deletions at once (each replica runs
        retention) lock them in the same order and cannot deadlock.
        The bytes behind the attachments are not touched: a blob may be quoted
        by a message that is kept. The result names them, and
        `RetentionStore.delete_unreferenced_media` finds the ones nothing
        points at any more.
        """
        rows = (
            await session.execute(
                select(
                    Message.id,
                    Message.room_id,
                    Message.seq,
                    Message.transport_event_id,
                    func.coalesce(
                        Message.content[ATTACHMENT_GROUP_KEY]["id"].astext,
                        Message.transport_event_id,
                    ).label("message_key"),
                )
                .where(Message.tenant_id == require_tenant_id(), condition)
                .order_by(Message.sent_at)
                .limit(limit)
            )
        ).all()
        if not rows:
            return _nothing_deleted()
        message_ids = [r.id for r in rows]
        uris = set(
            (
                await session.execute(
                    select(MessageAttachment.uri).where(
                        MessageAttachment.message_id.in_(message_ids)
                    )
                )
            ).scalars()
        )
        floors: dict[str, int] = {}
        for row in rows:
            floors[row.room_id] = max(floors.get(row.room_id, 0), row.seq)
        for room_id, seq in sorted(floors.items()):
            if seq > 0:
                await session.execute(
                    update(Room)
                    .where(Room.id == room_id)
                    .values(seq_floor=func.greatest(Room.seq_floor, seq))
                )
        await session.execute(delete(Message).where(Message.id.in_(message_ids)))
        return DeletedMessages(
            event_ids=[row.transport_event_id for row in rows],
            message_keys={row.message_key for row in rows},
            uris=uris,
            room_ids=set(floors),
        )

    async def head_seqs(
        self,
        session: AsyncSession,
        room_ids: list[str],
        *,
        types: Collection[str] | None = None,
    ) -> dict[str, int]:
        """`head_seq` for many rooms in one query, 0 for a room with nothing sent.

        For a client starting up in all its rooms at once: one round trip
        rather than one per room, which at boot is several hundred at the same
        moment.
        """
        if not room_ids:
            return {}
        query = select(Message.room_id, func.max(Message.seq)).where(
            any_of(Message.room_id, room_ids)
        )
        if types is not None:
            query = query.where(Message.event_type.in_(list(types)))
        result = await session.execute(query.group_by(Message.room_id))
        heads = {room_id: max(int(seq or 0), 0) for room_id, seq in result.all()}
        if types is None:
            floors = await session.execute(
                select(Room.id, Room.seq_floor).where(
                    any_of(Room.id, room_ids), Room.seq_floor > 0
                )
            )
            for room_id, floor in floors.all():
                heads[room_id] = max(heads.get(room_id, 0), int(floor))
        return {room_id: heads.get(room_id, 0) for room_id in room_ids}

    async def rooms_past(
        self,
        session: AsyncSession,
        cursors: dict[str, int],
        *,
        types: Collection[str] | None = None,
    ) -> set[str]:
        """Of the rooms in `cursors`, the ones with a row after their cursor,
        in one query whose result is only those rooms. With `types`, a row
        of one of those types.

        The rooms and cursors go as two arrays, so the statement is the same
        however many rooms there are: a reader in every room of a workspace
        asks about tens of thousands, past the 32,767 parameters a statement
        may have, and building a statement that size would hold the event
        loop for a good part of a second."""
        if not cursors:
            return set()
        params: dict[str, object] = {
            "room_ids": list(cursors),
            "seqs": list(cursors.values()),
        }
        if types is None:
            statement = _ROOMS_PAST
        else:
            statement = _ROOMS_PAST_OF_TYPES
            params["types"] = list(types)
        result = await session.execute(statement, params)
        return set(result.scalars().all())

    async def get_by_transport_event_id(
        self, session: AsyncSession, transport_event_id: str
    ) -> Message | None:
        result = await session.execute(
            select(Message).where(Message.transport_event_id == transport_event_id)
        )
        return result.scalar_one_or_none()

    async def list_for_room(
        self,
        session: AsyncSession,
        room_id: str,
        *,
        after_seq: int,
        limit: int,
        types: Collection[str] | None = None,
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

        With `types`, only rows of those types, for a reader that acts on no
        others (`MessageListener.subscribe`).
        """
        query = select(Message).where(
            Message.room_id == room_id, Message.seq > after_seq
        )
        if types is not None:
            query = query.where(Message.event_type.in_(list(types)))
        result = await session.execute(query.order_by(Message.seq).limit(limit))
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

    async def list_thread_newest_first(
        self,
        session: AsyncSession,
        room_id: str,
        *,
        thread_root_event_id: str,
        limit: int,
        before_seq: int | None = None,
    ) -> list[Message]:
        """A thread's newest messages, its root included, newest first; only
        those written before `before_seq` when it is given."""
        result = await session.execute(
            select(Message)
            .where(
                Message.room_id == room_id,
                or_(
                    Message.thread_root_event_id == thread_root_event_id,
                    Message.transport_event_id == thread_root_event_id,
                ),
                *_before(before_seq),
            )
            .order_by(Message.seq.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def list_top_level_newest_first(
        self,
        session: AsyncSession,
        room_id: str,
        *,
        limit: int,
        before_seq: int | None = None,
    ) -> list[Message]:
        """The room's newest top-level messages, newest first; only those
        written before `before_seq` when it is given. Replies inside threads
        are left out."""
        result = await session.execute(
            select(Message)
            .where(
                Message.room_id == room_id,
                Message.thread_root_event_id.is_(None),
                *_before(before_seq),
            )
            .order_by(Message.seq.desc())
            .limit(limit)
        )
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


# The two statements a message's number costs, run by asyncpg directly
# (`db/raw.py`): every message an agent or a person sends takes the room's
# lock and reads its head.
_ROOMS_PAST_SQL = (
    "SELECT position.room_id "
    "FROM unnest(CAST(:room_ids AS text[]), CAST(:seqs AS bigint[])) "
    "AS position(room_id, seq) "
    "WHERE EXISTS (SELECT 1 FROM messages "
    "WHERE messages.room_id = position.room_id AND messages.seq > position.seq{types})"
)
_ROOMS_PAST = text(_ROOMS_PAST_SQL.format(types=""))
_ROOMS_PAST_OF_TYPES = text(
    _ROOMS_PAST_SQL.format(
        types=" AND messages.event_type = ANY(CAST(:types AS text[]))"
    )
)
_LOCK_ROOM = RawStatement(text("SELECT pg_advisory_xact_lock(hashtext(:room_id))"))
_LOCK_ROOM_ANNOUNCED_BY_WRITER = RawStatement(
    text(f"SELECT pg_advisory_xact_lock(hashtext(:room_id)), {SET_WRITER_ANNOUNCES}")
)
# The highest position the room has ever used: usually its newest row, but
# retention may have deleted that row while a cursor that read it is still
# past it. `rooms.seq_floor` remembers the highest live position retention
# removed; both are read in one statement, so a deletion committing between
# them cannot be half-seen.
_ROOM_HEAD = RawStatement(
    select(
        func.greatest(
            select(func.coalesce(func.max(Message.seq), 0))
            .where(Message.room_id == bindparam("room_id"))
            .scalar_subquery(),
            select(func.coalesce(func.max(Room.seq_floor), 0))
            .where(Room.id == bindparam("room_id"))
            .scalar_subquery(),
        ).label("head")
    )
)


def _before(seq: int | None) -> list[ColumnElement[bool]]:
    """The condition keeping rows written before `seq`; none when not given."""
    return [] if seq is None else [Message.seq < seq]
