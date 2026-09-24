"""Where approval cards and turn status messages sit on a bridge.

Stateless, like every store here: the caller owns the session and the
transaction, and the bound tenant scopes every read through row-level security.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select

from switch_core.db.models import ApprovalRequestPost, TurnStatusPost

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class ApprovalRequestPostStore:
    async def create(
        self, session: AsyncSession, post: ApprovalRequestPost
    ) -> ApprovalRequestPost:
        session.add(post)
        await session.flush()
        return post

    async def count_in_channel(
        self, session: AsyncSession, bridge_id: str, channel_id: str
    ) -> int:
        """What a new handle counts up from. The unique index settles collisions."""
        result = await session.execute(
            select(func.count())
            .select_from(ApprovalRequestPost)
            .where(
                ApprovalRequestPost.bridge_id == bridge_id,
                ApprovalRequestPost.external_channel_id == channel_id,
            )
        )
        return int(result.scalar_one())

    async def get(
        self,
        session: AsyncSession,
        bridge_id: str,
        agent_id: str,
        session_id: str,
        request_id: str,
        *,
        for_update: bool,
    ) -> ApprovalRequestPost | None:
        query = select(ApprovalRequestPost).where(
            ApprovalRequestPost.bridge_id == bridge_id,
            ApprovalRequestPost.agent_id == agent_id,
            ApprovalRequestPost.session_id == session_id,
            ApprovalRequestPost.request_id == request_id,
        )
        if for_update:
            query = query.with_for_update()
        return (await session.execute(query)).scalar_one_or_none()

    async def get_by_token(
        self, session: AsyncSession, bridge_id: str, token: str
    ) -> ApprovalRequestPost | None:
        """Scoped by bridge: a token that arrived over another bridge names nothing here."""
        result = await session.execute(
            select(ApprovalRequestPost).where(
                ApprovalRequestPost.bridge_id == bridge_id,
                ApprovalRequestPost.token == token,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_handle(
        self, session: AsyncSession, bridge_id: str, channel_id: str, handle: str
    ) -> ApprovalRequestPost | None:
        """Case-insensitive: a handle is retyped by a person, and "a3" means "A3"."""
        result = await session.execute(
            select(ApprovalRequestPost).where(
                ApprovalRequestPost.bridge_id == bridge_id,
                ApprovalRequestPost.external_channel_id == channel_id,
                func.lower(ApprovalRequestPost.handle) == handle.lower(),
            )
        )
        return result.scalar_one_or_none()

    async def get_by_post(
        self,
        session: AsyncSession,
        bridge_id: str,
        channel_id: str,
        external_post_id: str,
    ) -> ApprovalRequestPost | None:
        """The card a message replies to, if the message it replies to is a card."""
        result = await session.execute(
            select(ApprovalRequestPost).where(
                ApprovalRequestPost.bridge_id == bridge_id,
                ApprovalRequestPost.external_channel_id == channel_id,
                ApprovalRequestPost.external_post_id == external_post_id,
            )
        )
        return result.scalar_one_or_none()


class TurnStatusPostStore:
    async def get(
        self,
        session: AsyncSession,
        bridge_id: str,
        agent_id: str,
        session_id: str,
        turn_id: str,
    ) -> TurnStatusPost | None:
        result = await session.execute(
            select(TurnStatusPost).where(
                TurnStatusPost.bridge_id == bridge_id,
                TurnStatusPost.agent_id == agent_id,
                TurnStatusPost.session_id == session_id,
                TurnStatusPost.turn_id == turn_id,
            )
        )
        return result.scalar_one_or_none()

    async def unfinished(
        self, session: AsyncSession, bridge_id: str
    ) -> list[TurnStatusPost]:
        """Status messages still drawn as running, which a missed event may have left stale."""
        result = await session.execute(
            select(TurnStatusPost).where(
                TurnStatusPost.bridge_id == bridge_id,
                TurnStatusPost.finished.is_(False),
            )
        )
        return list(result.scalars())

    async def create(self, session: AsyncSession, post: TurnStatusPost) -> None:
        session.add(post)
        await session.flush()
