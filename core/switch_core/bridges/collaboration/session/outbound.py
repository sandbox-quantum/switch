"""Putting a session's state in a channel, and keeping it in step afterwards.

Two things go out, and each occupies one message that is kept in step rather
than reposted. A **request card** is something someone has to answer, so it
moves open → submitting → resolved or closed and the channel carries one
message per request rather than a running commentary. **Turn activity** is not
addressed to anyone — it is what the agent said and did, and it is read rather
than answered — but it changes for the same reason, so it gets the same
treatment: one message per turn, ending on the turn's final state, a Block Kit
message rewritten in place with the tool calls as the cards of a `plan` block.

Request cards and production activity messages have durable publication records.
Both can recover their existing platform messages after a bridge restart.

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
from contextvars import ContextVar
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.db.models import Client, ExternalUser, SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.sessions.contract import TURN_ENDED, Item, SnapshotRequest, TurnUpsert

from .activity_journal import ActivityJournal, ActivityRecord
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
    entirely: the one that actually asked, as the caller resolved it
    (`refresh_activity` reads it straight off the command's own `Origin`), and
    kept for as long as the anchor is — a thread can move on to a newer asker
    while this turn is still running, and re-reading that at release time
    would clear someone else's `:eyes:` instead of its own.
    """

    channel_id: str
    message_ref: str
    thread_root_id: str | None
    reaction_ref: str | None
    agent_name: str = ""
    log_ref: str | None = None
    log_state: tuple[tuple[str, int], ...] | None = None
    session_url: str | None = None
    status_state: tuple[str, str, str | None] | None = None


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
    """Publish SDK activity without exposing internal assistant narration.

    Slack keeps the live status separate from the collapsible tool log.
    When the turn ends, the log becomes the summary and the status is removed.

    Production publishers use a durable journal to recover message anchors
    and uncertain deliveries after a restart.
    """

    def __init__(
        self, adapter: CollaborationAdapter, *, journal: ActivityJournal | None = None
    ) -> None:
        self._journal = journal
        self._record: ContextVar[ActivityRecord | None] = ContextVar(
            "activity_record", default=None
        )
        self._adapter = adapter
        self._separate_activity_log = getattr(adapter, "separate_activity_log", False)
        self._separate_attention_slot = getattr(
            adapter, "separate_attention_slot", False
        )
        self._reactions_per_agent = getattr(
            adapter, "activity_reactions_per_agent", False
        )
        self._timer_redraws = getattr(adapter, "redraws_for_elapsed_time", False)
        self._only_mentions_notify = getattr(adapter, "notifies_only_by_mention", False)
        self._recovers_posts = getattr(adapter, "recovers_uncertain_posts", False)
        self._anchors: OrderedDict[tuple[str, str], _Anchor] = OrderedDict()
        self._thread_turns: dict[tuple[str, str, str], set[tuple[str, str]]] = {}
        self._attention: OrderedDict[tuple[str, str], tuple[str, str]] = OrderedDict()

    @property
    def durable(self) -> bool:
        return self._journal is not None

    @property
    def notifies_only_by_mention(self) -> bool:
        """Whether naming someone is the only way this platform reaches them.

        Read by the caller that resolves who to name, which is where the
        agent's owner is preferred to whoever started the turn and where an
        unreachable owner becomes something the post admits to.
        """
        return self._only_mentions_notify

    @property
    def renders_custom_url_schemes(self) -> bool:
        """Whether a `switchdash://` link is a link here at all.

        Read by the caller that builds the Console link, which is the only
        place that holds both the deeplink and the gateway's public URL to
        rewrite it against. False sends the browser redirect instead, because
        a platform that linkifies only http(s) shows the raw deeplink as text
        somebody would have to copy.
        """
        return bool(getattr(self._adapter, "renders_custom_url_schemes", True))

    @property
    def redraws_for_elapsed_time(self) -> bool:
        """Whether a running turn is worth redrawing for the clock alone.

        Read by the caller that decides how often to publish at all, so a
        platform that does not redraw for the clock is not asked to.
        """
        return self._timer_redraws

    def _status_state(
        self,
        turn: TurnUpsert,
        items: list[Item],
        elapsed_seconds: float | None,
        session_url: str | None,
    ) -> tuple[str, str, str | None]:
        """What the status message is already showing.

        Two publishes with the same answer would draw the same message, and
        the second is an edit nobody would see. The clock counts only where
        the platform redraws for it; elsewhere what the status shows is the
        turn's state and its tools, and the elapsed time goes out with the
        next change to either.
        """
        drawn = (
            f"{int(elapsed_seconds) if elapsed_seconds is not None else ''}"
            if self._timer_redraws
            else ",".join(f"{item.item_id}:{item.revision}" for item in items)
        )
        return (turn.turn_id, f"{turn.status}:{drawn}", session_url)

    async def recorded_commands(self, session_id: str) -> set[str]:
        return (
            await self._journal.recorded_commands(session_id)
            if self._journal
            else set()
        )

    async def publish(
        self,
        items: list[Item],
        turn: TurnUpsert,
        *,
        session_id: str,
        channel_id: str,
        thread_root_id: str | None,
        asked_on: str | None,
        agent_name: str,
        elapsed_seconds: float | None,
        session_url: str | None = None,
        notify_external_id: str | None = None,
        notify_unreachable: bool = False,
        error_summary: str | None = None,
    ) -> bool:
        async def attend() -> None:
            if self._separate_attention_slot:
                await self._refresh_attention(
                    session_id,
                    channel_id,
                    agent_name,
                    thread_root_id,
                    turn,
                    notify_external_id,
                    notify_unreachable,
                    error_summary,
                )

        async def draw() -> bool:
            try:
                drawn = await self._publish(
                    items,
                    turn,
                    session_id=session_id,
                    channel_id=channel_id,
                    thread_root_id=thread_root_id,
                    asked_on=asked_on,
                    agent_name=agent_name,
                    elapsed_seconds=elapsed_seconds,
                    session_url=session_url,
                )
            except CardNotPosted:
                # A status whose delivery cannot be resolved keeps its
                # reservation for good where the platform cannot search for it.
                # Attention is a message of its own and the only way this turn
                # has of saying something went wrong, so it goes out rather
                # than waiting behind a status nobody can settle.
                await attend()
                raise
            await attend()
            return drawn

        if self._journal is None:
            return await draw()
        key = (session_id, turn.command_id or turn.turn_id)
        async with self._journal.open(*key) as record:
            if record is None:
                return False
            if (
                record.data.get("completed")
                and record.data.get("turn_id") == turn.turn_id
            ):
                return True
            # A provisional delivery result is not the SDK turn's final state.
            # Reuse its receipt when that same command gains a real turn ID.
            if record.data.get("turn_id") != turn.turn_id:
                record.data.pop("completed", None)
                record.data.pop("ended", None)
            record.data["turn_id"] = turn.turn_id
            record.data["ended"] = turn.status in TURN_ENDED
            await record.save()
            token = self._record.set(record)
            try:
                saved = record.data.get("anchor")
                if saved:
                    anchor = _Anchor(**saved)
                    anchor.log_state = (
                        tuple(tuple(entry) for entry in saved["log_state"])
                        if saved.get("log_state") is not None
                        else None
                    )
                    if saved.get("status_state") is not None:
                        anchor.status_state = (
                            saved["status_state"][0],
                            saved["status_state"][1],
                            saved["status_state"][2],
                        )
                    self._anchors[key] = anchor
                    if turn.status in TURN_ENDED:
                        await self._release_thread(key, anchor)
                drawn = await draw()
                if drawn and turn.status in TURN_ENDED:
                    if not turn.turn_id.startswith("pending:"):
                        # Keep a small completion receipt to suppress replay, but
                        # discard delivery reservations and reaction/log anchors.
                        record.data = {"turn_id": turn.turn_id, "ended": True}
                    record.data["completed"] = True
                    await record.save()
                return drawn
            finally:
                self._record.reset(token)

    async def _refresh_attention(
        self,
        session_id: str,
        channel_id: str,
        agent_name: str,
        thread_root_id: str | None,
        turn: TurnUpsert,
        notify_external_id: str | None,
        notify_unreachable: bool,
        error_summary: str | None,
    ) -> None:
        """One attention reply per command; update it when the problem clears."""
        key = (session_id, turn.command_id or turn.turn_id)
        record = self._record.get()
        saved = record.data.get("attention", {}) if record else {}
        previous = self._attention.get(key)
        ref = saved.get("ref") if record else previous[0] if previous else None
        last_state = (
            record.data.get("attention_state")
            if record
            else previous[1]
            if previous
            else None
        )
        if not error_summary and not ref and not saved:
            return
        state = error_summary or turn.status
        if ref and state == last_state:
            return
        content = TurnActivity(
            [],
            turn,
            status_only=True,
            notify_unreachable=notify_unreachable,
            error_summary=error_summary,
        )
        if ref is None:
            # A post can notify followers; an edit cannot. The durable slot
            # also recovers a post whose response was lost before a restart.
            ref = await self._post_activity(
                channel_id,
                agent_name,
                replace(content, notify_external_id=notify_external_id),
                thread_root_id,
                "attention",
            )
            if saved:
                await self._adapter.update_rich(channel_id, agent_name, ref, content)
        else:
            await self._adapter.update_rich(channel_id, agent_name, ref, content)
        if record:
            record.data["attention_state"] = state
            await record.save()
        else:
            self._attention[key] = (ref, state)
            self._attention.move_to_end(key)
            while len(self._attention) > _MAX_ANCHORS:
                self._attention.popitem(last=False)

    async def _save_anchor(self, anchor: _Anchor) -> None:
        record = self._record.get()
        if record:
            record.data["anchor"] = asdict(anchor)
            await record.save()

    async def _post_activity(
        self,
        channel: str,
        agent: str,
        content: TurnActivity,
        thread: str | None,
        slot: str,
    ) -> str:
        record = self._record.get()
        if record is None:
            return await self._adapter.post_rich(channel, agent, content, thread)
        delivery = record.data.get(slot)
        if delivery:
            saved_ref = delivery.get("ref")
            if saved_ref:
                if not isinstance(saved_ref, str):
                    raise ValueError(
                        "Activity journal message reference must be a string."
                    )
                return saved_ref
            if not self._recovers_posts:
                # The send may well have landed; nothing here can find out.
                # Posting again on every cycle would put one unwanted copy in
                # the chat per cycle, so the reservation is kept and this slot
                # stays as it is. The attention message is published
                # separately and is not held up by it.
                raise CardNotPosted(
                    f"The {slot} message sent as {delivery['token']} in "
                    f"{delivery['channel']} was never acknowledged, and this "
                    "platform cannot search for it. Keeping its reservation "
                    "rather than posting a second one that may duplicate it."
                )
            ref = await self._adapter.find_request_card(
                delivery["channel"],
                delivery["thread"],
                delivery["token"],
                datetime.fromisoformat(delivery["created_at"]),
                None,
            )
            if ref is None:
                raise CardNotPosted(
                    "Activity delivery is unconfirmed; retaining its reservation and retrying lookup."
                )
        else:
            delivery = {
                "token": secrets.token_urlsafe(16),
                "channel": channel,
                "thread": thread,
                "created_at": datetime.now(UTC).isoformat(),
            }
            record.data[slot] = delivery
            await record.save()
            try:
                ref = await self._adapter.post_rich(
                    channel,
                    agent,
                    replace(content, publication_token=delivery["token"]),
                    thread,
                )
            except RichContentThrottled:
                del record.data[slot]
                await record.save()
                raise
            except RichContentFailed:
                # The adapter explicitly refused the post. Transport timeouts
                # propagate separately and keep their uncertain reservation.
                del record.data[slot]
                await record.save()
                raise
        delivery["ref"] = ref
        record.data[slot] = delivery
        await record.save()
        return ref

    async def _publish(
        self,
        items: list[Item],
        turn: TurnUpsert,
        *,
        session_id: str,
        channel_id: str,
        thread_root_id: str | None,
        asked_on: str | None,
        agent_name: str,
        elapsed_seconds: float | None,
        session_url: str | None = None,
    ) -> bool:
        """Draw the turn where it already is, or where it is not yet.

        `asked_on` is the message the `:eyes:` reaction goes on, which is not
        necessarily `thread_root_id`: a command answered inside an existing
        thread threads under that thread's root, but the message that
        actually asked is the reply itself. The caller resolves it once, off
        the command's own `Origin` (`refresh_activity`), and it is carried
        through rather than re-derived here from whatever the thread looks
        like by the time this runs.

        Logged rather than raised, unlike a card that cannot be posted: nobody
        is waiting on this to answer anything, so the session is no worse off
        than it was before the contract existed and whatever asked for it can
        get on with the part that someone is waiting for. The return value is
        for a caller that retries on its own schedule and needs to know
        whether *this* call actually landed rather than just not raising —
        `False` on any refusal along the way, so it knows not to treat a
        refusal as the turn's current state having been shown.

        Retain anchors until the final summary edit succeeds.
        A failed final publication retries the same messages instead of posting
        duplicate history. The journal retains them across process restarts.
        """
        # The SDK transcript includes internal narration such as "Answered in
        # the room". Activity is a tool log; the actual reply is delivered separately.
        items = [item for item in items if item.kind == "tool-activity"]
        # Reuse the receipt message when an accepted command gains an SDK turn ID.
        key = (session_id, turn.command_id or turn.turn_id)
        anchor = self._anchors.get(key)
        ended = turn.status in TURN_ENDED

        if anchor is None:
            anchor = await self._begin(
                items,
                turn,
                session_id=session_id,
                channel_id=channel_id,
                thread_root_id=thread_root_id,
                asked_on=asked_on,
                agent_name=agent_name,
                elapsed_seconds=elapsed_seconds,
                session_url=session_url,
            )
            if anchor is None:
                return False
            self._anchors[key] = anchor
            await self._save_anchor(anchor)
            if not ended:
                await self._claim_thread(key, anchor)
            drawn = (
                await self._edit(
                    anchor,
                    items,
                    turn,
                    session_id=session_id,
                    ended=ended,
                    elapsed_seconds=elapsed_seconds,
                )
                if self._journal
                else True
            )
        else:
            anchor.session_url = session_url
            if not ended:
                await self._claim_thread(key, anchor)
            drawn = await self._edit(
                anchor,
                items,
                turn,
                session_id=session_id,
                ended=ended,
                elapsed_seconds=elapsed_seconds,
            )

        if self._separate_activity_log:
            drawn = await self._draw_log(anchor, items, turn) and drawn
            await self._save_anchor(anchor)
        if ended:
            record = self._record.get()
            if record and drawn:
                record.data["ended"] = True
                await record.save()
            drawn = await self._release_thread(key, anchor) and drawn
            if not drawn or turn.turn_id.startswith("pending:"):
                self._anchors[key] = anchor
                self._anchors.move_to_end(key)
                await self._forget_the_oldest()
            else:
                self._anchors.pop(key, None)
            return drawn
        self._anchors[key] = anchor
        self._anchors.move_to_end(key)
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
        asked_on: str | None,
        agent_name: str,
        elapsed_seconds: float | None,
        session_url: str | None = None,
    ) -> _Anchor | None:
        """Post the turn where the caller put it: in a thread, or the channel
        root if there was nothing to thread under.

        The platform can refuse it, and then the channel is told rather than
        left with a turn that silently never appeared, and `None` says so to
        the caller.

        Runs once per turn, which is why the "agent has started" nudge belongs
        here: an anchor that already exists is a turn already announced, and a
        platform told again on every redraw would show the agent as typing for
        as long as it ran.
        """
        if turn.status not in TURN_ENDED:
            await self._adapter.notify_working(
                channel_id,
                agent_name,
                # The asking message and the thread the status goes into are
                # the same message exactly when the command was addressed at
                # the channel root — the turn threads under what was said. So
                # whoever is waiting is watching the root, not a thread they
                # have not opened; anything else means they are watching the
                # thread the command came from.
                None if asked_on == thread_root_id else thread_root_id,
            )
        try:
            posted = await self._post_activity(
                channel_id,
                agent_name,
                TurnActivity(
                    items,
                    turn,
                    elapsed_seconds,
                    status_only=self._separate_activity_log,
                    session_url=session_url,
                ),
                thread_root_id,
                "status",
            )
        except RichContentThrottled:
            raise
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
        return _Anchor(
            channel_id=channel_id,
            message_ref=posted,
            thread_root_id=thread_root_id,
            reaction_ref=asked_on,
            agent_name=agent_name,
            session_url=session_url,
            status_state=self._status_state(turn, items, elapsed_seconds, session_url)
            if self._journal is None
            else None,
            log_state=tuple((item.item_id, item.revision) for item in items)
            + ((turn.status, 0),),
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
        state = self._status_state(turn, items, elapsed_seconds, anchor.session_url)
        if not ended and anchor.status_state == state:
            # Nothing this message shows has changed. Where the status is a
            # line of its own, tool-only changes belong to the separate log;
            # where it is the turn's one post, a clock that has moved on its
            # own is not a change a reader wanted the post rewritten for.
            return True
        try:
            await self._adapter.update_rich(
                anchor.channel_id,
                anchor.agent_name,
                anchor.message_ref,
                TurnActivity(
                    items,
                    turn,
                    elapsed_seconds,
                    status_only=self._separate_activity_log,
                    session_url=anchor.session_url,
                ),
            )
        except RichContentThrottled:
            raise
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
        if not ended:
            anchor.status_state = state
        return True

    async def _draw_log(
        self, anchor: _Anchor, items: list[Item], turn: TurnUpsert
    ) -> bool:
        # Reserve the second reply before requests arrive, even before the first tool.
        state = tuple((item.item_id, item.revision) for item in items) + (
            (turn.status, 0),
        )
        if state == anchor.log_state and anchor.log_ref:
            return True
        content = TurnActivity(items, turn, tool_log=True)
        try:
            if anchor.log_ref is None:
                anchor.log_ref = await self._post_activity(
                    anchor.channel_id,
                    anchor.agent_name,
                    content,
                    anchor.thread_root_id,
                    "log",
                )
            else:
                await self._adapter.update_rich(
                    anchor.channel_id, anchor.agent_name, anchor.log_ref, content
                )
        except RichContentThrottled:
            raise
        except RichContentFailed:
            logger.exception("Could not update tool log for turn %s", turn.turn_id)
            return False
        anchor.log_state = state
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
        turns = self._thread_turns.setdefault(self._thread_key(anchor), set())
        first = not turns
        if not first or await self._mark_thread(anchor, working=True):
            turns.add(key)

    async def _release_thread(self, key: tuple[str, str], anchor: _Anchor) -> bool:
        """The inverse of `_claim_thread`: drop this turn from the holders of
        `anchor.reaction_ref`, switching the reaction off once none are left.

        A turn that never claimed it still reaches this — published already
        ended, or one whose claim this process never recorded at all (a
        restart loses `_thread_turns` along with everything else this class
        holds only in memory). Either way the rule is the same: touch the
        reaction only when nothing else here is holding it. A claim by
        another live turn must survive this turn's own end, so that check
        comes first; a turn that was never tracked, with nobody else holding
        the ref either, still asks `_mark_thread` to take it off — a genuine
        no-op if there was truly never anything to remove, since
        `_mark_being_read` already will not act against its own record of
        having nothing there.
        """
        if anchor.reaction_ref is None:
            return True
        thread_key = self._thread_key(anchor)
        turns = self._thread_turns.get(thread_key)
        if turns is not None:
            turns.discard(key)
            if turns:
                return True
            del self._thread_turns[thread_key]
        record = self._record.get()
        if self._journal and await self._journal.reaction_held(
            key,
            anchor.channel_id,
            anchor.reaction_ref,
            agent_name=anchor.agent_name if self._reactions_per_agent else None,
            sessions=record.sessions if record else self._journal.sessions,
        ):
            return True
        return await self._mark_thread(anchor, working=False)

    def _thread_key(self, anchor: _Anchor) -> tuple[str, str, str]:
        """Who is holding what, keyed by whose reaction it actually is.

        Where each agent reacts as its own bot the marks are independent, so
        one agent finishing must not read another's claim as its own and leave
        its own eyes on the message for good. Where every agent shares a bot
        there is one reaction between them, and scoping the key per agent
        would have the second agent's claim try to add a reaction that is
        already there and the first agent's end remove one the second still
        wants.
        """
        agent = anchor.agent_name if self._reactions_per_agent else ""
        return (anchor.channel_id, anchor.reaction_ref or "", agent)

    async def _mark_thread(self, anchor: _Anchor, *, working: bool) -> bool:
        """Put `:eyes:` on the message that actually asked, or take it off.

        Not necessarily the thread root — a turn threaded under a reply deep
        in the thread reacts to that reply, resolved once by `_begin` and
        kept on the anchor as `reaction_ref` for exactly this. Adapter-owned
        and best effort: errors do not interrupt rendering. Return whether it worked so
        callers can retry a failed claim or unfinished terminal cleanup.
        """
        if anchor.reaction_ref is None or not getattr(
            self._adapter, "supports_activity_reactions", False
        ):
            return True
        try:
            await self._adapter.mark_activity(
                anchor.channel_id,
                anchor.reaction_ref,
                agent_name=anchor.agent_name,
                working=working,
                **({"force": True} if self._journal else {}),
            )
            return True
        except Exception:
            logger.warning(
                "Could not %s the activity reaction on %s in %s.",
                "add" if working else "remove",
                anchor.reaction_ref,
                anchor.channel_id,
                exc_info=True,
            )
            return False

    async def _forget_the_oldest(self) -> None:
        """Bound the in-memory cache, retaining durable message references.

        Production publishers reload evicted anchors from the journal. Only
        the demo path loses an anchor when it is evicted.
        """
        while len(self._anchors) > _MAX_ANCHORS:
            key, anchor = self._anchors.popitem(last=False)
            session_id, turn_id = key
            logger.warning(
                "Evicting activity cache entry after %s turns: turn %s of session %s. "
                "Durable publishers retain the message references in the journal.",
                _MAX_ANCHORS,
                turn_id,
                session_id,
            )
            if self._journal is None:
                await self._release_thread(key, anchor)


class SessionRequestCards:
    """One bridge's posted request cards, as the requests behind them change."""

    def __init__(
        self,
        adapter: CollaborationAdapter,
        *,
        bridge_id: str,
        surface: str,
        posts: SessionRequestPostStore,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._adapter = adapter
        self._bridge_id = bridge_id
        self._surface = surface
        self._posts = posts
        self._session_factory = session_factory
        self._reported_edit_failures: dict[str, tuple[int, str]] = {}

    @property
    def surface(self) -> str:
        """Which platform these cards are posted on.

        Read by the publisher rather than passed to it separately: the cards
        and the activity it drives are one bridge's, and two places to say
        which one is two places to say it differently.
        """
        return self._surface

    @property
    def notifies_only_by_mention(self) -> bool:
        """Whether naming someone is the only way this platform reaches them.

        Read where a card's one notification is resolved, for the same reason
        `SessionTurnActivity` exposes it: the agent's owner leads on a
        platform where an unnamed reader is an unnotified one.
        """
        return bool(getattr(self._adapter, "notifies_only_by_mention", False))

    @property
    def renders_custom_url_schemes(self) -> bool:
        """Whether this platform makes a `switchdash://` link clickable.

        Read where a Console link is put in front of someone, for the same
        reason `SessionTurnActivity` reads it: where it is False the link has
        to be rewritten as the gateway's https redirect or it is dead text.
        """
        return bool(getattr(self._adapter, "renders_custom_url_schemes", True))

    @property
    def recovers_uncertain_posts(self) -> bool:
        """Whether a card whose send was never acknowledged can be found again.

        Where it is False there is nothing to wait for: the publisher stops
        searching and discloses the card as unanswerable in the channel rather
        than re-asking a question the platform cannot answer.
        """
        return bool(getattr(self._adapter, "recovers_uncertain_posts", False))

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
        unavailable_reason: str | None = None,
        notify_external_id: str | None = None,
        notify_unreachable: bool = False,
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
                    RequestCard(
                        request,
                        reference,
                        unavailable_reason=unavailable_reason,
                        notify_external_id=notify_external_id,
                        notify_unreachable=notify_unreachable,
                    ),
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
            post.external_channel_id,
            post.thread_id,
            post.token,
            post.created_at,
            post.handle,
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

    async def disclose_unconfirmed(
        self, post: SessionRequestPost, *, console_url: str | None
    ) -> None:
        """Say in the channel that this card cannot be answered there.

        For the platform that cannot search its own history, an unconfirmed
        delivery never resolves: the card may be sitting in the chat asking a
        question, and `command_for_text` refuses every typed answer to it
        because nothing can prove the card exists. Left alone that is the worst
        of the failure modes — it looks like it is working. So the channel is
        told once, in a separate message, and pointed at Console, which can
        answer the request without needing the card at all.

        Exactly one attempt is ever made, and the row records it before the
        message is sent rather than after. A second notice would say nothing
        the first did not, and this is reached on every publication cycle for
        as long as the request stays open — so the durable mark has to be in
        place before anything can go wrong, even at the cost of losing the
        notice entirely if this process dies mid-send.

        The reservation itself is kept. It is what stops the card being posted
        a second time, and the handle it holds is the one printed on whatever
        did arrive.
        """
        async with self._session_factory() as session:
            stored = await session.get(
                SessionRequestPost, post.id, with_for_update=True
            )
            if stored is None or stored.unconfirmed_notice_at is not None:
                return
            stored.unconfirmed_notice_at = datetime.now(UTC)
            await session.commit()
        console = (
            f"[Switch Console]({console_url})" if console_url else "Switch Console"
        )
        sent = await self._adapter.admin_message(
            post.external_channel_id,
            f"Switch could not confirm that request **{post.handle}** reached "
            "this chat. If a card for it is here, answering it here will not "
            f"work — answer it in {console} instead.",
            post.thread_id,
        )
        if sent is None:
            logger.error(
                "Could not tell channel %s that card %s was never confirmed. The "
                "request can still be answered in Console, but nothing in the "
                "channel says so, and this is not attempted again.",
                post.external_channel_id,
                post.handle,
            )

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

    async def refresh(
        self,
        post: SessionRequestPost,
        request: SnapshotRequest,
        *,
        agent_name: str,
        unavailable_reason: str | None = None,
    ) -> None:
        """Redraw the card for `request` where it was posted.

        `agent_name` is the agent whose session asked, the same name the card
        was posted under. A platform that writes the name into the body needs
        it again to redraw the card as the same agent, and the row does not
        carry it: the session does, and every caller here has the session.

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
        # Only an answer given on this very platform has a handle this channel
        # would recognise. Someone who answered from the console may well have
        # a claimed identity here too, but naming them by it would say they
        # answered where they did not.
        responder_external_id = None
        if request.decided_by and request.decided_by.surface == self._surface:
            async with self._session_factory() as db:
                responder_external_id = await db.scalar(
                    select(ExternalUser.external_user_id)
                    .join(Client, Client.id == ExternalUser.client_id)
                    .where(
                        ExternalUser.bridge_id == self._bridge_id,
                        Client.matrix_user_id == request.decided_by.actor_id,
                    )
                )
        try:
            await self._adapter.update_rich(
                post.external_channel_id,
                agent_name,
                post.external_post_id,
                RequestCard(
                    request,
                    reference,
                    responder_external_id=responder_external_id,
                    unavailable_reason=unavailable_reason,
                ),
            )
        except RichContentThrottled:
            raise
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
