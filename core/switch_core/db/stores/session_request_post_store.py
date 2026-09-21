"""Reading back what a request card stands for."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select

from switch_core.db.models import SessionRequestPost

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class SessionRequestPostStore:
    async def create(
        self, session: AsyncSession, post: SessionRequestPost
    ) -> SessionRequestPost:
        session.add(post)
        await session.flush()
        return post

    async def count_in_channel(
        self, session: AsyncSession, bridge_id: str, channel_id: str
    ) -> int:
        """How many cards this bridge has posted in one channel.

        What a freshly minted handle counts up from. It is a starting point and
        not a reservation — two cards posted at once would compute the same one
        — so the unique index is what actually settles it and the caller retries
        from here.
        """
        result = await session.execute(
            select(func.count())
            .select_from(SessionRequestPost)
            .where(
                SessionRequestPost.bridge_id == bridge_id,
                SessionRequestPost.external_channel_id == channel_id,
            )
        )
        return int(result.scalar_one())

    async def get_by_request(
        self, session: AsyncSession, bridge_id: str, session_id: str, request_id: str
    ) -> SessionRequestPost | None:
        """The card a request already has on this bridge, if it has one.

        One request, one card: a second would be a second set of buttons for a
        decision that can only be taken once, and the unique index refuses it.
        Read before posting so that refusal arrives as an answer rather than as
        a constraint violation.
        """
        result = await session.execute(
            select(SessionRequestPost).where(
                SessionRequestPost.bridge_id == bridge_id,
                SessionRequestPost.session_id == session_id,
                SessionRequestPost.request_id == request_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_token(
        self, session: AsyncSession, bridge_id: str, token: str
    ) -> SessionRequestPost | None:
        """The request a callback token names, within one bridge.

        Scoped by bridge even though a token is unique on its own: a token that
        reached us over another workspace's connection names nothing here.
        """
        result = await session.execute(
            select(SessionRequestPost).where(
                SessionRequestPost.bridge_id == bridge_id,
                SessionRequestPost.token == token,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_handle(
        self, session: AsyncSession, bridge_id: str, channel_id: str, handle: str
    ) -> SessionRequestPost | None:
        """The request a typed handle names, within one channel of one bridge.

        Matched without regard to case, because a handle is something a person
        retypes rather than something a platform hands back, and "r42" is what
        they meant. It is unique per channel, which is as far as a person can
        see: the same handle in another channel is another request.
        """
        result = await session.execute(
            select(SessionRequestPost).where(
                SessionRequestPost.bridge_id == bridge_id,
                SessionRequestPost.external_channel_id == channel_id,
                func.lower(SessionRequestPost.handle) == handle.lower(),
            )
        )
        return result.scalar_one_or_none()

    async def get_by_post(
        self, session: AsyncSession, bridge_id: str, external_post_id: str
    ) -> SessionRequestPost | None:
        """The request a message is a reply to, if that message is a card.

        This is what makes a bare "yes" answerable: it stands for a decision
        only when it is a direct reply to exactly one card, and a thread rooted
        at a card is exactly that.
        """
        result = await session.execute(
            select(SessionRequestPost).where(
                SessionRequestPost.bridge_id == bridge_id,
                SessionRequestPost.external_post_id == external_post_id,
            )
        )
        return result.scalar_one_or_none()
