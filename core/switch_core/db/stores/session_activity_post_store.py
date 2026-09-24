"""Where approval cards and turn messages sit on a bridge.

Stateless, like every store here: the caller owns the session and the
transaction, and the bound tenant scopes every read through row-level security.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, or_, select

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
        *,
        for_update: bool,
    ) -> TurnStatusPost | None:
        query = select(TurnStatusPost).where(
            TurnStatusPost.bridge_id == bridge_id,
            TurnStatusPost.agent_id == agent_id,
            TurnStatusPost.session_id == session_id,
            TurnStatusPost.turn_id == turn_id,
        )
        if for_update:
            query = query.with_for_update()
        return (await session.execute(query)).scalar_one_or_none()

    async def at(
        self, session: AsyncSession, bridge_id: str, channel_id: str, ref: str
    ) -> TurnStatusPost | None:
        """The turn a message of ours is showing: its own message, or its notice."""
        result = await session.execute(
            select(TurnStatusPost)
            .where(
                TurnStatusPost.bridge_id == bridge_id,
                TurnStatusPost.external_channel_id == channel_id,
                or_(
                    TurnStatusPost.external_post_id == ref,
                    TurnStatusPost.attention_post_id == ref,
                ),
            )
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def marked(
        self, session: AsyncSession, bridge_id: str
    ) -> list[TurnStatusPost]:
        """Turn messages whose asking message still carries a marker of theirs."""
        result = await session.execute(
            select(TurnStatusPost).where(
                TurnStatusPost.bridge_id == bridge_id,
                TurnStatusPost.mark.is_not(None),
            )
        )
        return list(result.scalars())

    async def other_holders(
        self,
        session: AsyncSession,
        post: TurnStatusPost,
        mark: str,
        *,
        same_agent: bool,
    ) -> int:
        """Other turns that put `mark` on the same asking message and still hold it."""
        query = (
            select(func.count())
            .select_from(TurnStatusPost)
            .where(
                TurnStatusPost.bridge_id == post.bridge_id,
                TurnStatusPost.external_channel_id == post.external_channel_id,
                TurnStatusPost.reaction_message_ref == post.reaction_message_ref,
                TurnStatusPost.mark == mark,
                or_(
                    TurnStatusPost.agent_id != post.agent_id,
                    TurnStatusPost.session_id != post.session_id,
                    TurnStatusPost.turn_id != post.turn_id,
                ),
            )
        )
        if same_agent:
            query = query.where(TurnStatusPost.agent_id == post.agent_id)
        return int((await session.execute(query)).scalar_one())

    async def create(self, session: AsyncSession, post: TurnStatusPost) -> None:
        session.add(post)
        await session.flush()
