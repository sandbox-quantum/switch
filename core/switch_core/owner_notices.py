"""Record owner-visible notices with unverified platform invitations."""

from __future__ import annotations

import uuid

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Agent, OwnerNotice, Room


async def record_unverified_invites(
    session: AsyncSession, room: Room, agents: list[Agent]
) -> None:
    """Write notices in the same transaction that records the memberships.

    An unread notice coalesces duplicate joins for the same agent and room.
    Dismissal permits a later join to notify the owner again. Ownership and
    names are read when displayed rather than retained as snapshots.
    """
    for agent in agents:
        await session.execute(
            insert(OwnerNotice)
            .values(
                id=str(uuid.uuid4()),
                tenant_id=room.tenant_id,
                agent_id=agent.id,
                room_id=room.id,
                kind="unverified_agent_invite",
            )
            .on_conflict_do_nothing(constraint="uq_owner_notices_pending_join")
        )
