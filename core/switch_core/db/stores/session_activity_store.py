"""What a session's host reports: activity lines and approval requests.

Stateless, like every store here: the caller owns the session and the
transaction, and the bound tenant scopes every read through row-level security.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert

from switch_core.db.models import Agent, ApprovalRequest, SessionActivityEvent

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


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
    async def insert_if_absent(
        self, session: AsyncSession, event: SessionActivityEvent
    ) -> bool:
        """Insert `event` unless its (agent, session, seq) exists."""
        values = {
            column.key: getattr(event, column.key)
            for column in SessionActivityEvent.__table__.columns
            if getattr(event, column.key) is not None
        }
        result = await session.execute(
            insert(SessionActivityEvent)
            .values(**values)
            .on_conflict_do_nothing()
            .returning(SessionActivityEvent.seq)
        )
        return result.scalar_one_or_none() is not None

    async def get(
        self, session: AsyncSession, agent_id: str, session_id: str, seq: int
    ) -> SessionActivityEvent | None:
        result = await session.execute(
            select(SessionActivityEvent).where(
                SessionActivityEvent.agent_id == agent_id,
                SessionActivityEvent.session_id == session_id,
                SessionActivityEvent.seq == seq,
            )
        )
        return result.scalar_one_or_none()

    async def since(
        self,
        session: AsyncSession,
        agent_id: str,
        session_id: str,
        after_seq: int,
        limit: int,
    ) -> list[SessionActivityEvent]:
        result = await session.execute(
            select(SessionActivityEvent)
            .where(
                SessionActivityEvent.agent_id == agent_id,
                SessionActivityEvent.session_id == session_id,
                SessionActivityEvent.seq > after_seq,
            )
            .order_by(SessionActivityEvent.seq)
            .limit(limit)
        )
        return list(result.scalars())

    async def turn(
        self, session: AsyncSession, agent_id: str, session_id: str, turn_id: str
    ) -> list[SessionActivityEvent]:
        """Every recorded line of one turn, in the host's order."""
        result = await session.execute(
            select(SessionActivityEvent)
            .where(
                SessionActivityEvent.agent_id == agent_id,
                SessionActivityEvent.session_id == session_id,
                SessionActivityEvent.turn_id == turn_id,
            )
            .order_by(SessionActivityEvent.seq)
        )
        return list(result.scalars())

    async def prune_before(self, session: AsyncSession, cutoff: datetime) -> int:
        result = await session.execute(
            delete(SessionActivityEvent).where(SessionActivityEvent.created_at < cutoff)
        )
        return int(result.rowcount or 0)  # type: ignore[attr-defined]
