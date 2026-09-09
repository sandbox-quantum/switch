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

    async def record_posted(
        self,
        session: AsyncSession,
        publication: SessionPublication,
        external_post_id: str,
    ) -> SessionPublication:
        """A card is out there, and this is where it is.

        Settled, so `last_error` goes with it — whatever went wrong on an
        earlier try is no longer true of this intent.
        """
        publication.state = "posted"
        publication.external_post_id = external_post_id
        publication.last_error = None
        publication.attempts += 1
        await session.flush()
        return publication

    async def record_failure(
        self,
        session: AsyncSession,
        publication: SessionPublication,
        state: str,
        last_error: str,
    ) -> SessionPublication:
        """A try that did not settle, and why.

        It cannot clear `external_post_id`, which is the whole point of
        splitting this from `record_posted`: the caller that records a failed
        edit after a successful post would otherwise erase the one fact saying
        a card exists, and a reconciliation that finds nothing posts a second.

        `attempts` counts tries and not failures, because a try that ended in
        silence is the one worth backing off on.
        """
        publication.state = state
        publication.last_error = last_error
        publication.attempts += 1
        await session.flush()
        return publication

    async def claim_unresolved(
        self, session: AsyncSession, limit: int
    ) -> list[SessionPublication]:
        """Intents that never settled, taken for this sweep alone.

        What the retry sweep works through. It is driven from here rather than
        from the event stream because a session waiting on an approval emits
        nothing further, and that is exactly the session whose card is missing.

        The rows are locked and rows another sweep already holds are skipped.
        Reconciling a post takes a call to the platform, which can outlast the
        sweep timer, and two passes that both adopt the same in-flight intent
        post the second card this table exists to prevent. The caller holds the
        transaction for as long as it is working on them.
        """
        result = await session.execute(
            select(SessionPublication)
            .where(SessionPublication.state.in_(UNRESOLVED_STATES))
            .order_by(SessionPublication.updated_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        return list(result.scalars())
