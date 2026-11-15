"""How far each client's consumer has handled each room (`delivery_cursors`).

Read and written in a session bound to the client's tenant: the table is
scoped, and every row belongs to a membership in that tenant.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, bindparam, func, literal, select, text
from sqlalchemy.dialects.postgresql import ARRAY, insert
from sqlalchemy.types import Text

from switch_core.db.id_lists import any_of
from switch_core.db.models import DeliveryCursor, Message

if TYPE_CHECKING:
    from collections.abc import Collection

    from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class CursorAdvance:
    """Move one client's cursor in one room to `seq`, under the lease that
    makes this process the client's reader: `kind` and `key` name the lease,
    `token` is the one this process claimed it with."""

    client_id: str
    room_id: str
    seq: int
    kind: str
    key: str
    token: int


# The advance and its fence in one statement. A cursor moves only while this
# process holds the lease under the token it claimed, and only while the
# membership exists. The lease row is locked for share, so a process taking
# the lease over waits for this statement to commit and then reads the cursor
# as moved; the membership row is locked against deletion for the same span,
# so a removal cannot slip in between the check and the write. A cursor only
# ever moves forward.
_ADVANCE = text(
    """
    WITH wanted AS (
        SELECT * FROM unnest(:client_ids, :room_ids, :seqs, :kinds, :keys, :tokens)
            AS wanted(client_id, room_id, seq, kind, key, token)
    ),
    fenced AS (
        SELECT member.tenant_id, wanted.client_id, wanted.room_id, wanted.seq
        FROM wanted
        JOIN ownership_leases lease
          ON lease.kind = wanted.kind
         AND lease.key = wanted.key
         AND lease.token = wanted.token
         AND lease.process_id = :process_id
        JOIN client_rooms member
          ON member.client_id = wanted.client_id
         AND member.room_id = wanted.room_id
        FOR SHARE OF lease FOR KEY SHARE OF member
    )
    INSERT INTO delivery_cursors AS cursor (tenant_id, client_id, room_id, last_seq)
    SELECT tenant_id, client_id, room_id, seq FROM fenced
    ON CONFLICT (client_id, room_id) DO UPDATE
    SET last_seq = GREATEST(cursor.last_seq, EXCLUDED.last_seq),
        updated_at = now()
    RETURNING cursor.client_id, cursor.room_id
    """
).bindparams(
    bindparam("client_ids", type_=ARRAY(Text)),
    bindparam("room_ids", type_=ARRAY(Text)),
    bindparam("seqs", type_=ARRAY(BigInteger)),
    bindparam("kinds", type_=ARRAY(Text)),
    bindparam("keys", type_=ARRAY(Text)),
    bindparam("tokens", type_=ARRAY(BigInteger)),
)

# A cursor at its room's newest row for each of the client's memberships in
# the given rooms that has none.
_SEED_MEMBERSHIPS = text(
    """
    INSERT INTO delivery_cursors (tenant_id, client_id, room_id, last_seq)
    SELECT member.tenant_id, member.client_id, member.room_id,
           GREATEST(COALESCE(
               (SELECT max(m.seq) FROM messages m WHERE m.room_id = member.room_id),
               0
           ), 0)
    FROM client_rooms member
    WHERE member.client_id = :client_id AND member.room_id = ANY(:room_ids)
    ON CONFLICT (client_id, room_id) DO NOTHING
    """
).bindparams(bindparam("room_ids", type_=ARRAY(Text)))

# For each room, the newest row after the given place that is older than the
# cut-off: a consumer resuming there skips through it.
_BACKLOG_ENDS = text(
    """
    SELECT place.room_id, max(m.seq)
    FROM unnest(:room_ids, :seqs) AS place(room_id, seq)
    JOIN messages m ON m.room_id = place.room_id AND m.seq > place.seq
    WHERE m.sent_at < now() - CAST(:older_than AS interval)
    GROUP BY place.room_id
    """
).bindparams(
    bindparam("room_ids", type_=ARRAY(Text)),
    bindparam("seqs", type_=ARRAY(BigInteger)),
)


def _room_head(room_id: str) -> object:
    """The room's newest live row, or 0 for a room with none. Reconstructed
    history is numbered below zero and is never delivered."""
    return func.greatest(
        select(func.coalesce(func.max(Message.seq), 0))
        .where(Message.room_id == room_id)
        .scalar_subquery(),
        literal(0, BigInteger),
    )


class DeliveryCursorStore:
    async def positions(
        self, session: AsyncSession, client_id: str, room_ids: Collection[str]
    ) -> dict[str, int]:
        """The client's cursor in each of `room_ids` that has one."""
        if not room_ids:
            return {}
        result = await session.execute(
            select(DeliveryCursor.room_id, DeliveryCursor.last_seq).where(
                DeliveryCursor.client_id == client_id,
                any_of(DeliveryCursor.room_id, room_ids),
            )
        )
        return dict(result.tuples().all())

    async def seed(self, session: AsyncSession, client_id: str, room_id: str) -> None:
        """Start the client's cursor in the room at the room's newest row,
        unless it has one. Written with the membership, in the caller's
        transaction, so a consumer that learns of the membership later still
        starts at the moment the client joined."""
        await session.execute(
            insert(DeliveryCursor)
            .values(client_id=client_id, room_id=room_id, last_seq=_room_head(room_id))
            .on_conflict_do_nothing(
                index_elements=[DeliveryCursor.client_id, DeliveryCursor.room_id]
            )
        )

    async def seed_memberships(
        self, session: AsyncSession, client_id: str, room_ids: Collection[str]
    ) -> None:
        """`seed` for each of `room_ids` the client is a member of and has no
        cursor in, in one statement: for memberships written before cursors
        were, or by something that writes none."""
        if not room_ids:
            return
        await session.execute(
            _SEED_MEMBERSHIPS, {"client_id": client_id, "room_ids": list(room_ids)}
        )

    async def advance(
        self,
        session: AsyncSession,
        *,
        process_id: str,
        advances: Collection[CursorAdvance],
    ) -> set[tuple[str, str]]:
        """Move each cursor forward where this process still holds the lease
        and the membership still exists. Returns the (client, room) pairs
        written; the rest were refused. One (client, room) pair at most once
        in `advances`."""
        if not advances:
            return set()
        rows = list(advances)
        result = await session.execute(
            _ADVANCE,
            {
                "client_ids": [row.client_id for row in rows],
                "room_ids": [row.room_id for row in rows],
                "seqs": [row.seq for row in rows],
                "kinds": [row.kind for row in rows],
                "keys": [row.key for row in rows],
                "tokens": [row.token for row in rows],
                "process_id": process_id,
            },
        )
        return {(client_id, room_id) for client_id, room_id in result.tuples().all()}

    async def backlog_ends(
        self, session: AsyncSession, places: dict[str, int], older_than: timedelta
    ) -> dict[str, int]:
        """For each room in `places` (room to cursor), the newest row past the
        cursor that is older than `older_than`, where there is one."""
        if not places:
            return {}
        result = await session.execute(
            _BACKLOG_ENDS,
            {
                "room_ids": list(places),
                "seqs": list(places.values()),
                "older_than": older_than,
            },
        )
        return dict(result.tuples().all())
