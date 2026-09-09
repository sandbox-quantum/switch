"""The intent to publish a request, and what became of it."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select

from switch_core.db.models import SessionPublication

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

UNRESOLVED_STATES = ("intended", "in-flight")


class SessionPublicationStore:
    async def create(
        self, session: AsyncSession, publication: SessionPublication
    ) -> SessionPublication:
        """Record the intent to post, before the platform is called.

        The row exists so that a crash between the call and its result leaves
        something behind saying a post may be out there. The caller commits it
        before it calls the platform; a row written afterwards would say
        nothing about the case it exists for.
        """
        session.add(publication)
        await session.flush()
        return publication

    async def get(
        self, session: AsyncSession, bridge_id: str, session_id: str, request_id: str
    ) -> SessionPublication | None:
        """What this bridge has already tried for this request, if anything."""
        result = await session.execute(
            select(SessionPublication).where(
                SessionPublication.bridge_id == bridge_id,
                SessionPublication.session_id == session_id,
                SessionPublication.request_id == request_id,
            )
        )
        return result.scalar_one_or_none()

    async def record_attempt(
        self,
        session: AsyncSession,
        publication: SessionPublication,
        state: str,
        external_post_id: str | None,
        last_error: str | None,
    ) -> SessionPublication:
        """Move an intent along, counting the try.

        `attempts` is what a sweep backs off on, so it counts attempts rather
        than failures: a try that ended in silence is the one worth waiting
        longer before repeating.
        """
        publication.state = state
        publication.external_post_id = external_post_id
        publication.last_error = last_error
        publication.attempts += 1
        await session.flush()
        return publication

    async def unresolved(
        self, session: AsyncSession, limit: int
    ) -> list[SessionPublication]:
        """Intents that never reached a settled state, oldest touched first.

        What the retry sweep works through. It is driven from here rather than
        from the event stream because a session waiting on an approval emits
        nothing further, and that is exactly the session whose card is missing.
        """
        result = await session.execute(
            select(SessionPublication)
            .where(SessionPublication.state.in_(UNRESOLVED_STATES))
            .order_by(SessionPublication.updated_at)
            .limit(limit)
        )
        return list(result.scalars())
