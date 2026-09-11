"""Putting a session's state in a channel, and keeping it in step afterwards.

Two things go out, and each occupies one message that is kept in step rather
than reposted. A **request card** is something someone has to answer, so it
moves open → submitting → resolved or closed and the channel carries one
message per request rather than a running commentary. **Turn activity** is not
addressed to anyone — it is what the agent said and did, and it is read rather
than answered — but it changes for the same reason, so it gets the same
treatment: one message per turn, ending on the turn's final state, a Block Kit
message rewritten in place with the tool calls as the cards of a `plan` block.

What differs is what is remembered. A card's message is a row, because an
answer typed tomorrow has to find it; a turn's is held in memory for as long as
the turn is running, because nothing resolves against it.

The inbound half turns a press into a command; this is the other side of it.

Posting is also what makes the inbound half reachable at all: the row written
here is the only thing a token, a handle or a reply to a card ever resolves to.

Typed on `CollaborationAdapter`'s `post_rich` / `update_rich` rather than on
Block Kit: which renderer draws a turn or a card is the adapter's own choice,
and this module never asks. `RichContentFailed` is the one error either can
raise, on any platform, so the edit-failure fallback below is not Slack-shaped
either.

A turn always goes in a thread, never at the channel root: one already
addressed inside a thread stays there, and one addressed at the channel root
now threads under that same triggering message instead of posting beside it —
see `SessionTurnActivity` for the `:eyes:` reaction that goes with it. A
command with nothing to thread under falls back to the channel root, same as
always.
"""

from __future__ import annotations

import logging
import secrets
from collections import OrderedDict
from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
    RequestCard,
    RichContentFailed,
    TurnActivity,
)
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore

from .contract import TURN_ENDED, Item, SnapshotRequest, TurnUpsert
from .form import posted_form
from .renderers import RequestReference

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


@dataclass
class _Anchor:
    """The message a turn is being kept in.

    `thread_root_id` is what a later edit still needs — it is the thread this
    turn's own message was posted into. `reaction_ref` is a different message
    entirely: on Slack, the one that actually asked, resolved once when the
    turn's own message is first posted and kept for as long as the anchor is,
    so a later resolve — the same lookup, but the thread may have moved on to
    a newer asker by then — cannot make a turn's own end clear someone else's
    `:eyes:` instead of its own.
    """

    channel_id: str
    message_ref: str
    thread_root_id: str | None
    reaction_ref: str | None


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

    One message per turn, because a turn is a report and reposting one is a
    running commentary: a reader scrolling a channel would find six versions
    of the same turn and no way to tell which is current. The message is the
    anchor every later change goes to via `post_rich` / `update_rich`,
    rewritten whole on every change — a Block Kit message with the tool calls
    as the cards of a `plan` block on Slack, the neutral turn summary
    anywhere else — and the last change is the turn's final state.

    Always in a thread, never at the channel root: a turn already addressed
    inside a thread stays there, and one addressed at the channel root now
    threads under that same triggering message rather than posting beside it
    — the caller resolves which before this ever sees it (`refresh_activity`).
    On Slack, whichever message ends up as that thread's root gets a `:eyes:`
    reaction for as long as the turn runs, the same signal the old
    runtime-state indicator put on a message being handled — added once the
    turn's own message first posts, taken off once the turn ends. Best
    effort and Slack-only: a reaction is not on the port, and losing one is
    not worth failing a turn's own draw over.

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

    def __init__(self, adapter: CollaborationAdapter) -> None:
        self._adapter = adapter
        self._anchors: OrderedDict[tuple[str, str], _Anchor] = OrderedDict()
        self._thread_turns: dict[tuple[str, str], set[tuple[str, str]]] = {}

    async def publish(
        self,
        items: list[Item],
        turn: TurnUpsert,
        *,
        session_id: str,
        channel_id: str,
        thread_root_id: str | None,
        agent_name: str,
        elapsed_seconds: float | None,
    ) -> bool:
        """Draw the turn where it already is, or where it is not yet.

        Logged rather than raised, unlike a card that cannot be posted: nobody
        is waiting on this to answer anything, so the session is no worse off
        than it was before the contract existed and whatever asked for it can
        get on with the part that someone is waiting for. The return value is
        for a caller that retries on its own schedule and needs to know
        whether *this* call actually landed rather than just not raising —
        `False` on any refusal along the way, so it knows not to treat a
        refusal as the turn's current state having been shown.

        The anchor is dropped once the turn has ended, because nothing more is
        coming for it — including when the last edit is the one that failed,
        which is the one case worth a different sentence in the log: what is
        left in the channel then says the turn is still running, and no later
        call from this process will correct it. A caller that retries on a
        `False` return will still try again, and finding no anchor left will
        post the turn's final state as a new message rather than editing the
        old one — one visible duplicate, the same trade this class already
        makes for a process restart.
        """
        key = (session_id, turn.turn_id)
        anchor = self._anchors.pop(key, None)
        ended = turn.status in TURN_ENDED

        if anchor is None:
            anchor = await self._begin(
                items,
                turn,
                session_id=session_id,
                channel_id=channel_id,
                thread_root_id=thread_root_id,
                agent_name=agent_name,
                elapsed_seconds=elapsed_seconds,
            )
            if anchor is None:
                return False
            drawn = True
            if not ended:
                await self._claim_thread(key, anchor)
        else:
            drawn = await self._edit(
                anchor,
                items,
                turn,
                session_id=session_id,
                ended=ended,
                elapsed_seconds=elapsed_seconds,
            )

        if ended:
            await self._release_thread(key, anchor)
            return drawn
        self._anchors[key] = anchor
        await self._forget_the_oldest()
        return drawn

    async def _begin(
        self,
        items: list[Item],
        turn: TurnUpsert,
        *,
        session_id: str,
        channel_id: str,
        thread_root_id: str | None,
        agent_name: str,
        elapsed_seconds: float | None,
    ) -> _Anchor | None:
        """Post the turn where the caller put it: in a thread, or the channel
        root if there was nothing to thread under.

        The platform can refuse it, and then the channel is told rather than
        left with a turn that silently never appeared, and `None` says so to
        the caller.
        """
        try:
            posted = await self._adapter.post_rich(
                channel_id,
                agent_name,
                TurnActivity(items, turn, elapsed_seconds),
                thread_root_id,
            )
        except RichContentFailed as error:
            logger.error(
                "Could not post the activity for turn %s of session %s in "
                "channel %s: %s. The channel shows what the agent asked "
                "without what it did.",
                turn.turn_id,
                session_id,
                channel_id,
                error,
            )
            return None
        reaction_ref = thread_root_id
        if thread_root_id is not None and isinstance(self._adapter, SlackAdapter):
            reaction_ref = self._adapter.reaction_target(channel_id, thread_root_id)
        return _Anchor(
            channel_id=channel_id,
            message_ref=posted,
            thread_root_id=thread_root_id,
            reaction_ref=reaction_ref,
        )

    async def _edit(
        self,
        anchor: _Anchor,
        items: list[Item],
        turn: TurnUpsert,
        *,
        session_id: str,
        ended: bool,
        elapsed_seconds: float | None,
    ) -> bool:
        """Rewrite the posted message with the turn as it now stands."""
        try:
            await self._adapter.update_rich(
                anchor.channel_id,
                anchor.message_ref,
                TurnActivity(items, turn, elapsed_seconds),
            )
        except RichContentFailed as error:
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
            return False
        return True

    async def _claim_thread(self, key: tuple[str, str], anchor: _Anchor) -> None:
        """Add this turn to the set of turns holding the reaction on
        `anchor.reaction_ref`, switching it on only if this turn is the
        first to want it.

        Two turns can resolve to the same asking message — one addressed at
        the channel root threads under it, and another already running in
        that same thread shares it too — and the second must not find the
        reaction already there and skip it, nor the first's own end wipe it
        out from under the second.
        """
        if anchor.reaction_ref is None:
            return
        thread_key = (anchor.channel_id, anchor.reaction_ref)
        turns = self._thread_turns.setdefault(thread_key, set())
        first = not turns
        turns.add(key)
        if first:
            await self._mark_thread(anchor, working=True)

    async def _release_thread(self, key: tuple[str, str], anchor: _Anchor) -> None:
        """The inverse of `_claim_thread`: drop this turn from the holders of
        `anchor.reaction_ref`, switching the reaction off only once none are
        left — and doing nothing at all for a turn that never claimed it,
        which is what a turn published for the first time already ended
        does."""
        if anchor.reaction_ref is None:
            return
        thread_key = (anchor.channel_id, anchor.reaction_ref)
        turns = self._thread_turns.get(thread_key)
        if turns is None or key not in turns:
            return
        turns.discard(key)
        if not turns:
            del self._thread_turns[thread_key]
            await self._mark_thread(anchor, working=False)

    async def _mark_thread(self, anchor: _Anchor, *, working: bool) -> None:
        """Put `:eyes:` on the message that actually asked, or take it off.

        Not necessarily the thread root — a turn threaded under a reply deep
        in the thread reacts to that reply, resolved once by `_begin` and
        kept on the anchor as `reaction_ref` for exactly this. Slack only,
        and best effort: neither reacting nor removing a reaction is on the
        port, and losing one is not worth failing a turn's own draw over.
        """
        if anchor.reaction_ref is None or not isinstance(self._adapter, SlackAdapter):
            return
        try:
            await self._adapter.mark_activity(
                anchor.channel_id, anchor.reaction_ref, working=working
            )
        except Exception:
            logger.warning(
                "Could not %s the activity reaction on %s in %s.",
                "add" if working else "remove",
                anchor.reaction_ref,
                anchor.channel_id,
                exc_info=True,
            )

    async def _forget_the_oldest(self) -> None:
        """Keep the anchors bounded by dropping the least recently published.

        A turn that stops without ever saying so holds its anchor for the life
        of the process, and the ids come from outside, so without a bound this
        grows for as long as the bridge runs. Dropping one costs a reposted
        turn rather than a lost one, and it says which turn it will happen to
        — and, on Slack, a thread left showing `:eyes:` for a turn nothing
        here is tracking any more, since forgetting the anchor is the only
        record of where that reaction went.
        """
        while len(self._anchors) > _MAX_ANCHORS:
            key, anchor = self._anchors.popitem(last=False)
            session_id, turn_id = key
            logger.warning(
                "Holding activity anchors for more than %s turns, so turn %s of "
                "session %s is being forgotten: if it changes again it will be "
                "posted afresh rather than edited in place.",
                _MAX_ANCHORS,
                turn_id,
                session_id,
            )
            await self._release_thread(key, anchor)


class SessionRequestCards:
    """One bridge's posted request cards, as the requests behind them change."""

    def __init__(
        self,
        adapter: CollaborationAdapter,
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
        """Reserve the card durably, then send it to the platform.

        The reservation is committed before the platform call, not after: a
        process that dies or times out between the two leaves a row whose
        `external_post_id` still equals its own token, and that is what
        marks a card unconfirmed rather than missing. `recover` resolves one
        by searching the platform for it instead of risking a duplicate post,
        and an unconfirmed card answers nothing until it does — see the
        matching check in `command_for_text`.

        A reservation that fails outright (the platform refuses the post) is
        the other thing this must not leave behind: a handle held for a card
        nobody can see, so it is released and the caller told, rather than
        left for `recover` to find nothing.
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
            reference = RequestReference(token=post.token, handle=post.handle)
            await session.commit()
            try:
                ref = await self._adapter.post_rich(
                    channel_id,
                    agent_name,
                    RequestCard(request, reference),
                    thread_root_id,
                )
            except RichContentFailed as error:
                await session.delete(post)
                await session.commit()
                raise CardNotPosted(
                    f"Could not post the card for request {request.request_id} "
                    f"in channel {channel_id}: {error}. Nobody has been asked, "
                    f"and the handle {post.handle} was released."
                ) from error
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

        A redraw that lands is written back, because the row is what an answer
        stands against: `expectedRevision` comes off it, so a card showing
        revision 2 over a row still saying 1 collects answers the session then
        rejects as stale — and rejects them somewhere this bridge cannot tell
        the person about. A redraw that did not land is not written back: the
        channel is still showing the old card, so the old revision is the one
        that matches what anyone can actually read.

        The epoch is not touched. Nothing here has a new one, and a session that
        has changed epoch has invalidated every card it posted rather than moved
        them on — which is the publisher's to notice, not a redraw's.

        Re-raises after the reply is posted, so a caller polling for pending
        publications (`SessionPublisher`) sees the failure and retries rather
        than believing the redraw landed. The reply itself is sent once per
        distinct `(revision, state)` rather than on every retry, or a card
        stuck at the same state would get the same notice again every few
        seconds until something moves it on.
        """
        reference = RequestReference(token=post.token, handle=post.handle)
        try:
            await self._adapter.update_rich(
                post.external_channel_id,
                post.external_post_id,
                RequestCard(request, reference),
            )
        except RichContentFailed as error:
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
                    f"work.\n{error.text}",
                    post.external_post_id,
                )
                self._reported_edit_failures[post.token] = state
            raise
        self._reported_edit_failures.pop(post.token, None)
        await self._record(post, request)

    async def _record(self, post: SessionRequestPost, request: SnapshotRequest) -> None:
        """Bring the row up to the revision the card now shows.

        Read again rather than written through the instance handed in: that one
        belongs to whichever session posted the card, which is closed by now, so
        assigning to it would update nothing.
        """
        async with self._session_factory() as session:
            row = await self._posts.get_by_token(session, self._bridge_id, post.token)
            if row is None:
                logger.error(
                    "Redrew card %s for request %s at revision %s, but its record "
                    "is gone, so an answer to it now resolves to nothing.",
                    post.handle,
                    post.request_id,
                    request.revision,
                )
                return
            row.revision = request.revision
            row.form = posted_form(request)
            await session.commit()
