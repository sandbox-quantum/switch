"""Puts session activity and requests on one bridge's platform.

Pushed, not scanned: `SessionActivityListener` hands every change for the
bridge's tenant to `_on_change`, which only queues a key. A task of this
bridge's own drains the queue and does the platform work, so a slow or rate
limited platform never holds up the listener's other subscribers.

A key queued while the same key is still waiting is dropped, and each key is
handled by reading the rows as they are now. So a burst of steps in one turn
costs one redraw rather than one per step, and a request answered before its
card was posted is posted already answered — or, if it is no longer open, not
at all.

**Requests** (approvals and questions). The card lives in
`approval_request_posts`: `token` rides in the controls and `handle` (`A<n>`)
is what a person types. The reservation is committed before the platform call,
with `external_post_id` null, so a process that dies mid-post leaves a card
marked unconfirmed rather than one posted twice; the card is then searched for
where the platform can be searched, and the channel told once where it cannot
and the platform may say so. An approval answered by a person is taken off a
platform that removes answered cards.

**Turns.** Each turn is drawn in one message, from its rows, with the adapter's
own activity rendering: every step, the stop control while it runs, and how
long it took. The asking message carries a queued or working marker while the
turn waits or runs, and a platform that says a turn is stuck in a message of
its own gets one, cleared again once it no longer applies. All of it sits in
`turn_status_posts`.

Failures of a key are retried on a widening interval; a platform that asks for
a wait gets exactly that wait.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Literal, cast

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
    ActivitySnapshot,
    CollaborationAdapter,
    RemovalFailed,
    RichContentFailed,
    RichContentThrottled,
    RichContentWedged,
    ThreadUnavailable,
    TurnActivity,
)
from switch_core.db.models import (
    Agent,
    ApprovalRequest,
    ApprovalRequestPost,
    BridgeMessageMap,
    Message,
    Room,
    SessionActivityItem,
    TurnStatusPost,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.session_activity_post_store import (
    ApprovalRequestPostStore,
    TurnStatusPostStore,
)
from switch_core.db.stores.session_activity_store import (
    TURN_ITEM_ID,
    ApprovalRequestStore,
    SessionActivityStore,
)
from switch_core.deeplinks import deeplink_for_platform
from switch_core.session_activity.bridge_turns import (
    TurnView,
    status_state,
    turn_view,
)
from switch_core.session_activity.cards import (
    answerer_of,
    approval_card,
    approval_request,
)
from switch_core.session_activity.listener import Change, SessionActivityListener
from switch_core.sessions.contract import DecidedBy, decided
from switch_core.sessions.presentation import (
    activity_error_summary,
    notification_recipient,
    session_console_url,
)

logger = logging.getLogger(__name__)

HANDLE_PREFIX = "A"
_MINT_ATTEMPTS = 5
_HANDLE_CONSTRAINT = "uq_approval_request_posts_handle"
# An inbound message and the card answering it can race: the platform post a
# thread hangs off is mapped only once the inbound relay commits. Waited out a
# few times before the card goes to the channel root instead.
_THREAD_WAIT_SECONDS = 1.0
_THREAD_WAIT_ATTEMPTS = 5
# How far back a resync redraws settled cards and ended turns. A resync means
# announcements may have been lost; one lost a while ago has had its message
# corrected by a later resync already, and redrawing everything on each start
# would spend a platform's rate budget on messages nobody is looking at.
_RESYNC_WINDOW = timedelta(minutes=15)
# How often running turns are looked at again: for the clock, where the
# platform redraws for it, and for their agent going offline or coming back.
_TICK_SECONDS = 5.0
_RETRY_MIN_SECONDS = 5.0
_RETRY_MAX_SECONDS = 600.0
# How many turns' drawn state one bridge remembers. Forgetting one costs a
# redraw nobody needed if that turn changes again, not a wrong one.
_MAX_REMEMBERED_TURNS = 4096
# A card that froze in the last hour is plausibly still on someone's screen and
# misleading them; under an older one a notice reaches nobody.
_WEDGE_NOTICE_MAX_AGE = timedelta(hours=1)
_WEDGE_NOTICE = (
    "⚠️ This platform dropped the live stream behind the message above, so that "
    "card is frozen and cannot be updated, finished, or removed. Whatever it is "
    "showing is the last thing the stream wrote, not where the turn got to — "
    "the turn itself was unaffected."
)
_HOST_OFFLINE = "Host offline. Answers are unavailable until the session reconnects."

Mark = Literal["queued", "working"]


@dataclass(frozen=True)
class _Target:
    channel_id: str
    thread_ref: str | None
    agent: Agent

    @property
    def agent_name(self) -> str:
        return self.agent.name


@dataclass(frozen=True)
class StopTarget:
    """What a Stop control on one of this bridge's messages would stop."""

    agent_id: str
    session_id: str
    room_id: str
    thread_id: str | None
    # The session's running turn now, which the pressed control must still name.
    running_turn_id: str | None


@dataclass
class _TurnDrawn:
    """What this process last showed of a turn, so an unchanged redraw is skipped."""

    status_state: str | None = None
    attention_state: str | None = None
    status: str | None = None
    final: bool = False
    wedged: bool = False


@dataclass
class _Backoff:
    """A key's waits between failed attempts: doubling, capped, cleared on success."""

    waits: dict[tuple[str, ...], float] = field(default_factory=dict)

    def next(self, key: tuple[str, ...]) -> float:
        wait = self.waits.get(key, _RETRY_MIN_SECONDS)
        self.waits[key] = min(wait * 2, _RETRY_MAX_SECONDS)
        return wait

    def clear(self, key: tuple[str, ...]) -> None:
        self.waits.pop(key, None)


class _ThreadNotMappedYet(Exception):
    pass


_Key = tuple[str, ...]
_RESYNC: _Key = ("resync",)


class SessionActivityBridgePublisher:
    def __init__(
        self,
        *,
        adapter: CollaborationAdapter,
        bridge_id: str,
        bridge_type: str,
        tenant_id: str,
        listener: SessionActivityListener,
        session_factory: async_sessionmaker[AsyncSession],
        agent_online: Callable[[str], bool],
        gateway_public_url: str | None,
    ) -> None:
        self._adapter = adapter
        self._bridge_id = bridge_id
        self._bridge_type = bridge_type
        self._tenant_id = tenant_id
        self._listener = listener
        self._sessions = session_factory
        self._agent_online = agent_online
        self._gateway_public_url = gateway_public_url
        self._approvals = ApprovalRequestStore()
        self._rooms = RoomStore()
        self._activity = SessionActivityStore()
        self._card_posts = ApprovalRequestPostStore()
        self._turn_posts = TurnStatusPostStore()
        self._queue: asyncio.Queue[_Key] = asyncio.Queue()
        self._pending: set[_Key] = set()
        self._thread_waits: dict[_Key, int] = {}
        self._retries = _Backoff()
        self._drawn: OrderedDict[_Key, _TurnDrawn] = OrderedDict()
        self._live_turns: dict[_Key, str] = {}
        self._open_cards: dict[_Key, str] = {}
        self._online_seen: dict[str, bool] = {}
        self._unsure_marks: set[_Key] = set()
        self._card_edit_failures: dict[str, tuple[str, str | None]] = {}
        self._noted_unconfirmed: set[str] = set()
        self._tasks: list[asyncio.Task[None]] = []
        self._unsubscribe: Callable[[], None] | None = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._tasks:
            raise RuntimeError("SessionActivityBridgePublisher is already started")
        self._unsubscribe = self._listener.subscribe(
            self._tenant_id, self._on_change, self._on_resync
        )
        self._tasks = [
            asyncio.create_task(
                self._run(), name=f"session-activity-bridge-{self._bridge_id}"
            ),
            asyncio.create_task(
                self._tick_forever(),
                name=f"session-activity-bridge-tick-{self._bridge_id}",
            ),
        ]
        # The listener resyncs its subscribers when it connects, which may have
        # happened before this bridge started.
        self._enqueue(_RESYNC)

    async def stop(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []

    # ── Listener callbacks: queue only ────────────────────────────────────────

    async def _on_change(self, change: Change) -> None:
        if change.kind.startswith("approval."):
            self._enqueue(("approval", change.agent_id, change.session_id, change.key))
        elif change.kind == "activity":
            self._enqueue(("turn", change.agent_id, change.session_id, change.key))

    async def _on_resync(self) -> None:
        self._enqueue(_RESYNC)

    def _enqueue(self, key: _Key) -> None:
        if key in self._pending:
            return
        self._pending.add(key)
        self._queue.put_nowait(key)

    def _enqueue_later(self, key: _Key, delay: float) -> None:
        asyncio.get_running_loop().call_later(delay, self._enqueue, key)

    def _retry_later(self, key: _Key) -> None:
        self._enqueue_later(key, self._retries.next(key))

    # ── The bridge's own tasks ────────────────────────────────────────────────

    async def _run(self) -> None:
        while True:
            key = await self._queue.get()
            self._pending.discard(key)
            try:
                await self._handle(key)
            except asyncio.CancelledError:
                raise
            except RichContentThrottled as throttled:
                logger.warning(
                    "%s asked bridge %s to wait %.1fs; retrying %s then.",
                    self._adapter.platform_name,
                    self._bridge_id,
                    throttled.retry_after,
                    key,
                )
                self._enqueue_later(key, throttled.retry_after)
            except _ThreadNotMappedYet:
                self._enqueue_later(key, _THREAD_WAIT_SECONDS)
            except Exception:
                # The delivery loop: one key failing must not stop the rest.
                delay = self._retries.next(key)
                logger.exception(
                    "Could not publish %s on bridge %s; trying again in %.0fs.",
                    key,
                    self._bridge_id,
                    delay,
                )
                self._enqueue_later(key, delay)

    async def _tick_forever(self) -> None:
        while True:
            await asyncio.sleep(_TICK_SECONDS)
            clock = self._adapter.redraws_for_elapsed_time
            for keys in (self._live_turns, self._open_cards):
                for key, agent_id in list(keys.items()):
                    moved = self._online_seen.get(agent_id) != self._agent_online(
                        agent_id
                    )
                    if moved or (clock and keys is self._live_turns):
                        self._enqueue(key)

    async def _handle(self, key: _Key) -> None:
        kind = key[0]
        if kind == "resync":
            await self._resync()
        elif kind == "approval":
            await self._publish_approval(key, key[1], key[2], key[3])
        elif kind == "turn":
            await self._publish_turn(key, key[1], key[2], key[3])
        else:
            raise ValueError(f"Unknown publication key {key!r}")

    async def _resync(self) -> None:
        since = datetime.now(UTC) - _RESYNC_WINDOW
        async with tenant_session(self._sessions, self._tenant_id) as db:
            posted = exists().where(
                ApprovalRequestPost.bridge_id == self._bridge_id,
                ApprovalRequestPost.agent_id == ApprovalRequest.agent_id,
                ApprovalRequestPost.session_id == ApprovalRequest.session_id,
                ApprovalRequestPost.request_id == ApprovalRequest.request_id,
            )
            requests = (
                await db.execute(
                    select(
                        ApprovalRequest.agent_id,
                        ApprovalRequest.session_id,
                        ApprovalRequest.request_id,
                    )
                    .join(Room, Room.id == ApprovalRequest.room_id)
                    .where(
                        Room.bridge_id == self._bridge_id,
                        or_(
                            ApprovalRequest.state == "open",
                            and_(ApprovalRequest.updated_at >= since, posted),
                        ),
                    )
                )
            ).all()
            unended = and_(
                SessionActivityItem.item_id == TURN_ITEM_ID,
                SessionActivityItem.status.in_(("queued", "running")),
            )
            turns = (
                await db.execute(
                    select(
                        SessionActivityItem.agent_id,
                        SessionActivityItem.session_id,
                        SessionActivityItem.turn_id,
                        func.max(SessionActivityItem.updated_at),
                        func.bool_or(unended),
                        TurnStatusPost.updated_at,
                    )
                    .join(Room, Room.id == SessionActivityItem.room_id)
                    .outerjoin(
                        TurnStatusPost,
                        and_(
                            TurnStatusPost.bridge_id == self._bridge_id,
                            TurnStatusPost.agent_id == SessionActivityItem.agent_id,
                            TurnStatusPost.session_id == SessionActivityItem.session_id,
                            TurnStatusPost.turn_id == SessionActivityItem.turn_id,
                        ),
                    )
                    .where(
                        Room.bridge_id == self._bridge_id,
                        or_(SessionActivityItem.updated_at >= since, unended),
                    )
                    .group_by(
                        SessionActivityItem.agent_id,
                        SessionActivityItem.session_id,
                        SessionActivityItem.turn_id,
                        TurnStatusPost.updated_at,
                    )
                )
            ).all()
            marked = await self._turn_posts.marked(db, self._bridge_id)
        for agent_id, session_id, request_id in requests:
            self._enqueue(("approval", agent_id, session_id, request_id))
        for agent_id, session_id, turn_id, changed, running, drawn_at in turns:
            # An ended turn whose message was last drawn after its last change
            # already shows how it ended.
            if running or drawn_at is None or drawn_at < changed:
                self._enqueue(("turn", agent_id, session_id, turn_id))
        for post in marked:
            self._enqueue(("turn", post.agent_id, post.session_id, post.turn_id))

    # ── Where a room's publications go ────────────────────────────────────────

    async def _target(
        self,
        db: AsyncSession,
        key: _Key,
        agent_id: str,
        room_id: str,
        thread_id: str | None,
    ) -> _Target | None:
        """The channel and thread for a room on this bridge, or None if it is not on it."""
        found = await self._rooms.get_with_membership(db, room_id, agent_id)
        if found is None or found[0].bridge_id != self._bridge_id:
            return None
        room, member = found
        if not room.external_channel_id:
            logger.warning(
                "Room %s is on bridge %s but has no channel; nothing is published there.",
                room_id,
                self._bridge_id,
            )
            return None
        agent = await db.get(Agent, agent_id)
        if agent is None:
            return None
        if not member:
            logger.warning(
                "Not publishing for agent %s in room %s: it is no longer a member.",
                agent.name,
                room_id,
            )
            return None
        return _Target(
            channel_id=room.external_channel_id,
            thread_ref=await self._thread_ref(
                db, key, room.external_channel_id, thread_id
            ),
            agent=agent,
        )

    async def _platform_ref(
        self, db: AsyncSession, channel_id: str, switch_id: str | None
    ) -> str | None:
        """The platform's post for a Switch message in this channel, if it has one."""
        if switch_id is None:
            return None
        external_post_id: str | None = await db.scalar(
            select(BridgeMessageMap.external_post_id).where(
                BridgeMessageMap.bridge_id == self._bridge_id,
                BridgeMessageMap.external_channel_id == channel_id,
                BridgeMessageMap.transport_event_id == switch_id,
            )
        )
        return external_post_id

    async def _thread_ref(
        self, db: AsyncSession, key: _Key, channel_id: str, thread_id: str | None
    ) -> str | None:
        if thread_id is None:
            return None
        external_post_id = await self._platform_ref(db, channel_id, thread_id)
        if external_post_id is not None:
            self._thread_waits.pop(key, None)
            return external_post_id
        waited = self._thread_waits.get(key, 0)
        if waited < _THREAD_WAIT_ATTEMPTS:
            self._thread_waits[key] = waited + 1
            raise _ThreadNotMappedYet(thread_id)
        self._thread_waits.pop(key, None)
        logger.warning(
            "Switch message %s has no post in channel %s on bridge %s; "
            "publishing %s at the channel root instead of in its thread.",
            thread_id,
            channel_id,
            self._bridge_id,
            key,
        )
        return None

    def _session_url(self, agent_id: str, room_id: str, session_id: str) -> str | None:
        return deeplink_for_platform(
            session_console_url(
                self._gateway_public_url, agent_id, room_id, session_id
            ),
            self._gateway_public_url,
            self._adapter.renders_custom_url_schemes,
        )

    async def _recipient(
        self,
        db: AsyncSession,
        room_id: str,
        agent: Agent,
        turn_row: SessionActivityItem | None,
        thread_ref: str | None,
    ) -> str | None:
        """Who a post asking someone to act names: whoever asked, else the owner."""
        actor_id: str | None = None
        if turn_row is not None and turn_row.message_id is not None:
            actor_id = await db.scalar(
                select(Message.sender_id).where(
                    Message.transport_event_id == turn_row.message_id
                )
            )
        return await notification_recipient(
            db,
            bridge_id=self._bridge_id,
            room_id=room_id,
            surface=self._bridge_type,
            actor_id=actor_id,
            agent=agent,
            thread_id=thread_ref,
        )

    async def _turn_row(
        self, db: AsyncSession, agent_id: str, session_id: str, turn_id: str
    ) -> SessionActivityItem | None:
        return await db.get(
            SessionActivityItem,
            (self._tenant_id, agent_id, session_id, turn_id, TURN_ITEM_ID),
        )

    # ── Request cards ─────────────────────────────────────────────────────────

    async def _publish_approval(
        self, key: _Key, agent_id: str, session_id: str, request_id: str
    ) -> None:
        async with tenant_session(self._sessions, self._tenant_id) as db:
            row = await self._approvals.get(
                db, agent_id, session_id, request_id, for_update=False
            )
            if row is None or row.room_id is None:
                self._open_cards.pop(key, None)
                return
            post = await self._card_posts.get(
                db, self._bridge_id, agent_id, session_id, request_id, for_update=False
            )
            if (post is None and row.state != "open") or (
                post is not None and post.removed_at is not None
            ):
                self._open_cards.pop(key, None)
                return
            target = await self._target(db, key, agent_id, row.room_id, row.thread_id)
            if target is None:
                self._open_cards.pop(key, None)
                return
            decided_by, responder = await answerer_of(db, row, self._bridge_id)
            turn_row = await self._turn_row(db, agent_id, session_id, row.turn_id)
            online = self._agent_online(agent_id)
            asking = post is None and row.state == "open"
            recipient = (
                await self._recipient(
                    db, row.room_id, target.agent, turn_row, target.thread_ref
                )
                if asking
                else None
            )
            session_url = self._session_url(agent_id, row.room_id, session_id)
            db.expunge_all()
        self._online_seen[agent_id] = online
        if row.state == "open":
            self._open_cards[key] = agent_id
        else:
            self._open_cards.pop(key, None)
        unavailable = _HOST_OFFLINE if not online and row.state == "open" else None
        if post is None:
            await self._post_card(
                row,
                target,
                asked_at_root=_asked_at_root(turn_row),
                unavailable_reason=unavailable,
                notify_external_id=recipient,
                notify_unreachable=recipient is None
                and self._adapter.notifies_only_by_mention,
            )
            self._retries.clear(key)
            return
        if post.external_post_id is None:
            recovered = await self._unconfirmed(key, post, session_url)
            if recovered is None:
                return
            post = recovered
        if getattr(self._adapter, "removes_answered_cards", False) and decided(
            approval_request(row, decided_by)
        ):
            if await self._remove_card(key, post):
                return
        await self._refresh_card(
            row,
            post,
            target,
            decided_by=decided_by,
            responder=responder,
            unavailable_reason=unavailable,
        )
        self._retries.clear(key)

    async def _post_card(
        self,
        row: ApprovalRequest,
        target: _Target,
        *,
        asked_at_root: bool,
        unavailable_reason: str | None,
        notify_external_id: str | None,
        notify_unreachable: bool,
    ) -> None:
        post = await self._reserve(row, target)
        if post is None:
            return
        card = approval_card(
            row,
            post,
            decided_by=None,
            responder_external_id=None,
            unavailable_reason=unavailable_reason,
            notify_external_id=notify_external_id,
            notify_unreachable=notify_unreachable,
        )
        thread_ref = target.thread_ref
        try:
            try:
                ref = await self._adapter.post_rich(
                    target.channel_id, target.agent_name, card, thread_ref
                )
            except ThreadUnavailable as missing:
                if not asked_at_root:
                    # Asked in a thread the platform no longer has: the channel
                    # root is people who were never in that conversation.
                    raise
                logger.warning(
                    "No thread for request %s in channel %s (%s); posting its "
                    "card at the channel root, where it was asked.",
                    row.request_id,
                    target.channel_id,
                    missing,
                )
                thread_ref = None
                ref = await self._adapter.post_rich(
                    target.channel_id, target.agent_name, card, None
                )
        except RichContentFailed:
            await self._release(post)
            raise
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._card_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.request_id,
                for_update=True,
            )
            if stored is None:
                logger.error(
                    "Posted card %s for request %s in channel %s, but its "
                    "reservation is gone, so the card answers nothing.",
                    post.handle,
                    post.request_id,
                    target.channel_id,
                )
                return
            stored.external_post_id = ref
            stored.thread_ref = thread_ref
        logger.info(
            "Posted card %s for request %s of session %s in channel %s",
            post.handle,
            row.request_id,
            row.session_id,
            target.channel_id,
        )

    async def _refresh_card(
        self,
        row: ApprovalRequest,
        post: ApprovalRequestPost,
        target: _Target,
        *,
        decided_by: DecidedBy | None,
        responder: str | None,
        unavailable_reason: str | None,
    ) -> None:
        """Redraw a card; a redraw that fails says so under the card, once per state.

        A stale card goes on offering buttons for a request that has settled,
        and a reader cannot tell that pressing one will do nothing.
        """
        assert post.external_post_id is not None
        card = approval_card(
            row,
            post,
            decided_by=decided_by,
            responder_external_id=responder,
            unavailable_reason=unavailable_reason,
            notify_external_id=None,
            notify_unreachable=False,
        )
        try:
            await self._adapter.update_rich(
                post.external_channel_id,
                target.agent_name,
                post.external_post_id,
                card,
                post.thread_ref,
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
            state = (row.state, unavailable_reason)
            if self._card_edit_failures.get(post.token) != state:
                await self._adapter.admin_message(
                    post.external_channel_id,
                    f"The card for request {post.handle} above could not be "
                    "updated, so it may still be offering buttons that no "
                    "longer work.",
                    self._adapter.notice_address(
                        post.external_post_id, post.thread_ref
                    ),
                    drawn=error.text,
                )
                self._card_edit_failures[post.token] = state
            raise
        self._card_edit_failures.pop(post.token, None)

    async def _remove_card(self, key: _Key, post: ApprovalRequestPost) -> bool:
        """Take an answered card off the platform. True once it is gone.

        Nothing is written until the platform says the card is gone; a
        deletion whose acknowledgement was lost is settled by asking again,
        which the platform answers as already gone. A refusal leaves the card
        settled and readable, and is tried again later.
        """
        assert post.external_post_id is not None
        try:
            await self._adapter.remove_publication(
                post.external_channel_id, post.external_post_id
            )
        except RichContentThrottled:
            raise
        except RemovalFailed as refusal:
            delay = self._retries.next(key)
            logger.warning(
                "Card %s for request %s was answered but %s would not take it "
                "back: %s. It stays in channel %s showing the decision; trying "
                "again in %.0fs.",
                post.handle,
                post.request_id,
                self._adapter.platform_name,
                refusal,
                post.external_channel_id,
                delay,
            )
            self._enqueue_later(key, delay)
            return False
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._card_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.request_id,
                for_update=True,
            )
            if stored is not None and stored.removed_at is None:
                stored.removed_at = datetime.now(UTC)
        self._retries.clear(key)
        return True

    async def _reserve(
        self, row: ApprovalRequest, target: _Target
    ) -> ApprovalRequestPost | None:
        """Hold a handle nobody else in the channel has. None if another poster got there first."""
        token = secrets.token_urlsafe(16)
        async with tenant_session(self._sessions, self._tenant_id) as db:
            start = await self._card_posts.count_in_channel(
                db, self._bridge_id, target.channel_id
            )
            for attempt in range(_MINT_ATTEMPTS):
                post = ApprovalRequestPost(
                    tenant_id=self._tenant_id,
                    bridge_id=self._bridge_id,
                    agent_id=row.agent_id,
                    session_id=row.session_id,
                    request_id=row.request_id,
                    token=token,
                    handle=f"{HANDLE_PREFIX}{start + 1 + attempt}",
                    external_channel_id=target.channel_id,
                    external_post_id=None,
                    thread_ref=target.thread_ref,
                )
                try:
                    async with db.begin_nested():
                        await self._card_posts.create(db, post)
                except IntegrityError as error:
                    if _HANDLE_CONSTRAINT in str(error.orig):
                        continue
                    existing = await self._card_posts.get(
                        db,
                        self._bridge_id,
                        row.agent_id,
                        row.session_id,
                        row.request_id,
                        for_update=False,
                    )
                    if existing is None:
                        raise
                    return None
                await db.commit()
                return post
        raise RuntimeError(
            f"No free handle for request {row.request_id} in channel "
            f"{target.channel_id} after {_MINT_ATTEMPTS} tries; it has no card, "
            "because a card nobody can name cannot be answered by typing."
        )

    async def _release(self, post: ApprovalRequestPost) -> None:
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._card_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.request_id,
                for_update=True,
            )
            if stored is not None and stored.external_post_id is None:
                await db.delete(stored)

    async def _unconfirmed(
        self, key: _Key, post: ApprovalRequestPost, session_url: str | None
    ) -> ApprovalRequestPost | None:
        """A card whose post was never confirmed: find it, or say so; never repost."""
        if post.unconfirmed_notice_at is not None:
            return None
        if not self._adapter.recovers_uncertain_posts:
            if self._adapter.discloses_unconfirmed_posts:
                await self._disclose_unconfirmed(post, session_url)
            elif post.token not in self._noted_unconfirmed:
                self._noted_unconfirmed.add(post.token)
                logger.error(
                    "Delivery of card %s in channel %s was never confirmed, and "
                    "%s can neither search for it nor say so in the channel. The "
                    "reservation is held and request %s can still be answered in "
                    "Console.",
                    post.handle,
                    post.external_channel_id,
                    self._adapter.platform_name,
                    post.request_id,
                )
            return None
        ref = await self._adapter.find_request_card(
            post.external_channel_id,
            post.thread_ref,
            post.token,
            post.created_at,
            post.handle,
        )
        if ref is None:
            delay = self._retries.next(key)
            logger.warning(
                "Card %s for request %s in channel %s was never confirmed and is "
                "not on %s yet. It is not posted again, to avoid asking twice; "
                "looking again in %.0fs.",
                post.handle,
                post.request_id,
                post.external_channel_id,
                self._adapter.platform_name,
                delay,
            )
            self._enqueue_later(key, delay)
            return None
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._card_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.request_id,
                for_update=True,
            )
            if stored is None:
                return None
            stored.external_post_id = ref
        post.external_post_id = ref
        return post

    async def _disclose_unconfirmed(
        self, post: ApprovalRequestPost, session_url: str | None
    ) -> None:
        """Say once in the channel that this card cannot be answered there.

        The row is stamped before the message is sent: a second notice would
        say nothing the first did not, so losing the notice to a crash
        mid-send is the cheaper mistake.
        """
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._card_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.request_id,
                for_update=True,
            )
            if stored is None or stored.unconfirmed_notice_at is not None:
                return
            stored.unconfirmed_notice_at = datetime.now(UTC)
        console = (
            f"[Switch Console]({session_url})" if session_url else "Switch Console"
        )
        sent = await self._adapter.admin_message(
            post.external_channel_id,
            f"Switch could not confirm that request **{post.handle}** reached "
            "this chat. If a card for it is here, answering it here will not "
            f"work — answer it in {console} instead.",
            post.thread_ref,
        )
        if sent is None:
            logger.error(
                "Could not tell channel %s that card %s was never confirmed. The "
                "request can still be answered in Console, but nothing in the "
                "channel says so, and this is not attempted again.",
                post.external_channel_id,
                post.handle,
            )

    # ── Turns ─────────────────────────────────────────────────────────────────

    async def _publish_turn(
        self, key: _Key, agent_id: str, session_id: str, turn_id: str
    ) -> None:
        async with tenant_session(self._sessions, self._tenant_id) as db:
            view = turn_view(
                await self._activity.turn(db, agent_id, session_id, turn_id)
            )
            if view is None or view.row.room_id is None:
                return
            room_id = view.row.room_id
            target = await self._target(db, key, agent_id, room_id, view.row.thread_id)
            if target is None:
                self._live_turns.pop(key, None)
                return
            asked_on = (
                await self._platform_ref(db, target.channel_id, view.row.message_id)
                or target.thread_ref
            )
            post = await self._turn_posts.get(
                db, self._bridge_id, agent_id, session_id, turn_id, for_update=False
            )
            now: datetime = (await db.execute(select(func.now()))).scalar_one()
            unended = [
                row.turn_id
                for row in await self._activity.turns_of_session(
                    db, agent_id, session_id
                )
                if row.status in ("queued", "running") and row.turn_id != turn_id
            ]
            running = await self._running_turn(db, agent_id, session_id)
            online = self._agent_online(agent_id)
            error_summary = activity_error_summary(view.turn, online=online)
            recipient = (
                await self._recipient(
                    db, room_id, target.agent, view.row, target.thread_ref
                )
                if error_summary and self._adapter.separate_attention_slot
                else None
            )
            db.expunge_all()
        self._online_seen[agent_id] = online
        session_url = self._session_url(agent_id, room_id, session_id)
        interrupt_turn_id = None if view.ended else running
        elapsed = view.elapsed_seconds(now)
        drawn = self._remembered(key)
        was_final = drawn.final
        content = TurnActivity(
            view.items,
            view.turn,
            elapsed,
            session_url=session_url,
            interrupt_turn_id=interrupt_turn_id,
        )
        state = status_state(
            view,
            elapsed_seconds=elapsed,
            interrupt_turn_id=interrupt_turn_id,
            session_url=session_url,
            clock_redraws=self._adapter.redraws_for_elapsed_time,
        )
        if post is None:
            post = await self._begin_turn(key, view, target, asked_on, content)
            if post is not None:
                drawn.status_state = state
                drawn.final = view.ended
        else:
            await self._redraw_turn(key, post, view, target, content, state, drawn)
        if post is not None:
            await self._marks(key, post, view, target, waiting_behind=bool(unended))
            await self._attention(
                post, view, target, error_summary, recipient, session_url, drawn
            )
        if post is not None and not view.ended:
            self._live_turns[key] = agent_id
        else:
            self._live_turns.pop(key, None)
        if post is not None and drawn.final and not was_final:
            await self._stamp_drawn(post)
        if drawn.status != view.turn.status:
            drawn.status = view.turn.status
            # The other waiting turns' stop controls name this session's
            # running turn, which may just have changed.
            for other in unended:
                self._enqueue(("turn", agent_id, session_id, other))

    async def _stamp_drawn(self, post: TurnStatusPost) -> None:
        """Record that the turn's message shows how it ended, for the next resync."""
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._turn_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.turn_id,
                for_update=True,
            )
            if stored is not None:
                stored.updated_at = func.now()

    def _remembered(self, key: _Key) -> _TurnDrawn:
        drawn = self._drawn.get(key)
        if drawn is None:
            drawn = self._drawn[key] = _TurnDrawn()
        self._drawn.move_to_end(key)
        while len(self._drawn) > _MAX_REMEMBERED_TURNS:
            self._drawn.popitem(last=False)
        return drawn

    async def _running_turn(
        self, db: AsyncSession, agent_id: str, session_id: str
    ) -> str | None:
        """The turn a stop control would end: the session's running one, if any."""
        running = [
            row.turn_id
            for row in await self._activity.turns_of_session(db, agent_id, session_id)
            if row.status == "running"
        ]
        return running[-1] if running else None

    async def _begin_turn(
        self,
        key: _Key,
        view: TurnView,
        target: _Target,
        asked_on: str | None,
        content: TurnActivity,
    ) -> TurnStatusPost | None:
        """Post the turn in its thread, or at the channel root with none to thread under.

        Once per turn, which is why the "agent has started" nudge belongs here.
        A refusal is logged; the next change to the turn tries again, and an
        ended turn is tried again after a wait.
        """
        if not view.ended:
            await self._adapter.notify_working(
                target.channel_id,
                target.agent_name,
                # Asked at the channel root, the turn threads under what was
                # said, and whoever is waiting is watching the root.
                None if asked_on == target.thread_ref else target.thread_ref,
            )
        try:
            ref = await self._adapter.post_rich(
                target.channel_id, target.agent_name, content, target.thread_ref
            )
        except RichContentThrottled:
            raise
        except RichContentFailed as error:
            logger.error(
                "Could not post the activity for turn %s of session %s in "
                "channel %s: %s. The channel shows what the agent asked without "
                "what it did.",
                view.turn.turn_id,
                view.row.session_id,
                target.channel_id,
                error,
            )
            if view.ended:
                self._retry_later(key)
            return None
        post = TurnStatusPost(
            tenant_id=self._tenant_id,
            bridge_id=self._bridge_id,
            agent_id=view.row.agent_id,
            session_id=view.row.session_id,
            turn_id=view.turn.turn_id,
            external_channel_id=target.channel_id,
            external_post_id=ref,
            thread_ref=target.thread_ref,
            reaction_message_ref=asked_on,
            mark=None,
            attention_post_id=None,
        )
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            await self._turn_posts.create(db, post)
            db.expunge(post)
        self._retries.clear(key)
        return post

    async def _redraw_turn(
        self,
        key: _Key,
        post: TurnStatusPost,
        view: TurnView,
        target: _Target,
        content: TurnActivity,
        state: str,
        drawn: _TurnDrawn,
    ) -> None:
        """Rewrite the turn's message as the turn now stands, unless nothing shown moved."""
        if drawn.wedged:
            return
        if drawn.status_state == state and (not view.ended or drawn.final):
            return
        try:
            await self._adapter.update_rich(
                post.external_channel_id,
                target.agent_name,
                post.external_post_id,
                content,
                post.thread_ref,
            )
        except RichContentThrottled:
            raise
        except RichContentWedged as wedged:
            logger.error("%s", wedged)
            drawn.wedged = True
            await self._say_wedged(post, view, target)
            return
        except RichContentFailed as error:
            logger.error(
                "Could not update the activity for turn %s of session %s in "
                "channel %s: %s. %s",
                view.turn.turn_id,
                view.row.session_id,
                post.external_channel_id,
                error,
                "The turn has ended; trying again after a wait."
                if view.ended
                else "The next change to the turn will try the same message.",
            )
            if view.ended:
                self._retry_later(key)
            return
        drawn.status_state = state
        drawn.final = view.ended
        self._retries.clear(key)

    async def _say_wedged(
        self, post: TurnStatusPost, view: TurnView, target: _Target
    ) -> None:
        """Tell the channel the message above has stopped for good, while anyone is looking."""
        age = datetime.now(UTC) - view.row.created_at
        if age > _WEDGE_NOTICE_MAX_AGE:
            logger.warning(
                "Not saying that the activity message %s is frozen: its turn "
                "started %.0f minutes ago, so a reply under it now would reach "
                "nobody still looking at it.",
                post.external_post_id,
                age.total_seconds() / 60,
            )
            return
        try:
            posted = await self._adapter.send_message(
                post.external_channel_id,
                target.agent_name,
                _WEDGE_NOTICE,
                post.thread_ref,
            )
        except Exception:
            logger.exception(
                "Could not say that the activity message %s for turn %s is "
                "frozen. The message stays as it is, unexplained.",
                post.external_post_id,
                view.turn.turn_id,
            )
            return
        if posted is None:
            logger.error(
                "The platform would not take the message saying that the "
                "activity message %s for turn %s is frozen.",
                post.external_post_id,
                view.turn.turn_id,
            )

    # ── The marker on the asking message ──────────────────────────────────────

    async def _marks(
        self,
        key: _Key,
        post: TurnStatusPost,
        view: TurnView,
        target: _Target,
        *,
        waiting_behind: bool,
    ) -> None:
        """Put the one marker the turn's state earns on the asking message, and
        take it off when the turn ends.

        The marker is recorded before the platform is asked, so a request that
        fails without an answer still counts as a marker that may be there.
        """
        if (
            not self._adapter.supports_activity_reactions
            or post.reaction_message_ref is None
        ):
            return
        if view.ended:
            if post.mark is not None and not await self._release_mark(
                post, target.agent_name
            ):
                self._retry_later(key)
            return
        # A turn is reported queued for a moment before it starts even when
        # nothing is ahead of it; the queued mark is only worth showing when
        # another turn of the session really is in the way.
        wanted: Mark = (
            "queued"
            if self._adapter.supports_queue_reaction
            and view.turn.status == "queued"
            and waiting_behind
            else "working"
        )
        if post.mark == wanted and key not in self._unsure_marks:
            return
        if post.mark is not None and post.mark != wanted:
            if not await self._release_mark(post, target.agent_name):
                return
        await self._record_mark(post, wanted)
        try:
            await self._adapter.mark_activity(
                post.external_channel_id,
                post.reaction_message_ref,
                agent_name=target.agent_name,
                mark=wanted,
                on=True,
                force=True,
            )
        except ActivityMarkRefused as refusal:
            logger.warning("%s The turn goes on without the mark.", refusal)
            self._unsure_marks.discard(key)
            await self._record_mark(post, None)
        except Exception:
            logger.warning(
                "Could not add the %s reaction on %s in %s; trying again with "
                "the turn's next change.",
                wanted,
                post.reaction_message_ref,
                post.external_channel_id,
                exc_info=True,
            )
            self._unsure_marks.add(key)
        else:
            self._unsure_marks.discard(key)

    async def _release_mark(self, post: TurnStatusPost, agent_name: str) -> bool:
        """Take this turn's marker off, unless another turn still holds the same one.

        Two turns can hang off one asking message; the last to let go removes
        it. Where every agent reacts as one bot there is a single marker
        between them, and where each reacts as its own there is one apiece.
        False when the platform could not be asked, so it is tried again.
        """
        mark = post.mark
        assert mark is not None and post.reaction_message_ref is not None
        async with tenant_session(self._sessions, self._tenant_id) as db:
            holders = await self._turn_posts.other_holders(
                db,
                post,
                mark,
                same_agent=self._adapter.activity_reactions_per_agent,
            )
        if not holders:
            try:
                await self._adapter.mark_activity(
                    post.external_channel_id,
                    post.reaction_message_ref,
                    agent_name=agent_name,
                    mark=cast(Mark, mark),
                    on=False,
                    force=True,
                )
            except ActivityMarkRefused as refusal:
                logger.error("%s The %s marker may stay on the message.", refusal, mark)
            except Exception:
                logger.warning(
                    "Could not remove the %s reaction on %s in %s.",
                    mark,
                    post.reaction_message_ref,
                    post.external_channel_id,
                    exc_info=True,
                )
                return False
        await self._record_mark(post, None)
        return True

    async def _record_mark(self, post: TurnStatusPost, mark: Mark | None) -> None:
        async with tenant_session(self._sessions, self._tenant_id) as db, db.begin():
            stored = await self._turn_posts.get(
                db,
                self._bridge_id,
                post.agent_id,
                post.session_id,
                post.turn_id,
                for_update=True,
            )
            if stored is not None:
                stored.mark = mark
        post.mark = mark

    # ── The "turn is stuck" message ───────────────────────────────────────────

    async def _attention(
        self,
        post: TurnStatusPost,
        view: TurnView,
        target: _Target,
        error_summary: str | None,
        recipient: str | None,
        session_url: str | None,
        drawn: _TurnDrawn,
    ) -> None:
        """One message per turn saying somebody has to act, cleared once nobody does.

        Posted, not edited in, because a post notifies and an edit does not.
        Carries the session's link, the way from the message a reader is asked
        to act on to what the turn was doing.
        """
        if not self._adapter.separate_attention_slot:
            return
        if error_summary is None and post.attention_post_id is None:
            return
        state = f"{session_url or ''}\n{error_summary or view.turn.status}"
        if post.attention_post_id is not None and drawn.attention_state == state:
            return
        content = TurnActivity(
            [],
            view.turn,
            status_only=True,
            notify_unreachable=bool(error_summary)
            and recipient is None
            and self._adapter.notifies_only_by_mention,
            error_summary=error_summary,
            session_url=session_url,
        )
        try:
            if post.attention_post_id is None:
                ref = await self._adapter.post_rich(
                    post.external_channel_id,
                    target.agent_name,
                    replace(content, notify_external_id=recipient),
                    post.thread_ref,
                )
                async with (
                    tenant_session(self._sessions, self._tenant_id) as db,
                    db.begin(),
                ):
                    stored = await self._turn_posts.get(
                        db,
                        self._bridge_id,
                        post.agent_id,
                        post.session_id,
                        post.turn_id,
                        for_update=True,
                    )
                    if stored is not None:
                        stored.attention_post_id = ref
                post.attention_post_id = ref
            else:
                await self._adapter.update_rich(
                    post.external_channel_id,
                    target.agent_name,
                    post.attention_post_id,
                    content,
                    post.thread_ref,
                )
        except RichContentThrottled:
            raise
        except RichContentWedged as wedged:
            logger.error("%s", wedged)
        except RichContentFailed as error:
            logger.error(
                "Could not draw the attention message for turn %s in channel "
                "%s: %s. The next change to the turn will try again.",
                view.turn.turn_id,
                post.external_channel_id,
                error,
            )
            return
        drawn.attention_state = state

    # ── Read back for a control pressed on a turn's message ───────────────────

    async def activity_shown_at(
        self, channel_id: str, ref: str
    ) -> ActivitySnapshot | None:
        """The turn a message of ours is showing, for an adapter that offers it."""
        async with tenant_session(self._sessions, self._tenant_id) as db:
            found = await self._turn_at(db, channel_id, ref)
            if found is None:
                return None
            view, _ = found
            assert view.row.room_id is not None
            now: datetime = (await db.execute(select(func.now()))).scalar_one()
        return ActivitySnapshot(
            items=view.items,
            turn=view.turn,
            elapsed_seconds=view.elapsed_seconds(now),
            session_url=self._session_url(
                view.row.agent_id, view.row.room_id, view.row.session_id
            ),
            read_at=now,
        )

    async def stop_target(self, channel_id: str, ref: str) -> StopTarget | None:
        """What a Stop control on the message at `ref` would stop, or None."""
        async with tenant_session(self._sessions, self._tenant_id) as db:
            found = await self._turn_at(db, channel_id, ref)
            if found is None:
                return None
            view, running = found
        assert view.row.room_id is not None
        return StopTarget(
            agent_id=view.row.agent_id,
            session_id=view.row.session_id,
            room_id=view.row.room_id,
            thread_id=view.row.thread_id,
            running_turn_id=running,
        )

    async def _turn_at(
        self, db: AsyncSession, channel_id: str, ref: str
    ) -> tuple[TurnView, str | None] | None:
        """The turn behind a message, re-checked the way drawing it was checked."""
        post = await self._turn_posts.at(db, self._bridge_id, channel_id, ref)
        if post is None:
            return None
        view = turn_view(
            await self._activity.turn(db, post.agent_id, post.session_id, post.turn_id)
        )
        if view is None or view.row.room_id is None:
            return None
        found = await self._rooms.get_with_membership(
            db, view.row.room_id, post.agent_id
        )
        if (
            found is None
            or found[0].bridge_id != self._bridge_id
            or found[0].external_channel_id != channel_id
            or not found[1]
        ):
            return None
        return view, await self._running_turn(db, post.agent_id, post.session_id)


def _asked_at_root(turn_row: SessionActivityItem | None) -> bool:
    """Whether the turn a request belongs to was asked at the channel root.

    Only then may its card go to the root when its thread cannot be found. A
    request whose turn is not recorded says nothing about where it was asked,
    and is treated as the root, as it always was without that record.
    """
    if turn_row is None or turn_row.message_id is None:
        return True
    return turn_row.thread_id in (None, turn_row.message_id)
