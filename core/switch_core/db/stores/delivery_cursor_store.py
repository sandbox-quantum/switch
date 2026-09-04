"""Where each agent has been delivered to in each room."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from switch_core.db.models import DeliveryCursor

if TYPE_CHECKING:
    from collections.abc import Collection

    from sqlalchemy.ext.asyncio import AsyncSession


class DeliveryCursorStore:
    async def position(self, session: AsyncSession, agent_id: str, room_id: str) -> int:
        """How far this agent has been delivered, 0 if it never has.

        Zero rather than None because `seq` starts at 1: an agent with no
        cursor is behind the room's first message, which is the same statement
        the number already makes.
        """
        result = await session.execute(
            select(DeliveryCursor.last_seq).where(
                DeliveryCursor.agent_id == agent_id,
                DeliveryCursor.room_id == room_id,
            )
        )
        return result.scalar_one_or_none() or 0

    async def positions_in(
        self, session: AsyncSession, room_id: str, agent_ids: Collection[str]
    ) -> dict[str, int]:
        """Several agents' positions in one room, for dispatching a room once.

        Agents with no cursor are absent from the map rather than present at 0,
        so a caller can tell "never delivered" from "delivered nothing".
        """
        if not agent_ids:
            return {}
        result = await session.execute(
            select(DeliveryCursor.agent_id, DeliveryCursor.last_seq).where(
                DeliveryCursor.room_id == room_id,
                DeliveryCursor.agent_id.in_(list(agent_ids)),
            )
        )
        return {agent_id: last_seq for agent_id, last_seq in result.all()}

    async def advance(
        self, session: AsyncSession, agent_id: str, room_id: str, seq: int
    ) -> None:
        """Move the cursor forward to `seq`, never backward.

        `GREATEST` rather than an assignment because two deliveries for the
        same agent can finish out of order — a retry after a slow read, two
        workers on the same room — and the later write must not undo the
        further one. Rewinding a cursor redelivers, and a redelivered message
        is indistinguishable from a new one to whoever reads it.
        """
        statement = insert(DeliveryCursor).values(
            agent_id=agent_id, room_id=room_id, last_seq=seq
        )
        await session.execute(
            statement.on_conflict_do_update(
                constraint="uq_delivery_cursors_agent_room",
                set_={
                    "last_seq": func.greatest(
                        DeliveryCursor.last_seq, statement.excluded.last_seq
                    ),
                    "updated_at": func.now(),
                },
            )
        )
