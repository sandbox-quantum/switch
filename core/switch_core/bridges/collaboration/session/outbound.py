"""Putting a session's state in a channel, and keeping it in step afterwards.

Two things go out, and both are posted once and edited in place afterwards. A
**request card** is something someone has to answer, so it moves open →
submitting → resolved or closed and the channel carries one message per request
rather than a running commentary. **Turn activity** is not addressed to anyone —
it is what the agent said and did, and it is read rather than answered — but it
changes for the same reason, so it gets the same treatment: one message per
turn, kept in step, ending on the turn's final state.

What differs is what is remembered. A card's message is a row, because an
answer typed tomorrow has to find it; a turn's is held in memory for as long as
the turn is running, because nothing resolves against it.

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
from collections import OrderedDict
from dataclasses import dataclass

from slack_sdk.errors import SlackApiError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore

from .contract import TURN_ENDED, Item, SnapshotRequest, TurnUpsert
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

# How many unended turns one bridge keeps a message to edit for. Far more than
# a bridge has live turns, and small enough that a session leaking them cannot
# take the process with it.
_MAX_ANCHORS = 512


@dataclass(frozen=True)
class _Anchor:
    """The message a turn is being kept in, and the channel it is in."""

    channel_id: str
    message_ref: str


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
    """A turn's work, shown in a channel and kept in step as it runs.

    One message per turn, posted the first time and edited every time after,
    because a turn is a report and reposting one is a running commentary: a
    reader scrolling a channel would find six versions of the same turn and no
    way to tell which is current. The message that was posted is the anchor
    every later edit goes to, and the last edit is the turn's final state.

    Still not a card, which is the difference in how failure is handled here. A
    card has buttons, so one left showing a stale state invites a press that
    cannot land and has to be raised about; a turn is read, so a failed edit is
    logged and the next one tries the same anchor again.

    **The anchors are held in memory, and that is this slice's boundary.** They
    live as long as the process does, so a bridge restarted mid-turn reposts
    the turn instead of editing it — one duplicate in the channel, visible, and
    not silence. Making them durable is the publisher's work in the server-side
    branch, which has a record with a sweep behind it; there is nothing here
    for it to migrate, only a store to hand in.
    """

    def __init__(self, adapter: SlackAdapter) -> None:
        self._adapter = adapter
        self._anchors: OrderedDict[tuple[str, str], _Anchor] = OrderedDict()

    async def publish(
        self,
        items: list[Item],
        turn: TurnUpsert,
        *,
        session_id: str,
        channel_id: str,
        thread_root_id: str | None,
        agent_name: str,
    ) -> None:
        """Draw the turn where it already is, or where it is not yet.

        Logged rather than raised, unlike a card that cannot be posted: nobody
        is waiting on this to answer anything, so the session is no worse off
        than it was before the contract existed and whatever asked for it can
        get on with the part that someone is waiting for.

        The anchor is dropped once the turn has ended, because nothing more is
        coming for it — including when the last edit is the one that failed,
        which is the one case worth a different sentence in the log: what is
        left in the channel then says the turn is still running, and no later
        call will correct it.
        """
        message = render_activity(items, turn)
        key = (session_id, turn.turn_id)
        anchor = self._anchors.pop(key, None)
        ended = turn.status in TURN_ENDED

        if anchor is None:
            ref = await self._adapter.post_blocks(
                channel_id, agent_name, message.text, message.blocks, thread_root_id
            )
            if ref is None:
                logger.error(
                    "Slack did not accept the activity for turn %s of session %s "
                    "in channel %s, so the channel shows what the agent asked "
                    "without what it did.",
                    turn.turn_id,
                    session_id,
                    channel_id,
                )
                return
            anchor = _Anchor(channel_id=channel_id, message_ref=ref)
        else:
            try:
                await self._adapter.update_blocks(
                    anchor.channel_id,
                    anchor.message_ref,
                    message.text,
                    message.blocks,
                )
            except SlackApiError as error:
                logger.error(
                    "Could not update the activity for turn %s of session %s in "
                    "channel %s: %s. %s",
                    turn.turn_id,
                    session_id,
                    anchor.channel_id,
                    error,
                    "The turn has ended, so the channel is left showing it as "
                    "still running."
                    if ended
                    else "The next change to the turn will try the same message.",
                )

        if ended:
            return
        self._anchors[key] = anchor
        self._forget_the_oldest()

    def _forget_the_oldest(self) -> None:
        """Keep the anchors bounded by dropping the least recently published.

        A turn that stops without ever saying so holds its anchor for the life
        of the process, and the ids come from outside, so without a bound this
        grows for as long as the bridge runs. Dropping one costs a reposted
        turn rather than a lost one, and it says which turn it will happen to.
        """
        while len(self._anchors) > _MAX_ANCHORS:
            (session_id, turn_id), _ = self._anchors.popitem(last=False)
            logger.warning(
                "Holding activity anchors for more than %s turns, so turn %s of "
                "session %s is being forgotten: if it changes again it will be "
                "posted afresh rather than edited in place.",
                _MAX_ANCHORS,
                turn_id,
                session_id,
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
        """Draw `request` as a card in a channel, and record what it offers.

        The handle is reserved before the card is drawn, because the card
        carries it: minting after posting would mean a clash could only be
        resolved by editing a message someone may already be reading. So the row
        goes in first, holding its own token where the post ref will go — unique
        already, so two reservations cannot collide on it either — and the ref
        is filled in once Slack has one.

        Which leaves one ordering to be deliberate about: a card that posts and
        then fails to record is a card offering buttons that resolve to nothing,
        and that cannot happen here, because the recording came first. A
        reservation that fails to post is the other way round — a handle held
        for a card nobody can see — so it is released before raising.
        """
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
            await self._adapter.admin_message(
                post.external_channel_id,
                f"The card for request {post.handle} above could not be updated, "
                f"so it may still be offering buttons that no longer "
                f"work.\n{message.text}",
                post.external_post_id,
            )
