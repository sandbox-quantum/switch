"""Reading back what a request card stands for."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select

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
