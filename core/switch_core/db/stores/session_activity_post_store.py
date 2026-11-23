"""Where approval cards and turn messages sit on a bridge.

Stateless, like every store here: the caller owns the session and the
transaction, and the bound tenant scopes every read through row-level security.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import and_, func, or_, select

from switch_core.db.models import (
    AgentSessionActivityItem,
    ApprovalRequest,
    ApprovalRequestPost,
    SteeredMessageMark,
    TurnStatusPost,
)
from switch_core.db.stores.session_activity_store import TURN_ITEM_ID

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

    async def latest_in_thread(
        self,
        session: AsyncSession,
        bridge_id: str,
        channel_id: str,
        thread_ref: str,
    ) -> ApprovalRequestPost | None:
        """The newest card posted in a thread, for a reply in that thread."""
        result = await session.execute(
            select(ApprovalRequestPost)
            .where(
                ApprovalRequestPost.bridge_id == bridge_id,
                ApprovalRequestPost.external_channel_id == channel_id,
                ApprovalRequestPost.thread_ref == thread_ref,
                ApprovalRequestPost.removed_at.is_(None),
            )
            .order_by(ApprovalRequestPost.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def newest_open_in_channel(
        self, session: AsyncSession, bridge_id: str, channel_id: str
    ) -> ApprovalRequestPost | None:
        """The newest card in a channel whose request still waits on an answer."""
        result = await session.execute(
            select(ApprovalRequestPost)
            .join(
                ApprovalRequest,
                and_(
                    ApprovalRequest.agent_id == ApprovalRequestPost.agent_id,
                    ApprovalRequest.session_id == ApprovalRequestPost.session_id,
                    ApprovalRequest.request_id == ApprovalRequestPost.request_id,
                ),
            )
            .where(
                ApprovalRequestPost.bridge_id == bridge_id,
                ApprovalRequestPost.external_channel_id == channel_id,
                ApprovalRequestPost.external_post_id.is_not(None),
                ApprovalRequestPost.removed_at.is_(None),
                ApprovalRequest.state == "open",
            )
            .order_by(ApprovalRequestPost.created_at.desc())
            .limit(1)
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
        """The turn a message of ours is showing: its own message, its notice,
        or the work message (`!work-threads`) its session is on."""
        result = await session.execute(
            select(TurnStatusPost)
            .where(
                TurnStatusPost.bridge_id == bridge_id,
                TurnStatusPost.external_channel_id == channel_id,
                or_(
                    TurnStatusPost.external_post_id == ref,
                    TurnStatusPost.attention_post_id == ref,
                    TurnStatusPost.work_message_ref == ref,
                ),
            )
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def latest_in_thread(
        self, session: AsyncSession, bridge_id: str, channel_id: str, thread_ref: str
    ) -> TurnStatusPost | None:
        """The turn a thread is busy with, else the one drawn there last.

        What Slack's own Stop on a session in a thread names: a session there
        belongs to the thread, not to any one message of ours in it, so the
        press names the thread's first message. A turn still running comes
        first, because several agents can take turns in one thread and the
        row a finished turn leaves is touched later than a running one's:
        it is stamped when the turn ends, and a running turn's row is not
        rewritten as it redraws.
        """
        turn = AgentSessionActivityItem
        running = (
            select(turn.turn_id)
            .where(
                turn.agent_id == TurnStatusPost.agent_id,
                turn.session_id == TurnStatusPost.session_id,
                turn.turn_id == TurnStatusPost.turn_id,
                turn.item_id == TURN_ITEM_ID,
                turn.status.in_(("queued", "running")),
            )
            .exists()
        )
        result = await session.execute(
            select(TurnStatusPost)
            .where(
                TurnStatusPost.bridge_id == bridge_id,
                TurnStatusPost.external_channel_id == channel_id,
                TurnStatusPost.thread_ref == thread_ref,
            )
            .order_by(running.desc(), TurnStatusPost.updated_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def others_unfinished_in_thread(
        self, session: AsyncSession, post: TurnStatusPost
    ) -> bool:
        """Whether another turn drawn inline in the same thread has not had its
        ending yet. A platform session belongs to the thread, so one turn
        ending must not mark it done while another is still working there."""
        if post.thread_ref is None:
            return False
        found = await session.scalar(
            select(TurnStatusPost.turn_id)
            .where(
                TurnStatusPost.bridge_id == post.bridge_id,
                TurnStatusPost.external_channel_id == post.external_channel_id,
                TurnStatusPost.thread_ref == post.thread_ref,
                TurnStatusPost.work_message_ref.is_not(None),
                TurnStatusPost.work_finished_at.is_(None),
                or_(
                    TurnStatusPost.agent_id != post.agent_id,
                    TurnStatusPost.session_id != post.session_id,
                    TurnStatusPost.turn_id != post.turn_id,
                ),
            )
            .limit(1)
        )
        return found is not None

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


class SteeredMessageMarkStore:
    """The work markers on messages steered into running turns, per bridge."""

    async def of_turn(
        self,
        session: AsyncSession,
        bridge_id: str,
        agent_id: str,
        session_id: str,
        turn_id: str,
    ) -> list[SteeredMessageMark]:
        result = await session.execute(
            select(SteeredMessageMark).where(
                SteeredMessageMark.bridge_id == bridge_id,
                SteeredMessageMark.agent_id == agent_id,
                SteeredMessageMark.session_id == session_id,
                SteeredMessageMark.turn_id == turn_id,
            )
        )
        return list(result.scalars())

    async def record(self, session: AsyncSession, mark: SteeredMessageMark) -> None:
        """Store whether the marker is (or may be) on the message, before or
        after the platform is asked, so a failure leaves it counted."""
        await session.merge(mark)
        await session.flush()

    async def marked(
        self, session: AsyncSession, bridge_id: str
    ) -> list[SteeredMessageMark]:
        """Steered messages still carrying a marker of ours."""
        result = await session.execute(
            select(SteeredMessageMark).where(
                SteeredMessageMark.bridge_id == bridge_id,
                SteeredMessageMark.marked.is_(True),
            )
        )
        return list(result.scalars())

    async def holders(
        self,
        session: AsyncSession,
        bridge_id: str,
        channel_id: str,
        reaction_message_ref: str,
    ) -> list[SteeredMessageMark]:
        """Every steered marker held on one platform message."""
        result = await session.execute(
            select(SteeredMessageMark).where(
                SteeredMessageMark.bridge_id == bridge_id,
                SteeredMessageMark.external_channel_id == channel_id,
                SteeredMessageMark.reaction_message_ref == reaction_message_ref,
                SteeredMessageMark.marked.is_(True),
            )
        )
        return list(result.scalars())
