"""What a session's host reports: turn steps and approval requests.

Stateless, like every store here: the caller owns the session and the
transaction, and the bound tenant scopes every read through row-level security.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert

from switch_core.db.models import Agent, ApprovalRequest, SessionActivityItem

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

TURN_ITEM_ID = "turn"


class ApprovalRequestStore:
    async def insert_if_absent(
        self, session: AsyncSession, request: ApprovalRequest
    ) -> bool:
        """Insert `request` unless its key exists. True when this call made it."""
        values = {
            column.key: getattr(request, column.key)
            for column in ApprovalRequest.__table__.columns
            if getattr(request, column.key) is not None
        }
        result = await session.execute(
            insert(ApprovalRequest)
            .values(**values)
            .on_conflict_do_nothing()
            .returning(ApprovalRequest.request_id)
        )
        return result.scalar_one_or_none() is not None

    async def get(
        self,
        session: AsyncSession,
        agent_id: str,
        session_id: str,
        request_id: str,
        *,
        for_update: bool,
    ) -> ApprovalRequest | None:
        query = select(ApprovalRequest).where(
            ApprovalRequest.agent_id == agent_id,
            ApprovalRequest.session_id == session_id,
            ApprovalRequest.request_id == request_id,
        )
        if for_update:
            query = query.with_for_update()
        return (await session.execute(query)).scalar_one_or_none()

    async def undelivered(
        self, session: AsyncSession, agent_id: str
    ) -> list[ApprovalRequest]:
        """Outcomes the agent is owed: answers and expiries not yet handed over."""
        result = await session.execute(
            select(ApprovalRequest)
            .where(
                ApprovalRequest.agent_id == agent_id,
                ApprovalRequest.state.in_(("answered", "expired")),
                ApprovalRequest.delivered_at.is_(None),
            )
            .order_by(ApprovalRequest.updated_at)
        )
        return list(result.scalars())

    async def open_for_owner(
        self, session: AsyncSession, owner_id: str
    ) -> list[ApprovalRequest]:
        """Open requests of every agent `owner_id` owns, oldest first."""
        result = await session.execute(
            select(ApprovalRequest)
            .join(Agent, Agent.id == ApprovalRequest.agent_id)
            .where(Agent.owner_id == owner_id, ApprovalRequest.state == "open")
            .order_by(ApprovalRequest.created_at)
        )
        return list(result.scalars())

    async def expire_due(
        self, session: AsyncSession, now: datetime
    ) -> list[ApprovalRequest]:
        """Close every open request whose deadline has passed, returning them."""
        result = await session.execute(
            update(ApprovalRequest)
            .where(
                ApprovalRequest.state == "open",
                ApprovalRequest.expires_at.is_not(None),
                ApprovalRequest.expires_at <= now,
            )
            .values(state="expired")
            .returning(ApprovalRequest)
        )
        return list(result.scalars())


class SessionActivityStore:
    async def upsert(self, session: AsyncSession, item: SessionActivityItem) -> bool:
        """Record `item` unless a revision at least as new is stored.

        True when this call inserted the row or moved it forward. An equal or
        older revision changes nothing, and so announces nothing.
        """
        values = {
            column.key: getattr(item, column.key)
            for column in SessionActivityItem.__table__.columns
            if column.key not in ("created_at", "updated_at")
            and not (column.key == "tenant_id" and item.tenant_id is None)
        }
        statement = insert(SessionActivityItem).values(**values)
        moved = {
            key: statement.excluded[key]
            for key in (
                "kind",
                "revision",
                "status",
                "title",
                "text",
                "command_id",
                "room_id",
                "thread_id",
                "message_id",
                "occurred_at",
            )
        }
        result = await session.execute(
            statement.on_conflict_do_update(
                index_elements=[
                    SessionActivityItem.tenant_id,
                    SessionActivityItem.agent_id,
                    SessionActivityItem.session_id,
                    SessionActivityItem.turn_id,
                    SessionActivityItem.item_id,
                ],
                set_={**moved, "updated_at": func.now()},
                where=SessionActivityItem.revision < statement.excluded.revision,
            ).returning(SessionActivityItem.item_id)
        )
        return result.scalar_one_or_none() is not None

    async def turn(
        self, session: AsyncSession, agent_id: str, session_id: str, turn_id: str
    ) -> list[SessionActivityItem]:
        """Every step of one turn, in the order each was first reported."""
        result = await session.execute(
            select(SessionActivityItem)
            .where(
                SessionActivityItem.agent_id == agent_id,
                SessionActivityItem.session_id == session_id,
                SessionActivityItem.turn_id == turn_id,
            )
            .order_by(SessionActivityItem.created_at, SessionActivityItem.item_id)
        )
        return list(result.scalars())

    async def turns_of_session(
        self, session: AsyncSession, agent_id: str, session_id: str
    ) -> list[SessionActivityItem]:
        """The turn rows of one session, oldest first."""
        result = await session.execute(
            select(SessionActivityItem)
            .where(
                SessionActivityItem.agent_id == agent_id,
                SessionActivityItem.session_id == session_id,
                SessionActivityItem.item_id == TURN_ITEM_ID,
            )
            .order_by(SessionActivityItem.created_at)
        )
        return list(result.scalars())

    async def prune_before(self, session: AsyncSession, cutoff: datetime) -> int:
        result = await session.execute(
            delete(SessionActivityItem).where(SessionActivityItem.updated_at < cutoff)
        )
        return int(result.rowcount or 0)  # type: ignore[attr-defined]
