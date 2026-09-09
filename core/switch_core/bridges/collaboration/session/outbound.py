"""Putting a session's state in a channel, and keeping it in step afterwards.

Two things go out. A **request card** is something someone has to answer, so it
is posted once and then edited in place as the request moves open → submitting
→ resolved or closed, and the channel carries one message per request rather
than a running commentary. **Turn activity** is not addressed to anyone: it is
what the agent said and did, and it is posted for reading.

The inbound half turns a press into a command; this is the other side of it.

Posting is also what makes the inbound half reachable at all: the row written
here is the only thing a token, a handle or a reply to a card ever resolves to.

Slack-shaped, for the same reason `post_blocks` is: Block Kit is Slack's own
form and the platforms that need something like a card need something
different. The neutral seam belongs here when a second platform wants one, not
before.
"""

from __future__ import annotations

import logging
import secrets

from slack_sdk.errors import SlackApiError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore

from .contract import Item, SnapshotRequest
from .form import posted_form
from .renderers import RequestReference
from .renderers.slack import render_activity, render_request

logger = logging.getLogger(__name__)

# What a person types to name a card. Short because it is retyped by hand, and
# unique only within one channel, which is as far as anyone can see.
_HANDLE_PREFIX = "R"

# A clash means another card took the number between the count and the insert.
# Each retry counts one further up, so the loop only needs to outlast the cards
# posted concurrently into a single channel.
_MINT_ATTEMPTS = 5

# The two refusals this can provoke, named because they are different mistakes
# and only one of them is worth retrying.
_HANDLE_CONSTRAINT = "uq_session_request_posts_handle"
_REQUEST_CONSTRAINT = "uq_session_request_posts_request"


def _violates(error: IntegrityError, constraint: str) -> bool:
    """Whether Postgres refused this particular uniqueness.

    asyncpg records the name on its own exception, and SQLAlchemy re-raises a
    wrapper `from` it, so the name is on the cause where it is anywhere. Failing
    that it is still in the message, quoted, because that is how Postgres writes
    it. Without this every refusal reads as the last one guessed at.
    """
    for candidate in (error.orig, getattr(error.orig, "__cause__", None)):
        name = getattr(candidate, "constraint_name", None)
        if name:
            return bool(name == constraint)
    return f'"{constraint}"' in str(error.orig)


class CardNotPosted(RuntimeError):
    """A request that has no card, so nobody was asked and nobody can answer.

    Raised rather than logged: the session is waiting on an answer, and the
    caller is the only thing that can tell it no one is going to give one.
    """


class CardAlreadyPosted(CardNotPosted):
    """The request was already asked, so this is a repeat and not a failure.

    A subclass because a caller that only wants to know nobody was asked is
    right either way, and one that can tell a repeat from a refusal can.
    """


class SessionTurnActivity:
    """A turn's work, shown in a channel.

    Nothing is recorded for it and nothing is edited afterwards, which is the
    difference between this and a card. A card is a question, so it needs a row
    to resolve an answer against and has to stop offering buttons once it is
    settled; a turn is a report, and a report that is out of date is still what
    happened. Keeping one message per turn in step with a live session needs an
    anchor to edit, and where that anchor lives is the same open question as
    which room a session's activity belongs to.
    """

    def __init__(self, adapter: SlackAdapter) -> None:
        self._adapter = adapter

    async def post(
        self,
        items: list[Item],
        *,
        channel_id: str,
        thread_root_id: str | None,
        agent_name: str,
    ) -> None:
        """Draw the turn in a channel, saying so in the log if Slack refuses.

        Logged rather than raised, unlike a card that cannot be posted: nobody
        is waiting on this to answer anything, so the session is no worse off
        than it was before the contract existed and whatever asked for it can
        get on with the part that someone is waiting for.
        """
        message = render_activity(items)
        ref = await self._adapter.post_blocks(
            channel_id, agent_name, message.text, message.blocks, thread_root_id
        )
        if ref is None:
            logger.error(
                "Slack did not accept the activity for turn %s in channel %s, so "
                "the channel shows what the agent asked without what it did.",
                items[0].turn_id,
                channel_id,
            )


class SessionRequestCards:
    """One bridge's posted request cards, as the requests behind them change."""

    def __init__(
        self,
        adapter: SlackAdapter,
        *,
        bridge_id: str,
        posts: SessionRequestPostStore,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._adapter = adapter
        self._bridge_id = bridge_id
        self._posts = posts
        self._session_factory = session_factory
        self._reported_edit_failures: dict[str, tuple[int, str]] = {}

    async def post(
        self,
        request: SnapshotRequest,
        *,
        channel_id: str,
        thread_root_id: str | None,
        room_id: str,
        session_id: str,
        epoch: str,
        agent_name: str,
    ) -> SessionRequestPost:
        """Reserve the card durably before sending it to the platform."""
        form = posted_form(request)
        token = secrets.token_urlsafe(16)
        async with self._session_factory() as session:
            post = await self._reserve(
                session,
                token=token,
                form=form,
                channel_id=channel_id,
                thread_root_id=thread_root_id,
                room_id=room_id,
                session_id=session_id,
                epoch=epoch,
                request=request,
            )
            message = render_request(
                request, RequestReference(token=post.token, handle=post.handle)
            )
            message.blocks[0]["block_id"] = f"switch-request:{post.token}"
            await session.commit()
            ref = await self._adapter.post_blocks(
                channel_id, agent_name, message.text, message.blocks, thread_root_id
            )
            if ref is None:
                await session.delete(post)
                await session.commit()
                raise CardNotPosted(
                    f"Slack did not accept the card for request "
                    f"{request.request_id} in channel {channel_id}, so nobody "
                    f"has been asked and the handle {post.handle} was released."
                )
            post.external_post_id = ref
            await session.commit()
            logger.info(
                "Posted card %s for request %s of session %s in channel %s",
                post.handle,
                request.request_id,
                session_id,
                channel_id,
            )
            return post

    async def recover(self, post: SessionRequestPost) -> SessionRequestPost:
        """Bind an uncertain delivery to its existing platform message; never repost."""
        ref = await self._adapter.find_request_card(
            post.external_channel_id, post.thread_id, post.token, post.created_at
        )
        if ref is None:
            raise CardNotPosted(
                f"Delivery of card {post.handle} is unconfirmed; retaining its reservation "
                "and retrying lookup instead of risking a duplicate."
            )
        async with self._session_factory() as session:
            stored = await session.get(
                SessionRequestPost, post.id, with_for_update=True
            )
            if stored is None:
                raise CardNotPosted("The reserved card no longer exists.")
            if stored.external_post_id not in (stored.token, ref):
                raise CardNotPosted(
                    "The reserved card is bound to a different message."
                )
            stored.external_post_id = ref
            await session.commit()
            return stored

    async def _reserve(
        self,
        session: AsyncSession,
        *,
        token: str,
        form: dict[str, object],
        channel_id: str,
        thread_root_id: str | None,
        room_id: str,
        session_id: str,
        epoch: str,
        request: SnapshotRequest,
    ) -> SessionRequestPost:
        """Hold a handle nobody else in this channel has, or say it could not.

        The request is checked for a card first, so that a second card for a
        decision that can only be taken once is refused as itself rather than
        arriving as a handle that will not mint. That read cannot cover the one
        case where two posters are in flight at once, so the insert is read the
        same way: by which uniqueness Postgres named. Retrying is only ever
        right for the handle, which is a guess; anything else is an answer.
        """
        repeat = await self._repeat_of(session, session_id=session_id, request=request)
        if repeat is not None:
            raise repeat
        start = await self._posts.count_in_channel(session, self._bridge_id, channel_id)
        for attempt in range(_MINT_ATTEMPTS):
            row = SessionRequestPost(
                bridge_id=self._bridge_id,
                token=token,
                handle=f"{_HANDLE_PREFIX}{start + 1 + attempt}",
                external_channel_id=channel_id,
                external_post_id=token,
                room_id=room_id,
                thread_id=thread_root_id,
                session_id=session_id,
                epoch=epoch,
                request_id=request.request_id,
                revision=request.revision,
                form=form,
            )
            try:
                async with session.begin_nested():
                    await self._posts.create(session, row)
            except IntegrityError as error:
                if _violates(error, _REQUEST_CONSTRAINT):
                    raise await self._lost_the_race(
                        session, session_id=session_id, request=request
                    ) from error
                if not _violates(error, _HANDLE_CONSTRAINT):
                    raise
                continue
            return row
        raise CardNotPosted(
            f"Could not find a free handle for request {request.request_id} in "
            f"channel {channel_id} after {_MINT_ATTEMPTS} tries, so it has no "
            f"card: a card nobody can name is one a typed answer cannot reach."
        )

    async def _repeat_of(
        self,
        session: AsyncSession,
        *,
        session_id: str,
        request: SnapshotRequest,
    ) -> CardAlreadyPosted | None:
        """The refusal to give this request a second card, if it has one."""
        existing = await self._posts.get_by_request(
            session, self._bridge_id, session_id, request.request_id
        )
        if existing is None:
            return None
        return CardAlreadyPosted(
            f"Request {request.request_id} of session {session_id} already has "
            f"card {existing.handle} in channel {existing.external_channel_id}."
        )

    async def _lost_the_race(
        self,
        session: AsyncSession,
        *,
        session_id: str,
        request: SnapshotRequest,
    ) -> CardAlreadyPosted:
        """The same refusal, for the poster that got there second.

        Read again rather than reported blind: the winner has committed by the
        time this insert is refused, so the card it made can be named, and being
        told which card already asks the question is the whole difference
        between this and a card that simply did not appear.
        """
        repeat = await self._repeat_of(session, session_id=session_id, request=request)
        if repeat is not None:
            return repeat
        return CardAlreadyPosted(
            f"Request {request.request_id} of session {session_id} was given a "
            f"card by another poster, which has since gone."
        )

    async def refresh(self, post: SessionRequestPost, request: SnapshotRequest) -> None:
        """Redraw the card for `request` where it was posted.

        When the edit fails the outcome is posted into the thread instead. A
        stale card is the one failure that cannot be left silent: it goes on
        showing buttons for a request that has already settled, and a reader has
        no way to tell that pressing one will do nothing.

        That reply lands in the card's own thread, which is also the one place a
        bare "yes" answers — and only as the first reply. So a failed edit takes
        that slot and leaves the card answerable by name alone. Accepted rather
        than worked around: the card is already known to be wrong, and losing a
        shorthand is the safer of the two directions.
        """
        message = render_request(
            request, RequestReference(token=post.token, handle=post.handle)
        )
        message.blocks[0]["block_id"] = f"switch-request:{post.token}"
        try:
            await self._adapter.update_blocks(
                post.external_channel_id,
                post.external_post_id,
                message.text,
                message.blocks,
            )
        except SlackApiError as error:
            logger.error(
                "Could not update the card for request %s in channel %s: %s. "
                "Posting the outcome as a reply instead.",
                post.request_id,
                post.external_channel_id,
                error,
            )
            state = (request.revision, request.state)
            if self._reported_edit_failures.get(post.token) != state:
                await self._adapter.admin_message(
                    post.external_channel_id,
                    f"The card for request {post.handle} above could not be updated, "
                    f"so it may still be offering buttons that no longer "
                    f"work.\n{message.text}",
                    post.external_post_id,
                )
                self._reported_edit_failures[post.token] = state
            raise
        else:
            self._reported_edit_failures.pop(post.token, None)
